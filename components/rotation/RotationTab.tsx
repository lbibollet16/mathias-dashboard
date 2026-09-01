'use client'

// Onglet « Rotation & Fournisseurs ».
//
// Sept vues sur la même analyse pré-calculée :
//   Synthèse      — KPIs, verdict de chaque agent, constats les plus lourds
//   Fournisseurs  — stock, rotation et santé par fournisseur (Pareto)
//   Codes ligne   — même lecture, regroupée par famille de pièces
//   Pièces        — détail, filtrable, avec ABC/XYZ, Wilson, point de commande
//   Agents        — tous les constats, par agent
//   Réceptions    — alertes « commande trop importante rentrée en inventaire »
//   Archives      — snapshots mensuels, courbe de roulement, inventaire imprimable
//   Réglages      — paramètres supply chain + import mensuel des ventes
//
// Tout vient d'un run pré-calculé : aucun appel à Traction au chargement.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Theme, Carte, SectionTitre, KpiCard, GrilleKpi, Th, ThTriable, Badge, Message,
  fmtArgentCourt,
} from '@/components/meca/MecaUI'

type Vue = 'synthese' | 'fournisseurs' | 'lignes' | 'pieces' | 'agents' | 'receptions' | 'archives' | 'reglages'

const VUES: { id: Vue; label: string }[] = [
  { id: 'synthese', label: '📊 Synthèse' },
  { id: 'fournisseurs', label: '🏭 Fournisseurs' },
  { id: 'lignes', label: '🏷️ Codes de ligne' },
  { id: 'pieces', label: '🔩 Pièces' },
  { id: 'agents', label: '🤖 Agents' },
  { id: 'receptions', label: '🚨 Réceptions' },
  { id: 'archives', label: '🗄️ Archives' },
  { id: 'reglages', label: '⚙️ Réglages' },
]

const AGENTS: Record<string, { nom: string; icone: string; quoi: string }> = {
  pareto:     { nom: 'Pareto / ABC',   icone: '📐', quoi: 'Où se concentre le capital : 80 % de la consommation vient d\'une poignée de pièces.' },
  rotation:   { nom: 'Rotation',       icone: '🔄', quoi: 'Combien de fois le stock se renouvelle par an. Coût des ventes ÷ stock moyen.' },
  wilson:     { nom: 'Wilson / EOQ',   icone: '📦', quoi: 'Quantité économique de commande : l\'arbitrage entre frais de commande et frais de possession.' },
  service:    { nom: 'Niveau de service', icone: '🎯', quoi: 'Stock de sécurité et point de commande pour tenir le taux de service visé.' },
  surstock:   { nom: 'Surstock',       icone: '📈', quoi: 'Ce qui dépasse l\'horizon de couverture cible et immobilise de la trésorerie.' },
  stock_mort: { nom: 'Stock mort',     icone: '💀', quoi: 'Pièces sans aucun mouvement — capital gelé, à retourner ou liquider.' },
  rupture:    { nom: 'Ruptures',       icone: '⛔', quoi: 'Pièces à demande active tombées à zéro : ventes perdues.' },
  reception:  { nom: 'Réceptions',     icone: '🚨', quoi: 'Commandes trop importantes entrées en inventaire.' },
  fiabilite:  { nom: 'Fiabilité',      icone: '🔍', quoi: 'Qualité des données : trous de ventes, coûts à zéro, pièces sans fournisseur.' },
}

const STATUTS: Record<string, { label: string; couleur: keyof Theme['C'] }> = {
  rupture:       { label: 'Rupture',        couleur: 'red' },
  sous_stock:    { label: 'Sous le seuil',  couleur: 'yellow' },
  ok:            { label: 'OK',             couleur: 'green' },
  surstock:      { label: 'Surstock',       couleur: 'yellow' },
  dormant:       { label: 'Dormant',        couleur: 'yellow' },
  mort:          { label: 'Stock mort',     couleur: 'red' },
  jamais_vendue: { label: 'Jamais vendue',  couleur: 'red' },
  sur_commande:  { label: 'Sur commande',   couleur: 'blue' },
}

// ── Formatage ────────────────────────────────────────────────────────────
const n0 = (v: any) => v === null || v === undefined ? '—' : Number(v).toLocaleString('fr-CA', { maximumFractionDigits: 0 })
const n1 = (v: any) => v === null || v === undefined ? '—' : Number(v).toLocaleString('fr-CA', { maximumFractionDigits: 1 })
const n2 = (v: any) => v === null || v === undefined ? '—' : Number(v).toLocaleString('fr-CA', { maximumFractionDigits: 2 })
const arg = (v: any) => v === null || v === undefined ? '—' : fmtArgentCourt(Number(v))
const pct = (v: any) => v === null || v === undefined ? '—' : Number(v).toLocaleString('fr-CA', { maximumFractionDigits: 1 }) + ' %'

/** Un nombre très grand devient illisible en tableau : 2 863 915 $ → 2,86 M$. */
const argCourt = (v: any) => {
  if (v === null || v === undefined) return '—'
  const x = Number(v)
  if (Math.abs(x) >= 1_000_000) return (x / 1_000_000).toLocaleString('fr-CA', { maximumFractionDigits: 2 }) + ' M$'
  if (Math.abs(x) >= 10_000) return Math.round(x / 1000).toLocaleString('fr-CA') + ' k$'
  return fmtArgentCourt(x)
}

