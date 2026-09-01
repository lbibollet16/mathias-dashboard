// Paramètres du module : réglages globaux (délai, niveau de service, Wilson,
// seuils d'alerte) et surcharges par fournisseur.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { chargerConfig, lireTout } from '@/lib/supply-chain-db'
import { zScore } from '@/lib/supply-chain'

export const dynamic = 'force-dynamic'

// Bornes de validation. Un niveau de service à 1 ferait diverger le Z (∞) et un
// taux de possession à 0 ferait exploser la formule de Wilson (division par 0).
const BORNES: Record<string, [number, number]> = {
  delai_jours: [1, 365],
  niveau_service: [0.5, 0.999],
  cout_commande: [0, 5000],
  cout_ligne_commande: [0, 500],
  max_commandes_an: [1, 365],
  taux_possession: [0.01, 2],
  horizon_surstock_mois: [1, 60],
  mois_stock_mort: [3, 120],
  seuil_abc_a: [0.5, 0.95],
  seuil_abc_b: [0.6, 0.999],
  alerte_couverture_mois: [1, 120],
  alerte_valeur_dollars: [0, 1_000_000],
  alerte_multiple_eoq: [1, 50],
  alerte_sans_vente_dollars: [0, 1_000_000],
  alerte_qte_min: [1, 1000],
  saison_horizon_mois: [1, 12],
}

export async function GET() {
  try {
    const cfg = await chargerConfig()
    const fournisseurs = await lireTout<any>('sc_fournisseurs_params', '*')
    return NextResponse.json({
      config: cfg,
      z: zScore(cfg.niveau_service),
      fournisseurs: fournisseurs.sort((a, b) => a.fournisseur.localeCompare(b.fournisseur)),
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()

    // ── Surcharge fournisseur ────────────────────────────────────────
    if (body.fournisseur) {
      const patch: any = { fournisseur: body.fournisseur, maj_le: new Date().toISOString() }
      for (const k of ['delai_jours', 'cout_commande', 'niveau_service', 'franco_port'] as const) {
        if (k in body) patch[k] = body[k] === null || body[k] === '' ? null : Number(body[k])
      }
      if ('suivi_actif' in body) patch.suivi_actif = !!body.suivi_actif
      if ('notes' in body) patch.notes = body.notes
      if ('id_fournisseur' in body) patch.id_fournisseur = body.id_fournisseur

      if (patch.niveau_service != null && (patch.niveau_service <= 0.5 || patch.niveau_service >= 1)) {
        return NextResponse.json({ erreur: 'niveau_service doit être entre 0.5 et 0.999' }, { status: 400 })
      }
      if (patch.delai_jours != null && (patch.delai_jours < 1 || patch.delai_jours > 365)) {
        return NextResponse.json({ erreur: 'delai_jours doit être entre 1 et 365' }, { status: 400 })
      }

      const { data, error } = await supabaseAdmin
        .from('sc_fournisseurs_params').upsert(patch, { onConflict: 'fournisseur' }).select().single()
      if (error) throw new Error(error.message)
      return NextResponse.json({ success: true, fournisseur: data })
    }

    // ── Config globale ───────────────────────────────────────────────
    const patch: any = { maj_le: new Date().toISOString(), maj_par: body.user_email || null }
    for (const [k, [min, max]] of Object.entries(BORNES)) {
      if (!(k in body)) continue
      const v = Number(body[k])
      if (!Number.isFinite(v)) return NextResponse.json({ erreur: `${k} : valeur invalide` }, { status: 400 })
      if (v < min || v > max) {
        return NextResponse.json({ erreur: `${k} doit être entre ${min} et ${max}` }, { status: 400 })
      }
      patch[k] = v
    }
    if ('saison_active' in body) patch.saison_active = !!body.saison_active
    if ('lignes_hors_perimetre' in body) {
      const brut = Array.isArray(body.lignes_hors_perimetre)
        ? body.lignes_hors_perimetre.join(',')
        : String(body.lignes_hors_perimetre || '')
      patch.lignes_hors_perimetre = brut
        .split(',').map((x: string) => x.trim().toUpperCase()).filter(Boolean).join(',')
    }
    if (patch.seuil_abc_a != null && patch.seuil_abc_b != null && patch.seuil_abc_b <= patch.seuil_abc_a) {
      return NextResponse.json({ erreur: 'Le seuil B doit être supérieur au seuil A' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from('sc_config').update(patch).eq('id', 1).select().single()
    if (error) throw new Error(error.message)

    return NextResponse.json({
      success: true, config: data, z: zScore(Number(data.niveau_service)),
      note: 'Les nouveaux seuils s\'appliquent au prochain recalcul.',
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
