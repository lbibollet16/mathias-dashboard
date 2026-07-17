'use client'

// Onglet « Directeur de service » — remplace Service Powersport + Service Marine.
//
// Compile les deux départements en une vue. En tête, les aviseurs à suivre
// impérativement (bons en retard ou signalés), tous départements confondus,
// triés du plus urgent au moins urgent. Un filtre permet de se restreindre à
// Powersport ou Marine. Clic sur un aviseur = son détail (bons + suivi).

import { useEffect, useState, useMemo } from 'react'
import AdvisorDashboard from './AdvisorDashboard'
import {
  Theme, Carte, SectionTitre, KpiCard, GrilleKpi, Gauge, BarresHorizontales,
  ThTriable, Th, Badge, fmtArgent, fmtArgentCourt,
} from './MecaUI'

type Dept = 'tous' | 'powersport' | 'marine'
const DEPT_LABEL = (d: string | null) => d === 'powersport' ? 'Powersport' : d === 'marine' ? 'Marine' : '—'

export default function DirecteurServiceTab({ ...t }: Theme) {
  const [dept, setDept] = useState<Dept>('tous')
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [erreur, setErreur] = useState<string | null>(null)
  const [selId, setSelId] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState('revenuGenere')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  useEffect(() => {
    let annule = false
    setLoading(true); setErreur(null); setSelId(null)
    fetch(`/api/meca/summary?dept=${dept}`)
      .then(r => r.json())
      .then(j => { if (!annule) { if (j.erreur) setErreur(j.erreur); else setData(j) } })
      .catch(e => { if (!annule) setErreur(String(e)) })
      .finally(() => { if (!annule) setLoading(false) })
    return () => { annule = true }
  }, [dept])

  const classement: any[] = data?.classementAviseurs ?? []

  // À suivre impérativement : au moins un bon en retard ou signalé.
  const aSuivre = useMemo(() =>
    classement
      .map(a => ({ ...a, urgence: (a.bonsEnRetard ?? 0) + (a.bonsSignales ?? 0) }))
      .filter(a => a.urgence > 0)
      .sort((x, y) => y.urgence - x.urgence || y.valeurEnAttente - x.valeurEnAttente),
    [classement])

  const classementTrie = useMemo(() => {
    const l = [...classement]
    l.sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey]
      if (typeof va === 'string' || typeof vb === 'string') {
        return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
      }
      const na = va === null ? -Infinity : va, nb = vb === null ? -Infinity : vb
      return sortDir === 'asc' ? na - nb : nb - na
    })
    return l
  }, [classement, sortKey, sortDir])

  function toggleSort(k: string) {
    if (sortKey === k) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir('desc') }
  }

  const onglet = (d: Dept, label: string) => (
    <button
      onClick={() => setDept(d)}
      style={{
        padding: '7px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
        border: `1px solid ${dept === d ? t.C.blue : t.bdr}`,
        background: dept === d ? `${t.C.blue}1f` : 'transparent',
        color: dept === d ? t.C.blue : t.sub,
      }}
    >
      {label}
    </button>
  )

  const tdNum: any = { padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12.5 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: t.C.blue, margin: 0 }}>📊 Directeur de service</h2>
        <p style={{ fontSize: 13, color: t.sub, margin: '4px 0 0' }}>
          Powersport et Marine réunis. Les aviseurs à suivre en priorité sont en tête.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {onglet('tous', 'Tous les départements')}
        {onglet('powersport', 'Powersport')}
        {onglet('marine', 'Marine')}
      </div>

      {loading && <Carte t={t}><span style={{ color: t.sub, fontSize: 14 }}>⏳ Chargement…</span></Carte>}
      {erreur && <Carte t={t}><span style={{ color: t.C.red, fontSize: 14 }}>Erreur : {erreur}</span></Carte>}

      {!loading && !erreur && data && (
        <>
          {data.advisors.length === 0 ? (
            <Carte t={t} style={{ fontSize: 14, color: t.sub, lineHeight: 1.6 }}>
              Aucun aviseur actif {dept === 'tous' ? '' : `en ${DEPT_LABEL(dept)}`}. Assigne des aviseurs à un
              département dans l'onglet <strong>⚙️ Aviseur Technique</strong>.
            </Carte>
          ) : (
            <>
              <GrilleKpi>
                <KpiCard t={t} label="Aviseurs actifs" value={String(data.advisors.length)} />
                <KpiCard t={t} label="Bons de travail ouverts" value={String(data.bonsOuverts)} />
                <KpiCard t={t} label="Ouverts + de 30 j" value={String(data.bonsOuvertsPlus30j)} warn={data.bonsOuvertsPlus30j > 0} />
                <KpiCard t={t} label="Signalés (2+ imports)" value={String(data.bonsSignales)} warn={data.bonsSignales > 0} />
                <KpiCard t={t} label="Valeur en attente" value={fmtArgentCourt(data.valeurEnAttente)} />
                <KpiCard t={t} label="Âge moyen" value={`${data.ageMoyenJours} j`} />
              </GrilleKpi>

              {/* À suivre impérativement */}
              <Carte t={t} style={{ padding: 0, overflow: 'auto', borderColor: aSuivre.length ? t.C.red : t.bdr }}>
                <div style={{ padding: '16px 18px 12px' }}>
                  <SectionTitre
                    t={t}
                    titre={`🚨 Aviseurs à suivre impérativement (${aSuivre.length})`}
                    aide="Au moins un bon en retard (+30 j) ou signalé (non fermé depuis 2 imports). Clique pour voir le détail."
                  />
                </div>
                {aSuivre.length === 0 ? (
                  <div style={{ padding: '4px 18px 18px', color: t.C.green, fontSize: 13 }}>
                    ✅ Aucun aviseur en situation critique{dept === 'tous' ? '' : ` en ${DEPT_LABEL(dept)}`}.
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
                        <Th t={t} align="left">Aviseur</Th>
                        <Th t={t} align="center">Dépt</Th>
                        <Th t={t}>En retard</Th>
                        <Th t={t}>Signalés</Th>
                        <Th t={t}>Bons ouverts</Th>
                        <Th t={t}>Valeur en attente</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {aSuivre.map(a => (
                        <tr key={a.id}
                          onClick={() => setSelId(selId === a.id ? null : a.id)}
                          onMouseEnter={e => (e.currentTarget.style.background = t.hvr)}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                          style={{ borderBottom: `1px solid ${t.bdr}`, cursor: 'pointer' }}>
                          <td style={{ padding: '9px 12px', fontWeight: 600, color: selId === a.id ? t.C.blue : undefined }}>{a.nom}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'center' }}>
                            <Badge t={t} couleur={t.sub}>{DEPT_LABEL(a.departement)}</Badge>
                          </td>
                          <td style={{ ...tdNum, fontFamily: undefined, color: a.bonsEnRetard > 0 ? t.C.red : undefined, fontWeight: a.bonsEnRetard > 0 ? 700 : 400 }}>{a.bonsEnRetard}</td>
                          <td style={{ ...tdNum, fontFamily: undefined, color: a.bonsSignales > 0 ? t.C.red : undefined, fontWeight: a.bonsSignales > 0 ? 700 : 400 }}>{a.bonsSignales}</td>
                          <td style={{ ...tdNum, fontFamily: undefined }}>{a.bonsOuverts}</td>
                          <td style={tdNum}>{fmtArgentCourt(a.valeurEnAttente)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Carte>

              {selId && <AdvisorDashboard {...t} advisorId={selId} onClose={() => setSelId(null)} />}

              {/* Répartition par âge */}
              <Carte t={t} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <SectionTitre t={t} titre="Répartition des bons ouverts par âge" />
                {data.ageParTranche.map((x: any) => (
                  <Gauge key={x.label} t={t} label={x.label} value={x.count}
                    maxValue={Math.max(1, ...data.ageParTranche.map((y: any) => y.count))} unit=" bons" />
                ))}
              </Carte>

              {/* Revenu par aviseur */}
              <Carte t={t} style={{ padding: 0 }}>
                <div style={{ padding: '16px 18px 12px' }}>
                  <SectionTitre t={t} titre="Revenu par aviseur — Mois à Date" aide="Clique une barre pour le détail de l'aviseur." />
                </div>
                <div style={{ padding: '0 18px 18px' }}>
                  <BarresHorizontales
                    t={t}
                    items={classementTrie.map(a => ({ id: a.id, label: `${a.nom} · ${DEPT_LABEL(a.departement)}`, valeur: a.revenuGenere }))}
                    format={fmtArgentCourt}
                    onClick={id => setSelId(selId === id ? null : id)}
                    selectedId={selId}
                  />
                </div>
              </Carte>

              {/* Classement complet triable */}
              <Carte t={t} style={{ padding: 0, overflow: 'auto' }}>
                <div style={{ padding: '16px 18px 12px' }}>
                  <SectionTitre t={t} titre="Classement des aviseurs" aide="Clique un en-tête pour trier, une ligne pour le détail." />
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
                      <ThTriable t={t} label="Aviseur" colonne="nom" actif={sortKey} dir={sortDir} onSort={toggleSort} align="left" />
                      <Th t={t} align="center">Dépt</Th>
                      <ThTriable t={t} label="Revenu (MTD)" colonne="revenuGenere" actif={sortKey} dir={sortDir} onSort={toggleSort} />
                      <ThTriable t={t} label="Profit %" colonne="profitPct" actif={sortKey} dir={sortDir} onSort={toggleSort} />
                      <ThTriable t={t} label="Bons ouverts" colonne="bonsOuverts" actif={sortKey} dir={sortDir} onSort={toggleSort} />
                      <ThTriable t={t} label="En retard" colonne="bonsEnRetard" actif={sortKey} dir={sortDir} onSort={toggleSort} />
                      <ThTriable t={t} label="Signalés" colonne="bonsSignales" actif={sortKey} dir={sortDir} onSort={toggleSort} />
                      <ThTriable t={t} label="Valeur en attente" colonne="valeurEnAttente" actif={sortKey} dir={sortDir} onSort={toggleSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {classementTrie.map(a => (
                      <tr key={a.id}
                        onClick={() => setSelId(selId === a.id ? null : a.id)}
                        onMouseEnter={e => (e.currentTarget.style.background = t.hvr)}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        style={{ borderBottom: `1px solid ${t.bdr}`, cursor: 'pointer' }}>
                        <td style={{ padding: '9px 12px', fontWeight: 600, color: selId === a.id ? t.C.blue : undefined }}>{a.nom}</td>
                        <td style={{ padding: '9px 12px', textAlign: 'center', fontSize: 11, color: t.sub }}>{DEPT_LABEL(a.departement)}</td>
                        <td style={tdNum}>{fmtArgentCourt(a.revenuGenere)}</td>
                        <td style={tdNum}>{a.profitPct !== null ? `${a.profitPct.toFixed(1)} %` : '—'}</td>
                        <td style={{ ...tdNum, fontFamily: undefined }}>{a.bonsOuverts}</td>
                        <td style={{ ...tdNum, fontFamily: undefined, color: a.bonsEnRetard > 0 ? t.C.red : undefined, fontWeight: a.bonsEnRetard > 0 ? 700 : 400 }}>{a.bonsEnRetard}</td>
                        <td style={{ ...tdNum, fontFamily: undefined, color: a.bonsSignales > 0 ? t.C.red : undefined, fontWeight: a.bonsSignales > 0 ? 700 : 400 }}>{a.bonsSignales}</td>
                        <td style={tdNum}>{fmtArgentCourt(a.valeurEnAttente)}</td>
                      </tr>
                    ))}
                    {classementTrie.length === 0 && (
                      <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: t.sub }}>Aucun aviseur.</td></tr>
                    )}
                  </tbody>
                </table>
              </Carte>

              {/* Performance financière compilée */}
              <Carte t={t} style={{ padding: 0, overflow: 'auto' }}>
                <div style={{ padding: '16px 18px 12px' }}>
                  <SectionTitre
                    t={t}
                    titre="Performance financière — Mois à Date"
                    aide={dept === 'tous'
                      ? 'Tous départements confondus, ventilée par catégorie (Client / Interne / Garantie / Total / Autre).'
                      : `Département ${DEPT_LABEL(dept)}, ventilée par catégorie.`}
                  />
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
                      <Th t={t} align="left">Indicateur</Th>
                      {data.financier.categories.map((c: string) => <Th key={c} t={t}>{c.replace('|', ' · ')}</Th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {data.financier.rows.map((row: any) => (
                      <tr key={row.key} style={{ borderBottom: `1px solid ${t.bdr}` }}>
                        <td style={{ padding: '9px 12px', fontWeight: 600 }}>{row.titre}</td>
                        {data.financier.categories.map((c: string) => {
                          const v = row.valeurs[c]
                          return <td key={c} style={tdNum}>{v === null || v === undefined ? '—' : row.isPercent ? `${v.toFixed(1)} %` : fmtArgent(v)}</td>
                        })}
                      </tr>
                    ))}
                    {data.financier.rows.length === 0 && (
                      <tr><td colSpan={data.financier.categories.length + 1} style={{ padding: 20, textAlign: 'center', color: t.sub }}>
                        Aucune donnée de performance importée.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </Carte>
            </>
          )}
        </>
      )}
    </div>
  )
}