export default function RotationTab(props: Theme & { profil?: any }) {
  const t: Theme = props
  const email = props.profil?.email || props.profil?.nom || null

  const [vue, setVue] = useState<Vue>('synthese')
  const [data, setData] = useState<any>(null)
  const [chargement, setChargement] = useState(true)
  const [recalcul, setRecalcul] = useState(false)
  const [msg, setMsg] = useState<{ type: 'info' | 'ok' | 'err'; texte: string } | null>(null)

  // Filtre transverse : cliquer un fournisseur bascule sur les pièces filtrées.
  const [filtreFournisseur, setFiltreFournisseur] = useState<string | null>(null)
  const [filtreLigne, setFiltreLigne] = useState<string | null>(null)

  const charger = useCallback(async () => {
    setChargement(true)
    try {
      const r = await fetch('/api/rotation')
      const j = await r.json()
      if (j.erreur) setMsg({ type: 'err', texte: j.erreur })
      else setData(j)
    } catch (e: any) {
      setMsg({ type: 'err', texte: e?.message || String(e) })
    } finally {
      setChargement(false)
    }
  }, [])

  useEffect(() => { charger() }, [charger])

  async function lancerRecalcul() {
    setRecalcul(true)
    setMsg({ type: 'info', texte: 'Recalcul en cours — lecture du feed Traction (130 000 pièces) et des ventes. Compte 30 à 90 secondes.' })
    try {
      const r = await fetch('/api/rotation/recalculer?declencheur=manuel', { method: 'POST' })
      const j = await r.json()
      if (!r.ok || j.erreur) setMsg({ type: 'err', texte: j.erreur || 'Échec du recalcul' })
      else {
        setMsg({ type: 'ok', texte: `✅ ${j.stats.pieces} pièces analysées, ${j.stats.findings} constats — en ${Math.round(j.duree_ms / 1000)} s.` })
        await charger()
      }
    } catch (e: any) {
      setMsg({ type: 'err', texte: e?.message || String(e) })
    } finally {
      setRecalcul(false)
    }
  }

  const kpis = data?.kpis || {}
  const groupes = data?.groupes || []
  const fournisseurs = useMemo(() => groupes.filter((g: any) => g.dimension === 'fournisseur'), [groupes])
  const lignes = useMemo(() => groupes.filter((g: any) => g.dimension === 'ligne'), [groupes])

  function ouvrirPieces(fournisseur: string | null, ligne: string | null) {
    setFiltreFournisseur(fournisseur)
    setFiltreLigne(ligne)
    setVue('pieces')
  }

  if (chargement && !data) {
    return <Carte t={t}><div style={{ padding: 30, textAlign: 'center', color: t.sub }}>Chargement de l'analyse…</div></Carte>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{`
        @media print {
          .rot-nocopy { display: none !important; }
          .rot-print  { break-inside: avoid; }
          body { background: #fff !important; }
        }
      `}</style>

      {/* ── En-tête ─────────────────────────────────────────────────── */}
      <Carte t={t} style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <SectionTitre t={t} titre="🔄 Rotation & Fournisseurs"
              aide="Stock par fournisseur et par code de ligne, roulement d'inventaire, et agents supply chain." />
            {data?.run && (
              <div style={{ fontSize: 11.5, color: t.sub, marginTop: 6 }}>
                Dernier calcul : {new Date(data.run.termine_le).toLocaleString('fr-CA')} ·{' '}
                {n0(data.run.nb_pieces)} pièces · {Math.round((data.run.duree_ms || 0) / 1000)} s ·{' '}
                déclenché par {data.run.declencheur}
              </div>
            )}
          </div>
          <div className="rot-nocopy" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={lancerRecalcul} disabled={recalcul}
              style={{
                padding: '9px 16px', borderRadius: 8, border: 'none', cursor: recalcul ? 'wait' : 'pointer',
                background: t.C.blue, color: '#fff', fontWeight: 700, fontSize: 13, opacity: recalcul ? 0.6 : 1,
              }}>
              {recalcul ? '⏳ Calcul…' : '🔄 Recalculer'}
            </button>
          </div>
        </div>

        {msg && <div style={{ marginTop: 12 }}><Message t={t} type={msg.type}>{msg.texte}</Message></div>}

        {/* Couverture des données — sans ça les chiffres se lisent mal. */}
        {kpis.mois_manquants?.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Message t={t} type="err">
              <strong>{kpis.mois_manquants.length} mois de ventes manquants</strong> sur les 12 de la fenêtre
              ({kpis.mois_manquants.join(', ')}). La demande est calculée sur les {kpis.mois_presents?.length} mois
              réellement importés — elle reste juste en moyenne, mais la saisonnalité et l'écart-type sont estimés
              sur moins de points. <em>Importe les rapports 2891 manquants dans l'onglet Réglages.</em>
            </Message>
          </div>
        )}
      </Carte>

      {/* ── Navigation ──────────────────────────────────────────────── */}
      <div className="rot-nocopy" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {VUES.map(v => {
          const actif = vue === v.id
          const pastille = v.id === 'receptions' && data?.nb_receptions_nouvelles > 0
            ? ` (${data.nb_receptions_nouvelles})` : ''
          return (
            <button key={v.id} onClick={() => setVue(v.id)}
              style={{
                padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                fontWeight: actif ? 800 : 600,
                border: `1px solid ${actif ? t.C.blue : t.bdr}`,
                background: actif ? (t.dark ? '#1a233a' : '#dbeafe') : t.card,
                color: actif ? t.C.blue : t.sub,
              }}>
              {v.label}{pastille}
            </button>
          )
        })}
      </div>

      {!data?.pret && (
        <Message t={t} type="info">
          Aucune analyse n'a encore été calculée. Clique sur <strong>Recalculer</strong> pour lancer le premier run.
          {' '}Pense d'abord à exécuter la migration SQL <code>2026-09-01_supply_chain_rotation.sql</code> dans Supabase.
        </Message>
      )}

      {vue === 'synthese' && <VueSynthese t={t} kpis={kpis} data={data} fournisseurs={fournisseurs} onVue={setVue} />}
      {vue === 'fournisseurs' && <VueGroupes t={t} titre="Stock par fournisseur" dimension="fournisseur" groupes={fournisseurs} onDrill={c => ouvrirPieces(c, null)} />}
      {vue === 'lignes' && <VueGroupes t={t} titre="Stock par code de ligne" dimension="ligne" groupes={lignes} onDrill={c => ouvrirPieces(null, c)} />}
      {vue === 'pieces' && <VuePieces t={t} fournisseur={filtreFournisseur} ligne={filtreLigne}
        setFournisseur={setFiltreFournisseur} setLigne={setFiltreLigne}
        listeFournisseurs={fournisseurs.map((g: any) => g.cle)} listeLignes={lignes.map((g: any) => g.cle)} />}
      {vue === 'agents' && <VueAgents t={t} resume={data?.findings_par_agent || []} />}
      {vue === 'receptions' && <VueReceptions t={t} email={email} onMaj={charger} />}
      {vue === 'archives' && <VueArchives t={t} snapshots={data?.snapshots || []} onMaj={charger} />}
      {vue === 'reglages' && <VueReglages t={t} config={data?.config} email={email} onMaj={charger} />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Synthèse
// ═══════════════════════════════════════════════════════════════════════

function VueSynthese({ t, kpis, data, fournisseurs, onVue }: {
  t: Theme; kpis: any; data: any; fournisseurs: any[]; onVue: (v: Vue) => void
}) {
  const [findings, setFindings] = useState<any[]>([])
  useEffect(() => {
    fetch('/api/rotation/findings?severite=critique,attention&limite=15')
      .then(r => r.json()).then(j => setFindings(j.findings || [])).catch(() => {})
  }, [data?.run?.run_id])

  const top = useMemo(() =>
    [...fournisseurs].sort((a, b) => b.valeur_stock - a.valeur_stock).slice(0, 12), [fournisseurs])
  const maxVal = Math.max(1, ...top.map(g => g.valeur_stock))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <GrilleKpi min={190}>
        <KpiCard t={t} label="Valeur d'inventaire" value={argCourt(kpis.valeur_stock)} />
        <KpiCard t={t} label="Roulement (fois/an)" value={n2(kpis.rotation_globale)} warn={kpis.rotation_globale < 2} />
        <KpiCard t={t} label="Jours de stock" value={kpis.dsi_global ? n0(kpis.dsi_global) + ' j' : '—'} warn={kpis.dsi_global > 180} />
        <KpiCard t={t} label="Stock mort" value={argCourt(kpis.valeur_morte)} warn={kpis.valeur_morte > 0} />
        <KpiCard t={t} label="Dormant (à surveiller)" value={argCourt(kpis.valeur_dormante)} />
        <KpiCard t={t} label="Excédent" value={argCourt(kpis.valeur_exces)} warn={kpis.valeur_exces > 0} />
        <KpiCard t={t} label="Ruptures actives" value={n0(kpis.nb_rupture)} warn={kpis.nb_rupture > 0} />
      </GrilleKpi>

      <Carte t={t}>
        <SectionTitre t={t} titre="Comment lire le roulement"
          aide={
            kpis.nb_snapshots > 0
              ? `Rotation = coût des ventes annualisé ÷ stock moyen. ${kpis.nb_snapshots} photo(s) mensuelle(s) archivée(s) alimentent le stock moyen ; la précision augmente à chaque 1er du mois.`
              : `Aucune photo mensuelle archivée pour l'instant : le stock moyen est approché par le stock du jour. Le premier snapshot automatique tombera le 1er du mois prochain.`
          } />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginTop: 14 }}>
          <Mini t={t} label="Coût des ventes (12 m annualisé)" valeur={argCourt(kpis.cogs_annualise)} />
          <Mini t={t} label="Stock moyen" valeur={argCourt(kpis.stock_moyen)} />
          <Mini t={t} label="Couverture des données" valeur={kpis.couverture_donnees || '—'} />
          <Mini t={t} label="Fournisseurs / codes de ligne" valeur={`${n0(kpis.nb_fournisseurs)} / ${n0(kpis.nb_lignes)}`} />
          <Mini t={t} label="Pièces suivies" valeur={`${n0(kpis.nb_pieces_stock)} en stock / ${n0(kpis.nb_pieces)}`} />
          <Mini t={t} label="Argent en jeu (constats)" valeur={argCourt(kpis.impact_total)} />
          <Mini t={t} label={`Écarté du calcul (${(kpis.exclusion?.lignes || []).join(', ') || '—'})`}
            valeur={kpis.exclusion ? `${n0(kpis.exclusion.nb_en_stock)} pcs · ${argCourt(kpis.exclusion.valeur)}` : '—'} />
          <Mini t={t} label="Historique disponible depuis" valeur={kpis.profondeur_historique || '—'} />
          <Mini t={t} label="Pièces sur commande (non stockées)" valeur={n0(kpis.nb_sur_commande)} />
          <Mini t={t} label="Pièces mortes / dormantes" valeur={`${n0(kpis.nb_mort)} / ${n0(kpis.nb_dormant)}`} />
        </div>
      </Carte>

      <Carte t={t}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <SectionTitre t={t} titre="Verdict des agents" aide="Chaque agent regarde le même stock sous un angle différent. Trié par argent en jeu." />
          <button onClick={() => onVue('agents')} style={btnLien(t)}>Tout voir →</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 14 }}>
          {(data?.findings_par_agent || []).map((a: any) => {
            const meta = AGENTS[a.agent] || { nom: a.agent, icone: '•', quoi: '' }
            const couleur = a.nb_critique > 0 ? t.C.red : a.nb_attention > 0 ? t.C.yellow : t.C.green
            return (
              <div key={a.agent} onClick={() => onVue('agents')}
                style={{ border: `1px solid ${t.bdr}`, borderLeft: `4px solid ${couleur}`, borderRadius: 10, padding: 14, cursor: 'pointer', background: t.card }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 800 }}>{meta.icone} {meta.nom}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: couleur }}>{argCourt(a.impact)}</span>
                </div>
                <div style={{ fontSize: 11.5, color: t.sub, marginTop: 6, lineHeight: 1.45 }}>{meta.quoi}</div>
                <div style={{ fontSize: 11.5, marginTop: 8, display: 'flex', gap: 8 }}>
                  {a.nb_critique > 0 && <Badge t={t} couleur={t.C.red}>{a.nb_critique} critique{a.nb_critique > 1 ? 's' : ''}</Badge>}
                  {a.nb_attention > 0 && <Badge t={t} couleur={t.C.yellow}>{a.nb_attention} à voir</Badge>}
                  {a.nb_critique === 0 && a.nb_attention === 0 && <Badge t={t} couleur={t.C.green}>RAS</Badge>}
                </div>
              </div>
            )
          })}
        </div>
      </Carte>

      <Carte t={t}>
        <SectionTitre t={t} titre="Où dort le capital" aide="Les 12 fournisseurs qui immobilisent le plus. La barre claire est la part qui ne tourne pas (stock mort + excédent)." />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: 14 }}>
          {top.map(g => {
            const fige = (g.valeur_morte || 0) + (g.valeur_exces || 0)
            return (
              <div key={g.cle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 600 }}>{g.cle}</span>
                  <span style={{ color: t.sub, fontFamily: 'monospace' }}>
                    {argCourt(g.valeur_stock)} · rotation {n2(g.rotation)}×
                    {fige > 0 && <span style={{ color: t.C.red }}> · {argCourt(fige)} figés</span>}
                  </span>
                </div>
                <div style={{ height: 12, borderRadius: 6, background: t.dark ? '#111' : '#eef1f5', border: `1px solid ${t.bdr}`, overflow: 'hidden', display: 'flex' }}>
                  <div style={{ width: `${((g.valeur_stock - fige) / maxVal) * 100}%`, background: t.C.blue }} />
                  <div style={{ width: `${(fige / maxVal) * 100}%`, background: t.C.red, opacity: 0.65 }} />
                </div>
              </div>
            )
          })}
        </div>
      </Carte>

      <Carte t={t}>
        <SectionTitre t={t} titre="Les 15 constats les plus lourds" aide="Toutes catégories confondues, triés par sévérité puis par argent en jeu." />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          {findings.length === 0 && <div style={{ color: t.sub, fontSize: 13 }}>Aucun constat critique. </div>}
          {findings.map((f, i) => <CarteFinding key={i} t={t} f={f} />)}
        </div>
      </Carte>
    </div>
  )
}

