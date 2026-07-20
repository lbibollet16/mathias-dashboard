'use client'

// Onglet « Aviseur Technique » — le seul du module qui écrit en base.
//
//  - import des 2 fichiers Excel sources (rapport aviseur + bons de travail) ;
//  - paramétrage : qui apparaît dans les dashboards, et dans quel département —
//    c'est ce réglage qui pilote les onglets Service Powersport / Marine ;
//  - suivi détaillé des bons ouverts, avec réassignation manuelle.

import { useEffect, useRef, useState } from 'react'
import AdvisorDashboard from './AdvisorDashboard'
import SuiviBonsDeTravail from './SuiviBonsDeTravail'
import { Theme, Carte, SectionTitre, Th, Badge } from './MecaUI'

interface AdvisorRow {
  id: string
  nom: string
  departement: 'powersport' | 'marine' | null
  actif: boolean
  bonsOuverts: number
  ageMoyenJours: number
  bonsSignales: number
}

export default function AviseurTechniqueTab({ ...t }: Theme) {
  const [advisors, setAdvisors] = useState<AdvisorRow[]>([])
  const [nomsRapport, setNomsRapport] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ type: 'info' | 'ok' | 'err', text: string } | null>(null)
  const [avertissements, setAvertissements] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [selectedAdvisorId, setSelectedAdvisorId] = useState<string | null>(null)
  const [renomme, setRenomme] = useState<{ id: string, nom: string } | null>(null)

  async function charger() {
    setLoading(true)
    try {
      const r = await fetch('/api/meca/advisors')
      const j = await r.json()
      if (j.erreur) setMsg({ type: 'err', text: j.erreur })
      else { setAdvisors(j.advisors ?? []); setNomsRapport(j.nomsRapportNonRattaches ?? []) }
    } catch (e: any) {
      setMsg({ type: 'err', text: e?.message || String(e) })
    } finally { setLoading(false) }
  }

  useEffect(() => { charger() }, [])

  async function importer(kind: 'rapport-aviseur' | 'bons-de-travail', file: File) {
    setUploading(true)
    setAvertissements([])
    setMsg({ type: 'info', text: `Import de ${file.name}…` })
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch(`/api/meca/import/${kind}`, { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok || j.erreur) {
        setMsg({ type: 'err', text: j.erreur || 'Erreur import' })
        if (j.warnings?.length) setAvertissements(j.warnings)
        return
      }
      const n = j.workOrdersImported ?? j.rowsImported ?? 0
      let texte = `✅ ${n} ligne(s) importée(s).`
      if (j.workOrdersClosedSinceLastImport != null) texte += ` ${j.workOrdersClosedSinceLastImport} bon(s) détecté(s) fermé(s).`
      if (j.nouveauxSignalements) texte += ` ${j.nouveauxSignalements} nouveau(x) signalement(s).`
      setMsg({ type: 'ok', text: texte })
      // Les avertissements sont affichés, pas juste envoyés dans la console :
      // ce sont eux qui expliquent une ligne manquante ou un aviseur non reconnu.
      setAvertissements(j.warnings ?? [])
      await charger()
    } catch (e: any) {
      setMsg({ type: 'err', text: e?.message || String(e) })
    } finally { setUploading(false) }
  }

  async function patcher(id: string, patch: any) {
    setAdvisors(prev => prev.map(a => (a.id === id ? { ...a, ...patch } : a)))
    const r = await fetch('/api/meca/advisors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    })
    const j = await r.json()
    if (j.erreur) { setMsg({ type: 'err', text: j.erreur }); charger(); return }
    if (j.perfRattachees) {
      setMsg({ type: 'ok', text: `✅ ${j.perfRattachees} ligne(s) du rapport aviseur rattachée(s) à cet aviseur.` })
      charger()
    }
  }

  // Transfert : donner tous les bons + la performance d'un aviseur à un autre
  // (départ d'un employé, ou vider un "Aviseur #NN" placeholder).
  async function transferer(id: string, vers: string) {
    const src = advisors.find(a => a.id === id)?.nom || id
    const dst = advisors.find(a => a.id === vers)?.nom || vers
    if (!confirm(`Transférer tout le suivi de « ${src} » vers « ${dst} » ? Cette action déplace ses bons de travail et sa performance.`)) return
    setMsg({ type: 'info', text: 'Transfert en cours…' })
    const r = await fetch('/api/meca/advisors', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, transfererVers: vers }),
    })
    const j = await r.json()
    if (j.erreur) setMsg({ type: 'err', text: j.erreur })
    else { setMsg({ type: 'ok', text: `✅ ${j.transfere.bons} bon(s) et ${j.transfere.perf} ligne(s) de performance transférés vers ${j.transfere.vers}.` }); charger() }
  }

  const selectStyle: any = {
    padding: '5px 8px', borderRadius: 6, border: `1px solid ${t.bdr}`,
    fontSize: 13, background: t.card, color: 'inherit',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: t.C.blue, margin: 0 }}>⚙️ Aviseur Technique</h2>
        <p style={{ fontSize: 13, color: t.sub, margin: '4px 0 0' }}>
          Importe les rapports Excel, assigne chaque aviseur à un département, et suis les bons de travail ouverts.
        </p>
      </div>

      <Carte t={t}>
        <SectionTitre
          t={t}
          titre="Importer les fichiers Excel"
          aide="Importe la liste des bons en premier : c'est elle qui crée les aviseurs. Le rapport aviseur se rattache ensuite par nom."
        />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 14 }}>
          <BoutonImport t={t} label="📊 Rapport des aviseurs technique (1612)" disabled={uploading} onFile={f => importer('rapport-aviseur', f)} />
          <BoutonImport t={t} label="📋 Liste des bons de travail (182)" disabled={uploading} onFile={f => importer('bons-de-travail', f)} />
        </div>
        {msg && (
          <div style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 8, fontSize: 13, lineHeight: 1.5,
            color: msg.type === 'err' ? t.C.red : msg.type === 'ok' ? t.C.green : t.C.blue,
            background: `${msg.type === 'err' ? t.C.red : msg.type === 'ok' ? t.C.green : t.C.blue}14`,
            border: `1px solid ${msg.type === 'err' ? t.C.red : msg.type === 'ok' ? t.C.green : t.C.blue}55`,
          }}>
            {msg.text}
          </div>
        )}
        {avertissements.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, color: t.C.yellow, fontWeight: 600 }}>
              ⚠️ {avertissements.length} avertissement(s) — cliquer pour voir
            </summary>
            <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 12, color: t.sub, lineHeight: 1.6 }}>
              {avertissements.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </details>
        )}
      </Carte>

      {/* Les noms du rapport en attente de rattachement, proposés à la saisie :
          le rattachement est une égalité de chaîne, autant éviter la faute de frappe. */}
      <datalist id="meca-noms-rapport">
        {nomsRapport.map(n => <option key={n} value={n} />)}
      </datalist>

      <Carte t={t} style={{ padding: 0, overflow: 'auto' }}>
        <div style={{ padding: '16px 18px 12px' }}>
          <SectionTitre
            t={t}
            titre="Paramétrage des aviseurs"
            aide="Détermine qui apparaît dans les dashboards Powersport / Marine, et dans lequel. Clique un nom pour son détail, ✏️ pour le renommer."
          />
          {nomsRapport.length > 0 && (
            <div style={{
              marginTop: 10, padding: '10px 14px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.6,
              color: t.C.yellow, background: `${t.C.yellow}14`, border: `1px solid ${t.C.yellow}55`,
            }}>
              ⚠️ {nomsRapport.length} nom(s) du rapport aviseur ne sont rattachés à aucun aviseur, donc leurs chiffres
              financiers n'apparaissent nulle part : {nomsRapport.map(n => `« ${n} »`).join(', ')}.<br />
              Les deux fichiers n'ont pas de clé commune — la liste des bons donne le numéro, le rapport donne le nom.
              Renomme l'« Aviseur #NN » correspondant avec ✏️ (les noms ci-dessus sont proposés à la saisie) : le
              rattachement se fera aussitôt, sans réimporter.
            </div>
          )}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: t.thBg, borderBottom: `1px solid ${t.bdr}` }}>
              <Th t={t} align="left">Aviseur</Th>
              <Th t={t} align="center">Bons ouverts</Th>
              <Th t={t} align="center">Âge moyen</Th>
              <Th t={t} align="center">Signalés</Th>
              <Th t={t} align="center">Département</Th>
              <Th t={t} align="center">Visible</Th>
              <Th t={t} align="center">Transférer vers</Th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: t.sub }}>⏳ Chargement…</td></tr>}
            {!loading && advisors.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: t.sub }}>
                Aucun aviseur — importe d'abord un des deux fichiers Excel ci-dessus.
              </td></tr>
            )}
            {!loading && advisors.map(a => (
              <tr key={a.id} style={{ borderBottom: `1px solid ${t.bdr}` }}>
                <td style={{ padding: '10px 12px' }}>
                  {renomme?.id === a.id ? (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <input
                        autoFocus
                        list="meca-noms-rapport"
                        value={renomme.nom}
                        onChange={e => setRenomme({ id: a.id, nom: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && renomme.nom.trim()) { patcher(a.id, { nom: renomme.nom.trim() }); setRenomme(null) }
                          if (e.key === 'Escape') setRenomme(null)
                        }}
                        style={{ ...selectStyle, width: 200 }}
                      />
                      <button onClick={() => { if (renomme.nom.trim()) patcher(a.id, { nom: renomme.nom.trim() }); setRenomme(null) }}
                        style={{ ...selectStyle, cursor: 'pointer', color: t.C.green, fontWeight: 700 }}>✓</button>
                      <button onClick={() => setRenomme(null)}
                        style={{ ...selectStyle, cursor: 'pointer', color: t.sub }}>✕</button>
                    </span>
                  ) : (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setSelectedAdvisorId(selectedAdvisorId === a.id ? null : a.id)}
                        style={{
                          background: 'none', border: 'none', padding: 0, fontWeight: 600, fontSize: 13,
                          color: selectedAdvisorId === a.id ? t.C.blue : 'inherit',
                          cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2,
                        }}
                      >
                        {a.nom}
                      </button>
                      <span style={{ color: t.sub, fontWeight: 400, fontSize: 11 }}>#{a.id}</span>
                      <button
                        onClick={() => setRenomme({ id: a.id, nom: a.nom })}
                        title="Renommer — utile pour les « Aviseur #NN » créés depuis la liste des bons"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: t.sub, padding: 0 }}
                      >
                        ✏️
                      </button>
                    </span>
                  )}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'center' }}>{a.bonsOuverts}</td>
                <td style={{
                  padding: '10px 12px', textAlign: 'center',
                  color: a.ageMoyenJours > 30 ? t.C.red : undefined,
                  fontWeight: a.ageMoyenJours > 30 ? 700 : 400,
                }}>
                  {a.ageMoyenJours} j
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                  {a.bonsSignales > 0
                    ? <Badge t={t} couleur={t.C.red}>{a.bonsSignales}</Badge>
                    : <span style={{ color: t.sub }}>—</span>}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                  <select
                    value={a.departement ?? ''}
                    onChange={e => patcher(a.id, { departement: e.target.value || null })}
                    style={selectStyle}
                  >
                    <option value="">— non assigné —</option>
                    <option value="powersport">Powersport</option>
                    <option value="marine">Marine</option>
                  </select>
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={a.actif}
                    onChange={e => patcher(a.id, { actif: e.target.checked })}
                    style={{ width: 16, height: 16, accentColor: t.C.blue, cursor: 'pointer' }}
                  />
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                  <select
                    value=""
                    onChange={e => { if (e.target.value) transferer(a.id, e.target.value); e.target.value = '' }}
                    title="Transférer tous ses bons et sa performance à un autre aviseur"
                    style={{ ...selectStyle, maxWidth: 150 }}
                  >
                    <option value="">— transférer… —</option>
                    {advisors.filter(x => x.id !== a.id).map(x => <option key={x.id} value={x.id}>{x.nom}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Carte>

      {selectedAdvisorId && (
        <AdvisorDashboard {...t} advisorId={selectedAdvisorId} onClose={() => setSelectedAdvisorId(null)} />
      )}

      <SuiviBonsDeTravail {...t} advisors={advisors} />
    </div>
  )
}

function BoutonImport({ t, label, disabled, onFile }:
  { t: Theme, label: string, disabled?: boolean, onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".xlsx,.xls"
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          // Réinitialisé pour permettre de réimporter le même fichier.
          e.target.value = ''
        }}
      />
      <button
        onClick={() => ref.current?.click()}
        disabled={disabled}
        style={{
          padding: '9px 16px', borderRadius: 8, border: `1px solid ${t.C.blue}`,
          background: disabled ? t.bdr : t.C.blue, color: disabled ? t.sub : '#fff',
          fontSize: 13, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {disabled ? '⏳ Import en cours…' : label}
      </button>
    </>
  )
}
