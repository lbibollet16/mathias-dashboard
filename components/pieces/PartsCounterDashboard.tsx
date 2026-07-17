'use client'

// Onglet « Comptoir Pièces » — vue directeur. KPI globaux, commis à suivre
// impérativement (justificatifs manquants ou factures urgentes +20 j),
// répartition par âge, ventes par commis, classement triable. Clic = détail.

import { useEffect, useState, useMemo } from 'react'
import PartsClerkDashboard from './PartsClerkDashboard'
import {
  Theme, Carte, SectionTitre, KpiCard, GrilleKpi, Gauge, BarresHorizontales,
  ThTriable, Th, fmtArgent, fmtArgentCourt,
} from '@/components/meca/MecaUI'

export default function PartsCounterDashboard({ ...t }: Theme) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [erreur, setErreur] = useState<string | null>(null)
  const [selId, setSelId] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState('ventesTotal')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  useEffect(() => {
    let annule = false
    fetch('/api/pieces/summary')
      .then(r => r.json())
      .then(j => { if (!annule) { if (j.erreur) setErreur(j.erreur); else setData(j) } })
      .catch(e => { if (!annule) setErreur(String(e)) })
      .finally(() => { if (!annule) setLoading(false) })
    return () => { annule = true }
  }, [])

  const classement: any[] = data?.classementCommis ?? []
  const seuilMarge = data?.seuils?.margePct ?? 25

  const aSuivre = useMemo(() =>
    classement
      .map(c => ({ ...c, urgence: (c.justificatifsManquants ?? 0) + (c.facturesUrgentes20j ?? 0) }))
      .filter(c => c.urgence > 0)
      .sort((x, y) => y.urgence - x.urgence),
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

  if (loading) return <div style={{ padding: 24, color: t.sub, fontSize: 14 }}>⏳ Chargement du Comptoir Pièces…</div>
  if (erreur)  return <div style={{ padding: 24, color: t.C.red, fontSize: 14 }}>Erreur : {erreur}</div>
  if (!data)   return null

  if (data.clerks.length === 0) {
    return (
      <Carte t={t} style={{ fontSize: 14, color: t.sub, lineHeight: 1.6 }}>
        Aucun commis pièces actif — importe d'abord le rapport de vente de pièces dans l'onglet <strong>⚙️ Pièces — Réglages</strong>.
      </Carte>
    )
  }

  const fo = data.facturesOuvertes
  const tdNum: any = { padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12.5 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: t.C.blue, margin: 0 }}>🛠 Comptoir Pièces</h2>
        <p style={{ fontSize: 13, color: t.sub, margin: '4px 0 0' }}>
          {data.clerks.length} commis actif(s) — seuil de marge {seuilMarge} %, justificatif obligatoire à partir de {fmtArgentCourt(data.seuils.montantJustificatifObligatoire)} de vente.
        </p>
      </div>

      <GrilleKpi>
        <KpiCard t={t} label="Ventes totales" value={fmtArgentCourt(data.kpi.ventesTotal)} />
        <KpiCard t={t} label="Profit total" value={fmtArgentCourt(data.kpi.profitTotal)} />
        <KpiCard t={t} label="Profit % global" value={`${data.kpi.profitPctGlobal.toFixed(1)} %`} />
        <KpiCard t={t} label="Nb factures" value={String(data.kpi.nbFactures)} />
        <KpiCard t={t} label="Sous 25% marge" value={String(data.kpi.ventesSousSeuil)} warn={data.kpi.ventesSousSeuil > 0} />
        <KpiCard t={t} label="Taux de closing" value={data.tauxClosingGlobal !== null ? `${data.tauxClosingGlobal.toFixed(1)} %` : '—'} />
        <KpiCard t={t} label="Ouvertes +15 j" value={String(fo.plus15j)} warn={fo.plus15j > 0} />
        <KpiCard t={t} label="Urgent +20 j" value={String(fo.plus20jUrgent)} warn={fo.plus20jUrgent > 0} />
      </GrilleKpi>

      {fo.plus20jUrgent > 0 && (
        <div style={{ background: `${t.C.red}14`, border: `1px solid ${t.C.red}`, borderRadius: 10, padding: '12px 16px', fontSize: 13.5, color: t.C.red, fontWeight: 600 }}>
          🚨 {fo.plus20jUrgent} facture(s) pièce ouverte(s) depuis plus de 20 jours — à traiter en priorité.
        </div>
      )}

      {/* Commis à suivre impérativement */}
      <Carte t={t} style={{ padding: 0, overflow: 'auto', borderColor: aSuivre.length ? t.C.red : t.bdr }}>
        <div style={{ padding: '16px 18px 12px' }}>
          <SectionTitre t={t} titre={`🚨 Commis à suivre impérativement (${aSuivre.length})`} aide="Au moins un justificatif de marge manquant ou une facture urgente (+20 j). Clique pour le détail." />
        </div>
        {aSuivre.length === 0 ? (
          <div style={{ padding: '4px 18px 18px', color: t.C.green, fontSize: 13 }}>✅ Aucun commis en situation critique.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
                <Th t={t} align="left">Commis</Th>
                <Th t={t}>Justif. manquants</Th>
                <Th t={t}>Urgentes +20 j</Th>
                <Th t={t}>Sous 25 % marge</Th>
                <Th t={t}>Ventes</Th>
              </tr>
            </thead>
            <tbody>
              {aSuivre.map(c => (
                <tr key={c.id} onClick={() => setSelId(selId === c.id ? null : c.id)}
                  onMouseEnter={e => (e.currentTarget.style.background = t.hvr)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  style={{ borderBottom: `1px solid ${t.bdr}`, cursor: 'pointer' }}>
                  <td style={{ padding: '9px 12px', fontWeight: 600, color: selId === c.id ? t.C.blue : undefined }}>{c.nom}</td>
                  <td style={{ ...tdNum, fontFamily: undefined, color: c.justificatifsManquants > 0 ? t.C.red : undefined, fontWeight: c.justificatifsManquants > 0 ? 700 : 400 }}>{c.justificatifsManquants}</td>
                  <td style={{ ...tdNum, fontFamily: undefined, color: c.facturesUrgentes20j > 0 ? t.C.red : undefined, fontWeight: c.facturesUrgentes20j > 0 ? 700 : 400 }}>{c.facturesUrgentes20j}</td>
                  <td style={{ ...tdNum, fontFamily: undefined }}>{c.ventesSousSeuil}</td>
                  <td style={tdNum}>{fmtArgentCourt(c.ventesTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Carte>

      {selId && <PartsClerkDashboard {...t} clerkId={selId} onClose={() => setSelId(null)} />}

      <Carte t={t} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionTitre t={t} titre="Répartition des factures ouvertes par âge" />
        {fo.ageParTranche.map((x: any) => (
          <Gauge key={x.label} t={t} label={x.label} value={x.count} maxValue={Math.max(1, ...fo.ageParTranche.map((y: any) => y.count))} unit=" factures" />
        ))}
      </Carte>

      <Carte t={t} style={{ padding: 0 }}>
        <div style={{ padding: '16px 18px 12px' }}>
          <SectionTitre t={t} titre="Ventes par commis" aide="Clique une barre pour le détail." />
        </div>
        <div style={{ padding: '0 18px 18px' }}>
          <BarresHorizontales
            t={t}
            items={classementTrie.map(c => ({ id: c.id, label: c.nom, valeur: c.ventesTotal }))}
            format={fmtArgentCourt}
            onClick={id => setSelId(selId === id ? null : id)}
            selectedId={selId}
          />
        </div>
      </Carte>

      <Carte t={t} style={{ padding: 0, overflow: 'auto' }}>
        <div style={{ padding: '16px 18px 12px' }}>
          <SectionTitre t={t} titre="Classement des commis" aide="Clique un en-tête pour trier, une ligne pour le détail." />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
              <ThTriable t={t} label="Commis" colonne="nom" actif={sortKey} dir={sortDir} onSort={toggleSort} align="left" />
              <ThTriable t={t} label="Ventes" colonne="ventesTotal" actif={sortKey} dir={sortDir} onSort={toggleSort} />
              <ThTriable t={t} label="Profit %" colonne="profitPct" actif={sortKey} dir={sortDir} onSort={toggleSort} />
              <ThTriable t={t} label="Nb factures" colonne="nbFactures" actif={sortKey} dir={sortDir} onSort={toggleSort} />
              <ThTriable t={t} label="Sous 25 %" colonne="ventesSousSeuil" actif={sortKey} dir={sortDir} onSort={toggleSort} />
              <ThTriable t={t} label="Justif. manquants" colonne="justificatifsManquants" actif={sortKey} dir={sortDir} onSort={toggleSort} />
              <ThTriable t={t} label="Urgentes +20 j" colonne="facturesUrgentes20j" actif={sortKey} dir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {classementTrie.map(c => (
              <tr key={c.id} onClick={() => setSelId(selId === c.id ? null : c.id)}
                onMouseEnter={e => (e.currentTarget.style.background = t.hvr)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                style={{ borderBottom: `1px solid ${t.bdr}`, cursor: 'pointer' }}>
                <td style={{ padding: '9px 12px', fontWeight: 600, color: selId === c.id ? t.C.blue : undefined }}>{c.nom}</td>
                <td style={tdNum}>{fmtArgentCourt(c.ventesTotal)}</td>
                <td style={{ ...tdNum, color: c.profitPct !== null && c.profitPct < seuilMarge ? t.C.red : undefined, fontWeight: c.profitPct !== null && c.profitPct < seuilMarge ? 700 : 400 }}>
                  {c.profitPct !== null ? `${c.profitPct.toFixed(1)} %` : '—'}
                </td>
                <td style={{ ...tdNum, fontFamily: undefined }}>{c.nbFactures}</td>
                <td style={{ ...tdNum, fontFamily: undefined, color: c.ventesSousSeuil > 0 ? t.C.red : undefined, fontWeight: c.ventesSousSeuil > 0 ? 700 : 400 }}>{c.ventesSousSeuil}</td>
                <td style={{ ...tdNum, fontFamily: undefined, color: c.justificatifsManquants > 0 ? t.C.red : undefined, fontWeight: c.justificatifsManquants > 0 ? 700 : 400 }}>{c.justificatifsManquants}</td>
                <td style={{ ...tdNum, fontFamily: undefined, color: c.facturesUrgentes20j > 0 ? t.C.red : undefined, fontWeight: c.facturesUrgentes20j > 0 ? 700 : 400 }}>{c.facturesUrgentes20j}</td>
              </tr>
            ))}
            {classementTrie.length === 0 && <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: t.sub }}>Aucun commis.</td></tr>}
          </tbody>
        </table>
      </Carte>
    </div>
  )
}
