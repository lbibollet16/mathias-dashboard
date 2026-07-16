'use client'

// Suivi des bons de travail ouverts (bas de l'onglet Aviseur Technique).
//
// Vue tous départements, filtrable, avec réassignation manuelle de l'aviseur
// quand le fichier source attribue mal un bon. Une réassignation est marquée en
// base et les imports suivants ne l'écrasent plus.

import { useEffect, useState, useCallback } from 'react'
import { Theme, Carte, SectionTitre, KpiCard, GrilleKpi, Th, fmtArgent, fmtArgentCourt } from './MecaUI'

interface AdvisorLite { id: string, nom: string }
type Filtre = 'tous' | 'retard' | 'rush'

export default function SuiviBonsDeTravail({ advisors, ...t }: { advisors: AdvisorLite[] } & Theme) {
  const [workOrders, setWorkOrders] = useState<any[]>([])
  const [kpi, setKpi] = useState({ total: 0, enRetard: 0, signales: 0, valeurTotale: 0 })
  const [modeRush, setModeRush] = useState(false)
  const [joursRestants, setJoursRestants] = useState(0)
  const [loading, setLoading] = useState(true)
  const [erreur, setErreur] = useState<string | null>(null)

  const [dept, setDept] = useState('tous')
  const [advisorId, setAdvisorId] = useState('')
  const [filtre, setFiltre] = useState<Filtre>('tous')
  const [q, setQ] = useState('')
  // La recherche est debouncée : sans ça, chaque frappe déclenchait un appel API.
  const [qDebounce, setQDebounce] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setQDebounce(q), 300)
    return () => clearTimeout(id)
  }, [q])

  const charger = useCallback(async () => {
    setLoading(true); setErreur(null)
    try {
      const p = new URLSearchParams()
      if (dept !== 'tous') p.set('dept', dept)
      if (advisorId) p.set('advisorId', advisorId)
      p.set('filtre', filtre)
      if (qDebounce) p.set('q', qDebounce)
      const r = await fetch(`/api/meca/work-orders?${p.toString()}`)
      const j = await r.json()
      if (j.erreur) { setErreur(j.erreur); return }
      setWorkOrders(j.workOrders ?? [])
      setKpi(j.kpi ?? { total: 0, enRetard: 0, signales: 0, valeurTotale: 0 })
      setModeRush(j.modeRush ?? false)
      setJoursRestants(j.joursRestantsDansLeMois ?? 0)
    } catch (e: any) {
      setErreur(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [dept, advisorId, filtre, qDebounce])

  useEffect(() => { charger() }, [charger])

  async function reassigner(factureNo: string, newAdvisorId: string) {
    // Optimiste, puis rechargement pour refléter l'état réel du serveur.
    setWorkOrders(prev => prev.map(w => w.factureNo === factureNo ? { ...w, advisorId: newAdvisorId, assigneManuel: true } : w))
    const r = await fetch('/api/meca/work-orders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ factureNo, advisorId: newAdvisorId }),
    })
    const j = await r.json()
    if (j.erreur) setErreur(j.erreur)
    charger()
  }

  const couleurAge = (age: number) => age > 30 ? t.C.red : age >= 15 ? t.C.yellow : t.C.green
  const selectStyle: any = {
    padding: '7px 10px', borderRadius: 8, border: `1px solid ${t.bdr}`,
    fontSize: 13, background: t.card, color: 'inherit',
  }
  const tdNum: any = { padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12.5 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <SectionTitre
          t={t}
          titre="Suivi des bons de travail ouverts"
          aide="Vue d'ensemble tous départements — cible les bons en retard et permet de réassigner un aviseur."
        />
      </div>

      {modeRush && (
        <div style={{
          background: t.dark ? '#2b2411' : '#fef7e0', border: `1px solid ${t.C.yellow}`, borderRadius: 10,
          padding: '12px 16px', display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', flexWrap: 'wrap', gap: 8,
        }}>
          <div style={{ fontSize: 13.5, color: t.C.yellow, fontWeight: 600 }}>
            ⏰ Rush de fin de mois — {joursRestants} jour{joursRestants > 1 ? 's' : ''} restant{joursRestants > 1 ? 's' : ''} avant
            la bascule. Priorise la fermeture des bons ci-dessous.
          </div>
          <button
            onClick={() => setFiltre('rush')}
            style={{
              padding: '6px 14px', borderRadius: 8, border: `1px solid ${t.C.yellow}`,
              background: filtre === 'rush' ? t.C.yellow : 'transparent',
              color: filtre === 'rush' ? '#3c2f00' : t.C.yellow,
              fontWeight: 700, fontSize: 12.5, cursor: 'pointer',
            }}
          >
            Voir la liste à fermer
          </button>
        </div>
      )}

      {erreur && (
        <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: 13, color: t.C.red, background: `${t.C.red}14`, border: `1px solid ${t.C.red}55` }}>
          {erreur}
        </div>
      )}

      <GrilleKpi min={150}>
        <KpiCard t={t} label="Bons ouverts (filtrés)" value={String(kpi.total)} />
        <KpiCard t={t} label="En retard (+30 j)" value={String(kpi.enRetard)} warn={kpi.enRetard > 0} />
        <KpiCard t={t} label="Signalés (stagnants)" value={String(kpi.signales)} warn={kpi.signales > 0} />
        <KpiCard t={t} label="Valeur en attente" value={fmtArgentCourt(kpi.valeurTotale)} />
      </GrilleKpi>

      <Carte t={t} style={{ padding: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Pilule t={t} label="Tous"             actif={filtre === 'tous'}   onClick={() => setFiltre('tous')} />
        <Pilule t={t} label="En retard (+30j)" actif={filtre === 'retard'} onClick={() => setFiltre('retard')} couleur={t.C.red} />
        <Pilule t={t} label="Rush fin de mois" actif={filtre === 'rush'}   onClick={() => setFiltre('rush')} couleur={t.C.yellow} />

        <select value={dept} onChange={e => setDept(e.target.value)} style={selectStyle}>
          <option value="tous">Tous les départements</option>
          <option value="powersport">Powersport</option>
          <option value="marine">Marine</option>
        </select>

        <select value={advisorId} onChange={e => setAdvisorId(e.target.value)} style={selectStyle}>
          <option value="">Tous les aviseurs</option>
          {advisors.map(a => <option key={a.id} value={a.id}>{a.nom}</option>)}
        </select>

        <input
          type="text"
          placeholder="🔍 Rechercher facture, client, aviseur…"
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ ...selectStyle, flex: '1 1 220px' }}
        />
      </Carte>

      <Carte t={t} style={{ padding: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
              <Th t={t} align="left">#Facture</Th>
              <Th t={t} align="left">Client</Th>
              <Th t={t} align="left">Aviseur</Th>
              <Th t={t} align="center">Département</Th>
              <Th t={t}>Ouvert le</Th>
              <Th t={t}>Âge</Th>
              <Th t={t} align="center">Signalé</Th>
              <Th t={t}>Valeur</Th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: t.sub }}>⏳ Chargement…</td></tr>
            )}
            {!loading && workOrders.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: t.sub }}>Aucun bon de travail ne correspond à ces filtres.</td></tr>
            )}
            {!loading && workOrders.map(w => (
              <tr key={w.factureNo} style={{
                borderBottom: `1px solid ${t.bdr}`,
                background: w.enRetard ? (t.dark ? '#2a1512' : '#fdecea') : undefined,
              }}>
                <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{w.factureNo}</td>
                <td style={{ padding: '8px 12px' }}>{w.clientNom}</td>
                <td style={{ padding: '8px 12px' }}>
                  <select
                    value={w.advisorId}
                    onChange={e => reassigner(w.factureNo, e.target.value)}
                    title={w.assigneManuel ? 'Réassigné manuellement — les imports ne l\'écrasent plus' : 'Aviseur du fichier source'}
                    style={{
                      padding: '4px 6px', borderRadius: 6, fontSize: 12, color: 'inherit',
                      border: `1px solid ${w.assigneManuel ? t.C.blue : t.bdr}`,
                      background: w.assigneManuel ? `${t.C.blue}14` : t.card,
                    }}
                  >
                    {advisors.map(a => <option key={a.id} value={a.id}>{a.nom}</option>)}
                    {!advisors.some(a => a.id === w.advisorId) && <option value={w.advisorId}>{w.advisorNom}</option>}
                  </select>
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  {w.departement === 'powersport' ? 'Powersport' : w.departement === 'marine' ? 'Marine' : '—'}
                </td>
                <td style={tdNum}>{w.dateOuverture}</td>
                <td style={{ ...tdNum, fontFamily: undefined, fontWeight: w.ageJours >= 15 ? 700 : 400, color: couleurAge(w.ageJours) }}>
                  {w.ageJours} j
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  {w.signale && (
                    <span title="Non fermé depuis 2 imports ou plus"
                      style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: t.C.red }} />
                  )}
                </td>
                <td style={tdNum}>{fmtArgent(w.valeur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Carte>

      <div style={{ fontSize: 11.5, color: t.sub, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Point couleur={t.C.green}  label="0-14 j" />
        <Point couleur={t.C.yellow} label="15-30 j" />
        <Point couleur={t.C.red}    label="+30 j — en retard" />
      </div>
    </div>
  )
}

function Pilule({ t, label, actif, onClick, couleur }:
  { t: Theme, label: string, actif: boolean, onClick: () => void, couleur?: string }) {
  const col = couleur ?? t.C.blue
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px', borderRadius: 20, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
        border: `1px solid ${actif ? col : t.bdr}`,
        background: actif ? `${col}1f` : 'transparent',
        color: actif ? col : t.sub,
      }}
    >
      {label}
    </button>
  )
}

function Point({ couleur, label }: { couleur: string, label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: couleur }} />
      {label}
    </span>
  )
}
