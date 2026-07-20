'use client'

// Onglet « Pièces — Réglages » : import des 4 fichiers Excel du comptoir pièces
// et paramétrage des commis (visibilité, renommage). Le seul onglet pièces qui
// écrit la structure (imports + réglages).

import { useEffect, useRef, useState } from 'react'
import PartsClerkDashboard from './PartsClerkDashboard'
import { Theme, Carte, SectionTitre, Th } from '@/components/meca/MecaUI'

// Le numéro entre parenthèses = le numéro de rapport Traction à sortir.
const IMPORTS: { kind: string, label: string }[] = [
  { kind: 'rapport-vente', label: '📊 Rapport de vente de pièces (1684)' },
  { kind: 'factures',      label: '📋 Liste des factures de pièces (Traction)' },
  { kind: 'estimes',       label: '🔁 Rapport estimé vs facture (1683)' },
  { kind: 'ouvertes',      label: '⏳ Liste des pièces (181)' },
]

export default function PiecesConfigTab({ ...t }: Theme) {
  const [clerks, setClerks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ type: 'info' | 'ok' | 'err', text: string } | null>(null)
  const [avert, setAvert] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [selId, setSelId] = useState<string | null>(null)
  const [renomme, setRenomme] = useState<{ id: string, nom: string } | null>(null)

  async function charger() {
    setLoading(true)
    try {
      const r = await fetch('/api/pieces/commis')
      const j = await r.json()
      if (j.erreur) setMsg({ type: 'err', text: j.erreur }); else setClerks(j.clerks ?? [])
    } catch (e: any) { setMsg({ type: 'err', text: e?.message || String(e) }) }
    finally { setLoading(false) }
  }
  useEffect(() => { charger() }, [])

  async function importer(kind: string, file: File) {
    setUploading(true); setAvert([])
    setMsg({ type: 'info', text: `Import de ${file.name}…` })
    try {
      const fd = new FormData(); fd.append('file', file)
      const r = await fetch(`/api/pieces/import/${kind}`, { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok || j.erreur) { setMsg({ type: 'err', text: j.erreur || 'Erreur import' }); if (j.warnings?.length) setAvert(j.warnings); return }
      let texte = `✅ ${j.rowsImported ?? 0} ligne(s) importée(s).`
      if (j.ventesSousLeSeuil != null) texte += ` ${j.ventesSousLeSeuil} vente(s) sous le seuil de marge.`
      if (j.convertis != null) texte += ` ${j.convertis} estimé(s) converti(s).`
      if (j.facturesClosedSinceLastImport != null) texte += ` ${j.facturesClosedSinceLastImport} facture(s) détectée(s) fermée(s).`
      setMsg({ type: 'ok', text: texte })
      setAvert(j.warnings ?? [])
      await charger()
    } catch (e: any) { setMsg({ type: 'err', text: e?.message || String(e) }) }
    finally { setUploading(false) }
  }

  async function patcher(id: string, patch: any) {
    setClerks(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)))
    const r = await fetch('/api/pieces/commis', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...patch }) })
    const j = await r.json()
    if (j.erreur) { setMsg({ type: 'err', text: j.erreur }); charger() }
  }

  const col = (ty: string) => ty === 'err' ? t.C.red : ty === 'ok' ? t.C.green : t.C.blue
  const selectStyle: any = { padding: '5px 8px', borderRadius: 6, border: `1px solid ${t.bdr}`, fontSize: 13, background: t.card, color: 'inherit' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: t.C.blue, margin: 0 }}>⚙️ Pièces — Réglages</h2>
        <p style={{ fontSize: 13, color: t.sub, margin: '4px 0 0' }}>
          Importe les rapports Excel et règle qui apparaît dans les dashboards pièces.
        </p>
      </div>

      <Carte t={t}>
        <SectionTitre t={t} titre="Importer les fichiers Excel" aide="Importe le rapport de vente en premier : il crée les commis. Les autres se rattachent ensuite." />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 14 }}>
          {IMPORTS.map(im => <BoutonImport key={im.kind} t={t} label={im.label} disabled={uploading} onFile={f => importer(im.kind, f)} />)}
        </div>
        {msg && (
          <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 8, fontSize: 13, lineHeight: 1.5, color: col(msg.type), background: `${col(msg.type)}14`, border: `1px solid ${col(msg.type)}55` }}>
            {msg.text}
          </div>
        )}
        {avert.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, color: t.C.yellow, fontWeight: 600 }}>⚠️ {avert.length} avertissement(s) — cliquer pour voir</summary>
            <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 12, color: t.sub, lineHeight: 1.6 }}>{avert.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </details>
        )}
      </Carte>

      <Carte t={t} style={{ padding: 0, overflow: 'auto' }}>
        <div style={{ padding: '16px 18px 12px' }}>
          <SectionTitre t={t} titre="Paramétrage des commis" aide="Détermine qui apparaît dans les dashboards. Clique un nom pour son détail, ✏️ pour le renommer." />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
              <Th t={t} align="left">Commis</Th>
              <Th t={t} align="center">Visible</Th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={2} style={{ padding: 20, textAlign: 'center', color: t.sub }}>⏳ Chargement…</td></tr>}
            {!loading && clerks.length === 0 && <tr><td colSpan={2} style={{ padding: 20, textAlign: 'center', color: t.sub }}>Aucun commis — importe d'abord le rapport de vente de pièces.</td></tr>}
            {!loading && clerks.map(c => (
              <tr key={c.id} style={{ borderBottom: `1px solid ${t.bdr}` }}>
                <td style={{ padding: '10px 12px' }}>
                  {renomme?.id === c.id ? (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <input autoFocus value={renomme.nom}
                        onChange={e => setRenomme({ id: c.id, nom: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Enter' && renomme.nom.trim()) { patcher(c.id, { nom: renomme.nom.trim() }); setRenomme(null) } if (e.key === 'Escape') setRenomme(null) }}
                        style={{ ...selectStyle, width: 200 }} />
                      <button onClick={() => { if (renomme.nom.trim()) patcher(c.id, { nom: renomme.nom.trim() }); setRenomme(null) }} style={{ ...selectStyle, cursor: 'pointer', color: t.C.green, fontWeight: 700 }}>✓</button>
                      <button onClick={() => setRenomme(null)} style={{ ...selectStyle, cursor: 'pointer', color: t.sub }}>✕</button>
                    </span>
                  ) : (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <button onClick={() => setSelId(selId === c.id ? null : c.id)}
                        style={{ background: 'none', border: 'none', padding: 0, fontWeight: 600, fontSize: 13, color: selId === c.id ? t.C.blue : 'inherit', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                        {c.nom}
                      </button>
                      <span style={{ color: t.sub, fontWeight: 400, fontSize: 11 }}>#{c.id}</span>
                      <button onClick={() => setRenomme({ id: c.id, nom: c.nom })} title="Renommer" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: t.sub, padding: 0 }}>✏️</button>
                    </span>
                  )}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                  <input type="checkbox" checked={c.actif} onChange={e => patcher(c.id, { actif: e.target.checked })} style={{ width: 16, height: 16, accentColor: t.C.blue, cursor: 'pointer' }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Carte>

      {selId && <PartsClerkDashboard {...t} clerkId={selId} onClose={() => setSelId(null)} />}
    </div>
  )
}

function BoutonImport({ t, label, disabled, onFile }: { t: Theme, label: string, disabled?: boolean, onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <input ref={ref} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
      <button onClick={() => ref.current?.click()} disabled={disabled}
        style={{ padding: '9px 16px', borderRadius: 8, border: `1px solid ${t.C.blue}`, background: disabled ? t.bdr : t.C.blue, color: disabled ? t.sub : '#fff', fontSize: 13, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' }}>
        {disabled ? '⏳ Import…' : label}
      </button>
    </>
  )
}
