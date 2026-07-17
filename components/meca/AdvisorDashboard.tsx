'use client'

// Détail d'un aviseur, ouvert depuis le dashboard de département ou le suivi.
//
// L'intérêt par rapport au niveau département : la liste NOMINATIVE de ses bons
// ouverts (cibler LE bon qui traîne, pas juste savoir qu'il y en a un), et la
// comparaison à ses collègues du même département — pensée pour situer et
// motiver, jamais pour sanctionner : vert si mieux que la moyenne, ambre sinon,
// et aucun jugement dans le texte.

import { useEffect, useState, useCallback } from 'react'
import { Theme, Carte, SectionTitre, KpiCard, GrilleKpi, Th, fmtArgent, fmtArgentCourt } from './MecaUI'
import SuiviBonRow from './SuiviBonRow'

export default function AdvisorDashboard({ advisorId, onClose, suiviEditable = false, moiNom, ...t }:
  { advisorId: string, onClose?: () => void, suiviEditable?: boolean, moiNom?: string } & Theme) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [erreur, setErreur] = useState<string | null>(null)
  const [boMap, setBoMap] = useState<Record<string, any[]>>({})

  useEffect(() => {
    let annule = false
    fetch('/api/bo-alerts').then(r => r.json())
      .then(j => { if (!annule && j.alerts) setBoMap(j.alerts) })
      .catch(() => {})
    return () => { annule = true }
  }, [])

  const charger = useCallback(async (silencieux = false) => {
    if (!silencieux) setLoading(true)
    setErreur(null)
    try {
      const r = await fetch(`/api/meca/advisor-summary?id=${encodeURIComponent(advisorId)}`)
      const j = await r.json()
      if (j.erreur) setErreur(j.erreur); else setData(j)
    } catch (e: any) { setErreur(String(e)) }
    finally { setLoading(false) }
  }, [advisorId])

  useEffect(() => { charger() }, [charger])

  if (loading) return <Carte t={t}><span style={{ color: t.sub, fontSize: 14 }}>⏳ Chargement…</span></Carte>
  if (erreur)  return <Carte t={t}><span style={{ color: t.C.red, fontSize: 14 }}>Erreur : {erreur}</span></Carte>
  if (!data)   return null

  const tdNum: any = { padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12.5 }

  // Pièces en back-order sur les bons ouverts de cet aviseur.
  const nbBoPieces = (data.workOrders ?? []).reduce((s: number, w: any) => s + (boMap[String(w.facture_no)]?.length ?? 0), 0)
  const nbBoBons = (data.workOrders ?? []).filter((w: any) => (boMap[String(w.facture_no)]?.length ?? 0) > 0).length

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

      {nbBoPieces > 0 && (
        <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, color: t.C.red, background: `${t.C.red}14`, border: `1px solid ${t.C.red}` }}>
          🔁 {nbBoPieces} pièce(s) en back-order sur {nbBoBons} de tes bons — voir le détail dans la liste des bons ouverts.
        </div>
      )}

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
          <SectionTitre
            t={t}
            titre={`Bons de travail ouverts (${data.workOrders.length})`}
            aide={suiviEditable
              ? 'Renseigne le suivi de chaque bon : statut, date planifiée, note. Enregistré automatiquement.'
              : undefined}
          />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
              <Th t={t} align="left">#Facture</Th>
              <Th t={t} align="left">Client</Th>
              <Th t={t}>Âge</Th>
              <Th t={t}>Valeur</Th>
              <Th t={t} align="left" >Suivi</Th>
            </tr>
          </thead>
          <tbody>
            {data.workOrders.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 16, textAlign: 'center', color: t.sub }}>Aucun bon de travail ouvert.</td></tr>
            )}
            {data.workOrders.map((w: any) => (
              <SuiviBonRow
                key={w.facture_no}
                {...t}
                bon={{ ...w, boAlerts: boMap[String(w.facture_no)] }}
                editable={suiviEditable}
                moiNom={moiNom}
                onSaved={() => charger(true)}
              />
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
