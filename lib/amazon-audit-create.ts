// Helper partagé : créer un audit avec son snapshot initial.
// Utilisé par /api/amazon/audits (création manuelle) et /api/amazon/import
// (création automatique après import settlement) et /api/amazon/audits/backfill.

import { supabaseAdmin } from './supabase'
import { detectVariant } from './amazon-inventory'
import { loadManualMappings, distributeToBases } from './amazon-mapping'
import { loadTractionForSettlement } from './amazon-traction-snapshot'

export interface CreateAuditInput {
  mois: string              // YYYY-MM
  label?: string
  started_by?: string
  settlement_id?: string | null
  // Mode :
  //   'mensuel_ama' (défaut) — audit mensuel warehouse complet (HUB + FBM + SP)
  //   'settlement_fbm'       — comptage rapide FBM uniquement (par settlement)
  audit_type?: 'mensuel_ama' | 'settlement_fbm'
}

export interface CreateAuditResult {
  success: boolean
  audit?: any
  total?: number
  skipped?: boolean
  reason?: string
  erreur?: string
}

export async function createAuditSnapshot(input: CreateAuditInput): Promise<CreateAuditResult> {
  try {
    // Dédoublonnage par (settlement_id, audit_type) : si un audit du même type
    // existe déjà pour ce settlement, on le garde (préserve les comptages saisis).
    // Plusieurs audits de TYPES différents peuvent coexister sur le même
    // settlement (ex: settlement_fbm + settlement_fba snapshot).
    if (input.settlement_id) {
      const targetType = input.audit_type || 'mensuel_ama'
      const { data: existing } = await supabaseAdmin
        .from('amazon_audits')
        .select('id, label, audit_type')
        .eq('settlement_id', input.settlement_id)
        .eq('audit_type', targetType)
        .limit(1)
      if (existing && existing.length > 0) {
        return { success: true, skipped: true, reason: `Audit ${targetType} déjà existant (id=${existing[0].id}) pour ce settlement`, audit: existing[0] }
      }
    }

    const auditType = input.audit_type || 'mensuel_ama'

    // Créer l'enregistrement audit
    const { data: created, error: cErr } = await supabaseAdmin
      .from('amazon_audits')
      .insert({
        mois: input.mois,
        label: input.label || `Audit ${input.mois}`,
        started_by: input.started_by || null,
        statut: 'en_cours',
        started_at: new Date().toISOString(),
        settlement_id: input.settlement_id || null,
        audit_type: auditType,
      })
      .select()
      .single()
    if (cErr) throw cErr
    const auditId = created.id

    // Charger l'inventaire Traction (ligne AMA seulement) DEPUIS LE SNAPSHOT
    // figé du settlement — garantit que les valeurs théoriques de l'audit
    // ne bougent pas si Traction est resync entre l'import et l'audit.
    // Si pas de settlement_id ou pas de snapshot → fallback sur live.
    const tractionRows = await loadTractionForSettlement(input.settlement_id || null, { code_ligne_in: ['AMA'] })

    // Dernier snapshot FBA Amazon
    const { data: snapDates } = await supabaseAdmin
      .from('amazon_fba_inventory')
      .select('snapshot_date')
      .order('snapshot_date', { ascending: false })
      .limit(1)
    const latestSnap = snapDates && snapDates[0]?.snapshot_date

    // Charger les multi-mappings manuels pour convertir packs Amazon → unités physiques
    const manualMappings = await loadManualMappings()

    const fbaByBase = new Map<string, number>()
    if (latestSnap) {
      let f = 0
      while (true) {
        const { data } = await supabaseAdmin
          .from('amazon_fba_inventory')
          .select('sku, afn_fulfillable_quantity, afn_inbound_working_quantity, afn_inbound_shipped_quantity, afn_inbound_receiving_quantity, afn_reserved_quantity, traction_code')
          .eq('snapshot_date', latestSnap)
          .range(f, f + 999)
        if (!data) break
        for (const row of data) {
          const amazonTotal = Number(row.afn_fulfillable_quantity || 0)
            + Number(row.afn_inbound_working_quantity || 0)
            + Number(row.afn_inbound_shipped_quantity || 0)
            + Number(row.afn_inbound_receiving_quantity || 0)
            + Number(row.afn_reserved_quantity || 0)
          if (amazonTotal === 0) continue
          // Distribue vers les bases Traction en unités physiques (× multiplier si pack)
          const dist = distributeToBases(row.sku, row.traction_code, amazonTotal, manualMappings)
          for (const d of dist) {
            if (!d.base) continue
            fbaByBase.set(d.base, (fbaByBase.get(d.base) || 0) + d.physical_qty)
          }
        }
        if (data.length < 1000) break
        f += 1000
      }
    }

    // Grouper Traction par base code
    type BaseAccum = {
      description: string | null
      coutant: number
      hub: number
      fbm: number
      sans_prefix: number
      fba_traction: number
    }
    const bases = new Map<string, BaseAccum>()
    for (const t of tractionRows) {
      const v = detectVariant(t.pk_code)
      const qty = Number(t.qty_minus_reserved || 0)
      const ex = bases.get(v.base) || { description: null, coutant: 0, hub: 0, fbm: 0, sans_prefix: 0, fba_traction: 0 }
      if (!ex.description && t.desc_fra) ex.description = t.desc_fra
      if (ex.coutant === 0 && Number(t.prix_coutant || 0) > 0) ex.coutant = Number(t.prix_coutant)
      if (v.location === 'HUB')       ex.hub += qty
      else if (v.location === 'FBM')  ex.fbm += qty
      else if (v.location === 'FBA')  ex.fba_traction += qty
      else                            ex.sans_prefix += qty
      bases.set(v.base, ex)
    }

    // Pour 'settlement_fbm' : ne lister QUE les base_codes ayant eu une
    // transaction FBM (fulfillment_id='MFN') dans le settlement courant.
    // Les autres SKU FBM n'ont pas bougé depuis le dernier audit → pas
    // besoin de les recompter (ils seront vérifiés dans l'audit AMA mensuel).
    let basesAvecTransactionFbm: Set<string> | null = null
    if (auditType === 'settlement_fbm' && input.settlement_id) {
      // Charger les SKU avec transactions MFN dans ce settlement
      const mfnTxRows: any[] = []
      let from = 0
      while (true) {
        const { data, error } = await supabaseAdmin
          .from('amazon_transactions')
          .select('sku, traction_code')
          .eq('settlement_id', input.settlement_id)
          .eq('fulfillment_id', 'MFN')
          .range(from, from + 999)
        if (error) break
        mfnTxRows.push(...(data || []))
        if (!data || data.length < 1000) break
        from += 1000
      }
      basesAvecTransactionFbm = new Set<string>()
      // Résoudre chaque SKU MFN vers son/ses base_code(s).
      // Une transaction fulfillment_id='MFN' = forcément FBM, donc on
      // ajoute la base peu importe la location détectée du pk_code.
      for (const t of mfnTxRows) {
        const sku = t.sku
        if (!sku) continue
        const manual = manualMappings.get(sku)
        if (manual && manual.length > 0) {
          for (const m of manual) {
            basesAvecTransactionFbm.add(detectVariant(m.pk_code).base)
          }
        } else {
          const tc = t.traction_code || sku
          basesAvecTransactionFbm.add(detectVariant(tc).base)
        }
      }
    }

    // Créer une ligne audit_count pour chaque base qui a du stock quelque part.
    // Filtrage selon le mode :
    //   - 'settlement_fbm' : SEULEMENT les base avec fbm_theorique > 0 ET
    //                        ayant eu au moins une transaction MFN dans le
    //                        settlement courant (comptage incrémental rapide)
    //   - 'mensuel_ama'    : toutes les bases avec stock à un endroit physique chez Mathias
    const countRows: any[] = []
    for (const [base, b] of bases) {
      const fba_amazon = fbaByBase.get(base) || 0
      if (auditType === 'settlement_fbm') {
        // Comptage rapide FBM only — exclut HUB, SP, FBA
        if (b.fbm === 0) continue
        // Comptage incrémental : seulement les bases avec mouvement FBM ce settlement
        if (basesAvecTransactionFbm && !basesAvecTransactionFbm.has(base)) continue
      } else {
        // Audit mensuel — toutes les bases avec stock physique chez Mathias OU au FBA
        if (b.hub === 0 && b.fbm === 0 && b.sans_prefix === 0 && fba_amazon === 0 && b.fba_traction === 0) continue
      }
      countRows.push({
        audit_id: auditId,
        base_code: base,
        description: b.description,
        coutant: b.coutant,
        hub_theorique: b.hub,
        fbm_theorique: b.fbm,
        sans_prefix_theorique: b.sans_prefix,
        fba_amazon_theorique: fba_amazon,
        fba_traction_theorique: b.fba_traction,
      })
    }

    for (let i = 0; i < countRows.length; i += 500) {
      const batch = countRows.slice(i, i + 500)
      const { error } = await supabaseAdmin.from('amazon_audit_counts').insert(batch)
      if (error) throw error
    }

    await supabaseAdmin
      .from('amazon_audits')
      .update({ snapshot_count: countRows.length })
      .eq('id', auditId)

    return { success: true, audit: { ...created, snapshot_count: countRows.length }, total: countRows.length }
  } catch (e: any) {
    return { success: false, erreur: e.message || String(e) }
  }
}
