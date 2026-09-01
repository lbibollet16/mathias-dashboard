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

type Vue = 'actions' | 'fournisseurs' | 'lignes' | 'pieces' | 'agents' | 'receptions' | 'archives' | 'reglages'

// « À faire » d'abord : c'est la seule vue qu'on doit avoir besoin d'ouvrir un
// jour normal. Les autres sont là pour creuser quand on a une question précise.
const VUES: { id: Vue; label: string }[] = [
  { id: 'actions', label: '🎯 À faire' },
  { id: 'pieces', label: '🔩 Pièces' },
  { id: 'fournisseurs', label: '🏭 Fournisseurs' },
  { id: 'lignes', label: '🏷️ Codes de ligne' },
  { id: 'receptions', label: '🚨 Réceptions' },
  { id: 'agents', label: '🔬 Analyse détaillée' },
  { id: 'archives', label: '🗄️ Archives' },
  { id: 'reglages', label: '⚙️ Réglages' },
]

/** Filtre partagé : cliquer n'importe où dans l'onglet ouvre la liste de pièces
 *  correspondante. C'est ce qui relie « 1 364 320 $ de stock mort » aux 12 986
 *  pièces qui composent ce montant. */
export interface FiltrePieces {
  fournisseur: string | null
  ligne: string | null
  statut: string
  abc: string
  q: string
  tri: string
}

const FILTRE_VIDE: FiltrePieces = { fournisseur: null, ligne: null, statut: '', abc: '', q: '', tri: 'valeur' }

/** Chaque agent pointe vers les pièces qu'il a jugées : un constat sans la liste
 *  derrière n'est qu'une opinion. */
