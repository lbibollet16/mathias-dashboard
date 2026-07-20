'use client'

// Onglet « Aviseur » — accessible à tout le personnel.
//
// L'aviseur choisit son nom dans la liste en haut ; son dashboard complet
// apparaît alors (stats, comparaison à l'équipe) avec, sous chaque bon de
// travail ouvert, le suivi qu'il renseigne lui-même (statut, date planifiée,
// note). Pas de compte individuel : la sélection sert de contexte.

import { useEffect, useMemo, useState } from 'react'
import AdvisorDashboard from './AdvisorDashboard'
import { Theme, Carte, SectionTitre, Badge } from './MecaUI'

interface AdvisorRow { id: string, nom: string, departement: 'powersport' | 'marine' | null, actif: boolean, bonsOuverts: number, bonsSignales: number }

export default function AviseurTab({ ...t }: Theme) {
  const [advisors, setAdvisors] = useState<AdvisorRow[]>([])
  const [loading, setLoading] = useState(true)
  const [erreur, setErreur] = useState<string | null>(null)
  const [selId, setSelId] = useState<string | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    let annule = false
    fetch('/api/meca/advisors')
      .then(r => r.json())
      .then(j => { if (!annule) { if (j.erreur) setErreur(j.erreur); else setAdvisors(j.advisors ?? []) } })
      .catch(e => { if (!annule) setErreur(String(e)) })
      .finally(() => { if (!annule) setLoading(false) })
    return () => { annule = true }
  }, [])

  const filtres = useMemo(() => {
    const s = q.trim().toLowerCase()
    // Seuls les aviseurs visibles (actifs) sont sélectionnables ici.
    const base = advisors.filter(a => a.actif !== false)
    const liste = s ? base.filter(a => a.nom.toLowerCase().includes(s)) : base
    return [...liste].sort((a, b) => a.nom.localeCompare(b.nom))
  }, [advisors, q])

  const sel = advisors.find(a => a.id === selId) || null

  const deptLabel = (d: string | null) => d === 'powersport' ? 'Powersport' : d === 'marine' ? 'Marine' : 'non assigné'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: t.C.blue, margin: 0 }}>🔧 Aviseur</h2>
        <p style={{ fontSize: 13, color: t.sub, margin: '4px 0 0' }}>
          Choisis ton nom pour voir ton tableau de bord et faire le suivi de tes bons de travail.
        </p>
      </div>

      <Carte t={t}>
        <SectionTitre t={t} titre="Sélectionne ton nom" />
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="🔍 Filtrer par nom…"
          style={{
            marginTop: 12, width: '100%', maxWidth: 320, padding: '8px 12px', borderRadius: 8,
            border: `1px solid ${t.bdr}`, fontSize: 13, background: t.card, color: 'inherit',
          }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {loading && <span style={{ color: t.sub, fontSize: 13 }}>⏳ Chargement…</span>}
          {erreur && <span style={{ color: t.C.red, fontSize: 13 }}>Erreur : {erreur}</span>}
          {!loading && !erreur && filtres.length === 0 && (
            <span style={{ color: t.sub, fontSize: 13 }}>Aucun aviseur — l'import n'a pas encore été fait.</span>
          )}
          {filtres.map(a => {
            const actif = selId === a.id
            return (
              <button
                key={a.id}
                onClick={() => setSelId(actif ? null : a.id)}
                style={{
                  position: 'relative', padding: '10px 16px', borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${actif ? t.C.blue : t.bdr}`,
                  background: actif ? `${t.C.blue}1f` : t.card,
                  color: actif ? t.C.blue : 'inherit',
                  fontSize: 14, fontWeight: 600, textAlign: 'left',
                }}
              >
                <div>{a.nom}</div>
                <div style={{ fontSize: 11, fontWeight: 400, color: t.sub, marginTop: 2 }}>
                  {deptLabel(a.departement)} · {a.bonsOuverts} bon(s)
                </div>
                {!!a.bonsSignales && (
                  <span title={`${a.bonsSignales} bon(s) signalé(s)`} style={{
                    position: 'absolute', top: -6, right: -6, minWidth: 18, height: 18, padding: '0 5px',
                    borderRadius: 9, background: t.C.red, color: '#fff', fontSize: 10, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', border: `2px solid ${t.card}`,
                  }}>
                    {a.bonsSignales}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </Carte>

      {sel && (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 700 }}>{sel.nom}</span>
            <Badge t={t} couleur={sel.departement ? t.C.blue : t.sub}>{deptLabel(sel.departement)}</Badge>
          </div>
          <AdvisorDashboard {...t} advisorId={sel.id} suiviEditable moiNom={sel.nom} />
        </div>
      )}
    </div>
  )
}
