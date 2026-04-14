import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { SkuResolver } from '@/lib/amazon-sku'

// POST multipart/form-data — upload d'un fichier Amazon.
// Auto-détection du type via les colonnes d'en-tête:
//   - settlement TSV (payments) → colonnes 'settlement-id', 'transaction-type'
//   - FBA inventory CSV → colonnes 'sku', 'afn-warehouse-quantity'
//   - Reimbursements CSV → colonnes 'reimbursement-id', 'reason'

// ─── Parseurs CSV/TSV minimaux avec gestion des guillemets ────────────────
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let inQuote = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue }
      if (ch === '"') { inQuote = false; i++; continue }
      field += ch; i++; continue
    }
    if (ch === '"') { inQuote = true; i++; continue }
    if (ch === delim) { cur.push(field); field = ''; i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') {
      cur.push(field); field = ''
      if (cur.length > 1 || (cur.length === 1 && cur[0] !== '')) rows.push(cur)
      cur = []
      i++; continue
    }
    field += ch; i++
  }
  if (field !== '' || cur.length > 0) { cur.push(field); rows.push(cur) }
  return rows
}

function parseTSV(text: string) { return parseDelimited(text, '\t') }
function parseCSV(text: string) { return parseDelimited(text, ',') }

function rowsToObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length < 2) return []
  const header = rows[0].map(h => h.trim())
  const out: Record<string, string>[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const obj: Record<string, string> = {}
    for (let j = 0; j < header.length; j++) obj[header[j]] = (r[j] ?? '').trim()
    out.push(obj)
  }
  return out
}