const STATUT_PAR_AGENT: Record<string, { statut: string; tri: string }> = {
  surstock:   { statut: 'surstock', tri: 'exces' },
  stock_mort: { statut: 'mort,jamais_vendue', tri: 'morte' },
  rupture:    { statut: 'rupture', tri: 'urgence' },
  service:    { statut: 'rupture,sous_stock', tri: 'urgence' },
  reception:  { statut: '', tri: 'valeur' },
  wilson:     { statut: '', tri: 'ventes' },
  rotation:   { statut: '', tri: 'valeur' },
  pareto:     { statut: '', tri: 'valeur' },
  fiabilite:  { statut: '', tri: 'valeur' },
}

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

  const [vue, setVue] = useState<Vue>('actions')
  const [data, setData] = useState<any>(null)
  const [chargement, setChargement] = useState(true)
  const [recalcul, setRecalcul] = useState(false)
  const [msg, setMsg] = useState<{ type: 'info' | 'ok' | 'err'; texte: string } | null>(null)

  const [filtre, setFiltre] = useState<FiltrePieces>(FILTRE_VIDE)

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

  /** Point d'entrée unique du drill-down : tout montant affiché mène à ses pièces. */
  function ouvrirPieces(p: Partial<FiltrePieces>) {
    setFiltre({ ...FILTRE_VIDE, ...p })
    setVue('pieces')
  }

  /** Drill-down depuis un constat d'agent : on croise le fournisseur (ou le code)
   *  du constat avec le statut que cet agent surveille. */
  function ouvrirDepuisFinding(f: any) {
    const map = STATUT_PAR_AGENT[f.agent] || { statut: '', tri: 'valeur' }
    if (f.code_piece) { ouvrirPieces({ q: f.code_piece, tri: map.tri }); return }
    ouvrirPieces({
      fournisseur: f.fournisseur || null,
      ligne: f.code_ligne || null,
      statut: map.statut,
      tri: map.tri,
    })
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

      {vue === 'actions' && <VueActions t={t} kpis={kpis} data={data} fournisseurs={fournisseurs}
        onVue={setVue} onPieces={ouvrirPieces} onFinding={ouvrirDepuisFinding} />}
      {vue === 'fournisseurs' && <VueGroupes t={t} titre="Stock par fournisseur" dimension="fournisseur" groupes={fournisseurs} onDrill={c => ouvrirPieces({ fournisseur: c })} />}
      {vue === 'lignes' && <VueGroupes t={t} titre="Stock par code de ligne" dimension="ligne" groupes={lignes} onDrill={c => ouvrirPieces({ ligne: c })} />}
      {vue === 'pieces' && <VuePieces t={t} filtre={filtre} setFiltre={setFiltre}
        listeFournisseurs={fournisseurs.map((g: any) => g.cle)} listeLignes={lignes.map((g: any) => g.cle)} />}
      {vue === 'agents' && <VueAgents t={t} resume={data?.findings_par_agent || []} onFinding={ouvrirDepuisFinding} />}
      {vue === 'receptions' && <VueReceptions t={t} email={email} onMaj={charger} />}
      {vue === 'archives' && <VueArchives t={t} snapshots={data?.snapshots || []} onMaj={charger} />}
      {vue === 'reglages' && <VueReglages t={t} config={data?.config} email={email} onMaj={charger} />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// « À faire » — la vue par défaut
// ═══════════════════════════════════════════════════════════════════════

/**
 * Une action = un geste concret, son montant, et la liste des pièces derrière.
 *
 * Le reste de l'onglet répond à « qu'est-ce qui se passe ? ». Cette vue-ci
 * répond à « qu'est-ce que je fais aujourd'hui ? », et c'est la seule question
 * qui se pose un jour normal. Les blocs sont triés par argent en jeu : le
 * premier de la liste est toujours celui qui rapporte le plus.
 */
interface Action {
  cle: string
  titre: string          // un verbe : ce qu'on fait
  quoi: string           // ce que le système a vu
  pourquoi: string       // pourquoi ça coûte
  montant: number
  libelleMontant: string
  nb: number
  couleur: string
  icone: string
  filtre?: Partial<FiltrePieces>
  vue?: Vue
}

function VueActions({ t, kpis, data, fournisseurs, onVue, onPieces, onFinding }: {
  t: Theme; kpis: any; data: any; fournisseurs: any[]
  onVue: (v: Vue) => void
  onPieces: (p: Partial<FiltrePieces>) => void
  onFinding: (f: any) => void
}) {
  const [findings, setFindings] = useState<any[]>([])
  const [detailsOuverts, setDetailsOuverts] = useState(false)

  useEffect(() => {
    fetch('/api/rotation/findings?severite=critique,attention&limite=12')
      .then(r => r.json()).then(j => setFindings(j.findings || [])).catch(() => {})
  }, [data?.run?.run_id])

  const nbRecep = data?.nb_receptions_nouvelles || 0
  const sansMinMax = Number(kpis.nb_sans_minmax || 0)
  const moisManquants: string[] = kpis.mois_manquants || []

  const actions: Action[] = useMemo(() => {
    const a: Action[] = [
      {
        cle: 'commander', icone: '🔴', couleur: t.C.red,
        titre: 'Commander maintenant',
        quoi: `${n0(kpis.nb_rupture)} pièces tenues en stock sont tombées à zéro, ${n0(kpis.nb_sous_stock)} sont sous leur point de commande.`,
        pourquoi: 'Chaque jour sans stock est une vente qui part chez le concurrent.',
        montant: Number(kpis.marge_exposee || 0),
        libelleMontant: 'de marge exposée par an',
        nb: Number(kpis.nb_rupture || 0) + Number(kpis.nb_sous_stock || 0),
        filtre: { statut: 'rupture,sous_stock', tri: 'urgence' },
      },
      {
        cle: 'liquider', icone: '💀', couleur: t.C.red,
        titre: 'Retourner ou liquider',
        quoi: `${n0(kpis.nb_mort)} pièces n'ont eu aucune vente depuis au moins 24 mois.`,
        pourquoi: `Ce capital est gelé et coûte environ ${argCourt(Number(kpis.valeur_morte || 0) * 0.25)}/an rien qu'à être entreposé.`,
        montant: Number(kpis.valeur_morte || 0),
        libelleMontant: 'de capital immobilisé',
        nb: Number(kpis.nb_mort || 0),
        filtre: { statut: 'mort,jamais_vendue', tri: 'morte' },
      },
      {
        cle: 'stopper', icone: '🟠', couleur: t.C.yellow,
        titre: 'Arrêter de commander',
        quoi: `${n0(kpis.nb_surstock)} pièces dépassent 12 mois de couverture.`,
        pourquoi: "L'excédent bloque de la trésorerie sur des pièces qui se vendent déjà lentement.",
        montant: Number(kpis.valeur_exces || 0),
        libelleMontant: 'au-delà de la couverture cible',
        nb: Number(kpis.nb_surstock || 0),
        filtre: { statut: 'surstock', tri: 'exces' },
      },
    ]

    if (nbRecep > 0) a.push({
      cle: 'receptions', icone: '🚨', couleur: t.C.red,
      titre: 'Justifier des réceptions',
      quoi: `${n0(nbRecep)} entrées en inventaire ont déclenché une alerte et personne ne les a encore regardées.`,
      pourquoi: 'Plus on attend, plus la fenêtre de retour au fournisseur se referme.',
      montant: Number(kpis.exces_receptions || 0),
      libelleMontant: "d'excédent reçu",
      nb: nbRecep,
      vue: 'receptions',
    })

    if (Number(kpis.valeur_dormante || 0) > 0) a.push({
      cle: 'surveiller', icone: '👁️', couleur: t.C.yellow,
      titre: 'Surveiller les dormantes',
      quoi: `${n0(kpis.nb_dormant)} pièces sans vente sur 12 mois, mais qui bougeaient encore il y a moins de 24 mois.`,
      pourquoi: "Elles ne sont pas mortes, elles y vont. C'est le dernier moment pour les retourner.",
      montant: Number(kpis.valeur_dormante || 0),
      libelleMontant: 'à surveiller',
      nb: Number(kpis.nb_dormant || 0),
      filtre: { statut: 'dormant', tri: 'valeur' },
    })

    if (sansMinMax > 0) a.push({
      cle: 'parametrer', icone: '🔧', couleur: t.C.blue,
      titre: 'Paramétrer les min/max',
      quoi: `${n0(sansMinMax)} pièces de classe A sont réapprovisionnées sans aucun seuil dans Traction.`,
      pourquoi: 'Sans seuil, le réappro se fait au jugé : on rate des ventes ou on surcommande.',
      montant: 0,
      libelleMontant: '',
      nb: sansMinMax,
      filtre: { abc: 'A', tri: 'ventes' },
    })

    if (moisManquants.length > 0) a.push({
      cle: 'donnees', icone: '📥', couleur: t.C.blue,
      titre: 'Importer les ventes manquantes',
      quoi: `${moisManquants.length} mois absents de l'historique : ${moisManquants.join(', ')}.`,
      pourquoi: 'Chaque trou dégrade la demande calculée, donc tous les seuils ci-dessus.',
      montant: 0,
      libelleMontant: '',
      nb: moisManquants.length,
      vue: 'reglages',
    })

    return a.filter(x => x.nb > 0).sort((x, y) => y.montant - x.montant)
  }, [kpis, nbRecep, sansMinMax, moisManquants, t])

  const top = useMemo(() =>
    [...fournisseurs]
      .sort((a, b) => (b.valeur_morte + b.valeur_exces) - (a.valeur_morte + a.valeur_exces))
      .slice(0, 10),
    [fournisseurs])
  const maxFige = Math.max(1, ...top.map(g => g.valeur_morte + g.valeur_exces))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Les trois seuls chiffres à retenir. Cliquables. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
        <Tuile t={t} label="Valeur d'inventaire" valeur={argCourt(kpis.valeur_stock)}
          note={`${n0(kpis.nb_pieces_stock)} pièces en stock`}
          onClick={() => onPieces({ tri: 'valeur' })} />
        <Tuile t={t} label="Roulement" valeur={`${n2(kpis.rotation_globale)}×/an`}
          note={kpis.dsi_global ? `${n0(kpis.dsi_global)} jours de stock` : ''}
          couleur={kpis.rotation_globale < 1 ? t.C.red : kpis.rotation_globale < 2 ? t.C.yellow : t.C.green} />
        <Tuile t={t} label="Capital qui ne tourne pas"
          valeur={argCourt(Number(kpis.valeur_morte || 0) + Number(kpis.valeur_exces || 0))}
          note={`${n0(Number(kpis.nb_mort || 0) + Number(kpis.nb_surstock || 0))} pièces`}
          couleur={t.C.red}
          onClick={() => onPieces({ statut: 'mort,jamais_vendue,surstock', tri: 'morte' })} />
      </div>

      {/* La liste d'actions. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {actions.map((a, i) => (
          <div key={a.cle} style={{
            background: t.card, border: `1px solid ${t.bdr}`, borderLeft: `5px solid ${a.couleur}`,
            borderRadius: 12, padding: '16px 18px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span style={{
                    width: 24, height: 24, borderRadius: '50%', background: a.couleur, color: '#fff',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12.5, fontWeight: 800, flexShrink: 0,
                  }}>{i + 1}</span>
                  <span style={{ fontSize: 16.5, fontWeight: 800 }}>{a.icone} {a.titre}</span>
                </div>
                <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.55 }}>{a.quoi}</div>
                <div style={{ fontSize: 12, color: t.sub, marginTop: 4, lineHeight: 1.5 }}>{a.pourquoi}</div>
              </div>
              <div style={{ textAlign: 'right', minWidth: 170 }}>
                {a.montant > 0 && (
                  <>
                    <div style={{ fontSize: 26, fontWeight: 800, color: a.couleur, lineHeight: 1.1 }}>
                      {argCourt(a.montant)}
                    </div>
                    <div style={{ fontSize: 11, color: t.sub, marginTop: 2 }}>{a.libelleMontant}</div>
                  </>
                )}
                <button
                  onClick={() => a.vue ? onVue(a.vue) : onPieces(a.filtre || {})}
                  style={{
                    marginTop: 10, padding: '9px 15px', borderRadius: 8, border: 'none',
                    background: a.couleur, color: '#fff', fontWeight: 700, fontSize: 12.5,
                    cursor: 'pointer', whiteSpace: 'nowrap',
                  }}>
                  {a.vue === 'receptions'
                    ? `Voir les ${n0(a.nb)} alertes →`
                    : a.vue === 'reglages'
                      ? 'Aller à l’import →'
                      : `Voir les ${n0(a.nb)} pièces →`}
                </button>
              </div>
            </div>
          </div>
        ))}
        {actions.length === 0 && (
          <Carte t={t}>
            <div style={{ textAlign: 'center', color: t.C.green, fontWeight: 700, padding: 20 }}>
              ✅ Rien à traiter — aucun seuil franchi.
            </div>
          </Carte>
        )}
      </div>

      {/* Chez qui le capital dort : de quoi préparer un appel ou un retour groupé. */}
      <Carte t={t}>
        <SectionTitre t={t} titre="Chez qui le capital dort"
          aide="Les 10 fournisseurs qui immobilisent le plus de stock mort et d'excédent. Clique une barre pour voir leurs pièces concernées." />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          {top.map(g => {
            const fige = (g.valeur_morte || 0) + (g.valeur_exces || 0)
            if (fige <= 0) return null
            return (
              <div key={g.cle}
                onClick={() => onPieces({ fournisseur: g.cle, statut: 'mort,jamais_vendue,surstock', tri: 'morte' })}
                style={{ cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 12.5, gap: 12 }}>
                  <span style={{ fontWeight: 600 }}>{g.cle}</span>
                  <span style={{ color: t.sub, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                    <strong style={{ color: t.C.red }}>{argCourt(fige)} figés</strong>
                    {' '}sur {argCourt(g.valeur_stock)} · rotation {n2(g.rotation)}×
                  </span>
                </div>
                <div style={{ height: 11, borderRadius: 6, background: t.dark ? '#111' : '#eef1f5', border: `1px solid ${t.bdr}`, overflow: 'hidden' }}>
                  <div style={{ width: `${(fige / maxFige) * 100}%`, height: '100%', background: t.C.red, opacity: .75 }} />
                </div>
              </div>
            )
          })}
        </div>
      </Carte>

      {/* Les cas nominatifs, sous la liste d'actions. */}
      <Carte t={t}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <SectionTitre t={t} titre="Les cas les plus lourds, nommément"
            aide="Clique un constat pour ouvrir les pièces qu'il désigne." />
          <button onClick={() => onVue('agents')} style={btnLien(t)}>Tous les constats →</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          {findings.length === 0 && <div style={{ color: t.sub, fontSize: 13 }}>Aucun constat critique.</div>}
          {findings.map((f, i) => <CarteFinding key={i} t={t} f={f} onVoir={onFinding} />)}
        </div>
      </Carte>

      {/* Le détail technique, replié : il ne doit pas encombrer la lecture. */}
      <Carte t={t}>
        <div onClick={() => setDetailsOuverts(o => !o)}
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', gap: 12 }}>
          <SectionTitre t={t} titre="Comment ces chiffres sont calculés"
            aide={kpis.nb_snapshots > 0
              ? `Roulement = coût des ventes annualisé ÷ stock moyen, sur ${kpis.nb_snapshots} photo(s) mensuelle(s) archivée(s).`
              : `Aucune photo mensuelle archivée : le stock moyen est approché par le stock du jour.`} />
          <span style={{ fontSize: 13, color: t.sub }}>{detailsOuverts ? '▲' : '▼'}</span>
        </div>
        {detailsOuverts && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginTop: 16 }}>
            <Mini t={t} label="Coût des ventes (12 m annualisé)" valeur={argCourt(kpis.cogs_annualise)} />
            <Mini t={t} label="Stock moyen" valeur={argCourt(kpis.stock_moyen)} />
            <Mini t={t} label="Photos mensuelles archivées" valeur={n0(kpis.nb_snapshots)} />
            <Mini t={t} label="Couverture des ventes" valeur={kpis.couverture_donnees || '—'} />
            <Mini t={t} label="Historique depuis" valeur={kpis.profondeur_historique || '—'} />
            <Mini t={t} label="Fournisseurs / codes de ligne" valeur={`${n0(kpis.nb_fournisseurs)} / ${n0(kpis.nb_lignes)}`} />
            <Mini t={t} label="Pièces suivies" valeur={`${n0(kpis.nb_pieces_stock)} en stock / ${n0(kpis.nb_pieces)}`} />
            <Mini t={t} label="Sur commande (non stockées)" valeur={n0(kpis.nb_sur_commande)} />
            <Mini t={t} label={`Écarté du calcul (${(kpis.exclusion?.lignes || []).join(', ') || '—'})`}
              valeur={kpis.exclusion ? `${n0(kpis.exclusion.nb_en_stock)} pcs · ${argCourt(kpis.exclusion.valeur)}` : '—'} />
          </div>
        )}
      </Carte>
    </div>
  )
}

