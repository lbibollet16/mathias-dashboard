'use client'

// Onglet « Commis Pièces » — accessible à tout le personnel.
// Le commis choisit son nom ; son dashboard complet apparaît, avec le suivi
// éditable de ses factures ouvertes et de ses justificatifs de marge.

import { useEffect, useMemo, useState } from 'react'
import PartsClerkDashboard from './PartsClerkDashboard'
import { Theme, Carte, SectionTitre } from '@/components/meca/MecaUI'

export default function CommisPiecesTab({ ...t }: Theme) {
  const [clerks, setClerks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [erreur, setErreur] = useState<string | null>(null)
  const [selId, setSelId] = useState<string | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    let annule = false
    fetch('/api/pieces/commis')
      .then(r => r.json())
      .then(j => { if (!annule) { if (j.erreur) setErreur(j.erreur); else setClerks(j.clerks ?? []) } })
      .catch(e => { if (!annule) setErreur(String(e)) })
      .finally(() => { if (!annule) setLoading(false) })
    return () => { annule = true }
  }, [])

  const filtres = useMemo(() => {
    const s = q.trim().toLowerCase()
    // Seuls les commis visibles (actifs) sont sélectionnables ici.
    const base = clerks.filter(c => c.actif !== false)
    const l = s ? base.filter(c => c.nom.toLowerCase().includes(s)) : base
    return [...l].sort((a, b) => a.nom.localeCompare(b.nom))
  }, [clerks, q])

  const sel = clerks.find(c => c.id === selId) || null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: t.C.blue, margin: 0 }}>🧰 Commis Pièces</h2>
        <p style={{ fontSize: 13, color: t.sub, margin: '4px 0 0' }}>
          Choisis ton nom pour voir tes ventes, tes factures pièces ouvertes et tes justificatifs de marge.
        </p>
      </div>

      <Carte t={t}>
        <SectionTitre t={t} titre="Sélectionne ton nom" />
        <input
          type="text" value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 Filtrer par nom…"
          style={{ marginTop: 12, width: '100%', maxWidth: 320, padding: '8px 12px', borderRadius: 8, border: `1px solid ${t.bdr}`, fontSize: 13, background: t.card, color: 'inherit' }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {loading && <span style={{ color: t.sub, fontSize: 13 }}>⏳ Chargement…</span>}
          {erreur && <span style={{ color: t.C.red, fontSize: 13 }}>Erreur : {erreur}</span>}
          {!loading && !erreur && filtres.length === 0 && <span style={{ color: t.sub, fontSize: 13 }}>Aucun commis — l'import n'a pas encore été fait.</span>}
          {filtres.map(c => {
            const actif = selId === c.id
            return (
              <button key={c.id} onClick={() => setSelId(actif ? null : c.id)}
                style={{
                  padding: '10px 16px', borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${actif ? t.C.blue : t.bdr}`,
                  background: actif ? `${t.C.blue}1f` : t.card,
                  color: actif ? t.C.blue : 'inherit', fontSize: 14, fontWeight: 600,
                }}>
                {c.nom}
                <span style={{ fontSize: 11, fontWeight: 400, color: t.sub, marginLeft: 6 }}>#{c.id}</span>
              </button>
            )
          })}
        </div>
      </Carte>

      {sel && <PartsClerkDashboard {...t} clerkId={sel.id} suiviEditable moiNom={sel.nom} />}
    </div>
  )
}