function num(v: any): number { const n = parseFloat(v); return isNaN(n) ? 0 : n }
function parseDate(v: any): string | null {
  if (!v) return null
  // Format 1: ISO "2026-04-14T09:25:00+00:00"
  const d1 = new Date(v)
  if (!isNaN(d1.getTime())) return d1.toISOString()
  // Format 2: "19.03.2026 06:59:44 UTC"
  const m = String(v).match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/)
  if (m) {
    const d2 = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`)
    if (!isNaN(d2.getTime())) return d2.toISOString()
  }
  return null
}

// ─── Détection du type de fichier ─────────────────────────────────────────
type FileType = 'payments' | 'fba_inventory' | 'reimbursements' | 'unknown'

function detectType(headers: string[]): FileType {
  const h = new Set(headers.map(x => x.toLowerCase()))
  if (h.has('settlement-id') && h.has('transaction-type')) return 'payments'
  if (h.has('sku') && h.has('afn-warehouse-quantity')) return 'fba_inventory'
  if (h.has('reimbursement-id') && h.has('reason')) return 'reimbursements'
  return 'unknown'
}

// ─── Handlers par type ────────────────────────────────────────────────────
async function handlePayments(objs: Record<string, string>[], fileName: string, resolver: SkuResolver) {
  if (objs.length === 0) return { success: false, erreur: 'Fichier vide' }

  // Ligne 1 = header du settlement (transaction-type vide)
  const header = objs[0]
  const settlement_id = header['settlement-id']
  if (!settlement_id) return { success: false, erreur: 'settlement-id manquant' }

  const settlementRow = {
    settlement_id,
    settlement_start: parseDate(header['settlement-start-date']),
    settlement_end: parseDate(header['settlement-end-date']),
    deposit_date: parseDate(header['deposit-date']),
    total_amount: num(header['total-amount']),
    currency: header['currency'] || null,
    marketplace: header['marketplace-name'] || null,
    file_name: fileName,
  }

  // Upsert settlement (réimport = mise à jour)
  const { error: sErr } = await supabaseAdmin
    .from('amazon_settlements')
    .upsert(settlementRow, { onConflict: 'settlement_id' })
  if (sErr) throw sErr

  // Vider les transactions existantes pour ce settlement (réimport propre)
  await supabaseAdmin.from('amazon_transactions').delete().eq('settlement_id', settlement_id)

  // Convertir les lignes de détail
  const txRows: any[] = []
  let unresolved = 0
  for (let i = 1; i < objs.length; i++) {
    const o = objs[i]
    // Ignorer les lignes totalement vides
    if (!o['transaction-type'] && !o['amount-type'] && !o['amount']) continue

    const sku = o['sku'] || null
    let traction_code: string | null = null
    let resolution_source: string | null = null
    if (sku) {
      const r = resolver.resolve(sku)
      traction_code = r.traction_code
      resolution_source = r.source
      if (!traction_code) unresolved++
    }

    txRows.push({
      settlement_id,
      transaction_type: o['transaction-type'] || null,
      order_id: o['order-id'] || null,
      merchant_order_id: o['merchant-order-id'] || null,
      adjustment_id: o['adjustment-id'] || null,
      shipment_id: o['shipment-id'] || null,
      marketplace: o['marketplace-name'] || null,
      amount_type: o['amount-type'] || null,
      amount_description: o['amount-description'] || null,
      amount: num(o['amount']),
      fulfillment_id: o['fulfillment-id'] || null,
      posted_date: parseDate(o['posted-date-time'] || o['posted-date']),
      order_item_code: o['order-item-code'] || null,
      sku,
      quantity_purchased: num(o['quantity-purchased']),
      promotion_id: o['promotion-id'] || null,
      traction_code,
      resolution_source,
    })
  }

  // Insert par lots de 500
  let inserted = 0
  for (let i = 0; i < txRows.length; i += 500) {
    const batch = txRows.slice(i, i + 500)
    const { error } = await supabaseAdmin.from('amazon_transactions').insert(batch)
    if (error) throw error
    inserted += batch.length
  }

  return {
    success: true,
    type: 'payments',
    settlement_id,
    transactions_inserted: inserted,
    unresolved_sku: unresolved,
  }
}

async function handleFbaInventory(objs: Record<string, string>[], fileName: string, resolver: SkuResolver) {
  if (objs.length === 0) return { success: false, erreur: 'Fichier vide' }

  const today = new Date().toISOString().split('T')[0]

  // Purger le snapshot du jour
  await supabaseAdmin.from('amazon_fba_inventory').delete().eq('snapshot_date', today)

  const rows: any[] = []
  let unresolved = 0
  for (const o of objs) {
    const sku = o['sku']
    if (!sku) continue
    const r = resolver.resolve(sku)
    if (!r.traction_code) unresolved++
    rows.push({
      snapshot_date: today,
      sku,
      fnsku: o['fnsku'] || null,
      asin: o['asin'] || null,
      product_name: o['product-name'] || null,
      condition: o['condition'] || null,
      your_price: num(o['your-price']),
      afn_warehouse_quantity: num(o['afn-warehouse-quantity']),
      afn_fulfillable_quantity: num(o['afn-fulfillable-quantity']),
      afn_unsellable_quantity: num(o['afn-unsellable-quantity']),
      afn_reserved_quantity: num(o['afn-reserved-quantity']),
      afn_total_quantity: num(o['afn-total-quantity']),
      afn_inbound_working_quantity: num(o['afn-inbound-working-quantity']),
      afn_inbound_shipped_quantity: num(o['afn-inbound-shipped-quantity']),
      afn_inbound_receiving_quantity: num(o['afn-inbound-receiving-quantity']),
      traction_code: r.traction_code,
      resolution_source: r.source,
    })
  }

  let inserted = 0
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500)
    const { error } = await supabaseAdmin.from('amazon_fba_inventory').insert(batch)
    if (error) throw error
    inserted += batch.length
  }

  return {
    success: true,
    type: 'fba_inventory',
    snapshot_date: today,
    rows_inserted: inserted,
    unresolved_sku: unresolved,
  }
}

async function handleReimbursements(objs: Record<string, string>[], fileName: string, resolver: SkuResolver) {
  if (objs.length === 0) return { success: false, erreur: 'Fichier vide' }

  const rows: any[] = []
  let unresolved = 0
  for (const o of objs) {
    const reimbursement_id = o['reimbursement-id']
    if (!reimbursement_id) continue
    const sku = o['sku'] || null
    let traction_code: string | null = null
    let resolution_source: string | null = null
    if (sku) {
      const r = resolver.resolve(sku)
      traction_code = r.traction_code
      resolution_source = r.source
      if (!traction_code) unresolved++
    }
    rows.push({
      reimbursement_id,
      approval_date: parseDate(o['approval-date']),
      case_id: o['case-id'] || null,
      amazon_order_id: o['amazon-order-id'] || null,
      reason: o['reason'] || null,
      sku,
      fnsku: o['fnsku'] || null,
      asin: o['asin'] || null,
      product_name: o['product-name'] || null,
      currency: o['currency-unit'] || null,
      amount_per_unit: num(o['amount-per-unit']),
      amount_total: num(o['amount-total']),
      quantity_reimbursed_cash: num(o['quantity-reimbursed-cash']),
      quantity_reimbursed_inventory: num(o['quantity-reimbursed-inventory']),
      quantity_reimbursed_total: num(o['quantity-reimbursed-total']),
      original_reimbursement_id: o['original-reimbursement-id'] || null,
      original_reimbursement_type: o['original-reimbursement-type'] || null,
      traction_code,
      resolution_source,
    })
  }

  const { error } = await supabaseAdmin
    .from('amazon_reimbursements')
    .upsert(rows, { onConflict: 'reimbursement_id' })
  if (error) throw error

  return {
    success: true,
    type: 'reimbursements',
    rows_inserted: rows.length,
    unresolved_sku: unresolved,
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ erreur: 'Fichier manquant' }, { status: 400 })

    const text = await file.text()
    const fileName = file.name || 'unknown'

    // Déterminer le délimiteur via la 1ère ligne
    const firstLine = text.slice(0, Math.min(4096, text.length)).split(/\r?\n/)[0] || ''
    const isTsv = firstLine.includes('\t')
    const rows = isTsv ? parseTSV(text) : parseCSV(text)
    const objs = rowsToObjects(rows)
    if (objs.length === 0) return NextResponse.json({ erreur: 'Fichier vide ou illisible' }, { status: 400 })

    const headers = Object.keys(objs[0])
    const type = detectType(headers)
    if (type === 'unknown') {
      return NextResponse.json({
        erreur: 'Type de fichier non reconnu',
        headers_trouves: headers,
        indices: 'Doit contenir: settlement-id+transaction-type (payments), sku+afn-warehouse-quantity (FBA inventory), ou reimbursement-id+reason (remboursements)',
      }, { status: 400 })
    }

    // Init resolver (charge cache + Traction Amazon lines)
    const resolver = new SkuResolver()
    await resolver.init()

    let result: any
    if (type === 'payments')           result = await handlePayments(objs, fileName, resolver)
    else if (type === 'fba_inventory') result = await handleFbaInventory(objs, fileName, resolver)
    else if (type === 'reimbursements')result = await handleReimbursements(objs, fileName, resolver)
    else                               result = { success: false, erreur: 'type inconnu' }

    // Sauvegarder les mappings auto appris pendant l'import
    await resolver.persistLearned()

    return NextResponse.json(result)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
