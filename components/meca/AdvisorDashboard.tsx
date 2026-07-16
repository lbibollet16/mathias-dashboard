'use client'

// Détail d'un aviseur, ouvert depuis le dashboard de département ou le suivi.
//
// L'intérêt par rapport au niveau département : la liste NOMINATIVE de ses bons
// ouverts (cibler LE bon qui traîne, pas juste savoir qu'il y en a un), et la
// comparaison à ses collègues du même département — pensée pour situer et
// motiver, jamais pour sanctionner : vert si mieux que la moyenne, ambre sinon,
// et aucun jugement dans le texte.

import { useEffect, useState } from 'react'
import { Theme, Carte, SectionTitre, KpiCard, GrilleKpi, Th, fmtArgent, fmtArgentCourt } from './MecaUI'

export default function AdvisorDashboard({ advisorId, onClose, ...t }:
  { advisorId: string, onClose?: () => void } & Theme) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [erreur, setErreur] = useState<string | null>(null)

  useEffect(() => {
    let annule = false
    setLoading(true); setErreur(null)
    fetch(`/api/meca/advisor-summary?id=${encodeURIComponent(advisorId)}`)
      .then(r => r.json())
      .then(j => { if (!annule) { if (j.erreur) setErreur(j.erreur); else setData(j) } })
      .catch(e => { if (!annule) setErreur(String(e)) })
      .finally(() => { if (!annule) setLoading(false) })
    return () => { annule = true }
  }, [advisorId])

  if (loading) return <Carte t={t}><span style={{ color: t.sub, fontSize: 14 }}>⏳ Chargement…</span></Carte>
  if (erreur)  return <Carte t={t}><span style={{ color: t.C.red, fontSize: 14 }}>Erreur : {erreur}</span></Carte>
  if (!data)   return null

  const tdNum: any = { padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12.5 }

  return (
    <Carte t={t} style={{ display: 'flex', flexDirection: 'column', gap: 16, background: t.dark ? '#141414' : '#fafbfc' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: t.C.blue, margin: 0 }}>{data.advisor.nom}</h2>
          <p style={{ fontSize: 12.5, color: t.sub, margin: '2px 0 0' }}>
            #{data.advisor.id} · {data.advisor.departement ?? 'non assigné'}
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            style={{
              padding: '6px 12px', borderRadius: 8, border: `1px solid ${t.bdr}`,
              background: t.card, fontSize: 12.5, color: t.sub, cursor: 'pointer',
            }}
          >
            Fermer
          </button>
        )}
      </div>

      <GrilleKpi min={160}>
        <KpiCard t={t} label="Revenu (MTD)" value={fmtArgentCourt(data.kpi.revenuGenere)} />
        <KpiCard t={t} label="Profit moyen" value={data.kpi.profitPctMoyen !== null ? `${data.kpi.profitPctMoyen.toFixed(1)} %` : '—'} />
        <KpiCard t={t} label="Bons ouverts" value={String(data.kpi.bonsOuverts)} />
        <KpiCard t={t} label="Âge moyen" value={`${data.kpi.ageMoyenJours} j`} />
        <KpiCard t={t} label="+ de 30 j" value={String(data.kpi.bonsOuvertsPlus30j)} warn={data.kpi.bonsOuvertsPlus30j > 0} />
        <KpiCard t={t} label="Signalés (2+ imports)" value={String(data.kpi.bonsSignales)} warn={data.kpi.bonsSignales > 0} />
        <KpiCard t={t} label="Valeur en attente" value={fmtArgentCourt(data.kpi.valeurEnAttente)} />
      </GrilleKpi>

      {data.comparaisonEquipe && (
        <Carte t={t}>
          <SectionTitre
            t={t}
            titre="Comparaison avec l'équipe"
            aide={`Moyenne de ${data.comparaisonEquipe.nbCollegues} collègue(s) actif(s) du même département.`}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
            <BarreComparaison t={t} label="Revenu (MTD)" soi={data.kpi.revenuGenere}
              equipe={data.comparaisonEquipe.revenuMoyenEquipe} unit=" $" plusCestMieux />
            {data.kpi.profitPctMoyen !== null && data.comparaisonEquipe.profitPctMoyenEquipe !== null && (
              <BarreComparaison t={t} label="Profit %" soi={data.kpi.profitPctMoyen}
                equipe={data.comparaisonEquipe.profitPctMoyenEquipe} unit=" %" plusCestMieux />
            )}
            <BarreComparaison t={t} label="Âge moyen des bons ouverts" soi={data.kpi.ageMoyenJours}
              equipe={data.comparaisonEquipe.ageMoyenEquipe} unit=" j" plusCestMieux={false} />
            <BarreComparaison t={t} label="Fermetures / jour" soi={data.rythme.fermeturesParJour}
              equipe={data.comparaisonEquipe.fermeturesParJourMoyenEquipe} unit="" plusCestMieux />
          </div>
          {data.rythme.fiabiliteFermeture !== 'bonne' && (
            <p style={{ fontSize: 11, color: t.C.yellow, margin: '12px 0 0' }}>
              Rythme de fermeture basé sur peu d'imports historiques — s'affinera avec le temps.
            </p>
          )}
        </Carte>
      )}

      <Carte t={t} style={{ padding: 0, overflow: 'auto' }}>
        <div style={{ padding: '14px 16px 10px' }}>
          <SectionTitre t={t} titre={`Bons de travail ouverts (${data.workOrders.length})`} />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
              <Th t={t} align="left">#Facture</Th>
              <Th t={t} align="left">Client</Th>
              <Th t={t} align="left">Statut</Th>
              <Th t={t}>Ouvert le</Th>
              <Th t={t}>Âge</Th>
              <Th t={t}>Valeur</Th>
              <Th t={t} align="center">Signalé</Th>
            </tr>
          </thead>
          <tbody>
            {data.workOrders.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 16, textAlign: 'center', color: t.sub }}>Aucun bon de travail ouvert.</td></tr>
            )}
            {data.workOrders.map((w: any) => (
              <tr key={w.facture_no} style={{
                borderBottom: `1px solid ${t.bdr}`,
                background: w.signale ? (t.dark ? '#2a1512' : '#fdecea') : undefined,
              }}>
                <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{w.facture_no}</td>
                <td style={{ padding: '8px 12px' }}>{w.client_nom}</td>
                <td style={{ padding: '8px 12px', color: t.sub }}>{w.statut}</td>
                <td style={tdNum}>{w.date_ouverture}</td>
                <td style={{ ...tdNum, fontWeight: w.ageJours > 30 ? 700 : 400, color: w.ageJours > 30 ? t.C.red : undefined }}>
                  {w.ageJours} j
                </td>
                <td style={tdNum}>{fmtArgent(w.valeur)}</td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  {w.signale && (
                    <span title="Non fermé depuis 2 imports ou plus"
                      style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: t.C.red }} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Carte>

      <Carte t={t} style={{ padding: 0, overflow: 'auto' }}>
        <div style={{ padding: '14px 16px 10px' }}>
          <SectionTitre t={t} titre="Performance financière — Mois à Date" />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
              <Th t={t} align="left">Indicateur</Th>
              {data.financier.categories.map((cat: string) => <Th key={cat} t={t}>{cat.replace('|', ' · ')}</Th>)}
            </tr>
          </thead>
          <tbody>
            {data.financier.rows.map((row: any) => (
              <tr key={row.key} style={{ borderBottom: `1px solid ${t.bdr}` }}>
                <td style={{ padding: '8px 12px', fontWeight: 600 }}>{row.titre}</td>
                {data.financier.categories.map((cat: string) => {
                  const v = row.valeurs[cat]
                  return (
                    <td key={cat} style={tdNum}>
                      {v === null || v === undefined ? '—' : row.isPercent ? `${v.toFixed(1)} %` : fmtArgent(v)}
                    </td>
                  )
                })}
              </tr>
            ))}
            {data.financier.rows.length === 0 && (
              <tr>
                <td colSpan={data.financier.categories.length + 1} style={{ padding: 16, textAlign: 'center', color: t.sub }}>
                  Aucune donnée de performance importée pour cet aviseur.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Carte>
    </Carte>
  )
}

// Deux barres superposées : l'aviseur (épaisse) et la moyenne des collègues
// (fine). Vert quand il fait mieux que la moyenne, ambre sinon — sans texte de
// jugement.
function BarreComparaison({ t, label, soi, equipe, unit, plusCestMieux }:
  { t: Theme, label: string, soi: number, equipe: number, unit: string, plusCestMieux: boolean } ) {
  const max = Math.max(soi, equipe, 1) * 1.15
  const meilleur = plusCestMieux ? soi >= equipe : soi <= equipe
  const col = meilleur ? t.C.green : t.C.yellow
  const ecart = equipe !== 0 ? Math.round(((soi - equipe) / Math.abs(equipe)) * 100) : 0
  const piste = t.dark ? '#111' : '#eef1f5'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: t.sub, fontWeight: 500 }}>{label}</span>
        <span style={{ fontWeight: 700, color: col }}>{ecart > 0 ? '+' : ''}{ecart}% vs équipe</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ position: 'relative', height: 8, background: piste, borderRadius: 4, border: `1px solid ${t.bdr}` }}>
          <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, (soi / max) * 100)}%`, background: col, borderRadius: 4 }} />
        </div>
        <div style={{ position: 'relative', height: 5, background: piste, borderRadius: 3, border: `1px solid ${t.bdr}` }}>
          <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, (equipe / max) * 100)}%`, background: t.sub, borderRadius: 3 }} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: t.sub, marginTop: 3 }}>
        <span>Aviseur : {soi.toLocaleString('fr-CA')}{unit}</span>
        <span>Équipe : {equipe.toLocaleString('fr-CA')}{unit}</span>
      </div>
    </div>
  )
}