/** Tuile de KPI cliquable. Celle de MecaUI ne gère pas le clic — et c'est
 *  justement le clic qui manquait : un montant sans sa liste ne sert à rien. */
function Tuile({ t, label, valeur, note, couleur, onClick }: {
  t: Theme; label: string; valeur: string; note?: string; couleur?: string; onClick?: () => void
}) {
  return (
    <div onClick={onClick}
      style={{
        background: t.card, border: `1px solid ${couleur || t.bdr}`, borderRadius: 10,
        padding: '14px 16px', cursor: onClick ? 'pointer' : 'default',
      }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: t.sub }}>{label}</div>
      <div style={{ fontSize: 25, fontWeight: 800, marginTop: 4, color: couleur || (t.dark ? '#e8eaed' : '#202124') }}>
        {valeur}
      </div>
      <div style={{ fontSize: 11.5, color: t.sub, marginTop: 3 }}>
        {note}
        {onClick && <span style={{ color: t.C.blue, fontWeight: 700 }}>{note ? ' · ' : ''}voir →</span>}
      </div>
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

function CarteFinding({ t, f, onVoir }: { t: Theme; f: any; onVoir?: (f: any) => void }) {
  const [ouvert, setOuvert] = useState(false)
  const couleur = f.severite === 'critique' ? t.C.red : f.severite === 'attention' ? t.C.yellow : t.C.blue
  const meta = AGENTS[f.agent] || { nom: f.agent, icone: '•' }
  // Un constat qui ne désigne ni pièce ni fournisseur (une synthèse globale)
  // n'a pas de liste propre à ouvrir : on n'affiche pas de bouton mort.
  const cliquable = !!onVoir && (f.code_piece || f.fournisseur || f.code_ligne
    || ['surstock', 'stock_mort', 'rupture', 'service'].includes(f.agent))
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
          {cliquable && (
            <button onClick={e => { e.stopPropagation(); onVoir!(f) }}
              style={{
                marginTop: 10, padding: '8px 14px', borderRadius: 8, border: 'none',
                background: t.C.blue, color: '#fff', fontWeight: 700, fontSize: 12.5, cursor: 'pointer',
              }}>
              🔩 Voir les pièces concernées →
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Fournisseurs / codes de ligne
// ═══════════════════════════════════════════════════════════════════════

/**
 * Colonnes déclarées en données plutôt qu'en JSX.
 *
 * L'ancienne version alignait quatorze colonnes en dur dans l'en-tête, le corps
 * ET le pied du tableau — illisible à l'écran comme dans le code. Ici, six
 * colonnes sont marquées `cle: true` et s'affichent par défaut : celles qui
 * répondent à « où est mon argent et est-ce qu'il tourne ». Le reste s'ouvre
 * d'un clic pour qui veut creuser.
 */
interface ColonneGroupe {
  id: string
  titre: string
  cle?: boolean                                  // visible par défaut
  fournisseurSeul?: boolean
  rendu: (g: any, t: Theme) => any
  couleur?: (g: any, t: Theme) => string | undefined
  total?: (tot: any) => any
}

const COLONNES_GROUPE: ColonneGroupe[] = [
  { id: 'valeur_stock', titre: 'Valeur stock', cle: true,
    rendu: g => argCourt(g.valeur_stock), total: tot => argCourt(tot.valeur) },
  { id: 'rotation', titre: 'Rotation', cle: true,
    rendu: g => n2(g.rotation) + '×',
    couleur: (g, t) => g.rotation < 1 ? t.C.red : g.rotation < 2 ? t.C.yellow : t.C.green,
    total: tot => n2(tot.valeur > 0 ? tot.cogs / tot.valeur : 0) + '×' },
  { id: 'valeur_morte', titre: 'Stock mort', cle: true,
    rendu: g => g.valeur_morte > 0 ? argCourt(g.valeur_morte) : '—',
    couleur: (g, t) => g.valeur_morte > 0 ? t.C.red : undefined,
    total: tot => argCourt(tot.morte) },
  { id: 'valeur_exces', titre: 'Excédent', cle: true,
    rendu: g => g.valeur_exces > 0 ? argCourt(g.valeur_exces) : '—',
    couleur: (g, t) => g.valeur_exces > 0 ? t.C.yellow : undefined,
    total: tot => argCourt(tot.exces) },
  { id: 'nb_rupture', titre: 'Ruptures', cle: true,
    rendu: g => g.nb_rupture || '—',
    couleur: (g, t) => g.nb_rupture > 0 ? t.C.red : undefined,
    total: () => '—' },

  { id: 'nb_pieces_stock', titre: 'Pièces', rendu: g => n0(g.nb_pieces_stock), total: () => '—' },
  { id: 'ventes_12m_cogs', titre: 'Coût ventes 12 m', rendu: g => argCourt(g.ventes_12m_cogs), total: tot => argCourt(tot.cogs) },
  { id: 'marge_pct', titre: 'Marge', rendu: g => pct(g.marge_pct), total: () => '—' },
  { id: 'dsi_jours', titre: 'Jours stock', rendu: g => g.dsi_jours ? n0(g.dsi_jours) : '—', total: () => '—' },
  { id: 'valeur_dormante', titre: 'Dormant',
    rendu: g => g.valeur_dormante > 0 ? argCourt(g.valeur_dormante) : '—',
    couleur: (g, t) => g.valeur_dormante > 0 ? t.C.yellow : undefined,
    total: tot => argCourt(tot.dormante) },
  { id: 'valeur_retournable', titre: 'Retournable', fournisseurSeul: true,
    rendu: g => g.valeur_retournable > 0 ? argCourt(g.valeur_retournable) : '—',
    couleur: (g, t) => g.valeur_retournable > 0 ? t.C.green : undefined,
    total: tot => argCourt(tot.retournable) },
  { id: 'part_cumulee', titre: '% cumulé', rendu: g => pct(g.part_cumulee), total: () => '—' },
  { id: 'variation_pct', titre: 'Var. mois',
    rendu: g => g.variation_pct == null ? '—' : (g.variation_pct > 0 ? '+' : '') + pct(g.variation_pct),
    couleur: (g, t) => g.variation_pct == null ? undefined : g.variation_pct > 0 ? t.C.yellow : t.C.green,
    total: () => '—' },
]

function VueGroupes({ t, titre, dimension, groupes, onDrill }: {
  t: Theme; titre: string; dimension: 'fournisseur' | 'ligne'; groupes: any[]; onDrill: (cle: string) => void
}) {
  const [tri, setTri] = useState('valeur_stock')
  const [sens, setSens] = useState<'asc' | 'desc'>('desc')
  const [q, setQ] = useState('')
  const [pareto, setPareto] = useState<string>('')
  const [sansStock, setSansStock] = useState(false)
  const [tout, setTout] = useState(false)

  const colonnes = useMemo(() =>
    COLONNES_GROUPE.filter(c =>
      (tout || c.cle) && !(c.fournisseurSeul && dimension !== 'fournisseur')),
    [tout, dimension])

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

  const nom = dimension === 'fournisseur' ? 'fournisseurs' : 'codes de ligne'

  return (
    <Carte t={t} style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: 16, borderBottom: `1px solid ${t.bdr}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: t.C.blue, margin: 0 }}>{titre}</h3>
            <div style={{ fontSize: 12.5, color: t.sub, marginTop: 5, lineHeight: 1.6 }}>
              {filtres.length} {nom} · <strong>{argCourt(totaux.valeur)}</strong> de stock, dont{' '}
              <strong style={{ color: t.C.red }}>{argCourt(totaux.morte + totaux.exces)}</strong> qui ne tournent pas.
            </div>
            <div style={{ fontSize: 11, color: t.sub, marginTop: 3 }}>
              Clique une ligne pour ouvrir ses pièces.
            </div>
          </div>
          <a href={`/api/rotation/export?type=${dimension === 'fournisseur' ? 'fournisseurs' : 'lignes'}`}
            style={{ ...btnLien(t), textDecoration: 'none' }}>⬇ CSV</a>
        </div>

        <div className="rot-nocopy" style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Rechercher…" style={champ(t, 220)} />
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
          <button onClick={() => setTout(o => !o)} style={btnLien(t)}>
            {tout ? '← Colonnes essentielles' : 'Toutes les colonnes →'}
          </button>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead style={{ background: t.thBg, position: 'sticky', top: 0 }}>
            <tr>
              <ThTriable t={t} label={dimension === 'fournisseur' ? 'Fournisseur' : 'Code de ligne'}
                colonne="cle" actif={tri} dir={sens} onSort={onSort} align="left" />
              {colonnes.map(c => (
                <ThTriable key={c.id} t={t} label={c.titre} colonne={c.id} actif={tri} dir={sens} onSort={onSort} />
              ))}
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
                    classe {g.classe_pareto} · {n0(g.nb_pieces_stock)} pièces
                    {g.nb_snapshots > 0 ? ` · ${g.nb_snapshots} snapshot(s)` : ' · rotation estimée'}
                  </div>
                </td>
                {colonnes.map(c => (
                  <Td key={c.id} couleur={c.couleur?.(g, t)}>{c.rendu(g, t)}</Td>
                ))}
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                  <BarreSante t={t} score={g.score_sante} />
                </td>
              </tr>
            ))}
            {filtres.length === 0 && (
              <tr><td colSpan={colonnes.length + 2} style={{ padding: 24, textAlign: 'center', color: t.sub }}>
                Aucun résultat pour ces filtres.
              </td></tr>
            )}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `2px solid ${t.bdr}`, fontWeight: 800, background: t.thBg }}>
              <td style={{ padding: '9px 12px' }}>Total ({filtres.length})</td>
              {colonnes.map(c => <Td key={c.id}>{c.total ? c.total(totaux) : '—'}</Td>)}
              <Td>—</Td>
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

function VuePieces({ t, filtre, setFiltre, listeFournisseurs, listeLignes }: {
  t: Theme
  filtre: FiltrePieces
  setFiltre: (f: FiltrePieces) => void
  listeFournisseurs: string[]; listeLignes: string[]
}) {
  const { fournisseur, ligne, statut, abc, q, tri } = filtre
  const maj = (p: Partial<FiltrePieces>) => setFiltre({ ...filtre, ...p })

  const [pieces, setPieces] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [totaux, setTotaux] = useState<any>(null)
  const [page, setPage] = useState(0)
  const [chargement, setChargement] = useState(false)
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
      setTotaux(j.totaux || null)
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
    else { maj({ tri: k }); setSens('desc') }
  }

  // Bandeau de contexte : quand on arrive ici depuis « Voir les 1 149 pièces »,
  // il faut savoir d'un coup d'œil ce qu'on regarde, et combien ça pèse.
  const LIBELLE_STATUT: Record<string, string> = {
    'rupture,sous_stock': 'à commander',
    'rupture': 'en rupture',
    'sous_stock': 'sous le seuil',
    'surstock': 'en surstock',
    'mort,jamais_vendue': 'en stock mort',
    'mort,jamais_vendue,surstock': 'qui ne tournent pas',
    'dormant': 'dormantes',
    'sur_commande': 'sur commande',
    'ok': 'au vert',
  }
  const contexte = [
    LIBELLE_STATUT[statut] || (statut ? statut.replace(/,/g, ' / ') : ''),
    fournisseur ? `chez ${fournisseur}` : '',
    ligne ? `ligne ${ligne}` : '',
    abc ? `classe ${abc}` : '',
    q ? `recherche « ${q} »` : '',
  ].filter(Boolean).join(' · ')
  const filtreActif = !!(fournisseur || ligne || statut || abc || q)

  const paramsExport = new URLSearchParams({ type: 'pieces' })
  if (fournisseur) paramsExport.set('fournisseur', fournisseur)
  if (ligne) paramsExport.set('ligne', ligne)
  if (statut) paramsExport.set('statut', statut)

  return (
    <Carte t={t} style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: 16, borderBottom: `1px solid ${t.bdr}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: t.C.blue, margin: 0 }}>
              {n0(total)} pièces {contexte || '— toutes'}
            </h3>
            {totaux && (
              <div style={{ fontSize: 12.5, color: t.sub, marginTop: 5, lineHeight: 1.6 }}>
                <strong>{argCourt(totaux.valeur_stock)}</strong> de stock
                {totaux.exces_valeur > 0 && <> · <strong style={{ color: t.C.yellow }}>{argCourt(totaux.exces_valeur)}</strong> d'excédent</>}
                {totaux.valeur_morte > 0 && <> · <strong style={{ color: t.C.red }}>{argCourt(totaux.valeur_morte)}</strong> de stock mort</>}
                {totaux.qte_a_commander > 0 && <> · <strong style={{ color: t.C.blue }}>{n0(totaux.qte_a_commander)} u</strong> à commander ({argCourt(totaux.valeur_a_commander)})</>}
              </div>
            )}
            <div style={{ fontSize: 11, color: t.sub, marginTop: 4 }}>
              PC = point de commande · SS = stock de sécurité · EOQ = quantité économique de Wilson
            </div>
          </div>
          <a href={`/api/rotation/export?${paramsExport}`} style={{ ...btnLien(t), textDecoration: 'none' }}>⬇ CSV</a>
        </div>

        <div className="rot-nocopy" style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input value={q} onChange={e => maj({ q: e.target.value })} placeholder="Code ou description…" style={champ(t, 240)} />
          <select value={fournisseur || ''} onChange={e => maj({ fournisseur: e.target.value || null })} style={champ(t, 230)}>
            <option value="">Tous les fournisseurs</option>
            {listeFournisseurs.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={ligne || ''} onChange={e => maj({ ligne: e.target.value || null })} style={champ(t, 180)}>
            <option value="">Tous les codes de ligne</option>
            {listeLignes.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <select value={statut} onChange={e => maj({ statut: e.target.value })} style={champ(t, 190)}>
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
          <select value={abc} onChange={e => maj({ abc: e.target.value })} style={champ(t, 130)}>
            <option value="">ABC : tout</option>
            <option value="A">A</option><option value="B">B</option><option value="C">C</option>
          </select>
          {filtreActif && (
            <button onClick={() => setFiltre({ ...FILTRE_VIDE, tri })} style={btnLien(t)}>✕ Tout afficher</button>
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

function VueAgents({ t, resume, onFinding }: { t: Theme; resume: any[]; onFinding: (f: any) => void }) {
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
        {findings.map((f, i) => <CarteFinding key={i} t={t} f={f} onVoir={onFinding} />)}
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