function Mini({ t, label, valeur }: { t: Theme; label: string; valeur: string }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: t.sub }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, marginTop: 3 }}>{valeur}</div>
    </div>
  )
}

const btnLien = (t: Theme): any => ({
  padding: '6px 12px', borderRadius: 8, border: `1px solid ${t.bdr}`,
  background: 'transparent', color: t.C.blue, cursor: 'pointer', fontSize: 12, fontWeight: 700,
})

function CarteFinding({ t, f }: { t: Theme; f: any }) {
  const [ouvert, setOuvert] = useState(false)
  const couleur = f.severite === 'critique' ? t.C.red : f.severite === 'attention' ? t.C.yellow : t.C.blue
  const meta = AGENTS[f.agent] || { nom: f.agent, icone: '•' }
  return (
    <div style={{ border: `1px solid ${t.bdr}`, borderLeft: `4px solid ${couleur}`, borderRadius: 10, padding: '11px 14px', background: t.card }}>
      <div onClick={() => setOuvert(o => !o)} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, cursor: 'pointer', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10.5, color: t.sub, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            {meta.icone} {meta.nom}{f.fournisseur ? ` · ${f.fournisseur}` : ''}
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 3 }}>{f.titre}</div>
        </div>
        <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          {Number(f.impact_dollars) > 0 && (
            <div style={{ fontSize: 14, fontWeight: 800, color: couleur }}>{argCourt(f.impact_dollars)}</div>
          )}
          <div style={{ fontSize: 11, color: t.sub }}>{ouvert ? '▲' : '▼'}</div>
        </div>
      </div>
      {ouvert && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${t.bdr}`, fontSize: 12.5, lineHeight: 1.6 }}>
          <div style={{ color: t.sub }}>{f.detail}</div>
          <div style={{ marginTop: 8, padding: '8px 11px', borderRadius: 8, background: `${t.C.blue}12`, border: `1px solid ${t.C.blue}44` }}>
            <strong style={{ color: t.C.blue }}>À faire :</strong> {f.action}
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Fournisseurs / codes de ligne
// ═══════════════════════════════════════════════════════════════════════

function VueGroupes({ t, titre, dimension, groupes, onDrill }: {
  t: Theme; titre: string; dimension: 'fournisseur' | 'ligne'; groupes: any[]; onDrill: (cle: string) => void
}) {
  const [tri, setTri] = useState('valeur_stock')
  const [sens, setSens] = useState<'asc' | 'desc'>('desc')
  const [q, setQ] = useState('')
  const [pareto, setPareto] = useState<string>('')
  const [sansStock, setSansStock] = useState(false)

  const filtres = useMemo(() => {
    let l = groupes
    if (!sansStock) l = l.filter(g => g.valeur_stock !== 0 || g.nb_pieces_stock > 0)
    if (pareto) l = l.filter(g => g.classe_pareto === pareto)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      l = l.filter(g => String(g.cle).toLowerCase().includes(s))
    }
    return [...l].sort((a, b) => {
      const av = a[tri], bv = b[tri]
      if (typeof av === 'string') return sens === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      const x = Number(av ?? -Infinity), y = Number(bv ?? -Infinity)
      return sens === 'asc' ? x - y : y - x
    })
  }, [groupes, tri, sens, q, pareto, sansStock])

  const totaux = useMemo(() => ({
    valeur: filtres.reduce((s, g) => s + g.valeur_stock, 0),
    cogs: filtres.reduce((s, g) => s + g.ventes_12m_cogs, 0),
    morte: filtres.reduce((s, g) => s + g.valeur_morte, 0),
    dormante: filtres.reduce((s, g) => s + (g.valeur_dormante || 0), 0),
    exces: filtres.reduce((s, g) => s + g.valeur_exces, 0),
    retournable: filtres.reduce((s, g) => s + (g.valeur_retournable || 0), 0),
  }), [filtres])

  const onSort = (k: string) => {
    if (k === tri) setSens(s => (s === 'asc' ? 'desc' : 'asc'))
    else { setTri(k); setSens('desc') }
  }

  return (
    <Carte t={t} style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: 16, borderBottom: `1px solid ${t.bdr}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
          <SectionTitre t={t} titre={titre}
            aide={`${filtres.length} ${dimension === 'fournisseur' ? 'fournisseurs' : 'codes de ligne'} · ${argCourt(totaux.valeur)} de stock · dont ${argCourt(totaux.morte + totaux.exces)} qui ne tournent pas. Clique une ligne pour voir ses pièces.`} />
          <a href={`/api/rotation/export?type=${dimension === 'fournisseur' ? 'fournisseurs' : 'lignes'}`}
            style={{ ...btnLien(t), textDecoration: 'none' }}>⬇ CSV</a>
        </div>

        <div className="rot-nocopy" style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Rechercher…"
            style={champ(t, 220)} />
          <select value={pareto} onChange={e => setPareto(e.target.value)} style={champ(t, 200)}>
            <option value="">Toutes classes Pareto</option>
            <option value="A">A — 80 % de la valeur</option>
            <option value="B">B — les 15 % suivants</option>
            <option value="C">C — la longue traîne</option>
          </select>
          <label style={{ fontSize: 12.5, color: t.sub, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={sansStock} onChange={e => setSansStock(e.target.checked)} />
            Inclure ceux sans stock
          </label>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead style={{ background: t.thBg, position: 'sticky', top: 0 }}>
            <tr>
              <ThTriable t={t} label={dimension === 'fournisseur' ? 'Fournisseur' : 'Code de ligne'} colonne="cle" actif={tri} dir={sens} onSort={onSort} align="left" />
              <ThTriable t={t} label="Valeur stock" colonne="valeur_stock" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="% cumulé" colonne="part_cumulee" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Pièces" colonne="nb_pieces_stock" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Coût ventes 12 m" colonne="ventes_12m_cogs" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Marge" colonne="marge_pct" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Rotation" colonne="rotation" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Jours stock" colonne="dsi_jours" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Mort" colonne="valeur_morte" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Dormant" colonne="valeur_dormante" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Excédent" colonne="valeur_exces" actif={tri} dir={sens} onSort={onSort} />
              {dimension === 'fournisseur' && <ThTriable t={t} label="Retournable" colonne="valeur_retournable" actif={tri} dir={sens} onSort={onSort} />}
              <ThTriable t={t} label="Rupt." colonne="nb_rupture" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Var. mois" colonne="variation_pct" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Santé" colonne="score_sante" actif={tri} dir={sens} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {filtres.map(g => (
              <tr key={g.cle} onClick={() => onDrill(g.cle)}
                style={{ borderTop: `1px solid ${t.bdr}`, cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = t.hvr)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <td style={{ padding: '8px 12px' }}>
                  <div style={{ fontWeight: 600 }}>{g.cle}</div>
                  <div style={{ fontSize: 10.5, color: t.sub }}>
                    classe {g.classe_pareto}
                    {g.nb_snapshots > 0 ? ` · ${g.nb_snapshots} snapshot(s)` : ' · rotation estimée'}
                  </div>
                </td>
                <Td>{argCourt(g.valeur_stock)}</Td>
                <Td>{pct(g.part_cumulee)}</Td>
                <Td>{n0(g.nb_pieces_stock)}</Td>
                <Td>{argCourt(g.ventes_12m_cogs)}</Td>
                <Td>{pct(g.marge_pct)}</Td>
                <Td couleur={g.rotation < 1 ? t.C.red : g.rotation < 2 ? t.C.yellow : t.C.green}>{n2(g.rotation)}</Td>
                <Td>{g.dsi_jours ? n0(g.dsi_jours) : '—'}</Td>
                <Td couleur={g.valeur_morte > 0 ? t.C.red : undefined}>{g.valeur_morte > 0 ? argCourt(g.valeur_morte) : '—'}</Td>
                <Td couleur={g.valeur_dormante > 0 ? t.C.yellow : undefined}>{g.valeur_dormante > 0 ? argCourt(g.valeur_dormante) : '—'}</Td>
                <Td couleur={g.valeur_exces > 0 ? t.C.yellow : undefined}>{g.valeur_exces > 0 ? argCourt(g.valeur_exces) : '—'}</Td>
                {dimension === 'fournisseur' && <Td couleur={g.valeur_retournable > 0 ? t.C.green : undefined}>{g.valeur_retournable > 0 ? argCourt(g.valeur_retournable) : '—'}</Td>}
                <Td couleur={g.nb_rupture > 0 ? t.C.red : undefined}>{g.nb_rupture || '—'}</Td>
                <Td couleur={g.variation_pct == null ? undefined : g.variation_pct > 0 ? t.C.yellow : t.C.green}>
                  {g.variation_pct == null ? '—' : (g.variation_pct > 0 ? '+' : '') + pct(g.variation_pct)}
                </Td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                  <BarreSante t={t} score={g.score_sante} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `2px solid ${t.bdr}`, fontWeight: 800, background: t.thBg }}>
              <td style={{ padding: '9px 12px' }}>Total ({filtres.length})</td>
              <Td>{argCourt(totaux.valeur)}</Td>
              <Td>—</Td><Td>—</Td>
              <Td>{argCourt(totaux.cogs)}</Td>
              <Td>—</Td>
              <Td>{n2(totaux.valeur > 0 ? totaux.cogs / totaux.valeur : 0)}</Td>
              <Td>—</Td>
              <Td>{argCourt(totaux.morte)}</Td>
              <Td>{argCourt(totaux.dormante)}</Td>
              <Td>{argCourt(totaux.exces)}</Td>
              {dimension === 'fournisseur' && <Td>{argCourt(totaux.retournable)}</Td>}
              <Td>—</Td><Td>—</Td><Td>—</Td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Carte>
  )
}

function Td({ children, couleur }: { children: any; couleur?: string }) {
  return <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', color: couleur, fontWeight: couleur ? 700 : 400 }}>{children}</td>
}

function BarreSante({ t, score }: { t: Theme; score: number }) {
  const s = Math.max(0, Math.min(100, Number(score) || 0))
  const col = s >= 70 ? t.C.green : s >= 45 ? t.C.yellow : t.C.red
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end' }}>
      <div style={{ width: 46, height: 7, borderRadius: 4, background: t.dark ? '#111' : '#eef1f5', overflow: 'hidden' }}>
        <div style={{ width: `${s}%`, height: '100%', background: col }} />
      </div>
      <span style={{ fontFamily: 'monospace', fontSize: 11.5, color: col, fontWeight: 700 }}>{Math.round(s)}</span>
    </div>
  )
}

const champ = (t: Theme, largeur?: number): any => ({
  padding: '7px 11px', borderRadius: 8, border: `1px solid ${t.bdr}`,
  background: t.card, color: 'inherit', fontSize: 12.5, width: largeur,
})

// ═══════════════════════════════════════════════════════════════════════
// Pièces
// ═══════════════════════════════════════════════════════════════════════

function VuePieces({ t, fournisseur, ligne, setFournisseur, setLigne, listeFournisseurs, listeLignes }: {
  t: Theme; fournisseur: string | null; ligne: string | null
  setFournisseur: (v: string | null) => void; setLigne: (v: string | null) => void
  listeFournisseurs: string[]; listeLignes: string[]
}) {
  const [pieces, setPieces] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [chargement, setChargement] = useState(false)
  const [q, setQ] = useState('')
  const [statut, setStatut] = useState('')
  const [abc, setAbc] = useState('')
  const [tri, setTri] = useState('valeur')
  const [sens, setSens] = useState<'asc' | 'desc'>('desc')
  const debounce = useRef<any>(null)

  const charger = useCallback(async () => {
    setChargement(true)
    const p = new URLSearchParams({ tri, sens, page: String(page), taille: '100' })
    if (fournisseur) p.set('fournisseur', fournisseur)
    if (ligne) p.set('ligne', ligne)
    if (statut) p.set('statut', statut)
    if (abc) p.set('abc', abc)
    if (q.trim()) p.set('q', q.trim())
    try {
      const r = await fetch(`/api/rotation/pieces?${p}`)
      const j = await r.json()
      setPieces(j.pieces || [])
      setTotal(j.total || 0)
    } finally { setChargement(false) }
  }, [fournisseur, ligne, statut, abc, q, tri, sens, page])

  useEffect(() => {
    clearTimeout(debounce.current)
    debounce.current = setTimeout(charger, q ? 350 : 0)
    return () => clearTimeout(debounce.current)
  }, [charger, q])

  // Un changement de filtre remet en page 1 — sinon on tombe sur une page vide.
  useEffect(() => { setPage(0) }, [fournisseur, ligne, statut, abc, q])

  const onSort = (k: string) => {
    if (k === tri) setSens(s => (s === 'asc' ? 'desc' : 'asc'))
    else { setTri(k); setSens('desc') }
  }

  const paramsExport = new URLSearchParams({ type: 'pieces' })
  if (fournisseur) paramsExport.set('fournisseur', fournisseur)
  if (ligne) paramsExport.set('ligne', ligne)
  if (statut) paramsExport.set('statut', statut)

  return (
    <Carte t={t} style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: 16, borderBottom: `1px solid ${t.bdr}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <SectionTitre t={t} titre="Détail par pièce"
            aide={`${n0(total)} pièces${fournisseur ? ` · ${fournisseur}` : ''}${ligne ? ` · ligne ${ligne}` : ''}. PC = point de commande, SS = stock de sécurité, EOQ = quantité économique de Wilson.`} />
          <a href={`/api/rotation/export?${paramsExport}`} style={{ ...btnLien(t), textDecoration: 'none' }}>⬇ CSV</a>
        </div>

        <div className="rot-nocopy" style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Code ou description…" style={champ(t, 240)} />
          <select value={fournisseur || ''} onChange={e => setFournisseur(e.target.value || null)} style={champ(t, 230)}>
            <option value="">Tous les fournisseurs</option>
            {listeFournisseurs.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={ligne || ''} onChange={e => setLigne(e.target.value || null)} style={champ(t, 180)}>
            <option value="">Tous les codes de ligne</option>
            {listeLignes.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <select value={statut} onChange={e => setStatut(e.target.value)} style={champ(t, 190)}>
            <option value="">Tous les statuts</option>
            <option value="rupture">Rupture</option>
            <option value="sous_stock">Sous le seuil</option>
            <option value="rupture,sous_stock">À commander</option>
            <option value="surstock">Surstock</option>
            <option value="mort,jamais_vendue">Stock mort</option>
            <option value="dormant">Dormant</option>
            <option value="sur_commande">Sur commande (non stockée)</option>
            <option value="ok">OK</option>
          </select>
          <select value={abc} onChange={e => setAbc(e.target.value)} style={champ(t, 130)}>
            <option value="">ABC : tout</option>
            <option value="A">A</option><option value="B">B</option><option value="C">C</option>
          </select>
          {(fournisseur || ligne || statut || abc || q) && (
            <button onClick={() => { setFournisseur(null); setLigne(null); setStatut(''); setAbc(''); setQ('') }}
              style={btnLien(t)}>✕ Réinitialiser</button>
          )}
        </div>
      </div>

      <div style={{ overflowX: 'auto', maxHeight: '70vh' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead style={{ background: t.thBg, position: 'sticky', top: 0, zIndex: 1 }}>
            <tr>
              <ThTriable t={t} label="Code" colonne="code" actif={tri} dir={sens} onSort={onSort} align="left" />
              <Th t={t} align="left">Classe</Th>
              <ThTriable t={t} label="Stock" colonne="stock" actif={tri} dir={sens} onSort={onSort} />
              <Th t={t}>Transit / cmd</Th>
              <ThTriable t={t} label="Valeur" colonne="valeur" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Demande /mois" colonne="demande" actif={tri} dir={sens} onSort={onSort} />
              <Th t={t}>12 mois</Th>
              <ThTriable t={t} label="Couverture" colonne="couverture" actif={tri} dir={sens} onSort={onSort} />
              <ThTriable t={t} label="Rotation" colonne="rotation" actif={tri} dir={sens} onSort={onSort} />
              <Th t={t}>SS / PC</Th>
              <Th t={t}>EOQ</Th>
              <ThTriable t={t} label="À commander" colonne="commander" actif={tri} dir={sens} onSort={onSort} />
              <Th t={t} align="left">Statut</Th>
            </tr>
          </thead>
          <tbody>
            {chargement && pieces.length === 0 && (
              <tr><td colSpan={13} style={{ padding: 24, textAlign: 'center', color: t.sub }}>Chargement…</td></tr>
            )}
            {!chargement && pieces.length === 0 && (
              <tr><td colSpan={13} style={{ padding: 24, textAlign: 'center', color: t.sub }}>Aucune pièce pour ces filtres.</td></tr>
            )}
            {pieces.map(p => {
              const st = STATUTS[p.statut] || { label: p.statut, couleur: 'blue' as const }
              return (
                <tr key={p.code_piece} style={{ borderTop: `1px solid ${t.bdr}` }}
                  onMouseEnter={e => (e.currentTarget.style.background = t.hvr)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <td style={{ padding: '7px 12px', maxWidth: 260 }}>
                    <div style={{ fontWeight: 700, fontFamily: 'monospace' }}>{p.code_piece}</div>
                    <div style={{ fontSize: 10.5, color: t.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.description || '—'}
                    </div>
                    <div style={{ fontSize: 10, color: t.sub }}>{p.fournisseur} · {p.code_ligne}</div>
                  </td>
                  <td style={{ padding: '7px 12px' }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 12.5 }}>
                      {p.classe_abc}{p.classe_xyz}
                    </span>
                  </td>
                  <Td couleur={p.stock < 0 ? t.C.red : undefined}>{n0(p.stock)}</Td>
                  <Td>{p.qte_transit || p.qte_commande ? `${n0(p.qte_transit)} / ${n0(p.qte_commande)}` : '—'}</Td>
                  <Td>{argCourt(p.valeur_stock)}</Td>
                  <Td>{n1(p.demande_mens)}</Td>
                  <Td>{n0(p.ventes_12m_qte)} u · {argCourt(p.ventes_12m_cogs)}</Td>
                  <Td couleur={p.couverture_mois == null ? undefined : p.couverture_mois > 24 ? t.C.red : p.couverture_mois > 12 ? t.C.yellow : undefined}>
                    {p.couverture_mois == null ? '—' : n1(p.couverture_mois) + ' m'}
                  </Td>
                  <Td>{n2(p.rotation)}</Td>
                  <Td>{n0(p.stock_securite)} / {n0(p.point_commande)}</Td>
                  <Td>{p.eoq > 0 ? n0(p.eoq) : '—'}</Td>
                  <Td couleur={p.qte_a_commander > 0 ? t.C.blue : undefined}>{p.qte_a_commander > 0 ? n0(p.qte_a_commander) : '—'}</Td>
                  <td style={{ padding: '7px 12px' }}>
                    <Badge t={t} couleur={t.C[st.couleur]}>{st.label}</Badge>
                    {p.derniere_vente && <div style={{ fontSize: 10, color: t.sub, marginTop: 3 }}>dern. {p.derniere_vente}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {total > 100 && (
        <div className="rot-nocopy" style={{ padding: 12, display: 'flex', justifyContent: 'center', gap: 10, alignItems: 'center', borderTop: `1px solid ${t.bdr}` }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={btnLien(t)}>← Précédent</button>
          <span style={{ fontSize: 12.5, color: t.sub }}>
            Page {page + 1} / {Math.ceil(total / 100)}
          </span>
          <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * 100 >= total} style={btnLien(t)}>Suivant →</button>
        </div>
      )}
    </Carte>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Agents
// ═══════════════════════════════════════════════════════════════════════

function VueAgents({ t, resume }: { t: Theme; resume: any[] }) {
  const [agent, setAgent] = useState('')
  const [severite, setSeverite] = useState('')
  const [findings, setFindings] = useState<any[]>([])
  const [chargement, setChargement] = useState(true)

  useEffect(() => {
    setChargement(true)
    const p = new URLSearchParams({ limite: '200' })
    if (agent) p.set('agent', agent)
    if (severite) p.set('severite', severite)
    fetch(`/api/rotation/findings?${p}`)
      .then(r => r.json()).then(j => setFindings(j.findings || []))
      .finally(() => setChargement(false))
  }, [agent, severite])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Carte t={t}>
        <SectionTitre t={t} titre="Les agents supply chain"
          aide="Chaque agent applique une méthode reconnue au même jeu de données et rend un constat chiffré, avec l'action à poser." />
        <div className="rot-nocopy" style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button onClick={() => setAgent('')} style={{ ...btnLien(t), fontWeight: agent === '' ? 800 : 600 }}>Tous</button>
          {resume.map(a => {
            const meta = AGENTS[a.agent] || { nom: a.agent, icone: '•' }
            return (
              <button key={a.agent} onClick={() => setAgent(a.agent)}
                style={{ ...btnLien(t), fontWeight: agent === a.agent ? 800 : 600, borderColor: agent === a.agent ? t.C.blue : t.bdr }}>
                {meta.icone} {meta.nom} ({a.nb})
              </button>
            )
          })}
          <select value={severite} onChange={e => setSeverite(e.target.value)} style={champ(t, 170)}>
            <option value="">Toutes sévérités</option>
            <option value="critique">Critique</option>
            <option value="attention">À voir</option>
            <option value="info">Information</option>
          </select>
          <a href={`/api/rotation/export?type=findings${agent ? '&agent=' + agent : ''}`}
            style={{ ...btnLien(t), textDecoration: 'none' }}>⬇ CSV</a>
        </div>
        {agent && AGENTS[agent] && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: t.sub, lineHeight: 1.6, padding: '10px 13px', background: t.thBg, borderRadius: 8 }}>
            <strong>{AGENTS[agent].icone} {AGENTS[agent].nom}</strong> — {AGENTS[agent].quoi}
          </div>
        )}
      </Carte>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {chargement && <Carte t={t}><div style={{ textAlign: 'center', color: t.sub }}>Chargement…</div></Carte>}
        {!chargement && findings.length === 0 && (
          <Carte t={t}><div style={{ textAlign: 'center', color: t.sub }}>Aucun constat pour ce filtre.</div></Carte>
        )}
        {findings.map((f, i) => <CarteFinding key={i} t={t} f={f} />)}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Réceptions
// ═══════════════════════════════════════════════════════════════════════

const MOTIFS: Record<string, string> = {
  couverture: 'Couverture excessive',
  valeur: 'Montant élevé',
  eoq: 'Au-delà du lot économique',
  sans_vente: 'Pièce sans vente',
}

function VueReceptions({ t, email, onMaj }: { t: Theme; email: string | null; onMaj: () => void }) {
  const [rows, setRows] = useState<any[]>([])
  const [totaux, setTotaux] = useState<any>({})
  const [chargement, setChargement] = useState(true)
  const [statut, setStatut] = useState('nouveau,vu')
  const [toutes, setToutes] = useState(false)
  const [jours, setJours] = useState(180)

  const charger = useCallback(async () => {
    setChargement(true)
    const p = new URLSearchParams({ jours: String(jours), limite: '400' })
    if (statut) p.set('statut', statut)
    if (toutes) p.set('toutes', '1')
    try {
      const r = await fetch(`/api/rotation/receptions?${p}`)
      const j = await r.json()
      setRows(j.receptions || [])
      setTotaux(j.totaux || {})
    } finally { setChargement(false) }
  }, [statut, toutes, jours])

  useEffect(() => { charger() }, [charger])

  async function traiter(id: number, nouveauStatut: string) {
    const commentaire = nouveauStatut === 'justifie' || nouveauStatut === 'ignore'
      ? window.prompt('Commentaire (optionnel) :') ?? ''
      : undefined
    await fetch('/api/rotation/receptions', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, statut: nouveauStatut, commentaire, user_email: email }),
    })
    await charger()
    onMaj()
  }

  return (
    <Carte t={t} style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: 16, borderBottom: `1px solid ${t.bdr}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <SectionTitre t={t} titre="🚨 Réceptions trop importantes"
            aide="Chaque entrée de stock détectée par le sync Traction est évaluée sur quatre déclencheurs : couverture après réception, montant, multiple du lot économique de Wilson, et pièce sans historique de vente." />
          <a href={`/api/rotation/export?type=receptions&jours=${jours}${toutes ? '&toutes=1' : ''}`}
            style={{ ...btnLien(t), textDecoration: 'none' }}>⬇ CSV</a>
        </div>

        <GrilleKpi min={170}>
          <div style={{ marginTop: 14 }}><Mini t={t} label="Alertes affichées" valeur={n0(totaux.nb_alertes)} /></div>
          <div style={{ marginTop: 14 }}><Mini t={t} label="Non traitées" valeur={n0(totaux.nb_nouvelles)} /></div>
          <div style={{ marginTop: 14 }}><Mini t={t} label="Excédent immobilisé" valeur={argCourt(totaux.exces_valeur)} /></div>
          <div style={{ marginTop: 14 }}><Mini t={t} label="Valeur reçue (période)" valeur={argCourt(totaux.valeur_recue)} /></div>
        </GrilleKpi>

        <div className="rot-nocopy" style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={statut} onChange={e => setStatut(e.target.value)} style={champ(t, 210)}>
            <option value="nouveau,vu">À traiter</option>
            <option value="">Tous les statuts</option>
            <option value="nouveau">Nouvelles</option>
            <option value="a_retourner">À retourner</option>
            <option value="justifie">Justifiées</option>
            <option value="ignore">Ignorées</option>
          </select>
          <select value={jours} onChange={e => setJours(Number(e.target.value))} style={champ(t, 160)}>
            <option value={30}>30 jours</option>
            <option value={90}>90 jours</option>
            <option value={180}>6 mois</option>
            <option value={365}>1 an</option>
          </select>
          <label style={{ fontSize: 12.5, color: t.sub, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={toutes} onChange={e => setToutes(e.target.checked)} />
            Afficher aussi les réceptions sans alerte
          </label>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead style={{ background: t.thBg }}>
            <tr>
              <Th t={t} align="left">Date</Th>
              <Th t={t} align="left">Pièce</Th>
              <Th t={t}>Reçu</Th>
              <Th t={t}>Valeur</Th>
              <Th t={t}>Stock avant → après</Th>
              <Th t={t}>Demande</Th>
              <Th t={t}>Couv. après</Th>
              <Th t={t}>EOQ</Th>
              <Th t={t} align="left">Déclencheurs</Th>
              <Th t={t}>Excédent</Th>
              <Th t={t} align="left">Traitement</Th>
            </tr>
          </thead>
          <tbody>
            {chargement && <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: t.sub }}>Chargement…</td></tr>}
            {!chargement && rows.length === 0 && (
              <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: t.sub }}>
                Aucune réception signalée sur la période. Les réceptions sont détectées automatiquement à chaque sync Traction (2×/jour).
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id} style={{ borderTop: `1px solid ${t.bdr}` }}>
                <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 11.5 }}>{r.date_reception}</td>
                <td style={{ padding: '8px 12px', maxWidth: 250 }}>
                  <div style={{ fontWeight: 700, fontFamily: 'monospace' }}>{r.code_piece}</div>
                  <div style={{ fontSize: 10.5, color: t.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description || '—'}</div>
                  <div style={{ fontSize: 10, color: t.sub }}>{r.fournisseur}</div>
                </td>
                <Td>{n0(r.qte_recue)}</Td>
                <Td couleur={r.severite === 'critique' ? t.C.red : undefined}>{argCourt(r.valeur)}</Td>
                <Td>{n0(r.stock_avant)} → {n0(r.stock_apres)}</Td>
                <Td>{n1(r.demande_mens)}/m</Td>
                <Td couleur={r.couverture_apres > 24 ? t.C.red : r.couverture_apres > 12 ? t.C.yellow : undefined}>
                  {r.couverture_apres == null ? 'aucune vente' : n0(r.couverture_apres) + ' m'}
                </Td>
                <Td>{r.eoq > 0 ? n0(r.eoq) : '—'}</Td>
                <td style={{ padding: '8px 12px' }}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {(Array.isArray(r.motifs) ? r.motifs : []).map((m: string) => (
                      <Badge key={m} t={t} couleur={r.severite === 'critique' ? t.C.red : t.C.yellow}>{MOTIFS[m] || m}</Badge>
                    ))}
                    {(!r.motifs || r.motifs.length === 0) && <span style={{ color: t.sub }}>—</span>}
                  </div>
                </td>
                <Td couleur={r.exces_valeur > 0 ? t.C.red : undefined}>{r.exces_valeur > 0 ? argCourt(r.exces_valeur) : '—'}</Td>
                <td className="rot-nocopy" style={{ padding: '8px 12px' }}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {['justifie', 'a_retourner', 'ignore'].map(s => (
                      <button key={s} onClick={() => traiter(r.id, s)}
                        style={{
                          ...btnLien(t), padding: '4px 8px', fontSize: 11,
                          borderColor: r.statut === s ? t.C.blue : t.bdr,
                          background: r.statut === s ? (t.dark ? '#1a233a' : '#dbeafe') : 'transparent',
                        }}>
                        {s === 'justifie' ? '✓ Justifiée' : s === 'a_retourner' ? '↩ À retourner' : '✕ Ignorer'}
                      </button>
                    ))}
                  </div>
                  {r.commentaire && <div style={{ fontSize: 10.5, color: t.sub, marginTop: 4 }}>{r.commentaire}</div>}
                  {r.vu_par && <div style={{ fontSize: 10, color: t.sub }}>par {r.vu_par}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Carte>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Archives (snapshots mensuels + inventaire imprimable)
// ═══════════════════════════════════════════════════════════════════════

function VueArchives({ t, snapshots, onMaj }: { t: Theme; snapshots: any[]; onMaj: () => void }) {
  const [moisSel, setMoisSel] = useState<string>('')
  const [detail, setDetail] = useState<any>(null)
  const [cible, setCible] = useState<string>('')
  const [impression, setImpression] = useState<any>(null)
  const [chargement, setChargement] = useState(false)
  const [msg, setMsg] = useState<{ type: 'info' | 'ok' | 'err'; texte: string } | null>(null)

  useEffect(() => {
    if (!moisSel && snapshots.length > 0) setMoisSel(snapshots[snapshots.length - 1].mois)
  }, [snapshots, moisSel])

  useEffect(() => {
    if (!moisSel) return
    setChargement(true); setImpression(null); setCible('')
    fetch(`/api/rotation/snapshots?mois=${moisSel}`)
      .then(r => r.json()).then(j => setDetail(j.erreur ? null : j))
      .finally(() => setChargement(false))
  }, [moisSel])

  async function snapshotManuel() {
    const mois = window.prompt(
      'Mois à photographier (YYYY-MM).\n\n'
      + 'Le snapshot capture le stock ACTUEL de Traction et l\'archive sous ce mois. '
      + 'Utile pour créer un point de départ sans attendre le 1er du mois prochain.',
      new Date().toISOString().slice(0, 7))
    if (!mois) return
    setMsg({ type: 'info', texte: 'Photographie de l\'inventaire en cours…' })
    try {
      const r = await fetch(`/api/rotation/snapshot?mois=${mois}&force=1&source=manuel`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok || j.erreur) setMsg({ type: 'err', texte: j.erreur })
      else {
        setMsg({ type: 'ok', texte: `✅ Snapshot ${j.mois} : ${n0(j.stats.pieces)} pièces, ${argCourt(j.stats.valeur_totale)}.` })
        onMaj()
      }
    } catch (e: any) { setMsg({ type: 'err', texte: e?.message || String(e) }) }
  }

  async function ouvrirImpression(dimension: 'fournisseur' | 'ligne', valeur: string) {
    setCible(valeur); setChargement(true)
    const r = await fetch(`/api/rotation/snapshots?mois=${moisSel}&${dimension}=${encodeURIComponent(valeur)}`)
    const j = await r.json()
    setImpression(j.erreur ? null : j)
    setChargement(false)
  }

  const serie = snapshots.map((s: any) => Number(s.valeur_totale))
  const maxSerie = Math.max(1, ...serie)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Carte t={t}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <SectionTitre t={t} titre="🗄️ Inventaire archivé — le 1er de chaque mois"
            aide="Le cron photographie automatiquement l'inventaire complet le 1er de chaque mois. Le snapshot pris le 1er septembre porte le mois « 2026-08 » : il photographie la clôture d'août." />
          <button onClick={snapshotManuel} className="rot-nocopy" style={btnLien(t)}>📸 Snapshot manuel</button>
        </div>

        {msg && <div style={{ marginTop: 12 }}><Message t={t} type={msg.type}>{msg.texte}</Message></div>}

        {snapshots.length === 0 ? (
          <div style={{ marginTop: 14 }}>
            <Message t={t} type="info">
              Aucune archive pour l'instant. Le premier snapshot automatique tombera le 1er du mois prochain.
              Pour démarrer la série tout de suite (et rendre la rotation fiable plus vite), lance un
              <strong> snapshot manuel</strong>.
            </Message>
          </div>
        ) : (
          <>
            {/* Courbe de la valeur d'inventaire — le roulement à l'échelle de l'entrepôt. */}
            <div style={{ marginTop: 16, display: 'flex', alignItems: 'flex-end', gap: 6, height: 130 }}>
              {snapshots.map((s: any, i: number) => {
                const h = (Number(s.valeur_totale) / maxSerie) * 100
                const actif = s.mois === moisSel
                return (
                  <div key={s.mois} onClick={() => setMoisSel(s.mois)}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', minWidth: 34 }}
                    title={`${s.mois} : ${argCourt(s.valeur_totale)} · ${n0(s.nb_pieces)} pièces`}>
                    <div style={{ fontSize: 9.5, color: t.sub, marginBottom: 3 }}>{argCourt(s.valeur_totale)}</div>
                    <div style={{
                      width: '100%', height: `${Math.max(3, h)}%`, borderRadius: '4px 4px 0 0',
                      background: actif ? t.C.blue : (t.dark ? '#2a3550' : '#c7d7f5'),
                    }} />
                    <div style={{ fontSize: 10, color: actif ? t.C.blue : t.sub, marginTop: 4, fontWeight: actif ? 800 : 500 }}>
                      {s.mois.slice(2)}
                    </div>
                  </div>
                )
              })}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <select value={moisSel} onChange={e => setMoisSel(e.target.value)} style={champ(t, 170)}>
                {snapshots.map((s: any) => <option key={s.mois} value={s.mois}>{s.mois}</option>)}
              </select>
              <a href={`/api/rotation/export?type=snapshot&mois=${moisSel}`} style={{ ...btnLien(t), textDecoration: 'none' }}>
                ⬇ Inventaire complet {moisSel} (CSV)
              </a>
            </div>
          </>
        )}
      </Carte>

      {chargement && <Carte t={t}><div style={{ textAlign: 'center', color: t.sub }}>Chargement…</div></Carte>}

      {/* Inventaire imprimable d'un fournisseur */}
      {impression && (
        <Carte t={t}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>
                Inventaire {impression.dimension === 'fournisseur' ? 'fournisseur' : 'code de ligne'} — {impression.cible}
              </h3>
              <div style={{ fontSize: 12.5, color: t.sub, marginTop: 4 }}>
                Clôture {impression.entete.mois} · photographié le {impression.entete.date_snapshot} ·{' '}
                {n0(impression.totaux.nb_pieces)} pièces · {n0(impression.totaux.qte)} unités ·{' '}
                <strong>{argCourt(impression.totaux.valeur)}</strong>
              </div>
            </div>
            <div className="rot-nocopy" style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => window.print()} style={btnLien(t)}>🖨️ Imprimer</button>
              <a href={`/api/rotation/export?type=snapshot&mois=${impression.entete.mois}&${impression.dimension}=${encodeURIComponent(impression.cible)}`}
                style={{ ...btnLien(t), textDecoration: 'none' }}>⬇ CSV</a>
              <button onClick={() => setImpression(null)} style={btnLien(t)}>✕ Fermer</button>
            </div>
          </div>

          <div style={{ overflowX: 'auto', marginTop: 14 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: t.thBg }}>
                <tr>
                  <Th t={t} align="left">Code</Th>
                  <Th t={t} align="left">Description</Th>
                  <Th t={t} align="left">Localisation</Th>
                  {impression.dimension === 'fournisseur' && <Th t={t} align="left">Ligne</Th>}
                  <Th t={t}>Qté</Th>
                  <Th t={t}>Dispo</Th>
                  <Th t={t}>Réservé</Th>
                  <Th t={t}>Coût unit.</Th>
                  <Th t={t}>Valeur</Th>
                </tr>
              </thead>
              <tbody>
                {impression.lignes.map((l: any) => (
                  <tr key={l.code_piece} style={{ borderTop: `1px solid ${t.bdr}` }}>
                    <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontWeight: 600 }}>{l.code_piece}</td>
                    <td style={{ padding: '6px 10px' }}>{l.description || '—'}</td>
                    <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontSize: 11 }}>{l.localisation || '—'}</td>
                    {impression.dimension === 'fournisseur' && <td style={{ padding: '6px 10px' }}>{l.code_ligne}</td>}
                    <Td>{n0(l.qty)}</Td>
                    <Td>{n0(l.qty_dispo)}</Td>
                    <Td>{n0(l.qte_reserve)}</Td>
                    <Td>{n2(l.cout_unitaire)}</Td>
                    <Td>{n2(l.valeur)}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${t.bdr}`, fontWeight: 800 }}>
                  <td colSpan={impression.dimension === 'fournisseur' ? 4 : 3} style={{ padding: '8px 10px' }}>
                    Total — {impression.totaux.nb_pieces} pièces
                  </td>
                  <Td>{n0(impression.totaux.qte)}</Td>
                  <Td>—</Td><Td>—</Td><Td>—</Td>
                  <Td>{n2(impression.totaux.valeur)}</Td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Carte>
      )}

      {/* Répartition du mois archivé */}
      {detail && !impression && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
          {[
            { titre: 'Par fournisseur', rows: detail.fournisseurs, dim: 'fournisseur' as const },
            { titre: 'Par code de ligne', rows: detail.lignes, dim: 'ligne' as const },
          ].map(bloc => (
            <Carte t={t} key={bloc.dim} style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: 14, borderBottom: `1px solid ${t.bdr}` }}>
                <SectionTitre t={t} titre={`${bloc.titre} — ${detail.entete.mois}`}
                  aide="Clique une ligne pour ouvrir l'inventaire imprimable." />
              </div>
              <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead style={{ background: t.thBg, position: 'sticky', top: 0 }}>
                    <tr>
                      <Th t={t} align="left">{bloc.dim === 'fournisseur' ? 'Fournisseur' : 'Code'}</Th>
                      <Th t={t}>Pièces</Th>
                      <Th t={t}>Unités</Th>
                      <Th t={t}>Valeur</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(bloc.rows || []).map((a: any) => (
                      <tr key={a.cle} onClick={() => ouvrirImpression(bloc.dim, a.cle)}
                        style={{ borderTop: `1px solid ${t.bdr}`, cursor: 'pointer' }}
                        onMouseEnter={e => (e.currentTarget.style.background = t.hvr)}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <td style={{ padding: '7px 12px' }}>{a.cle}</td>
                        <Td>{n0(a.nb_pieces)}</Td>
                        <Td>{n0(a.qte_totale)}</Td>
                        <Td>{argCourt(a.valeur_totale)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Carte>
          ))}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Réglages + import mensuel des ventes
// ═══════════════════════════════════════════════════════════════════════

const CHAMPS_CONFIG: { cle: string; label: string; aide: string; pas: number; suffixe?: string }[] = [
  { cle: 'delai_jours', label: 'Délai fournisseur', aide: 'Jours entre la commande et la réception. Entre dans le point de commande et le stock de sécurité.', pas: 1, suffixe: 'jours' },
  { cle: 'niveau_service', label: 'Niveau de service', aide: 'Probabilité de ne pas être en rupture pendant le délai. 0,95 = 95 % (Z ≈ 1,645).', pas: 0.01 },
  { cle: 'cout_commande', label: 'Coût d\'un bon de commande', aide: 'Coût administratif d\'émettre un bon complet chez un fournisseur, tous articles confondus.', pas: 5, suffixe: '$' },
  { cle: 'cout_ligne_commande', label: 'Coût d\'une ligne de commande', aide: 'Coût d\'ajouter une référence à un bon déjà émis. C\'est CE coût qui entre dans Wilson au niveau de la pièce : le bon part de toute façon pour d\'autres références.', pas: 1, suffixe: '$' },
  { cle: 'max_commandes_an', label: 'Commandes max par an', aide: 'Rythme de réapprovisionnement le plus rapide possible (26 = aux deux semaines). Borne le calcul : un max à 1 unité ne veut pas dire une commande par vente.', pas: 1, suffixe: '/an' },
  { cle: 'taux_possession', label: 'Taux de possession', aide: 'Coût annuel de détention en % du coût unitaire (Wilson : H). 0,25 = 25 %/an.', pas: 0.01 },
  { cle: 'horizon_surstock_mois', label: 'Horizon de couverture', aide: 'Au-delà de N mois de stock, l\'excédent est signalé comme surstock.', pas: 1, suffixe: 'mois' },
  { cle: 'mois_stock_mort', label: 'Seuil stock mort', aide: 'Aucune vente depuis N mois → la pièce est classée morte.', pas: 1, suffixe: 'mois' },
  { cle: 'seuil_abc_a', label: 'Seuil Pareto A', aide: 'Part cumulée du coût des ventes qui définit la classe A. 0,80 = les 80 % classiques.', pas: 0.01 },
  { cle: 'seuil_abc_b', label: 'Seuil Pareto B', aide: 'Part cumulée qui délimite B et C. 0,95 par convention.', pas: 0.01 },
]

const CHAMPS_ALERTE: { cle: string; label: string; aide: string; pas: number; suffixe?: string }[] = [
  { cle: 'alerte_couverture_mois', label: 'Couverture après réception', aide: 'Alerte si la réception fait passer le stock au-delà de N mois de ventes.', pas: 1, suffixe: 'mois' },
  { cle: 'alerte_valeur_dollars', label: 'Valeur de la réception', aide: 'Alerte si une même pièce entre pour plus de N $ en une fois.', pas: 100, suffixe: '$' },
  { cle: 'alerte_multiple_eoq', label: 'Multiple du lot économique', aide: 'Alerte si la quantité reçue dépasse N fois la quantité optimale de Wilson.', pas: 0.5, suffixe: '×' },
  { cle: 'alerte_sans_vente_dollars', label: 'Pièce sans vente', aide: 'Alerte si une pièce sans vente sur 12 mois entre pour plus de N $.', pas: 50, suffixe: '$' },
  { cle: 'alerte_qte_min', label: 'Quantité plancher', aide: 'En dessous de N unités reçues, aucune alerte n\'est levée — évite le bruit sur les petites pièces.', pas: 1, suffixe: 'u' },
]

function VueReglages({ t, config, email, onMaj }: { t: Theme; config: any; email: string | null; onMaj: () => void }) {
  const [cfg, setCfg] = useState<any>(config || {})
  const [z, setZ] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ type: 'info' | 'ok' | 'err'; texte: string } | null>(null)
  const [enCours, setEnCours] = useState(false)

  useEffect(() => { setCfg(config || {}) }, [config])
  useEffect(() => {
    fetch('/api/rotation/config').then(r => r.json()).then(j => setZ(j.z ?? null)).catch(() => {})
  }, [])

  async function enregistrer() {
    setEnCours(true)
    try {
      const r = await fetch('/api/rotation/config', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cfg, user_email: email }),
      })
      const j = await r.json()
      if (!r.ok || j.erreur) setMsg({ type: 'err', texte: j.erreur })
      else {
        setZ(j.z ?? null)
        setMsg({ type: 'ok', texte: '✅ Paramètres enregistrés. Ils s\'appliqueront au prochain recalcul.' })
        onMaj()
      }
    } catch (e: any) { setMsg({ type: 'err', texte: e?.message || String(e) }) }
    finally { setEnCours(false) }
  }

  const champNum = (c: typeof CHAMPS_CONFIG[0]) => (
    <div key={c.cle} style={{ border: `1px solid ${t.bdr}`, borderRadius: 10, padding: 13 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700 }}>{c.label}</div>
      <div style={{ fontSize: 11, color: t.sub, marginTop: 4, lineHeight: 1.5, minHeight: 32 }}>{c.aide}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8 }}>
        <input type="number" step={c.pas} value={cfg[c.cle] ?? ''}
          onChange={e => setCfg((p: any) => ({ ...p, [c.cle]: e.target.value === '' ? '' : Number(e.target.value) }))}
          style={{ ...champ(t), width: 120, fontFamily: 'monospace' }} />
        {c.suffixe && <span style={{ fontSize: 12, color: t.sub }}>{c.suffixe}</span>}
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ImportVentes t={t} email={email} onMaj={onMaj} />

      <Carte t={t}>
        <SectionTitre t={t} titre="Paramètres de réapprovisionnement"
          aide={`Ces valeurs alimentent Wilson, le stock de sécurité et le point de commande.${z ? ` Coefficient Z actuel : ${n2(z)}.` : ''}`} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12, marginTop: 14 }}>
          {CHAMPS_CONFIG.map(champNum)}
          <div style={{ border: `1px solid ${t.bdr}`, borderRadius: 10, padding: 13 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>Codes de ligne écartés</div>
            <div style={{ fontSize: 11, color: t.sub, marginTop: 4, lineHeight: 1.5, minHeight: 32 }}>
              Ces lignes sont retirées dès la lecture du feed Traction : elles n'entrent ni dans les tableaux,
              ni dans les snapshots mensuels, ni dans les alertes de réception. AMA est la ligne Amazon,
              dont les ventes passent par les settlements et non par le rapport 2891.
            </div>
            <input type="text"
              value={Array.isArray(cfg.lignes_hors_perimetre) ? cfg.lignes_hors_perimetre.join(',') : (cfg.lignes_hors_perimetre ?? '')}
              onChange={e => setCfg((p: any) => ({ ...p, lignes_hors_perimetre: e.target.value }))}
              placeholder="AMA,FBA,FBM"
              style={{ ...champ(t), width: '100%', fontFamily: 'monospace', marginTop: 8 }} />
          </div>
        </div>
      </Carte>

      <Carte t={t}>
        <SectionTitre t={t} titre="Seuils d'alerte de réception"
          aide="Les quatre déclencheurs de l'alerte « commande trop importante rentrée en inventaire ». Une réception qui coche deux déclencheurs devient critique." />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12, marginTop: 14 }}>
          {CHAMPS_ALERTE.map(champNum)}
        </div>
        <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={enregistrer} disabled={enCours}
            style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: t.C.blue, color: '#fff', fontWeight: 700, fontSize: 13, cursor: enCours ? 'wait' : 'pointer' }}>
            {enCours ? 'Enregistrement…' : '💾 Enregistrer les paramètres'}
          </button>
          {msg && <Message t={t} type={msg.type}>{msg.texte}</Message>}
        </div>
      </Carte>
    </div>
  )
}

function ImportVentes({ t, email, onMaj }: { t: Theme; email: string | null; onMaj: () => void }) {
  const [mois, setMois] = useState<string>(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [fichier, setFichier] = useState<File | null>(null)
  const [apercu, setApercu] = useState<any>(null)
  const [etat, setEtat] = useState<'idle' | 'apercu' | 'import'>('idle')
  const [msg, setMsg] = useState<{ type: 'info' | 'ok' | 'err'; texte: string } | null>(null)
  const [couverture, setCouverture] = useState<any>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const chargerCouverture = useCallback(() => {
    fetch('/api/rotation/import-ventes').then(r => r.json()).then(setCouverture).catch(() => {})
  }, [])
  useEffect(() => { chargerCouverture() }, [chargerCouverture])

  async function envoyer(estApercu: boolean) {
    if (!fichier) { setMsg({ type: 'err', texte: 'Choisis d\'abord le fichier 2891.' }); return }
    setEtat(estApercu ? 'apercu' : 'import')
    setMsg({ type: 'info', texte: estApercu ? 'Lecture du fichier…' : 'Import en cours, puis recalcul complet — compte jusqu\'à 2 minutes.' })
    try {
      const fd = new FormData()
      fd.append('file', fichier)
      fd.append('mois', mois)
      if (estApercu) fd.append('apercu', '1')
      if (email) fd.append('user_email', email)

      const r = await fetch('/api/rotation/import-ventes', { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok || j.erreur) { setMsg({ type: 'err', texte: j.erreur || 'Échec' }); return }

      if (estApercu) {
        setApercu(j)
        setMsg({ type: 'info', texte: j.note })
      } else {
        setApercu(null)
        setFichier(null)
        if (inputRef.current) inputRef.current.value = ''
        setMsg({
          type: 'ok',
          texte: `✅ ${j.lignes_importees} pièces importées pour ${mois}`
            + (j.lignes_supprimees ? `, ${j.lignes_supprimees} lignes obsolètes retirées` : '')
            + `. Recalcul : ${j.recalcul}.`,
        })
        chargerCouverture()
        onMaj()
      }
    } catch (e: any) { setMsg({ type: 'err', texte: e?.message || String(e) }) }
    finally { setEtat('idle') }
  }

  const r = apercu?.resume

  return (
    <Carte t={t}>
      <SectionTitre t={t} titre="📥 Import mensuel des ventes (rapport Traction 2891)"
        aide="Chaque début de mois, télécharge le rapport 2891 et charge-le ici. Seul le bloc de gauche (mois en cours) est importé ; le bloc comparatif de droite est ignoré. Ré-importer un mois le remplace au lieu de le doubler." />

      {couverture?.mois_manquants?.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Message t={t} type="err">
            <strong>Mois absents de l'historique :</strong> {couverture.mois_manquants.join(', ')}.
            {' '}Chaque trou réduit la précision de la demande, de la saisonnalité et du stock de sécurité.
          </Message>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 12.5, color: t.sub }}>Mois du rapport</label>
        <input type="month" value={mois} onChange={e => setMois(e.target.value)} style={champ(t, 160)} />
        <input ref={inputRef} type="file" accept=".xlsx,.xls"
          onChange={e => { setFichier(e.target.files?.[0] || null); setApercu(null) }}
          style={{ ...champ(t), padding: 6 }} />
        <button onClick={() => envoyer(true)} disabled={etat !== 'idle' || !fichier} style={btnLien(t)}>
          {etat === 'apercu' ? 'Lecture…' : '🔍 Aperçu'}
        </button>
        <button onClick={() => envoyer(false)} disabled={etat !== 'idle' || !fichier}
          style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: t.C.green, color: '#fff', fontWeight: 700, fontSize: 13, cursor: etat !== 'idle' ? 'wait' : 'pointer', opacity: fichier ? 1 : 0.5 }}>
          {etat === 'import' ? 'Import…' : '📥 Importer'}
        </button>
      </div>

      {msg && <div style={{ marginTop: 12 }}><Message t={t} type={msg.type}>{msg.texte}</Message></div>}

      {r && (
        <div style={{ marginTop: 14, border: `1px solid ${t.bdr}`, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 10 }}>Aperçu de {r.fichier} → {r.mois}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <Mini t={t} label="Pièces distinctes" valeur={n0(r.nb_codes)} />
            <Mini t={t} label="Lignes du fichier" valeur={n0(r.nb_lignes_fichier)} />
            <Mini t={t} label="Quantité vendue" valeur={n0(r.quantite)} />
            <Mini t={t} label="Chiffre d'affaires" valeur={argCourt(r.revenus)} />
            <Mini t={t} label="Coût des ventes" valeur={argCourt(r.couts)} />
            <Mini t={t} label="Marge" valeur={pct(r.marge_pct)} />
          </div>
          <div style={{ fontSize: 11.5, color: t.sub, marginTop: 12, lineHeight: 1.6 }}>
            Bloc comparatif ignoré : {n0(r.bloc2_ignore?.quantite)} u pour {argCourt(r.bloc2_ignore?.revenus)}.
            {r.total_rapport && ` Total annoncé par le rapport : ${argCourt(r.total_rapport.revenus)}.`}
            {r.lignes_deja_en_base > 0 && ` ${r.lignes_deja_en_base} lignes existantes pour ${r.mois} seront remplacées.`}
          </div>
          {r.avertissements?.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {r.avertissements.map((a: string, i: number) => (
                <div key={i} style={{ fontSize: 11.5, color: t.C.yellow, marginTop: 3 }}>⚠ {a}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {couverture?.imports?.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12.5, color: t.sub }}>
            Historique des imports ({couverture.imports.length})
          </summary>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 10 }}>
            <thead style={{ background: t.thBg }}>
              <tr>
                <Th t={t} align="left">Mois</Th><Th t={t} align="left">Fichier</Th>
                <Th t={t}>Pièces</Th><Th t={t}>CA</Th><Th t={t}>Coût</Th>
                <Th t={t} align="left">Importé le</Th>
              </tr>
            </thead>
            <tbody>
              {couverture.imports.map((im: any) => (
                <tr key={im.id} style={{ borderTop: `1px solid ${t.bdr}` }}>
                  <td style={{ padding: '6px 10px', fontFamily: 'monospace' }}>{im.mois}</td>
                  <td style={{ padding: '6px 10px', fontSize: 11 }}>{im.fichier}</td>
                  <Td>{n0(im.nb_lignes)}</Td>
                  <Td>{argCourt(im.ca_total)}</Td>
                  <Td>{argCourt(im.cogs_total)}</Td>
                  <td style={{ padding: '6px 10px', fontSize: 11 }}>
                    {new Date(im.importe_le).toLocaleString('fr-CA')}
                    {im.importe_par ? ` · ${im.importe_par}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Carte>
  )
}
