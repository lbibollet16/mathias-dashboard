'use client'

// Onglets « Service Powersport » et « Service Marine ».
//
// Vue directeur : KPI du département, répartition par âge des bons ouverts,
// rythme d'ouverture/fermeture, classement triable des aviseurs (clic = détail
// individuel), et la table financière Mois à Date ventilée par catégorie —
// exactement la structure du rapport aviseur source.

import { useEffect, useState, useMemo } from 'react'
import AdvisorDashboard from './AdvisorDashboard'
import {
  Theme, Carte, SectionTitre, KpiCard, GrilleKpi, Gauge, BarresHorizontales,
  ThTriable, Th, fmtArgent, fmtArgentCourt,
} from './MecaUI'

interface ClassementAviseur {
  id: string
  nom: string
  revenuGenere: number
  profitPct: number | null
  bonsOuverts: number
  bonsEnRetard: number
  bonsSignales: number
  valeurEnAttente: number
}

export default function DepartmentDashboard({ dept, ...t }: { dept: 'powersport' | 'marine' } & Theme) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [erreur, setErreur] = useState<string | null>(null)
  const [selectedAdvisorId, setSelectedAdvisorId] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<keyof ClassementAviseur>('revenuGenere')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  useEffect(() => {
    let annule = false
    setLoading(true); setErreur(null); setSelectedAdvisorId(null)
    fetch(`/api/meca/summary?dept=${dept}`)
      .then(r => r.json())
      .then(j => { if (!annule) { if (j.erreur) setErreur(j.erreur); else setData(j) } })
      .catch(e => { if (!annule) setErreur(String(e)) })
      .finally(() => { if (!annule) setLoading(false) })
    return () => { annule = true }
  }, [dept])

  const label = dept === 'powersport' ? 'Service Powersport' : 'Service Marine'

  const classementTrie = useMemo(() => {
    const liste = [...((data?.classementAviseurs ?? []) as ClassementAviseur[])]
    liste.sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey]
      if (typeof va === 'string' || typeof vb === 'string') {
        return sortDir === 'asc'
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va))
      }
      // null (profit % inconnu) toujours en bas plutôt que traité comme 0
      const na = va === null ? -Infinity : (va as number)
      const nb = vb === null ? -Infinity : (vb as number)
      return sortDir === 'asc' ? na - nb : nb - na
    })
    return liste
  }, [data?.classementAviseurs, sortKey, sortDir])

  function toggleSort(key: any) {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('desc') }
  }

  if (loading) return <div style={{ padding: 24, color: t.sub, fontSize: 14 }}>⏳ Chargement du dashboard {label}…</div>
  if (erreur)  return <div style={{ padding: 24, color: t.C.red, fontSize: 14 }}>Erreur : {erreur}</div>
  if (!data)   return null

  if (data.advisors.length === 0) {
    return (
      <Carte t={t} style={{ lineHeight: 1.6, fontSize: 14, color: t.sub }}>
        Aucun aviseur n'est encore assigné au département <strong>{label}</strong>.<br />
        Va dans l'onglet <strong>⚙️ Aviseur Technique</strong> pour assigner des aviseurs à ce département.
      </Carte>
    )
  }

  const maxAgeTranche = Math.max(1, ...data.ageParTranche.map((x: any) => x.count))
  const ventes = data.financier.rows.find((r: any) => r.key === 'ventes')?.valeurs ?? {}
  const revenuTotal = Object.values(ventes).reduce<number>((s, v: any) => s + (v || 0), 0)
  const profitVals = Object.values(data.financier.rows.find((r: any) => r.key === 'profit_pct')?.valeurs ?? {})
    .filter((v): v is number => v !== null)
  const profitMoyen = profitVals.length > 0 ? profitVals.reduce((s, v) => s + v, 0) / profitVals.length : null

  const tdBase: any = { padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12.5 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: t.C.blue, margin: 0 }}>🔧 {label}</h2>
        <p style={{ fontSize: 13, color: t.sub, margin: '4px 0 0' }}>
          {data.advisors.length} aviseur(s) actif(s) — {data.advisors.map((a: any) => a.nom).join(', ')}
        </p>
      </div>

      <GrilleKpi>
        <KpiCard t={t} label="Revenu (mois à date)" value={fmtArgentCourt(revenuTotal)} />
        <KpiCard t={t} label="Profit moyen" value={profitMoyen !== null ? `${profitMoyen.toFixed(1)} %` : '—'} />
        <KpiCard t={t} label="Bons de travail ouverts" value={String(data.bonsOuverts)} />
        <KpiCard t={t} label="Âge moyen des bons ouverts" value={`${data.ageMoyenJours} j`} />
        <KpiCard t={t} label="Ouverts depuis + de 30 j" value={String(data.bonsOuvertsPlus30j)} warn={data.bonsOuvertsPlus30j > 0} />
        <KpiCard t={t} label="Signalés (2+ imports sans fermeture)" value={String(data.bonsSignales)} warn={data.bonsSignales > 0} />
        <KpiCard t={t} label="Valeur en attente" value={fmtArgentCourt(data.valeurEnAttente)} />
      </GrilleKpi>

      <Carte t={t} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionTitre t={t} titre="Répartition des bons ouverts par âge" />
        {data.ageParTranche.map((x: any) => (
          <Gauge key={x.label} t={t} label={x.label} value={x.count} maxValue={maxAgeTranche} unit=" bons" />
        ))}
      </Carte>

      <Carte t={t}>
        <SectionTitre
          t={t}
          titre="Rythme d'ouverture et de fermeture"
          aide={`Moyenne sur les ${data.rythme.periodeJours} derniers jours.`}
        />
        {data.rythme.fiabiliteFermeture !== 'bonne' && (
          <p style={{ fontSize: 12, color: t.C.yellow, fontWeight: 600, margin: '6px 0 0' }}>
            ⚠️ Fiabilité de la fermeture {data.rythme.fiabiliteFermeture === 'insuffisante' ? 'insuffisante' : 'limitée'} —
            encore peu d'imports dans l'historique.
          </p>
        )}
        <div style={{ marginTop: 14 }}>
          <GrilleKpi min={180}>
            <KpiCard t={t} label="Ouvertures / jour" value={String(data.rythme.ouverturesParJour)} />
            <KpiCard t={t} label="Fermetures / jour (estimé)" value={String(data.rythme.fermeturesParJour)} />
            <KpiCard
              t={t}
              label="Solde net / jour"
              value={`${data.rythme.soldeNetParJour > 0 ? '+' : ''}${data.rythme.soldeNetParJour}`}
              warn={data.rythme.soldeNetParJour > 0}
            />
          </GrilleKpi>
        </div>
        <p style={{ fontSize: 12, color: t.sub, margin: '12px 0 0' }}>
          {data.rythme.soldeNetParJour > 0
            ? 'La file de bons ouverts grossit plus vite qu\'elle ne se vide.'
            : data.rythme.soldeNetParJour < 0
              ? 'La file de bons ouverts se résorbe — bon signe.'
              : 'La file de bons ouverts est stable.'}
        </p>
        <p style={{ fontSize: 11.5, color: t.sub, margin: '8px 0 0', lineHeight: 1.5, fontStyle: 'italic' }}>
          Les ouvertures viennent d'une date réelle du fichier source. Les fermetures ne sont
          détectées qu'au prochain import : leur précision dépend de ta fréquence d'import.
        </p>
      </Carte>

      <Carte t={t} style={{ padding: 0 }}>
        <div style={{ padding: '16px 18px 12px' }}>
          <SectionTitre
            t={t}
            titre="Revenu par aviseur — Mois à Date"
            aide="Repère qui porte le département, et qui a besoin d'un coup de main. Clique une barre pour le détail."
          />
        </div>
        <div style={{ padding: '0 18px 18px' }}>
          <BarresHorizontales
            t={t}
            items={classementTrie.map(a => ({ id: a.id, label: a.nom, valeur: a.revenuGenere }))}
            format={fmtArgentCourt}
            onClick={id => setSelectedAdvisorId(selectedAdvisorId === id ? null : id)}
            selectedId={selectedAdvisorId}
          />
        </div>
      </Carte>

      <Carte t={t} style={{ padding: 0, overflow: 'auto' }}>
        <div style={{ padding: '16px 18px 12px' }}>
          <SectionTitre t={t} titre="Classement des aviseurs" aide="Clique un en-tête pour trier, une ligne pour voir le détail individuel." />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
              <ThTriable t={t} label="Aviseur"          colonne="nom"             actif={sortKey} dir={sortDir} onSort={toggleSort} align="left" />
              <ThTriable t={t} label="Revenu (MTD)"     colonne="revenuGenere"    actif={sortKey} dir={sortDir} onSort={toggleSort} />
              <ThTriable t={t} label="Profit %"         colonne="profitPct"       actif={sortKey} dir={sortDir} onSort={toggleSort} />
              <ThTriable t={t} label="Bons ouverts"     colonne="bonsOuverts"     actif={sortKey} dir={sortDir} onSort={toggleSort} />
              <ThTriable t={t} label="En retard"        colonne="bonsEnRetard"    actif={sortKey} dir={sortDir} onSort={toggleSort} />
              <ThTriable t={t} label="Signalés"         colonne="bonsSignales"    actif={sortKey} dir={sortDir} onSort={toggleSort} />
              <ThTriable t={t} label="Valeur en attente" colonne="valeurEnAttente" actif={sortKey} dir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {classementTrie.map(a => (
              <tr
                key={a.id}
                onClick={() => setSelectedAdvisorId(selectedAdvisorId === a.id ? null : a.id)}
                onMouseEnter={e => (e.currentTarget.style.background = t.hvr)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                style={{ borderBottom: `1px solid ${t.bdr}`, cursor: 'pointer' }}
              >
                <td style={{ padding: '9px 12px', fontWeight: 600, color: selectedAdvisorId === a.id ? t.C.blue : undefined }}>
                  {a.nom}
                </td>
                <td style={tdBase}>{fmtArgentCourt(a.revenuGenere)}</td>
                <td style={tdBase}>{a.profitPct !== null ? `${a.profitPct.toFixed(1)} %` : '—'}</td>
                <td style={{ ...tdBase, fontFamily: undefined }}>{a.bonsOuverts}</td>
                <td style={{ ...tdBase, fontFamily: undefined, color: a.bonsEnRetard > 0 ? t.C.red : undefined, fontWeight: a.bonsEnRetard > 0 ? 700 : 400 }}>
                  {a.bonsEnRetard}
                </td>
                <td style={{ ...tdBase, fontFamily: undefined, color: a.bonsSignales > 0 ? t.C.red : undefined, fontWeight: a.bonsSignales > 0 ? 700 : 400 }}>
                  {a.bonsSignales}
                </td>
                <td style={tdBase}>{fmtArgentCourt(a.valeurEnAttente)}</td>
              </tr>
            ))}
            {classementTrie.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: t.sub }}>Aucun aviseur actif dans ce département.</td></tr>
            )}
          </tbody>
        </table>
      </Carte>

      {selectedAdvisorId && (
        <AdvisorDashboard {...t} advisorId={selectedAdvisorId} onClose={() => setSelectedAdvisorId(null)} />
      )}

      <Carte t={t} style={{ padding: 0, overflow: 'auto' }}>
        <div style={{ padding: '16px 18px 12px' }}>
          <SectionTitre
            t={t}
            titre="Performance financière — Mois à Date"
            aide="Ventilée par catégorie (Client / Interne / Garantie / Total / Autre), Pièce et Main d'oeuvre séparées, agrégée sur les aviseurs actifs du département."
          />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
              <Th t={t} align="left">Indicateur</Th>
              {data.financier.categories.map((cat: string) => (
                <Th key={cat} t={t}>{cat.replace('|', ' · ')}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.financier.rows.map((row: any) => (
              <tr key={row.key} style={{ borderBottom: `1px solid ${t.bdr}` }}>
                <td style={{ padding: '9px 12px', fontWeight: 600 }}>{row.titre}</td>
                {data.financier.categories.map((cat: string) => {
                  const v = row.valeurs[cat]
                  return (
                    <td key={cat} style={tdBase}>
                      {v === null || v === undefined ? '—' : row.isPercent ? `${v.toFixed(1)} %` : fmtArgent(v)}
                    </td>
                  )
                })}
              </tr>
            ))}
            {data.financier.rows.length === 0 && (
              <tr>
                <td colSpan={data.financier.categories.length + 1} style={{ padding: 20, textAlign: 'center', color: t.sub }}>
                  Aucune donnée de performance importée pour ces aviseurs — importe le Rapport des Aviseurs Technique
                  dans l'onglet ⚙️ Aviseur Technique.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Carte>
    </div>
  )
}
