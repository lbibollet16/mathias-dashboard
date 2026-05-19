'use client'
import React, { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabaseCli = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const ROLES_ONGLETS: Record<string, string[]> = {
  admin:        ['calc','import','booking','retours','negatifs','commandes','commandes_attente','fournitures','inventaire','verification','comptabilite','amazon','scoa','utilisateurs'],
  gestionnaire: ['calc','import','booking','retours','negatifs','commandes','commandes_attente','fournitures','inventaire','comptabilite','amazon','scoa'],
  commis:       ['commandes','commandes_attente','fournitures','retours'],
  employe_piece: ['commandes_attente','fournitures','negatifs','inventaire','retours'],
}

// Onglets TOUJOURS visibles pour tout le monde — même si l'utilisateur a un
// `onglets_custom` sauvegardé avant l'apparition de l'onglet. Évite d'avoir
// à re-éditer chaque utilisateur quand on ajoute un onglet utile à tous.
const ONGLETS_FORCES_TOUS = ['commandes_attente']

function ongletsVisibles(profil: any): string[] {
  const base = profil?.onglets_custom && Array.isArray(profil.onglets_custom) && profil.onglets_custom.length > 0
    ? profil.onglets_custom
    : (ROLES_ONGLETS[profil?.role || 'commis'] || ROLES_ONGLETS['commis'])
  return [...new Set([...base, ...ONGLETS_FORCES_TOUS])]
}

interface Item {
  pk: string; desc: string; moyMois: number
  ventesMoyParMois: number[]
  totalCA: number
  stock: number; fournisseur: string; ligne: string
  cost: number; classeABC: string; cssABC: string; xyz: string; cssXYZ: string; saison: string
  roulement: number; tendance: number; iconeTendance: string; cssTendance: string
  stockSecurite: number; pointCommande: number; scoreUrgence: number; alerteReappro: boolean
}
interface Lot {
  id: number; code_piece: string; code_ligne: string; fournisseur: string
  qte_recue: number; qte_restante: number; date_limite: string; cout_unitaire: number
}
interface Negatif {
  id: number; code_piece: string; fournisseur: string; ligne: string
  description: string; stock_negatif: number; cout_unitaire: number; date_apparition: string
}

const C = { blue:'#1a73e8', green:'#188038', yellow:'#f9ab00', red:'#d93025' }

const TIPS: Record<string, string> = {
  'Matrice':     'ABC = volume (A=fort ≥2/mois, B=moyen ≥0.5, C=faible). XYZ = régularité (X=stable CV≤0.6, Y=variable, Z=imprévisible). Calculé par EMA α=0.3.',
  'Fournisseur': 'Fournisseur selon Traction + code de ligne de produit.',
  'Code Pièce':  'Code unique Traction. ⚡RÉAPPRO = stock sous le point de commande.',
  'Description': 'Description de la pièce selon Traction (DescFra).',
  'Saison':      'Saisonnalité : Été (mai-août), Hiver (nov-fév), Variable, Sur Commande = ne pas stocker.',
  'Tendance':    '↑ hausse >15% | → stable | ↓ baisse >15%. Compare les 3 derniers mois aux 3 précédents.',
  'Besoin':      'Quantité prévue sur la couverture sélectionnée, ajustée par la saisonnalité mensuelle.',
  'Stock Sécu.': 'Wilson : 1.645 × écart-type × √(délai 0.5 mois). Protège contre la variabilité à 95%.',
  'Pt Cmd':      'Seuil de réapprovisionnement = EMA × délai + stock sécurité.',
  'Roul.':       'Rotation annuelle = ventes annuelles / stock. 99x = rupture.',
  'Stock':       'QTYMINUSRESERVED de Traction = stock physique moins réservations clients.',
  'Coût Un.':    'PrixCoutant de Traction.',
  'ACHAT':       'Qté à commander = besoin + stock sécu − stock actuel. 0 = pas besoin.',
}

export default function Dashboard() {
  const [tab, setTab]       = useState('calc')
  const [data, setData]     = useState<any>(null)
  const [lots, setLots]     = useState<Lot[]>([])
  const [negs, setNegs]     = useState<Negatif[]>([])
  const [loading, setLoading] = useState(true)
  const [dark, setDark]     = useState(false)
  const [user, setUser]     = useState<any>(null)
  const [newVersion, setNewVersion] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  // Charger html5-qrcode + ZXing pour compatibilité maximale
  useEffect(() => {
    if (!(window as any).Html5Qrcode) {
      const s = document.createElement('script')
      s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
      document.head.appendChild(s)
    }
    if (!('BarcodeDetector' in window) && !(window as any).ZXingLibrary) {
      const s = document.createElement('script')
      s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js'
      document.head.appendChild(s)
    }
  }, [])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  const [profil, setProfil] = useState<any>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [tip, setTip]       = useState<string|null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncLog, setSyncLog] = useState('')

  // Filtres calc
  const [fourn, setFourn]   = useState('ALL')
  const [xyz, setXyz]       = useState('ALL')
  const [tend, setTend]     = useState('ALL')
  const [cov, setCov]       = useState(3)
  const [filtABC, setFiltABC] = useState('A')
  const [lignes, setLignes] = useState<string[]>([])
  const [ddOpen, setDdOpen] = useState(false)
  const ddRef = useRef<HTMLDivElement>(null)

  // Import
  const [alts, setAlts] = useState<Map<string,string[]>>(new Map())
  const [negsVerifies, setNegsVerifies] = useState<any[]>([])
  const [validationsCompta, setValidationsCompta] = useState<any[]>([])
  const [verifsDoubles, setVerifsDoubles] = useState<any[]>([])
  const [retoursActifsGlobal, setRetoursActifsGlobal] = useState<any[]>([])
  const [commandesAttenteGlobal, setCommandesAttenteGlobal] = useState<any[]>([])
  const [forceMesSuivis, setForceMesSuivis] = useState(false)  // déclenche le filtre dans CommandesAttenteTab
  const [notifVuGlobal, setNotifVuGlobal] = useState(false)
  const [fournituresData, setFournituresData] = useState<{catalogue:any[],demandes:any[]}>({catalogue:[],demandes:[]}) // principal -> [alternatifs]
  const [altReverse, setAltReverse] = useState<Map<string,string>>(new Map()) // alternatif -> principal
  const [iFile, setIFile]   = useState<File|null>(null)
  const [iMois, setIMois]   = useState('')
  const [iStatus, setIStatus] = useState('')

  useEffect(() => {
    try { if (localStorage.getItem('dk')==='1') setDark(true) } catch {}

    // Vérifier la session
    supabaseCli.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        window.location.href = '/login'
        return
      }
      setUser(session.user)
      // Charger le profil
      const { data: p } = await supabaseCli
        .from('profils_utilisateurs')
        .select('*')
        .eq('id', session.user.id)
        .single()
      setProfil(p)
      setAuthLoading(false)
      fetchAll()
    })

    // Écouter les changements de session
    const { data: { subscription } } = supabaseCli.auth.onAuthStateChange(async (event, session) => {
      if (!session) { window.location.href = '/login'; return }
      if (event === 'SIGNED_OUT') { window.location.href = '/login' }
    })
    return () => subscription.unsubscribe()
  }, [])

  // Vérifier nouvelle version toutes les 5 minutes
  useEffect(() => {
    let buildId: string | null = null
    async function checkVersion() {
      try {
        const r = await fetch('/api/version?t=' + Date.now())
        if (!r.ok) return
        const j = await r.json()
        if (!buildId) { buildId = j.buildId; return }
        if (j.buildId !== buildId) setNewVersion(true)
      } catch {}
    }
    checkVersion()
    const interval = setInterval(checkVersion, 5 * 60 * 1000) // toutes les 5 min
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ddRef.current && !ddRef.current.contains(e.target as Node)) setDdOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  async function fetchAll() {
    setLoading(true)
    try {
      const [d, l, n, a, f, nv, vc, ret, cmdAtt, vd] = await Promise.all([
        fetch('/api/calculateur').then(r=>r.json()),
        fetch('/api/lots').then(r=>r.json()),
        fetch('/api/negatifs').then(r=>r.json()),
        fetch('/api/alternatives').then(r=>r.json()),
        fetch('/api/fournitures').then(r=>r.json()),
        fetch('/api/negatifs-verifies').then(r=>r.json()),
        fetch('/api/validations-comptables').then(r=>r.json()),
        fetch('/api/comptabilite/retours?actifs=1').then(r=>r.json()).catch(()=>[]),
        fetch('/api/commandes-attente').then(r=>r.json()).catch(()=>({lignes:[]})),
        fetch('/api/verifications-doubles').then(r=>r.json()).catch(()=>[]),
      ])
      setData(d); setLots(Array.isArray(l)?l:[]); setNegs(Array.isArray(n)?n:[])
      if(f&&f.catalogue) setFournituresData(f)
      if(Array.isArray(nv)) setNegsVerifies(nv)
      if(Array.isArray(vc)) setValidationsCompta(vc)
      if(Array.isArray(ret)) setRetoursActifsGlobal(ret)
      if(cmdAtt && Array.isArray(cmdAtt.lignes)) setCommandesAttenteGlobal(cmdAtt.lignes)
      if(Array.isArray(vd)) setVerifsDoubles(vd)
      // Construire les maps d'alternatives
      if (Array.isArray(a)) {
        const fwd = new Map<string,string[]>()
        const rev = new Map<string,string>()
        for (const p of a) {
          if (!fwd.has(p.code_principal)) fwd.set(p.code_principal, [])
          fwd.get(p.code_principal)!.push(p.code_alternatif)
          rev.set(p.code_alternatif, p.code_principal)
        }
        setAlts(fwd); setAltReverse(rev)
      }
    } catch { setData({erreur:'Erreur connexion'}) }
    setLoading(false)
  }

  async function lancerSync() {
    setSyncing(true); setSyncLog('Synchronisation ERP en cours...')
    try {
      const r = await fetch('/api/erp/sync', { method: 'POST' })
      const j = await r.json()
      if (j.success) {
        setSyncLog(`✅ Sync OK — ${j.stats.lots_new} lots créés, ${j.stats.negatifs} négatifs${j.modeInit ? ' (initialisation)' : ''}`)
        await fetchAll()
      } else {
        setSyncLog('❌ ' + j.erreur)
      }
    } catch (e: any) { setSyncLog('❌ ' + e.message) }
    setSyncing(false)
  }

  const bg    = dark ? '#0d0d0d' : '#f0f2f5'
  const card  = dark ? '#1a1a1a' : '#fff'
  const bdr   = dark ? '#2a2a2a' : '#e0e4ea'
  const txt   = dark ? '#e8e8e8' : '#1a1a1a'
  const sub   = dark ? '#888'    : '#5f6368'
  const thBg  = dark ? '#111'    : '#f4f6f8'
  const hvr   = dark ? '#222'    : '#f8f9fa'

  const S = { w:'100%', p:'9px 12px', border:`1px solid ${bdr}`, borderRadius:8, fontSize:13,
    background:dark?'#222':'#f8f9fa', color:dark?'#e8e8e8':'#1a1a1a', cursor:'pointer', outline:'none', boxSizing:'border-box' as const }

  const mNow = new Date().getMonth()
  const items: Item[] = data?.liste_complete || []

  const lignesDisp = Array.from(new Set(
    items.filter(it => fourn==='ALL' || it.fournisseur===fourn).map(it=>it.ligne).filter(l=>l&&l!=='N/A')
  )).sort()

  function getBesoin(it: Item) {
    if (cov===0) return it.moyMois
    // Somme des vraies ventes moyennes historiques pour chaque mois futur
    // Si un mois est à 0 dans l'historique, c'est une vraie absence de demande (hors-saison)
    // On NE fallback PAS sur l'EMA qui gonflerait artificiellement
    let b=0, m=mNow
    for (let i=0;i<cov;i++) {
      b += it.ventesMoyParMois?.[m] ?? 0
      m=(m+1)%12
    }
    // Si aucune donnée saisonnière (tableau vide ou tout à 0), utiliser EMA × cov
    if (b === 0 && it.moyMois > 0) b = it.moyMois * cov
    return b
  }
  function getQte(it: Item) {
    if (cov===0) return 0
    if (it.saison==='Sur Commande') return 0
    const besoin = getBesoin(it)
    const stockDispo = Math.max(0,it.stock)
    // Protection surstockage : si on a déjà ≥ 2× le besoin prévu, ne pas commander
    if (besoin > 0 && stockDispo >= besoin * 2) return 0
    const q = Math.ceil(besoin + (it.stockSecurite||0) - stockDispo)
    return Math.max(0,q)
  }

  const filtered = items.filter(it => {
    // Filtre ABC — par défaut A seulement
    if (filtABC === 'A' && it.classeABC !== 'A') return false
    if (filtABC === 'AB' && it.classeABC === 'C') return false
    if (fourn!=='ALL' && it.fournisseur!==fourn) return false
    if (xyz!=='ALL' && it.xyz!==xyz) return false
    if (lignes.length>0 && !lignes.includes(it.ligne)) return false
    if (tend==='hausse' && it.iconeTendance!=='haut') return false
    if (tend==='baisse' && it.iconeTendance!=='bas') return false
    if (tend==='stable' && it.iconeTendance!=='stable') return false
    if (cov>0 && getQte(it)<=0) return false
    // Exclure les pièces dont le besoin est < 3 unités sur la période
    if (cov>0 && getBesoin(it) < 3) return false
    // Exclure si une alternative couvre le besoin (stock alt >= besoin)
    if (cov>0) {
      const altCodes = (alts as Map<string,string[]>).get(it.pk) || []
      const besoin = getBesoin(it)
      const normC = (s:string) => s.trim().toLowerCase().replace(/\s+/g,'')
      for (const altCode of altCodes) {
        const altCodeN = normC(altCode)
        const altItem = items.find((x:Item) => normC(x.pk) === altCodeN)
        if (altItem && Math.max(0, altItem.stock) >= besoin) return false
      }
    }
    return true
  })

  const total = filtered.reduce((s,it)=>s+getQte(it)*it.cost, 0)

  function Tip({col}: {col:string}) {
    if (!TIPS[col]) return null
    return (
      <span style={{position:'relative',display:'inline-block',marginLeft:4}} onMouseEnter={()=>setTip(col)} onMouseLeave={()=>setTip(null)}>
        <span style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:14,height:14,borderRadius:'50%',background:dark?'#444':'#d0d7e3',color:dark?'#ccc':'#555',fontSize:9,fontWeight:700,cursor:'help'}}>i</span>
        {tip===col && (
          <div style={{position:'fixed',background:'#1a1a1a',color:'#fff',padding:'10px 14px',borderRadius:8,fontSize:12,width:260,zIndex:99999,lineHeight:1.6,boxShadow:'0 4px 20px rgba(0,0,0,.5)',pointerEvents:'none',marginTop:8,whiteSpace:'normal'}}>
            <strong style={{color:'#90cdf4',display:'block',marginBottom:4}}>{col}</strong>
            {TIPS[col]}
          </div>
        )}
      </span>
    )
  }

  function TH({l,center,right,blue,green}: {l:string;center?:boolean;right?:boolean;blue?:boolean;green?:boolean}) {
    return (
      <th style={{padding:'11px 9px',textAlign:right?'right':center?'center':'left',fontSize:11,fontWeight:700,textTransform:'uppercase',color:blue?C.blue:sub,borderBottom:`2px solid ${bdr}`,whiteSpace:'nowrap',background:green?(dark?'#0d2a18':'#e6f4ea'):thBg,position:'sticky',top:0,zIndex:10}}>
        {l}<Tip col={l}/>
      </th>
    )
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault()
    if (!iFile||!iMois) return
    setIStatus('En cours...')
    const fd = new FormData(); fd.append('data',iFile); fd.append('mois_annee',iMois)
    try {
      const r = await fetch('/api/import-ventes',{method:'POST',body:fd})
      const j = await r.json()
      setIStatus(j.success ? `✓ ${j.lignes_importees} lignes importées` : '❌ '+j.erreur)
      if (j.success) { setIFile(null); setIMois('') }
    } catch { setIStatus('❌ Erreur connexion') }
  }

  function Bdg({label,color}: {label:string;color:string}) {
    return <span style={{background:color,color:'#fff',padding:'3px 6px',borderRadius:4,fontSize:11,fontWeight:700,display:'inline-block',minWidth:18,textAlign:'center'}}>{label}</span>
  }

  // ─────────────────────────────────────────────────────────────────────
  if (authLoading) return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'#0f172a',fontFamily:"'DM Sans',sans-serif"}}>
      <div style={{textAlign:'center',color:'#fff'}}>
        <div style={{fontSize:48,marginBottom:16}}>⚓</div>
        <p style={{color:'#94a3b8',fontSize:14}}>Chargement en cours...</p>
      </div>
    </div>
  )

  return (
    <div style={{minHeight:'100vh',background:bg,color:txt,fontFamily:"'DM Sans','Segoe UI',sans-serif",transition:'background .2s'}}>

      {/* NAV */}
      <nav style={{background:dark?'#111':C.blue,color:'#fff',padding:'0 16px',height:54,display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,zIndex:200,boxShadow:'0 2px 8px rgba(0,0,0,.2)'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:18}}>⚓</span>
          <span style={{fontWeight:700,fontSize:isMobile?13:15}}>{isMobile?'Mathias Marine':'Mathias Marine Sports'}</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          {!isMobile && data?.calcule_le && <span style={{fontSize:11,opacity:.6,background:'rgba(255,255,255,.12)',padding:'3px 10px',borderRadius:20}}>Cache: {new Date(data.calcule_le).toLocaleDateString('fr-CA')}</span>}
          {!isMobile && profil && <span style={{fontSize:12,opacity:.8}}>{profil.nom}</span>}
          <button onClick={()=>setDark(!dark)} style={{background:'rgba(255,255,255,.15)',border:'none',borderRadius:8,width:32,height:32,cursor:'pointer',fontSize:15,color:'#fff'}}>{dark?'☀️':'🌙'}</button>
          <button onClick={async()=>{await supabaseCli.auth.signOut();window.location.href='/login'}}
            style={{background:'rgba(255,255,255,.15)',border:'none',borderRadius:8,padding:'0 10px',height:32,fontSize:12,color:'#fff',cursor:'pointer'}}>
            {isMobile?'↪':'Déconnexion'}
          </button>
        </div>
      </nav>

      {/* TABS */}
      <div style={{background:dark?'#141414':'#e2e6ef',borderBottom:`1px solid ${bdr}`,overflowX:'auto',display:'flex',WebkitOverflowScrolling:'touch',scrollbarWidth:'none',gap:isMobile?2:0}}>
        {[{id:'calc',l:isMobile?'🧮':'Calculateur Achats'},{id:'import',l:isMobile?'📥':'Importer Ventes'},{id:'retours',l:isMobile?'🔄 RMA':'Retours RMA'},{id:'booking',l:isMobile?'📊':'Booking'},{id:'negatifs',l:isMobile?'🔴 Négatifs':'Pièces Négatives',d:true},{id:'commandes',l:isMobile?'📋':'📋 Commandes'},{id:'commandes_attente',l:isMobile?'⏳':'⏳ Commandes en attente'},{id:'fournitures',l:isMobile?'💡':'💡 Suggestions'},{id:'inventaire',l:'📦 Inventaire'},{id:'verification',l:isMobile?'🔍':'🔍 Vérification'},{id:'comptabilite',l:isMobile?'💰':'💰 Comptabilité'},{id:'amazon',l:isMobile?'📦 AMZ':'📦 Amazon'},{id:'scoa',l:isMobile?'🏍 SCOA':'🏍 SCOA'},{id:'utilisateurs',l:isMobile?'👥':'👥 Utilisateurs'}].filter(t=>ongletsVisibles(profil).includes(t.id)).map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:isMobile?'12px 14px':'12px 16px',border:'none',background:tab===t.id?(dark?'#1a233a':'#dbeafe'):'transparent',cursor:'pointer',fontSize:isMobile?14:13,fontWeight:tab===t.id?800:600,color:tab===t.id?C.blue:t.d?C.red:sub,borderBottom:tab===t.id?`3px solid ${C.blue}`:'3px solid transparent',borderRadius:isMobile?'8px 8px 0 0':0,transition:'all .15s',whiteSpace:'nowrap',flexShrink:0}}>
            {t.l}
          </button>
        ))}
      </div>

      <div style={{maxWidth:1700,margin:'0 auto',padding:isMobile?'10px 10px':'18px 16px'}}>

        {/* Bandeau global — corrections demandées par la comptabilité */}
        {(() => {
          const moi = profil?.nom || profil?.email || ''
          const mesRetours = (retoursActifsGlobal || []).filter((r:any) => r.demandeur_employe === moi)
          if (mesRetours.length === 0) return null
          const nbNeg = mesRetours.filter((r:any) => r.source === 'negatif').length
          const nbCpt = mesRetours.filter((r:any) => r.source === 'comptage').length
          // Ne pas afficher le bandeau global si on est déjà sur l'onglet concerné (le bandeau interne suffit)
          const surBonOnglet = (tab === 'negatifs' && nbCpt === 0) || (tab === 'inventaire' && nbNeg === 0)
          if (surBonOnglet) return null
          return (
            <div style={{background:'#fce8e6',border:'2px solid #d93025',borderRadius:10,padding:'12px 16px',marginBottom:14,display:'flex',alignItems:'center',gap:14,flexWrap:'wrap',animation:'pulseRet 2s ease-in-out infinite'}}>
              <style>{`@keyframes pulseRet { 0%,100%{box-shadow:0 0 0 0 rgba(217,48,37,.4)} 50%{box-shadow:0 0 0 8px rgba(217,48,37,0)} }`}</style>
              <span style={{fontSize:24}}>⚠️</span>
              <div style={{flex:1,minWidth:200}}>
                <div style={{fontSize:13,fontWeight:900,color:'#d93025'}}>
                  {mesRetours.length === 1 ? '1 correction demandée par la comptabilité' : `${mesRetours.length} corrections demandées par la comptabilité`}
                </div>
                <div style={{fontSize:11,color:'#5f6368',marginTop:2}}>
                  Clique sur un bouton pour voir les commentaires et corriger.
                </div>
              </div>
              {nbNeg > 0 && (
                <button onClick={()=>setTab('negatifs')}
                  style={{background:'#d93025',color:'#fff',border:'none',borderRadius:8,padding:'9px 14px',fontWeight:800,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                  🔴 Voir Négatifs ({nbNeg})
                </button>
              )}
              {nbCpt > 0 && (
                <button onClick={()=>setTab('inventaire')}
                  style={{background:'#d93025',color:'#fff',border:'none',borderRadius:8,padding:'9px 14px',fontWeight:800,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                  📦 Voir Inventaire ({nbCpt})
                </button>
              )}
            </div>
          )
        })()}

        {/* Bandeau global — suivis Commandes en attente (≥10j + plan d'action + match employé ≥85%) */}
        {(() => {
          if (notifVuGlobal) return null
          if (tab === 'commandes_attente') return null  // bandeau interne au tab dans ce cas
          const moi = profil?.nom || profil?.email || ''
          if (!moi) return null
          const mesSuivis = (commandesAttenteGlobal || []).filter((l:any) => {
            const ref = l.date_commande ? new Date(l.date_commande + 'T00:00:00') : new Date(l.date_premiere_vue)
            const ageJours = Math.max(0, Math.floor((Date.now() - ref.getTime()) / 86400000))
            return ageJours >= 10
              && l.plan_action && l.plan_action.length > 0
              && matchNomEmploye(l.nom_employe, moi) >= 0.85
          })
          if (mesSuivis.length === 0) return null
          return (
            <div style={{background:'#fff4e5',border:'2px solid #f9ab00',borderRadius:10,padding:'12px 16px',marginBottom:14,display:'flex',alignItems:'center',gap:14,flexWrap:'wrap',animation:'pulseSuiv 2s ease-in-out infinite'}}>
              <style>{`@keyframes pulseSuiv { 0%,100%{box-shadow:0 0 0 0 rgba(249,171,0,.4)} 50%{box-shadow:0 0 0 8px rgba(249,171,0,0)} }`}</style>
              <span style={{fontSize:24}}>🔔</span>
              <div style={{flex:1,minWidth:200}}>
                <div style={{fontSize:13,fontWeight:900,color:'#b06a00'}}>
                  {mesSuivis.length === 1 ? '1 suivi à faire (commande en retard)' : `${mesSuivis.length} suivis à faire (commandes en retard)`}
                </div>
                <div style={{fontSize:11,color:'#5f6368',marginTop:2}}>
                  {mesSuivis.length === 1 ? 'Une commande' : 'Des commandes'} en retard (≥10j) avec un plan d'action en cours t'attend{mesSuivis.length === 1 ? '' : 'ent'}.
                </div>
              </div>
              <button onClick={()=>{ setTab('commandes_attente'); setForceMesSuivis(true) }}
                style={{background:'#f9ab00',color:'#fff',border:'none',borderRadius:8,padding:'9px 14px',fontWeight:800,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                ⏳ Voir mes suivis ({mesSuivis.length})
              </button>
              <button onClick={()=>setNotifVuGlobal(true)}
                title="Masquer (jusqu'au prochain rechargement)"
                style={{background:'transparent',border:'none',color:sub,cursor:'pointer',fontSize:14}}>
                ✕
              </button>
            </div>
          )
        })()}


        {/* ── CALCULATEUR ─────────────────────────────────────────── */}
        {tab==='calc' && <>
          <div style={{background:card,borderRadius:12,padding:isMobile?'10px 12px':'14px 18px',marginBottom:14,display:'flex',gap:isMobile?8:12,flexWrap:'wrap',alignItems:'flex-start',border:`1px solid ${bdr}`}}>

            {/* ABC */}
            <div style={{flex:1,minWidth:isMobile?'45%':130}}>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Priorité ABC</div>
              <select value={filtABC} onChange={e=>setFiltABC(e.target.value)} style={{...S,border:`2px solid ${filtABC==='A'?C.green:C.yellow}`,fontWeight:700}}>
                <option value="A">🟢 A seulement — Top 20% CA</option>
                <option value="AB">🟡 A + B — 95% du CA</option>
                <option value="ALL">Tous — A, B et C</option>
              </select>
            </div>

            {/* Fournisseur */}
            <div style={{flex:1,minWidth:140}}>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Fournisseur</div>
              <select value={fourn} onChange={e=>{setFourn(e.target.value);setLignes([])}} style={S}>
                <option value="ALL">Tous</option>
                {(data?.fournisseurs||[]).map((f:string)=><option key={f} value={f}>{f}</option>)}
              </select>
            </div>

            {/* Lignes — dropdown compact */}
            <div style={{flex:1.2,minWidth:160}} ref={ddRef}>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>
                Lignes {lignes.length>0 && <span style={{color:C.blue}}>({lignes.length})</span>}
              </div>
              <div style={{position:'relative'}}>
                <button onClick={()=>setDdOpen(!ddOpen)} style={{...S,display:'flex',justifyContent:'space-between',alignItems:'center',cursor:'pointer'}}>
                  <span>{lignes.length===0?'Toutes':lignes.length===1?lignes[0]:`${lignes.length} sélectionnées`}</span>
                  <span style={{fontSize:10}}>{ddOpen?'▲':'▼'}</span>
                </button>
                {ddOpen && (
                  <div style={{position:'absolute',top:'105%',left:0,right:0,background:card,border:`1px solid ${bdr}`,borderRadius:8,zIndex:500,boxShadow:'0 4px 16px rgba(0,0,0,.15)',maxHeight:220,overflowY:'auto'}}>
                    <div style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                      <span style={{fontSize:11,color:sub}}>Sélectionner lignes</span>
                      {lignes.length>0 && <button onClick={()=>setLignes([])} style={{fontSize:11,color:C.red,background:'none',border:'none',cursor:'pointer',padding:0}}>Tout décocher</button>}
                    </div>
                    {lignesDisp.map(l=>(
                      <label key={l} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 12px',cursor:'pointer',fontSize:13,borderBottom:`1px solid ${dark?'#222':'#f5f5f5'}`}}
                        onMouseEnter={e=>(e.currentTarget.style.background=hvr)}
                        onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>
                        <input type="checkbox" checked={lignes.includes(l)} onChange={()=>setLignes(prev=>prev.includes(l)?prev.filter(x=>x!==l):[...prev,l])} style={{accentColor:C.blue}}/>
                        {l}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* XYZ */}
            <div style={{flex:1,minWidth:130}}>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Volatilité XYZ</div>
              <select value={xyz} onChange={e=>setXyz(e.target.value)} style={S}>
                <option value="ALL">Toutes</option>
                <option value="X">X — Stable</option>
                <option value="Y">Y — Variable</option>
                <option value="Z">Z — Imprévisible</option>
              </select>
            </div>

            {/* Tendance */}
            <div style={{flex:1,minWidth:130}}>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Tendance</div>
              <select value={tend} onChange={e=>setTend(e.target.value)} style={S}>
                <option value="ALL">Toutes</option>
                <option value="hausse">↑ En hausse</option>
                <option value="stable">→ Stables</option>
                <option value="baisse">↓ En baisse</option>
              </select>
            </div>

            {/* Couverture */}
            <div style={{flex:1.1,minWidth:150}}>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.blue,marginBottom:5}}>🎯 Couverture Stock</div>
              <select value={cov} onChange={e=>setCov(Number(e.target.value))} style={{...S,border:`2px solid ${C.blue}`,color:C.blue,fontWeight:700,background:dark?'#1a233a':'#e8f0fe'}}>
                <option value={0}>Sélectionner...</option>
                <option value={3}>3 Mois</option>
                <option value={6}>6 Mois</option>
                <option value={12}>12 Mois</option>
              </select>
            </div>

            {/* Total */}
            <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`2px solid ${C.green}`,borderRadius:10,padding:'10px 18px',textAlign:'right',minWidth:180,display:'flex',flexDirection:'column',justifyContent:'center'}}>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.green,marginBottom:3}}>Valeur Commande</div>
              <div style={{fontSize:26,fontWeight:900,color:C.green,fontVariantNumeric:'tabular-nums'}}>{total.toLocaleString('fr-CA',{minimumFractionDigits:2})} $</div>
              <div style={{fontSize:11,color:C.green,opacity:.7}}>{filtered.filter(it=>getQte(it)>0).length} pièces</div>
            </div>
          </div>

          {/* Tableau */}
          <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
            <div style={{overflowX:'auto',maxHeight:'65vh',overflowY:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                <thead><tr>
                  <TH l="Matrice" center/><TH l="Fournisseur"/><TH l="Code Pièce"/>
                  <TH l="Description"/><TH l="Saison" center/><TH l="Tendance" center/>
                  <TH l="Besoin" center blue/><TH l="Stock Sécu." center/><TH l="Pt Cmd" center/>
                  <TH l="Roul." center/><TH l="Stock" center/><TH l="Coût Un." right/>
                  <TH l="ACHAT" center green/>
                  <th style={{padding:'11px 9px',textAlign:'right',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,background:thBg,position:'sticky',top:0,zIndex:10}}>Total $</th>
                </tr></thead>
                <tbody>
                  {loading
                    ? <tr><td colSpan={14} style={{textAlign:'center',padding:60,color:sub}}>⏳ Chargement...</td></tr>
                    : data?.erreur
                    ? <tr><td colSpan={14} style={{textAlign:'center',padding:60,color:C.red}}>{data.erreur}</td></tr>
                    : cov===0
                    ? <tr><td colSpan={14} style={{textAlign:'center',padding:60,color:sub}}>
                        <div style={{fontSize:24,marginBottom:8}}>🎯</div>
                        Sélectionnez une couverture pour voir les recommandations
                      </td></tr>
                    : filtered.length===0
                    ? <tr><td colSpan={14} style={{textAlign:'center',padding:60,color:sub}}>Aucune pièce avec ces filtres</td></tr>
                    : filtered.map(it => {
                        const b=getBesoin(it), q=getQte(it), lc=q*it.cost
                        const tic=it.iconeTendance==='haut'?'↑':it.iconeTendance==='bas'?'↓':'→'
                        const tc=it.iconeTendance==='haut'?C.green:it.iconeTendance==='bas'?C.red:sub
                        const rowBg=it.alerteReappro?(dark?'#2a1f00':'#fff8e1'):'transparent'
                        return (
                          <tr key={it.pk} style={{background:rowBg}}
                            onMouseEnter={e=>e.currentTarget.style.background=it.alerteReappro?(dark?'#362800':'#fff3cd'):hvr}
                            onMouseLeave={e=>e.currentTarget.style.background=rowBg}>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                              <div style={{display:'flex',gap:3,justifyContent:'center'}}>
                                <Bdg label={it.classeABC} color={it.classeABC==='A'?C.green:it.classeABC==='B'?C.yellow:C.red}/>
                                <Bdg label={it.xyz} color={it.xyz==='X'?C.green:it.xyz==='Y'?C.yellow:C.red}/>
                              </div>
                            </td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontSize:12}}>
                              <div style={{maxWidth:150,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:sub}}>{it.fournisseur}</div>
                              <strong style={{color:C.blue,fontSize:11}}>{it.ligne}</strong>
                            </td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`}}>
                              <strong>{it.pk}</strong>
                              {it.alerteReappro && <span style={{background:'#ff6f00',color:'#fff',fontSize:9,fontWeight:700,padding:'2px 4px',borderRadius:3,marginLeft:5}}>⚡RÉAPPRO</span>}
                            </td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:sub}} title={it.desc}>{it.desc}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                              <span style={{background:dark?'#2a2a2a':'#e2e8f0',color:dark?'#ccc':'#475569',padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600}}>{it.saison}</span>
                            </td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                              <span style={{color:tc,fontWeight:900,fontSize:17}}>{tic}</span>
                              <span style={{display:'block',fontSize:10,color:tc}}>{it.tendance>0?'+':''}{it.tendance}%</span>
                            </td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.blue,fontWeight:700}}>{b.toFixed(1)}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.yellow,fontWeight:700}}>{it.stockSecurite}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:sub,fontWeight:600}}>{it.pointCommande}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{it.roulement.toFixed(1)}x</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:it.stock<0?C.red:it.stock===0?C.yellow:txt,fontWeight:700}}>{it.stock}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{it.cost.toFixed(2)}$</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',background:dark?'#0d2a18':'#e6f4ea',color:C.green,fontSize:17,fontWeight:900}}>{q}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700}}>{lc>0?lc.toFixed(2)+'$':'—'}</td>
                          </tr>
                        )
                      })
                  }
                </tbody>
              </table>
            </div>
          </div>
        </>}

        {/* ── IMPORT ──────────────────────────────────────────────── */}
        {tab==='import' && (
          <div style={{maxWidth:620,margin:'40px auto'}}>
            <div style={{background:card,borderRadius:12,padding:28,border:`1px solid ${bdr}`,borderLeft:`5px solid ${C.blue}`}}>
              <h2 style={{margin:'0 0 6px',color:C.blue,fontSize:19}}>Importer les ventes</h2>
              <p style={{color:sub,fontSize:13,margin:'0 0 20px'}}>Chargez un fichier Excel mensuel de ventes.</p>
              <form onSubmit={handleImport}>
                <label style={{display:'block',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Mois</label>
                <input type="month" value={iMois} onChange={e=>setIMois(e.target.value)} required style={{...S,marginBottom:14}}/>
                <label style={{display:'block',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Fichier Excel / CSV</label>
                <input type="file" accept=".xlsx,.xls,.csv" onChange={e=>setIFile(e.target.files?.[0]||null)} required style={{...S,marginBottom:18}}/>
                <button type="submit" style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'11px 0',fontSize:14,fontWeight:700,cursor:'pointer',width:'100%'}}>🚀 Aspirer ce mois</button>
              </form>
              {iStatus && <div style={{marginTop:10,padding:'10px 14px',background:iStatus.startsWith('✓')?(dark?'#0d2a18':'#e6f4ea'):(dark?'#2b1113':'#fce8e6'),borderRadius:8,color:iStatus.startsWith('✓')?C.green:C.red,fontSize:13,fontWeight:600}}>{iStatus}</div>}
              <div style={{marginTop:20,padding:14,background:dark?'#1a1a1a':'#f8f9fa',borderRadius:8,fontSize:12,color:sub}}>
                <strong style={{color:txt}}>Après l'import</strong>, relancez le cache :<br/>
                <code style={{display:'block',marginTop:6,background:dark?'#111':'#e8edf5',padding:'4px 8px',borderRadius:4,fontSize:11}}>curl -X POST http://localhost:3000/api/calculateur/recalculer</code>
              </div>
            </div>
          </div>
        )}

        {/* ── RETOURS RMA ─────────────────────────────────────────── */}
        {tab==='retours' && <>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14,flexWrap:'wrap',gap:10}}>
            <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
              <button onClick={lancerSync} disabled={syncing}
                style={{background:syncing?sub:'#2563eb',color:'#fff',border:'none',borderRadius:8,padding:'9px 18px',fontSize:13,fontWeight:700,cursor:syncing?'default':'pointer'}}>
                {syncing?'⏳ Sync en cours...':'⚡ Synchroniser ERP'}
              </button>
              <button onClick={async()=>{
                  setSyncing(true); setSyncLog('')
                  try {
                    const r = await fetch('/api/lots')
                    if (r.ok) { setLots(await r.json()); setSyncLog('✅ Liste mise à jour') }
                    else setSyncLog('❌ Erreur')
                  } catch(e:any) { setSyncLog('❌ '+e.message) }
                  setSyncing(false)
                }} disabled={syncing}
                style={{background:syncing?sub:C.green,color:'#fff',border:'none',borderRadius:8,padding:'9px 18px',fontSize:13,fontWeight:700,cursor:syncing?'default':'pointer'}}>
                {syncing?'⏳...':'🔄 Rafraîchir'}
              </button>
              {syncLog && <span style={{fontSize:12,color:syncLog.startsWith('✅')?C.green:C.red}}>{syncLog}</span>}
            </div>
            <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`2px solid ${C.green}`,borderRadius:10,padding:'10px 18px',textAlign:'right'}}>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.green,marginBottom:3}}>Valeur à retourner</div>
              <div style={{fontSize:24,fontWeight:900,color:C.green}}>{lots.reduce((s,l)=>s+l.qte_restante*l.cout_unitaire,0).toLocaleString('fr-CA',{minimumFractionDigits:2})} $</div>
            </div>
          </div>
          {/* Section urgente: ≤10 jours restants, groupé par fournisseur */}
          {(()=>{
            const urgents = lots.filter(lot => Math.ceil((new Date(lot.date_limite).getTime()-Date.now())/86400000) <= 10)
            const parFourn = new Map<string, typeof lots>()
            for (const lot of urgents) {
              if (!parFourn.has(lot.fournisseur)) parFourn.set(lot.fournisseur, [])
              parFourn.get(lot.fournisseur)!.push(lot)
            }
            const groupes = Array.from(parFourn.entries()).sort((a,b) => {
              const minA = Math.min(...a[1].map(l => Math.ceil((new Date(l.date_limite).getTime()-Date.now())/86400000)))
              const minB = Math.min(...b[1].map(l => Math.ceil((new Date(l.date_limite).getTime()-Date.now())/86400000)))
              return minA - minB
            })
            return groupes.length > 0 ? (
              <div style={{marginBottom:20}}>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                  <span style={{fontSize:16,fontWeight:800,color:C.red}}>🚨 Retours urgents (≤ 10 jours)</span>
                  <span style={{background:C.red,color:'#fff',padding:'3px 10px',borderRadius:20,fontSize:12,fontWeight:700}}>{urgents.length} pièces • {groupes.length} fournisseurs</span>
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:12}}>
                  {groupes.map(([fourn, lotsF]) => {
                    const totalVal = lotsF.reduce((s,l) => s + l.qte_restante * l.cout_unitaire, 0)
                    const totalQte = lotsF.reduce((s,l) => s + l.qte_restante, 0)
                    const minDiff = Math.min(...lotsF.map(l => Math.ceil((new Date(l.date_limite).getTime()-Date.now())/86400000)))
                    return (
                      <div key={fourn} style={{background:dark?'#2b1113':'#fff8f8',borderRadius:12,border:`2px solid ${C.red}`,overflow:'hidden'}}>
                        <div style={{padding:'12px 16px',background:dark?'#3a1518':C.red+'11',display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8}}>
                          <div>
                            <div style={{fontWeight:800,fontSize:16}}>{fourn}</div>
                            <div style={{fontSize:12,color:sub,marginTop:2}}>{lotsF.length} pièces • {totalQte} unités • Min: <strong style={{color:C.red}}>{minDiff} jours</strong></div>
                          </div>
                          <div style={{textAlign:'right'}}>
                            <div style={{fontSize:18,fontWeight:900,color:C.red}}>{totalVal.toLocaleString('fr-CA',{minimumFractionDigits:2})} $</div>
                          </div>
                        </div>
                        <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                          <thead><tr style={{background:thBg}}>
                            {['Ligne','Code Pièce','Qté Restante','Date Limite','Temps Restant','Valeur'].map((h,i)=>(
                              <th key={i} style={{padding:'8px 9px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`,textAlign:i>=2?'center':'left'}}>{h}</th>
                            ))}
                          </tr></thead>
                          <tbody>
                            {lotsF.sort((a,b) => new Date(a.date_limite).getTime() - new Date(b.date_limite).getTime()).map(lot => {
                              const diff = Math.ceil((new Date(lot.date_limite).getTime()-Date.now())/86400000)
                              return (
                                <tr key={lot.id}>
                                  <td style={{padding:'7px 9px',borderBottom:`1px solid ${bdr}`}}><span style={{background:dark?'#333':'#e2e8f0',color:dark?'#ccc':'#475569',padding:'2px 8px',borderRadius:4,fontSize:12,fontWeight:600}}>{lot.code_ligne}</span></td>
                                  <td style={{padding:'7px 9px',borderBottom:`1px solid ${bdr}`,fontWeight:600}}>{lot.code_piece}</td>
                                  <td style={{padding:'7px 9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700}}>{lot.qte_restante} <span style={{fontSize:11,color:sub}}>(reçu:{lot.qte_recue})</span></td>
                                  <td style={{padding:'7px 9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{lot.date_limite}</td>
                                  <td style={{padding:'7px 9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}><span style={{background:C.red+'22',color:C.red,padding:'2px 8px',borderRadius:20,fontWeight:700,fontSize:12}}>{diff}j</span></td>
                                  <td style={{padding:'7px 9px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700}}>{(lot.qte_restante*lot.cout_unitaire).toFixed(2)} $</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null
          })()}

          {/* Tableau complet tous les lots */}
          <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
            <div style={{padding:'12px 16px',borderBottom:`1px solid ${bdr}`,background:thBg}}>
              <span style={{fontSize:14,fontWeight:700}}>📦 Tous les retours ({lots.length})</span>
            </div>
            {lots.length===0
              ? <div style={{textAlign:'center',padding:50,color:sub}}>
                  <div style={{fontSize:30,marginBottom:10}}>📦</div>
                  <div style={{fontWeight:600,marginBottom:6}}>Aucun lot retournable actif</div>
                  <div style={{fontSize:13}}>Cliquez "Synchroniser ERP" pour analyser les réceptions depuis Traction.</div>
                </div>
              : <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                    <thead><tr style={{background:thBg}}>
                      {['Fournisseur','Ligne','Code Pièce','Qté Restante','Date Limite','Temps Restant','Valeur'].map((h,i)=>(
                        <th key={i} style={{padding:'11px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:i>=3?'center':'left'}}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {lots.map(lot=>{
                        const diff=Math.ceil((new Date(lot.date_limite).getTime()-Date.now())/86400000)
                        const col=diff<=15?C.red:diff<=30?C.yellow:C.green
                        const bgR=diff<=15?(dark?'#2b1113':'#fff8f8'):diff<=30?(dark?'#2b2411':'#fffcf5'):'transparent'
                        return (
                          <tr key={lot.id} style={{background:bgR,borderLeft:`4px solid ${col}`}}>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontWeight:600}}>{lot.fournisseur}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`}}><span style={{background:dark?'#333':'#e2e8f0',color:dark?'#ccc':'#475569',padding:'2px 8px',borderRadius:4,fontSize:12,fontWeight:600}}>{lot.code_ligne}</span></td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`}}>{lot.code_piece}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700}}>{lot.qte_restante} <span style={{fontSize:11,color:sub}}>(reçu:{lot.qte_recue})</span></td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{lot.date_limite}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}><span style={{background:col+'22',color:col,padding:'3px 10px',borderRadius:20,fontWeight:700}}>{diff} jours</span></td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700}}>{(lot.qte_restante*lot.cout_unitaire).toFixed(2)} $</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
            }
          </div>
        </>}

        {/* ── BOOKING ─────────────────────────────────────────────── */}
        {tab==='booking' && <BookingTab data={data} dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} alts={alts}/>}

        {/* ── NÉGATIFS ────────────────────────────────────────────── */}
        {tab==='negatifs' && <NegatifsTab negs={negs} dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} alts={alts} negsVerifies={negsVerifies} setNegsVerifies={setNegsVerifies} profil={profil} data={data} lancerSync={lancerSync} syncing={syncing} syncLog={syncLog} validationsCompta={validationsCompta} retoursActifs={retoursActifsGlobal} setRetoursActifs={setRetoursActifsGlobal} verifsDoubles={verifsDoubles}/>}
        {tab==='commandes' && <CommandesTab data={data} dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} altsMap={alts} fournituresData={fournituresData} setFournituresData={setFournituresData} profil={profil} validationsCompta={validationsCompta}/>}
        {tab==='commandes_attente' && <CommandesAttenteTab dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} profil={profil} forceMesSuivis={forceMesSuivis} setForceMesSuivis={setForceMesSuivis}/>}
        {tab==='inventaire' && <InventaireTab dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} profil={profil} validationsCompta={validationsCompta} retoursActifs={retoursActifsGlobal} setRetoursActifs={setRetoursActifsGlobal}/>}
        {tab==='comptabilite' && <ComptabiliteTab dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} profil={profil} negsVerifies={negsVerifies} validationsCompta={validationsCompta} setValidationsCompta={setValidationsCompta} verifsDoubles={verifsDoubles} setVerifsDoubles={setVerifsDoubles}/>}
        {tab==='verification' && <VerificationTab dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} profil={profil} negsVerifies={negsVerifies} verifsDoubles={verifsDoubles} setVerifsDoubles={setVerifsDoubles} validationsCompta={validationsCompta}/>}
        {tab==='amazon' && <AmazonTab dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} profil={profil}/>}
        {tab==='scoa' && <ScoaTab dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} profil={profil}/>}
        {tab==='utilisateurs' && <UtilisateursTab dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr}/>}
        {tab==='fournitures' && <FournituresTab fournituresData={fournituresData} setFournituresData={setFournituresData} dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} data={data} profil={profil}/>}
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}*{box-sizing:border-box}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-thumb{background:${dark?'#444':'#ccc'};border-radius:3px}#inline-scanner video{object-fit:cover!important;width:100%!important;height:100%!important}#inline-scanner img{display:none!important}`}</style>
    </div>
  )
}

// ── Commandes en attente (suivi import PDF Traction) ────────────────────────
const PLANS_ACTION_CMD = [
  '',
  '📞 Relancer le fournisseur',
  '📧 Email envoyé, en attente réponse',
  '⏰ Délai accepté (en attente)',
  '🔁 BO',
  '🔄 Chercher substitution',
  '🚨 Escalader au gestionnaire',
  '✅ Réception imminente confirmée',
  '❌ Annuler la commande',
] as const

// Le plan d'action « BO » nécessite une date_bo obligatoire
const PLAN_BO = '🔁 BO'

// Fuzzy match pour rapprocher le nom du PDF Traction ("Pothier, Anthony") du
// nom de l'utilisateur connecté ("Anthony Pothier" ou variantes). On
// tokenise, normalise et compte le pourcentage de tokens partagés.
function matchNomEmploye(pdfNom: string | null | undefined, userNom: string | null | undefined): number {
  if (!pdfNom || !userNom) return 0
  const tokenize = (s: string) => new Set(
    s.toLowerCase()
     .normalize('NFD').replace(/[̀-ͯ]/g, '')   // retire accents
     .replace(/[,.]/g, ' ')
     .split(/\s+/)
     .filter(t => t.length >= 2)
  )
  const a = tokenize(pdfNom)
  const b = tokenize(userNom)
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  let interLong = 0  // tokens partagés de longueur ≥ 4 (= noms/prénoms réels)
  for (const t of a) {
    if (b.has(t)) {
      inter++
      if (t.length >= 4) interLong++
    }
  }
  // Faux positif si les seuls tokens partagés sont des mots courts
  if (interLong === 0) return 0
  // Score = ratio par rapport à la liste la plus courte (containment)
  return inter / Math.min(a.size, b.size)
}

function CommandesAttenteTab({dark, card, bdr, sub, thBg, S, C, hvr, profil, forceMesSuivis, setForceMesSuivis}: any) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const [lignes, setLignes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [msg, setMsg] = useState<{type:'ok'|'err'|'info', text:string}|null>(null)
  const [filtFourn, setFiltFourn] = useState('ALL')
  const [filtStatut, setFiltStatut] = useState('ALL')
  const [filtEmploye, setFiltEmploye] = useState('ALL')
  const [filtAge, setFiltAge] = useState('ALL')      // ALL | 0-5 | 5-10 | 10+
  const [filtCommandePar, setFiltCommandePar] = useState('ALL')
  const [filtMesSuivisSeul, setFiltMesSuivisSeul] = useState(false)
  const [recherche, setRecherche] = useState('')
  const [diagOutput, setDiagOutput] = useState<any|null>(null)
  const [historique, setHistorique] = useState<{commandeId: number, items: any[]}|null>(null)
  const [notifVu, setNotifVu] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const fileRefIa = useRef<HTMLInputElement>(null)
  const fileRefDiag = useRef<HTMLInputElement>(null)
  const moiNom = profil?.nom || profil?.email || ''

  useEffect(() => { charger() }, [])

  // Quand on arrive depuis le bandeau global "Voir mes suivis" :
  // on active le filtre mes-suivis-seul + on met l'âge sur 10+, et on
  // reset l'indicateur global pour ne pas re-déclencher au prochain montage.
  useEffect(() => {
    if (forceMesSuivis) {
      setFiltMesSuivisSeul(true)
      setFiltAge('10+')
      setFiltFourn('ALL')
      setFiltStatut('ALL')
      setFiltEmploye('ALL')
      setFiltCommandePar('ALL')
      setRecherche('')
      if (typeof setForceMesSuivis === 'function') setForceMesSuivis(false)
    }
  }, [forceMesSuivis, setForceMesSuivis])

  async function charger() {
    setLoading(true)
    try {
      const r = await fetch('/api/commandes-attente')
      if (r.ok) {
        const d = await r.json()
        setLignes(d.lignes || [])
      }
    } finally { setLoading(false) }
  }

  async function importerPdf(file: File, moteur: 'regex'|'ia' = 'regex') {
    setImporting(true)
    setMsg({type:'info', text: moteur === 'ia' ? 'Import IA en cours… (peut prendre 1-3 min)' : 'Import en cours…'})
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('moteur', moteur)
      const r = await fetch('/api/commandes-attente/import', { method:'POST', body: fd })
      const d = await r.json()
      if (!r.ok || d.erreur) {
        setMsg({type:'err', text: d.erreur || 'Erreur import'})
        if (d.rawLines) setDiagOutput({ rawLines: d.rawLines, commandes: [], note: 'Échec parsing — lignes brutes ci-dessous' })
      } else {
        setMsg({
          type:'ok',
          text:`✅ ${d.nb_commandes_parsees} commandes lues (moteur ${d.moteur}) — ${d.inserted} nouvelles, ${d.updated} mises à jour, ${d.deactivated} reçues/fermées.`,
        })
        await charger()
      }
    } catch (e:any) {
      setMsg({type:'err', text: e.message || String(e)})
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function diagnostiquerPdf(file: File) {
    setImporting(true)
    setDiagOutput(null)
    setMsg({type:'info', text:'Diagnostic en cours…'})
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('diagnostic', '1')
      const r = await fetch('/api/commandes-attente/import', { method:'POST', body: fd })
      const d = await r.json()
      if (!r.ok || d.erreur) {
        setMsg({type:'err', text: d.erreur || 'Erreur diagnostic'})
      } else {
        setMsg({type:'ok', text:`Diagnostic : ${d.nb_lignes_brutes} lignes brutes, ${d.nb_commandes_parsees} commandes reconnues.`})
        setDiagOutput(d)
      }
    } catch (e:any) {
      setMsg({type:'err', text: e.message || String(e)})
    } finally {
      setImporting(false)
      if (fileRefDiag.current) fileRefDiag.current.value = ''
    }
  }

  async function patcherLigne(id: number, patch: {remarque?: string, plan_action?: string, date_bo?: string|null}) {
    setLignes(prev => prev.map(l => l.id===id ? {...l, ...patch, date_action: new Date().toISOString()} : l))
    await fetch('/api/commandes-attente', {
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ id, ...patch, modifie_par: moiNom }),
    })
  }

  async function ouvrirHistorique(commandeId: number) {
    setHistorique({ commandeId, items: [] })
    try {
      const r = await fetch(`/api/commandes-attente/historique?commande_id=${commandeId}`)
      if (r.ok) {
        const d = await r.json()
        setHistorique({ commandeId, items: d.historique || [] })
      }
    } catch {}
  }

  // Calcul de l'âge en jours = aujourd'hui - date_commande (fallback :
  // date_premiere_vue si la date de commande manque dans le PDF).
  const enriched = lignes.map(l => {
    const ref = l.date_commande ? new Date(l.date_commande + 'T00:00:00') : new Date(l.date_premiere_vue)
    const ageJours = Math.max(0, Math.floor((Date.now() - ref.getTime()) / 86400000))
    return { ...l, ageJours }
  })

  // Tranches d'âge fixes : 0-5j (vert), 5-10j (jaune), 10j+ (rouge)
  const trancheAge = (j: number): '0-5'|'5-10'|'10+' => j < 5 ? '0-5' : j < 10 ? '5-10' : '10+'

  const fournisseurs = [...new Set(enriched.map(l => l.nom_fournisseur).filter(Boolean))].sort()
  const statuts      = [...new Set(enriched.map(l => l.statut).filter(Boolean))].sort()
  const employes     = [...new Set(enriched.map(l => l.nom_employe).filter(Boolean))].sort()
  const commandeurs  = [...new Set(enriched.map(l => l.commande_par).filter(Boolean))].sort()

  const filtres = (l:any) => {
    if (filtMesSuivisSeul && matchNomEmploye(l.nom_employe, moiNom) < 0.85) return false
    if (filtFourn !== 'ALL' && l.nom_fournisseur !== filtFourn) return false
    if (filtStatut !== 'ALL' && l.statut !== filtStatut) return false
    if (filtEmploye !== 'ALL' && l.nom_employe !== filtEmploye) return false
    if (filtCommandePar !== 'ALL' && l.commande_par !== filtCommandePar) return false
    if (filtAge !== 'ALL' && trancheAge(l.ageJours) !== filtAge) return false
    if (recherche.trim()) {
      const q = recherche.toLowerCase()
      const hay = `${l.num_commande} ${l.num_piece} ${l.description||''} ${l.nom_fournisseur||''} ${l.commande_par||''} ${l.nom_employe||''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  }

  const filtered  = enriched.filter(filtres)
  const enRetard  = filtered.filter(l => l.ageJours >= 10)
  const aSurveil  = filtered.filter(l => l.ageJours >= 5 && l.ageJours < 10)
  const aTemps    = filtered.filter(l => l.ageJours < 5)

  // Notifications pour l'utilisateur connecté :
  // commandes en retard (≥10j) AVEC un plan d'action rempli ET dont le
  // nom_employe matche le nom de l'utilisateur à ≥85%.
  const mesSuivis = enriched.filter(l =>
    l.ageJours >= 10
    && l.plan_action
    && l.plan_action.length > 0
    && matchNomEmploye(l.nom_employe, moiNom) >= 0.85
  )

  const ageBadge = (j:number) => {
    const t = trancheAge(j)
    const col = t === '10+' ? C.red : t === '5-10' ? C.yellow : C.green
    return <span style={{background:col+'22',color:col,padding:'3px 10px',borderRadius:20,fontWeight:700,fontSize:12,whiteSpace:'nowrap'}}>{j} j</span>
  }

  const statutBadge = (s:string) => {
    const sl = s.toLowerCase()
    const col = sl.includes('partielle') ? C.yellow
              : sl.includes('ferm') ? C.green
              : sl.includes('annul') ? C.red
              : C.blue
    return <span style={{background:col+'22',color:col,padding:'2px 8px',borderRadius:6,fontSize:11,fontWeight:700}}>{s}</span>
  }

  const renderLigne = (l:any, urgent:boolean) => {
    const isBO = l.plan_action === PLAN_BO
    const boManquante = isBO && !l.date_bo
    return (
    <tr key={l.id} style={{background: urgent ? (dark?'#2b1113':'#fff5f5') : 'transparent', borderLeft: urgent ? `4px solid ${C.red}` : '4px solid transparent'}}>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontWeight:700,fontSize:12}}>{l.num_commande}</td>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>{l.date_commande || '—'}</td>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`}}>{statutBadge(l.statut)}</td>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub}}>{l.num_fournisseur || '—'}</td>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11,fontWeight:600}}>{l.nom_fournisseur || '—'}</td>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>{l.commande_par || '—'}</td>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontWeight:700,fontSize:12}}>{l.num_piece}</td>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700}}>{l.qte_commandee}</td>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11,maxWidth:200}}>{l.description || '—'}</td>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>{l.nom_employe || '—'}</td>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub}}>{l.num_facture || '—'}</td>
      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{ageBadge(l.ageJours)}</td>
      <td style={{padding:'6px',borderBottom:`1px solid ${bdr}`,minWidth:160}}>
        <input
          type="text"
          defaultValue={l.remarque || ''}
          onBlur={e => { if (e.target.value !== (l.remarque||'')) patcherLigne(l.id, {remarque: e.target.value}) }}
          placeholder="Remarque…"
          style={{width:'100%',padding:'5px 7px',border:`1px solid ${bdr}`,borderRadius:5,fontSize:11,background:dark?'#1a1a1a':'#fff',color:dark?'#eee':'#222'}}
        />
      </td>
      <td style={{padding:'6px',borderBottom:`1px solid ${bdr}`,minWidth:220}}>
        <div style={{display:'flex',gap:4,alignItems:'center'}}>
          <select
            value={l.plan_action || ''}
            onChange={e => {
              const next = e.target.value
              const patch: any = { plan_action: next }
              // Si on passe à autre chose que BO, on efface la date_bo
              if (next !== PLAN_BO && l.date_bo) patch.date_bo = null
              patcherLigne(l.id, patch)
            }}
            style={{flex:1,padding:'5px 7px',border:`1px solid ${boManquante?C.red:bdr}`,borderRadius:5,fontSize:11,background:dark?'#1a1a1a':'#fff',color:dark?'#eee':'#222',fontWeight:l.plan_action?700:400}}>
            {PLANS_ACTION_CMD.map(p => <option key={p} value={p}>{p || '—'}</option>)}
          </select>
          <button
            onClick={()=>ouvrirHistorique(l.id)}
            title="Voir l'historique des modifications"
            style={{background:'transparent',border:`1px solid ${bdr}`,borderRadius:4,padding:'4px 6px',cursor:'pointer',fontSize:11,color:sub}}>
            🕐
          </button>
        </div>
        {isBO && (
          <input
            type="date"
            value={l.date_bo || ''}
            onChange={e => patcherLigne(l.id, {date_bo: e.target.value || null})}
            required
            style={{marginTop:4,width:'100%',padding:'4px 6px',border:`1px solid ${boManquante?C.red:bdr}`,borderRadius:4,fontSize:11,background:dark?'#1a1a1a':'#fff',color:boManquante?C.red:(dark?'#eee':'#222'),fontWeight:700}}
            placeholder="Date BO obligatoire"
          />
        )}
      </td>
    </tr>
    )
  }

  const colonnes = ['#Commande','Date','Statut','#Fourn','Nom Fournisseur','Cmdé Par','#Pièce','Qte','Description','Employé','#Facture','Âge','Remarque','Plan d\'action']
  const tableTop = (
    <thead>
      <tr style={{background:thBg}}>
        {colonnes.map(c => <th key={c} style={{padding:'9px 8px',textAlign:'left',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`,whiteSpace:'nowrap'}}>{c}</th>)}
      </tr>
    </thead>
  )

  return (
    <div>
      {/* 🔔 Notification : commandes en retard de l'utilisateur avec plan d'action */}
      {mesSuivis.length > 0 && !notifVu && (
        <div style={{background:'#fce8e6',border:`2px solid ${C.red}`,borderRadius:10,padding:'12px 16px',marginBottom:14,display:'flex',alignItems:'center',gap:14,flexWrap:'wrap',animation:'pulseRet 2s ease-in-out infinite'}}>
          <style>{`@keyframes pulseRet { 0%,100%{box-shadow:0 0 0 0 rgba(217,48,37,.4)} 50%{box-shadow:0 0 0 8px rgba(217,48,37,0)} }`}</style>
          <span style={{fontSize:24}}>🔔</span>
          <div style={{flex:1,minWidth:200}}>
            <div style={{fontSize:13,fontWeight:900,color:C.red}}>
              {mesSuivis.length === 1
                ? '1 suivi à faire'
                : `${mesSuivis.length} suivis à faire`}
            </div>
            <div style={{fontSize:11,color:'#5f6368',marginTop:2}}>
              Tu as {mesSuivis.length === 1 ? 'une commande' : 'des commandes'} en retard (≥10j) avec un plan d'action en cours. Action attendue.
            </div>
          </div>
          <button onClick={()=>{ setFiltMesSuivisSeul(true); setFiltAge('10+'); setFiltEmploye('ALL') }}
            style={{background:C.red,color:'#fff',border:'none',borderRadius:8,padding:'9px 14px',fontWeight:800,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
            Voir mes suivis ({mesSuivis.length})
          </button>
          <button onClick={()=>setNotifVu(true)}
            title="Masquer (jusqu'au prochain rechargement)"
            style={{background:'transparent',border:'none',color:sub,cursor:'pointer',fontSize:14}}>
            ✕
          </button>
        </div>
      )}

      {/* Modal historique d'une commande */}
      {historique && (
        <div onClick={()=>setHistorique(null)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,maxWidth:680,width:'100%',maxHeight:'80vh',overflow:'auto'}}>
            <div style={{padding:'14px 18px',borderBottom:`1px solid ${bdr}`,display:'flex',alignItems:'center',gap:10}}>
              <span style={{fontSize:16,fontWeight:900}}>🕐 Historique des modifications</span>
              <button onClick={()=>setHistorique(null)} style={{marginLeft:'auto',background:'transparent',border:'none',color:sub,cursor:'pointer',fontSize:16}}>✕</button>
            </div>
            <div style={{padding:16}}>
              {historique.items.length === 0 ? (
                <div style={{color:sub,fontSize:12,textAlign:'center',padding:20}}>Aucune modification enregistrée pour cette commande.</div>
              ) : (
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead>
                    <tr style={{background:thBg}}>
                      <th style={{padding:'8px',textAlign:'left',borderBottom:`1px solid ${bdr}`}}>Date</th>
                      <th style={{padding:'8px',textAlign:'left',borderBottom:`1px solid ${bdr}`}}>Par</th>
                      <th style={{padding:'8px',textAlign:'left',borderBottom:`1px solid ${bdr}`}}>Champ</th>
                      <th style={{padding:'8px',textAlign:'left',borderBottom:`1px solid ${bdr}`}}>Avant</th>
                      <th style={{padding:'8px',textAlign:'left',borderBottom:`1px solid ${bdr}`}}>Après</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historique.items.map(h => (
                      <tr key={h.id}>
                        <td style={{padding:'7px',borderBottom:`1px solid ${bdr}`,whiteSpace:'nowrap',fontSize:11,color:sub}}>{new Date(h.modifie_le).toLocaleString('fr-CA')}</td>
                        <td style={{padding:'7px',borderBottom:`1px solid ${bdr}`,fontSize:11,fontWeight:600}}>{h.modifie_par || '—'}</td>
                        <td style={{padding:'7px',borderBottom:`1px solid ${bdr}`,fontSize:11}}><span style={{background:dark?'#222':'#eef',padding:'2px 6px',borderRadius:4,fontSize:10,fontWeight:700}}>{h.champ}</span></td>
                        <td style={{padding:'7px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis'}}>{h.valeur_avant || '∅'}</td>
                        <td style={{padding:'7px',borderBottom:`1px solid ${bdr}`,fontSize:11,fontWeight:600,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis'}}>{h.valeur_apres || '∅'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Header — import + config */}
      <div style={{...S.card, background:card, border:`1px solid ${bdr}`, padding:14, marginBottom:14}}>
        <div style={{display:'flex',gap:14,alignItems:'center',flexWrap:'wrap'}}>
          <div style={{flex:1,minWidth:220}}>
            <div style={{fontSize:18,fontWeight:900,color:C.blue}}>⏳ Commandes en attente</div>
            <div style={{fontSize:11,color:sub,marginTop:3}}>
              Importe ton PDF "Liste commande" Traction. Les commandes absentes du nouveau PDF disparaissent automatiquement.
              Échelle : <span style={{color:C.green,fontWeight:700}}>0–5j</span> · <span style={{color:C.yellow,fontWeight:700}}>5–10j</span> · <span style={{color:C.red,fontWeight:700}}>10j+</span>
            </div>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            style={{display:'none'}}
            onChange={e => { const f = e.target.files?.[0]; if (f) importerPdf(f, 'regex') }}
          />
          <input
            ref={fileRefIa}
            type="file"
            accept="application/pdf,.pdf"
            style={{display:'none'}}
            onChange={e => { const f = e.target.files?.[0]; if (f) importerPdf(f, 'ia') }}
          />
          <input
            ref={fileRefDiag}
            type="file"
            accept="application/pdf,.pdf"
            style={{display:'none'}}
            onChange={e => { const f = e.target.files?.[0]; if (f) diagnostiquerPdf(f) }}
          />
          <button
            disabled={importing}
            onClick={()=>fileRef.current?.click()}
            style={{background:importing?sub:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'10px 18px',fontWeight:800,cursor:importing?'not-allowed':'pointer',fontSize:13}}>
            {importing ? '⏳ Import…' : '📥 Importer PDF'}
          </button>
          <button
            disabled={importing}
            onClick={()=>fileRefIa.current?.click()}
            title="Mode IA — plus précis mais beaucoup plus lent (1-3 min). Utile si l'import standard rate des lignes."
            style={{background:'transparent',color:C.blue,border:`1px solid ${C.blue}`,borderRadius:8,padding:'10px 14px',fontWeight:700,cursor:importing?'not-allowed':'pointer',fontSize:12}}>
            🤖 Mode IA
          </button>
          <button
            disabled={importing}
            onClick={()=>fileRefDiag.current?.click()}
            title="Affiche les lignes brutes extraites du PDF — utile si l'import rate"
            style={{background:'transparent',color:sub,border:`1px solid ${bdr}`,borderRadius:8,padding:'10px 14px',fontWeight:700,cursor:importing?'not-allowed':'pointer',fontSize:12}}>
            🔍 Diagnostic
          </button>
        </div>

        {/* Paramètres exacts à utiliser dans Traction pour générer le PDF */}
        <div style={{marginTop:12,padding:'10px 12px',background:dark?'#0f1a2b':'#eaf2ff',border:`1px solid ${C.blue}33`,borderLeft:`3px solid ${C.blue}`,borderRadius:6,fontSize:11,lineHeight:1.7,color:dark?'#cfe1ff':'#1a3a6a'}}>
          <div style={{fontWeight:800,marginBottom:4,color:C.blue}}>📄 Paramètres Traction pour générer le PDF</div>
          <div><b>Importer :</b> Lautopak — Menu 247</div>
          <div><b>Impression :</b> Détaillée par pièces</div>
          <div><b>Type de commande :</b> *Tous*</div>
          <div><b>Réceptions partielles :</b> back-order seulement <span style={{color:C.green,fontWeight:700}}>☑ cocher</span></div>
          <div><b>Afficher les quantités commandées à 0 :</b> <span style={{color:C.red,fontWeight:700}}>☐ décocher</span></div>
          <div><b>Statut :</b> Transmise/Fermée <span style={{color:C.green,fontWeight:700}}>☑ cocher</span> &nbsp; · &nbsp; Réception Partielle <span style={{color:C.green,fontWeight:700}}>☑ cocher</span></div>
        </div>

        {msg && (
          <div style={{marginTop:10,padding:'9px 12px',borderRadius:6,fontSize:12,fontWeight:600,
            background: msg.type==='ok' ? '#e6f4ea' : msg.type==='err' ? '#fce8e6' : '#e8f0fe',
            color: msg.type==='ok' ? C.green : msg.type==='err' ? C.red : C.blue}}>
            {msg.text}
          </div>
        )}

        {diagOutput && (
          <div style={{marginTop:12,border:`1px solid ${bdr}`,borderRadius:6,overflow:'hidden'}}>
            <div style={{padding:'8px 12px',background:dark?'#1a1a1a':'#f8f9fa',display:'flex',alignItems:'center',gap:10,borderBottom:`1px solid ${bdr}`}}>
              <span style={{fontSize:13,fontWeight:800}}>🔍 Diagnostic PDF</span>
              {diagOutput.moteur && <span style={{fontSize:11,color:sub}}>moteur : {diagOutput.moteur}</span>}
              <span style={{fontSize:11,color:sub}}>{diagOutput.commandes?.length || 0} commandes reconnues</span>
              <button onClick={()=>setDiagOutput(null)} style={{marginLeft:'auto',background:'transparent',border:'none',color:sub,cursor:'pointer',fontSize:13}}>✕</button>
            </div>
            <div style={{padding:10,maxHeight:380,overflow:'auto',fontFamily:'ui-monospace,monospace',fontSize:11,whiteSpace:'pre-wrap',background:dark?'#0d0d0d':'#fff'}}>
              {diagOutput.note && <div style={{color:C.red,fontWeight:700,marginBottom:8}}>{diagOutput.note}</div>}
              <div style={{fontWeight:700,marginBottom:4,color:C.blue}}>— Texte brut extrait du PDF (premiers 8000 car) —</div>
              <div>{diagOutput.rawText || (diagOutput.rawLines || []).join('\n')}</div>
              {diagOutput.commandes && diagOutput.commandes.length > 0 && <>
                <div style={{fontWeight:700,marginTop:14,marginBottom:4,color:C.green}}>— Commandes parsées (JSON) —</div>
                <div>{JSON.stringify(diagOutput.commandes, null, 2)}</div>
              </>}
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div style={{textAlign:'center',padding:40,color:sub}}>Chargement…</div>
      ) : enriched.length === 0 ? (
        <div style={{...S.card, background:card, border:`1px solid ${bdr}`, padding:30, textAlign:'center', color:sub}}>
          Aucune commande en attente. Importe ton PDF Traction pour commencer.
        </div>
      ) : <>
        {/* Filtres */}
        <div style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap',alignItems:'center'}}>
          <input
            placeholder="🔍 Recherche (n° commande, pièce, description…)"
            value={recherche}
            onChange={e=>setRecherche(e.target.value)}
            style={{flex:1,minWidth:220,padding:'8px 12px',border:`1px solid ${bdr}`,borderRadius:6,background:card,color:dark?'#eee':'#222',fontSize:12}}
          />
          <select value={filtAge} onChange={e=>setFiltAge(e.target.value)}
            title="Filtrer par tranche d'âge depuis la date de commande"
            style={{padding:'8px 10px',border:`1px solid ${bdr}`,borderRadius:6,background:card,color:dark?'#eee':'#222',fontSize:12,fontWeight:filtAge!=='ALL'?700:400}}>
            <option value="ALL">Tous les âges</option>
            <option value="0-5">🟢 0–5 jours</option>
            <option value="5-10">🟡 5–10 jours</option>
            <option value="10+">🔴 10 jours et plus</option>
          </select>
          <select value={filtStatut} onChange={e=>setFiltStatut(e.target.value)}
            style={{padding:'8px 10px',border:`1px solid ${bdr}`,borderRadius:6,background:card,color:dark?'#eee':'#222',fontSize:12,fontWeight:filtStatut!=='ALL'?700:400}}>
            <option value="ALL">Tous les statuts</option>
            {statuts.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filtFourn} onChange={e=>setFiltFourn(e.target.value)}
            style={{padding:'8px 10px',border:`1px solid ${bdr}`,borderRadius:6,background:card,color:dark?'#eee':'#222',fontSize:12,fontWeight:filtFourn!=='ALL'?700:400}}>
            <option value="ALL">Tous les fournisseurs</option>
            {fournisseurs.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={filtCommandePar} onChange={e=>setFiltCommandePar(e.target.value)}
            style={{padding:'8px 10px',border:`1px solid ${bdr}`,borderRadius:6,background:card,color:dark?'#eee':'#222',fontSize:12,fontWeight:filtCommandePar!=='ALL'?700:400}}>
            <option value="ALL">Tous les commandeurs</option>
            {commandeurs.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filtEmploye} onChange={e=>setFiltEmploye(e.target.value)}
            style={{padding:'8px 10px',border:`1px solid ${bdr}`,borderRadius:6,background:card,color:dark?'#eee':'#222',fontSize:12,fontWeight:filtEmploye!=='ALL'?700:400}}>
            <option value="ALL">Tous les employés</option>
            {employes.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          {moiNom && (
            <button
              onClick={()=>setFiltMesSuivisSeul(!filtMesSuivisSeul)}
              title="Filtrer pour ne montrer que les commandes qui te sont associées (match nom à ≥85%)"
              style={{padding:'8px 12px',border:`1px solid ${filtMesSuivisSeul?C.blue:bdr}`,borderRadius:6,background:filtMesSuivisSeul?C.blue:'transparent',color:filtMesSuivisSeul?'#fff':sub,fontSize:11,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>
              {filtMesSuivisSeul ? '✓ Mes suivis' : '👤 Mes suivis'}
            </button>
          )}
          {(filtAge!=='ALL'||filtStatut!=='ALL'||filtFourn!=='ALL'||filtCommandePar!=='ALL'||filtEmploye!=='ALL'||filtMesSuivisSeul||recherche) && (
            <button
              onClick={()=>{setFiltAge('ALL');setFiltStatut('ALL');setFiltFourn('ALL');setFiltCommandePar('ALL');setFiltEmploye('ALL');setFiltMesSuivisSeul(false);setRecherche('')}}
              style={{padding:'8px 12px',border:'none',borderRadius:6,background:C.red+'22',color:C.red,fontSize:11,fontWeight:700,cursor:'pointer'}}>
              ✕ Réinit. filtres
            </button>
          )}
        </div>

        {/* Compteurs des 3 tranches */}
        <div style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}>
          <div style={{flex:1,minWidth:140,padding:'8px 12px',border:`1px solid ${bdr}`,borderLeft:`4px solid ${C.green}`,borderRadius:6,background:card}}>
            <div style={{fontSize:11,color:sub}}>0–5 jours</div>
            <div style={{fontSize:18,fontWeight:900,color:C.green}}>{aTemps.length}</div>
          </div>
          <div style={{flex:1,minWidth:140,padding:'8px 12px',border:`1px solid ${bdr}`,borderLeft:`4px solid ${C.yellow}`,borderRadius:6,background:card}}>
            <div style={{fontSize:11,color:sub}}>5–10 jours</div>
            <div style={{fontSize:18,fontWeight:900,color:C.yellow}}>{aSurveil.length}</div>
          </div>
          <div style={{flex:1,minWidth:140,padding:'8px 12px',border:`1px solid ${bdr}`,borderLeft:`4px solid ${C.red}`,borderRadius:6,background:card}}>
            <div style={{fontSize:11,color:sub}}>10 jours et plus</div>
            <div style={{fontSize:18,fontWeight:900,color:C.red}}>{enRetard.length}</div>
          </div>
        </div>

        {/* 🚨 Suivi à faire (≥10j) */}
        <div style={{...S.card, background:card, border:`2px solid ${enRetard.length>0?C.red:bdr}`, padding:0, marginBottom:14, overflow:'hidden'}}>
          <div style={{padding:'12px 14px',background: enRetard.length>0 ? '#fce8e6' : (dark?'#1a1a1a':'#f8f9fa'),borderBottom:`1px solid ${bdr}`,display:'flex',alignItems:'center',gap:10}}>
            <span style={{fontSize:18}}>🚨</span>
            <span style={{fontSize:14,fontWeight:900,color:enRetard.length>0?C.red:sub}}>Suivi à faire</span>
            <span style={{fontSize:12,color:sub}}>— {enRetard.length} pièce(s) en commande depuis 10 jours ou plus</span>
          </div>
          {enRetard.length === 0 ? (
            <div style={{padding:20,textAlign:'center',color:sub,fontSize:12}}>Tout va bien : aucune commande de 10 jours et plus.</div>
          ) : (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',minWidth:1300}}>
                {tableTop}
                <tbody>{enRetard.map(l => renderLigne(l, true))}</tbody>
              </table>
            </div>
          )}
        </div>

        {/* 📋 Toutes les commandes (sauf 10j+) */}
        <div style={{...S.card, background:card, border:`1px solid ${bdr}`, padding:0, overflow:'hidden'}}>
          <div style={{padding:'12px 14px',background:dark?'#1a1a1a':'#f8f9fa',borderBottom:`1px solid ${bdr}`,display:'flex',alignItems:'center',gap:10}}>
            <span style={{fontSize:18}}>📋</span>
            <span style={{fontSize:14,fontWeight:900}}>Commandes en cours</span>
            <span style={{fontSize:12,color:sub}}>— {aTemps.length + aSurveil.length} pièce(s) de moins de 10 jours</span>
          </div>
          {(aTemps.length + aSurveil.length) === 0 ? (
            <div style={{padding:20,textAlign:'center',color:sub,fontSize:12}}>Rien à afficher avec ces filtres.</div>
          ) : (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',minWidth:1300}}>
                {tableTop}
                <tbody>{[...aSurveil, ...aTemps].map(l => renderLigne(l, false))}</tbody>
              </table>
            </div>
          )}
        </div>
      </>}
    </div>
  )
}

// ── Commandes du Jour ────────────────────────────────────────────────────────
function CommandesTab({data, dark, card, bdr, sub, thBg, S, C, hvr, altsMap, fournituresData, setFournituresData, profil, validationsCompta}: any) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const [filtFourn, setFiltFourn] = useState('ALL')
  const employe = profil?.nom || profil?.email || 'Inconnu'
  const validesCommandeIds = new Set((validationsCompta||[]).filter((v:any)=>v.source==='commande').map((v:any)=>v.ref_id))
  const [suivis, setSuivis] = useState<any[]>([])
  const [alternatives, setAlternatives] = useState<Map<string,string>>(new Map())
  const [actionModal, setActionModal] = useState<{item: any, type: string} | null>(null)
  const [pieceAlt, setPieceAlt] = useState('')
  const [filtreStatut, setFiltreStatut] = useState('actif') // actif | attente | verifie | tout
  const aujourd = new Date()
  const moisNow = aujourd.getMonth()

  // Charger les suivis depuis Supabase au montage
  useEffect(() => {
    chargerSuivis()
    chargerAlternatives()
    const interval = setInterval(chargerSuivis, 30000)
    return () => clearInterval(interval)
  }, [])

  async function chargerAlternatives() {
    try {
      const r = await fetch('/api/alternatives')
      if (r.ok) {
        const data = await r.json()
        const map = new Map<string,string>()
        for (const a of data) {
          map.set(a.code_principal, a.code_alternatif)
          map.set(a.code_alternatif, a.code_principal)
        }
        setAlternatives(map)
      }
    } catch {}
  }

  async function chargerSuivis() {
    try {
      const r = await fetch('/api/suivi-commandes')
      if (r.ok) setSuivis(await r.json())
    } catch {}
  }

  function getSuivi(pk: string) {
    return suivis.find((s: any) => s.code_piece === pk)
  }

  function estCache(pk: string): boolean {
    const s = getSuivi(pk)
    if (!s) return false
    if (s.statut === 'pas_besoin') {
      return !s.date_expiry || new Date(s.date_expiry) > new Date()
    }
    if (s.statut === 'commande_faite') return true
    return false
  }

  function estVerifie(pk: string): boolean {
    const s = getSuivi(pk)
    return s?.statut === 'verifie'
  }

  function estValideCompta(pk: string): boolean {
    const s = getSuivi(pk)
    return !!(s && validesCommandeIds.has(s.id))
  }

  async function faireAction(item: any, type: string, extra?: any) {
    const body: any = {
      code_piece: item.pk,
      fournisseur: item.fournisseur,
      qte_suggeree: item.qteACommander,
      statut: type,
      stock_au_moment: item.stock,
      employe,
      ...extra
    }
    if (type === 'pas_besoin') {
      const exp = new Date()
      exp.setMonth(exp.getMonth() + 3)
      body.date_expiry = exp.toISOString()
    }
    await fetch('/api/suivi-commandes', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
    await chargerSuivis()
    setActionModal(null)
    setPieceAlt('')
  }

  function getBesoin4Semaines(it: any): number {
    if (!it.ventesMoyParMois) return it.moyMois
    const dernierJourMois = new Date(aujourd.getFullYear(), moisNow + 1, 0).getDate()
    const jourActuel = aujourd.getDate()
    const joursRestants = Math.min(dernierJourMois - jourActuel + 1, 28)
    const joursDebord = Math.max(0, 28 - joursRestants)
    const propM1 = joursRestants / dernierJourMois
    const moisSuivant = (moisNow + 1) % 12
    const propM2 = joursDebord / new Date(aujourd.getFullYear(), moisSuivant + 1, 0).getDate()
    return (it.ventesMoyParMois[moisNow] ?? it.moyMois) * propM1 + (it.ventesMoyParMois[moisSuivant] ?? it.moyMois) * propM2
  }

  const items: any[] = data?.liste_complete || []
  const BESOIN_MIN = 3
  const VALEUR_MIN = 10

  const toutesLignes = items.filter(it => {
    if (it.classeABC === 'C') return false
    if (it.saison === 'Sur Commande') return false
    if (filtFourn !== 'ALL' && it.fournisseur !== filtFourn) return false
    const besoin = getBesoin4Semaines(it)
    if (besoin < BESOIN_MIN) return false
    // Exclure si une alternative couvre la demande
    const suiviItem = getSuivi(it.pk)
    const altCodesC:string[] = [
      ...((altsMap&&altsMap.get&&altsMap.get(it.pk))||[]),
      ...(suiviItem?.piece_alternative ? [suiviItem.piece_alternative] : [])
    ]
    const normalize = (s:string) => s.trim().toLowerCase().replace(/\s+/g,'')
    const allItems:any[] = data?.liste_complete || []
    const altCouvreC = altCodesC.some((ac:string)=>{
      const acNorm = normalize(ac)
      const ai = allItems.find((x:any)=>normalize(x.pk)===acNorm)
      return ai&&Math.max(0,ai.stock)>=besoin
    })
    if (altCouvreC) return false
    return Math.max(0, it.stock) < besoin
  }).map(it => {
    const besoin = getBesoin4Semaines(it)
    const stockEff = Math.max(0, it.stock)
    const qteACommander = Math.max(1, Math.ceil(besoin - stockEff + (it.stockSecurite || 0)))
    return { ...it, besoin4sem: besoin, qteACommander, totalLigne: qteACommander * it.cost }
  }).filter(it => it.totalLigne >= VALEUR_MIN)
  .sort((a: any, b: any) => a.fournisseur.localeCompare(b.fournisseur))

  // Filtrer selon statut
  const suggestions = toutesLignes.filter(it => {
    const s = getSuivi(it.pk)
    if (filtreStatut === 'actif') return !estCache(it.pk) && !estVerifie(it.pk)
    if (filtreStatut === 'attente') return s?.statut === 'commande_faite'
    if (filtreStatut === 'verifie') return s?.statut === 'verifie' && !estValideCompta(it.pk)
    return true
  })

  const fournisseurs = Array.from(new Set(toutesLignes.map(it => it.fournisseur))).sort() as string[]
  const totalCommande = suggestions.reduce((s: number, it: any) => s + it.totalLigne, 0)
  const nbAttente = toutesLignes.filter(it => getSuivi(it.pk)?.statut === 'commande_faite').length
  const nbVerifie = toutesLignes.filter(it => getSuivi(it.pk)?.statut === 'verifie' && !estValideCompta(it.pk)).length

  const parFournisseur = new Map<string, any[]>()
  for (const it of suggestions) {
    if (!parFournisseur.has(it.fournisseur)) parFournisseur.set(it.fournisseur, [])
    parFournisseur.get(it.fournisseur)!.push(it)
  }

  const dateStr = aujourd.toLocaleDateString('fr-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric' })

  return <>


    {/* Modal action */}
    {actionModal && (
      <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <div style={{background:card,borderRadius:14,padding:28,width:420,border:`1px solid ${bdr}`}}>
          <h3 style={{margin:'0 0 6px',fontSize:16}}>{actionModal.type === 'alternative' ? '🔄 Pièce Alternative' : actionModal.type === 'pas_besoin' ? '🚫 Pas besoin' : '✅ Commande Faite'}</h3>
          <p style={{color:sub,fontSize:13,margin:'0 0 16px'}}><strong>{actionModal.item.pk}</strong> — {actionModal.item.desc}</p>
          {actionModal.type === 'alternative' && <>
            <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:5}}>Code SKU alternatif</label>
            <input value={pieceAlt} onChange={e=>setPieceAlt(e.target.value)} placeholder="Ex: 8M0060005" style={{...S,marginBottom:14}} autoFocus/>
          </>}
          {actionModal.type === 'pas_besoin' && <p style={{color:C.yellow,fontSize:13,marginBottom:14}}>Cette pièce sera cachée pendant <strong>3 mois</strong>.</p>}
          {actionModal.type === 'commande_faite' && <p style={{color:C.green,fontSize:13,marginBottom:14}}>Si le stock ne bouge pas dans <strong>5 jours</strong>, la pièce réapparaîtra en statut ⚠️ Vérifié.</p>}
          <div style={{display:'flex',gap:10}}>
            <button onClick={()=>{setActionModal(null);setPieceAlt('')}} style={{flex:1,background:'none',border:`1px solid ${bdr}`,borderRadius:8,padding:'10px 0',cursor:'pointer',color:sub}}>Annuler</button>
            <button onClick={()=>faireAction(actionModal.item, actionModal.type, actionModal.type==='alternative'?{piece_alternative:pieceAlt}:{})}
              style={{flex:2,background:actionModal.type==='commande_faite'?C.green:actionModal.type==='pas_besoin'?C.red:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'10px 0',fontWeight:700,cursor:'pointer'}}>
              Confirmer
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Règles */}
    <div style={{background:dark?'#1a1a2e':'#f0f4ff',border:`1px solid ${dark?'#2a2a4a':'#c7d4f0'}`,borderRadius:10,padding:'10px 18px',marginBottom:12,display:'flex',gap:20,flexWrap:'wrap',alignItems:'center',justifyContent:'space-between'}}>
      <div style={{display:'flex',gap:16,flexWrap:'wrap',alignItems:'center'}}>
        <span style={{fontSize:12,fontWeight:700,color:dark?'#90cdf4':'#1a56db'}}>Règles :</span>
        <span style={{fontSize:12,color:sub}}>✅ ABC = A ou B</span>
        <span style={{fontSize:12,color:sub}}>✅ Besoin ≥ 3 unités</span>
        <span style={{fontSize:12,color:sub}}>✅ Stock &lt; besoin 4 sem.</span>
        <span style={{fontSize:12,color:sub}}>✅ Valeur ≥ 10$</span>
      </div>
      <span style={{fontSize:12,color:sub}}>👤 <strong style={{color:dark?'#e8e8e8':'#1a1a1a'}}>{employe}</strong></span>
    </div>

    {/* Onglets statut */}
    <div style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}>
      {[
        {id:'actif', label:`📋 À commander (${toutesLignes.filter(it=>!estCache(it.pk)&&!estVerifie(it.pk)).length})`, color:C.blue},
        {id:'attente', label:`⏳ En attente (${nbAttente})`, color:C.yellow},
        {id:'verifie', label:`⚠️ Vérifié (${nbVerifie})`, color:C.red},
        {id:'tout', label:`Tout (${toutesLignes.length})`, color:sub},
      ].map(t => (
        <button key={t.id} onClick={()=>setFiltreStatut(t.id)}
          style={{padding:'7px 14px',borderRadius:20,border:`2px solid ${filtreStatut===t.id?t.color:bdr}`,background:filtreStatut===t.id?(dark?'#1a1a2e':'#f0f4ff'):'transparent',color:filtreStatut===t.id?t.color:sub,fontSize:12,fontWeight:700,cursor:'pointer'}}>
          {t.label}
        </button>
      ))}
    </div>

    {/* Header */}
    <div style={{background:card,borderRadius:12,padding:isMobile?'10px 12px':'14px 18px',marginBottom:14,display:'flex',gap:10,flexWrap:'wrap',alignItems:'flex-end',border:`1px solid ${bdr}`}}>
      <div style={{flex:2,minWidth:isMobile?'100%':200}}>
        <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Fournisseur</div>
        <select value={filtFourn} onChange={e=>setFiltFourn(e.target.value)} style={S}>
          <option value="ALL">Tous ({fournisseurs.length})</option>
          {fournisseurs.map((f:string) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>
      {!isMobile && <div style={{flex:1,fontSize:13,color:sub,padding:'8px 0'}}>
        <div>📅 {dateStr}</div>
        <div style={{marginTop:4}}><strong style={{color:dark?'#e8e8e8':'#1a1a1a'}}>{suggestions.length}</strong> pièces</div>
      </div>}
      <div style={{background:dark?'#1a233a':'#e8f0fe',border:`2px solid ${C.blue}`,borderRadius:10,padding:'10px 14px',textAlign:'right',minWidth:isMobile?'100%':180,flex:isMobile?1:0}}>
        <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.blue,marginBottom:3}}>Total</div>
        <div style={{fontSize:isMobile?20:22,fontWeight:900,color:C.blue}}>{totalCommande.toLocaleString('fr-CA',{minimumFractionDigits:2})} $</div>
      </div>
    </div>

    {/* Liste */}
    {suggestions.length === 0
      ? <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,textAlign:'center',padding:60,color:sub}}>
          <div style={{fontSize:32,marginBottom:10}}>{filtreStatut==='attente'?'⏳':filtreStatut==='verifie'?'⚠️':'✅'}</div>
          <div style={{fontWeight:600,marginBottom:6}}>
            {filtreStatut==='attente'?'Aucune commande en attente':filtreStatut==='verifie'?'Aucune commande à vérifier':'Aucune commande nécessaire'}
          </div>
        </div>
      : isMobile
        ? <div style={{display:'flex',flexDirection:'column',gap:0}}>
            {Array.from(parFournisseur.entries()).map(([fourn, pieces]) => {
              const totalF = pieces.reduce((s:number,it:any)=>s+it.totalLigne,0)
              return (
                <div key={fourn} style={{marginBottom:16}}>
                  <div style={{background:dark?'#111':'#f4f6f8',padding:'10px 14px',borderRadius:'10px 10px 0 0',border:`1px solid ${bdr}`,borderBottom:'none',display:'flex',justifyContent:'space-between'}}>
                    <strong style={{fontSize:14}}>{fourn}</strong>
                    <strong style={{color:C.blue}}>{totalF.toLocaleString('fr-CA',{minimumFractionDigits:2})} $</strong>
                  </div>
                  {pieces.map((it:any) => {
                    const suivi = getSuivi(it.pk)
                    const estVerif = suivi?.statut === 'verifie'
                    const estCmd = suivi?.statut === 'commande_faite'
                    return (
                      <div key={it.pk} style={{background:estVerif?(dark?'#2b1a00':'#fff8e1'):estCmd?(dark?'#0d2a18':'#f0fff4'):card,border:`1px solid ${bdr}`,borderTop:'none',padding:'12px 14px'}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                          <div>
                            <div style={{fontWeight:800,fontSize:15}}>{it.pk}</div>
                            <div style={{fontSize:12,color:sub,marginTop:2}}>{it.desc}</div>
                            {suivi?.piece_alternative && <div style={{fontSize:11,color:C.green,marginTop:2}}>✅ Alt: {suivi.piece_alternative}</div>}
                            {!suivi?.piece_alternative && altsMap && altsMap.get(it.pk) && <div style={{fontSize:11,color:C.blue,marginTop:2}}>🔄 Alt: {(altsMap.get(it.pk)||[]).join(', ')}</div>}
                          </div>
                          <div style={{textAlign:'right'}}>
                            <div style={{fontSize:20,fontWeight:900,color:C.green,background:dark?'#0d2a18':'#e6f4ea',padding:'4px 10px',borderRadius:8}}>{it.qteACommander}</div>
                            <div style={{fontSize:12,color:sub,marginTop:2}}>{it.totalLigne.toFixed(2)} $</div>
                          </div>
                        </div>
                        <div style={{display:'flex',gap:8,fontSize:12,color:sub,marginBottom:10,flexWrap:'wrap'}}>
                          <span>Besoin: <strong style={{color:C.blue}}>{it.besoin4sem.toFixed(1)}</strong></span>
                          <span>Stock: <strong style={{color:it.stock<0?C.red:it.stock===0?C.yellow:'inherit'}}>{it.stock}</strong></span>
                          <span style={{color:C.red}}>{Math.round((Math.max(0,it.stock)/it.besoin4sem)*28)}j couv.</span>
                        </div>
                        <div style={{display:'flex',gap:6}}>
                          {estVerif
                            ? <span style={{background:C.red+'22',color:C.red,padding:'6px 10px',borderRadius:8,fontSize:12,fontWeight:700,flex:1,textAlign:'center'}}>⚠️ Non reçu</span>
                            : estCmd
                              ? <span style={{background:C.green+'22',color:C.green,padding:'6px 10px',borderRadius:8,fontSize:12,fontWeight:700,flex:1,textAlign:'center'}}>⏳ {suivi?.employe}</span>
                              : <>
                                  <button onClick={()=>setActionModal({item:it,type:'commande_faite'})} style={{flex:1,background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'10px 0',fontSize:13,fontWeight:700,cursor:'pointer'}}>✅ Commandé</button>
                                  <button onClick={()=>setActionModal({item:it,type:'pas_besoin'})} style={{flex:1,background:C.red,color:'#fff',border:'none',borderRadius:8,padding:'10px 0',fontSize:13,fontWeight:700,cursor:'pointer'}}>🚫 Pas besoin</button>
                                  <button onClick={()=>setActionModal({item:it,type:'alternative'})} style={{flex:1,background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'10px 0',fontSize:13,fontWeight:700,cursor:'pointer'}}>🔄 Alt.</button>
                                </>
                          }
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        : <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
            <thead><tr style={{background:thBg}}>
              <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center',width:50}}>ABC</th>
              <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,width:160}}>Code Pièce</th>
              <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`}}>Description</th>
              <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center',width:70}}>Ligne</th>
              <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`2px solid ${bdr}`,textAlign:'center',width:100}}>Besoin 4 sem.</th>
              <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center',width:80}}>Stock</th>
              <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`2px solid ${bdr}`,textAlign:'center',width:100}}>Couverture</th>
              <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'right',width:90}}>Coût Un.</th>
              <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.green,borderBottom:`2px solid ${bdr}`,textAlign:'center',width:100,background:dark?'#0d2a18':'#e6f4ea'}}>À COMMANDER</th>
              <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'right',width:100}}>Total $</th>
              <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center',width:200}}>Action</th>
            </tr></thead>
            <tbody>
              {Array.from(parFournisseur.entries()).map(([fourn, pieces]) => {
                const totalF = pieces.reduce((s:number,it:any)=>s+it.totalLigne,0)
                return [
                  // Ligne séparatrice fournisseur
                  <tr key={`h-${fourn}`} style={{background:dark?'#111':'#f4f6f8'}}>
                    <td colSpan={8} style={{padding:'10px 18px',borderBottom:`1px solid ${bdr}`,borderTop:`2px solid ${bdr}`}}>
                      <strong style={{fontSize:14}}>{fourn}</strong>
                      <span style={{marginLeft:10,fontSize:12,color:sub}}>{pieces.length} pièce{pieces.length>1?'s':''}</span>
                    </td>
                    <td colSpan={3} style={{padding:'10px 18px',borderBottom:`1px solid ${bdr}`,borderTop:`2px solid ${bdr}`,textAlign:'right'}}>
                      <strong style={{color:C.blue}}>{totalF.toLocaleString('fr-CA',{minimumFractionDigits:2})} $</strong>
                    </td>
                  </tr>,
                  // Lignes pièces
                  ...pieces.map((it:any) => {
                    const suivi = getSuivi(it.pk)
                    const estVerif = suivi?.statut === 'verifie'
                    const estCmd = suivi?.statut === 'commande_faite'
                    return (
                      <tr key={it.pk} style={{background:estVerif?(dark?'#2b1a00':'#fff8e1'):estCmd?(dark?'#0d2a18':'#f0fff4'):'transparent'}}
                        onMouseEnter={e=>e.currentTarget.style.background=estVerif?(dark?'#3a2400':'#fff3cd'):estCmd?(dark?'#0f3020':'#e6f4ea'):hvr}
                        onMouseLeave={e=>e.currentTarget.style.background=estVerif?(dark?'#2b1a00':'#fff8e1'):estCmd?(dark?'#0d2a18':'#f0fff4'):'transparent'}>
                        <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                          <span style={{background:it.classeABC==='A'?C.green:C.yellow,color:'#fff',padding:'3px 6px',borderRadius:4,fontSize:11,fontWeight:700}}>{it.classeABC}</span>
                        </td>
                        <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>
                          {it.pk}
                          {suivi?.piece_alternative && <div style={{fontSize:10,color:C.green,marginTop:2}}>✅ Alt: {suivi.piece_alternative}</div>}
                          {!suivi?.piece_alternative && altsMap && altsMap.get(it.pk) && <div style={{fontSize:10,color:C.blue,marginTop:2}}>🔄 Alt: {(altsMap.get(it.pk)||[]).join(', ')}</div>}
                        </td>
                        <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:sub}} title={it.desc}>{it.desc}</td>
                        <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                          <span style={{background:dark?'#333':'#e2e8f0',color:dark?'#ccc':'#475569',padding:'2px 8px',borderRadius:4,fontSize:12,fontWeight:600}}>{it.ligne}</span>
                        </td>
                        <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.blue,fontWeight:700}}>{it.besoin4sem.toFixed(1)}</td>
                        <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:it.stock<0?C.red:it.stock===0?C.yellow:'inherit',fontWeight:700}}>{it.stock}</td>
                        <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                          {it.besoin4sem>0?<span style={{background:C.red+'22',color:C.red,padding:'2px 8px',borderRadius:20,fontSize:12,fontWeight:700}}>{Math.round((Math.max(0,it.stock)/it.besoin4sem)*28)} j</span>:'—'}
                        </td>
                        <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{it.cost.toFixed(2)} $</td>
                        <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',background:dark?'#0d2a18':'#e6f4ea',color:C.green,fontSize:17,fontWeight:900}}>{it.qteACommander}</td>
                        <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700}}>{it.totalLigne.toFixed(2)} $</td>
                        <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                          {estVerif
                            ? <span style={{background:C.red+'22',color:C.red,padding:'4px 8px',borderRadius:6,fontSize:11,fontWeight:700}}>⚠️ Non reçu</span>
                            : estCmd
                              ? <span style={{background:C.green+'22',color:C.green,padding:'4px 8px',borderRadius:6,fontSize:11,fontWeight:700}}>⏳ {suivi?.employe}</span>
                              : <div style={{display:'flex',gap:4,justifyContent:'center',flexWrap:'wrap'}}>
                                  <button onClick={()=>setActionModal({item:it,type:'commande_faite'})} style={{background:C.green,color:'#fff',border:'none',borderRadius:6,padding:'5px 8px',fontSize:11,fontWeight:700,cursor:'pointer'}}>✅ Commandé</button>
                                  <button onClick={()=>setActionModal({item:it,type:'pas_besoin'})} style={{background:C.red,color:'#fff',border:'none',borderRadius:6,padding:'5px 8px',fontSize:11,fontWeight:700,cursor:'pointer'}}>🚫 Pas besoin</button>
                                  <button onClick={()=>setActionModal({item:it,type:'alternative'})} style={{background:C.blue,color:'#fff',border:'none',borderRadius:6,padding:'5px 8px',fontSize:11,fontWeight:700,cursor:'pointer'}}>🔄 Alternatif</button>
                                </div>
                          }
                        </td>
                      </tr>
                    )
                  })
                ]
              })}
            </tbody>
          </table>
        </div>
    }

    {/* ── Section Fournitures / Suggestions ──────────────────── */}
    {(fournituresData?.demandes||[]).filter((d:any)=>d.statut==='en_attente').length > 0 && (
      <div style={{marginTop:20}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
          <span style={{fontSize:16}}>🔧</span>
          <h3 style={{margin:0,fontSize:15,fontWeight:700}}>Suggestions de commande</h3>
          <span style={{background:C.blue+'22',color:C.blue,borderRadius:20,padding:'2px 10px',fontSize:12,fontWeight:700}}>{(fournituresData?.demandes||[]).filter((d:any)=>d.statut==='en_attente').length}</span>
        </div>
        <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
            <thead><tr style={{background:thBg}}>
              <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Employé</th>
              <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>SKU</th>
              <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Description</th>
              <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Fournisseur</th>
              <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Qté</th>
              <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Lien</th>
              <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Action</th>
            </tr></thead>
            <tbody>
              {(fournituresData?.demandes||[]).filter((d:any)=>d.statut==='en_attente').sort((a:any,b:any) => {
                const order = (c:string) => c==='Commande Fournisseur'?0:1
                return order(a.categorie) - order(b.categorie)
              }).map((d:any) => {
                const isCmd = d.categorie==='Commande Fournisseur'
                return (
                <tr key={d.id} style={{background:isCmd?(dark?'#2b1113':'#fff0f0'):undefined,borderLeft:isCmd?`4px solid ${C.red}`:'none'}}
                  onMouseEnter={e=>e.currentTarget.style.background=isCmd?(dark?'#3a1518':'#ffe5e5'):hvr} onMouseLeave={e=>e.currentTarget.style.background=isCmd?(dark?'#2b1113':'#fff0f0'):'transparent'}>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontWeight:600}}>{d.employe}</td>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:12}}>{d.sku||'—'}</td>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,maxWidth:280,fontWeight:isCmd?800:400,color:isCmd?C.red:undefined}}>
                    {(() => {
                      const noteText = (d.note||'').split('|||')[0]
                      return (
                        <>
                          <div style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={d.description}>
                            {isCmd ? `🚩 ${d.fournisseur}` : d.description}
                          </div>
                          {noteText && !isCmd && (
                            <div style={{fontSize:11,color:C.blue,fontStyle:'italic',marginTop:3,fontWeight:600,whiteSpace:'pre-wrap',wordBreak:'break-word',lineHeight:1.4}} title={noteText}>
                              💬 {noteText}
                            </div>
                          )}
                        </>
                      )
                    })()}
                  </td>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,color:isCmd?C.red:sub,fontSize:12,fontWeight:isCmd?700:400}}>{d.fournisseur||'—'}</td>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700}}>{isCmd?'—':d.quantite}</td>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                    {(()=>{const u=(d.note||'').split('|||')[1];return u?<a href={u} target="_blank" rel="noreferrer" style={{background:C.blue,color:'#fff',padding:'5px 10px',borderRadius:6,fontSize:11,fontWeight:700,textDecoration:'none',display:'inline-block'}}>🔗 Ouvrir</a>:<span style={{color:sub,fontSize:11}}>—</span>})()}
                  </td>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                    <div style={{display:'flex',gap:6,justifyContent:'center'}}>
                      <button onClick={async()=>{await fetch('/api/fournitures',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:d.id,statut:'traitée'})});const r=await fetch('/api/fournitures');if(r.ok&&setFournituresData)setFournituresData(await r.json())}}
                        style={{background:C.green,color:'#fff',border:'none',borderRadius:6,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>{isCmd?'✅ Fait':'✅ Commandé'}</button>
                      <button onClick={async()=>{await fetch('/api/fournitures',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:d.id,statut:'annulée'})});const r=await fetch('/api/fournitures');if(r.ok&&setFournituresData)setFournituresData(await r.json())}}
                        style={{background:C.red+'22',color:C.red,border:'none',borderRadius:6,padding:'5px 8px',fontSize:11,fontWeight:700,cursor:'pointer'}}>✕</button>
                    </div>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )}
  </>
}




// ── Suggestions de Commande Tab ──────────────────────────────────────────────
function FournituresTab({fournituresData, setFournituresData, dark, card, bdr, sub, thBg, S, C, hvr, data, profil}: any) {
  const employe = profil?.nom || profil?.email || 'Inconnu'
  const [sku, setSku] = useState('')
  const [qte, setQte] = useState(1)
  const [note, setNote] = useState('')
  const [urlPiece, setUrlPiece] = useState('')
  const [statutSugg, setStatutSugg] = useState('Restock')
  const [skuInfo, setSkuInfo] = useState<any>(null)
  const [skuErreur, setSkuErreur] = useState('')
  const [loading, setLoading] = useState(false)
  const [msgOk, setMsgOk] = useState('')
  const [rapportEmploye, setRapportEmploye] = useState('ALL')
  const [fournCmd, setFournCmd] = useState('')
  const [fournLoading, setFournLoading] = useState(false)
  const [pieceExiste, setPieceExiste] = useState<boolean|null>(null)
  const [numReference, setNumReference] = useState('')
  const [descNouvelle, setDescNouvelle] = useState('')

  const demandes: any[] = fournituresData?.demandes || []
  const allItems: any[] = data?.liste_complete || []

  // Trouver une pièce dans le cache Traction
  function chercherSku(s: string) {
    const norm = (x:string) => x.trim().toLowerCase().replace(/\s+/g,'')
    return allItems.find((it:any) => norm(it.pk) === norm(s))
  }

  // Calculer besoin 2 mois basé sur historique
  function calculerBesoin2Mois(item: any): number {
    if (!item?.ventesMoyParMois) return 0
    const aujourd = new Date()
    const m1 = aujourd.getMonth()
    const m2 = (m1 + 1) % 12
    return (item.ventesMoyParMois[m1] || 0) + (item.ventesMoyParMois[m2] || 0)
  }

  async function onSkuChange(val: string) {
    setSku(val)
    setSkuErreur('')
    setSkuInfo(null)
    if (val.trim().length >= 3) {
      // D'abord chercher dans le cache local
      const found = chercherSku(val.trim())
      if (found) {
        setSkuInfo(found)
        const besoin = calculerBesoin2Mois(found)
        if (besoin > 0) setQte(Math.ceil(besoin))
      } else {
        // Sinon chercher dans Traction via API
        try {
          const r = await fetch('/api/sku-lookup?sku=' + encodeURIComponent(val.trim()))
          const j = await r.json()
          if (j.found) {
            setSkuInfo({ pk: j.pk, desc: j.desc, fournisseur: j.fournisseur, stock: j.stock, cost: j.cost, ligne: j.ligne, classeABC: '—', ventesMoyParMois: null })
          }
        } catch {}
      }
    }
  }

  async function soumettre(e: any) {
    e.preventDefault()
    if (pieceExiste === null) return
    if (pieceExiste && !sku.trim()) return
    if (!pieceExiste && (!urlPiece.trim() || !numReference.trim() || !descNouvelle.trim())) return
    setLoading(true)
    await fetch('/api/fournitures', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        employe,
        sku: pieceExiste ? sku.trim() : (numReference.trim() || null),
        description: pieceExiste ? (skuInfo?.desc || sku.trim()) : descNouvelle.trim(),
        fournisseur: skuInfo?.fournisseur || '',
        categorie: statutSugg,
        quantite: qte,
        unite: 'unité',
        note: pieceExiste ? note : `Réf: ${numReference.trim()}${note ? ' — ' + note : ''}`,
        url: urlPiece.trim() || null
      })
    })
    setSku(''); setQte(1); setNote(''); setUrlPiece(''); setSkuInfo(null); setStatutSugg('Restock')
    setPieceExiste(null); setNumReference(''); setDescNouvelle('')
    await recharger()
    setMsgOk(`✅ Suggestion envoyée dans Commandes du Jour!`)
    setTimeout(() => setMsgOk(''), 4000)
    setLoading(false)
  }

  async function recharger() {
    const r = await fetch('/api/fournitures')
    if (r.ok) setFournituresData(await r.json())
  }

  async function annuler(id: number) {
    await fetch('/api/fournitures', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, statut: 'annulée' }) })
    await recharger()
  }

  // Fournisseurs disponibles depuis les données Traction
  const fournisseursList = Array.from(new Set((data?.liste_complete||[]).map((it:any) => it.fournisseur).filter(Boolean))).sort() as string[]

  async function soumettreCommFourn(e: any) {
    e.preventDefault()
    if (!fournCmd.trim()) return
    setFournLoading(true)
    await fetch('/api/fournitures', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        employe,
        sku: null,
        description: `Commande fournisseur: ${fournCmd.trim()}`,
        fournisseur: fournCmd.trim(),
        categorie: 'Commande Fournisseur',
        quantite: 1,
        unite: 'commande',
        note: null,
        url: null
      })
    })
    setFournCmd('')
    await recharger()
    setMsgOk(`✅ Commande fournisseur "${fournCmd.trim()}" envoyée!`)
    setTimeout(() => setMsgOk(''), 4000)
    setFournLoading(false)
  }

  const employes = Array.from(new Set(demandes.map((d:any) => d.employe))).sort() as string[]
  const demandesFiltrees = demandes.filter((d:any) => rapportEmploye === 'ALL' || d.employe === rapportEmploye)
  const besoin2mois = skuInfo ? calculerBesoin2Mois(skuInfo) : 0

  return <>


    <div style={{maxWidth:900,margin:'0 auto'}}>

      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20,flexWrap:'wrap',gap:10}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:800}}>💡 Suggestions de Commande</h2>
          <p style={{color:sub,fontSize:13,margin:'4px 0 0'}}>Entre un SKU pour suggérer une commande à la réception</p>
        </div>
        <div style={{background:dark?'#1a1a2e':'#f0f4ff',border:`1px solid ${C.blue}33`,borderRadius:20,padding:'7px 16px',fontSize:13}}>
          👤 <strong>{employe}</strong>
        </div>
      </div>

      {/* Message succès */}
      {msgOk && <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`1px solid ${C.green}`,borderRadius:10,padding:'12px 16px',marginBottom:16,color:C.green,fontWeight:700}}>{msgOk}</div>}

      {/* Commande rapide fournisseur */}
      <div style={{background:dark?'#1a1a2e':'#fff8f0',borderRadius:14,border:`2px solid ${C.yellow}`,padding:'20px 24px',marginBottom:20}}>
        <div style={{fontSize:15,fontWeight:800,marginBottom:12}}>🚨 Demande urgente — passer commande de ce fournisseur</div>
        <form onSubmit={soumettreCommFourn} style={{display:'flex',gap:10,alignItems:'flex-end',flexWrap:'wrap'}}>
          <div style={{flex:1,minWidth:200}}>
            <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:6}}>Fournisseur *</label>
            <input list="fournisseurs-list" value={fournCmd} onChange={e=>setFournCmd(e.target.value)} placeholder="Nom du fournisseur..."
              required style={{width:'100%',padding:'10px 12px',border:`1px solid ${bdr}`,borderRadius:8,fontSize:14,fontWeight:600,
              background:dark?'#222':'#fff',color:dark?'#e8e8e8':'#1a1a1a',outline:'none',boxSizing:'border-box' as const}}/>
            <datalist id="fournisseurs-list">
              {fournisseursList.map((f:string) => <option key={f} value={f}/>)}
            </datalist>
          </div>
          <button type="submit" disabled={fournLoading||!fournCmd.trim()}
            style={{background:C.yellow,color:'#000',border:'none',borderRadius:10,padding:'10px 20px',fontSize:14,fontWeight:800,cursor:fournCmd.trim()?'pointer':'not-allowed',opacity:fournCmd.trim()?1:0.6,whiteSpace:'nowrap'}}>
            {fournLoading ? 'Envoi...' : '🚚 Envoyer'}
          </button>
        </form>
      </div>

      {/* Formulaire suggestion pièce */}
      <div style={{background:card,borderRadius:14,border:`1px solid ${bdr}`,padding:'24px 28px',marginBottom:20}}>
        <form onSubmit={soumettre}>
          {/* Étape 1 : La pièce existe-t-elle ? */}
          <div style={{marginBottom:16}}>
            <label style={{fontSize:13,fontWeight:800,display:'block',marginBottom:10}}>La pièce existe-t-elle dans le système ?</label>
            <div style={{display:'flex',gap:10}}>
              <button type="button" onClick={()=>{setPieceExiste(true);setSku('');setSkuInfo(null);setUrlPiece('');setNumReference('');setDescNouvelle('')}}
                style={{flex:1,padding:'12px 0',borderRadius:10,fontSize:15,fontWeight:700,cursor:'pointer',
                  background:pieceExiste===true?C.green:dark?'#222':'#f8f9fa',
                  color:pieceExiste===true?'#fff':dark?'#ccc':'#555',
                  border:`2px solid ${pieceExiste===true?C.green:bdr}`}}>
                ✅ Oui
              </button>
              <button type="button" onClick={()=>{setPieceExiste(false);setSku('');setSkuInfo(null);setUrlPiece('');setNumReference('');setDescNouvelle('');setStatutSugg('Restock')}}
                style={{flex:1,padding:'12px 0',borderRadius:10,fontSize:15,fontWeight:700,cursor:'pointer',
                  background:pieceExiste===false?C.red:dark?'#222':'#f8f9fa',
                  color:pieceExiste===false?'#fff':dark?'#ccc':'#555',
                  border:`2px solid ${pieceExiste===false?C.red:bdr}`}}>
                ❌ Non (nouvelle pièce)
              </button>
            </div>
          </div>

          {/* === PIÈCE EXISTANTE === */}
          {pieceExiste === true && <>
            {/* SKU */}
            <div style={{marginBottom:16}}>
              <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:6}}>Numéro de pièce (SKU) *</label>
              <input value={sku} onChange={e=>onSkuChange(e.target.value)} placeholder="Ex: 83-6016, VR6320, 782-1131..." required
                style={{...S,fontSize:15,fontWeight:sku?700:400,border:`2px solid ${skuInfo?C.green:skuErreur?C.red:bdr}`}}/>
            </div>

            {/* Info pièce trouvée */}
            {skuInfo && (
              <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`1px solid ${C.green}33`,borderRadius:10,padding:'12px 16px',marginBottom:16}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:8}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:14,color:C.green,marginBottom:3}}>✅ Pièce trouvée</div>
                    <div style={{fontWeight:600,fontSize:15}}>{skuInfo.desc}</div>
                    <div style={{fontSize:12,color:sub,marginTop:3}}>
                      <span style={{marginRight:12}}>🏢 {skuInfo.fournisseur}</span>
                      <span style={{marginRight:12}}>📦 Stock actuel: <strong>{skuInfo.stock}</strong></span>
                      <span style={{background:skuInfo.classeABC==='A'?C.green:skuInfo.classeABC==='B'?C.yellow:sub,color:'#fff',padding:'1px 6px',borderRadius:4,fontSize:11}}>{skuInfo.classeABC}</span>
                    </div>
                  </div>
                  {besoin2mois > 0 && (
                    <div style={{background:dark?'#1a233a':'#dbeafe',border:`1px solid ${C.blue}33`,borderRadius:8,padding:'8px 14px',textAlign:'center'}}>
                      <div style={{fontSize:11,color:C.blue,fontWeight:700,textTransform:'uppercase'}}>Besoin 2 mois</div>
                      <div style={{fontSize:22,fontWeight:900,color:C.blue}}>{besoin2mois.toFixed(1)}</div>
                      <div style={{fontSize:10,color:sub}}>basé sur historique</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {skuErreur && <div style={{color:C.red,fontSize:12,marginBottom:12}}>⚠️ {skuErreur}</div>}
          </>}

          {/* === NOUVELLE PIÈCE === */}
          {pieceExiste === false && <>
            <div style={{background:dark?'#2b2411':'#fef7e0',border:`1px solid ${C.yellow}`,borderRadius:10,padding:'12px 16px',marginBottom:16,fontSize:12,color:dark?'#e8c547':'#92400e'}}>
              ⚠️ <strong>Seule la réception/expédition peut créer un nouveau fournisseur.</strong> Remplissez les informations ci-dessous et la réception s'en chargera.
            </div>

            {/* Description */}
            <div style={{marginBottom:16}}>
              <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:6}}>Description de la pièce *</label>
              <input value={descNouvelle} onChange={e=>setDescNouvelle(e.target.value)} placeholder="Ex: Courroie alternateur Honda Civic 2020..."
                required style={{...S,fontSize:14,fontWeight:600}}/>
            </div>

            {/* Numéro facture / BT */}
            <div style={{marginBottom:16}}>
              <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:6}}>N° facture ou bon de travail *</label>
              <input value={numReference} onChange={e=>setNumReference(e.target.value)} placeholder="Ex: FAC-12345, BT-6789..."
                required style={{...S,fontSize:14,fontWeight:600,border:`2px solid ${numReference.trim()?C.green:bdr}`}}/>
            </div>

            {/* URL obligatoire */}
            <div style={{marginBottom:16}}>
              <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.red,display:'block',marginBottom:6}}>🔗 Lien vers la pièce (obligatoire) *</label>
              <input value={urlPiece} onChange={e=>setUrlPiece(e.target.value)} placeholder="https://www.fournisseur.com/piece-xyz..."
                type="url" inputMode="url" required
                style={{...S,fontSize:14,color:urlPiece?C.blue:'inherit',border:`2px solid ${urlPiece.trim()?C.green:C.red}`}}/>
            </div>
          </>}

          {/* === CHAMPS COMMUNS (visibles dans les 2 cas) === */}
          {pieceExiste !== null && <>
            {/* Quantité + Note */}
            <div style={{display:'grid',gridTemplateColumns:'160px 1fr',gap:12,marginBottom:16}}>
              <div>
                <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:6}}>
                  Quantité demandée
                  {pieceExiste && besoin2mois > 0 && <span style={{color:C.blue,fontWeight:400,marginLeft:6,textTransform:'none'}}>({besoin2mois.toFixed(0)} suggérée)</span>}
                </label>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <button type="button" onClick={()=>setQte(q=>Math.max(1,q-1))} style={{width:34,height:34,borderRadius:8,border:`1px solid ${bdr}`,background:'none',cursor:'pointer',fontSize:18,fontWeight:700,color:sub}}>−</button>
                  <input type="number" value={qte} onChange={e=>setQte(Math.max(1,Number(e.target.value)))} min={1} style={{...S,textAlign:'center',width:60,fontWeight:700,fontSize:16}}/>
                  <button type="button" onClick={()=>setQte(q=>q+1)} style={{width:34,height:34,borderRadius:8,border:`1px solid ${bdr}`,background:C.blue,cursor:'pointer',fontSize:18,fontWeight:700,color:'#fff'}}>+</button>
                </div>
              </div>
              <div>
                <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:6}}>Note (optionnel)</label>
                <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Ex: Pour le client X..." style={S}/>
              </div>
            </div>

            {/* URL (optionnel si pièce existante) */}
            {pieceExiste && (
              <div style={{marginBottom:16}}>
                <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:6}}>🔗 Lien vers la pièce (optionnel)</label>
                <input value={urlPiece} onChange={e=>setUrlPiece(e.target.value)} placeholder="https://www.fournisseur.com/piece-xyz..."
                  type="url" inputMode="url"
                  style={{...S,fontSize:14,color:urlPiece?C.blue:'inherit'}}/>
              </div>
            )}

            <button type="submit" disabled={loading || (pieceExiste && !sku.trim()) || (!pieceExiste && (!urlPiece.trim() || !numReference.trim() || !descNouvelle.trim()))}
              style={{width:'100%',background:C.blue,color:'#fff',border:'none',borderRadius:10,padding:'13px 0',fontSize:15,fontWeight:700,cursor:'pointer',opacity: (pieceExiste && !sku.trim()) || (!pieceExiste && (!urlPiece.trim() || !numReference.trim() || !descNouvelle.trim())) ? 0.5 : 1}}>
              {loading ? 'Envoi...' : '💡 Envoyer la suggestion → Commandes du Jour'}
            </button>
          </>}
        </form>
      </div>

      {/* Rapport par employé */}
      <div style={{background:card,borderRadius:14,border:`1px solid ${bdr}`,padding:'20px 24px'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,flexWrap:'wrap',gap:10}}>
          <h3 style={{margin:0,fontSize:16,fontWeight:700}}>📊 Registre des suggestions</h3>
          <select value={rapportEmploye} onChange={e=>setRapportEmploye(e.target.value)} style={{...S,minWidth:180}}>
            <option value="ALL">Tous les employés ({demandes.length})</option>
            {employes.map((emp:string) => {
              const n = demandes.filter((d:any)=>d.employe===emp).length
              return <option key={emp} value={emp}>{emp} ({n})</option>
            })}
          </select>
        </div>

        {demandesFiltrees.length === 0
          ? <div style={{textAlign:'center',padding:40,color:sub}}>
              <div style={{fontSize:32,marginBottom:8}}>📋</div>
              <p>Aucune suggestion pour le moment</p>
            </div>
          : <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                <thead><tr style={{background:thBg}}>
                  <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Employé</th>
                  <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>SKU</th>
                  <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Description</th>
                  <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Fournisseur</th>
                  <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Qté</th>
                  <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Lien</th>
                  <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Statut</th>
                  <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Date</th>
                  <th style={{padding:'9px',borderBottom:`2px solid ${bdr}`}}></th>
                </tr></thead>
                <tbody>
                  {demandesFiltrees.map((d:any) => (
                    <tr key={d.id} style={{opacity:d.statut==='annulée'?0.5:1}} onMouseEnter={e=>e.currentTarget.style.background=hvr} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontWeight:600}}>{d.employe}</td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:12}}>{d.sku||'—'}</td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={d.description}>{d.description}</td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:12}}>{d.fournisseur||'—'}</td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700}}>{d.quantite}</td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                        {(()=>{const u=(d.note||'').split('|||')[1];return u?<a href={u} target="_blank" rel="noreferrer" style={{color:C.blue,fontSize:12,fontWeight:700,textDecoration:'none'}}>🔗 Voir</a>:<span style={{color:sub,fontSize:11}}>—</span>})()}
                      </td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                        <span style={{background:d.statut==='en_attente'?C.yellow+'22':d.statut==='annulée'?C.red+'22':C.green+'22',color:d.statut==='en_attente'?C.yellow:d.statut==='annulée'?C.red:C.green,padding:'3px 8px',borderRadius:20,fontSize:11,fontWeight:700}}>
                          {d.statut==='en_attente'?'⏳ En attente':d.statut==='annulée'?'✕ Annulée':'✅ Commandé'}
                        </span>
                      </td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:12}}>{new Date(d.date_demande).toLocaleDateString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`}}>
                        {d.statut==='en_attente' && <button onClick={()=>annuler(d.id)} style={{background:C.red+'22',color:C.red,border:'none',borderRadius:6,padding:'4px 8px',fontSize:11,cursor:'pointer',fontWeight:700}}>Annuler</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        }
      </div>
    </div>
  </>
}

// ── Inventaire Cyclique Tab ───────────────────────────────────────────────────
function InventaireTab({dark, card, bdr, sub, thBg, S, C, hvr, profil, validationsCompta, retoursActifs, setRetoursActifs}: any) {
  const employe = profil?.nom || profil?.email || 'Inconnu'
  const [sousOnglet, setSousOnglet] = useState<'compter'|'suivi'>('compter')

  async function marquerRetourCorrigeCompt(retourId: number) {
    try {
      await fetch('/api/comptabilite/retours', {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ id: retourId, action: 'corrige', user_email: employe })
      })
      const r = await fetch('/api/comptabilite/retours?actifs=1')
      const j = await r.json()
      if (Array.isArray(j) && setRetoursActifs) setRetoursActifs(j)
    } catch (e: any) { alert(e.message) }
  }

  // ── Édition d'un comptage retourné par la compta ───────────────────────────
  const [editComptage, setEditComptage] = useState<any>(null)        // ligne inventaire_comptages chargée
  const [editRetourId, setEditRetourId] = useState<number|null>(null) // id du retour comptabilité associé
  const [editForm, setEditForm] = useState<{localisation:string, qte_comptee:string, note:string}>({localisation:'',qte_comptee:'',note:''})
  const [editPhotoFile, setEditPhotoFile] = useState<File|null>(null)
  const [editPhotoPreview, setEditPhotoPreview] = useState<string|null>(null)
  const [editPhotoSupprimee, setEditPhotoSupprimee] = useState(false)
  const [editLoading, setEditLoading] = useState(false)
  const editPhotoRef = useRef<HTMLInputElement>(null)

  async function ouvrirEditComptage(retour: any) {
    try {
      const r = await fetch('/api/inventaire/comptages?id=' + encodeURIComponent(String(retour.ref_id)))
      const c = await r.json()
      if (!c || c.erreur) { alert('Comptage introuvable'); return }
      setEditComptage(c)
      setEditRetourId(retour.id)
      setEditForm({
        localisation: c.localisation || '',
        qte_comptee: String(c.qte_comptee ?? ''),
        note: c.note || '',
      })
      setEditPhotoFile(null)
      setEditPhotoPreview(null)
      setEditPhotoSupprimee(false)
    } catch (e: any) { alert(e.message) }
  }

  function fermerEditComptage() {
    setEditComptage(null); setEditRetourId(null)
    setEditForm({localisation:'',qte_comptee:'',note:''})
    setEditPhotoFile(null); setEditPhotoPreview(null); setEditPhotoSupprimee(false)
  }

  function onEditPhotoChange(e: any) {
    const f = e.target.files?.[0]
    if (!f) return
    setEditPhotoFile(f)
    setEditPhotoSupprimee(false)
    const reader = new FileReader()
    reader.onload = ev => setEditPhotoPreview(ev.target?.result as string)
    reader.readAsDataURL(f)
    e.target.value = ''
  }

  async function sauverEditComptage() {
    if (!editComptage || editForm.qte_comptee === '') return
    setEditLoading(true)
    try {
      // Upload nouvelle photo si fournie
      let photoUrl: string | null | undefined = undefined
      if (editPhotoFile) {
        const fd = new FormData()
        fd.append('file', editPhotoFile)
        fd.append('code_piece', editComptage.code_piece)
        fd.append('localisation', editForm.localisation || editComptage.localisation || '')
        const r = await fetch('/api/inventaire/photo', { method: 'POST', body: fd })
        const j = await r.json()
        if (j.url) photoUrl = j.url
      } else if (editPhotoSupprimee) {
        photoUrl = null
      }

      const body: any = {
        id: editComptage.id,
        localisation: editForm.localisation.trim().toUpperCase() || editComptage.localisation,
        qte_comptee: Number(editForm.qte_comptee),
        note: editForm.note || null,
      }
      if (photoUrl !== undefined) body.photo_url = photoUrl

      const r = await fetch('/api/inventaire/comptages', {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body)
      })
      const j = await r.json()
      if (j.erreur) { alert(j.erreur); setEditLoading(false); return }

      // Marquer le retour comme corrigé
      if (editRetourId) await marquerRetourCorrigeCompt(editRetourId)

      fermerEditComptage()
    } catch (e: any) { alert(e.message) }
    finally { setEditLoading(false) }
  }
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Import
  const [importFile, setImportFile] = useState<File|null>(null)
  const [importStatus, setImportStatus] = useState('')
  const [importLoading, setImportLoading] = useState(false)

  // État session
  const [etape, setEtape] = useState<'localisation'|'piece'|'quantite'|'photo'>('localisation')
  const [locInput, setLocInput] = useState('')
  const [pieceInput, setPieceInput] = useState('')
  const [qteInput, setQteInput] = useState('')
  const [locActive, setLocActive] = useState<string|null>(null)
  const [piecesLoc, setPiecesLoc] = useState<any[]>([])
  const [stockMap, setStockMap] = useState<Map<string,{stock:number,reserve:number}>>(new Map())
  const [pieceActive, setPieceActive] = useState<any>(null)
  const [modeRapide, setModeRapide] = useState(false)
  const [erreur, setErreur] = useState('')
  const [comptesDuJour, setComptesDuJour] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [dernierComptage, setDernierComptage] = useState<any>(null)
  const [showCreerLoc, setShowCreerLoc] = useState(false)
  const [locInconnue, setLocInconnue] = useState('')
  const [pieceAjoutable, setPieceAjoutable] = useState<any>(null)
  const [multiLocInfo, setMultiLocInfo] = useState<{locs: string[], dejaComptee?: {loc: string, employe: string, qte: number}} | null>(null)
  const [pieceDejaComptee, setPieceDejaComptee] = useState<any>(null)
  const [photoFile, setPhotoFile] = useState<File|null>(null)
  const [photoPreview, setPhotoPreview] = useState<string|null>(null)
  const [pendingComptage, setPendingComptage] = useState<any>(null)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)

  // Progression
  const [locsStats, setLocsStats] = useState<any[]>([])
  const [loadingProg, setLoadingProg] = useState(false)

  // Rapport
  const [comptages, setComptages] = useState<any[]>([])
  const [filtDate, setFiltDate] = useState(new Date().toISOString().split('T')[0])
  const [filtEmploye, setFiltEmploye] = useState('ALL')
  const [filtEcart, setFiltEcart] = useState('ALL')

  const locRef = useRef<HTMLInputElement>(null)
  const pieceRef = useRef<HTMLInputElement>(null)
  const qteRef = useRef<HTMLInputElement>(null)
  const photoRef = useRef<HTMLInputElement>(null)
  const locScanRef = useRef<HTMLInputElement>(null)
  const pieceScanRef2 = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [scanModal, setScanModal] = useState<'loc'|'piece'|null>(null)
  const [scanLog, setScanLog] = useState('')
  const scanIntervalRef = useRef<any>(null)
  const streamRef = useRef<MediaStream|null>(null)
  const pieceScanRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (sousOnglet === 'suivi') { chargerComptages(); chargerProgression() }
  }, [sousOnglet])

  // Reprendre la localisation sauvegardée
  useEffect(() => {
    try {
      const savedLoc = localStorage.getItem('inv_loc_active')
      if (savedLoc) {
        setLocInput(savedLoc)
        setErreur('')
        // Proposer de reprendre
        setShowReprendreMsg(true)
      }
    } catch {}
  }, [])

  const [showReprendreMsg, setShowReprendreMsg] = useState(false)
  const [sessionActive, setSessionActive] = useState<any>(null)

  async function chargerProgression() {
    setLoadingProg(true)
    try {
      // 1. Charger tous les comptages
      const rCompt = await fetch('/api/inventaire/comptages?all=1')
      const comptages: any[] = rCompt.ok ? await rCompt.json() : []

      // 2. Trouver les localisations uniques dans les comptages
      const locsUniques = Array.from(new Set(
        comptages.map((c:any) => (c.localisation||'').trim().toUpperCase()).filter(Boolean)
      ))

      if (locsUniques.length === 0) { setLocsStats([]); return }

      // 3. Pour chaque localisation, charger ses pièces depuis inventaire_localisations
      const mapPiecesLoc = new Map<string, Set<string>>()
      await Promise.all(locsUniques.map(async (loc) => {
        try {
          const r = await fetch('/api/inventaire/localisations?loc=' + encodeURIComponent(loc))
          if (!r.ok) return
          const pieces: any[] = await r.json()
          const set = new Set<string>()
          for (const p of pieces) {
            const pk = (p.code_piece||'').trim()
            if (pk && !pk.startsWith('LOC_')) set.add(pk)
          }
          mapPiecesLoc.set(loc, set)
        } catch {}
      }))

      // 4. Grouper comptages par localisation → par employé
      const mapLoc = new Map<string, Map<string, Set<string>>>()
      const mapDates = new Map<string, {piece:string, date:string}>()
      for (const c of comptages) {
        const locKey = (c.localisation||'').trim().toUpperCase()
        if (!locKey) continue
        if (!mapLoc.has(locKey)) mapLoc.set(locKey, new Map())
        const byEmp = mapLoc.get(locKey)!
        if (!byEmp.has(c.employe)) byEmp.set(c.employe, new Set())
        byEmp.get(c.employe)!.add((c.code_piece||'').trim())
        // Garder la dernière date par employe+loc
        const dk = locKey+'|'+c.employe
        const existing = mapDates.get(dk)
        if (!existing || c.date_comptage > existing.date) {
          mapDates.set(dk, {piece: c.code_piece, date: c.date_comptage})
        }
      }

      // 5. Construire stats
      const stats: any[] = []
      for (const [loc, byEmp] of mapLoc.entries()) {
        const piecesLoc = mapPiecesLoc.get(loc) || new Set<string>()
        const totalPieces = piecesLoc.size

        // Pièces uniques comptées (toutes personnes)
        const toutesComptees = new Set<string>()
        for (const pieces of byEmp.values()) pieces.forEach(p => toutesComptees.add(p))
        const nb_comptes = toutesComptees.size
        const pct = totalPieces > 0 ? Math.min(100, Math.round((nb_comptes / totalPieces) * 100)) : null

        // Liste complète: comptées + manquantes
        const piecesCompteesList = Array.from(toutesComptees).sort()
        const piecesManquantes = totalPieces > 0
          ? Array.from(piecesLoc).filter(p => !toutesComptees.has(p)).sort()
          : []

        const employes = Array.from(byEmp.entries()).map(([emp, pieces]) => {
          const nb_emp = pieces.size
          const pctEmp = totalPieces > 0 ? Math.min(100, Math.round((nb_emp / totalPieces) * 100)) : null
          const dk = loc+'|'+emp
          const last = mapDates.get(dk)
          const piecesEmpList = Array.from(pieces).sort()
          const manqEmp = totalPieces > 0
            ? Array.from(piecesLoc).filter(p => !pieces.has(p)).sort()
            : []
          return {
            employe: emp,
            nb: nb_emp,
            total: totalPieces,
            pct: pctEmp,
            derniere_piece: last?.piece,
            derniere_date: last?.date,
            pieces_comptees: piecesEmpList,
            pieces_manquantes: manqEmp,
          }
        }).sort((a:any,b:any) => (b.nb||0) - (a.nb||0))

        stats.push({
          localisation: loc,
          nb_comptes,
          total_pieces: totalPieces,
          pct,
          pieces_comptees: piecesCompteesList,
          pieces_manquantes: piecesManquantes,
          employes
        })
      }

      stats.sort((a,b) => (b.pct!=null?b.pct:-1) - (a.pct!=null?a.pct:-1))
      setLocsStats(stats)
    } finally {
      setLoadingProg(false)
    }
  }


  function sonOk() {
    try {
      const a = new AudioContext()
      const g = a.createGain()
      g.connect(a.destination)
      // Bip double positif
      const play = (freq:number, start:number, dur:number) => {
        const o = a.createOscillator()
        o.connect(g); o.frequency.value = freq; o.type = 'sine'
        g.gain.setValueAtTime(0.3, a.currentTime + start)
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + start + dur)
        o.start(a.currentTime + start); o.stop(a.currentTime + start + dur)
      }
      play(880, 0, 0.1)
      play(1320, 0.12, 0.1)
    } catch {}
  }

  function sonErr() {
    try {
      const a = new AudioContext()
      const g = a.createGain()
      g.connect(a.destination)
      const o = a.createOscillator()
      o.connect(g); o.type = 'sawtooth'
      o.frequency.setValueAtTime(400, a.currentTime)
      o.frequency.exponentialRampToValueAtTime(150, a.currentTime + 0.5)
      g.gain.setValueAtTime(0.4, a.currentTime)
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.5)
      o.start(); o.stop(a.currentTime + 0.5)
    } catch {}
  }

  function sonBut() {
    try {
      const a = new AudioContext()
      const g = a.createGain()
      g.connect(a.destination)
      // Fanfare NHL style — notes montantes
      const notes = [
        {f:523, t:0,    d:0.12}, // DO
        {f:659, t:0.13, d:0.12}, // MI
        {f:784, t:0.26, d:0.12}, // SOL
        {f:1047,t:0.39, d:0.25}, // DO octave
        {f:784, t:0.55, d:0.08}, // SOL
        {f:1047,t:0.64, d:0.08}, // DO
        {f:1319,t:0.73, d:0.4},  // MI octave — note finale longue
      ]
      notes.forEach(({f, t, d}) => {
        const o = a.createOscillator()
        const og = a.createGain()
        o.connect(og); og.connect(a.destination)
        o.type = 'square'; o.frequency.value = f
        og.gain.setValueAtTime(0, a.currentTime + t)
        og.gain.linearRampToValueAtTime(0.35, a.currentTime + t + 0.02)
        og.gain.exponentialRampToValueAtTime(0.001, a.currentTime + t + d)
        o.start(a.currentTime + t); o.stop(a.currentTime + t + d + 0.05)
      })
    } catch {}
  }

  // Traiter image scannée — extraire texte du code-barres via input file
  function stopCamera() {
    if (scanIntervalRef.current) { clearInterval(scanIntervalRef.current); scanIntervalRef.current = null }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null }
    setScanLog('')
  }

  const html5ScannerRef = useRef<any>(null)
  const scanDoneRef = useRef(false)
  const scanModeRef = useRef<'loc'|'piece'>('loc')

  function startCamera(mode: 'loc'|'piece') {
    // Nettoyage complet avant de démarrer
    fermerScannerSync()
    scanDoneRef.current = false
    scanModeRef.current = mode
    setScanModal(mode)
    setScanLog('Démarrage caméra...')
  }

  // Démarrer le scanner quand le modal s'affiche (via useEffect)
  useEffect(() => {
    if (!scanModal) return
    const mode = scanModeRef.current
    let cancelled = false
    const tryStart = (attempt: number) => {
      if (cancelled || scanDoneRef.current) return
      const H5 = (window as any).Html5Qrcode
      const H5F = (window as any).Html5QrcodeSupportedFormats
      if (!H5 || !H5F) {
        if (attempt < 20) { setTimeout(() => tryStart(attempt+1), 300); return }
        setScanLog('Scanner non chargé — tapez le code ci-dessous'); return
      }
      const el = document.getElementById('inline-scanner')
      if (!el) {
        if (attempt < 15) { setTimeout(() => tryStart(attempt+1), 200); return }
        return
      }
      // Vider le div au cas où il resterait du contenu
      el.innerHTML = ''
      try {
        const sc = new H5('inline-scanner', { verbose: false })
        html5ScannerRef.current = sc
        const config: any = {
          fps: 10,
          qrbox: (w: number, h: number) => {
            const s = Math.min(w, h) * 0.8
            return { width: Math.round(s), height: Math.round(s * 0.45) }
          },
          formatsToSupport: [
            H5F.QR_CODE, H5F.CODE_128, H5F.CODE_39, H5F.CODE_93,
            H5F.EAN_13, H5F.EAN_8, H5F.UPC_A, H5F.UPC_E,
            H5F.ITF, H5F.DATA_MATRIX, H5F.PDF_417
          ]
        }
        const onSuccess = (decoded: string) => {
          if (scanDoneRef.current || cancelled) return
          scanDoneRef.current = true
          const val = (decoded||'').trim().toUpperCase()
          if (!val) return
          sonOk()
          fermerScanner()
          if (mode === 'loc') { setLocInput(val); setTimeout(() => scanLocalisationVal(val, true), 150) }
          else { setPieceInput(val); setTimeout(() => scanPieceVal(val, true), 150) }
        }
        sc.start({ facingMode: 'environment' }, config, onSuccess, () => {})
          .then(() => { if (!cancelled) setScanLog('Pointez vers le code-barres') })
          .catch(() => {
            if (cancelled) return
            sc.start({ facingMode: 'user' }, config, onSuccess, () => {})
              .then(() => { if (!cancelled) setScanLog('Pointez vers le code-barres') })
              .catch(() => { if (!cancelled) setScanLog('Caméra inaccessible — tapez le code ci-dessous') })
          })
      } catch { if (!cancelled) setScanLog('Erreur — tapez le code ci-dessous') }
    }
    setTimeout(() => tryStart(0), 400)
    return () => { cancelled = true; fermerScannerSync() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanModal])

  function fermerScannerSync() {
    scanDoneRef.current = true
    if (html5ScannerRef.current) {
      const sc = html5ScannerRef.current
      html5ScannerRef.current = null
      try { sc.stop().catch(() => {}) } catch {}
      try { sc.clear() } catch {}
    }
    // Nettoyer le DOM manuellement au cas où
    const el = document.getElementById('inline-scanner')
    if (el) el.innerHTML = ''
  }

  function fermerScanner() {
    fermerScannerSync()
    setScanModal(null); setScanLog('')
  }

  function handleScanManual(mode: 'loc'|'piece') {
    const el = document.getElementById('scan-manual-input') as HTMLInputElement
    const v = el?.value?.trim().toUpperCase()
    if (!v) return
    fermerScanner()
    if (mode === 'loc') { setLocInput(v); setTimeout(() => scanLocalisationVal(v, true), 100) }
    else { setPieceInput(v); setTimeout(() => scanPieceVal(v, true), 100) }
  }

  function onLocScan(e: any) {
    const f = e.target.files?.[0]; if (!f) return
    // Fallback photo si getUserMedia échoue
    const reader = new FileReader()
    reader.onload = async () => {
      const img = new Image(); img.src = reader.result as string
      await new Promise(r => { img.onload = r })
      if ('BarcodeDetector' in window) {
        try {
          const det = new (window as any).BarcodeDetector()
          const codes = await det.detect(img)
          if (codes.length > 0) { const v = codes[0].rawValue.trim().toUpperCase(); setLocInput(v); setTimeout(() => scanLocalisationVal(v, true), 100); return }
        } catch {}
      }
    }
    reader.readAsDataURL(f); e.target.value = ''
  }

  function onPieceScan(e: any) {
    const f = e.target.files?.[0]; if (!f) return
    const reader = new FileReader()
    reader.onload = async () => {
      const img = new Image(); img.src = reader.result as string
      await new Promise(r => { img.onload = r })
      if ('BarcodeDetector' in window) {
        try {
          const det = new (window as any).BarcodeDetector()
          const codes = await det.detect(img)
          if (codes.length > 0) { const v = codes[0].rawValue.trim().toUpperCase(); setPieceInput(v); setTimeout(() => scanPieceVal(v, true), 100); return }
        } catch {}
      }
    }
    reader.readAsDataURL(f); e.target.value = ''
  }

  async function scanLocalisationVal(loc: string, fromCamera = false) {
    if (!loc) return
    setLoading(true); setErreur(''); setShowCreerLoc(false)
    // Sauvegarder la localisation active pour reprendre si on quitte
    try { localStorage.setItem('inv_loc_active', loc) } catch {}
    const r = await fetch('/api/inventaire/localisations?loc=' + encodeURIComponent(loc))
    const data = await r.json()
    if (!Array.isArray(data) || data.length === 0) {
      setErreur('❌ Localisation "' + loc + '" inconnue')
      setLocInconnue(loc); setShowCreerLoc(true); sonErr()
      setLocInput(''); setLoading(false)
      if (!fromCamera) setTimeout(() => locRef.current?.focus(), 100)
      return
    }
    const codes = data.map((p:any) => p.code_piece).join(',')
    const rStock = await fetch('/api/inventaire/stock', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ codes })
    })
    const map = new Map<string,{stock:number,reserve:number}>()
    if (rStock.ok) {
      const stocks = await rStock.json()
      for (const s of stocks) {
        map.set(s.code_piece, { stock: s.stock, reserve: s.reserve })
        map.set(s.code_piece.toUpperCase(), { stock: s.stock, reserve: s.reserve })
      }
    }
    // Filtrer : garder seulement les pièces avec du stock positif
    // - Exclure LOC_ (placeholders de localisation vide)
    // - Exclure pièces non trouvées dans Traction (stock 0 ou inexistante)
    // - Exclure pièces avec stock total ≤ 0 (0 ou négatif)
    // - Dédupliquer par code_piece (case-insensitive) pour éviter les doublons
    const seen = new Set<string>()
    const dataFiltered = data.filter((p:any) => {
      if (p.code_piece.startsWith('LOC_')) return false
      const key = p.code_piece.toUpperCase()
      if (seen.has(key)) return false
      seen.add(key)
      const si = map.get(p.code_piece) || map.get(p.code_piece.toUpperCase()) || map.get(p.code_piece.toLowerCase())
      if (!si) return false
      return (si.stock + si.reserve) > 0
    })
    setStockMap(map); setPiecesLoc(dataFiltered); setLocActive(loc)

    // Créer/reprendre une session pour cette localisation
    try {
      const pieces_attendues = dataFiltered.map((p:any) => p.code_piece)
      const sessR = await fetch('/api/inventaire/session', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ localisation: loc, employe, pieces_attendues, nb_attendues: pieces_attendues.length })
      })
      if (sessR.ok) {
        const sessJ = await sessR.json()
        setSessionActive(sessJ.session)
      }
    } catch {}

    setLocInput(''); setEtape('piece'); setComptesDuJour([]); setMultiLocInfo(null); setPieceDejaComptee(null); sonOk(); setLoading(false)
    if (!fromCamera) setTimeout(() => pieceRef.current?.focus(), 100)
  }

  async function scanLocalisation(e?: any) {
    if (e) e.preventDefault()
    await scanLocalisationVal(locInput.trim().toUpperCase())
  }

  async function creerLocalisation() {
    if (!locInconnue) return
    setLoading(true)
    await fetch('/api/inventaire/localisations', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ localisation: locInconnue, employe })
    })
    setShowCreerLoc(false); setErreur('')
    setLocActive(locInconnue); setPiecesLoc([]); setStockMap(new Map())
    setEtape('piece'); setLoading(false)
    setTimeout(() => pieceRef.current?.focus(), 100)
  }

  async function ajouterPieceDansLoc() {
    if (!pieceAjoutable || !locActive) return
    setLoading(true); setErreur('')
    const r = await fetch('/api/inventaire/localisations', {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        code_piece: pieceAjoutable.pk,
        localisation: locActive,
        description: pieceAjoutable.desc || null,
        fournisseur: pieceAjoutable.fournisseur || null
      })
    })
    const inserted = await r.json()
    if (inserted && inserted.id) {
      // Ajouter dans la liste locale et continuer le scan normalement
      const newPieces = [...piecesLoc, inserted]
      setPiecesLoc(newPieces)
      // Charger le stock
      const rStock = await fetch('/api/inventaire/stock', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ codes: pieceAjoutable.pk })
      })
      if (rStock.ok) {
        const stocks = await rStock.json()
        const newMap = new Map(stockMap)
        for (const s of stocks) newMap.set(s.code_piece, { stock: s.stock, reserve: s.reserve })
        setStockMap(newMap)
      }
      const stockInfo = stockMap.get(pieceAjoutable.pk.toUpperCase()) || { stock: 0, reserve: 0 }
      setPieceActive({ ...inserted, stockSys: stockInfo.stock + stockInfo.reserve, stock: stockInfo.stock, reserve: stockInfo.reserve })
      setPieceAjoutable(null)
      setErreur('')
      if (modeRapide) {
        await _sauvegarder(inserted, stockInfo, 1)
      } else {
        setEtape('quantite'); setLoading(false)
        setTimeout(() => qteRef.current?.focus(), 100)
      }
    } else {
      setErreur('❌ Erreur lors de l\'ajout: ' + (inserted.erreur || 'inconnue'))
      setLoading(false)
    }
  }

  async function scanPieceVal(code: string, fromCamera = false) {
    if (!code) return
    setLoading(true); setErreur(''); setPieceAjoutable(null); setPieceDejaComptee(null); setMultiLocInfo(null)
    const pieceDansLoc = piecesLoc.find((p:any) => p.code_piece.trim().toUpperCase() === code)
    if (!pieceDansLoc) {
      const r = await fetch('/api/sku-lookup?sku=' + encodeURIComponent(code))
      const j = await r.json()
      if (!j.found) {
        setErreur('❌ Piece "' + code + '" inconnue')
        sonErr(); setPieceInput(''); setLoading(false)
        if (!fromCamera) setTimeout(() => pieceRef.current?.focus(), 100); return
      }
      const rLoc = await fetch('/api/inventaire/localisations?code=' + encodeURIComponent(code))
      const locData = await rLoc.json()
      const autresLocs = Array.isArray(locData) ? locData.flatMap((p:any) => [p.localisation1,p.localisation2,p.localisation3,p.localisation4].filter(Boolean)) : []
      setPieceAjoutable({ pk: code, desc: j.desc, fournisseur: j.fournisseur, stock: j.stock })
      setErreur(autresLocs.length > 0
        ? `⚠️ Piece "${code}" pas dans ${locActive}. Localisations actuelles: ${autresLocs.join(', ')}`
        : `⚠️ Piece "${code}" sans localisation assignée.`)
      sonErr(); setPieceInput(''); setLoading(false)
      if (!fromCamera) setTimeout(() => pieceRef.current?.focus(), 100); return
    }
    // Vérifier les autres localisations de cette pièce
    // On query TOUTES les lignes de la table localisations pour cette pièce
    // (pas juste le row courant) car la même pièce peut avoir plusieurs rows
    let autresLocs: string[] = []
    try {
      const rAllLocs = await fetch('/api/inventaire/localisations?code=' + encodeURIComponent(code))
      const allLocData = await rAllLocs.json()
      if (Array.isArray(allLocData)) {
        const allLocs = new Set<string>()
        for (const row of allLocData) {
          for (const l of [row.localisation1, row.localisation2, row.localisation3, row.localisation4]) {
            if (l) allLocs.add(l.toUpperCase())
          }
        }
        allLocs.delete(locActive?.toUpperCase() || '')
        autresLocs = Array.from(allLocs)
      }
    } catch {
      // Fallback: utiliser les colonnes du row courant
      autresLocs = [pieceDansLoc.localisation1, pieceDansLoc.localisation2, pieceDansLoc.localisation3, pieceDansLoc.localisation4]
        .filter(Boolean).filter((l:string) => l.toUpperCase() !== locActive?.toUpperCase())
    }

    // Si multi-loc, vérifier si déjà comptée à une autre localisation dans le
    // cycle actif (statut en_attente ou reconcilie, sans limite de date).
    if (autresLocs.length > 0) {
      try {
        const rCheck = await fetch('/api/inventaire/comptages?code_actifs=' + encodeURIComponent(code))
        const comptagesAuj = await rCheck.json()
        const comptageAutreLoc = Array.isArray(comptagesAuj) ? comptagesAuj.find((c:any) => c.localisation?.toUpperCase() !== locActive?.toUpperCase()) : null
        if (comptageAutreLoc) {
          // Déjà comptée ailleurs aujourd'hui — demander confirmation
          setPieceDejaComptee({
            piece: pieceDansLoc, code, autresLocs,
            comptage: comptageAutreLoc,
            stockInfo: stockMap.get(code) || { stock: 0, reserve: 0 }
          })
          setErreur('')
          setPieceInput(''); setLoading(false)
          return
        }
      } catch {}
    }

    setMultiLocInfo(autresLocs.length > 0 ? { locs: autresLocs } : null)
    const stockInfo = stockMap.get(code) || { stock: 0, reserve: 0 }
    setPieceActive({ ...pieceDansLoc, stockSys: stockInfo.stock + stockInfo.reserve, stock: stockInfo.stock, reserve: stockInfo.reserve })
    setPieceInput('')
    if (modeRapide) {
      await _sauvegarder(pieceDansLoc, stockInfo, 1)
    } else {
      setEtape('quantite'); setLoading(false)
      if (!fromCamera) setTimeout(() => qteRef.current?.focus(), 100)
    }
  }

  // Continuer le comptage d'une pièce déjà comptée ailleurs
  async function continuerComptageDejaComptee() {
    if (!pieceDejaComptee) return
    const { piece, autresLocs, stockInfo } = pieceDejaComptee
    setMultiLocInfo({ locs: autresLocs })
    setPieceActive({ ...piece, stockSys: stockInfo.stock + stockInfo.reserve, stock: stockInfo.stock, reserve: stockInfo.reserve })
    setPieceDejaComptee(null)
    if (modeRapide) {
      await _sauvegarder(piece, stockInfo, 1)
    } else {
      setEtape('quantite'); setLoading(false)
      setTimeout(() => qteRef.current?.focus(), 100)
    }
  }

  function skipPieceDejaComptee() {
    setPieceDejaComptee(null)
    setPieceInput('')
    setEtape('piece')
    setTimeout(() => pieceRef.current?.focus(), 100)
  }

  async function scanPiece(e?: any) {
    if (e) e.preventDefault()
    await scanPieceVal(pieceInput.trim().toUpperCase())
  }

  async function soumettreQte(e?: any) {
    if (e) e.preventDefault()
    if (!pieceActive || !qteInput) return
    const qte = parseFloat(qteInput)
    const ecart = qte - pieceActive.stockSys
    if (ecart !== 0) {
      setPendingComptage({ piece: pieceActive, stockInfo: { stock: pieceActive.stock, reserve: pieceActive.reserve }, qte, ecart })
      setEtape('photo'); setLoading(false)
      setTimeout(() => photoRef.current?.click(), 300)
    } else {
      setLoading(true)
      await _sauvegarder(pieceActive, { stock: pieceActive.stock, reserve: pieceActive.reserve }, qte, null)
    }
  }

  async function soumettreAvecPhoto(e?: any) {
    if (e) e.preventDefault()
    if (!pendingComptage || !photoFile) return
    setUploadingPhoto(true)
    let photoUrl = null
    try {
      const fd = new FormData()
      fd.append('file', photoFile)
      fd.append('code_piece', pendingComptage.piece.code_piece)
      fd.append('localisation', locActive||'')
      const r = await fetch('/api/inventaire/photo', { method: 'POST', body: fd })
      const j = await r.json()
      if (j.url) photoUrl = j.url
    } catch {}
    await _sauvegarder(pendingComptage.piece, pendingComptage.stockInfo, pendingComptage.qte, photoUrl)
    setPhotoFile(null); setPhotoPreview(null); setPendingComptage(null); setUploadingPhoto(false)
  }

  function onPhotoChange(e: any) {
    const f = e.target.files?.[0]
    if (!f) return
    setPhotoFile(f)
    const reader = new FileReader()
    reader.onload = ev => setPhotoPreview(ev.target?.result as string)
    reader.readAsDataURL(f)
  }

  async function _sauvegarder(piece: any, stockInfo: any, qte: number, photoUrl: string|null = null) {
    const qteSysteme = (stockInfo.stock||0) + (stockInfo.reserve||0)
    try {
      const r = await fetch('/api/inventaire/comptages', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          code_piece: piece.code_piece, localisation: locActive,
          qte_comptee: qte, qte_systeme: qteSysteme, qte_reservee: stockInfo.reserve||0,
          employe, photo_url: photoUrl
        })
      })
      if (!r.ok) {
        const j = await r.json().catch(()=>({}))
        setErreur('❌ Erreur sauvegarde: ' + (j.erreur||r.statusText)); sonErr(); setLoading(false); return
      }
    } catch (e: any) {
      setErreur('❌ Erreur réseau: ' + e.message); sonErr(); setLoading(false); return
    }
    const c = { code_piece: piece.code_piece, description: piece.description, qte_comptee: qte, qte_systeme: qteSysteme, ecart: qte-qteSysteme, heure: new Date().toLocaleTimeString('fr-CA'), photo_url: photoUrl }
    setComptesDuJour(prev => [c, ...prev.filter((x:any)=>x.code_piece!==piece.code_piece)])
    setDernierComptage(c); setPieceActive(null); setQteInput(''); setEtape('piece'); sonOk(); setLoading(false)
    setTimeout(() => pieceRef.current?.focus(), 100)
  }

  async function annulerDernier() {
    if (!dernierComptage) return
    await fetch('/api/inventaire/comptages?code=' + encodeURIComponent(dernierComptage.code_piece) + '&loc=' + encodeURIComponent(locActive||''), { method: 'DELETE' })
    setComptesDuJour(prev => prev.filter((c:any) => c.code_piece !== dernierComptage.code_piece))
    setDernierComptage(null)
  }

  function changerLocalisation() {
    setEtape('localisation'); setLocActive(null); setPiecesLoc([]); setPieceActive(null)
    setLocInput(''); setPieceInput(''); setQteInput(''); setErreur(''); setShowCreerLoc(false)
    setPhotoFile(null); setPhotoPreview(null); setPendingComptage(null)
    setTimeout(() => locRef.current?.focus(), 100)
  }

  async function importerLocalisations(e: any) {
    e.preventDefault()
    if (!importFile) return
    setImportLoading(true); setImportStatus('')
    const fd = new FormData(); fd.append('file', importFile)
    const r = await fetch('/api/inventaire/import', { method: 'POST', body: fd })
    const j = await r.json()
    setImportStatus(j.success ? `✅ ${j.total} pièces importées` : `❌ ${j.erreur}`)
    setImportLoading(false); setImportFile(null)
  }

  async function chargerComptages() {
    const r = await fetch('/api/inventaire/comptages')
    if (r.ok) setComptages(await r.json())
  }


  const btnPrimary: any = {border:'none',borderRadius:12,fontWeight:800,cursor:'pointer',color:'#fff',width:'100%',padding:isMobile?'16px 0':'10px 0',fontSize:isMobile?17:14}

  return <>
    {/* Bandeau de retours comptabilité — affiché en TÊTE si l'utilisateur a des comptages à corriger */}
    <RetoursComptaBandeau retours={retoursActifs} source="comptage" employe={employe} dark={dark} card={card} bdr={bdr} sub={sub} C={C} onCorrige={marquerRetourCorrigeCompt} onEdit={ouvrirEditComptage}/>

    {/* Input photo caché pour le modal d'édition */}
    <input ref={editPhotoRef} type="file" accept="image/*" capture="environment" onChange={onEditPhotoChange} style={{display:'none'}}/>

    {/* Modal d'édition d'un comptage retourné par la compta */}
    {editComptage && (() => {
      const qc = editForm.qte_comptee === '' ? null : Number(editForm.qte_comptee)
      const qs = Number(editComptage.qte_systeme || 0)
      const ec = qc === null ? null : qc - qs
      const photoActuelle = !editPhotoSupprimee && !editPhotoPreview ? editComptage.photo_url : null
      return (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:9999,display:'flex',alignItems:'flex-start',justifyContent:'center',padding:isMobile?0:20,overflowY:'auto'}}
             onClick={fermerEditComptage}>
          <div onClick={(e:any)=>e.stopPropagation()} style={{background:card,borderRadius:isMobile?0:14,maxWidth:560,width:'100%',border:`2px solid ${C.blue}`,boxShadow:'0 10px 40px rgba(0,0,0,.4)',minHeight:isMobile?'100vh':undefined}}>
            <div style={{position:'sticky',top:0,background:C.blue,color:'#fff',padding:'14px 16px',display:'flex',justifyContent:'space-between',alignItems:'center',borderRadius:isMobile?0:'12px 12px 0 0'}}>
              <div>
                <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',opacity:.85}}>📦 Modifier le comptage</div>
                <div style={{fontSize:18,fontWeight:900,fontFamily:'monospace',marginTop:2}}>{editComptage.code_piece}</div>
              </div>
              <button onClick={fermerEditComptage}
                style={{background:'rgba(255,255,255,.2)',border:'none',borderRadius:8,padding:'7px 12px',color:'#fff',cursor:'pointer',fontSize:13,fontWeight:700}}>✕ Fermer</button>
            </div>
            <div style={{padding:'16px'}}>
              <div style={{fontSize:11,color:sub,marginBottom:12}}>
                Compté par <strong>{editComptage.employe}</strong> le {new Date(editComptage.date_comptage).toLocaleDateString('fr-CA',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:14}}>
                <div style={{background:dark?'#1a233a':'#e8f0fe',borderRadius:10,padding:'10px',textAlign:'center',border:`1px solid ${C.blue}33`}}>
                  <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Système</div>
                  <div style={{fontSize:22,fontWeight:900,color:C.blue}}>{qs}</div>
                </div>
                <div style={{background:dark?'#0d2a18':'#e6f4ea',borderRadius:10,padding:'10px',textAlign:'center',border:`1px solid ${C.green}33`}}>
                  <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Compté</div>
                  <div style={{fontSize:22,fontWeight:900,color:C.green}}>{qc ?? '—'}</div>
                </div>
                <div style={{background:ec===0||ec===null?(dark?'#1a1a1a':'#f8f9fa'):(dark?'#2b1113':'#fce8e6'),borderRadius:10,padding:'10px',textAlign:'center',border:`1px solid ${ec===0||ec===null?bdr:C.red}33`}}>
                  <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Écart</div>
                  <div style={{fontSize:22,fontWeight:900,color:ec===0||ec===null?sub:C.red}}>{ec===null?'—':(ec>0?'+':'')+ec}</div>
                </div>
              </div>

              <div style={{marginBottom:12}}>
                <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Localisation</div>
                <input value={editForm.localisation} onChange={e=>setEditForm(f=>({...f,localisation:e.target.value.toUpperCase()}))}
                  style={{...S,fontSize:14,fontWeight:700,fontFamily:'monospace'}}/>
              </div>

              <div style={{marginBottom:12}}>
                <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Quantité comptée *</div>
                <input type="number" step="any" inputMode="numeric" value={editForm.qte_comptee}
                  onChange={e=>setEditForm(f=>({...f,qte_comptee:e.target.value}))}
                  style={{...S,fontSize:20,fontWeight:900,textAlign:'center',padding:'12px'}}/>
              </div>

              <div style={{marginBottom:12}}>
                <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Note</div>
                <textarea value={editForm.note} onChange={e=>setEditForm(f=>({...f,note:e.target.value}))}
                  rows={3} placeholder="Optionnel"
                  style={{...S,fontSize:13,padding:'10px',resize:'vertical',fontFamily:'inherit'}}/>
              </div>

              <div style={{marginBottom:14}}>
                <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Photo</div>
                {(photoActuelle || editPhotoPreview) ? (
                  <div style={{position:'relative',display:'inline-block'}}>
                    <img src={editPhotoPreview || photoActuelle!} alt=""
                      style={{maxWidth:'100%',maxHeight:200,borderRadius:8,border:`2px solid ${C.green}`}}
                      onError={(e:any)=>e.target.style.display='none'}/>
                    <button type="button"
                      onClick={()=>{
                        if (editPhotoPreview) { setEditPhotoFile(null); setEditPhotoPreview(null) }
                        else { setEditPhotoSupprimee(true) }
                      }}
                      style={{position:'absolute',top:4,right:4,background:C.red,border:'none',borderRadius:'50%',width:28,height:28,color:'#fff',cursor:'pointer',fontWeight:700}}>✕</button>
                  </div>
                ) : (
                  <div style={{fontSize:12,color:sub,marginBottom:8}}>Aucune photo</div>
                )}
                <button type="button" onClick={()=>editPhotoRef.current?.click()}
                  style={{display:'block',marginTop:8,background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'10px 14px',fontWeight:700,cursor:'pointer',fontSize:13}}>
                  📷 {(photoActuelle || editPhotoPreview) ? 'Remplacer la photo' : 'Ajouter une photo'}
                </button>
              </div>

              <div style={{display:'flex',gap:8,justifyContent:'flex-end',borderTop:`1px solid ${bdr}`,paddingTop:14}}>
                <button onClick={fermerEditComptage}
                  style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'10px 16px',fontWeight:700,cursor:'pointer',fontSize:13}}>
                  Annuler
                </button>
                <button onClick={sauverEditComptage}
                  disabled={editLoading || editForm.qte_comptee === ''}
                  style={{background:editLoading||editForm.qte_comptee===''?bdr:C.green,color:'#fff',border:'none',borderRadius:8,padding:'10px 18px',fontWeight:800,cursor:editLoading?'default':'pointer',fontSize:13}}>
                  {editLoading ? '⏳ Enregistrement...' : '✅ Enregistrer la correction'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )
    })()}

    {/* Sous-onglets */}
    <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center',justifyContent:'space-between'}}>
      <div style={{display:'flex',gap:8}}>
        <button onClick={()=>setSousOnglet('compter')} style={{padding:isMobile?'14px 22px':'8px 16px',borderRadius:isMobile?14:20,border:`2px solid ${sousOnglet==='compter'?C.blue:bdr}`,background:sousOnglet==='compter'?(dark?'#1a233a':'#e8f0fe'):'transparent',color:sousOnglet==='compter'?C.blue:sub,fontSize:isMobile?16:13,fontWeight:700,cursor:'pointer',flex:isMobile?1:undefined}}>📦 Compter</button>
        <button onClick={()=>setSousOnglet('suivi')} style={{padding:isMobile?'14px 22px':'8px 16px',borderRadius:isMobile?14:20,border:`2px solid ${sousOnglet==='suivi'?C.green:bdr}`,background:sousOnglet==='suivi'?(dark?'#0d2a18':'#e6f4ea'):'transparent',color:sousOnglet==='suivi'?C.green:sub,fontSize:isMobile?16:13,fontWeight:700,cursor:'pointer',flex:isMobile?1:undefined}}>📊 Suivi</button>
      </div>
      {sousOnglet==='compter' && (
        <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer'}}>
          <div onClick={()=>setModeRapide(!modeRapide)} style={{width:44,height:24,borderRadius:12,background:modeRapide?C.green:'#94a3b8',position:'relative',cursor:'pointer',transition:'all .2s'}}>
            <div style={{position:'absolute',top:4,left:modeRapide?23:4,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'all .2s'}}/>
          </div>
          <span style={{color:modeRapide?C.green:sub,fontWeight:600,fontSize:isMobile?14:13}}>⚡ Mode rapide</span>
        </label>
      )}
    </div>

    {sousOnglet==='compter' && <>
      {/* Message reprendre localisation */}
      {showReprendreMsg && locInput && (
        <div style={{background:dark?'#1a233a':'#e8f0fe',borderRadius:12,padding:'14px 16px',marginBottom:14,border:`2px solid ${C.blue}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}}>
          <div>
            <div style={{fontWeight:700,color:C.blue,fontSize:14}}>📍 Reprendre la localisation ?</div>
            <div style={{fontSize:13,color:sub,marginTop:2}}>Tu as laissé <strong>{locInput}</strong> en cours</div>
          </div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={()=>{setShowReprendreMsg(false);scanLocalisationVal(locInput,false)}}
              style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:13}}>
              ▶ Reprendre
            </button>
            <button onClick={()=>{setShowReprendreMsg(false);try{localStorage.removeItem('inv_loc_active')}catch{}}}
              style={{background:'transparent',color:sub,border:`1px solid ${bdr}`,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:13}}>
              ✕ Ignorer
            </button>
          </div>
        </div>
      )}

      {/* Import — desktop seulement */}
      {!isMobile && (
        <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,padding:'10px 16px',marginBottom:12}}>
          <form onSubmit={importerLocalisations} style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
            <span style={{fontSize:12,fontWeight:600,color:sub}}>📥 Mettre à jour localisations:</span>
            <input type="file" accept=".xlsx,.xls" onChange={e=>setImportFile(e.target.files?.[0]||null)} style={{...S,flex:1,minWidth:160,fontSize:12}}/>
            <button type="submit" disabled={!importFile||importLoading} style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'6px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
              {importLoading?'...':'📥 Importer'}
            </button>
            {importStatus && <span style={{fontSize:12,color:importStatus.startsWith('✅')?C.green:C.red,fontWeight:600}}>{importStatus}</span>}
          </form>
        </div>
      )}

      {/* Inputs cachés pour scan caméra */}
      {/* Scanner dans popup externe scanner.html */}
      <input ref={locScanRef} type="file" accept="image/*" capture="environment" onChange={onLocScan} style={{display:'none'}}/>
      <input ref={pieceScanRef} type="file" accept="image/*" capture="environment" onChange={onPieceScan} style={{display:'none'}}/>
      <input ref={photoRef} type="file" accept="image/*" capture="environment" onChange={onPhotoChange} style={{display:'none'}}/>

      <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 300px',gap:16,alignItems:'start'}}>
        <div>

          {/* Localisation active */}
          {locActive && (() => {
            const nbComptes = comptesDuJour.length
            const nbTotal = piecesLoc.filter((p:any) => {
              const key = p.code_piece.toUpperCase()
              return key.indexOf('LOC_') !== 0 // Exclure les placeholders
            }).length
            const pct = nbTotal > 0 ? Math.round((nbComptes / nbTotal) * 100) : 0
            return (
              <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`2px solid ${C.green}`,borderRadius:14,padding:isMobile?'14px 16px':'12px 16px',marginBottom:12}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.green}}>📍 Localisation active</div>
                    <div style={{fontSize:isMobile?30:24,fontWeight:900,color:C.green,letterSpacing:2,marginTop:2}}>{locActive}</div>
                    <div style={{fontSize:12,color:sub,marginTop:2}}>👤 {employe} • {nbTotal} pièces</div>
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:6,alignItems:'flex-end'}}>
                    {dernierComptage && (
                      <button onClick={annulerDernier} style={{background:C.yellow+'22',border:`1px solid ${C.yellow}`,borderRadius:8,padding:'6px 10px',color:C.yellow,cursor:'pointer',fontWeight:700,fontSize:12}}>↩ Annuler</button>
                    )}
                    <button onClick={changerLocalisation} style={{background:'none',border:`1px solid ${C.green}`,borderRadius:8,padding:'6px 10px',color:C.green,cursor:'pointer',fontWeight:700,fontSize:12}}>🔄 Changer</button>
                  </div>
                </div>
                {/* Barre de progression */}
                <div style={{marginTop:12}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                    <span style={{fontSize:12,color:sub}}>{nbComptes} / {nbTotal} pièces comptées</span>
                    <span style={{fontSize:13,fontWeight:800,color:pct===100?C.green:C.blue}}>{pct}%</span>
                  </div>
                  <div style={{background:dark?'#1a1a1a':'#d1fae5',borderRadius:20,height:8,overflow:'hidden'}}>
                    <div style={{width:pct+'%',height:'100%',background:pct===100?C.green:C.blue,borderRadius:20,transition:'width .3s'}}/>
                  </div>
                  {pct===100 && (() => {
                    // Jouer le son de but une seule fois quand on atteint 100%
                    if (comptesDuJour.length === nbTotal && nbTotal > 0) {
                      setTimeout(() => sonBut(), 100)
                    }
                    return (
                      <div style={{marginTop:10,background:C.green,borderRadius:10,padding:'10px 14px',textAlign:'center'}}>
                        <span style={{color:'#fff',fontWeight:800,fontSize:14}}>🏒 Localisation complète! </span>
                        <button onClick={changerLocalisation} style={{background:'rgba(255,255,255,.3)',border:'none',borderRadius:8,padding:'4px 12px',color:'#fff',cursor:'pointer',fontWeight:700,fontSize:13,marginLeft:8}}>
                          Fermer →
                        </button>
                      </div>
                    )
                  })()}
                  {pct<100 && nbComptes>0 && (
                    <button onClick={changerLocalisation} style={{marginTop:8,background:'none',border:`1px solid ${bdr}`,borderRadius:8,padding:'6px 14px',color:sub,cursor:'pointer',fontSize:12,width:'100%'}}>
                      Fermer la localisation ({pct}% complété)
                    </button>
                  )}
                </div>
              </div>
            )
          })()}

          {/* SCANNER INLINE */}
          {scanModal && (
            <div style={{position:'fixed',inset:0,zIndex:9999,background:'#000',display:'flex',flexDirection:'column'}}>
              <div style={{padding:'14px 16px',background:'#111',display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0}}>
                <span style={{fontSize:17,fontWeight:700,color:'#fff'}}>
                  {scanModal==='loc'?'📍 Scanner Localisation':'📦 Scanner Pièce'}
                </span>
                <button onClick={fermerScanner} style={{background:'#ef4444',border:'none',color:'#fff',padding:'10px 20px',borderRadius:10,fontSize:16,fontWeight:700,cursor:'pointer'}}>✕ Fermer</button>
              </div>
              <div style={{flex:1,overflow:'hidden',background:'#000',position:'relative'}}>
                <div id="inline-scanner" style={{width:'100%',height:'100%'}}/>
              </div>
              <div style={{padding:'10px 16px',background:'#111',textAlign:'center',fontSize:14,color:'#4ade80',fontWeight:600,flexShrink:0}}>{scanLog||'Chargement...'}</div>
              <div style={{padding:'14px 16px',background:'#1a1a1a',display:'flex',gap:8,flexShrink:0,borderTop:'1px solid #333'}}>
                <input id="scan-manual-input" type="text" placeholder="Ou taper le code ici..."
                  autoComplete="off" autoCapitalize="characters" spellCheck={false}
                  onKeyDown={e=>{if(e.key==='Enter') handleScanManual(scanModal)}}
                  style={{flex:1,background:'#2a2a2a',border:'2px solid #555',color:'#fff',padding:'14px',borderRadius:10,fontSize:18,fontWeight:700,outline:'none',letterSpacing:1}}/>
                <button onClick={()=>handleScanManual(scanModal)}
                  style={{background:'#2563eb',color:'#fff',border:'none',padding:'14px 24px',borderRadius:10,fontWeight:900,cursor:'pointer',fontSize:16,whiteSpace:'nowrap'}}>OK</button>
              </div>
            </div>
          )}

          {/* ÉTAPE LOCALISATION */}
          {etape==='localisation' && (
            <div style={{background:card,borderRadius:14,border:`2px solid ${C.blue}`,padding:isMobile?'20px':'16px',marginBottom:12}}>
              <div style={{fontSize:isMobile?16:13,fontWeight:700,color:C.blue,marginBottom:14}}>📍 Localisation</div>
              <form onSubmit={scanLocalisation} style={{display:'flex',flexDirection:'column',gap:10}}>
                <input ref={locRef} value={locInput} onChange={e=>{setLocInput(e.target.value.toUpperCase());setErreur('');setShowCreerLoc(false)}}
                  placeholder="Ex: PSC4-36"
                  style={{...S,fontSize:isMobile?20:16,fontWeight:700,padding:isMobile?'16px 14px':'10px 14px',borderRadius:12,textAlign:'center',letterSpacing:2}} autoCapitalize="characters"/>
                <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'1fr auto',gap:10}}>
                  {isMobile && (
                    <button type="button" onClick={()=>startCamera('loc')}
                      style={{...btnPrimary,background:dark?'#1a233a':'#e8f0fe',color:C.blue,border:`2px solid ${C.blue}`,fontSize:17,padding:'16px 0',minHeight:54}}>
                      📷 Scanner
                    </button>
                  )}
                  <button type="submit" disabled={loading} style={{...btnPrimary,background:C.blue,fontSize:isMobile?17:14,padding:isMobile?'16px 0':undefined,minHeight:isMobile?54:undefined}}>
                    {loading?'...':isMobile?'🔍 Chercher':'OK'}
                  </button>
                </div>
              </form>
              {showCreerLoc && (
                <div style={{marginTop:14,background:dark?'#1a1a2e':'#fff8e1',border:`2px solid ${C.yellow}`,borderRadius:12,padding:'14px 16px'}}>
                  <p style={{color:C.yellow,fontWeight:700,fontSize:14,margin:'0 0 6px'}}>⚠️ "{locInconnue}" inconnue</p>
                  <p style={{color:sub,fontSize:12,margin:'0 0 12px'}}>Cette localisation n'existe pas. Veux-tu la créer ?</p>
                  <div style={{display:'flex',gap:8,flexDirection:isMobile?'column':'row'}}>
                    <button onClick={creerLocalisation} style={{...btnPrimary,background:C.green,padding:'12px 0'}}>✅ Créer "{locInconnue}"</button>
                    <button onClick={()=>{setShowCreerLoc(false);setErreur('');setLocInconnue('')}} style={{...btnPrimary,background:'#94a3b8',padding:'12px 0'}}>Annuler</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ÉTAPE PIÈCE */}
          {etape==='piece' && locActive && (
            <div style={{background:card,borderRadius:14,border:`2px solid ${C.yellow}`,padding:isMobile?'20px':'16px',marginBottom:12}}>
              <div style={{fontSize:isMobile?16:13,fontWeight:700,color:C.yellow,marginBottom:14}}>
                🔍 Scanner une pièce
                {modeRapide && <span style={{background:C.green,color:'#fff',padding:'3px 10px',borderRadius:10,fontSize:12,marginLeft:8}}>⚡ qté=1</span>}
              </div>
              <form onSubmit={scanPiece} style={{display:'flex',flexDirection:'column',gap:10}}>
                <input ref={pieceRef} value={pieceInput} onChange={e=>{setPieceInput(e.target.value.toUpperCase());setErreur('')}}
                  placeholder="Scanner ou taper le SKU..."
                  style={{...S,fontSize:isMobile?20:16,fontWeight:700,padding:isMobile?'16px 14px':'10px 14px',borderRadius:12,textAlign:'center'}} autoCapitalize="characters"/>
                <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'1fr auto',gap:10}}>
                  {isMobile && (
                    <button type="button" onClick={()=>startCamera('piece')}
                      style={{...btnPrimary,background:dark?'#2b2411':'#fff8e1',color:C.yellow,border:`2px solid ${C.yellow}`,fontSize:17,padding:'16px 0',minHeight:54}}>
                      📷 Scanner
                    </button>
                  )}
                  <button type="submit" disabled={loading} style={{...btnPrimary,background:C.yellow,fontSize:isMobile?17:14,padding:isMobile?'16px 0':undefined,minHeight:isMobile?54:undefined}}>
                    {loading?'...':isMobile?'✅ Confirmer':'OK'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* ÉTAPE QUANTITÉ */}
          {etape==='quantite' && pieceActive && (
            <div style={{background:card,borderRadius:14,border:`2px solid ${C.green}`,padding:isMobile?'20px':'16px',marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:14}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.green}}>✅ Pièce confirmée</div>
                  <div style={{fontSize:isMobile?22:18,fontWeight:900,marginTop:2}}>{pieceActive.code_piece}</div>
                  <div style={{fontSize:13,color:sub,marginTop:2}}>{pieceActive.description}</div>
                  <div style={{fontSize:isMobile?14:12,marginTop:6,display:'flex',gap:14,flexWrap:'wrap'}}>
                    <span style={{color:C.blue,fontWeight:600}}>Stock: <strong>{pieceActive.stockSys}</strong></span>
                    {pieceActive.reserve>0 && <span style={{color:C.yellow,fontWeight:600}}>Réservé: <strong>{pieceActive.reserve}</strong></span>}
                  </div>
                </div>
                <button onClick={()=>{setEtape('piece');setPieceActive(null);setQteInput('');setTimeout(()=>pieceRef.current?.focus(),100)}}
                  style={{background:'none',border:`1px solid ${bdr}`,borderRadius:8,padding:isMobile?'10px 14px':'6px 12px',color:sub,cursor:'pointer',fontSize:isMobile?14:12,marginLeft:10}}>
                  ↩ Mauvaise pièce
                </button>
              </div>
              <form onSubmit={soumettreQte} style={{display:'flex',flexDirection:'column',gap:10}}>
                <input ref={qteRef} type="number" inputMode="numeric" step="any" value={qteInput}
                  onChange={e=>{setQteInput(e.target.value);setErreur('')}}
                  placeholder="Quantité sur tablette"
                  style={{...S,fontSize:isMobile?36:22,fontWeight:900,textAlign:'center',padding:isMobile?'20px 14px':'12px 14px',borderRadius:12}} autoFocus/>
                <button type="submit" disabled={loading||!qteInput} style={{...btnPrimary,background:qteInput?C.green:'#94a3b8',fontSize:isMobile?18:14,padding:isMobile?'18px 0':undefined,minHeight:isMobile?56:undefined}}>
                  {loading?'Sauvegarde...':'✅ Confirmer la quantité'}
                </button>
              </form>
            </div>
          )}

          {/* ÉTAPE PHOTO */}
          {etape==='photo' && pendingComptage && (
            <div style={{background:card,borderRadius:14,border:`2px solid ${C.red}`,padding:isMobile?'20px':'16px',marginBottom:12}}>
              <div style={{fontSize:isMobile?16:13,fontWeight:700,color:C.red,marginBottom:10}}>📸 Photo obligatoire — Écart détecté</div>
              <div style={{background:C.red+'22',borderRadius:10,padding:'12px 16px',marginBottom:14}}>
                <div style={{fontSize:isMobile?20:15,fontWeight:900,color:C.red}}>
                  Écart: {pendingComptage.ecart>0?'+':''}{pendingComptage.ecart} unités
                </div>
                <div style={{fontSize:13,color:sub,marginTop:3}}>
                  {pendingComptage.piece.code_piece} — Système: {pendingComptage.piece.stockSys} → Compté: {pendingComptage.qte}
                </div>
              </div>
              <p style={{color:sub,fontSize:13,margin:'0 0 14px'}}>Prends une photo du stock sur la tablette pour justifier l'écart.</p>
              {!photoPreview
                ? <button onClick={()=>photoRef.current?.click()} style={{...btnPrimary,background:C.blue,marginBottom:10}}>📷 Prendre une photo</button>
                : <div style={{marginBottom:12}}>
                    <img src={photoPreview} style={{width:'100%',borderRadius:12,maxHeight:260,objectFit:'cover',border:`2px solid ${C.green}`}} alt="Photo"/>
                    <button onClick={()=>photoRef.current?.click()} style={{...btnPrimary,background:'#94a3b8',marginTop:8,padding:'10px 0',fontSize:14}}>🔄 Reprendre</button>
                  </div>
              }
              {photoPreview && (
                <button onClick={soumettreAvecPhoto} disabled={uploadingPhoto} style={{...btnPrimary,background:C.green}}>
                  {uploadingPhoto?'Envoi en cours...':'✅ Confirmer avec photo'}
                </button>
              )}
              <button onClick={()=>{setEtape('quantite');setPendingComptage(null);setPhotoFile(null);setPhotoPreview(null)}}
                style={{...btnPrimary,background:'transparent',color:sub,border:`1px solid ${bdr}`,marginTop:10,fontSize:14}}>
                ← Modifier la quantité
              </button>
            </div>
          )}

          {/* Pièce déjà comptée à une autre localisation */}
          {pieceDejaComptee && (
            <div style={{background:dark?'#1a233a':'#dbeafe',border:`2px solid ${C.blue}`,borderRadius:12,padding:'16px',marginBottom:12}}>
              <div style={{fontWeight:800,fontSize:isMobile?16:14,color:C.blue,marginBottom:8}}>
                📍 Pièce "{pieceDejaComptee.code}" — multi-localisation
              </div>
              <div style={{fontSize:isMobile?13:12,color:dark?'#ccc':'#333',marginBottom:10,lineHeight:1.6}}>
                Cette pièce existe dans <strong>{pieceDejaComptee.autresLocs.length + 1} localisations</strong> et a déjà été comptée dans une autre :
              </div>
              <div style={{background:dark?'#111':'#fff',borderRadius:8,padding:'10px 14px',marginBottom:10,border:`1px solid ${bdr}`}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                  <span style={{background:C.green+'22',color:C.green,padding:'2px 8px',borderRadius:6,fontSize:11,fontWeight:700}}>✅ Déjà compté</span>
                  <strong style={{color:C.blue}}>{pieceDejaComptee.comptage.localisation}</strong>
                </div>
                <div style={{fontSize:12,color:sub}}>
                  Par <strong>{pieceDejaComptee.comptage.employe}</strong> — Qté : <strong style={{fontSize:15}}>{pieceDejaComptee.comptage.qte_comptee}</strong>
                  <span style={{marginLeft:6}}>
                    {(() => {
                      const d = new Date(pieceDejaComptee.comptage.date_comptage)
                      const today = new Date()
                      const sameDay = d.toDateString() === today.toDateString()
                      return sameDay
                        ? `(aujourd'hui ${d.toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'})})`
                        : `(${d.toLocaleDateString('fr-CA',{day:'numeric',month:'short'})} à ${d.toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'})})`
                    })()}
                  </span>
                </div>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
                <span style={{background:C.yellow+'22',color:C.yellow,padding:'2px 8px',borderRadius:6,fontSize:11,fontWeight:700}}>⏳ À compter</span>
                <strong style={{color:C.blue}}>{locActive}</strong>
                <span style={{fontSize:11,color:sub}}>(tu es ici)</span>
              </div>
              {pieceDejaComptee.autresLocs.filter((l:string)=>l.toUpperCase()!==locActive?.toUpperCase()&&l.toUpperCase()!==pieceDejaComptee.comptage.localisation?.toUpperCase()).length > 0 && (
                <div style={{fontSize:12,color:sub,marginBottom:10}}>
                  📍 Encore à compter : <strong>{pieceDejaComptee.autresLocs.filter((l:string)=>l.toUpperCase()!==locActive?.toUpperCase()&&l.toUpperCase()!==pieceDejaComptee.comptage.localisation?.toUpperCase()).join(', ')}</strong>
                </div>
              )}
              <div style={{fontSize:11,color:sub,marginBottom:10,background:dark?'#0d2a18':'#e6f4ea',borderRadius:6,padding:'8px 10px'}}>
                💡 C'est normal de compter la même pièce dans plusieurs localisations. Le système garde chaque comptage séparément par localisation.
              </div>
              <div style={{display:'flex',gap:10}}>
                <button onClick={continuerComptageDejaComptee}
                  style={{flex:2,background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'12px 0',fontSize:isMobile?15:13,fontWeight:700,cursor:'pointer'}}>
                  ✅ Compter ici aussi ({locActive})
                </button>
                <button onClick={skipPieceDejaComptee}
                  style={{flex:1,background:dark?'#333':'#e2e8f0',color:dark?'#ccc':'#475569',border:'none',borderRadius:8,padding:'12px 0',fontSize:isMobile?15:13,fontWeight:700,cursor:'pointer'}}>
                  ⏭️ Passer
                </button>
              </div>
            </div>
          )}

          {/* Alerte multi-localisation (visible pendant ET après le comptage) */}
          {multiLocInfo && !pieceDejaComptee && (etape === 'piece' || etape === 'quantite' || etape === 'photo') && (
            <div style={{background:dark?'#1a233a':'#e8f0fe',border:`2px solid ${C.blue}`,borderRadius:12,padding:'14px 16px',marginBottom:12}}>
              <div style={{fontWeight:800,fontSize:isMobile?15:14,color:C.blue,marginBottom:8}}>
                ⚠️ Cette pièce existe dans {multiLocInfo.locs.length + 1} localisations !
              </div>
              <div style={{fontSize:isMobile?13:12,color:dark?'#ccc':'#333',marginBottom:10,lineHeight:1.5}}>
                Tu dois compter cette pièce <strong>à chaque localisation séparément</strong>. Le système garde en mémoire chaque comptage.
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{background:C.green,color:'#fff',padding:'4px 12px',borderRadius:8,fontSize:isMobile?14:12,fontWeight:700}}>
                    ✅ {locActive} (ici)
                  </span>
                  <span style={{fontSize:11,color:sub}}>— en cours de comptage</span>
                </div>
                {multiLocInfo.locs.map((l: string, i: number) => (
                  <div key={i} style={{display:'flex',alignItems:'center',gap:8}}>
                    <span style={{background:C.yellow,color:'#fff',padding:'4px 12px',borderRadius:8,fontSize:isMobile?14:12,fontWeight:700}}>
                      ⏳ {l}
                    </span>
                    <span style={{fontSize:11,color:sub}}>— à compter aussi (va scanner cette localisation ensuite)</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Erreur + bouton ajouter pièce */}
          {erreur && (
            <div style={{background:pieceAjoutable?'#fff3cd':C.red+'22',border:`2px solid ${pieceAjoutable?'#ffc107':C.red}`,borderRadius:12,padding:'14px 16px',marginBottom:12,color:pieceAjoutable?'#856404':C.red,fontWeight:700,fontSize:isMobile?15:13}}>
              {erreur}
              {pieceAjoutable && locActive && (
                <div style={{marginTop:10}}>
                  <div style={{fontSize:12,fontWeight:400,marginBottom:8,color:dark?'#ccc':'#555'}}>
                    {pieceAjoutable.desc && <span>{pieceAjoutable.desc}</span>}
                    {pieceAjoutable.fournisseur && <span> — {pieceAjoutable.fournisseur}</span>}
                    {pieceAjoutable.stock != null && <span> — Stock: {pieceAjoutable.stock}</span>}
                  </div>
                  <button onClick={ajouterPieceDansLoc}
                    style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'10px 20px',fontSize:isMobile?15:13,fontWeight:700,cursor:'pointer',width:'100%'}}>
                    ➕ Ajouter "{pieceAjoutable.pk}" dans {locActive}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Tableau pièces de la localisation */}
          {locActive && piecesLoc.length > 0 && etape !== 'photo' && (
            <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden',marginTop:8}}>
              <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,background:thBg,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{fontSize:13,fontWeight:700}}>📦 {locActive} — {piecesLoc.length} pièces</span>
                <span style={{fontSize:12,color:C.green,fontWeight:700}}>{comptesDuJour.length} comptées</span>
              </div>
              {isMobile
                ? <div style={{maxHeight:300,overflowY:'auto'}}>
                    {piecesLoc.map((p:any) => {
                      const si = stockMap.get(p.code_piece)||{stock:0,reserve:0}
                      const c = comptesDuJour.find((x:any)=>x.code_piece===p.code_piece)
                      const stockTotal = si.stock + si.reserve
                      return (
                        <div key={p.code_piece} style={{padding:'12px 14px',borderBottom:`1px solid ${bdr}`,background:c?(dark?'#0d2a18':'#f0fff4'):'transparent',display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontWeight:700,fontSize:14,fontFamily:'monospace'}}>{p.code_piece}</div>
                            <div style={{fontSize:11,color:sub,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.description}</div>
                            <div style={{fontSize:12,marginTop:3,display:'flex',gap:10,flexWrap:'wrap'}}>
                              <span style={{color:stockTotal<0?C.red:C.blue,fontWeight:600}}>Stock: <strong>{stockTotal}</strong></span>
                              {si.reserve>0&&<span style={{color:C.yellow,fontWeight:600}}>Réservé: <strong>{si.reserve}</strong></span>}
                              {si.stock!==stockTotal&&<span style={{color:sub,fontSize:11}}>Dispo: {si.stock}</span>}
                            </div>
                            {/* Toutes les localisations de la pièce */}
                            <div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:4}}>
                              {[p.localisation1,p.localisation2,p.localisation3,p.localisation4].filter(Boolean).map((loc:string,i:number)=>(
                                <span key={i} style={{background:loc===locActive?(dark?'#1a233a':'#dbeafe'):dark?'#333':'#f1f5f9',color:loc===locActive?C.blue:sub,padding:'1px 6px',borderRadius:4,fontSize:10,fontWeight:loc===locActive?700:400}}>
                                  {loc}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div style={{textAlign:'right',marginLeft:10,flexShrink:0}}>
                            {c
                              ? <div>
                                  <div style={{fontSize:18,fontWeight:900,color:c.ecart===0?C.green:C.red}}>{c.qte_comptee}</div>
                                  {c.ecart!==0&&<div style={{fontSize:11,color:C.red,fontWeight:700}}>{c.ecart>0?'+':''}{c.ecart}</div>}
                                  {c.photo_url&&<div style={{fontSize:14}}>📸</div>}
                                  <button onClick={()=>{
                                    const si2 = stockMap.get(p.code_piece)||{stock:0,reserve:0}
                                    setPieceActive({...p, stockSys: si2.stock+si2.reserve, stock: si2.stock, reserve: si2.reserve})
                                    setQteInput(String(c.qte_comptee)); setEtape('quantite'); setErreur('')
                                  }} style={{background:C.blue+'22',color:C.blue,border:`1px solid ${C.blue}`,borderRadius:6,padding:'4px 10px',fontSize:12,fontWeight:700,cursor:'pointer',marginTop:4}}>
                                    ✏️ Modifier
                                  </button>
                                </div>
                              : <div style={{width:36,height:36,borderRadius:'50%',border:`2px dashed ${bdr}`,display:'flex',alignItems:'center',justifyContent:'center',color:sub,fontSize:18}}>—</div>
                            }
                          </div>
                        </div>
                      )
                    })}
                  </div>
                : <div style={{maxHeight:280,overflowY:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                      <thead><tr style={{background:thBg}}>
                        <th style={{padding:'7px 10px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`,textAlign:'left'}}>Code</th>
                        <th style={{padding:'7px 10px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`,textAlign:'left'}}>Description</th>
                        <th style={{padding:'7px 10px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>Stock sys.</th>
                        <th style={{padding:'7px 10px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.yellow,borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>Réservé</th>
                        <th style={{padding:'7px 10px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.green,borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>Compté</th>
                        <th style={{padding:'7px 10px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>Écart</th>
                      </tr></thead>
                      <tbody>
                        {piecesLoc.map((p:any) => {
                          const si = stockMap.get(p.code_piece)||{stock:0,reserve:0}
                          const c = comptesDuJour.find((x:any)=>x.code_piece===p.code_piece)
                          return (
                            <tr key={p.code_piece} style={{background:c?(dark?'#0d2a18':'#f0fff4'):'transparent'}}>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontWeight:700,fontFamily:'monospace',fontSize:11}}>{p.code_piece}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,color:sub,maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.description}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700,color:(si.stock+si.reserve)<0?C.red:'inherit'}}>{si.stock+si.reserve}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.yellow}}>{si.reserve||0}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700,color:c?C.green:sub}}>{c?c.qte_comptee:'—'}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700,color:c&&c.ecart!==0?C.red:C.green}}>{c?(c.ecart===0?'✅':(c.ecart>0?'+':'')+c.ecart):'—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
              }
            </div>
          )}
        </div>

        {/* Panneau session mobile */}
        {isMobile && locActive && comptesDuJour.length > 0 && etape !== 'photo' && (
          <div style={{background:card,borderRadius:14,border:`1px solid ${bdr}`,overflow:'hidden',marginTop:10}}>
            <div style={{padding:'12px 14px',borderBottom:`1px solid ${bdr}`,background:thBg,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontSize:14,fontWeight:700}}>📋 Comptages ({comptesDuJour.length})</span>
              <span style={{fontSize:12,color:C.red,fontWeight:700}}>{comptesDuJour.filter((c:any)=>c.ecart!==0).length} écarts</span>
            </div>
            <div style={{maxHeight:350,overflowY:'auto'}}>
              {comptesDuJour.map((c:any,i:number)=>(
                <div key={i} style={{padding:'12px 14px',borderBottom:`1px solid ${bdr}`,background:i===0?(dark?'#0d2a18':'#f0fff4'):'transparent',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:700,fontFamily:'monospace'}}>{c.code_piece}</div>
                    <div style={{fontSize:11,color:sub}}>{c.heure} {c.description?('— '+c.description):''}</div>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginLeft:8}}>
                    <div style={{textAlign:'right'}}>
                      <div style={{fontSize:20,fontWeight:900,color:c.ecart===0?C.green:C.red}}>{c.qte_comptee}</div>
                      {c.ecart!==0&&<div style={{fontSize:11,color:C.red,fontWeight:700}}>{c.ecart>0?'+':''}{c.ecart}</div>}
                    </div>
                    {c.photo_url&&<span style={{fontSize:16}}>📸</span>}
                    <button onClick={()=>{
                      const p = piecesLoc.find((x:any)=>x.code_piece===c.code_piece)
                      if (!p) return
                      const si2 = stockMap.get(c.code_piece)||{stock:0,reserve:0}
                      setPieceActive({...p, stockSys: si2.stock+si2.reserve, stock: si2.stock, reserve: si2.reserve})
                      setQteInput(String(c.qte_comptee)); setEtape('quantite'); setErreur('')
                    }} style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'8px 12px',fontSize:13,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>
                      ✏️ Modifier
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Panneau session — desktop seulement */}
        {!isMobile && (
          <div style={{background:card,borderRadius:14,border:`1px solid ${bdr}`,overflow:'hidden',position:'sticky',top:80}}>
            <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,background:thBg,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontSize:13,fontWeight:700}}>📋 Session ({comptesDuJour.length})</span>
              <span style={{fontSize:11,color:C.red,fontWeight:700}}>{comptesDuJour.filter((c:any)=>c.ecart!==0).length} écarts</span>
            </div>
            <div style={{maxHeight:450,overflowY:'auto'}}>
              {comptesDuJour.length===0
                ? <div style={{textAlign:'center',padding:24,color:sub,fontSize:12}}>Aucun comptage</div>
                : comptesDuJour.map((c:any,i:number)=>(
                    <div key={i} style={{padding:'9px 12px',borderBottom:`1px solid ${bdr}`,background:i===0?(dark?'#0d2a18':'#f0fff4'):'transparent'}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                        <div>
                          <div style={{fontSize:11,fontWeight:700}}>{c.code_piece}</div>
                          <div style={{fontSize:10,color:sub}}>{c.heure}</div>
                        </div>
                        <div style={{textAlign:'right',display:'flex',alignItems:'center',gap:6}}>
                          <div>
                            <div style={{fontSize:14,fontWeight:900,color:C.green}}>{c.qte_comptee}</div>
                            {c.ecart!==0&&<div style={{fontSize:10,fontWeight:700,color:C.red}}>{c.ecart>0?'+':''}{c.ecart}</div>}
                          </div>
                          {c.photo_url&&<span style={{fontSize:16}}>📸</span>}
                          <button onClick={()=>{
                            const p = piecesLoc.find((x:any)=>x.code_piece===c.code_piece)
                            if (!p) return
                            const si2 = stockMap.get(c.code_piece)||{stock:0,reserve:0}
                            setPieceActive({...p, stockSys: si2.stock+si2.reserve, stock: si2.stock, reserve: si2.reserve})
                            setQteInput(String(c.qte_comptee)); setEtape('quantite'); setErreur('')
                          }} style={{background:C.blue+'22',color:C.blue,border:'none',borderRadius:4,padding:'2px 6px',fontSize:10,fontWeight:700,cursor:'pointer'}}>✏️</button>
                        </div>
                      </div>
                    </div>
                  ))
              }
            </div>
          </div>
        )}
      </div>

    </>}
    {sousOnglet==='suivi' && (
      <SuiviInventaire
        dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} isMobile={isMobile}
        comptages={comptages} filtDate={filtDate} setFiltDate={setFiltDate}
        filtEmploye={filtEmploye} setFiltEmploye={setFiltEmploye}
        filtEcart={filtEcart} setFiltEcart={setFiltEcart}
        chargerComptages={chargerComptages}
        locsStats={locsStats} loadingProg={loadingProg} chargerProgression={chargerProgression}
        validationsCompta={validationsCompta}
      />
    )}


  </>
}



// ── RapportInventaire ────────────────────────────────────────────────────────

// ── SuiviInventaire ──────────────────────────────────────────────────────────
function SuiviInventaire({dark, card, bdr, sub, thBg, S, C, hvr, isMobile,
  comptages, filtDate, setFiltDate, filtEmploye, setFiltEmploye, filtEcart, setFiltEcart, chargerComptages,
  locsStats, loadingProg, chargerProgression, validationsCompta}: any) {
  const [vue, setVue] = useState<'progression'|'detail'>('progression')
  const validesComptageIds = new Set((validationsCompta||[]).filter((v:any)=>v.source==='comptage').map((v:any)=>v.ref_id))
  const comptagesNonValides = comptages.filter((c:any) => !validesComptageIds.has(c.id))
  const employes = Array.from(new Set(comptagesNonValides.map((c:any)=>c.employe))).sort() as string[]
  const cFiltres = comptagesNonValides.filter((c:any) => {
    if (filtDate && !c.date_comptage?.startsWith(filtDate)) return false
    if (filtEmploye !== 'ALL' && c.employe !== filtEmploye) return false
    if (filtEcart === 'ecart' && c.ecart === 0) return false
    if (filtEcart === 'ok' && c.ecart !== 0) return false
    return true
  })
  return (
    <div>
      {/* Toggle vue */}
      <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',justifyContent:'space-between',alignItems:'center'}}>
        <div style={{display:'flex',gap:8}}>
          <button onClick={()=>setVue('progression')} style={{padding:'8px 16px',borderRadius:20,border:`2px solid ${vue==='progression'?C.green:bdr}`,background:vue==='progression'?(dark?'#0d2a18':'#e6f4ea'):'transparent',color:vue==='progression'?C.green:sub,fontWeight:700,cursor:'pointer',fontSize:13}}>
            📈 Progression
          </button>
          <button onClick={()=>setVue('detail')} style={{padding:'8px 16px',borderRadius:20,border:`2px solid ${vue==='detail'?C.blue:bdr}`,background:vue==='detail'?(dark?'#1a233a':'#e8f0fe'):'transparent',color:vue==='detail'?C.blue:sub,fontWeight:700,cursor:'pointer',fontSize:13}}>
            📋 Détail des comptages
          </button>
        </div>
        <button onClick={async()=>{
          if(!confirm('⚠️ Effacer TOUS les comptages et sessions ? Cette action est irréversible.')) return
          await Promise.all([
            fetch('/api/inventaire/comptages?all=1', {method:'DELETE'}),
            fetch('/api/inventaire/session?all=1', {method:'DELETE'}),
          ])
          chargerComptages(); chargerProgression()
        }} style={{background:'#e53e3e22',color:'#e53e3e',border:'1px solid #e53e3e',borderRadius:8,padding:'6px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
          🗑️ Effacer tout (test)
        </button>
      </div>

      {vue==='progression' && (() => {
        return (
    <div>
      {/* Onglet Progression */}
      <div style={{marginBottom:14,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div style={{fontWeight:700,fontSize:16}}>📈 Progression de l'inventaire</div>
        <button onClick={chargerProgression} disabled={loadingProg}
          style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:13}}>
          {loadingProg?'⏳ Chargement...':'🔄 Actualiser'}
        </button>
      </div>
      {loadingProg
        ? <div style={{textAlign:'center',padding:40,color:sub}}>⏳ Chargement...</div>
        : locsStats.length === 0
          ? <div style={{textAlign:'center',padding:40,color:sub}}>
              <div style={{fontSize:30,marginBottom:8}}>📦</div>
              <div>Aucun comptage enregistré</div>
            </div>
          : <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {locsStats.map((ls:any) => {
                const pct = ls.pct
                const couleur = pct===100?C.green:pct!=null&&pct>50?C.blue:pct!=null?C.yellow:'#64748b'
                const barWidth = pct!=null ? pct : (ls.total_pieces>0 ? Math.min(100,Math.round(ls.nb_comptes/ls.total_pieces*100)) : 0)
                return (
                <div key={ls.localisation} style={{background:card,borderRadius:12,border:`1px solid ${pct===100?C.green:bdr}`,padding:'14px 16px',borderLeft:`4px solid ${couleur}`}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8,flexWrap:'wrap',gap:6}}>
                    <div style={{fontWeight:800,fontSize:16,fontFamily:'monospace'}}>{ls.localisation}</div>
                    <div style={{display:'flex',alignItems:'center',gap:10}}>
                      <span style={{fontSize:12,color:sub}}>
                        {ls.nb_comptes} comptée{ls.nb_comptes>1?'s':''}
                        {ls.total_pieces>0 && <span> / {ls.total_pieces} total</span>}
                      </span>
                      <span style={{background:couleur,color:'#fff',padding:'3px 10px',borderRadius:20,fontWeight:700,fontSize:13}}>
                        {pct!=null ? pct+'%' : ls.nb_comptes+' pièce'+(ls.nb_comptes>1?'s':'')}
                      </span>
                    </div>
                  </div>
                  {/* Barre de progression */}
                  <div style={{height:8,background:dark?'#333':'#e2e8f0',borderRadius:4,marginBottom:10,overflow:'hidden'}}>
                    <div style={{height:'100%',width:barWidth+'%',background:couleur,borderRadius:4,transition:'width 0.5s'}}/>
                  </div>
                  {/* Employés avec % individuel */}
                  {ls.employes.length > 0 && (
                    <div style={{display:'flex',flexDirection:'column',gap:6,marginTop:4}}>
                      {ls.employes.map((e:any) => (
                        <div key={e.employe} style={{background:dark?'#1a1a1a':'#f8f9fa',borderRadius:8,padding:'8px 12px'}}>
                          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                            <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                              <span style={{fontWeight:700,color:C.blue,fontSize:13}}>👤 {e.employe}</span>
                              <span style={{color:sub,fontSize:12}}>
                                {e.nb}/{ls.total_pieces||e.nb_attendues} pièces
                              </span>
                            </div>
                            <span style={{background:e.pct===100?C.green:e.pct!=null&&e.pct>50?C.blue:e.pct!=null?C.yellow:'#94a3b8',color:'#fff',padding:'2px 8px',borderRadius:12,fontWeight:700,fontSize:11}}>
                              {e.pct != null ? e.pct+'%' : '?'}
                            </span>
                          </div>
                          <div style={{height:4,background:dark?'#333':'#e2e8f0',borderRadius:2,overflow:'hidden'}}>
                            <div style={{height:'100%',width:(e.pct||0)+'%',background:e.pct===100?C.green:e.pct!=null&&e.pct>50?C.blue:C.yellow,borderRadius:2,transition:'width 0.5s'}}/>
                          </div>
                          {e.derniere_date && (
                            <div style={{color:sub,fontSize:10,marginTop:3}}>
                              Dernière: <strong>{e.derniere_piece}</strong> — {new Date(e.derniere_date).toLocaleDateString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
                            </div>
                          )}
                          {/* Pièces comptées */}
                          {e.pieces_comptees && e.pieces_comptees.length > 0 && (
                            <div style={{marginTop:6,background:dark?'#0d2a18':'#e6f4ea',borderRadius:6,padding:'6px 8px'}}>
                              <div style={{fontSize:10,fontWeight:700,color:C.green,marginBottom:3}}>
                                ✅ {e.pieces_comptees.length} pièce{e.pieces_comptees.length>1?'s':''} comptée{e.pieces_comptees.length>1?'s':''}
                              </div>
                              <div style={{fontSize:10,color:sub,fontFamily:'monospace',lineHeight:1.8,flexWrap:'wrap',display:'flex',gap:'4px 8px'}}>
                                {e.pieces_comptees.slice().sort().map((p:string) => (
                                  <span key={p} style={{background:dark?'#1a2a1a':'#d1fae5',color:C.green,padding:'1px 4px',borderRadius:3}}>{p}</span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                )
              })}
            </div>
      }
    </div>
        )
      })()}

      {vue==='detail' && (() => {
        return (
    <div>
      {/* Rapport */}
      <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,padding:'12px 16px',marginBottom:12,display:'flex',gap:10,flexWrap:'wrap',alignItems:'flex-end'}}>
        <div style={{flex:1,minWidth:isMobile?'100%':130}}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:4}}>Date</div>
          <input type="date" value={filtDate} onChange={e=>setFiltDate(e.target.value)} style={S}/>
        </div>
        <div style={{flex:1,minWidth:isMobile?'45%':130}}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:4}}>Employé</div>
          <select value={filtEmploye} onChange={e=>setFiltEmploye(e.target.value)} style={S}>
            <option value="ALL">Tous</option>
            {employes.map((e:string)=><option key={e} value={e}>{e}</option>)}
          </select>
        </div>
        <div style={{flex:1,minWidth:isMobile?'45%':130}}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:4}}>Écarts</div>
          <select value={filtEcart} onChange={e=>setFiltEcart(e.target.value)} style={S}>
            <option value="ALL">Tous</option>
            <option value="ecart">Avec écart</option>
            <option value="ok">Sans écart</option>
          </select>
        </div>
        <button onClick={chargerComptages} style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer'}}>🔄</button>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <div style={{background:dark?'#2b1113':'#fce8e6',border:`2px solid ${C.red}`,borderRadius:10,padding:'8px 14px',textAlign:'center',minWidth:100}}>
            <div style={{fontSize:10,fontWeight:700,color:C.red,textTransform:'uppercase'}}>Écarts</div>
            <div style={{fontSize:20,fontWeight:900,color:C.red}}>{cFiltres.filter((c:any)=>c.ecart!==0).length}</div>
          </div>
          <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`2px solid ${C.green}`,borderRadius:10,padding:'8px 14px',textAlign:'center',minWidth:100}}>
            <div style={{fontSize:10,fontWeight:700,color:C.green,textTransform:'uppercase'}}>Total</div>
            <div style={{fontSize:20,fontWeight:900,color:C.green}}>{cFiltres.length}</div>
          </div>
        </div>
      </div>

      {isMobile
        ? <div style={{display:'flex',flexDirection:'column',gap:10}}>
            {cFiltres.length===0
              ? <div style={{textAlign:'center',padding:40,color:sub}}>Aucun comptage</div>
              : cFiltres.map((c:any)=>{
                  const estReconcilie = c.statut === 'reconcilie'
                  const ecartFinal = estReconcilie ? c.ecart_reconcilie : c.ecart
                  return (
                    <div key={c.id} style={{background:card,borderRadius:12,border:`2px solid ${ecartFinal!==0&&ecartFinal!==null?C.red:estReconcilie?C.green:C.yellow}`,padding:'14px 16px'}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
                        <div>
                          <div style={{fontWeight:800,fontSize:15,fontFamily:'monospace'}}>{c.code_piece}</div>
                          <div style={{fontSize:12,color:sub,marginTop:2}}>
                            <span style={{background:dark?'#1a233a':'#e8f0fe',color:C.blue,padding:'2px 6px',borderRadius:4,fontWeight:600}}>{c.localisation}</span>
                          </div>
                        </div>
                        <div style={{textAlign:'right'}}>
                          {estReconcilie
                            ? <>
                                <div style={{fontSize:10,color:sub}}>Écart réconcilié</div>
                                <div style={{fontSize:22,fontWeight:900,color:ecartFinal===0?C.green:C.red}}>{ecartFinal>0?'+':''}{ecartFinal}</div>
                                <span style={{background:C.green+'22',color:C.green,padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>✅ Réconcilié</span>
                              </>
                            : <>
                                <div style={{fontSize:10,color:sub}}>Écart brut</div>
                                <div style={{fontSize:22,fontWeight:900,color:C.yellow}}>{c.ecart>0?'+':''}{c.ecart}</div>
                                <span style={{background:C.yellow+'22',color:C.yellow,padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>⏳ En attente</span>
                              </>
                          }
                          {c.photo_url&&(
                          <div style={{marginTop:8}}>
                            <div style={{fontSize:10,color:sub,marginBottom:3,fontWeight:700,textTransform:'uppercase'}}>📸 Photo</div>
                            <a href={c.photo_url} target="_blank" rel="noreferrer">
                              <img src={c.photo_url} onError={(e:any)=>{e.target.style.display='none';e.target.parentElement.innerHTML='📸 <span style="font-size:10px;color:#888">Photo indisponible</span>'}} style={{width:'100%',maxWidth:120,height:80,objectFit:'cover',borderRadius:8,border:`2px solid ${C.green}`,display:'block'}} alt="Photo comptage"/>
                            </a>
                          </div>
                        )}
                        </div>
                      </div>
                      <div style={{background:dark?'#1a1a1a':'#f8f9fa',borderRadius:8,padding:'8px 10px',marginBottom:6}}>
                        <div style={{display:'flex',gap:12,fontSize:12,flexWrap:'wrap'}}>
                          <span style={{color:sub}}>Stock comptage: <strong style={{color:C.blue}}>{c.qte_systeme}</strong></span>
                          {estReconcilie&&<span style={{color:sub}}>Stock J+1: <strong style={{color:C.blue}}>{c.stock_apres_sync}</strong></span>}
                          <span style={{color:sub}}>Compté: <strong style={{color:C.green}}>{c.qte_comptee}</strong></span>
                        </div>
                        {c.photo_url&&(
                          <div style={{marginTop:8}}>
                            <a href={c.photo_url} target="_blank" rel="noreferrer">
                              <img src={c.photo_url} onError={(e:any)=>{e.target.style.display='none';e.target.parentElement.innerHTML='📸 <span style="font-size:10px;color:#888">Photo indisponible</span>'}} style={{width:'100%',maxWidth:140,height:90,objectFit:'cover',borderRadius:8,border:`2px solid ${C.green}`,display:'block'}} alt="Photo écart"/>
                            </a>
                            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:4}}>
                              <div style={{fontSize:10,color:C.green,fontWeight:700}}>📸 Photo de l'écart</div>
                              <a href={c.photo_url} download target="_blank" rel="noreferrer" style={{fontSize:11,color:C.blue,fontWeight:700,textDecoration:'none',background:C.blue+'22',padding:'2px 8px',borderRadius:6}}>⬇ Télécharger</a>
                            </div>
                          </div>
                        )}
                        {estReconcilie&&c.ecart!==c.ecart_reconcilie&&(
                          <div style={{fontSize:11,color:sub,marginTop:4}}>
                            Ventes entre-temps: <strong style={{color:C.blue}}>{c.qte_systeme - c.stock_apres_sync}</strong> unités vendues après le comptage
                          </div>
                        )}
                      </div>
                      {estReconcilie&&c.date_reconciliation&&(
                        <div style={{fontSize:10,color:sub}}>
                          Réconcilié le {new Date(c.date_reconciliation).toLocaleDateString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
                        </div>
                      )}
                      <div style={{fontSize:11,color:sub,marginTop:4}}>👤 {c.employe} — {new Date(c.date_comptage).toLocaleDateString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
                    </div>
                  )
                })
            }
          </div>
        : <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead><tr style={{background:thBg}}>
                  {['Code Pièce','Localisation','Stock comptage','Stock J+1','Compté','Écart brut','Écart réconcilié','Statut','Photo','Employé','Date'].map((h,i)=>(
                    <th key={i} style={{padding:'9px 10px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:i>1?'center':'left'}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {cFiltres.length===0
                    ? <tr><td colSpan={11} style={{textAlign:'center',padding:50,color:sub}}>Aucun comptage</td></tr>
                    : cFiltres.map((c:any)=>{
                        const estReconcilie = c.statut === 'reconcilie'
                        const ecartFinal = estReconcilie ? c.ecart_reconcilie : c.ecart
                        const bgRow = ecartFinal!==0&&ecartFinal!==null?(dark?'#2b1113':'#fff8f8'):'transparent'
                        return (
                          <tr key={c.id} style={{background:bgRow}}
                            onMouseEnter={e=>e.currentTarget.style.background=ecartFinal!==0?(dark?'#3a1a1a':'#ffe8e8'):hvr}
                            onMouseLeave={e=>e.currentTarget.style.background=bgRow}>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,fontWeight:700,fontFamily:'monospace',fontSize:11}}>{c.code_piece}</td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`}}>
                              <span style={{background:dark?'#1a233a':'#e8f0fe',color:C.blue,padding:'2px 6px',borderRadius:4,fontSize:11,fontWeight:600}}>{c.localisation}</span>
                            </td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700}}>{c.qte_systeme}</td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700,color:estReconcilie?C.blue:sub}}>
                              {estReconcilie ? c.stock_apres_sync : '—'}
                            </td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700,color:C.green}}>{c.qte_comptee}</td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700,color:c.ecart===0?C.green:sub,fontSize:11}}>{c.ecart>0?'+':''}{c.ecart}</td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:900,color:!estReconcilie?sub:ecartFinal===0?C.green:C.red}}>
                              {estReconcilie ? (ecartFinal>0?'+':'')+ecartFinal : '⏳'}
                            </td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                              {estReconcilie
                                ? <span style={{background:C.green+'22',color:C.green,padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>✅ Réconcilié</span>
                                : <span style={{background:C.yellow+'22',color:C.yellow,padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>⏳ En attente</span>
                              }
                            </td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                              {c.photo_url?<a href={c.photo_url} target="_blank" rel="noreferrer" style={{color:C.blue,textDecoration:'none',fontSize:18}}>📸</a>:<span style={{color:sub,fontSize:11}}>—</span>}
                            </td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`}}>
                              <span style={{background:C.blue+'22',color:C.blue,padding:'2px 6px',borderRadius:10,fontSize:10}}>👤 {c.employe}</span>
                            </td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:sub,fontSize:11,whiteSpace:'nowrap'}}>
                              {new Date(c.date_comptage).toLocaleDateString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
                            </td>
                          </tr>
                        )
                      })
                  }
                </tbody>
              </table>
            </div>
          </div>
      }
    </div>
        )
      })()}
    </div>
  )
}


function ProgressionInventaire({dark, card, bdr, sub, C, isMobile, locsStats, loadingProg, chargerProgression}: any) {
  const [locExpand, setLocExpand] = useState<string|null>(null)
  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14,flexWrap:'wrap',gap:8}}>
        <div style={{fontWeight:700,fontSize:15,color:sub}}>
          {locsStats.length} localisation{locsStats.length>1?'s':''} comptée{locsStats.length>1?'s':''}
        </div>
        <button onClick={chargerProgression} disabled={loadingProg}
          style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:13}}>
          {loadingProg?'⏳':'🔄'} Actualiser
        </button>
      </div>

      {loadingProg
        ? <div style={{textAlign:'center',padding:60,color:sub}}>⏳ Chargement...</div>
        : locsStats.length === 0
          ? <div style={{textAlign:'center',padding:60,color:sub}}>
              <div style={{fontSize:36,marginBottom:10}}>📦</div>
              <div style={{fontWeight:600}}>Aucun comptage enregistré</div>
              <div style={{fontSize:13,marginTop:6}}>Scannez une localisation dans l'onglet Compter</div>
            </div>
          : <div style={{display:'flex',flexDirection:'column',gap:12}}>
              {locsStats.map((ls:any) => {
                const pct = ls.pct
                const couleur = pct===100?C.green:pct!=null&&pct>50?C.blue:pct!=null?C.yellow:'#64748b'
                const isExpanded = locExpand === ls.localisation
                return (
                  <div key={ls.localisation} style={{background:card,borderRadius:14,border:`1px solid ${pct===100?C.green:bdr}`,overflow:'hidden'}}>
                    {/* Header localisation */}
                    <div onClick={()=>setLocExpand(isExpanded?null:ls.localisation)}
                      style={{padding:'14px 16px',cursor:'pointer',borderLeft:`5px solid ${couleur}`,display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
                      <div>
                        <div style={{fontWeight:900,fontSize:17,fontFamily:'monospace',letterSpacing:1}}>{ls.localisation}</div>
                        <div style={{fontSize:12,color:sub,marginTop:3}}>
                          {ls.nb_comptes} / {ls.total_pieces>0?ls.total_pieces:'?'} pièces comptées
                          {ls.employes.length>0 && <span style={{marginLeft:8}}>• {ls.employes.map((e:any)=>e.employe).join(', ')}</span>}
                        </div>
                      </div>
                      <div style={{display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
                        <span style={{background:couleur,color:'#fff',padding:'4px 12px',borderRadius:20,fontWeight:900,fontSize:14}}>
                          {pct!=null?pct+'%':ls.nb_comptes+'✓'}
                        </span>
                        <span style={{color:sub,fontSize:16}}>{isExpanded?'▲':'▼'}</span>
                      </div>
                    </div>

                    {/* Barre de progression */}
                    <div style={{height:6,background:dark?'#2a2a2a':'#e2e8f0'}}>
                      <div style={{height:'100%',width:(pct||0)+'%',background:couleur,transition:'width 0.5s'}}/>
                    </div>

                    {/* Détail expandable */}
                    {isExpanded && (
                      <div style={{padding:'12px 16px',borderTop:`1px solid ${bdr}`}}>
                        {/* Stats par employé */}
                        {ls.employes.map((e:any) => (
                          <div key={e.employe} style={{marginBottom:12,background:dark?'#1a1a1a':'#f8f9fa',borderRadius:10,padding:'10px 12px'}}>
                            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                              <div>
                                <span style={{fontWeight:700,color:C.blue}}>👤 {e.employe}</span>
                                <span style={{color:sub,fontSize:12,marginLeft:8}}>{e.nb}/{e.total>0?e.total:'?'} pièces</span>
                              </div>
                              <span style={{background:e.pct===100?C.green:e.pct!=null&&e.pct>50?C.blue:e.pct!=null?C.yellow:'#64748b',color:'#fff',padding:'2px 8px',borderRadius:10,fontWeight:700,fontSize:12}}>
                                {e.pct!=null?e.pct+'%':e.nb+'✓'}
                              </span>
                            </div>
                            {/* Barre employé */}
                            <div style={{height:4,background:dark?'#333':'#e2e8f0',borderRadius:2,marginBottom:8,overflow:'hidden'}}>
                              <div style={{height:'100%',width:(e.pct||0)+'%',background:e.pct===100?C.green:e.pct!=null&&e.pct>50?C.blue:C.yellow,transition:'width 0.5s'}}/>
                            </div>
                            {e.derniere_date && (
                              <div style={{fontSize:11,color:sub,marginBottom:8}}>
                                Dernière: <strong>{e.derniere_piece}</strong> — {new Date(e.derniere_date).toLocaleDateString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
                              </div>
                            )}
                            {/* Pièces comptées */}
                            {e.pieces_comptees.length>0 && (
                              <div style={{marginBottom:6}}>
                                <div style={{fontSize:11,fontWeight:700,color:C.green,marginBottom:4}}>✅ Comptées ({e.pieces_comptees.length})</div>
                                <div style={{display:'flex',flexWrap:'wrap',gap:'3px 6px'}}>
                                  {e.pieces_comptees.map((p:string)=>(
                                    <span key={p} style={{background:dark?'#0d2a18':'#d1fae5',color:C.green,padding:'2px 6px',borderRadius:4,fontSize:10,fontFamily:'monospace'}}>{p}</span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {/* Pièces manquantes */}
                            {e.pieces_manquantes.length>0 && (
                              <div>
                                <div style={{fontSize:11,fontWeight:700,color:C.red,marginBottom:4}}>⬜ Manquantes ({e.pieces_manquantes.length})</div>
                                <div style={{display:'flex',flexWrap:'wrap',gap:'3px 6px'}}>
                                  {e.pieces_manquantes.map((p:string)=>(
                                    <span key={p} style={{background:dark?'#2b1113':'#fee2e2',color:C.red,padding:'2px 6px',borderRadius:4,fontSize:10,fontFamily:'monospace'}}>{p}</span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
      }
    </div>
  )
}



function UtilisateursTab({dark, card, bdr, sub, thBg, S, C, hvr}: any) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showInvite, setShowInvite] = useState(false)
  const [invEmail, setInvEmail] = useState('')
  const [invNom, setInvNom] = useState('')
  const [invRole, setInvRole] = useState('commis')
  const [invLoading, setInvLoading] = useState(false)
  const [msgOk, setMsgOk] = useState('')
  const [erreur, setErreur] = useState('')
  const [editUser, setEditUser] = useState<any>(null)
  const [editOnglets, setEditOnglets] = useState<string[]>([])
  const [editLoading, setEditLoading] = useState(false)

  // Tous les onglets disponibles
  const TOUS_ONGLETS = [
    { id: 'calc',        label: '🧮 Calculateur Achats',  desc: 'Calcul des achats et stocks' },
    { id: 'import',      label: '📥 Importer Ventes',     desc: 'Import des données de ventes' },
    { id: 'booking',     label: '📅 Booking',             desc: 'Planification et réservations' },
    { id: 'retours',     label: '🔄 Retours RMA',         desc: 'Gestion des retours fournisseurs' },
    { id: 'negatifs',    label: '🔴 Pièces Négatives',    desc: 'Suivi des pièces en négatif' },
    { id: 'commandes',   label: '📋 Commandes du jour',   desc: 'Commandes journalières' },
    { id: 'commandes_attente', label: '⏳ Commandes en attente', desc: 'Suivi des commandes Traction non reçues' },
    { id: 'fournitures', label: '💡 Suggestions',         desc: 'Suggestions de réapprovisionnement' },
    { id: 'inventaire',  label: '📦 Inventaire',          desc: 'Inventaire cyclique et comptage' },
    { id: 'comptabilite',label: '💰 Comptabilité',        desc: 'Validation comptable et historique' },
    { id: 'amazon',      label: '📦 Amazon',              desc: 'Réconciliation FBA/FBM et LAUTOPAK' },
    { id: 'scoa',        label: '🏍 SCOA',                desc: 'Analyse ventes PS / Bateau neuf & usagé' },
    { id: 'utilisateurs',label: '👥 Utilisateurs',        desc: 'Gestion des accès et utilisateurs' },
  ]

  const ROLES_LEGACY: Record<string, string[]> = {
    admin:         ['calc','import','booking','retours','negatifs','commandes','commandes_attente','fournitures','inventaire','comptabilite','amazon','scoa','utilisateurs'],
    gestionnaire:  ['calc','import','booking','retours','negatifs','commandes','commandes_attente','fournitures','inventaire','comptabilite','amazon','scoa'],
    commis:        ['commandes','commandes_attente','fournitures','retours'],
    employe_piece: ['commandes_attente','fournitures','negatifs','inventaire','retours'],
  }

  const ROLES = [
    {val:'admin',        label:'Admin',         color:C.red},
    {val:'gestionnaire', label:'Gestionnaire',   color:C.blue},
    {val:'commis',       label:'Commis',         color:C.green},
    {val:'employe_piece',label:'Employé pièce',  color:C.yellow},
  ]

  useEffect(() => { chargerUsers() }, [])

  async function chargerUsers() {
    setLoading(true)
    const r = await fetch('/api/auth/users')
    if (r.ok) setUsers(await r.json())
    setLoading(false)
  }

  function getOngletsEffectifs(u: any): string[] {
    const base = (u.onglets_custom && Array.isArray(u.onglets_custom) && u.onglets_custom.length > 0)
      ? u.onglets_custom
      : (ROLES_LEGACY[u.role] || ROLES_LEGACY['commis'])
    // Onglets forcés pour tout le monde (cf. ONGLETS_FORCES_TOUS dans Dashboard)
    return [...new Set([...base, 'commandes_attente'])]
  }

  function ouvrirEdit(u: any) {
    setEditUser(u)
    setEditOnglets(getOngletsEffectifs(u))
    setErreur('')
  }

  async function sauvegarderOnglets() {
    if (!editUser) return
    setEditLoading(true)
    await fetch('/api/auth/users', {
      method: 'PATCH',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ id: editUser.id, onglets_custom: editOnglets })
    })
    await chargerUsers()
    setEditUser(null)
    setEditLoading(false)
    setMsgOk(`✅ Accès de ${editUser.nom} mis à jour`)
    setTimeout(() => setMsgOk(''), 4000)
  }

  function toggleOnglet(id: string) {
    setEditOnglets(prev =>
      prev.includes(id) ? prev.filter(o => o !== id) : [...prev, id]
    )
  }

  async function inviter(e: any) {
    e.preventDefault()
    setInvLoading(true); setErreur('')
    const r = await fetch('/api/auth/invite', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email: invEmail, nom: invNom, role: invRole })
    })
    const j = await r.json()
    if (j.erreur) setErreur(j.erreur)
    else {
      setMsgOk(`✅ Invitation envoyée à ${invEmail}`)
      setInvEmail(''); setInvNom(''); setInvRole('commis')
      setShowInvite(false)
      await chargerUsers()
      setTimeout(() => setMsgOk(''), 4000)
    }
    setInvLoading(false)
  }

  async function toggleActif(id: string, actif: boolean) {
    await fetch('/api/auth/users', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, actif }) })
    await chargerUsers()
  }

  async function supprimer(id: string, nom: string) {
    if (!confirm(`Supprimer ${nom} ?`)) return
    await fetch('/api/auth/users', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id }) })
    await chargerUsers()
  }

  return (
    <div>
      {/* ── Modal Modifier Accès ── */}
      {editUser && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
          <div style={{background:card,borderRadius:20,padding:28,width:'100%',maxWidth:520,border:`1px solid ${bdr}`,boxShadow:'0 24px 80px rgba(0,0,0,.4)',maxHeight:'90vh',overflowY:'auto'}}>
            {/* Header modal */}
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
              <div>
                <div style={{fontWeight:800,fontSize:18}}>🔐 Accès de {editUser.nom}</div>
                <div style={{color:sub,fontSize:13,marginTop:2}}>{editUser.email}</div>
              </div>
              <button onClick={()=>setEditUser(null)}
                style={{background:'none',border:`1px solid ${bdr}`,borderRadius:8,padding:'6px 12px',cursor:'pointer',color:sub,fontSize:20}}>✕</button>
            </div>

            {/* Raccourcis */}
            <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
              <button onClick={()=>setEditOnglets(TOUS_ONGLETS.map(o=>o.id))}
                style={{background:C.blue+'22',color:C.blue,border:`1px solid ${C.blue}`,borderRadius:8,padding:'5px 12px',fontSize:12,fontWeight:700,cursor:'pointer'}}>
                ✅ Tout cocher
              </button>
              <button onClick={()=>setEditOnglets([])}
                style={{background:C.red+'22',color:C.red,border:`1px solid ${C.red}`,borderRadius:8,padding:'5px 12px',fontSize:12,fontWeight:700,cursor:'pointer'}}>
                ☐ Tout décocher
              </button>
              {ROLES.map(r => (
                <button key={r.val} onClick={()=>setEditOnglets(ROLES_LEGACY[r.val]||[])}
                  style={{background:r.color+'22',color:r.color,border:`1px solid ${r.color}`,borderRadius:8,padding:'5px 12px',fontSize:12,fontWeight:700,cursor:'pointer'}}>
                  {r.label}
                </button>
              ))}
            </div>

            {/* Checkboxes onglets */}
            <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:24}}>
              {TOUS_ONGLETS.map(o => {
                const checked = editOnglets.includes(o.id)
                return (
                  <div key={o.id} onClick={()=>toggleOnglet(o.id)}
                    style={{display:'flex',alignItems:'center',gap:14,padding:'12px 16px',borderRadius:12,border:`2px solid ${checked?C.blue:bdr}`,background:checked?(dark?'#1a233a':'#e8f0fe'):'transparent',cursor:'pointer',transition:'all .15s'}}>
                    <div style={{width:22,height:22,borderRadius:6,border:`2px solid ${checked?C.blue:sub}`,background:checked?C.blue:'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,transition:'all .15s'}}>
                      {checked && <span style={{color:'#fff',fontSize:14,fontWeight:900}}>✓</span>}
                    </div>
                    <div>
                      <div style={{fontWeight:700,fontSize:14,color:checked?C.blue:'inherit'}}>{o.label}</div>
                      <div style={{fontSize:12,color:sub,marginTop:1}}>{o.desc}</div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Résumé */}
            <div style={{background:dark?'#1a1a1a':'#f8f9fa',borderRadius:10,padding:'10px 14px',marginBottom:20,fontSize:12,color:sub}}>
              <strong style={{color:C.blue}}>{editOnglets.length}</strong> onglet{editOnglets.length>1?'s':''} sélectionné{editOnglets.length>1?'s':''}
              {editOnglets.length > 0 && <span style={{marginLeft:6}}>→ {editOnglets.map(id=>TOUS_ONGLETS.find(o=>o.id===id)?.label.replace(/^[\S]+\s/,'')||id).join(', ')}</span>}
            </div>

            {/* Boutons */}
            <div style={{display:'flex',gap:10}}>
              <button onClick={()=>setEditUser(null)}
                style={{flex:1,background:'none',border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 0',cursor:'pointer',color:sub,fontWeight:600,fontSize:14}}>
                Annuler
              </button>
              <button onClick={sauvegarderOnglets} disabled={editLoading}
                style={{flex:2,background:C.blue,color:'#fff',border:'none',borderRadius:10,padding:'12px 0',fontWeight:700,cursor:'pointer',fontSize:14}}>
                {editLoading?'Sauvegarde...':'💾 Sauvegarder les accès'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Invitation ── */}
      {showInvite && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
          <div style={{background:card,borderRadius:20,padding:28,width:'100%',maxWidth:460,border:`1px solid ${bdr}`,boxShadow:'0 24px 80px rgba(0,0,0,.4)'}}>
            <h3 style={{margin:'0 0 6px',fontSize:18,fontWeight:800}}>📧 Inviter un utilisateur</h3>
            <p style={{color:sub,fontSize:13,margin:'0 0 20px'}}>Un email d'invitation sera envoyé automatiquement.</p>
            {erreur && <div style={{background:C.red+'22',border:`1px solid ${C.red}`,borderRadius:8,padding:'10px 14px',marginBottom:12,color:C.red,fontSize:13}}>{erreur}</div>}
            <form onSubmit={inviter}>
              <div style={{marginBottom:12}}>
                <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:4}}>Nom complet *</label>
                <input value={invNom} onChange={e=>setInvNom(e.target.value)} placeholder="Ex: Marie Tremblay" required style={S}/>
              </div>
              <div style={{marginBottom:12}}>
                <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:4}}>Email *</label>
                <input type="email" value={invEmail} onChange={e=>setInvEmail(e.target.value)} placeholder="marie@mathiasmarine.com" required style={S}/>
              </div>
              <div style={{marginBottom:20}}>
                <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:8}}>Rôle initial *</label>
                <select value={invRole} onChange={e=>setInvRole(e.target.value)} style={S}>
                  {ROLES.map(r=><option key={r.val} value={r.val}>{r.label}</option>)}
                </select>
                <div style={{fontSize:11,color:sub,marginTop:4}}>Vous pourrez ajuster les accès précis après l'invitation.</div>
              </div>
              <div style={{display:'flex',gap:10}}>
                <button type="button" onClick={()=>{setShowInvite(false);setErreur('')}}
                  style={{flex:1,background:'none',border:`1px solid ${bdr}`,borderRadius:10,padding:'11px 0',cursor:'pointer',color:sub,fontWeight:600}}>
                  Annuler
                </button>
                <button type="submit" disabled={invLoading}
                  style={{flex:2,background:C.blue,color:'#fff',border:'none',borderRadius:10,padding:'11px 0',fontWeight:700,cursor:'pointer',fontSize:14}}>
                  {invLoading?'Envoi...':'📧 Envoyer invitation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20,flexWrap:'wrap',gap:10}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:800}}>👥 Gestion des utilisateurs</h2>
          <p style={{color:sub,fontSize:13,margin:'4px 0 0'}}>{users.length} utilisateur{users.length>1?'s':''}</p>
        </div>
        <button onClick={()=>setShowInvite(true)}
          style={{background:C.blue,color:'#fff',border:'none',borderRadius:10,padding:'10px 20px',fontSize:14,fontWeight:700,cursor:'pointer'}}>
          + Inviter un utilisateur
        </button>
      </div>

      {msgOk && <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`1px solid ${C.green}`,borderRadius:10,padding:'12px 16px',marginBottom:16,color:C.green,fontWeight:700}}>{msgOk}</div>}

      {/* ── Liste utilisateurs ── */}
      {loading
        ? <div style={{textAlign:'center',padding:60,color:sub}}>Chargement...</div>
        : users.length === 0
          ? <div style={{textAlign:'center',padding:60,color:sub}}>
              <div style={{fontSize:40,marginBottom:10}}>👥</div>
              <p>Aucun utilisateur — invitez le premier !</p>
            </div>
          : <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {users.map((u:any) => {
                const onglets = getOngletsEffectifs(u)
                const aCustom = u.onglets_custom && Array.isArray(u.onglets_custom) && u.onglets_custom.length > 0
                const roleInfo = ROLES.find(r=>r.val===u.role) || ROLES[2]
                return (
                  <div key={u.id} style={{background:card,borderRadius:14,border:`1px solid ${bdr}`,padding:'16px 20px',display:'flex',alignItems:'center',gap:16,flexWrap:'wrap'}}>
                    {/* Avatar */}
                    <div style={{width:44,height:44,borderRadius:'50%',background:roleInfo.color+'33',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>
                      {(u.nom||'?')[0].toUpperCase()}
                    </div>
                    {/* Info */}
                    <div style={{flex:1,minWidth:180}}>
                      <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                        <span style={{fontWeight:800,fontSize:15}}>{u.nom}</span>
                        <span style={{background:u.actif?C.green+'22':C.red+'22',color:u.actif?C.green:C.red,padding:'2px 8px',borderRadius:10,fontSize:11,fontWeight:700}}>
                          {u.actif?'✅ Actif':'🚫 Inactif'}
                        </span>
                        <span style={{background:roleInfo.color+'22',color:roleInfo.color,padding:'2px 8px',borderRadius:10,fontSize:11,fontWeight:700}}>
                          {roleInfo.label}
                        </span>
                        {aCustom && <span style={{background:C.blue+'22',color:C.blue,padding:'2px 8px',borderRadius:10,fontSize:11,fontWeight:700}}>Accès personnalisé</span>}
                      </div>
                      <div style={{fontSize:12,color:sub,marginTop:3}}>{u.email}</div>
                      {/* Onglets actifs */}
                      <div style={{display:'flex',flexWrap:'wrap',gap:'3px 6px',marginTop:8}}>
                        {TOUS_ONGLETS.filter(o=>onglets.includes(o.id)).map(o=>(
                          <span key={o.id} style={{background:dark?'#1a233a':'#e8f0fe',color:C.blue,padding:'2px 8px',borderRadius:6,fontSize:11,fontWeight:600}}>
                            {o.label.replace(/^[\S]+\s/,'')}
                          </span>
                        ))}
                      </div>
                    </div>
                    {/* Actions */}
                    <div style={{display:'flex',gap:8,flexShrink:0}}>
                      <button onClick={()=>ouvrirEdit(u)}
                        style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'8px 16px',fontSize:13,fontWeight:700,cursor:'pointer'}}>
                        🔐 Modifier accès
                      </button>
                      <button onClick={()=>toggleActif(u.id,!u.actif)}
                        style={{background:u.actif?C.yellow+'22':C.green+'22',color:u.actif?C.yellow:C.green,border:'none',borderRadius:8,padding:'8px 12px',fontSize:13,fontWeight:700,cursor:'pointer'}}>
                        {u.actif?'Désactiver':'Activer'}
                      </button>
                      <button onClick={()=>supprimer(u.id,u.nom)}
                        style={{background:C.red+'22',color:C.red,border:'none',borderRadius:8,padding:'8px 12px',fontSize:13,fontWeight:700,cursor:'pointer'}}>
                        🗑️
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
      }
    </div>
  )
}


// ── Négatifs Tab ────────────────────────────────────────────────────────────
// ── Booking Tab ──────────────────────────────────────────────────────────────
function BookingTab({data,dark,card,bdr,sub,thBg,S,alts}: any) {
  const C = { blue:'#1a73e8', green:'#188038', yellow:'#f9ab00', red:'#d93025' }
  const [fournisseur,setFournisseur]=useState('')
  const [debut,setDebut]=useState('')
  const [fin,setFin]=useState('')
  const [termes,setTermes]=useState(30)
  const [budget,setBudget]=useState(0)
  const [calc,setCalc]=useState(false)
  const [res,setRes]=useState<any[]>([])
  const [cf,setCf]=useState<any>(null)
  const hvr=dark?'#1a1a1a':'#f8fafc'

  const fournisseurs=Array.from(new Set((data?.liste_complete||[]).filter((it:any)=>it.classeABC!=='C').map((it:any)=>it.fournisseur))).sort() as string[]

  function optimiser(e:any){
    e.preventDefault()
    if(!data?.liste_complete)return
    const mDeb=parseInt(debut.split('-')[1])-1,mFin=parseInt(fin.split('-')[1])-1
    const mois:number[]=[]
    if(mDeb<=mFin){for(let i=mDeb;i<=mFin;i++)mois.push(i)}else{for(let i=mDeb;i<=11;i++)mois.push(i);for(let i=0;i<=mFin;i++)mois.push(i)}
    let sugg:any[]=[],coutTot=0
    data.liste_complete.forEach((it:any)=>{
      if(it.fournisseur!==fournisseur||it.classeABC==='C')return
      let v=0; mois.forEach((m:number)=>{v+=it.moyMois*(it.indiceSaison?.[m]??1)})
      if(v<=3)return
      // Exclure si une alternative couvre la demande
      const altCodesB:string[] = (alts&&alts.get&&alts.get(it.pk))||[]
      const normB = (s:string) => s.trim().toLowerCase().replace(/\s+/g,'')
      const altCouvreB = altCodesB.some((ac:string)=>{
        const acN=normB(ac)
        const ai=data.liste_complete.find((x:any)=>normB(x.pk)===acN)
        return ai&&Math.max(0,ai.stock)>=v
      })
      if(altCouvreB)return
      const saf=it.stockSecurite||Math.ceil(v*(it.classeABC==='A'?.2:.1))
      const q=Math.ceil(v+saf-Math.max(0,it.stock))
      if(q>0&&it.saison!=='Sur Commande')sugg.push({...it,vp:v.toFixed(1),saf,vs:it.stock,qb:q})
    })
    sugg.sort((a:any,b:any)=>((b.scoreUrgence||0)-(a.scoreUrgence||0)))
    if(budget>0){
      let tot=0;const sel:any[]=[]
      for(const s of sugg){const c=s.qb*s.cost;if(tot+c<=budget){sel.push(s);tot+=c}}
      sugg=sel;coutTot=tot
    } else {
      coutTot=sugg.reduce((s:number,it:any)=>s+it.qb*it.cost,0)
    }
    setRes(sugg)
    // Cashflow
    const payDate=new Date(debut);payDate.setDate(payDate.getDate()+termes)
    const encDate=new Date(fin);encDate.setMonth(encDate.getMonth()+1)
    const ecart=Math.round((payDate.getTime()-encDate.getTime())/(1000*60*60*24))
    setCf({coutTot,payF:payDate.toLocaleDateString('fr-CA'),encF:encDate.toLocaleDateString('fr-CA'),ecart})
    setCalc(true)
  }

  return <div style={{maxWidth:1400,margin:'0 auto'}}>
    <div style={{background:card,borderRadius:12,padding:'16px 20px',marginBottom:14,border:`1px solid ${bdr}`}}>
      <h3 style={{margin:'0 0 14px',fontSize:16,fontWeight:700}}>🧠 Optimiseur de Booking</h3>
      <form onSubmit={optimiser} style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'flex-end'}}>
        <div style={{flex:2,minWidth:180}}>
          <label style={{display:'block',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Fournisseur</label>
          <select value={fournisseur} onChange={e=>setFournisseur(e.target.value)} required style={S}>
            <option value="">Sélectionner...</option>
            {fournisseurs.map((f:string)=><option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div style={{flex:1,minWidth:130}}>
          <label style={{display:'block',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Début période</label>
          <input type="month" value={debut} onChange={e=>setDebut(e.target.value)} required style={S}/>
        </div>
        <div style={{flex:1,minWidth:130}}>
          <label style={{display:'block',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Fin période</label>
          <input type="month" value={fin} onChange={e=>setFin(e.target.value)} required style={S}/>
        </div>
        <div style={{flex:1,minWidth:130}}>
          <label style={{display:'block',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Termes (jours)</label>
          <input type="number" value={termes} onChange={e=>setTermes(Number(e.target.value))} min={0} style={S}/>
        </div>
        <div style={{flex:1.2,minWidth:140}}>
          <label style={{display:'block',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Budget Max ($)</label>
          <input type="number" value={budget} onChange={e=>setBudget(Number(e.target.value))} min={0} step={100} style={S}/>
        </div>
        <button type="submit" style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'0 18px',height:39,fontSize:13,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>🧠 Optimiser</button>
      </form>
    </div>
    {calc&&cf&&<div style={{background:cf.ecart<=0?(dark?'#0d2a18':'#e6f4ea'):(dark?'#2b2411':'#fef7e0'),border:`2px solid ${cf.ecart<=0?C.green:C.yellow}`,borderRadius:10,padding:'12px 18px',marginBottom:14,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10}}>
      <div><div style={{fontSize:11,fontWeight:700,color:sub,textTransform:'uppercase',marginBottom:3}}>Total</div><strong style={{fontSize:24,color:C.blue}}>{cf.coutTot.toLocaleString('fr-CA',{minimumFractionDigits:2})} $</strong></div>
      <div style={{color:cf.ecart<=0?C.green:'#92400e',fontWeight:600,fontSize:13,maxWidth:'60%',textAlign:'right'}}>
        {cf.ecart<=0?`✅ Trésorerie OK — Facture le ${cf.payF}, ventes vers ${cf.encF}.`:`⚠️ Paiement le ${cf.payF} mais ventes vers ${cf.encF}. Financer ${cf.ecart} jours.`}
      </div>
    </div>}
    <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
        <thead><tr style={{background:thBg}}>
          {['Matrice','Code Pièce','Description','Ventes Prédites','Stock Sécu.','Stock Actuel','Coût Un.','QTÉ BOOKING','Total $'].map((h,i)=>(
            <th key={i} style={{padding:'11px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:i>=3?'center':'left',background:i===7?(dark?'#0d2a18':'#e6f4ea'):thBg}}>{h}</th>
          ))}
        </tr></thead>
        <tbody>
          {!calc
            ? <tr><td colSpan={9} style={{textAlign:'center',padding:50,color:sub}}>Remplissez les informations et cliquez Optimiser.</td></tr>
            : res.length===0
            ? <tr><td colSpan={9} style={{textAlign:'center',padding:50,color:sub}}>Aucune pièce A ou B valide pour ce budget.</td></tr>
            : res.map((it,i)=>(
              <tr key={i}>
                <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}><span style={{background:it.classeABC==='A'?C.green:C.yellow,color:'#fff',padding:'3px 6px',borderRadius:4,fontSize:11,fontWeight:700}}>{it.classeABC}</span></td>
                <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{it.pk}</td>
                <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:sub}}>{it.desc}</td>
                <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.blue,fontWeight:700}}>{it.vp}</td>
                <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.yellow,fontWeight:700}}>+{it.saf}</td>
                <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:it.vs<0?C.red:sub,fontWeight:600}}>{it.vs}</td>
                <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{it.cost.toFixed(2)}$</td>
                <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',background:dark?'#0d2a18':'#e6f4ea',color:C.green,fontSize:17,fontWeight:900}}>{it.qb}</td>
                <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700}}>{(it.qb*it.cost).toLocaleString('fr-CA',{minimumFractionDigits:2})}$</td>
              </tr>
            ))
          }
        </tbody>
      </table>
    </div>
  </div>
}

// ── Composant : bandeau de retour comptabilité ───────────────────────────────
// Affiché en TÊTE de NegatifsTab et InventaireTab quand il y a des retours
// actifs pour l'utilisateur courant.
function RetoursComptaBandeau({ retours, source, employe, dark, card, bdr, sub, C, onCorrige, onEdit }: any) {
  const mesRetours = (retours || []).filter((r: any) => r.source === source && r.demandeur_employe === employe)
  if (mesRetours.length === 0) return null
  const fmtDate = (d: string) => d ? new Date(d).toLocaleDateString('fr-CA',{year:'2-digit',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'
  const labelEdit = source === 'comptage' ? '📦 Voir / Modifier' : '📝 Voir / Modifier'
  return (
    <div style={{background:dark?'#2b1113':'#fce8e6',border:`2px solid ${C.red}`,borderRadius:10,padding:'14px 16px',marginBottom:14}}>
      <div style={{fontSize:14,fontWeight:900,color:C.red,marginBottom:8,display:'flex',alignItems:'center',gap:8}}>
        <span style={{fontSize:20}}>⚠️</span>
        {mesRetours.length === 1
          ? '1 correction demandée par la comptabilité'
          : `${mesRetours.length} corrections demandées par la comptabilité`}
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {mesRetours.map((r: any) => (
          <div key={r.id} style={{background:card,border:`1px solid ${C.red}`,borderRadius:8,padding:'10px 12px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10,flexWrap:'wrap',marginBottom:6}}>
              <div>
                <div style={{fontSize:13,fontWeight:800,fontFamily:'monospace'}}>{r.code_piece || '(code inconnu)'}</div>
                <div style={{fontSize:10,color:sub,marginTop:2}}>Retourné le {fmtDate(r.retourne_le)} par {r.comptable_email}</div>
              </div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {onEdit && (
                  <button onClick={()=>onEdit(r)}
                    style={{background:C.blue,color:'#fff',border:'none',borderRadius:6,padding:'7px 14px',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                    {labelEdit}
                  </button>
                )}
                <button onClick={()=>onCorrige(r.id)}
                  style={{background:'transparent',color:C.green,border:`1px solid ${C.green}`,borderRadius:6,padding:'7px 12px',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                  ✓ J'ai corrigé
                </button>
              </div>
            </div>
            <div style={{background:dark?'#1a1a1a':'#fff',border:`1px dashed ${C.red}`,borderRadius:6,padding:'8px 10px',fontSize:12,lineHeight:1.5,color:dark?'#e8e8e8':'#1a1a1a'}}>
              <strong style={{color:C.red,textTransform:'uppercase',fontSize:10}}>💬 Commentaire de la comptabilité :</strong>
              <div style={{marginTop:4}}>{r.commentaire_retour}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function NegatifsTab({negs, dark, card, bdr, sub, thBg, S, C, hvr, alts, negsVerifies, setNegsVerifies, profil, data, lancerSync, syncing, syncLog, validationsCompta, retoursActifs, setRetoursActifs, verifsDoubles}: any) {
  const validesNegatifIds = new Set((validationsCompta||[]).filter((v:any)=>v.source==='negatif').map((v:any)=>v.ref_id))
  // Double-vérification : map ref_id → record (pour afficher badge et auteur)
  const verifsNegMap = new Map<number, any>()
  for (const vd of (verifsDoubles || [])) {
    if (vd.source === 'negatif') verifsNegMap.set(Number(vd.ref_id), vd)
  }
  const SEUIL_DOUBLE_VERIF = 3
  // Causes hors comptabilité — passent par Vérification (admin) au lieu de Compta.
  const CAUSES_HORS_COMPTA_LOCAL = new Set([
    'Pièce non réceptionnée mais facturée (logiciel/service)',
    'Réservation (pièce mal importée dans facture)',
    'Double facturation',
  ])
  // Calcule le statut de double-vérif pour un négatif vérifié.
  // Va en Vérification si |ajustement| > 3 OU si la cause est « hors compta ».
  function statutDoubleVerif(v: any): { label: string; color: string; valide_par?: string } | null {
    const ecart = Math.abs(Number(v.ajustement || 0))
    const horsCompta = !!(v.cause && CAUSES_HORS_COMPTA_LOCAL.has(v.cause))
    if (!horsCompta && ecart <= SEUIL_DOUBLE_VERIF) return null
    const verif = verifsNegMap.get(v.id)
    if (verif) return { label: '✅ Double-vérif', color: C.green, valide_par: verif.valide_par }
    return { label: horsCompta ? '⏳ Vérif admin (hors compta)' : '⏳ Double-vérif attendue', color: C.yellow }
  }
  // Description par code pièce — depuis les négatifs actifs et la liste complète.
  const descByCode = new Map<string, string>()
  for (const n of (negs || [])) {
    if (n.code_piece && n.description) descByCode.set(n.code_piece, n.description)
  }
  for (const item of (data?.liste_complete || [])) {
    if (item.pk && item.desc && !descByCode.has(item.pk)) descByCode.set(item.pk, item.desc)
  }
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const employe = profil?.nom || profil?.email || 'Inconnu'

  async function marquerRetourCorrige(retourId: number) {
    try {
      await fetch('/api/comptabilite/retours', {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ id: retourId, action: 'corrige', user_email: employe })
      })
      // Refresh la liste des retours actifs
      const r = await fetch('/api/comptabilite/retours?actifs=1')
      const j = await r.json()
      if (Array.isArray(j) && setRetoursActifs) setRetoursActifs(j)
    } catch (e: any) { alert(e.message) }
  }

  // ── Édition d'un négatif vérifié retourné par la compta ────────────────────
  // On réutilise le modal de vérification (noteModal + form + altForm) en passant
  // en mode édition : `editNegId` contient l'id du négatif vérifié à PATCH,
  // `editRetourId` l'id du retour comptabilité à marquer corrigé après save.
  // `editKeptPhotos` contient les URLs des photos existantes conservées.
  const [editNegId, setEditNegId] = useState<number|null>(null)
  const [editRetourId, setEditRetourId] = useState<number|null>(null)
  const [editKeptPhotos, setEditKeptPhotos] = useState<string[]>([])

  async function ouvrirEditNeg(retour: any) {
    try {
      const r = await fetch('/api/negatifs-verifies?id=' + encodeURIComponent(String(retour.ref_id)))
      const v = await r.json()
      if (!v || v.erreur) { alert('Négatif vérifié introuvable'); return }

      // Retrouver description / fournisseur / ligne via data.liste_complete
      const item = (data?.liste_complete||[]).find((x:any) => x.pk === v.code_piece)
      const cout = (Number(v.stock_au_moment)||0) !== 0 ? Math.abs(Number(v.valeur_au_moment)/Number(v.stock_au_moment)) : (item?.cost ?? 0)
      const synthesized = {
        code_piece: v.code_piece,
        description: item?.desc || '',
        fournisseur: item?.fournisseur || '',
        ligne: item?.ligne || '',
        stock_negatif: v.stock_au_moment,
        cout_unitaire: cout,
      }

      const causeIdx = v.cause ? CAUSES.indexOf(v.cause) : -1
      setForm({
        serv_detail: v.serv_detail!=null? String(v.serv_detail):'',
        serv_interne: v.serv_interne!=null? String(v.serv_interne):'',
        serv_gar: v.serv_gar!=null? String(v.serv_gar):'',
        pce_detail: v.pce_detail!=null? String(v.pce_detail):'',
        recept_comm: v.recept_comm!=null? String(v.recept_comm):'',
        dec_physique: v.dec_physique!=null? String(v.dec_physique):'',
        autre: v.autre!=null? String(v.autre):'',
        qte_reelle: v.qte_reelle!=null? String(v.qte_reelle):'',
        cause: v.cause || '',
        causeIdx,
        commentaire_compta: v.commentaire || '',
      })
      setAltForm({
        serv_detail: v.alt_serv_detail!=null? String(v.alt_serv_detail):'',
        serv_interne: v.alt_serv_interne!=null? String(v.alt_serv_interne):'',
        serv_gar: v.alt_serv_gar!=null? String(v.alt_serv_gar):'',
        pce_detail: v.alt_pce_detail!=null? String(v.alt_pce_detail):'',
        recept_comm: v.alt_recept_comm!=null? String(v.alt_recept_comm):'',
        dec_physique: v.alt_dec_physique!=null? String(v.alt_dec_physique):'',
        autre: v.alt_autre!=null? String(v.alt_autre):'',
        qte_reelle: v.alt_qte_reelle!=null? String(v.alt_qte_reelle):'',
        cause: '', causeIdx: -1, commentaire_compta: '',
      })
      const kept = [v.photo_url, v.photo_url2].filter(Boolean) as string[]
      setEditKeptPhotos(kept)
      setPhotoFiles([])
      setPhotoPreviews(kept)
      setEditNegId(v.id)
      setEditRetourId(retour.id)
      setNoteModal(synthesized)
    } catch (e: any) { alert(e.message) }
  }
  const [filtFourn, setFiltFourn] = useState('ALL')
  const [filtLignes, setFiltLignes] = useState<string[]>([])
  const [ddLigneOpen, setDdLigneOpen] = useState(false)
  const ddLigneRef = useRef<HTMLDivElement>(null)
  const [sousOnglet, setSousOnglet] = useState<'actif'|'verifie'>('actif')
  const [noteModal, setNoteModal] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [photoFiles, setPhotoFiles] = useState<File[]>([])
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([])
  const photoRef = useRef<HTMLInputElement>(null)
  const [locsMap, setLocsMap] = useState<Map<string,string[]>>(new Map())

  // Charger les localisations de toutes les pièces négatives
  useEffect(() => {
    if (!negs || negs.length === 0) return
    const codes = Array.from(new Set(negs.map((n:any) => n.code_piece))) as string[]
    async function fetchLocs() {
      const map = new Map<string,string[]>()
      // Batch par 10 pour éviter de surcharger
      for (let i = 0; i < codes.length; i += 10) {
        const batch = codes.slice(i, i + 10)
        const results = await Promise.all(batch.map(code =>
          fetch('/api/inventaire/localisations?code=' + encodeURIComponent(code)).then(r => r.json()).catch(() => [])
        ))
        batch.forEach((code, idx) => {
          const data = results[idx]
          if (Array.isArray(data) && data.length > 0) {
            const locs = data.flatMap((p:any) => [p.localisation1, p.localisation2, p.localisation3, p.localisation4].filter(Boolean))
            const unique = Array.from(new Set(locs))
            if (unique.length > 0) map.set(code, unique)
          }
        })
      }
      setLocsMap(map)
    }
    fetchLocs()
  }, [negs])

  // Formulaire principal
  const champsDef = [
    {key:'serv_detail',   label:'Serv. détail',    desc:'Ventes service détail (sortie)',    sign:'-'},
    {key:'serv_interne',  label:'Serv. interne',   desc:'Ventes service interne (sortie)',   sign:'-'},
    {key:'serv_gar',      label:'Serv. gar.',       desc:'Ventes service garantie (sortie)',  sign:'-'},
    {key:'pce_detail',    label:'Pce détail',       desc:'Ventes pièces détail (sortie)',     sign:'-'},
    {key:'recept_comm',   label:'Récept. comm.',    desc:'Réceptions de commandes (entrée)',  sign:'+'},
    {key:'dec_physique',  label:'Déc. physique',    desc:'Ajustement inventaire annuel (±)',  sign:'±'},
    {key:'autre',         label:'Autre',            desc:'Autre ajustement (±)',              sign:'±'},
  ]

  const CAUSES = [
    'Pièce non réceptionnée mais facturée (logiciel/service)',
    'Réservation (pièce mal importée dans facture)',
    'Stock vendu non reçu en inventaire',
    "Erreur de comptage lors d'un inventaire antérieur",
    'Ajustement incorrect (Déc. physique ou Autre)',
    'Pièce alternative utilisée sous ce SKU',
    'Retour fournisseur non traité',
    'Double facturation',
  ]

  const CAUSES_SANS_PHOTO = [
    'Pièce non réceptionnée mais facturée (logiciel/service)',
    'Réservation (pièce mal importée dans facture)',
  ]

  // Ces causes ne doivent PAS apparaître dans l'onglet Comptabilité
  // (ce sont des corrections internes ou facturation — pas une écriture comptable).
  // À la place, elles passent par l'onglet Vérification pour validation admin.
  const CAUSES_HORS_COMPTA = [
    'Pièce non réceptionnée mais facturée (logiciel/service)',
    'Réservation (pièce mal importée dans facture)',
    'Double facturation',
  ]

  // Messages d'action spécifiques par cause
  const CAUSES_MESSAGES: Record<string, string> = {
    'Pièce non réceptionnée mais facturée (logiciel/service)': '📋 Valider avec la réception/expédition pour réceptionner le stock',
    'Réservation (pièce mal importée dans facture)': '📋 Corriger la réservation dans Lautopak menu 251',
    'Double facturation': '📋 Corriger la facture en double avec la facturation (non comptable)',
  }

  const emptyForm = () => ({
    serv_detail:'', serv_interne:'', serv_gar:'', pce_detail:'',
    recept_comm:'', dec_physique:'', autre:'', qte_reelle:'',
    cause:'', causeIdx:-1, commentaire_compta:''
  })

  const [form, setForm] = useState<any>(emptyForm())
  const [altForm, setAltForm] = useState<any>(emptyForm())

  function getAjust(stockSys: number, f: any) {
    // Qté tablette = somme des transactions
    // Stock sys = QTYMINUSRESERVED + QteReserveEnStock
    // Ajustement = Qté tablette - Stock sys
    const qteTab = parseFloat(f.qte_reelle) || 0
    return qteTab - stockSys
  }

  function qteTablette(f: any) {
    return (parseFloat(f.serv_detail)||0) + (parseFloat(f.serv_interne)||0) +
           (parseFloat(f.serv_gar)||0) + (parseFloat(f.pce_detail)||0) +
           (parseFloat(f.recept_comm)||0) + (parseFloat(f.dec_physique)||0) +
           (parseFloat(f.autre)||0)
  }

  function formComplet(f: any) {
    const exemptTout = f.causeIdx === 0
    if (exemptTout) return f.cause !== '' && f.commentaire_compta !== ''
    // Champs transactions peuvent être vides (= 0), seuls cause, commentaire et qte_reelle sont requis
    return f.qte_reelle !== '' && f.cause !== '' && f.commentaire_compta !== ''
  }
  // Validation allégée pour la pièce alternative : la cause + commentaire sont
  // partagés avec la pièce principale (un seul bloc Justification dans l'UI),
  // donc l'alt n'a besoin que de son stock réel.
  function altFormComplet(f: any, principalCauseIdx: number) {
    if (principalCauseIdx === 0) return true  // non réceptionnée → pas de comptage
    return f.qte_reelle !== ''
  }

  function photoObligatoire(ajust: number, cause?: string, causeIdx?: number) {
    if (causeIdx === 0 || (cause && CAUSES.indexOf(cause) === 0)) return false
    return Math.abs(ajust) > 1
  }
  function onPhoto(e: any) {
    const files = Array.from(e.target.files || []) as File[]
    if (files.length === 0) return
    setPhotoFiles(prev => [...prev, ...files])
    files.forEach(f => {
      const reader = new FileReader()
      reader.onload = ev => setPhotoPreviews(prev => [...prev, ev.target?.result as string])
      reader.readAsDataURL(f)
    })
    e.target.value = ''
  }

  async function uploadPhotos(code_piece: string, loc: string): Promise<string[]> {
    const urls: string[] = []
    for (const file of photoFiles) {
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('code_piece', code_piece)
        fd.append('localisation', `NEG_${code_piece}`)
        const r = await fetch('/api/inventaire/photo', { method: 'POST', body: fd })
        const j = await r.json()
        if (j.url) urls.push(j.url)
        else console.error('Upload photo erreur:', j)
      } catch(err) { console.error('Upload photo exception:', err) }
    }
    return urls
  }
  async function soumettre(e?: any) {
    if (e) e.preventDefault()
    if (!noteModal) return
    const n = noteModal
    const stockSys = Number(n.stock_negatif)
    const altCodes: string[] = (alts && alts.get && alts.get(n.code_piece)) || []
    const hasAlt = altCodes.length > 0

    const ajust = getAjust(stockSys, form)
    const photoObl = photoObligatoire(ajust, form.cause, form.causeIdx)

    // En mode édition, les photos déjà existantes (editKeptPhotos) comptent comme satisfaisant l'obligation.
    const totalPhotos = (editNegId ? editKeptPhotos.length : 0) + photoFiles.length
    if (photoObl && totalPhotos === 0) {
      alert('📸 Photo obligatoire car écart > 1 unité !')
      photoRef.current?.click()
      return
    }

    setLoading(true)

    // Upload photos nouvelles
    const newUrls = await uploadPhotos(n.code_piece, 'NEG')
    // Combiner photos conservées + nouvelles (max 2)
    const finalPhotos = editNegId ? [...editKeptPhotos, ...newUrls].slice(0, 2) : newUrls

    // Calculer ajustement alternatif
    let altAjust = null
    if (hasAlt) {
      const altItem = (data?.liste_complete||[]).find((x:any) => x.pk === altCodes[0])
      const altStockSys = altItem ? altItem.stock : 0
      altAjust = getAjust(altStockSys, altForm)
    }

    if (editNegId) {
      // Mode édition : PATCH du négatif existant
      await fetch('/api/negatifs-verifies', {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          id: editNegId,
          serv_detail:   parseFloat(form.serv_detail)||0,
          serv_interne:  parseFloat(form.serv_interne)||0,
          serv_gar:      parseFloat(form.serv_gar)||0,
          pce_detail:    parseFloat(form.pce_detail)||0,
          recept_comm:   parseFloat(form.recept_comm)||0,
          dec_physique:  parseFloat(form.dec_physique)||0,
          autre:         parseFloat(form.autre)||0,
          qte_reelle:    parseFloat(form.qte_reelle)||0,
          ajustement:    ajust,
          cause:         form.cause,
          commentaire:   form.commentaire_compta,
          photo_url:     finalPhotos[0] || null,
          photo_url2:    finalPhotos[1] || null,
          alt_code_piece: hasAlt ? altCodes[0] : null,
          alt_ajustement: altAjust,
          alt_serv_detail:  parseFloat(altForm.serv_detail)||0,
          alt_serv_interne: parseFloat(altForm.serv_interne)||0,
          alt_serv_gar:     parseFloat(altForm.serv_gar)||0,
          alt_pce_detail:   parseFloat(altForm.pce_detail)||0,
          alt_recept_comm:  parseFloat(altForm.recept_comm)||0,
          alt_dec_physique: parseFloat(altForm.dec_physique)||0,
          alt_autre:        parseFloat(altForm.autre)||0,
          alt_qte_reelle:   parseFloat(altForm.qte_reelle)||0,
        })
      })
      if (editRetourId) await marquerRetourCorrige(editRetourId)
    } else {
      // Création : POST classique
      await fetch('/api/negatifs-verifies', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          code_piece: n.code_piece,
          employe,
          stock_au_moment: n.stock_negatif,
          valeur_au_moment: Math.abs(n.stock_negatif * n.cout_unitaire),
          serv_detail:   parseFloat(form.serv_detail)||0,
          serv_interne:  parseFloat(form.serv_interne)||0,
          serv_gar:      parseFloat(form.serv_gar)||0,
          pce_detail:    parseFloat(form.pce_detail)||0,
          recept_comm:   parseFloat(form.recept_comm)||0,
          dec_physique:  parseFloat(form.dec_physique)||0,
          autre:         parseFloat(form.autre)||0,
          qte_reelle:    parseFloat(form.qte_reelle)||0,
          ajustement:    ajust,
          cause:         form.cause,
          commentaire:   form.commentaire_compta,
          photo_url:     finalPhotos[0] || null,
          photo_url2:    finalPhotos[1] || null,
          alt_code_piece: hasAlt ? altCodes[0] : null,
          alt_ajustement: altAjust,
          alt_serv_detail:  parseFloat(altForm.serv_detail)||0,
          alt_serv_interne: parseFloat(altForm.serv_interne)||0,
          alt_serv_gar:     parseFloat(altForm.serv_gar)||0,
          alt_pce_detail:   parseFloat(altForm.pce_detail)||0,
          alt_recept_comm:  parseFloat(altForm.recept_comm)||0,
          alt_dec_physique: parseFloat(altForm.dec_physique)||0,
          alt_autre:        parseFloat(altForm.autre)||0,
          alt_qte_reelle:   parseFloat(altForm.qte_reelle)||0,
        })
      })
    }

    const r = await fetch('/api/negatifs-verifies')
    if (r.ok) setNegsVerifies(await r.json())
    setNoteModal(null)
    setForm(emptyForm()); setAltForm(emptyForm())
    setPhotoFiles([]); setPhotoPreviews([])
    setEditNegId(null); setEditRetourId(null); setEditKeptPhotos([])
    setLoading(false)
  }

  async function retablir(id: number) {
    await fetch('/api/negatifs-verifies', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id }) })
    const r = await fetch('/api/negatifs-verifies')
    if (r.ok) setNegsVerifies(await r.json())
  }

  // Dédupliquer
  const dedup = new Map<string,any>()
  for (const n of negs) {
    if (!dedup.has(n.code_piece) || new Date(n.date_apparition) > new Date(dedup.get(n.code_piece).date_apparition))
      dedup.set(n.code_piece, n)
  }
  const negsUniques = Array.from(dedup.values())
  const codesVerifies = new Set(negsVerifies.map((v:any) => v.code_piece))
  const negsVerifiesVisibles = negsVerifies.filter((v:any) => !validesNegatifIds.has(v.id))
  const fournisseurs = Array.from(new Set(negsUniques.map((n:any) => n.fournisseur))).sort() as string[]
  const lignes = Array.from(new Set(negsUniques.map((n:any) => n.ligne))).sort() as string[]
  const negsActifs = negsUniques.filter((n:any) => !codesVerifies.has(n.code_piece))

  const filtered = negsActifs.filter((n:any) => {
    if (filtFourn !== 'ALL' && n.fournisseur !== filtFourn) return false
    if (filtLignes.length > 0 && !filtLignes.includes(n.ligne)) return false
    return true
  }).sort((a:any, b:any) => Math.abs(b.stock_negatif * b.cout_unitaire) - Math.abs(a.stock_negatif * a.cout_unitaire))

  const totalErreur = filtered.reduce((s:number, n:any) => s + Math.abs(n.stock_negatif * n.cout_unitaire), 0)

  const btnStyle: any = {border:'none',borderRadius:12,fontWeight:800,cursor:'pointer',color:'#fff',width:'100%',padding:'14px 0',fontSize:16}

  // Composant formulaire champs transactions
  function ChampTransaction({f, setF, prefix=''}: any) {
    return (
      <div style={{display:'flex',flexDirection:'column',gap:10}}>
        {champsDef.map(c => {
          const valNum = parseInt(f[c.key]) || 0
          const isNeg = valNum < 0
          const absVal = Math.abs(valNum)
          const couleur = f[c.key] !== '' ? (parseFloat(f[c.key]) < 0 && c.sign==='+' ? C.red : parseFloat(f[c.key]) > 0 && c.sign==='-' ? C.red : C.green) : bdr
          return (
            <div key={c.key} style={{background:dark?'#111':'#f8f9fa',borderRadius:10,padding:'12px 14px',border:`1px solid ${couleur}`}}>
              <div style={{marginBottom:10,display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14,display:'flex',justifyContent:'space-between'}}>
                    <span>{c.label}</span>
                    <span style={{fontSize:12,fontWeight:400,color:c.sign==='-'?C.red:c.sign==='+'?C.green:sub}}>
                      {c.sign === '-' ? '(sortie −)' : c.sign === '+' ? '(entrée +)' : '(±)'}
                    </span>
                  </div>
                  <div style={{fontSize:11,color:sub,marginTop:2}}>{c.desc}</div>
                </div>
                {f[c.key] !== '' && (
                  <button type="button" onClick={()=>setF((prev:any)=>({...prev,[c.key]:''}))}
                    style={{marginLeft:8,background:C.red+'22',border:'none',borderRadius:8,padding:'4px 10px',color:C.red,cursor:'pointer',fontSize:12,fontWeight:700,flexShrink:0}}>
                    ✕ Effacer
                  </button>
                )}
              </div>
              {/* Valeur affichée en grand */}
              <div style={{fontSize:28,fontWeight:900,textAlign:'center',color:isNeg?C.red:valNum>0?C.green:sub,marginBottom:10,minHeight:40,background:dark?'#1a1a1a':'#fff',borderRadius:8,padding:'8px',border:`1px solid ${bdr}`}}>
                {f[c.key]===''?<span style={{color:sub,fontSize:18}}>0</span>:f[c.key]}
              </div>
              {/* Clavier numérique custom */}
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:isMobile?8:6}}>
                {['1','2','3','4','5','6','7','8','9','±','0','⌫'].map(k => (
                  <button key={k} type="button"
                    onClick={()=>{
                      let cur = f[c.key] === '' ? '0' : f[c.key]
                      if (k === '⌫') {
                        const next = cur.length <= 1 ? '' : cur.slice(0,-1)
                        setF((prev:any)=>({...prev,[c.key]: next === '-' ? '' : next}))
                      } else if (k === '±') {
                        if (cur === '' || cur === '0') return
                        const next = cur.startsWith('-') ? cur.slice(1) : '-' + cur
                        setF((prev:any)=>({...prev,[c.key]: next}))
                      } else {
                        const next = cur === '0' ? k : cur === '-0' ? '-'+k : cur + k
                        setF((prev:any)=>({...prev,[c.key]: next}))
                      }
                    }}
                    style={{
                      padding:isMobile?'18px 0':'14px 0',borderRadius:12,fontWeight:700,fontSize:isMobile?22:18,cursor:'pointer',
                      border:`1px solid ${bdr}`,
                      background: k==='⌫'?(dark?'#2b1113':'#fce8e6'):k==='±'?(dark?'#1a233a':'#e8f0fe'):(dark?'#222':'#fff'),
                      color: k==='⌫'?C.red:k==='±'?C.blue:'inherit',
                      minHeight:isMobile?52:44
                    }}>
                    {k}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    )
  }


  return <>
    {/* Bandeau de retours comptabilité — affiché en TÊTE si l'utilisateur a des corrections demandées */}
    <RetoursComptaBandeau retours={retoursActifs} source="negatif" employe={employe} dark={dark} card={card} bdr={bdr} sub={sub} C={C} onCorrige={marquerRetourCorrige} onEdit={ouvrirEditNeg}/>

    {/* Input photo caché */}
    <input ref={photoRef} type="file" accept="image/*" capture="environment" multiple onChange={onPhoto} style={{display:'none'}}/>

    {/* Modal vérification — plein écran mobile */}
    {noteModal && (() => {
      const n = noteModal
      const stockSys = Number(n.stock_negatif)
      const altCodes: string[] = (alts && alts.get && alts.get(n.code_piece)) || []
      const hasAlt = altCodes.length > 0
      const altItem = hasAlt ? (data?.liste_complete||[]).find((x:any) => x.pk === altCodes[0]) : null
      const altStockSys = altItem ? altItem.stock : 0

      const qteTab = qteTablette(form)
      const ajust = getAjust(stockSys, form)
      const altQteTab = qteTablette(altForm)
      const altAjust = hasAlt ? getAjust(altStockSys, altForm) : null
      const photoObl = photoObligatoire(ajust, form.cause, form.causeIdx)
      const nbPhotos = photoFiles.length + (editNegId ? editKeptPhotos.length : 0)
      const allFormsComplet = formComplet(form) && (!hasAlt || altFormComplet(altForm, form.causeIdx))

      return (
        <div style={{position:'fixed',inset:0,background:dark?'#0d0d0d':'#f0f2f5',zIndex:9999,overflowY:'auto',fontFamily:"'DM Sans',sans-serif"}}>
          {/* Header fixe */}
          <div style={{position:'sticky',top:0,background:dark?'#111':(editNegId?C.blue:C.red),color:'#fff',padding:'14px 16px',zIndex:10,display:'flex',justifyContent:'space-between',alignItems:'center',boxShadow:'0 2px 8px rgba(0,0,0,.2)',gap:8}}>
            <div>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',opacity:.8}}>{editNegId?'📝 Correction négatif (retour compta)':'Vérification inventaire'}</div>
              <div style={{fontSize:18,fontWeight:900,letterSpacing:1}}>{n.code_piece}</div>
            </div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>{setForm(emptyForm());setAltForm(emptyForm());setPhotoFiles([]);setPhotoPreviews([])}}
                style={{background:'rgba(255,255,255,.15)',border:'1px solid rgba(255,255,255,.4)',borderRadius:10,padding:'8px 12px',color:'#fff',cursor:'pointer',fontSize:13,fontWeight:700}}>
                🔄 Réinitialiser
              </button>
              <button onClick={()=>{setNoteModal(null);setForm(emptyForm());setAltForm(emptyForm());setPhotoFiles([]);setPhotoPreviews([]);setEditNegId(null);setEditRetourId(null);setEditKeptPhotos([])}}
                style={{background:'rgba(255,255,255,.2)',border:'none',borderRadius:10,padding:'8px 14px',color:'#fff',cursor:'pointer',fontSize:14,fontWeight:700}}>
                ✕ Fermer
              </button>
            </div>
          </div>

          <div style={{padding:'16px',maxWidth:700,margin:'0 auto'}}>
            {/* Info pièce */}
            <div style={{background:card,borderRadius:14,padding:'16px',marginBottom:16,border:`2px solid ${C.red}`}}>
              <div style={{fontSize:13,fontWeight:700,color:C.red,marginBottom:8}}>📦 Pièce en négatif</div>
              <div style={{fontWeight:800,fontSize:18}}>{n.code_piece}</div>
              <div style={{color:sub,fontSize:13,marginTop:2}}>{n.description}</div>
              <div style={{marginTop:10,display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
                <div style={{background:dark?'#1a1a1a':'#fff8f8',borderRadius:10,padding:'10px',textAlign:'center',border:`1px solid ${C.red}33`}}>
                  <div style={{fontSize:11,color:sub,fontWeight:700,textTransform:'uppercase'}}>Stock total</div>
                  <div style={{fontSize:22,fontWeight:900,color:C.red}}>{n.stock_negatif}</div>
                </div>
                <div style={{background:dark?'#1a233a':'#e8f0fe',borderRadius:10,padding:'10px',textAlign:'center',border:`1px solid ${C.blue}33`}}>
                  <div style={{fontSize:11,color:sub,fontWeight:700,textTransform:'uppercase'}}>Disponible</div>
                  <div style={{fontSize:22,fontWeight:900,color:C.blue}}>{n.stock_negatif}</div>
                </div>
                <div style={{background:dark?'#2b2411':'#fef7e0',borderRadius:10,padding:'10px',textAlign:'center',border:`1px solid ${C.yellow}33`}}>
                  <div style={{fontSize:11,color:sub,fontWeight:700,textTransform:'uppercase'}}>Réservé</div>
                  <div style={{fontSize:22,fontWeight:900,color:C.yellow}}>0</div>
                </div>
              </div>
              <div style={{marginTop:8,fontSize:12,color:sub}}>🏢 {n.fournisseur} • Ligne {n.ligne}</div>
            </div>

            {/* Alternative détectée */}
            {hasAlt && (
              <div style={{background:dark?'#0d2a18':'#e6f4ea',borderRadius:14,padding:'14px 16px',marginBottom:16,border:`2px solid ${C.green}`}}>
                <div style={{fontSize:13,fontWeight:700,color:C.green,marginBottom:6}}>🔄 Pièce alternative détectée</div>
                <div style={{fontWeight:700,fontSize:16}}>{altCodes[0]}</div>
                {altItem && <div style={{color:sub,fontSize:12,marginTop:2}}>{altItem.desc}</div>}
                <div style={{fontSize:12,color:C.blue,marginTop:4}}>Stock actuel: <strong>{altStockSys}</strong></div>
                <div style={{fontSize:12,color:sub,marginTop:4}}>⚠️ Si tu as utilisé cette alternative pour servir le client, remplis aussi sa section ci-dessous</div>
              </div>
            )}

            {/* Formulaire pièce principale */}
            <div style={{background:card,borderRadius:14,padding:'16px',marginBottom:16,border:`1px solid ${bdr}`}}>
              <div style={{fontSize:15,fontWeight:800,color:C.red,marginBottom:14}}>
                📋 Transactions — {n.code_piece}
              </div>
              <ChampTransaction f={form} setF={setForm}/>

              {/* Qté tablette calculée automatiquement */}
              <div style={{marginTop:14,background:dark?'#1a233a':'#e8f0fe',borderRadius:12,padding:'14px',border:`1px solid ${C.blue}33`}}>
                <div style={{fontSize:12,fontWeight:700,color:C.blue,textTransform:'uppercase',marginBottom:6}}>
                  📦 Qté tablette (calculée automatiquement)
                </div>
                <div style={{fontSize:28,fontWeight:900,color:C.blue,textAlign:'center'}}>{qteTab.toFixed(0)}</div>
                <div style={{fontSize:11,color:sub,textAlign:'center',marginTop:2}}>= somme de toutes les transactions</div>
              </div>

              {/* Champ qte_reelle — masqué si pièce non réceptionnée */}
              {form.causeIdx !== 0 && (
                <div style={{marginTop:12,background:dark?'#0d2a18':'#e6f4ea',borderRadius:12,padding:'14px',border:`1px solid ${C.green}33`}}>
                  <div style={{fontSize:12,fontWeight:700,color:C.green,textTransform:'uppercase',marginBottom:6}}>
                    ✅ Stock réel sur tablette (vérification)
                  </div>
                  <input type="number" step="any" inputMode="numeric" min="0"
                    value={form.qte_reelle}
                    onChange={e=>setForm((prev:any)=>({...prev,qte_reelle:e.target.value}))}
                    placeholder="Compter..."
                    style={{...S,fontSize:22,fontWeight:900,textAlign:'center',padding:'12px',borderRadius:10,boxSizing:'border-box',width:'100%',maxWidth:'100%'}}/>
                  <div style={{fontSize:11,color:sub,marginTop:6,textAlign:'center'}}>Doit être ≥ 0</div>
                </div>
              )}
              {form.causeIdx === 0 && (
                <div style={{marginTop:12,background:dark?'#1a233a':'#e8f0fe',borderRadius:12,padding:'14px',border:`1px solid ${C.blue}33`}}>
                  <div style={{fontSize:13,fontWeight:700,color:C.blue}}>ℹ️ Pièce non réceptionnée</div>
                  <div style={{fontSize:12,color:sub,marginTop:4}}>Aucun stock physique à compter — la pièce est un logiciel ou service.</div>
                </div>
              )}

              {/* Ajustement calculé */}
              {form.qte_reelle !== '' && (
                <div style={{marginTop:12,background:ajust===0?(dark?'#0d2a18':'#e6f4ea'):(dark?'#2b1113':'#fce8e6'),borderRadius:12,padding:'14px',border:`2px solid ${ajust===0?C.green:C.red}`}}>
                  <div style={{fontSize:12,fontWeight:700,textTransform:'uppercase',color:ajust===0?C.green:C.red,marginBottom:4}}>
                    Ajustement à faire dans Traction
                  </div>
                  <div style={{fontSize:32,fontWeight:900,color:ajust===0?C.green:C.red,textAlign:'center'}}>
                    {ajust===0?'✅ Aucun':ajust>0?`+${ajust.toFixed(0)}`:`${ajust.toFixed(0)}`}
                  </div>
                  {ajust !== 0 && (
                    <div style={{fontSize:12,color:sub,textAlign:'center',marginTop:4}}>
                      {form.qte_reelle} tablette − {stockSys} système = {ajust > 0 ? '+' : ''}{ajust.toFixed(0)}
                    </div>
                  )}
                  {photoObligatoire(ajust, form.cause, form.causeIdx) && nbPhotos === 0 && (
                    <div style={{marginTop:8,background:C.red+'22',borderRadius:8,padding:'8px 12px',color:C.red,fontSize:13,fontWeight:700,textAlign:'center'}}>
                      📸 Photo obligatoire car écart &gt; 1 unité
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Formulaire alternatif */}
            {hasAlt && (
              <div style={{background:card,borderRadius:14,padding:'16px',marginBottom:16,border:`2px solid ${C.green}`}}>
                <div style={{fontSize:15,fontWeight:800,color:C.green,marginBottom:14}}>
                  🔄 Transactions — {altCodes[0]} (alternative)
                </div>
                <ChampTransaction f={altForm} setF={setAltForm}/>
                <div style={{marginTop:14,background:dark?'#1a233a':'#e8f0fe',borderRadius:12,padding:'14px',border:`1px solid ${C.blue}33`}}>
                  <div style={{fontSize:12,fontWeight:700,color:C.blue,textTransform:'uppercase',marginBottom:6}}>Qté tablette alternative</div>
                  <div style={{fontSize:28,fontWeight:900,color:C.blue,textAlign:'center'}}>{altQteTab.toFixed(0)}</div>
                </div>
                <div style={{marginTop:12,background:dark?'#0d2a18':'#e6f4ea',borderRadius:12,padding:'14px',border:`1px solid ${C.green}33`}}>
                  <div style={{fontSize:12,fontWeight:700,color:C.green,textTransform:'uppercase',marginBottom:6}}>Stock réel alternative</div>
                  <input type="number" step="any" inputMode="numeric" required min="0"
                    value={altForm.qte_reelle}
                    onChange={e=>setAltForm((prev:any)=>({...prev,qte_reelle:e.target.value}))}
                    placeholder="Compter..."
                    style={{...S,fontSize:22,fontWeight:900,textAlign:'center',padding:'12px',borderRadius:10,boxSizing:'border-box',width:'100%',maxWidth:'100%'}}/>
                </div>
                {altForm.qte_reelle !== '' && altAjust !== null && (
                  <div style={{marginTop:12,background:altAjust===0?(dark?'#0d2a18':'#e6f4ea'):(dark?'#2b1113':'#fce8e6'),borderRadius:12,padding:'14px',border:`2px solid ${altAjust===0?C.green:C.red}`}}>
                    <div style={{fontSize:12,fontWeight:700,textTransform:'uppercase',color:altAjust===0?C.green:C.red,marginBottom:4}}>
                      Ajustement alternatif dans Traction
                    </div>
                    <div style={{fontSize:32,fontWeight:900,color:altAjust===0?C.green:C.red,textAlign:'center'}}>
                      {altAjust===0?'✅ Aucun':altAjust>0?`+${altAjust.toFixed(0)}`:`${altAjust.toFixed(0)}`}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Cause + commentaire comptabilité */}
            <div style={{background:card,borderRadius:14,padding:'16px',marginBottom:16,border:`1px solid ${bdr}`}}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:14}}>📝 Justification comptabilité</div>
              <div style={{marginBottom:12}}>
                <div style={{fontSize:12,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:8}}>Cause principale *</div>
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  {CAUSES.map((cause, causeIdx) => (
                    <label key={cause} style={{display:'flex',alignItems:'center',gap:12,background:form.cause===cause?(dark?'#1a233a':'#e8f0fe'):dark?'#1a1a1a':'#f8f9fa',borderRadius:12,padding:isMobile?'16px':'12px 14px',border:`2px solid ${form.cause===cause?C.blue:bdr}`,cursor:'pointer'}}>
                      <input type="radio" name="cause" value={cause} checked={form.cause===cause} onChange={()=>setForm((p:any)=>({...p,cause:cause,causeIdx:causeIdx}))} style={{accentColor:C.blue,width:isMobile?22:18,height:isMobile?22:18,flexShrink:0}}/>
                      <span style={{fontSize:isMobile?15:13,fontWeight:form.cause===cause?700:400,color:form.cause===cause?C.blue:'inherit'}}>{cause}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div style={{fontSize:12,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:6}}>Explication pour la comptabilité *</div>
                <textarea value={form.commentaire_compta} onChange={e=>setForm((p:any)=>({...p,commentaire_compta:e.target.value}))}
                  placeholder="Explique en détail ce qui s'est passé pour permettre l'ajustement en comptabilité..."
                  required rows={4}
                  style={{...S,resize:'vertical',fontSize:14,padding:'12px',borderRadius:10,fontFamily:'inherit'}}/>
              </div>
            </div>

            {/* Photos */}
            <div style={{background:card,borderRadius:14,padding:'16px',marginBottom:16,border:`2px solid ${photoObligatoire(ajust, form.cause, form.causeIdx)&&nbPhotos===0?C.red:nbPhotos>0?C.green:bdr}`}}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:10}}>
                📸 Photos {photoObligatoire(ajust, form.cause, form.causeIdx)?'(obligatoire — écart > 1)':'(optionnel)'}
              </div>
              {photoPreviews.length > 0 && (
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
                  {photoPreviews.map((p,i) => (
                    <div key={i} style={{position:'relative'}}>
                      <img src={p} style={{width:'100%',borderRadius:10,height:isMobile?160:120,objectFit:'cover'}} alt={`Photo ${i+1}`}/>
                      <button onClick={()=>{
                          // En mode édition, les premières previews sont des URLs existantes (editKeptPhotos)
                          if (editNegId && i < editKeptPhotos.length) {
                            setEditKeptPhotos(prev => prev.filter((_,j)=>j!==i))
                          } else {
                            const newFileIdx = editNegId ? i - editKeptPhotos.length : i
                            setPhotoFiles(prev => prev.filter((_,j)=>j!==newFileIdx))
                          }
                          setPhotoPreviews(prev => prev.filter((_,j)=>j!==i))
                        }}
                        style={{position:'absolute',top:4,right:4,background:C.red,border:'none',borderRadius:'50%',width:24,height:24,color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700}}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" onClick={()=>photoRef.current?.click()}
                style={{...btnStyle,background:C.blue,fontSize:15,padding:'14px 0'}}>
                📷 {nbPhotos > 0 ? 'Ajouter une autre photo' : 'Prendre une photo'}
              </button>
            </div>

            {/* Résumé ajustements */}
            {(form.qte_reelle !== '' || (hasAlt && altForm.qte_reelle !== '')) && (
              <div style={{background:dark?'#111':'#f8f9fa',borderRadius:14,padding:'16px',marginBottom:16,border:`1px solid ${bdr}`}}>
                <div style={{fontSize:15,fontWeight:800,marginBottom:12}}>📊 Résumé des ajustements à faire</div>
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  <div style={{background:card,borderRadius:10,padding:'12px 14px',border:`2px solid ${ajust===0?C.green:C.red}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div>
                      <div style={{fontWeight:700,fontFamily:'monospace'}}>{n.code_piece}</div>
                      <div style={{fontSize:12,color:sub}}>Pièce principale</div>
                    </div>
                    <div style={{fontSize:24,fontWeight:900,color:ajust===0?C.green:C.red}}>
                      {ajust===0?'✅':ajust>0?`+${ajust.toFixed(0)}`:`${ajust.toFixed(0)}`}
                    </div>
                  </div>
                  {hasAlt && altForm.qte_reelle !== '' && altAjust !== null && (
                    <div style={{background:card,borderRadius:10,padding:'12px 14px',border:`2px solid ${altAjust===0?C.green:C.red}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                      <div>
                        <div style={{fontWeight:700,fontFamily:'monospace'}}>{altCodes[0]}</div>
                        <div style={{fontSize:12,color:sub}}>Pièce alternative</div>
                      </div>
                      <div style={{fontSize:24,fontWeight:900,color:altAjust===0?C.green:C.red}}>
                        {altAjust===0?'✅':altAjust>0?`+${altAjust.toFixed(0)}`:`${altAjust.toFixed(0)}`}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Bouton soumettre */}
            <button onClick={soumettre} disabled={loading||!allFormsComplet||(photoObligatoire(getAjust(Number(noteModal?.stock_negatif),form),form.cause)&&nbPhotos===0)}
              style={{...btnStyle,background:allFormsComplet&&(!photoObligatoire(ajust, form.cause, form.causeIdx)||nbPhotos>0)?C.green:'#94a3b8',marginBottom:32,fontSize:18,padding:'18px 0'}}>
              {loading?'Enregistrement...':editNegId?'✅ Enregistrer la correction':'✅ Confirmer la vérification'}
            </button>
          </div>
        </div>
      )
    })()}

    {/* Bouton sync + Sous-onglets */}
    <div style={{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap',alignItems:'center'}}>
      <button onClick={lancerSync} disabled={syncing}
        style={{padding:isMobile?'10px 16px':'7px 16px',borderRadius:20,border:`2px solid ${syncing?bdr:'#2563eb'}`,background:syncing?'transparent':'#2563eb22',color:syncing?sub:'#2563eb',fontSize:isMobile?14:12,fontWeight:700,cursor:syncing?'default':'pointer'}}>
        {syncing?'⏳ Sync...':'⚡ Sync ERP'}
      </button>
      <button onClick={()=>setSousOnglet('actif')} style={{padding:isMobile?'10px 16px':'7px 16px',borderRadius:20,border:`2px solid ${sousOnglet==='actif'?C.red:bdr}`,background:sousOnglet==='actif'?C.red+'22':'transparent',color:sousOnglet==='actif'?C.red:sub,fontSize:isMobile?14:12,fontWeight:700,cursor:'pointer'}}>
        🔴 À vérifier ({negsActifs.length})
      </button>
      <button onClick={()=>setSousOnglet('verifie')} style={{padding:isMobile?'10px 16px':'7px 16px',borderRadius:20,border:`2px solid ${sousOnglet==='verifie'?C.green:bdr}`,background:sousOnglet==='verifie'?C.green+'22':'transparent',color:sousOnglet==='verifie'?C.green:sub,fontSize:isMobile?14:12,fontWeight:700,cursor:'pointer'}}>
        ✅ Vérifié ({negsVerifiesVisibles.length})
      </button>
      {syncLog && <span style={{fontSize:11,color:syncLog.startsWith('✅')?C.green:C.red,fontWeight:600}}>{syncLog}</span>}
    </div>

    {sousOnglet === 'actif' ? <>
      {/* Filtres */}
      <div style={{background:card,borderRadius:12,padding:'12px',marginBottom:14,display:'flex',gap:10,flexWrap:'wrap',alignItems:'flex-end',border:`1px solid ${bdr}`}}>
        <div style={{flex:1,minWidth:isMobile?'100%':180}}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Fournisseur</div>
          <select value={filtFourn} onChange={e=>setFiltFourn(e.target.value)} style={S}>
            <option value="ALL">Tous ({negsActifs.length})</option>
            {fournisseurs.map((f:string)=><option key={f} value={f}>{f} ({negsActifs.filter((n:any)=>n.fournisseur===f).length})</option>)}
          </select>
        </div>
        <div style={{flex:1,minWidth:isMobile?'100%':160}} ref={ddLigneRef}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>
            Lignes {filtLignes.length>0&&<span style={{color:C.blue}}>({filtLignes.length})</span>}
          </div>
          <div style={{position:'relative'}}>
            <button onClick={()=>setDdLigneOpen(!ddLigneOpen)} style={{...S,display:'flex',justifyContent:'space-between',alignItems:'center',cursor:'pointer'}}>
              <span>{filtLignes.length===0?'Toutes':filtLignes.length===1?filtLignes[0]:`${filtLignes.length} sélectionnées`}</span>
              <span style={{fontSize:10}}>{ddLigneOpen?'▲':'▼'}</span>
            </button>
            {ddLigneOpen && (
              <div style={{position:'absolute',top:'105%',left:0,right:0,background:card,border:`1px solid ${bdr}`,borderRadius:8,zIndex:500,boxShadow:'0 4px 16px rgba(0,0,0,.15)',maxHeight:220,overflowY:'auto'}}>
                <div style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,display:'flex',justifyContent:'space-between'}}>
                  <span style={{fontSize:11,color:sub}}>Sélectionner lignes</span>
                  {filtLignes.length>0&&<button onClick={()=>setFiltLignes([])} style={{fontSize:11,color:C.red,background:'none',border:'none',cursor:'pointer'}}>Tout décocher</button>}
                </div>
                {lignes.map((l:string)=>(
                  <label key={l} style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',cursor:'pointer',fontSize:13,borderBottom:`1px solid ${dark?'#222':'#f5f5f5'}`}}>
                    <input type="checkbox" checked={filtLignes.includes(l)} onChange={()=>setFiltLignes(prev=>prev.includes(l)?prev.filter(x=>x!==l):[...prev,l])} style={{accentColor:C.blue,width:16,height:16}}/>
                    {l}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        <div style={{background:dark?'#2b1113':'#fce8e6',border:`2px solid ${C.red}`,borderRadius:10,padding:'10px 14px',textAlign:'right',minWidth:isMobile?'100%':180,flex:isMobile?1:0}}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.red}}>Erreur inventaire ({filtered.length})</div>
          <div style={{fontSize:isMobile?22:20,fontWeight:900,color:C.red}}>− {totalErreur.toLocaleString('fr-CA',{minimumFractionDigits:2})} $</div>
        </div>
      </div>

      {/* Liste pièces négatives */}
      {isMobile
        ? <div style={{display:'flex',flexDirection:'column',gap:10}}>
            {filtered.length===0
              ? <div style={{textAlign:'center',padding:50,color:sub,fontSize:14}}>✅ Aucune pièce négative</div>
              : filtered.map((n:any)=>{
                  const val=Math.abs(n.stock_negatif*n.cout_unitaire)
                  const altCodes: string[] = (alts&&alts.get&&alts.get(n.code_piece))||[]
                  return (
                    <div key={n.code_piece} style={{background:card,borderRadius:14,border:`2px solid ${val>500?C.red:val>100?C.yellow:bdr}`,padding:'16px'}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:800,fontSize:16,color:C.red}}>{n.code_piece}</div>
                          <div style={{fontSize:12,color:sub,marginTop:2}}>{n.description}</div>
                          <div style={{fontSize:12,color:sub,marginTop:2}}>{n.fournisseur} • Ligne {n.ligne}</div>
                          {locsMap.get(n.code_piece) && <div style={{fontSize:11,color:C.blue,marginTop:4}}>📍 {locsMap.get(n.code_piece)!.join(', ')}</div>}
                          {altCodes.length>0&&<div style={{fontSize:11,color:C.green,marginTop:4}}>🔄 Alt: {altCodes.join(', ')}</div>}
                        </div>
                        <div style={{textAlign:'right',marginLeft:12}}>
                          <div style={{fontSize:26,fontWeight:900,color:C.red}}>{n.stock_negatif}</div>
                          <div style={{fontSize:13,fontWeight:700,color:C.red}}>− {val.toFixed(2)} $</div>
                        </div>
                      </div>
                      <button onClick={()=>{setNoteModal(n);setForm(emptyForm());setAltForm(emptyForm());setPhotoFiles([]);setPhotoPreviews([])}}
                        style={{...btnStyle,background:C.green,fontSize:16,padding:'14px 0'}}>
                        ✓ Vérifier cette pièce
                      </button>
                    </div>
                  )
                })
            }
          </div>
        : <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                <thead><tr style={{background:thBg}}>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Fournisseur</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Ligne</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`}}>Code Pièce</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`}}>Description</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Localisation</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Stock</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'right'}}>Coût Un.</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`2px solid ${bdr}`,textAlign:'right'}}>Valeur</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Détecté le</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Action</th>
                </tr></thead>
                <tbody>
                  {filtered.length===0
                    ? <tr><td colSpan={10} style={{textAlign:'center',padding:60,color:sub}}>✅ Aucune pièce négative</td></tr>
                    : filtered.map((n:any)=>{
                        const val=Math.abs(n.stock_negatif*n.cout_unitaire)
                        const bgR=val>500?(dark?'#2b1113':'#fff8f8'):val>100?(dark?'#2b2411':'#fffcf5'):'transparent'
                        const dateStr=n.date_apparition?new Date(n.date_apparition).toLocaleDateString('fr-CA',{month:'short',day:'numeric'}):'—'
                        const locs = locsMap.get(n.code_piece)
                        return (
                          <tr key={n.code_piece} style={{background:bgR,borderLeft:val>500?`4px solid ${C.red}`:val>100?`4px solid ${C.yellow}`:'none'}}
                            onMouseEnter={e=>e.currentTarget.style.background=hvr}
                            onMouseLeave={e=>e.currentTarget.style.background=bgR}>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontWeight:600}}>{n.fournisseur}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                              <span style={{background:dark?'#333':'#e2e8f0',color:dark?'#ccc':'#475569',padding:'2px 8px',borderRadius:4,fontSize:12,fontWeight:600}}>{n.ligne}</span>
                            </td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>
                              {n.code_piece}
                              {alts&&alts.get&&alts.get(n.code_piece)&&(alts.get(n.code_piece)||[]).length>0&&
                                <div style={{fontSize:10,color:C.green,marginTop:2}}>✅ Alt: {(alts.get(n.code_piece)||[]).join(', ')}</div>}
                            </td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:sub}} title={n.description}>{n.description}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                              {locs && locs.length > 0
                                ? <div style={{display:'flex',gap:3,flexWrap:'wrap',justifyContent:'center'}}>{locs.map((l,i) => <span key={i} style={{background:dark?'#1a233a':'#dbeafe',color:C.blue,padding:'2px 6px',borderRadius:4,fontSize:11,fontWeight:700}}>{l}</span>)}</div>
                                : <span style={{color:sub,fontSize:11}}>—</span>
                              }
                            </td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.red,fontWeight:900,fontSize:17}}>{n.stock_negatif}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{n.cout_unitaire.toFixed(2)} $</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:C.red,fontWeight:700}}>− {val.toFixed(2)} $</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:sub,fontSize:12}}>{dateStr}</td>
                            <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                              <button onClick={()=>{setNoteModal(n);setForm(emptyForm());setAltForm(emptyForm());setPhotoFiles([]);setPhotoPreviews([])}}
                                style={{background:C.green+'22',color:C.green,border:`1px solid ${C.green}`,borderRadius:6,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>
                                ✓ Vérifié
                              </button>
                            </td>
                          </tr>
                        )
                      })
                  }
                </tbody>
              </table>
            </div>
          </div>
      }
    </> : <>
      {/* Tableau vérifié */}
      <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
        {isMobile
          ? <div style={{display:'flex',flexDirection:'column',gap:10,padding:'10px'}}>
              {negsVerifiesVisibles.length===0
                ? <div style={{textAlign:'center',padding:40,color:sub}}>Aucune pièce vérifiée</div>
                : negsVerifiesVisibles.map((v:any)=>(
                    <div key={v.id} style={{background:card,borderRadius:14,border:`2px solid ${Number(v.ajustement)!==0?C.red:C.green}`,padding:'16px',marginBottom:4}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12}}>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:900,fontSize:17,fontFamily:'monospace'}}>{v.code_piece}</div>
                          {descByCode.get(v.code_piece) && <div style={{fontSize:12,color:sub,marginTop:2,fontWeight:400}}>{descByCode.get(v.code_piece)}</div>}
                          <div style={{fontSize:12,color:sub,marginTop:4}}>👤 {v.employe}</div>
                          <div style={{fontSize:11,color:sub}}>{new Date(v.date_verification).toLocaleDateString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
                          {(() => {
                            const s = statutDoubleVerif(v); if (!s) return null
                            return (
                              <div style={{display:'inline-block',marginTop:6,background:s.color+'22',color:s.color,padding:'3px 8px',borderRadius:6,fontSize:11,fontWeight:800}}
                                title={s.valide_par ? `Validé par ${s.valide_par}` : 'En attente de double-vérification admin'}>
                                {s.label}{s.valide_par?` — ${s.valide_par}`:''}
                              </div>
                            )
                          })()}
                        </div>
                        <div style={{textAlign:'right'}}>
                          <div style={{fontSize:11,color:sub,marginBottom:2}}>Ajustement</div>
                          <div style={{fontSize:28,fontWeight:900,color:Number(v.ajustement)===0?C.green:C.red}}>
                            {Number(v.ajustement)>=0?'+':''}{Number(v.ajustement).toFixed(0)}
                          </div>
                          <div style={{display:'flex',gap:6,justifyContent:'flex-end',marginTop:4}}>
                            {v.photo_url&&(
                              <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
                                <a href={v.photo_url} target="_blank" rel="noreferrer">
                                  <img src={v.photo_url} onError={(e:any)=>{e.target.style.display='none';e.target.parentElement.innerHTML='📸 <span style="font-size:10px;color:#888">Indisponible</span>'}} style={{width:54,height:54,objectFit:'cover',borderRadius:6,border:`2px solid ${C.green}`}} alt="📸"/>
                                </a>
                                <a href={v.photo_url} download target="_blank" rel="noreferrer" style={{fontSize:10,color:C.blue,textDecoration:'none',fontWeight:700}}>⬇ DL</a>
                              </div>
                            )}
                            {v.photo_url2&&(
                              <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:2,marginLeft:4}}>
                                <a href={v.photo_url2} target="_blank" rel="noreferrer">
                                  <img src={v.photo_url2} onError={(e:any)=>{e.target.style.display='none';e.target.parentElement.innerHTML='📸 <span style="font-size:10px;color:#888">Indisponible</span>'}} style={{width:54,height:54,objectFit:'cover',borderRadius:6,border:`2px solid ${C.green}`}} alt="📸"/>
                                </a>
                                <a href={v.photo_url2} download target="_blank" rel="noreferrer" style={{fontSize:10,color:C.blue,textDecoration:'none',fontWeight:700}}>⬇ DL</a>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <div style={{background:dark?'#1a1a1a':'#f8f9fa',borderRadius:10,padding:'10px 12px',marginBottom:10}}>
                        <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:6}}>Stocks au moment</div>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,textAlign:'center'}}>
                          <div><div style={{fontSize:10,color:sub}}>Système</div><div style={{fontSize:18,fontWeight:900,color:C.red}}>{v.stock_au_moment}</div></div>
                          <div><div style={{fontSize:10,color:sub}}>Tablette</div><div style={{fontSize:18,fontWeight:900,color:C.blue}}>{v.qte_reelle??'—'}</div></div>
                          <div><div style={{fontSize:10,color:sub}}>Valeur</div><div style={{fontSize:13,fontWeight:700,color:C.red}}>−{Number(v.valeur_au_moment).toFixed(0)}$</div></div>
                        </div>
                      </div>
                      <div style={{background:dark?'#1a1a1a':'#f8f9fa',borderRadius:10,padding:'10px 12px',marginBottom:10}}>
                        <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:8}}>Transactions</div>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:4}}>
                          {[{l:'Serv. détail',v2:v.serv_detail},{l:'Serv. interne',v2:v.serv_interne},{l:'Serv. gar.',v2:v.serv_gar},{l:'Pce détail',v2:v.pce_detail},{l:'Récept. comm.',v2:v.recept_comm},{l:'Déc. physique',v2:v.dec_physique},{l:'Autre',v2:v.autre}].map(t=>(
                            <div key={t.l} style={{display:'flex',justifyContent:'space-between',fontSize:12,padding:'3px 0',borderBottom:`1px solid ${bdr}`}}>
                              <span style={{color:sub}}>{t.l}</span>
                              <span style={{fontWeight:700,color:Number(t.v2)===0?sub:Number(t.v2)<0?C.red:C.green}}>{Number(t.v2??0)>0?'+':''}{Number(t.v2??0).toFixed(0)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      {v.cause&&<div style={{background:dark?'#1a233a':'#e8f0fe',borderRadius:8,padding:'10px 12px',fontSize:13,whiteSpace:'pre-wrap',wordBreak:'break-word',color:C.blue,marginBottom:8,fontWeight:600}}>📋 {v.cause}</div>}
                      {v.cause && CAUSES_MESSAGES[v.cause] && (
                        <div style={{background:dark?'#2b2413':'#fef3cd',border:`1px solid ${C.yellow}`,borderRadius:8,padding:'10px 12px',fontSize:13,color:dark?'#ffc107':'#856404',marginBottom:8,fontWeight:700}}>
                          {CAUSES_MESSAGES[v.cause]}
                        </div>
                      )}
                      {v.commentaire&&<div style={{background:dark?'#1a1a1a':'#f8f9fa',borderRadius:8,padding:'10px 12px',fontSize:12,color:sub,marginBottom:8,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>💬 {v.commentaire}</div>}
                      {v.alt_code_piece&&(
                        <div style={{background:dark?'#0d2a18':'#e6f4ea',borderRadius:10,padding:'10px 12px',marginBottom:8,border:`1px solid ${C.green}33`}}>
                          <div style={{fontSize:12,fontWeight:700,color:C.green,marginBottom:4}}>🔄 Alternative — {v.alt_code_piece}</div>
                          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                            <span style={{fontSize:12,color:sub}}>Ajustement alternatif</span>
                            <span style={{fontSize:20,fontWeight:900,color:Number(v.alt_ajustement)===0?C.green:C.red}}>{Number(v.alt_ajustement)>=0?'+':''}{Number(v.alt_ajustement??0).toFixed(0)}</span>
                          </div>
                          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:3}}>
                            {[{l:'Serv. détail',v2:v.alt_serv_detail},{l:'Serv. interne',v2:v.alt_serv_interne},{l:'Serv. gar.',v2:v.alt_serv_gar},{l:'Pce détail',v2:v.alt_pce_detail},{l:'Récept. comm.',v2:v.alt_recept_comm},{l:'Déc. physique',v2:v.alt_dec_physique},{l:'Autre',v2:v.alt_autre}].map(t=>(
                              <div key={t.l} style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'2px 0',borderBottom:`1px solid ${bdr}`}}>
                                <span style={{color:sub}}>{t.l}</span>
                                <span style={{fontWeight:700,color:Number(t.v2)===0?sub:Number(t.v2)<0?C.red:C.green}}>{Number(t.v2??0)>0?'+':''}{Number(t.v2??0).toFixed(0)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <button onClick={()=>retablir(v.id)} style={{marginTop:8,background:C.yellow+'22',color:C.yellow,border:`1px solid ${C.yellow}`,borderRadius:8,padding:'10px 0',fontSize:13,fontWeight:700,cursor:'pointer',width:'100%'}}>
                        ↩ Rétablir dans À vérifier
                      </button>
                    </div>
                  ))
              }
            </div>
          : <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead><tr style={{background:thBg}}>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`}}>Code</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Stock</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Ajust.</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`2px solid ${bdr}`}}>Cause</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`}}>Commentaire</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.green,borderBottom:`2px solid ${bdr}`}}>Alt.</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Photos</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Serv.D</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Serv.I</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Serv.G</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Pce.D</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Récept.</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Déc.P</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Autre</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.green,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Tablette</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`}}>Vérifié par</th>
                  <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Date</th>
                  <th style={{padding:'9px 8px',borderBottom:`2px solid ${bdr}`}}></th>
                </tr></thead>
                <tbody>
                  {negsVerifiesVisibles.length===0
                    ? <tr><td colSpan={19} style={{textAlign:'center',padding:60,color:sub}}>Aucune pièce vérifiée</td></tr>
                    : negsVerifiesVisibles.map((v:any)=>(
                        <tr key={v.id} onMouseEnter={e=>e.currentTarget.style.background=hvr} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontWeight:700,fontFamily:'monospace',fontSize:11}}>
                            <div>{v.code_piece}</div>
                            {descByCode.get(v.code_piece) && (
                              <div style={{fontFamily:'sans-serif',fontSize:10,fontWeight:400,color:sub,marginTop:2,maxWidth:200,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}} title={descByCode.get(v.code_piece)}>
                                {descByCode.get(v.code_piece)}
                              </div>
                            )}
                            {(() => {
                              const s = statutDoubleVerif(v); if (!s) return null
                              return (
                                <div style={{display:'inline-block',marginTop:3,background:s.color+'22',color:s.color,padding:'1px 6px',borderRadius:4,fontSize:10,fontWeight:800,fontFamily:'sans-serif'}}
                                  title={s.valide_par ? `Validé par ${s.valide_par}` : 'En attente de double-vérification admin'}>
                                  {s.label}
                                </div>
                              )
                            })()}
                          </td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.red,fontWeight:700}}>{v.stock_au_moment}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:900,color:Number(v.ajustement)>=0?C.green:C.red}}>
                            {Number(v.ajustement)>=0?'+':''}{Number(v.ajustement).toFixed(0)}
                          </td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:C.blue,maxWidth:180,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{v.cause||'—'}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,maxWidth:200,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{v.commentaire||'—'}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>
                            {v.alt_code_piece&&<div style={{color:C.green,fontWeight:700}}>{v.alt_code_piece}<br/><span style={{color:Number(v.alt_ajustement)>=0?C.green:C.red}}>{Number(v.alt_ajustement)>=0?'+':''}{Number(v.alt_ajustement)?.toFixed(0)}</span></div>}
                          </td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                            <div style={{display:'flex',gap:6,justifyContent:'center',flexWrap:'wrap'}}>
                              {v.photo_url&&(
                                <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:1}}>
                                  <a href={v.photo_url} target="_blank" rel="noreferrer">
                                    <img src={v.photo_url} onError={(e:any)=>{e.target.style.display='none';e.target.parentElement.innerHTML='📸'}} style={{width:36,height:36,objectFit:'cover',borderRadius:4,border:`1px solid ${C.green}`}} alt="📸"/>
                                  </a>
                                  <a href={v.photo_url} download target="_blank" rel="noreferrer" style={{fontSize:9,color:C.blue,textDecoration:'none',fontWeight:700}}>⬇ DL</a>
                                </div>
                              )}
                              {v.photo_url2&&(
                                <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:1}}>
                                  <a href={v.photo_url2} target="_blank" rel="noreferrer">
                                    <img src={v.photo_url2} onError={(e:any)=>{e.target.style.display='none';e.target.parentElement.innerHTML='📸'}} style={{width:36,height:36,objectFit:'cover',borderRadius:4,border:`1px solid ${C.green}`}} alt="📸"/>
                                  </a>
                                  <a href={v.photo_url2} download target="_blank" rel="noreferrer" style={{fontSize:9,color:C.blue,textDecoration:'none',fontWeight:700}}>⬇ DL</a>
                                </div>
                              )}
                              {!v.photo_url&&<span style={{color:sub,fontSize:11}}>—</span>}
                            </div>
                          </td>
                          {[v.serv_detail,v.serv_interne,v.serv_gar,v.pce_detail,v.recept_comm,v.dec_physique,v.autre].map((val,i)=>(
                            <td key={i} style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontSize:11,fontWeight:600,color:Number(val)===0?sub:Number(val)<0?C.red:C.green}}>
                              {Number(val??0)>0?'+':''}{Number(val??0).toFixed(0)}
                            </td>
                          ))}
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontSize:11,fontWeight:700,color:C.green}}>{Number(v.qte_reelle??0).toFixed(0)}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`}}>
                            <span style={{background:C.blue+'22',color:C.blue,padding:'2px 6px',borderRadius:10,fontSize:10}}>👤 {v.employe}</span>
                          </td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:sub,fontSize:11,whiteSpace:'nowrap'}}>
                            {new Date(v.date_verification).toLocaleDateString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
                          </td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`}}>
                            <button onClick={()=>retablir(v.id)} style={{background:C.yellow+'22',color:C.yellow,border:'none',borderRadius:6,padding:'4px 8px',fontSize:11,cursor:'pointer',fontWeight:700}}>↩</button>
                          </td>
                        </tr>
                      ))
                  }
                </tbody>
              </table>
            </div>
        }
      </div>
    </>}
  </>
}

// ── Comptabilité Tab ─────────────────────────────────────────────────────────
// ── Comptabilité Tab ─────────────────────────────────────────────────────────
// Onglet de DOUBLE VÉRIFICATION admin : tout comptage / pièce négative avec
// |écart| > 3 doit y passer avant d'apparaître en Comptabilité.
function VerificationTab({dark, card, bdr, sub, thBg, S, C, hvr, profil, negsVerifies, verifsDoubles, setVerifsDoubles, validationsCompta}: any) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const userEmail = profil?.email || profil?.nom || 'Inconnu'
  const SEUIL = 3
  const [comptages, setComptages] = useState<any[]>([])
  const [locsParCode, setLocsParCode] = useState<Map<string, Set<string>>>(new Map())
  const [descParCode, setDescParCode] = useState<Map<string, string>>(new Map())
  const [retoursActifs, setRetoursActifs] = useState<any[]>([])
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingAction, setLoadingAction] = useState<string|null>(null)
  const [retourModal, setRetourModal] = useState<{ source: 'negatif'|'comptage'; ids: number[]; code_piece: string; demandeur: string } | null>(null)
  const [retourCommentaire, setRetourCommentaire] = useState('')
  const [validerModal, setValiderModal] = useState<{ source: 'negatif'|'comptage'; ids: number[]; code_piece: string; ecart: number; snapshot: any } | null>(null)
  const [validerCommentaire, setValiderCommentaire] = useState('')

  async function recharger() {
    try {
      const [c, vd, r] = await Promise.all([
        fetch('/api/inventaire/comptages').then(r=>r.json()),
        fetch('/api/verifications-doubles').then(r=>r.json()),
        fetch('/api/comptabilite/retours?actifs=1').then(r=>r.json()).catch(()=>[]),
      ])
      if (Array.isArray(c)) setComptages(c)
      if (Array.isArray(vd) && setVerifsDoubles) setVerifsDoubles(vd)
      if (Array.isArray(r)) setRetoursActifs(r)

      if (Array.isArray(c)) {
        const codesUniques = Array.from(new Set(c
          .filter((x:any) => x.statut === 'reconcilie' || x.statut === 'en_attente')
          .map((x:any) => x.code_piece)
          .filter(Boolean)))
        if (codesUniques.length > 0) {
          const rLoc = await fetch('/api/inventaire/localisations?codes=' + encodeURIComponent(codesUniques.join('|')))
          const rows = await rLoc.json()
          if (Array.isArray(rows)) {
            const map = new Map<string, Set<string>>()
            const desc = new Map<string, string>()
            for (const row of rows) {
              if (!row.code_piece || row.code_piece.startsWith('LOC_')) continue
              const set = map.get(row.code_piece) || new Set<string>()
              for (const l of [row.localisation1, row.localisation2, row.localisation3, row.localisation4]) {
                if (l) set.add(String(l).toUpperCase())
              }
              map.set(row.code_piece, set)
              if (row.description && !desc.has(row.code_piece)) desc.set(row.code_piece, String(row.description))
            }
            for (const n of (negsVerifies || [])) {
              if (n.code_piece && n.description && !desc.has(n.code_piece)) desc.set(n.code_piece, String(n.description))
            }
            setLocsParCode(map)
            setDescParCode(desc)
          }
        }
      }
    } catch {}
  }
  useEffect(() => { recharger() }, [])

  const validations = validationsCompta || []
  const validesKey = new Set(validations.map((v:any) => `${v.source}:${v.ref_id}`))
  const estValide = (s:string, id:any) => validesKey.has(`${s}:${id}`)
  const retournesKey = new Set((retoursActifs||[]).map((r:any) => `${r.source}:${r.ref_id}`))
  const estRetourne = (s:string, id:any) => retournesKey.has(`${s}:${id}`)
  const verifsKey = new Map<string, any>()
  for (const v of (verifsDoubles || [])) verifsKey.set(`${v.source}:${v.ref_id}`, v)
  const dejaVerifie = (source: string, ids: number[]) => ids.some(id => verifsKey.has(`${source}:${id}`))

  type ItemV = {
    key: string; source: 'negatif'|'comptage'; ids: number[]; code_piece: string;
    date: string; ecart: number; valeur: number; employe: string; raw: any;
  }
  const items: ItemV[] = []
  // Causes qui ne nécessitent PAS d'action comptable — elles passent par
  // Vérification pour validation admin, indépendamment du seuil d'écart.
  const CAUSES_HORS_COMPTA = [
    'Pièce non réceptionnée mais facturée (logiciel/service)',
    'Réservation (pièce mal importée dans facture)',
    'Double facturation',
  ]
  for (const n of (negsVerifies||[])) {
    if (estValide('negatif', n.id)) continue
    if (estRetourne('negatif', n.id)) continue
    if (dejaVerifie('negatif', [n.id])) continue     // déjà validé → fin du parcours
    const ecart = Number(n.ajustement || 0)
    const horsCompta = !!(n.cause && CAUSES_HORS_COMPTA.includes(n.cause))
    // Critères d'entrée en Vérification :
    //  - cause hors comptabilité (quelle que soit la valeur de l'écart) ; OU
    //  - |écart| > seuil (double-vérif obligatoire avant Compta)
    if (!horsCompta && Math.abs(ecart) <= SEUIL) continue
    items.push({
      key: `negatif:${n.id}`, source: 'negatif', ids: [n.id], code_piece: n.code_piece,
      date: n.date_verification, ecart, valeur: Number(n.valeur_au_moment || 0),
      employe: n.employe || '', raw: { ...n, _hors_compta: horsCompta },
    })
  }
  // Comptages multi-loc / single-loc — même logique d'agrégation que ComptabiliteTab
  const compteesParCode = new Map<string, Set<string>>()
  for (const c of (comptages || [])) {
    if (c.statut === 'obsolete' || c.statut === 'resolu') continue
    const set = compteesParCode.get(c.code_piece) || new Set<string>()
    set.add(String(c.localisation || '').toUpperCase())
    compteesParCode.set(c.code_piece, set)
  }
  const codesMultiTraites = new Set<string>()
  for (const c of (comptages || [])) {
    if (c.statut !== 'reconcilie') continue
    const locsConnues = locsParCode.get(c.code_piece) || new Set<string>()
    const estMultiLoc = locsConnues.size > 1
    if (estMultiLoc) {
      if (codesMultiTraites.has(c.code_piece)) continue
      codesMultiTraites.add(c.code_piece)
      const compteesLoc = compteesParCode.get(c.code_piece) || new Set<string>()
      const toutesComptees = Array.from(locsConnues).every(l => compteesLoc.has(l))
      if (!toutesComptees) continue
      const reconcs = (comptages || []).filter((x:any) => x.code_piece === c.code_piece && x.statut === 'reconcilie')
      const sumComptee = reconcs.reduce((s:number, x:any) => s + Number(x.qte_comptee || 0), 0)
      const oldest = [...reconcs].sort((a:any,b:any) => new Date(a.date_comptage).getTime() - new Date(b.date_comptage).getTime())[0]
      const latest = [...reconcs].sort((a:any,b:any) => new Date(b.date_reconciliation || b.date_comptage).getTime() - new Date(a.date_reconciliation || a.date_comptage).getTime())[0]
      const ajust = sumComptee - Number(oldest?.qte_systeme || 0)
      if (ajust === 0) continue
      if (Math.abs(ajust) <= SEUIL) continue
      const ids = reconcs.map((x:any) => x.id)
      if (ids.some((id:number) => estValide('comptage', id))) continue
      if (ids.some((id:number) => estRetourne('comptage', id))) continue
      if (dejaVerifie('comptage', ids)) continue
      items.push({
        key: `comptage:multi:${c.code_piece}`, source: 'comptage', ids, code_piece: c.code_piece,
        date: latest?.date_reconciliation || latest?.date_comptage || c.date_comptage, ecart: ajust,
        valeur: 0, employe: Array.from(new Set(reconcs.map((x:any) => x.employe).filter(Boolean))).join(', '),
        raw: { ...latest, qte_comptee: sumComptee, qte_systeme: Number(oldest?.qte_systeme || 0),
          multi_loc: true, nb_locs: locsConnues.size,
          locs_connues: Array.from(locsConnues),
          comptages_par_loc: reconcs.map((x:any) => ({
            id: x.id, localisation: x.localisation, qte_comptee: x.qte_comptee,
            employe: x.employe, date_comptage: x.date_comptage, note: x.note, photo_url: x.photo_url
          })),
        },
      })
    } else {
      let ajust: number
      if (c.stock_apres_sync !== null && c.stock_apres_sync !== undefined) ajust = Number(c.qte_comptee || 0) - Number(c.stock_apres_sync)
      else ajust = Number(c.ecart_reconcilie || 0)
      if (ajust === 0) continue
      if (Math.abs(ajust) <= SEUIL) continue
      if (estValide('comptage', c.id)) continue
      if (estRetourne('comptage', c.id)) continue
      if (dejaVerifie('comptage', [c.id])) continue
      items.push({
        key: `comptage:${c.id}`, source: 'comptage', ids: [c.id], code_piece: c.code_piece,
        date: c.date_reconciliation || c.date_comptage, ecart: ajust, valeur: 0,
        employe: c.employe || '', raw: c,
      })
    }
  }

  const searchLower = search.trim().toLowerCase()
  const itemsFiltered = items.filter(it => !searchLower || it.code_piece.toLowerCase().includes(searchLower))
  itemsFiltered.sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart))

  const fmtDate = (d:string) => d ? new Date(d).toLocaleDateString('fr-CA',{year:'2-digit',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'

  function toggleExpand(k: string) {
    setExpanded(prev => { const s = new Set(prev); if (s.has(k)) s.delete(k); else s.add(k); return s })
  }

  async function envoyerValidation() {
    if (!validerModal) return
    setLoadingAction(`valid:${validerModal.code_piece}`)
    try {
      const r = await fetch('/api/verifications-doubles', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          source: validerModal.source, ref_ids: validerModal.ids,
          code_piece: validerModal.code_piece, ecart: validerModal.ecart,
          snapshot: validerModal.snapshot, valide_par: userEmail,
          commentaire: validerCommentaire.trim() || null,
        }),
      })
      const j = await r.json()
      if (j.erreur) { alert(j.erreur); return }
      setValiderModal(null)
      setValiderCommentaire('')
      await recharger()
    } finally { setLoadingAction(null) }
  }

  async function envoyerRetour() {
    if (!retourModal) return
    const commentaire = retourCommentaire.trim()
    if (!commentaire) { alert('Le commentaire est obligatoire.'); return }
    setLoadingAction(`retour:${retourModal.code_piece}`)
    try {
      for (const id of retourModal.ids) {
        await fetch('/api/comptabilite/retours', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            source: retourModal.source, ref_id: id, code_piece: retourModal.code_piece,
            demandeur_employe: retourModal.demandeur, comptable_email: userEmail,
            commentaire_retour: commentaire,
          }),
        })
      }
      setRetourModal(null); setRetourCommentaire('')
      await recharger()
    } finally { setLoadingAction(null) }
  }

  const valeurTotale = itemsFiltered.reduce((s, it) => s + Math.abs(it.valeur), 0)

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:10,marginBottom:12}}>
        <div>
          <div style={{fontSize:20,fontWeight:900}}>🔍 Double vérification</div>
          <div style={{fontSize:11,color:sub,marginTop:2}}>Tout écart supérieur à {SEUIL} unités doit être validé ici avant d'aller en Comptabilité</div>
        </div>
        <button onClick={recharger} style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'7px 12px',fontWeight:700,cursor:'pointer',fontSize:12}}>🔄 Actualiser</button>
      </div>

      <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:10,display:'flex',gap:18,flexWrap:'wrap',alignItems:'center',fontSize:12}}>
        <div><span style={{color:sub}}>À vérifier : </span><strong style={{fontSize:15,color:dark?'#fff':'#1a1a1a'}}>{items.length}</strong></div>
        <div style={{color:sub}}>•</div>
        <div><span style={{color:C.red}}>🔴 Nég : </span><strong>{items.filter(i=>i.source==='negatif').length}</strong></div>
        <div><span style={{color:C.blue}}>📦 Cpt : </span><strong>{items.filter(i=>i.source==='comptage').length}</strong></div>
        <div style={{color:sub}}>•</div>
        <div><span style={{color:sub}}>Valeur en jeu : </span><strong style={{color:C.red}}>{valeurTotale.toFixed(0)}$</strong></div>
      </div>

      <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:10}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Rechercher par code pièce…"
          style={{...S,maxWidth:240,fontSize:12,padding:'7px 10px'}}/>
      </div>

      <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
        {items.length === 0 ? (
          <div style={{padding:30,textAlign:'center',color:sub,fontSize:13}}>
            ✅ Aucune pièce en attente de double-vérification
          </div>
        ) : (
          <>
            <div style={{display:'flex',gap:10,padding:'10px 12px',borderBottom:`1px solid ${bdr}`,background:thBg,fontWeight:700,fontSize:11,textTransform:'uppercase',color:sub}}>
              <div style={{width:60}}>Type</div>
              <div style={{flex:isMobile?2:1.5,minWidth:120}}>Pièce</div>
              <div style={{width:isMobile?80:90,textAlign:'center'}}>Écart</div>
              {!isMobile && <div style={{width:80,textAlign:'right'}}>Valeur</div>}
              {!isMobile && <div style={{width:120}}>Par</div>}
              {!isMobile && <div style={{width:110,textAlign:'right'}}>Date</div>}
              <div style={{width:isMobile?100:180,textAlign:'right'}}></div>
            </div>
            {itemsFiltered.map(it => {
              const isExp = expanded.has(it.key)
              const ecartColor = it.ecart >= 0 ? C.green : C.red
              return (
                <div key={it.key} style={{borderBottom:`1px solid ${bdr}`}}>
                  <div onClick={()=>toggleExpand(it.key)}
                    onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr}
                    onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}
                    style={{display:'flex',gap:10,padding:'10px 12px',alignItems:'center',cursor:'pointer'}}>
                    <div style={{width:60}}>
                      <span style={{background:(it.source==='negatif'?C.red:C.blue)+'22',color:it.source==='negatif'?C.red:C.blue,padding:'2px 6px',borderRadius:8,fontSize:10,fontWeight:700}}>{it.source==='negatif'?'🔴 Nég':'📦 Cpt'}</span>
                    </div>
                    <div style={{flex:isMobile?2:1.5,minWidth:120,fontWeight:700,fontFamily:'monospace',fontSize:13,overflow:'hidden'}}>
                      <span style={{display:'inline-block',width:14,color:sub,fontFamily:'sans-serif'}}>{isExp?'▼':'▶'}</span>
                      {it.code_piece}
                      {it.raw?.multi_loc && (
                        <span style={{marginLeft:6,fontSize:10,padding:'1px 6px',borderRadius:4,background:C.blue+'22',color:C.blue,fontWeight:700,fontFamily:'sans-serif',whiteSpace:'nowrap'}}>
                          📍 Multi-loc ({it.raw.nb_locs})
                        </span>
                      )}
                      {it.raw?._hors_compta && (
                        <span style={{marginLeft:6,fontSize:10,padding:'1px 6px',borderRadius:4,background:C.yellow+'22',color:C.yellow,fontWeight:700,fontFamily:'sans-serif',whiteSpace:'nowrap'}}
                          title="Cause hors comptabilité — pas une écriture comptable">
                          📋 Hors compta
                        </span>
                      )}
                      {descParCode.get(it.code_piece) && (
                        <div style={{fontFamily:'sans-serif',fontSize:11,fontWeight:400,color:sub,marginTop:2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}} title={descParCode.get(it.code_piece)}>
                          {descParCode.get(it.code_piece)}
                        </div>
                      )}
                      {it.raw?._hors_compta && it.raw?.cause && (
                        <div style={{fontFamily:'sans-serif',fontSize:11,fontWeight:600,color:C.yellow,marginTop:2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}} title={it.raw.cause}>
                          📋 {it.raw.cause}
                        </div>
                      )}
                    </div>
                    <div style={{width:isMobile?80:90,textAlign:'center',fontSize:18,fontWeight:900,color:ecartColor}}>
                      {it.ecart>=0?'+':''}{it.ecart.toFixed(0)}
                    </div>
                    {!isMobile && <div style={{width:80,textAlign:'right',fontSize:12,fontWeight:700,color:it.valeur>0?C.red:sub}}>
                      {it.valeur>0?`−${it.valeur.toFixed(0)}$`:'—'}
                    </div>}
                    {!isMobile && <div style={{width:120,fontSize:11,color:sub,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>👤 {it.employe}</div>}
                    {!isMobile && <div style={{width:110,textAlign:'right',fontSize:11,color:sub,whiteSpace:'nowrap'}}>{fmtDate(it.date)}</div>}
                    <div style={{width:isMobile?100:180,textAlign:'right',display:'flex',gap:4,justifyContent:'flex-end'}}>
                      <button disabled={loadingAction!==null}
                        onClick={(e:any)=>{e.stopPropagation();setRetourModal({source:it.source,ids:it.ids,code_piece:it.code_piece,demandeur:it.employe});setRetourCommentaire('')}}
                        title="Retourner au demandeur pour recompte"
                        style={{background:'transparent',border:`1px solid ${C.yellow}`,color:C.yellow,borderRadius:6,padding:'6px 9px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                        ↩
                      </button>
                      <button disabled={loadingAction!==null}
                        onClick={(e:any)=>{e.stopPropagation();setValiderModal({source:it.source,ids:it.ids,code_piece:it.code_piece,ecart:it.ecart,snapshot:it.raw});setValiderCommentaire('')}}
                        style={{background:C.green,color:'#fff',border:'none',borderRadius:6,padding:'6px 11px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                        ✓ Valider
                      </button>
                    </div>
                  </div>
                  {isExp && (
                    <div style={{background:dark?'#0f0f0f':'#fafbfc',padding:'14px 16px',borderTop:`1px solid ${bdr}`}}>
                      {it.source === 'comptage' ? (
                        <>
                          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,textAlign:'center',background:card,borderRadius:8,padding:'10px 12px',border:`1px solid ${bdr}`,marginBottom:10}}>
                            <div><div style={{fontSize:9,color:sub}}>{it.raw.multi_loc?'Système (snap)':'Système'}</div><div style={{fontSize:16,fontWeight:900,color:C.blue}}>{it.raw.qte_systeme}</div></div>
                            <div><div style={{fontSize:9,color:sub}}>{it.raw.multi_loc?'Compté (Σ)':'Compté'}</div><div style={{fontSize:16,fontWeight:900,color:C.green}}>{it.raw.qte_comptee}</div></div>
                            <div><div style={{fontSize:9,color:sub}}>Stock J+1</div><div style={{fontSize:16,fontWeight:900,color:C.blue}}>{it.raw.stock_apres_sync??'—'}</div></div>
                            <div><div style={{fontSize:9,color:sub}}>Loc</div><div style={{fontSize:13,fontWeight:700,fontFamily:'monospace',color:C.blue}}>{it.raw.multi_loc?(it.raw.locs_connues||[]).join(', '):it.raw.localisation}</div></div>
                          </div>
                          {it.raw.multi_loc && Array.isArray(it.raw.comptages_par_loc) && (
                            <div style={{background:card,borderRadius:8,padding:'10px 12px',border:`1px solid ${bdr}`,marginBottom:10}}>
                              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:8}}>Détail par localisation</div>
                              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                                {it.raw.comptages_par_loc.map((p:any) => (
                                  <div key={p.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:12,borderBottom:`1px dotted ${bdr}`,paddingBottom:4}}>
                                    <span style={{fontFamily:'monospace',fontWeight:700,color:C.blue}}>{p.localisation}</span>
                                    <span style={{color:sub}}>👤 {p.employe || '—'}</span>
                                    <span style={{fontWeight:900,color:C.green}}>{Number(p.qte_comptee||0)} unité(s)</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {it.raw.note && <div style={{background:dark?'#1a1a1a':'#f1f3f5',borderRadius:6,padding:'8px 12px',fontSize:12,color:sub,whiteSpace:'pre-wrap'}}>💬 {it.raw.note}</div>}
                          {it.raw.photo_url && (
                            <a href={it.raw.photo_url} target="_blank" rel="noreferrer" style={{display:'inline-block',marginTop:10}}>
                              <img src={it.raw.photo_url} alt="" style={{width:160,height:110,objectFit:'cover',borderRadius:6,border:`2px solid ${C.green}`}}/>
                            </a>
                          )}
                        </>
                      ) : (
                        <div style={{background:card,borderRadius:8,padding:'10px 12px',border:`1px solid ${bdr}`}}>
                          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,textAlign:'center',marginBottom:8}}>
                            <div><div style={{fontSize:9,color:sub}}>Système (au moment)</div><div style={{fontSize:16,fontWeight:900,color:C.red}}>{it.raw.stock_au_moment}</div></div>
                            <div><div style={{fontSize:9,color:sub}}>Tablette</div><div style={{fontSize:16,fontWeight:900,color:C.blue}}>{it.raw.qte_reelle??'—'}</div></div>
                            <div><div style={{fontSize:9,color:sub}}>Valeur</div><div style={{fontSize:13,fontWeight:700,color:C.red}}>−{Number(it.raw.valeur_au_moment||0).toFixed(0)}$</div></div>
                          </div>
                          {it.raw.commentaire && <div style={{background:dark?'#1a1a1a':'#f1f3f5',borderRadius:6,padding:'8px 12px',fontSize:12,color:sub,whiteSpace:'pre-wrap'}}>💬 {it.raw.commentaire}</div>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* Modale validation */}
      {validerModal && (
        <div onClick={()=>{setValiderModal(null);setValiderCommentaire('')}}
          style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:16}}>
          <div onClick={(e:any)=>e.stopPropagation()} style={{background:card,borderRadius:12,padding:'18px 22px',maxWidth:500,width:'100%',border:`2px solid ${C.green}`}}>
            <div style={{fontSize:16,fontWeight:900,color:C.green,marginBottom:8}}>✓ Valider la double-vérification</div>
            <div style={{fontSize:13,color:sub,marginBottom:12}}>
              Pièce <strong style={{fontFamily:'monospace'}}>{validerModal.code_piece}</strong> — écart <strong>{validerModal.ecart>=0?'+':''}{validerModal.ecart}</strong>
            </div>
            <textarea value={validerCommentaire} onChange={e=>setValiderCommentaire(e.target.value)}
              placeholder="Commentaire (optionnel)"
              style={{...S,width:'100%',minHeight:80,fontSize:12,padding:8,resize:'vertical'}}/>
            <div style={{display:'flex',gap:8,marginTop:12,justifyContent:'flex-end'}}>
              <button onClick={()=>{setValiderModal(null);setValiderCommentaire('')}}
                style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                Annuler
              </button>
              <button disabled={loadingAction!==null} onClick={envoyerValidation}
                style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'8px 16px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                {loadingAction?'⏳':'Valider'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale retour */}
      {retourModal && (
        <div onClick={()=>{setRetourModal(null);setRetourCommentaire('')}}
          style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:16}}>
          <div onClick={(e:any)=>e.stopPropagation()} style={{background:card,borderRadius:12,padding:'18px 22px',maxWidth:500,width:'100%',border:`2px solid ${C.yellow}`}}>
            <div style={{fontSize:16,fontWeight:900,color:C.yellow,marginBottom:8}}>↩ Retourner au demandeur</div>
            <div style={{fontSize:13,color:sub,marginBottom:12}}>
              Pièce <strong style={{fontFamily:'monospace'}}>{retourModal.code_piece}</strong> — demandeur : <strong>{retourModal.demandeur}</strong>
            </div>
            <textarea value={retourCommentaire} onChange={e=>setRetourCommentaire(e.target.value)}
              placeholder="Raison du retour (obligatoire) — ex: « Recompte demandé, vérifie LOC-B »"
              style={{...S,width:'100%',minHeight:90,fontSize:12,padding:8,resize:'vertical'}}/>
            <div style={{display:'flex',gap:8,marginTop:12,justifyContent:'flex-end'}}>
              <button onClick={()=>{setRetourModal(null);setRetourCommentaire('')}}
                style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                Annuler
              </button>
              <button disabled={loadingAction!==null} onClick={envoyerRetour}
                style={{background:C.yellow,color:'#fff',border:'none',borderRadius:8,padding:'8px 16px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                {loadingAction?'⏳':'Renvoyer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ComptabiliteTab({dark, card, bdr, sub, thBg, S, C, hvr, profil, negsVerifies, validationsCompta, setValidationsCompta, verifsDoubles, setVerifsDoubles}: any) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const userEmail = profil?.email || profil?.nom || 'Inconnu'
  const [comptages, setComptages] = useState<any[]>([])
  const [vue, setVue] = useState<'a_valider'|'historique'>('a_valider')
  const [filtType, setFiltType] = useState<'tous'|'negatif'|'comptage'|'photo'|'vrai_ecart'|'sys_rattrape'>('tous')
  const [tri, setTri] = useState<'date_desc'|'ecart_desc'|'code_asc'>('date_desc')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loadingAction, setLoadingAction] = useState<string|null>(null)
  const [filtSourceHist, setFiltSourceHist] = useState<'tous'|'negatif'|'comptage'>('tous')
  // Retour au demandeur (avec commentaire obligatoire)
  const [retourModal, setRetourModal] = useState<{ source: 'negatif'|'comptage'; ref_id: number; ids?: number[]; code_piece: string; demandeur: string } | null>(null)
  const [retourCommentaire, setRetourCommentaire] = useState('')
  const [retoursActifs, setRetoursActifs] = useState<any[]>([])
  const [retoursTous, setRetoursTous] = useState<any[]>([])
  // Map<code_piece, Set<localisation_upper>> — sources « connues » via inventaire_localisations.
  // Sert à détecter les pièces multi-localisation et savoir si toutes les locs ont été comptées
  // avant d'envoyer la pièce en Comptabilité.
  const [locsParCode, setLocsParCode] = useState<Map<string, Set<string>>>(new Map())
  // Description par code_piece (depuis inventaire_localisations ou memoire_negatifs)
  const [descParCode, setDescParCode] = useState<Map<string, string>>(new Map())

  async function recharger() {
    try {
      const [c, v, r, rT, vd] = await Promise.all([
        fetch('/api/inventaire/comptages').then(r=>r.json()),
        fetch('/api/validations-comptables').then(r=>r.json()),
        fetch('/api/comptabilite/retours?actifs=1').then(r=>r.json()),
        fetch('/api/comptabilite/retours').then(r=>r.json()),
        fetch('/api/verifications-doubles').then(r=>r.json()).catch(()=>[]),
      ])
      if (Array.isArray(c)) setComptages(c)
      if (Array.isArray(v)) setValidationsCompta(v)
      if (Array.isArray(r)) setRetoursActifs(r)
      if (Array.isArray(rT)) setRetoursTous(rT)
      if (Array.isArray(vd) && setVerifsDoubles) setVerifsDoubles(vd)

      // Charger les localisations connues pour les codes en jeu (reconcilie ou récents)
      if (Array.isArray(c)) {
        const codesUniques = Array.from(new Set(c
          .filter((x:any) => x.statut === 'reconcilie' || x.statut === 'en_attente')
          .map((x:any) => x.code_piece)
          .filter(Boolean)))
        if (codesUniques.length > 0) {
          const rLoc = await fetch('/api/inventaire/localisations?codes=' + encodeURIComponent(codesUniques.join('|')))
          const rows = await rLoc.json()
          if (Array.isArray(rows)) {
            const map = new Map<string, Set<string>>()
            const desc = new Map<string, string>()
            for (const row of rows) {
              if (!row.code_piece || row.code_piece.startsWith('LOC_')) continue
              const set = map.get(row.code_piece) || new Set<string>()
              for (const l of [row.localisation1, row.localisation2, row.localisation3, row.localisation4]) {
                if (l) set.add(String(l).toUpperCase())
              }
              map.set(row.code_piece, set)
              if (row.description && !desc.has(row.code_piece)) {
                desc.set(row.code_piece, String(row.description))
              }
            }
            setLocsParCode(map)
            // Compléter avec les descriptions des pièces négatives (qui ne sont
            // peut-être pas dans inventaire_localisations)
            for (const n of (negsVerifies || [])) {
              if (n.code_piece && n.description && !desc.has(n.code_piece)) {
                desc.set(n.code_piece, String(n.description))
              }
            }
            setDescParCode(desc)
          }
        } else {
          setLocsParCode(new Map())
          setDescParCode(new Map())
        }
      }
    } catch {}
  }

  // Pour un comptage (ou négatif) donné, retourne l'historique des retours
  // comptables associés (actuel OU passés) — par ref_id ou par code_piece.
  function historiqueRetoursPour(source: 'comptage'|'negatif', refId: number, codePiece: string): any[] {
    return retoursTous
      .filter((r:any) => r.source === source && (r.ref_id === refId || r.code_piece === codePiece))
      .sort((a:any, b:any) => new Date(b.retourne_le).getTime() - new Date(a.retourne_le).getTime())
  }

  // Set des items déjà retournés (pour ne pas les afficher dans la liste à valider)
  const retournesKey = new Set(retoursActifs.map((r:any) => `${r.source}:${r.ref_id}`))
  const estRetourne = (source:string, refId:any) => retournesKey.has(`${source}:${refId}`)

  async function envoyerRetour() {
    if (!retourModal) return
    const commentaire = retourCommentaire.trim()
    if (!commentaire) { alert('Le commentaire est obligatoire pour expliquer la raison du retour.'); return }
    setLoadingAction(`retour:${retourModal.source}:${retourModal.ref_id}`)
    try {
      // Pour un item multi-loc (plusieurs ids agrégés), créer un retour pour chaque
      // comptage sous-jacent afin que tous disparaissent de la liste « À valider ».
      const ids = (retourModal.ids && retourModal.ids.length > 0) ? retourModal.ids : [retourModal.ref_id]
      let lastErr: string | null = null
      for (const id of ids) {
        const r = await fetch('/api/comptabilite/retours', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            source: retourModal.source,
            ref_id: id,
            code_piece: retourModal.code_piece,
            demandeur_employe: retourModal.demandeur,
            comptable_email: userEmail,
            commentaire_retour: commentaire,
          })
        })
        const j = await r.json()
        if (j.erreur) lastErr = j.erreur
      }
      if (lastErr) { alert(lastErr); return }
      setRetourModal(null)
      setRetourCommentaire('')
      await recharger()
    } finally { setLoadingAction(null) }
  }

  useEffect(() => { recharger() }, [])

  const validations = validationsCompta || []
  const validesKey = new Set(validations.map((v:any) => `${v.source}:${v.ref_id}`))
  const estValide = (source:string, refId:any) => validesKey.has(`${source}:${refId}`)

  // Double-vérification admin : tout item avec |écart| > 3 doit être validé par
  // un admin avant d'apparaître en Comptabilité.
  const SEUIL_DOUBLE_VERIF = 3
  const verifsKey = new Map<string, any>()
  for (const v of (verifsDoubles || [])) verifsKey.set(`${v.source}:${v.ref_id}`, v)
  const verifPour = (source:string, ids:number[]): any | null => {
    for (const id of ids) {
      const v = verifsKey.get(`${source}:${id}`)
      if (v) return v
    }
    return null
  }

  type Item = {
    key: string; source: 'negatif'|'comptage'; id: number; code_piece: string;
    date: string; ecart: number; valeur: number; employe: string;
    hasPhoto: boolean; hasComment: boolean; hasAlt: boolean; raw: any;
    verif?: { valide_par: string, valide_le: string, commentaire: string|null } | null;
  }
  const items: Item[] = []
  // Causes à exclure de la Comptabilité (corrections internes, pas d'écriture comptable)
  const CAUSES_HORS_COMPTA = [
    'Pièce non réceptionnée mais facturée (logiciel/service)',
    'Réservation (pièce mal importée dans facture)',
    'Double facturation',
  ]
  for (const n of (negsVerifies||[])) {
    if (estValide('negatif', n.id)) continue
    if (estRetourne('negatif', n.id)) continue   // déjà retourné au demandeur
    if (n.cause && CAUSES_HORS_COMPTA.includes(n.cause)) continue
    const ecartN = Number(n.ajustement || 0)
    const verifN = verifPour('negatif', [n.id])
    // |écart| > 3 → masque tant que la double-vérif n'est pas faite
    if (Math.abs(ecartN) > SEUIL_DOUBLE_VERIF && !verifN) continue
    items.push({
      key: `negatif:${n.id}`, source: 'negatif', id: n.id, code_piece: n.code_piece,
      date: n.date_verification, ecart: ecartN,
      valeur: Number(n.valeur_au_moment||0), employe: n.employe||'',
      hasPhoto: !!(n.photo_url || n.photo_url2),
      hasComment: !!n.commentaire,
      hasAlt: !!n.alt_code_piece,
      raw: n,
      verif: verifN || null,
    })
  }
  // Construire la map des localisations COMPTÉES par code (depuis les comptages
  // récents, statut reconcilie ou en_attente). Sert à savoir si une pièce
  // multi-loc a été totalement comptée avant de l'envoyer en Comptabilité.
  const compteesParCode = new Map<string, Set<string>>()
  for (const c of (comptages || [])) {
    if (c.statut === 'obsolete' || c.statut === 'resolu') continue
    const set = compteesParCode.get(c.code_piece) || new Set<string>()
    set.add(String(c.localisation || '').toUpperCase())
    compteesParCode.set(c.code_piece, set)
  }
  // Pour les pièces multi-loc déjà traitées (= un seul item agrégé), éviter
  // d'ajouter une ligne par comptage individuel.
  const codesMultiTraites = new Set<string>()
  for (const c of (comptages||[])) {
    if (c.statut !== 'reconcilie') continue

    const locsConnues = locsParCode.get(c.code_piece) || new Set<string>()
    const estMultiLoc = locsConnues.size > 1

    if (estMultiLoc) {
      // Une seule ligne agrégée par pièce — skip si déjà traitée
      if (codesMultiTraites.has(c.code_piece)) continue
      codesMultiTraites.add(c.code_piece)

      // Toutes les localisations doivent avoir été comptées (au moins un
      // comptage non-obsolete/non-resolu existant pour chaque loc connue).
      const compteesLoc = compteesParCode.get(c.code_piece) || new Set<string>()
      const toutesComptees = Array.from(locsConnues).every(l => compteesLoc.has(l))
      if (!toutesComptees) continue  // attendre la fin du comptage

      // Agréger tous les comptages reconcilies de cette pièce
      const reconcs = (comptages || []).filter((x:any) =>
        x.code_piece === c.code_piece && x.statut === 'reconcilie')
      const sumComptee = reconcs.reduce((s:number, x:any) => s + Number(x.qte_comptee || 0), 0)
      // SNAPSHOT au PREMIER comptage : qte_systeme du comptage le plus ancien
      // sert de référence. Toutes les ventes ultérieures sont traitées comme
      // du trafic normal — l'ajustement final = compte_sum - qte_systeme_initial.
      const oldest = [...reconcs].sort((a:any,b:any) =>
        new Date(a.date_comptage).getTime() - new Date(b.date_comptage).getTime())[0]
      const latest = [...reconcs].sort((a:any,b:any) =>
        new Date(b.date_reconciliation || b.date_comptage).getTime()
        - new Date(a.date_reconciliation || a.date_comptage).getTime())[0]
      const qteSysSnapshot = Number(oldest?.qte_systeme || 0)
      const ajust = sumComptee - qteSysSnapshot
      if (ajust === 0) continue
      // Calculer l'amplitude du cycle (jours entre premier et dernier comptage)
      const dateOldest = oldest ? new Date(oldest.date_comptage).getTime() : 0
      const dateLatest = latest ? new Date(latest.date_comptage).getTime() : 0
      const cycleJours = dateOldest && dateLatest
        ? Math.max(0, Math.round((dateLatest - dateOldest) / (1000 * 60 * 60 * 24)))
        : 0

      const ids = reconcs.map((x:any) => x.id)
      if (ids.some((id:number) => estValide('comptage', id))) continue
      if (ids.some((id:number) => estRetourne('comptage', id))) continue

      const verifMulti = verifPour('comptage', ids)
      if (Math.abs(ajust) > SEUIL_DOUBLE_VERIF && !verifMulti) continue

      items.push({
        key: `comptage:multi:${c.code_piece}`, source: 'comptage', id: latest?.id || c.id, code_piece: c.code_piece,
        date: latest?.date_reconciliation || latest?.date_comptage || c.date_comptage, ecart: ajust,
        valeur: 0, employe: Array.from(new Set(reconcs.map((x:any) => x.employe).filter(Boolean))).join(', '),
        hasPhoto: reconcs.some((x:any) => x.photo_url),
        hasComment: reconcs.some((x:any) => x.note),
        hasAlt: false,
        verif: verifMulti || null,
        raw: {
          ...latest,
          qte_comptee: sumComptee,
          qte_systeme: qteSysSnapshot,
          multi_loc: true,
          nb_locs: locsConnues.size,
          locs_connues: Array.from(locsConnues),
          cycle_jours: cycleJours,
          date_premier_comptage: oldest?.date_comptage,
          date_dernier_comptage: latest?.date_comptage,
          comptages_par_loc: reconcs.map((x:any) => ({
            id: x.id, localisation: x.localisation, qte_comptee: x.qte_comptee,
            employe: x.employe, date_comptage: x.date_comptage, note: x.note, photo_url: x.photo_url
          })),
          ids_agreges: ids,
        },
      })
      continue
    }

    // Single-loc — comportement classique
    // L'écart affiché dans la liste = AJUSTEMENT à appliquer maintenant
    // = qte_comptee - stock_apres_sync (= stock J+1).
    let ajust: number
    if (c.stock_apres_sync !== null && c.stock_apres_sync !== undefined) {
      ajust = Number(c.qte_comptee || 0) - Number(c.stock_apres_sync)
    } else {
      ajust = Number(c.ecart_reconcilie || 0)
    }
    if (ajust === 0) continue
    if (estValide('comptage', c.id)) continue
    if (estRetourne('comptage', c.id)) continue
    const verifSingle = verifPour('comptage', [c.id])
    if (Math.abs(ajust) > SEUIL_DOUBLE_VERIF && !verifSingle) continue
    items.push({
      key: `comptage:${c.id}`, source: 'comptage', id: c.id, code_piece: c.code_piece,
      date: c.date_reconciliation || c.date_comptage, ecart: ajust,
      valeur: 0, employe: c.employe||'',
      hasPhoto: !!c.photo_url,
      hasComment: !!c.note,
      hasAlt: false,
      raw: c,
      verif: verifSingle || null,
    })
  }

  // Référence système pour le calcul de catégorie :
  // - multi-loc  → snapshot du PREMIER comptage (raw.qte_systeme)
  // - single-loc → stock J+1 (raw.stock_apres_sync = état actuel après ventes intermédiaires)
  function refSysteme(c: any): number | null {
    if (c.multi_loc) {
      const v = c.qte_systeme
      return (v === null || v === undefined) ? null : Number(v)
    }
    const v = c.stock_apres_sync
    return (v === null || v === undefined) ? null : Number(v)
  }

  const searchLower = search.trim().toLowerCase()
  const itemsFiltered = items.filter(it => {
    if (filtType === 'negatif' && it.source !== 'negatif') return false
    if (filtType === 'comptage' && it.source !== 'comptage') return false
    if (filtType === 'photo' && !it.hasPhoto) return false
    if (filtType === 'vrai_ecart' || filtType === 'sys_rattrape') {
      if (it.source !== 'comptage') return false
      const sysAct = refSysteme(it.raw)
      const compt = Number(it.raw.qte_comptee || 0)
      if (sysAct === null) return false
      if (filtType === 'vrai_ecart' && sysAct >= compt) return false
      if (filtType === 'sys_rattrape' && sysAct <= compt) return false
    }
    if (searchLower && !it.code_piece.toLowerCase().includes(searchLower)) return false
    return true
  })

  // Catégorise un comptage selon l'écart entre système et physique.
  // Sert d'indicateur visuel dans la liste « À valider ».
  const categorieComptage = (it: any): { label: string, emoji: string, color: string } | null => {
    if (it.source !== 'comptage') return null
    const c = it.raw
    const sysAct = refSysteme(c)
    const compt = Number(c.qte_comptee || 0)
    if (sysAct === null) return { label:'À vérifier', emoji:'❓', color:sub }
    if (sysAct === compt) return { label:'Résolu', emoji:'🟢', color:C.green }
    if (sysAct > compt)   return { label:'Système rattrapé', emoji:'🟡', color:C.yellow }
    return { label:'Vrai écart', emoji:'🔴', color:C.red }
  }

  const itemsSorted = [...itemsFiltered].sort((a,b) => {
    if (tri === 'date_desc') return new Date(b.date).getTime() - new Date(a.date).getTime()
    if (tri === 'ecart_desc') return Math.abs(b.ecart) - Math.abs(a.ecart)
    return a.code_piece.localeCompare(b.code_piece)
  })

  const totalValeur = itemsFiltered.reduce((s,it) => s + Math.abs(it.valeur), 0)
  const nbNegatifs = items.filter(i=>i.source==='negatif').length
  const nbComptages = items.filter(i=>i.source==='comptage').length
  // Pièces multi-loc en attente (au moins une loc non comptée) — pour
  // signaler que des comptages sont en cours et n'apparaissent pas encore ici.
  const codesEnAttenteMultiLoc = new Set<string>()
  for (const c of (comptages||[])) {
    if (c.statut !== 'reconcilie') continue
    const locsConnues = locsParCode.get(c.code_piece) || new Set<string>()
    if (locsConnues.size <= 1) continue
    const comptees = compteesParCode.get(c.code_piece) || new Set<string>()
    const toutesComptees = Array.from(locsConnues).every(l => comptees.has(l))
    if (!toutesComptees) codesEnAttenteMultiLoc.add(c.code_piece)
  }
  const nbAttenteMultiLoc = codesEnAttenteMultiLoc.size
  const nbPhoto = items.filter(i=>i.hasPhoto).length
  const nbVraiEcart = items.filter(i => {
    if (i.source !== 'comptage') return false
    const s = refSysteme(i.raw)
    return s !== null && s < Number(i.raw.qte_comptee || 0)
  }).length
  const nbSysRattrape = items.filter(i => {
    if (i.source !== 'comptage') return false
    const s = refSysteme(i.raw)
    return s !== null && s > Number(i.raw.qte_comptee || 0)
  }).length

  function toggleExpand(k: string) {
    setExpanded(prev => {
      const s = new Set(prev)
      if (s.has(k)) s.delete(k); else s.add(k)
      return s
    })
  }
  function toggleSelect(k: string, e?: any) {
    if (e) e.stopPropagation()
    setSelected(prev => {
      const s = new Set(prev)
      if (s.has(k)) s.delete(k); else s.add(k)
      return s
    })
  }
  function toggleSelectAll() {
    if (selected.size === itemsSorted.length) setSelected(new Set())
    else setSelected(new Set(itemsSorted.map(i=>i.key)))
  }

  // Pour un item multi-loc, on doit valider/retourner CHAQUE comptage sous-jacent.
  function idsACibler(it: Item): number[] {
    const ids = (it.raw as any)?.ids_agreges
    return Array.isArray(ids) && ids.length > 0 ? ids : [it.id]
  }

  async function valider(it: Item) {
    setLoadingAction(it.key)
    try {
      const ids = idsACibler(it)
      await Promise.all(ids.map(id => fetch('/api/validations-comptables', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ source: it.source, ref_id: id, code_piece: it.code_piece, snapshot: it.raw, user_email: userEmail })
      })))
      setSelected(prev => { const s = new Set(prev); s.delete(it.key); return s })
      await recharger()
    } finally { setLoadingAction(null) }
  }

  async function validerLot() {
    if (selected.size === 0) return
    if (!confirm(`Valider comptablement ${selected.size} élément(s) ?`)) return
    setLoadingAction('lot')
    try {
      const toValidate = itemsSorted.filter(i => selected.has(i.key))
      const calls: Promise<any>[] = []
      for (const it of toValidate) {
        for (const id of idsACibler(it)) {
          calls.push(fetch('/api/validations-comptables', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ source: it.source, ref_id: id, code_piece: it.code_piece, snapshot: it.raw, user_email: userEmail })
          }))
        }
      }
      await Promise.all(calls)
      setSelected(new Set())
      await recharger()
    } finally { setLoadingAction(null) }
  }

  async function annuler(id:number) {
    if (!confirm("Annuler cette validation ? La pièce réapparaîtra dans son onglet d'origine.")) return
    setLoadingAction(`undo:${id}`)
    try {
      await fetch('/api/validations-comptables', {
        method: 'DELETE',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ id })
      })
      await recharger()
    } finally { setLoadingAction(null) }
  }

  const fmtDate = (d:string) => d ? new Date(d).toLocaleDateString('fr-CA',{year:'2-digit',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'
  const fmtDateLong = (d:string) => d ? new Date(d).toLocaleDateString('fr-CA',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'

  const labelSource = (s:string) => s === 'negatif' ? '🔴 Négatif' : '📦 Comptage'
  const colorSource = (s:string) => s === 'negatif' ? C.red : C.blue

  const historique = [...validations].sort((a:any,b:any) => new Date(b.date_validation).getTime() - new Date(a.date_validation).getTime())
  const historiqueFiltre = filtSourceHist === 'tous' ? historique : historique.filter((v:any) => v.source === filtSourceHist)

  function NegDetails({n, verif}: any) {
    const histo = historiqueRetoursPour('negatif', n.id, n.code_piece)
    return (
      <div style={{background:dark?'#0f0f0f':'#fafbfc',padding:'14px 16px',borderTop:`1px solid ${bdr}`}}>
        <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:12}}>
          <div style={{background:card,borderRadius:8,padding:'10px 12px',border:`1px solid ${bdr}`}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:6}}>Stocks au moment</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,textAlign:'center'}}>
              <div><div style={{fontSize:9,color:sub}}>Système</div><div style={{fontSize:16,fontWeight:900,color:C.red}}>{n.stock_au_moment}</div></div>
              <div><div style={{fontSize:9,color:sub}}>Tablette</div><div style={{fontSize:16,fontWeight:900,color:C.blue}}>{n.qte_reelle??'—'}</div></div>
              <div><div style={{fontSize:9,color:sub}}>Valeur</div><div style={{fontSize:13,fontWeight:700,color:C.red}}>−{Number(n.valeur_au_moment||0).toFixed(0)}$</div></div>
            </div>
          </div>
          <div style={{background:card,borderRadius:8,padding:'10px 12px',border:`1px solid ${bdr}`}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:6}}>Transactions</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'2px 10px',fontSize:11}}>
              {[
                {l:'Serv. détail',v2:n.serv_detail},
                {l:'Serv. interne',v2:n.serv_interne},
                {l:'Serv. gar.',v2:n.serv_gar},
                {l:'Pce détail',v2:n.pce_detail},
                {l:'Récept.',v2:n.recept_comm},
                {l:'Déc. phys.',v2:n.dec_physique},
                {l:'Autre',v2:n.autre},
              ].map(t=>(
                <div key={t.l} style={{display:'flex',justifyContent:'space-between'}}>
                  <span style={{color:sub}}>{t.l}</span>
                  <span style={{fontWeight:700,color:Number(t.v2)===0?sub:Number(t.v2)<0?C.red:C.green}}>{Number(t.v2??0)>0?'+':''}{Number(t.v2??0).toFixed(0)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {verif && (
          <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`1px solid ${C.green}`,borderRadius:8,padding:'10px 12px',marginTop:10}}>
            <div style={{fontSize:11,fontWeight:800,color:C.green,textTransform:'uppercase',marginBottom:4}}>✅ Double-vérification validée</div>
            <div style={{fontSize:12,color:dark?'#ccc':'#333'}}>
              Par <strong>{verif.valide_par}</strong> le <strong>{fmtDate(verif.valide_le)}</strong>
            </div>
            {verif.commentaire && <div style={{fontSize:11,color:sub,marginTop:4,fontStyle:'italic'}}>💬 {verif.commentaire}</div>}
          </div>
        )}
        {n.cause && <div style={{background:dark?'#1a233a':'#e8f0fe',borderRadius:6,padding:'8px 12px',fontSize:12,color:C.blue,marginTop:10,fontWeight:600,whiteSpace:'pre-wrap'}}>📋 {n.cause}</div>}
        {n.commentaire && <div style={{background:dark?'#1a1a1a':'#f1f3f5',borderRadius:6,padding:'8px 12px',fontSize:12,color:sub,marginTop:8,whiteSpace:'pre-wrap'}}>💬 {n.commentaire}</div>}

        {(n.photo_url || n.photo_url2) && (
          <div style={{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}}>
            {n.photo_url && <a href={n.photo_url} target="_blank" rel="noreferrer"><img src={n.photo_url} alt="" onError={(e:any)=>e.target.style.display='none'} style={{width:120,height:80,objectFit:'cover',borderRadius:6,border:`2px solid ${C.green}`}}/></a>}
            {n.photo_url2 && <a href={n.photo_url2} target="_blank" rel="noreferrer"><img src={n.photo_url2} alt="" onError={(e:any)=>e.target.style.display='none'} style={{width:120,height:80,objectFit:'cover',borderRadius:6,border:`2px solid ${C.green}`}}/></a>}
          </div>
        )}

        {n.alt_code_piece && (
          <div style={{background:dark?'#0d2a18':'#e6f4ea',borderRadius:8,padding:'10px 12px',marginTop:10,border:`1px solid ${C.green}33`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <span style={{fontSize:12,fontWeight:700,color:C.green}}>🔄 Alt — {n.alt_code_piece}</span>
              <span style={{fontSize:16,fontWeight:900,color:Number(n.alt_ajustement)===0?C.green:C.red}}>{Number(n.alt_ajustement)>=0?'+':''}{Number(n.alt_ajustement??0).toFixed(0)}</span>
            </div>
          </div>
        )}

        {/* Historique des retours comptables sur cette pièce */}
        {histo.length > 0 && (
          <div style={{background:dark?'#2b1f0e':'#fff8e1',border:`1px solid ${C.yellow}`,borderRadius:6,padding:'10px 12px',marginTop:10}}>
            <div style={{fontSize:11,fontWeight:800,color:'#b06a00',textTransform:'uppercase',marginBottom:6}}>
              📋 Historique des retours comptables ({histo.length})
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {histo.map((r:any) => (
                <div key={r.id} style={{background:card,borderRadius:5,padding:'8px 10px',border:`1px dashed ${C.yellow}66`}}>
                  <div style={{display:'flex',justifyContent:'space-between',gap:8,flexWrap:'wrap',fontSize:10,color:sub,marginBottom:4}}>
                    <span>↩ Retourné le <strong>{fmtDate(r.retourne_le)}</strong> par {r.comptable_email}</span>
                    {r.corrige_le ? (
                      <span style={{color:C.green,fontWeight:700}}>✓ Corrigé le {fmtDate(r.corrige_le)} par {r.corrige_par}</span>
                    ) : (
                      <span style={{color:C.red,fontWeight:700}}>● ACTIF</span>
                    )}
                  </div>
                  <div style={{fontSize:12,whiteSpace:'pre-wrap',color:dark?'#e8e8e8':'#1a1a1a'}}>
                    <strong style={{color:'#b06a00'}}>Commentaire compta : </strong>{r.commentaire_retour}
                  </div>
                  {r.commentaire_correction && (
                    <div style={{fontSize:11,whiteSpace:'pre-wrap',color:dark?'#bbb':'#555',marginTop:4,borderTop:`1px dotted ${bdr}`,paddingTop:4}}>
                      <strong style={{color:C.green}}>Correction : </strong>{r.commentaire_correction}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  function ComptDetails({c, verif}: any) {
    const histo = historiqueRetoursPour('comptage', c.id, c.code_piece)
    return (
      <div style={{background:dark?'#0f0f0f':'#fafbfc',padding:'14px 16px',borderTop:`1px solid ${bdr}`}}>
        <div style={{background:card,borderRadius:8,padding:'10px 12px',border:`1px solid ${bdr}`,marginBottom:10}}>
          <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:6,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span>Quantités</span>
            {c.multi_loc && (
              <span style={{background:C.blue+'22',color:C.blue,fontWeight:800,padding:'2px 8px',borderRadius:10,fontSize:10}}>
                📍 Multi-loc ({c.nb_locs} localisations agrégées)
              </span>
            )}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,textAlign:'center'}}>
            <div>
              <div style={{fontSize:9,color:sub}} title={c.multi_loc?'Snapshot du système au premier comptage':'Système au moment du comptage'}>
                {c.multi_loc?'Système (snap)':'Système'}
              </div>
              <div style={{fontSize:16,fontWeight:900,color:C.blue}}>{c.qte_systeme}</div>
            </div>
            <div><div style={{fontSize:9,color:sub}}>{c.multi_loc?'Compté (Σ)':'Compté'}</div><div style={{fontSize:16,fontWeight:900,color:C.green}}>{c.qte_comptee}</div></div>
            <div><div style={{fontSize:9,color:sub}}>Stock J+1</div><div style={{fontSize:16,fontWeight:900,color:C.blue}}>{c.stock_apres_sync??'—'}</div></div>
            <div><div style={{fontSize:9,color:sub}}>Loc</div><div style={{fontSize:13,fontWeight:700,fontFamily:'monospace',color:C.blue}}>{c.multi_loc?(c.locs_connues||[]).join(', '):c.localisation}</div></div>
          </div>
          {!c.multi_loc && c.ecart !== c.ecart_reconcilie && (
            <div style={{fontSize:11,color:sub,marginTop:8,textAlign:'center'}}>
              Ventes entre-temps : <strong style={{color:C.blue}}>{c.qte_systeme - c.stock_apres_sync}</strong> unité(s)
            </div>
          )}
          {c.multi_loc && (
            <div style={{fontSize:11,marginTop:8,textAlign:'center',color:c.cycle_jours>1?C.yellow:sub}}>
              {c.cycle_jours > 1 ? '⚠️ ' : ''}Cycle de comptage : <strong>{c.cycle_jours} jour{c.cycle_jours>1?'s':''}</strong>
              {c.cycle_jours > 1 && ' — les ventes intermédiaires peuvent fausser la précision'}
              {c.qte_systeme !== c.stock_apres_sync && c.stock_apres_sync !== null && c.stock_apres_sync !== undefined && (
                <span> · ventes entre temps : <strong style={{color:C.blue}}>{c.qte_systeme - c.stock_apres_sync}</strong> u.</span>
              )}
            </div>
          )}
        </div>
        {c.multi_loc && Array.isArray(c.comptages_par_loc) && c.comptages_par_loc.length > 0 && (
          <div style={{background:card,borderRadius:8,padding:'10px 12px',border:`1px solid ${bdr}`,marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:8}}>Détail par localisation</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {c.comptages_par_loc.map((p:any) => (
                <div key={p.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:12,borderBottom:`1px dotted ${bdr}`,paddingBottom:4}}>
                  <span style={{fontFamily:'monospace',fontWeight:700,color:C.blue}}>{p.localisation}</span>
                  <span style={{color:sub}}>👤 {p.employe || '—'}</span>
                  <span style={{fontWeight:900,color:C.green}}>{Number(p.qte_comptee||0)} unité(s)</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {verif && (
          <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`1px solid ${C.green}`,borderRadius:8,padding:'10px 12px',marginBottom:10}}>
            <div style={{fontSize:11,fontWeight:800,color:C.green,textTransform:'uppercase',marginBottom:4}}>✅ Double-vérification validée</div>
            <div style={{fontSize:12,color:dark?'#ccc':'#333'}}>
              Par <strong>{verif.valide_par}</strong> le <strong>{fmtDate(verif.valide_le)}</strong>
            </div>
            {verif.commentaire && <div style={{fontSize:11,color:sub,marginTop:4,fontStyle:'italic'}}>💬 {verif.commentaire}</div>}
          </div>
        )}
        {c.note && <div style={{background:dark?'#1a1a1a':'#f1f3f5',borderRadius:6,padding:'8px 12px',fontSize:12,color:sub,marginBottom:10,whiteSpace:'pre-wrap'}}>💬 {c.note}</div>}
        {c.photo_url && (
          <a href={c.photo_url} target="_blank" rel="noreferrer" style={{display:'inline-block',marginBottom:10}}>
            <img src={c.photo_url} alt="" onError={(e:any)=>e.target.style.display='none'} style={{width:160,height:110,objectFit:'cover',borderRadius:6,border:`2px solid ${C.green}`}}/>
          </a>
        )}
        {/* Historique des retours comptables sur cette pièce */}
        {histo.length > 0 && (
          <div style={{background:dark?'#2b1f0e':'#fff8e1',border:`1px solid ${C.yellow}`,borderRadius:6,padding:'10px 12px',marginTop:10}}>
            <div style={{fontSize:11,fontWeight:800,color:'#b06a00',textTransform:'uppercase',marginBottom:6}}>
              📋 Historique des retours comptables ({histo.length})
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {histo.map((r:any) => (
                <div key={r.id} style={{background:card,borderRadius:5,padding:'8px 10px',border:`1px dashed ${C.yellow}66`}}>
                  <div style={{display:'flex',justifyContent:'space-between',gap:8,flexWrap:'wrap',fontSize:10,color:sub,marginBottom:4}}>
                    <span>↩ Retourné le <strong>{fmtDate(r.retourne_le)}</strong> par {r.comptable_email}</span>
                    {r.corrige_le ? (
                      <span style={{color:C.green,fontWeight:700}}>✓ Corrigé le {fmtDate(r.corrige_le)} par {r.corrige_par}</span>
                    ) : (
                      <span style={{color:C.red,fontWeight:700}}>● ACTIF</span>
                    )}
                  </div>
                  <div style={{fontSize:12,whiteSpace:'pre-wrap',color:dark?'#e8e8e8':'#1a1a1a'}}>
                    <strong style={{color:'#b06a00'}}>Commentaire compta : </strong>{r.commentaire_retour}
                  </div>
                  {r.commentaire_correction && (
                    <div style={{fontSize:11,whiteSpace:'pre-wrap',color:dark?'#bbb':'#555',marginTop:4,borderTop:`1px dotted ${bdr}`,paddingTop:4}}>
                      <strong style={{color:C.green}}>Correction : </strong>{r.commentaire_correction}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{fontSize:11,color:sub,marginTop:8}}>Réconcilié le {fmtDateLong(c.date_reconciliation)}</div>
      </div>
    )
  }

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:10,marginBottom:12}}>
        <div>
          <div style={{fontSize:20,fontWeight:900}}>💰 Comptabilité</div>
          <div style={{fontSize:11,color:sub,marginTop:2}}>Validation comptable et historique</div>
        </div>
        <button onClick={recharger} style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'7px 12px',fontWeight:700,cursor:'pointer',fontSize:12}}>🔄 Actualiser</button>
      </div>

      <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
        <button onClick={()=>setVue('a_valider')}
          style={{padding:'8px 14px',borderRadius:18,border:`2px solid ${vue==='a_valider'?C.blue:bdr}`,background:vue==='a_valider'?(dark?'#1a233a':'#e8f0fe'):'transparent',color:vue==='a_valider'?C.blue:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
          📥 À valider ({items.length})
        </button>
        <button onClick={()=>setVue('historique')}
          style={{padding:'8px 14px',borderRadius:18,border:`2px solid ${vue==='historique'?C.green:bdr}`,background:vue==='historique'?(dark?'#0d2a18':'#e6f4ea'):'transparent',color:vue==='historique'?C.green:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
          📚 Historique ({historique.length})
        </button>
      </div>

      {vue === 'a_valider' && (
        <div>
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:10,display:'flex',gap:18,flexWrap:'wrap',alignItems:'center',fontSize:12}}>
            <div><span style={{color:sub}}>Total : </span><strong style={{fontSize:15,color:dark?'#fff':'#1a1a1a'}}>{items.length}</strong></div>
            <div style={{color:sub}}>•</div>
            <div><span style={{color:C.red}}>🔴 {nbNegatifs}</span></div>
            <div><span style={{color:C.blue}}>📦 {nbComptages}</span></div>
            <div><span style={{color:sub}}>📸 {nbPhoto}</span></div>
            <div style={{color:sub}}>•</div>
            <div><span style={{color:sub}}>Valeur en jeu : </span><strong style={{color:C.red}}>{totalValeur.toFixed(0)}$</strong></div>
            {nbAttenteMultiLoc > 0 && (
              <>
                <div style={{color:sub}}>•</div>
                <div title="Pièces présentes dans plusieurs localisations dont au moins une n'a pas encore été comptée. Elles n'apparaissent pas tant que le cycle de comptage n'est pas complet.">
                  <span style={{color:C.yellow}}>📍 En attente multi-loc : </span>
                  <strong style={{color:C.yellow}}>{nbAttenteMultiLoc}</strong>
                </div>
              </>
            )}
          </div>

          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:10,display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Code pièce..."
              style={{...S,maxWidth:180,fontSize:12,padding:'7px 10px'}}/>
            <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
              {[
                {id:'tous', label:`Tous (${items.length})`, color:sub},
                {id:'negatif', label:`🔴 Nég (${nbNegatifs})`, color:C.red},
                {id:'comptage', label:`📦 Cpt (${nbComptages})`, color:C.blue},
                {id:'vrai_ecart', label:`🔴 Sys trop bas (${nbVraiEcart})`, color:C.red},
                {id:'sys_rattrape', label:`🟡 Sys trop haut (${nbSysRattrape})`, color:C.yellow},
                {id:'photo', label:`📸 Photo (${nbPhoto})`, color:C.green},
              ].map(f => (
                <button key={f.id} onClick={()=>setFiltType(f.id as any)}
                  style={{padding:'6px 11px',borderRadius:14,border:`1px solid ${filtType===f.id?f.color:bdr}`,background:filtType===f.id?f.color+'22':'transparent',color:filtType===f.id?f.color:sub,fontWeight:700,cursor:'pointer',fontSize:11}}>
                  {f.label}
                </button>
              ))}
            </div>
            <div style={{marginLeft:'auto',display:'flex',gap:6,alignItems:'center'}}>
              <span style={{fontSize:11,color:sub}}>Tri :</span>
              <select value={tri} onChange={e=>setTri(e.target.value as any)} style={{...S,fontSize:11,padding:'5px 8px',width:'auto'}}>
                <option value="date_desc">Date ↓</option>
                <option value="ecart_desc">Écart ↓</option>
                <option value="code_asc">Code A→Z</option>
              </select>
            </div>
          </div>

          {selected.size > 0 && (
            <div style={{background:C.green+'15',border:`2px solid ${C.green}`,borderRadius:10,padding:'10px 14px',marginBottom:10,display:'flex',gap:10,alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,zIndex:5}}>
              <div style={{fontSize:13,fontWeight:700,color:C.green}}>✓ {selected.size} élément(s) sélectionné(s)</div>
              <div style={{display:'flex',gap:8}}>
                <button onClick={()=>setSelected(new Set())}
                  style={{background:'transparent',border:`1px solid ${bdr}`,borderRadius:6,padding:'7px 12px',fontWeight:700,cursor:'pointer',fontSize:12,color:sub}}>
                  Annuler
                </button>
                <button disabled={loadingAction==='lot'} onClick={validerLot}
                  style={{background:C.green,color:'#fff',border:'none',borderRadius:6,padding:'7px 14px',fontWeight:700,cursor:'pointer',fontSize:12,opacity:loadingAction==='lot'?0.6:1}}>
                  {loadingAction==='lot'?'⏳ Validation...':`✓ Valider ${selected.size} sélectionné(s)`}
                </button>
              </div>
            </div>
          )}

          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
            {itemsSorted.length === 0
              ? <div style={{textAlign:'center',padding:40,color:sub,fontSize:13}}>Aucun élément à valider</div>
              : <>
                  <div style={{display:'flex',gap:10,padding:'8px 12px',background:thBg,borderBottom:`1px solid ${bdr}`,fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,alignItems:'center'}}>
                    <input type="checkbox" checked={selected.size===itemsSorted.length && itemsSorted.length>0} onChange={toggleSelectAll} style={{cursor:'pointer'}}/>
                    <div style={{width:60}}>Type</div>
                    <div style={{flex:isMobile?2:1.5,minWidth:90}}>Code pièce</div>
                    <div style={{width:isMobile?60:80,textAlign:'center'}}>Écart/Ajust</div>
                    {!isMobile && <div style={{width:80,textAlign:'right'}}>Valeur</div>}
                    {!isMobile && <div style={{width:50,textAlign:'center'}}>Infos</div>}
                    {!isMobile && <div style={{width:120}}>Par</div>}
                    {!isMobile && <div style={{width:110,textAlign:'right'}}>Date</div>}
                    <div style={{width:isMobile?60:90}}></div>
                  </div>

                  {itemsSorted.map(it => {
                    const isExp = expanded.has(it.key)
                    const isSel = selected.has(it.key)
                    const ecartColor = it.ecart === 0 ? C.green : it.ecart > 0 ? C.green : C.red
                    return (
                      <div key={it.key} style={{borderBottom:`1px solid ${bdr}`}}>
                        <div onClick={()=>toggleExpand(it.key)}
                          onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr}
                          onMouseLeave={(e:any)=>e.currentTarget.style.background=isSel?(dark?'#0d2a18':'#e6f4ea'):'transparent'}
                          style={{display:'flex',gap:10,padding:'10px 12px',alignItems:'center',cursor:'pointer',background:isSel?(dark?'#0d2a18':'#e6f4ea'):'transparent',transition:'background .1s'}}>
                          <input type="checkbox" checked={isSel} onChange={(e:any)=>toggleSelect(it.key, e)} onClick={(e:any)=>e.stopPropagation()} style={{cursor:'pointer'}}/>
                          <div style={{width:60}}>
                            <span style={{background:colorSource(it.source)+'22',color:colorSource(it.source),padding:'2px 6px',borderRadius:8,fontSize:10,fontWeight:700}}>{labelSource(it.source)}</span>
                          </div>
                          <div style={{flex:isMobile?2:1.5,minWidth:90,fontWeight:700,fontFamily:'monospace',fontSize:13,overflow:'hidden'}}>
                            <span style={{display:'inline-block',width:14,color:sub,fontFamily:'sans-serif'}}>{isExp?'▼':'▶'}</span>
                            {it.code_piece}
                            {(() => {
                              const cat = categorieComptage(it)
                              if (!cat) return null
                              return (
                                <span title={cat.label}
                                  style={{marginLeft:6,fontSize:11,padding:'1px 6px',borderRadius:4,background:cat.color+'22',color:cat.color,fontWeight:700,fontFamily:'sans-serif',whiteSpace:'nowrap'}}>
                                  {cat.emoji} {cat.label}
                                </span>
                              )
                            })()}
                            {it.verif && (
                              <span title={`Double-vérification validée par ${it.verif.valide_par} le ${fmtDate(it.verif.valide_le)}`}
                                style={{marginLeft:6,fontSize:10,padding:'1px 6px',borderRadius:4,background:C.green+'22',color:C.green,fontWeight:800,fontFamily:'sans-serif',whiteSpace:'nowrap'}}>
                                ✅ Double-vérif
                              </span>
                            )}
                            {(() => {
                              const d = descParCode.get(it.code_piece)
                              if (!d) return null
                              return (
                                <div style={{fontFamily:'sans-serif',fontSize:11,fontWeight:400,color:sub,marginTop:2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}} title={d}>
                                  {d}
                                </div>
                              )
                            })()}
                          </div>
                          <div style={{width:isMobile?60:80,textAlign:'center',fontSize:16,fontWeight:900,color:ecartColor}}>
                            {it.ecart>=0?'+':''}{it.ecart.toFixed(0)}
                          </div>
                          {!isMobile && <div style={{width:80,textAlign:'right',fontSize:12,fontWeight:700,color:it.valeur>0?C.red:sub}}>
                            {it.valeur>0?`−${it.valeur.toFixed(0)}$`:'—'}
                          </div>}
                          {!isMobile && <div style={{width:50,textAlign:'center',fontSize:13}}>
                            {it.hasPhoto && <span title="Photo">📸</span>}
                            {it.hasComment && <span title="Commentaire">💬</span>}
                            {it.hasAlt && <span title="Alternative">🔄</span>}
                          </div>}
                          {!isMobile && <div style={{width:120,fontSize:11,color:sub,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>👤 {it.employe}</div>}
                          {!isMobile && <div style={{width:110,textAlign:'right',fontSize:11,color:sub,whiteSpace:'nowrap'}}>{fmtDate(it.date)}</div>}
                          <div style={{width:isMobile?80:130,textAlign:'right',display:'flex',gap:4,justifyContent:'flex-end'}}>
                            <button disabled={loadingAction===it.key}
                              onClick={(e:any)=>{e.stopPropagation();setRetourModal({source:it.source,ref_id:it.id,ids:idsACibler(it),code_piece:it.code_piece,demandeur:it.employe});setRetourCommentaire('')}}
                              title="Retourner au demandeur pour correction"
                              style={{background:'transparent',border:`1px solid ${C.yellow}`,color:C.yellow,borderRadius:6,padding:isMobile?'6px 8px':'6px 10px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                              ↩
                            </button>
                            <button disabled={loadingAction===it.key} onClick={(e:any)=>{e.stopPropagation();valider(it)}}
                              style={{background:C.green,color:'#fff',border:'none',borderRadius:6,padding:isMobile?'6px 8px':'6px 12px',fontWeight:700,cursor:'pointer',fontSize:11,opacity:loadingAction===it.key?0.6:1}}>
                              {loadingAction===it.key?'⏳':'✓'}
                            </button>
                          </div>
                        </div>
                        {isExp && (it.source === 'negatif' ? <NegDetails n={it.raw} verif={it.verif}/> : <ComptDetails c={it.raw} verif={it.verif}/>)}
                      </div>
                    )
                  })}
                </>
            }
          </div>
        </div>
      )}

      {vue === 'historique' && (
        <div>
          <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap'}}>
            {[
              {id:'tous', label:`Tout (${historique.length})`, color:sub},
              {id:'negatif', label:`🔴 Négatifs (${historique.filter((v:any)=>v.source==='negatif').length})`, color:C.red},
              {id:'comptage', label:`📦 Comptages (${historique.filter((v:any)=>v.source==='comptage').length})`, color:C.blue},
            ].map(f => (
              <button key={f.id} onClick={()=>setFiltSourceHist(f.id as any)}
                style={{padding:'6px 12px',borderRadius:14,border:`1px solid ${filtSourceHist===f.id?f.color:bdr}`,background:filtSourceHist===f.id?f.color+'22':'transparent',color:filtSourceHist===f.id?f.color:sub,fontWeight:700,cursor:'pointer',fontSize:11}}>
                {f.label}
              </button>
            ))}
          </div>

          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
            {historiqueFiltre.length === 0
              ? <div style={{textAlign:'center',padding:40,color:sub}}>Aucune validation dans l'historique</div>
              : <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                    <thead><tr style={{background:thBg}}>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Type</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Code</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Détail</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Validé par</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Date</th>
                      <th style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`}}></th>
                    </tr></thead>
                    <tbody>
                      {historiqueFiltre.map((v:any) => {
                        const snap = v.snapshot || {}
                        let detail = '—'
                        if (v.source === 'negatif') detail = `Ajust ${Number(snap.ajustement??0)>=0?'+':''}${Number(snap.ajustement??0).toFixed(0)}${snap.cause?' — '+snap.cause:''}`
                        else if (v.source === 'comptage') {
                          const ec = snap.ecart_reconcilie ?? snap.ecart
                          detail = `${snap.localisation||''} — Écart ${ec>0?'+':''}${ec??'—'}`
                        }
                        return (
                          <tr key={v.id} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`}}>
                              <span style={{background:colorSource(v.source)+'22',color:colorSource(v.source),padding:'2px 8px',borderRadius:8,fontSize:10,fontWeight:700}}>{labelSource(v.source)}</span>
                            </td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,fontWeight:700,fontFamily:'monospace'}}>
                              {v.code_piece}
                              {descParCode.get(v.code_piece) && (
                                <div style={{fontFamily:'sans-serif',fontSize:10,fontWeight:400,color:sub,marginTop:2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:220}} title={descParCode.get(v.code_piece)}>
                                  {descParCode.get(v.code_piece)}
                                </div>
                              )}
                            </td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub}}>{detail}</td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>👤 {v.user_email||'—'}</td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontSize:11,color:sub,whiteSpace:'nowrap'}}>{fmtDate(v.date_validation)}</td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>
                              <button disabled={loadingAction===`undo:${v.id}`} onClick={()=>annuler(v.id)}
                                style={{background:'transparent',color:C.yellow,border:`1px solid ${C.yellow}`,borderRadius:6,padding:'4px 9px',fontSize:11,fontWeight:700,cursor:'pointer'}}>
                                {loadingAction===`undo:${v.id}`?'⏳':'↩'}
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
            }
          </div>
        </div>
      )}

      {/* Modal RETOUR AU DEMANDEUR */}
      {retourModal && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}
             onClick={()=>{setRetourModal(null);setRetourCommentaire('')}}>
          <div onClick={(e:any)=>e.stopPropagation()} style={{background:card,borderRadius:12,maxWidth:560,width:'100%',border:`2px solid ${C.yellow}`,padding:20,boxShadow:'0 10px 40px rgba(0,0,0,.4)'}}>
            <div style={{fontSize:15,fontWeight:900,marginBottom:6,color:C.yellow}}>↩ Retourner au demandeur pour correction</div>
            <div style={{fontSize:12,color:sub,marginBottom:14,lineHeight:1.5}}>
              Cette pièce sera renvoyée à <strong>{retourModal.demandeur}</strong> avec ton commentaire. Elle réapparaîtra dans son onglet d'origine ({retourModal.source==='negatif'?'Négatifs':'Inventaire / Comptages'}) avec un encadré rouge bien visible. Une notification sera affichée dès sa prochaine connexion.
            </div>
            <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:8,marginBottom:14,fontSize:12}}>
              <div style={{color:sub,fontWeight:700}}>Type :</div>
              <div><span style={{background:colorSource(retourModal.source)+'22',color:colorSource(retourModal.source),padding:'2px 8px',borderRadius:6,fontSize:11,fontWeight:700}}>{labelSource(retourModal.source)}</span></div>
              <div style={{color:sub,fontWeight:700}}>Pièce :</div>
              <div style={{fontFamily:'monospace',fontWeight:700}}>{retourModal.code_piece}</div>
              <div style={{color:sub,fontWeight:700}}>Demandeur :</div>
              <div>👤 {retourModal.demandeur || '(inconnu)'}</div>
            </div>
            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:sub,marginBottom:4,textTransform:'uppercase'}}>Raison du retour <span style={{color:C.red}}>*</span></div>
              <textarea value={retourCommentaire} onChange={e=>setRetourCommentaire(e.target.value)}
                placeholder="Ex: Le commentaire ne précise pas si le produit a été retrouvé. Photo manquante. À recompter avec localisation."
                style={{...S,width:'100%',minHeight:100,fontSize:12,padding:'8px 10px',resize:'vertical'}}
                autoFocus/>
              <div style={{fontSize:10,color:sub,marginTop:4}}>Le demandeur verra exactement ce texte. Sois précis pour qu'il sache quoi corriger.</div>
            </div>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
              <button onClick={()=>{setRetourModal(null);setRetourCommentaire('')}}
                style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                Annuler
              </button>
              <button onClick={envoyerRetour} disabled={!retourCommentaire.trim() || loadingAction?.startsWith('retour:')}
                style={{background:retourCommentaire.trim()?C.yellow:bdr,color:'#fff',border:'none',borderRadius:8,padding:'8px 16px',fontWeight:800,cursor:retourCommentaire.trim()?'pointer':'default',fontSize:12}}>
                {loadingAction?.startsWith('retour:') ? '⏳ Envoi...' : '↩ Envoyer le retour'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Amazon Tab (Phase 1) ─────────────────────────────────────────────────────
function AmazonTab({dark, card, bdr, sub, thBg, S, C, hvr, profil}: any) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const [vue, setVue] = useState<'fermeture'|'import'|'settlements'|'inventaire'|'consolide'|'audit'|'mapping'|'multimapping'|'archives'|'rapport'|'unsellable_suivi'|'profitabilite'|'forecast'>('fermeture')
  const [profitabiliteData, setProfitabiliteData] = useState<any>(null)
  const [profitSettlementId, setProfitSettlementId] = useState<string>('')
  const [forecastData, setForecastData] = useState<any>(null)
  const [coutsTransport, setCoutsTransport] = useState<any[]>([])
  const [editingTransport, setEditingTransport] = useState<{ pk_code: string; cout: string } | null>(null)
  const [editingCoutant, setEditingCoutant] = useState<{ pk_code: string; cout: string; source?: string } | null>(null)
  const [drilldownPk, setDrilldownPk] = useState<string | null>(null)
  // États de la vue Fermeture (nouvelle vue principale)
  const [closureList, setClosureList] = useState<any[]>([])
  const [closureActif, setClosureActif] = useState<string | null>(null)
  const [closureDetail, setClosureDetail] = useState<any>(null)
  const [closureLoading, setClosureLoading] = useState(false)
  const [rapportData, setRapportData] = useState<any>(null)
  const [archivesList, setArchivesList] = useState<any[]>([])
  const [multimappingList, setMultimappingList] = useState<any[]>([])
  const [unsellableSuivi, setUnsellableSuivi] = useState<any>(null)
  const [filtUnsellableStatut, setFiltUnsellableStatut] = useState<'tous'|'en_attente'|'resolu'>('tous')
  const [newMappingSku, setNewMappingSku] = useState('')
  const [newMappingPk, setNewMappingPk] = useState('')
  const [searchMultimapping, setSearchMultimapping] = useState('')
  const [lautopakLines, setLautopakLines] = useState<any>(null)
  const [lautopakLoading, setLautopakLoading] = useState(false)
  const [showLautopakModal, setShowLautopakModal] = useState(false)  // ouverture explicite de la modale
  const [lautopakReimbLines, setLautopakReimbLines] = useState<any>(null)
  const [showLautopakReimbModal, setShowLautopakReimbModal] = useState(false)
  const [reimbInvoiceRef, setReimbInvoiceRef] = useState('')
  const [reimbInvoiceDate, setReimbInvoiceDate] = useState('')
  // Workflow v2 : 4 documents LAUTOPAK + balance auto
  const [lautopakDocs, setLautopakDocs] = useState<any>(null)
  const [docDetailModal, setDocDetailModal] = useState<{ doc_type: string } | null>(null)
  const [docInputs, setDocInputs] = useState<Record<string, { numero?: string; date?: string; notes?: string }>>({})
  // Audit FBA auto (comparaison FBA Amazon vs FBA Traction)
  const [fbaComparison, setFbaComparison] = useState<any>(null)
  // Audit FBM lié au settlement courant (audit_type='settlement_fbm')
  const [fbmAuditSettlement, setFbmAuditSettlement] = useState<any>(null)
  const [creatingFbmAudit, setCreatingFbmAudit] = useState(false)
  const [releveRembStock, setReleveRembStock] = useState<Record<string,string>>({})  // saisie par settlement_id
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const [expandedPk, setExpandedPk] = useState<Record<string, boolean>>({})

  async function copyToClipboard(text: string) {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopiedCode(text)
      setTimeout(() => setCopiedCode(prev => prev === text ? null : prev), 1200)
    } catch {
      // Fallback si clipboard API bloquée
      const el = document.createElement('textarea')
      el.value = text; document.body.appendChild(el); el.select()
      try { document.execCommand('copy') } catch {}
      document.body.removeChild(el)
      setCopiedCode(text)
      setTimeout(() => setCopiedCode(prev => prev === text ? null : prev), 1200)
    }
  }
  const [releveMatch, setReleveMatch] = useState<any>(null)
  const [releveSaisi, setReleveSaisi] = useState<Record<string, string>>({})
  const [releveExpanded, setReleveExpanded] = useState<Record<string, boolean>>({})
  const [inventaireGaps, setInventaireGaps] = useState<any>({ rows: [], totals: {}, snapshot_date: null, dashboard: null, history: null })
  const [filtGap, setFiltGap] = useState<'tous'|'action'|'unsellable'|'rupture_fba'|'reclamation'|'ajust_traction'|'watched'|'ok'>('action')
  const [searchGap, setSearchGap] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [showFbm, setShowFbm] = useState(false)
  // Phase 4a : Inventaire consolidé
  const [consolide, setConsolide] = useState<any>({ products: [], totals: {}, snapshot_date: null })
  const [searchConsolide, setSearchConsolide] = useState('')
  const [filtConsolide, setFiltConsolide] = useState<'tous'|'oublis'|'ecart_fba'|'ecart_fbm'|'ok'>('tous')
  const [expandedBase, setExpandedBase] = useState<string|null>(null)
  // Phase 4b : Audit mensuel
  const [audits, setAudits] = useState<any[]>([])
  const [openAudit, setOpenAudit] = useState<any>(null)
  const [auditCounts, setAuditCounts] = useState<any[]>([])
  const [auditStats, setAuditStats] = useState<any>({})
  const [auditFiltre, setAuditFiltre] = useState<'tous'|'restants'|'comptes'|'ecarts'>('ecarts')
  const [auditSearch, setAuditSearch] = useState('')
  const [auditInput, setAuditInput] = useState<Record<string, {total?:string}>>({})
  const [showFinaliseModal, setShowFinaliseModal] = useState(false)
  const [showFbaReconcil, setShowFbaReconcil] = useState(false)
  const [newAuditMois, setNewAuditMois] = useState(() => {
    const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
  })
  const [creatingAudit, setCreatingAudit] = useState(false)
  const [auditInfoCol, setAuditInfoCol] = useState<string|null>(null)
  const [data, setData] = useState<any>({ counts: {}, settlements: [] })
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [importLog, setImportLog] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [unresolved, setUnresolved] = useState<any[]>([])
  const [mappings, setMappings] = useState<any[]>([])
  const [mappingInput, setMappingInput] = useState<Record<string,string>>({})
  // ─ State Phase 2 : settlements ─
  const [settlementsList, setSettlementsList] = useState<any[]>([])
  const [filtLautopak, setFiltLautopak] = useState<'tous'|'pending'|'facture'>('tous')
  const [searchSettlement, setSearchSettlement] = useState('')
  const [expandedSettlement, setExpandedSettlement] = useState<string|null>(null)
  const [detailCache, setDetailCache] = useState<Record<string, any>>({})
  const [loadingDetail, setLoadingDetail] = useState<string|null>(null)
  const [lautopakInput, setLautopakInput] = useState<Record<string, { ref: string; date: string; notes: string }>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  async function charger() {
    setLoading(true)
    try {
      const [d, u, m, s, g, c] = await Promise.all([
        fetch('/api/amazon/data').then(r=>r.json()),
        fetch('/api/amazon/sku-mapping?mode=unresolved').then(r=>r.json()),
        fetch('/api/amazon/sku-mapping?mode=mappings').then(r=>r.json()),
        fetch('/api/amazon/settlements').then(r=>r.json()),
        fetch('/api/amazon/inventory-gaps').then(r=>r.json()),
        fetch('/api/amazon/inventory-consolidated').then(r=>r.json()),
      ])
      if (d && !d.erreur) setData(d)
      if (Array.isArray(u)) setUnresolved(u)
      if (Array.isArray(m)) setMappings(m)
      if (Array.isArray(s)) setSettlementsList(s)
      if (g && !g.erreur) setInventaireGaps(g)
      if (c && !c.erreur) setConsolide(c)
      await chargerAudits()
    } catch {}
    setLoading(false)
  }

  async function chargerDetail(settlement_id: string) {
    if (detailCache[settlement_id]) return detailCache[settlement_id]
    setLoadingDetail(settlement_id)
    try {
      const r = await fetch(`/api/amazon/settlements?id=${encodeURIComponent(settlement_id)}`)
      const j = await r.json()
      if (!j.erreur) {
        setDetailCache(prev => ({...prev, [settlement_id]: j}))
        // Pré-remplir le formulaire LAUTOPAK si existant
        const s = j.settlement
        if (s) {
          setLautopakInput(prev => ({...prev, [settlement_id]: {
            ref: s.lautopak_invoice_ref || '',
            date: s.lautopak_invoice_date ? String(s.lautopak_invoice_date).split('T')[0] : '',
            notes: s.lautopak_notes || '',
          }}))
        }
        return j
      }
    } catch {}
    setLoadingDetail(null)
    return null
  }

  async function toggleSettlement(settlement_id: string) {
    if (expandedSettlement === settlement_id) {
      setExpandedSettlement(null)
    } else {
      setExpandedSettlement(settlement_id)
      await chargerDetail(settlement_id)
      setLoadingDetail(null)
    }
  }

  async function marquerFacture(settlement_id: string) {
    const input = lautopakInput[settlement_id] || { ref: '', date: '', notes: '' }
    if (!input.ref.trim()) { alert('N° de facture LAUTOPAK requis'); return }
    try {
      const r = await fetch('/api/amazon/settlements', {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          settlement_id,
          lautopak_status: 'facture',
          lautopak_invoice_ref: input.ref.trim(),
          lautopak_invoice_date: input.date || null,
          lautopak_notes: input.notes || null,
        })
      })
      const j = await r.json()
      if (j.success) {
        setDetailCache(prev => ({...prev, [settlement_id]: undefined as any}))
        await charger()
        await chargerDetail(settlement_id)
      } else {
        alert(j.erreur || 'Erreur')
      }
    } catch (e:any) { alert(e.message) }
  }

  async function annulerFacture(settlement_id: string) {
    if (!confirm('Annuler la facturation LAUTOPAK de ce settlement ?')) return
    try {
      await fetch('/api/amazon/settlements', {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          settlement_id,
          lautopak_status: 'pending',
          lautopak_invoice_ref: null,
          lautopak_invoice_date: null,
          lautopak_notes: null,
        })
      })
      setDetailCache(prev => ({...prev, [settlement_id]: undefined as any}))
      await charger()
      await chargerDetail(settlement_id)
    } catch (e:any) { alert(e.message) }
  }

  async function chargerAudits() {
    try {
      const r = await fetch('/api/amazon/audits')
      const j = await r.json()
      if (Array.isArray(j)) setAudits(j)
    } catch {}
  }

  async function chargerClosureList() {
    try {
      const r = await fetch('/api/amazon/closure')
      const j = await r.json()
      if (j.settlements) setClosureList(j.settlements)
    } catch {}
  }

  async function supprimerSettlement(settlementId: string) {
    const txt = `⚠️ SUPPRIMER DÉFINITIVEMENT ce settlement ?\n\n${settlementId}\n\nCela va effacer :\n• Les lignes de transactions (payments)\n• L'audit associé + tous les comptages\n• Le settlement lui-même\n\nLes remboursements CSV seront juste dé-liés (pas supprimés). Cette action est irréversible.`
    if (!confirm(txt)) return
    if (!confirm('Vraiment sûr ? Clique OK pour confirmer.')) return
    try {
      const r = await fetch(`/api/amazon/closure?id=${encodeURIComponent(settlementId)}`, { method: 'DELETE' })
      const j = await r.json()
      if (j.success) {
        setClosureActif(null); setClosureDetail(null)
        await chargerClosureList()
        await charger()  // recharge la liste settlementsList (vue avancée)
      } else {
        alert('Erreur : ' + (j.erreur || 'inconnue'))
      }
    } catch (e: any) {
      alert('Exception : ' + e.message)
    }
  }

  async function chargerClosureDetail(settlementId: string) {
    setClosureLoading(true)
    setClosureActif(settlementId)
    try {
      const r = await fetch(`/api/amazon/closure?id=${encodeURIComponent(settlementId)}`)
      const j = await r.json()
      if (!j.erreur) {
        setClosureDetail(j)
        // Auto-charger les lignes LAUTOPAK (orders + reimb) pour affichage inline
        // Orders : toujours utile pour voir les lignes à facturer dans l'étape 1
        try {
          const rOrders = await fetch(`/api/amazon/closure/lautopak-lines?id=${encodeURIComponent(settlementId)}`)
          const jOrders = await rOrders.json()
          if (!jOrders.erreur) setLautopakLines(jOrders)
        } catch {}
        // Reimb : seulement si étape 2 a des items cash
        if (j.steps?.some((st: any) => st.key === '2_reimbursements' && st.items?.length > 0)) {
          try {
            const r2 = await fetch(`/api/amazon/closure/lautopak-reimb-lines?id=${encodeURIComponent(settlementId)}`)
            const j2 = await r2.json()
            if (!j2.erreur) setLautopakReimbLines(j2)
          } catch {}
        }
        // Nouveau workflow v2 : 4 documents LAUTOPAK + balance auto
        try {
          const rDocs = await fetch(`/api/amazon/closure/lautopak-docs?id=${encodeURIComponent(settlementId)}`)
          const jDocs = await rDocs.json()
          if (!jDocs.erreur) setLautopakDocs(jDocs)
        } catch {}
        // Audit FBA auto (comparaison Amazon vs Traction)
        try {
          const rFba = await fetch(`/api/amazon/closure/fba-comparison?id=${encodeURIComponent(settlementId)}`)
          const jFba = await rFba.json()
          if (!jFba.erreur) setFbaComparison(jFba)
        } catch {}
        // Audit FBM lié au settlement (audit_type='settlement_fbm')
        try {
          const rAudits = await fetch('/api/amazon/audits')
          const jAudits = await rAudits.json()
          if (Array.isArray(jAudits)) {
            const fbmAudit = jAudits.find((a: any) => a.settlement_id === settlementId && a.audit_type === 'settlement_fbm')
            setFbmAuditSettlement(fbmAudit || null)
          }
        } catch {}
      }
    } catch {}
    setClosureLoading(false)
  }

  async function demarrerAuditFbmSettlement(settlementId: string, settlementMois: string) {
    setCreatingFbmAudit(true)
    try {
      const r = await fetch('/api/amazon/audits', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          mois: settlementMois,
          label: `FBM Settlement ${settlementId}`,
          started_by: profil?.email || profil?.nom || 'Inconnu',
          settlement_id: settlementId,
          audit_type: 'settlement_fbm',
        })
      })
      const j = await r.json()
      if (j.success && j.audit?.id) {
        setVue('audit')
        await chargerAudits()
        await chargerAuditDetail(j.audit.id)
      } else {
        alert(j.erreur || 'Erreur création audit FBM')
      }
    } catch (e: any) { alert(e.message) }
    setCreatingFbmAudit(false)
  }

  async function ouvrirAuditFbmSettlement(auditId: number) {
    setVue('audit')
    if (!audits.length) await chargerAudits()
    await chargerAuditDetail(auditId)
  }

  async function finaliserAuditFbmDepuisSettlement(auditId: number, settlementId: string) {
    if (!confirm('Finaliser cet audit FBM ? Il passera en statut « terminé » et tu ne pourras plus modifier les comptages sans le rouvrir.')) return
    try {
      await fetch(`/api/amazon/audits/${auditId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'finalize', finished_by: profil?.email || profil?.nom || 'Inconnu' })
      })
      await chargerClosureDetail(settlementId)
    } catch (e: any) { alert(e.message) }
  }

  async function reouvrirAuditFbmDepuisSettlement(auditId: number, settlementId: string) {
    if (!confirm('Rouvrir cet audit FBM pour modifier les comptages ?')) return
    try {
      await fetch(`/api/amazon/audits/${auditId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopen' })
      })
      await chargerClosureDetail(settlementId)
    } catch (e: any) { alert(e.message) }
  }

  async function chargerProfitabilite(settlementId: string) {
    setProfitSettlementId(settlementId)
    try {
      const r = await fetch(`/api/amazon/profitabilite?id=${encodeURIComponent(settlementId)}`)
      const j = await r.json()
      if (!j.erreur) setProfitabiliteData(j)
      else alert(j.erreur)
    } catch (e: any) { alert(e.message) }
  }

  async function chargerForecast() {
    try {
      const r = await fetch('/api/amazon/forecast')
      const j = await r.json()
      if (!j.erreur) setForecastData(j)
    } catch {}
  }

  async function chargerCoutsTransport() {
    try {
      const r = await fetch('/api/amazon/couts-transport')
      const j = await r.json()
      if (Array.isArray(j)) setCoutsTransport(j)
    } catch {}
  }

  async function saisirCoutTransport(pk_code: string, cout_unitaire: number) {
    try {
      await fetch('/api/amazon/couts-transport', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          pk_code, cout_unitaire,
          updated_by: profil?.email || profil?.nom || 'Inconnu',
        })
      })
      await chargerCoutsTransport()
      // Recharger la profitabilité pour refléter le nouveau coût
      if (profitSettlementId) await chargerProfitabilite(profitSettlementId)
    } catch (e: any) { alert(e.message) }
  }

  async function saisirCoutant(pk_code: string, cout_unitaire: number) {
    try {
      const r = await fetch('/api/amazon/couts-manuels', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          pk_code, cout_unitaire,
          updated_by: profil?.email || profil?.nom || 'Inconnu',
        })
      })
      const j = await r.json()
      if (j.erreur) { alert(j.erreur); return }
      // Recharger la profitabilité
      if (profitSettlementId) await chargerProfitabilite(profitSettlementId)
    } catch (e: any) { alert(e.message) }
  }

  async function effacerCoutantManuel(pk_code: string) {
    if (!confirm(`Effacer le coûtant manuel pour ${pk_code} ?\n\nLe système utilisera de nouveau le coûtant Traction (s'il existe).`)) return
    try {
      await fetch(`/api/amazon/couts-manuels?pk_code=${encodeURIComponent(pk_code)}`, { method: 'DELETE' })
      if (profitSettlementId) await chargerProfitabilite(profitSettlementId)
    } catch (e: any) { alert(e.message) }
  }

  async function nettoyerAuditFbm(auditId: number, settlementId: string) {
    if (!confirm('Nettoyer cet audit FBM ?\n\nLes lignes des SKU qui n\'ont eu AUCUNE transaction FBM dans ce settlement ET qui ne sont pas encore comptées seront SUPPRIMÉES.\n\nLes lignes déjà comptées sont préservées.')) return
    try {
      const r = await fetch(`/api/amazon/audits/${auditId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cleanup_no_movement' })
      })
      const j = await r.json()
      if (j.erreur) { alert(j.erreur); return }
      alert(`Nettoyage terminé : ${j.deleted} ligne(s) supprimée(s), ${j.kept} ligne(s) conservée(s).\nBases avec mouvement FBM ce settlement : ${j.bases_avec_mouvement}.`)
      await chargerClosureDetail(settlementId)
      // Si l'audit est ouvert, le rafraîchir aussi
      if (openAudit?.id === auditId) await chargerAuditDetail(auditId)
    } catch (e: any) { alert(e.message) }
  }

  // Quitter la vue audit. Si l'audit ouvert a un settlement_id, on revient
  // directement au settlement et on rafraîchit son détail (pour que le bandeau
  // FBM montre le statut à jour).
  async function retourDepuisAudit(auditOuvert: any) {
    const sid = auditOuvert?.settlement_id
    setOpenAudit(null)
    setAuditCounts([])
    if (sid) {
      setVue('fermeture')
      await chargerClosureDetail(sid)
    }
  }

  async function saisirDocLautopak(settlement_id: string, doc_type: string, payload: { numero_facture?: string; date_facture?: string; montant_total?: number; notes?: string }) {
    try {
      const r = await fetch('/api/amazon/closure/lautopak-docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settlement_id, doc_type,
          ...payload,
          saisi_par: profil?.nom || profil?.email || 'Inconnu',
        }),
      })
      const j = await r.json()
      if (!j.success) { alert(j.erreur || 'Erreur'); return }
      // Recharge les docs (pour avoir saisi_le, saisi_par, etc.)
      const rDocs = await fetch(`/api/amazon/closure/lautopak-docs?id=${encodeURIComponent(settlement_id)}`)
      const jDocs = await rDocs.json()
      if (!jDocs.erreur) setLautopakDocs(jDocs)
    } catch (e: any) { alert(e.message) }
  }

  async function effacerDocLautopak(settlement_id: string, doc_type: string) {
    if (!confirm(`Effacer la saisie ${doc_type} ?`)) return
    try {
      await fetch(`/api/amazon/closure/lautopak-docs?settlement_id=${encodeURIComponent(settlement_id)}&doc_type=${doc_type}`, { method: 'DELETE' })
      const rDocs = await fetch(`/api/amazon/closure/lautopak-docs?id=${encodeURIComponent(settlement_id)}`)
      const jDocs = await rDocs.json()
      if (!jDocs.erreur) setLautopakDocs(jDocs)
    } catch (e: any) { alert(e.message) }
  }

  async function validerEtape(settlementId: string, step: number | 'close' | 'reopen', action: 'validate' | 'unvalidate' = 'validate') {
    try {
      await fetch('/api/amazon/closure', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ settlement_id: settlementId, step, action, employe: profil?.nom || profil?.email || 'Inconnu' })
      })
      await chargerClosureDetail(settlementId)
      await chargerClosureList()
    } catch {}
  }

  async function chargerRapport(settlementId: string) {
    try {
      const [r1, r2, r3, r4] = await Promise.all([
        fetch(`/api/amazon/closure/report?id=${encodeURIComponent(settlementId)}`),
        fetch(`/api/amazon/closure/releve-match?id=${encodeURIComponent(settlementId)}`),
        fetch(`/api/amazon/closure/lautopak-docs?id=${encodeURIComponent(settlementId)}`),
        fetch(`/api/amazon/closure/fba-comparison?id=${encodeURIComponent(settlementId)}`),
      ])
      const [j1, j2, j3, j4] = await Promise.all([r1.json(), r2.json(), r3.json(), r4.json()])
      // Charger aussi la liste des audits liés pour la section 4
      let auditsLies: any[] = []
      try {
        const rA = await fetch('/api/amazon/audits')
        const jA = await rA.json()
        if (Array.isArray(jA)) auditsLies = jA.filter((a: any) => a.settlement_id === settlementId)
      } catch {}
      if (!j1.erreur) {
        setRapportData({
          ...j1,
          releve: !j2?.erreur ? j2 : null,
          lautopak_docs: !j3?.erreur ? j3 : null,
          fba_comparison: !j4?.erreur ? j4 : null,
          audits_lies: auditsLies,
        })
        setVue('rapport')
      }
    } catch {}
  }

  async function exporterRapportXlsx(r: any) {
    try {
      const XLSX: any = await import('xlsx')
      const wb = XLSX.utils.book_new()
      const fmtDate = (d: string | null) => d ? String(d).split('T')[0] : ''
      const num2 = (n: any) => Number(Number(n||0).toFixed(2))

      // Sommaire
      const sommaire: any[] = [
        ['Settlement ID', r.settlement.settlement_id],
        ['Période début', fmtDate(r.settlement.settlement_start)],
        ['Période fin', fmtDate(r.settlement.settlement_end)],
        ['Date de dépôt', fmtDate(r.settlement.deposit_date)],
        ['Montant Amazon (CA$)', num2(r.settlement.total_amount)],
        ['Facture LAUTOPAK', r.settlement.lautopak_invoice_ref || ''],
        ['Date facture LAUTOPAK', fmtDate(r.settlement.lautopak_invoice_date)],
        ['Statut', r.settlement.closed_at ? `Fermé le ${fmtDate(r.settlement.closed_at)} par ${r.settlement.closed_by}` : 'En cours'],
        [],
        ['Total dépôt Amazon', num2(r.totaux.total_depot_amazon)],
        ['Total reimbursements (CSV pièces perdues)', num2(r.totaux.total_reimbursements)],
        ['Ajustement inventaire net', num2(r.totaux.total_ajustement_inventaire_net)],
        ['Ajustement inventaire absolu', num2(r.totaux.total_ajustement_inventaire_abs)],
        ['Unsellable en attente', num2(r.totaux.total_unsellable)],
        ['Audit base products comptés', `${r.audit_stats.nb_counted}/${r.audit_stats.nb_total}`],
        ['Généré le', fmtDate(r.genere_le)],
      ]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sommaire), 'Sommaire')

      // ═══ Workflow v2 — Sections 1-5 ═══
      if (r.lautopak_docs) {
        const ld = r.lautopak_docs
        const docLabels: Record<string, string> = {
          'ventes': 'Facture VENTES',
          'note_credit_retours': 'Note crédit RETOURS sellable',
          'note_credit_pertes': 'Note crédit PERTES / DOMMAGES',
          'ajust_audit': 'Ajustement INVENTAIRE (audits)',
        }

        // Feuille 1 — Documents LAUTOPAK
        const sec1: any[] = [['Type', 'N° facture LAUTOPAK', 'Date', 'Nb lignes', 'Montant CA$']]
        for (const doc of ld.docs) {
          sec1.push([
            docLabels[doc.doc_type] || doc.label,
            doc.numero_facture || '(non saisi)',
            doc.date_facture ? fmtDate(doc.date_facture) : '',
            doc.lignes.length,
            num2(doc.total),
          ])
        }
        sec1.push([])
        sec1.push(['Net stock LAUTOPAK total (4 docs)', '', '', '', num2(ld.net_lautopak)])
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sec1), '1 - Documents LAUTOPAK')

        // Feuille 2 — Coûts Amazon
        const ca = ld.couts_amazon || {}
        const sec2: any[] = [['Catégorie', 'Montant CA$']]
        const labels: Record<string,string> = {
          'A_TOTAL_section_A': 'A — VENTES (hors Doc 1)',
          'A_ventes_expedition': '   Expédition (Order Shipping)',
          'A_ventes_taxes_net': '   Taxes net',
          'B_TOTAL_section_B': 'B — REMBOURSEMENTS (hors Doc 2 cashflow)',
          'B_remb_depenses_pos': '   Dépenses remboursées (positifs)',
          'B_remb_depenses_neg': '   Dépenses remboursées (négatifs)',
          'B_remb_ventes_frais_produit_non_sellable': '   Ventes remboursées : Frais produit non sellable',
          'B_remb_ventes_expedition': '   Ventes remboursées : Expédition',
          'C_TOTAL_section_C': 'C — DÉPENSES (= relevé papier section Dépenses)',
          'C_rabais_promotionnels': '   Rabais promotionnels',
          'C_frais_fba_stockage': '   Frais Expédié par Amazon — Stockage',
          'C_frais_fba_autres': '   Frais Expédié par Amazon — Autre',
          'C_frais_fba_abonnement': '   Frais d\'abonnement',
          'C_publicite': '   Prix de la publicité',
          'C_commissions_amazon': '   Commissions Amazon',
          'C_remboursements_inverses': '   Remboursements inversés (FBA)',
          'Z_autre_non_classe': 'AUTRE / non classé',
        }
        for (const k of Object.keys(labels)) {
          if (ca[k] !== undefined && Math.abs(Number(ca[k])) >= 0.01) {
            sec2.push([labels[k], num2(ca[k])])
          }
        }
        sec2.push([])
        sec2.push(['= TOTAL Coût des ventes Amazon', num2(ld.total_couts_amazon)])
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sec2), '2 - Couts Amazon')

        // Feuille 3 — Balance
        const sec3 = [
          ['Élément', 'Montant CA$'],
          ['Cashflow Doc 1 (Vente Order Principal)', num2(ld.cashflow_docs?.doc1_ventes)],
          ['Cashflow Doc 2 (Retours sellable, part Refund Principal)', num2(ld.cashflow_docs?.doc2_retours)],
          ['Cashflow Doc 3 (Pertes, Reim Amazon dans TSV)', num2(ld.cashflow_docs?.doc3_pertes)],
          ['Doc 4 (Audit) — hors cashflow', 0],
          [],
          ['+ Total cashflow documents', num2(ld.cashflow_docs?.total)],
          ['+ Coût des ventes Amazon (compte agrégé)', num2(ld.total_couts_amazon)],
          ['= Dépôt bancaire calculé', num2(ld.balance_calcul)],
          ['Dépôt bancaire réel (TSV settlement)', num2(ld.balance_settlement)],
          ['Écart', num2((ld.balance_calcul||0) - (ld.balance_settlement||0))],
          ['Balance OK ?', ld.balance_ok ? 'OUI ✓' : 'NON ⚠'],
        ]
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sec3), '3 - Balance')

        // Feuille 4 — Audits liés
        const sec4: any[] = [['Type', 'Libellé', 'Statut', 'Comptés', 'Total', 'Démarré', 'Terminé']]
        for (const a of (r.audits_lies || [])) {
          const labelType = a.audit_type === 'settlement_fbm' ? 'FBM (settlement)' :
                            a.audit_type === 'settlement_fba' ? 'FBA snapshot' :
                            a.audit_type === 'mensuel_ama' ? 'AMA mensuel' : (a.audit_type || '?')
          sec4.push([
            labelType, a.label || '', a.statut === 'termine' ? 'Terminé' : 'En cours',
            a.nb_comptes || 0, a.nb_total || 0,
            a.started_at ? fmtDate(a.started_at) : '', a.finished_at ? fmtDate(a.finished_at) : '',
          ])
        }
        if (r.fba_comparison && !r.fba_comparison.erreur_avertissement) {
          sec4.push([])
          sec4.push(['Audit FBA auto', `Snapshot ${r.fba_comparison.snapshot_date}`, '', r.fba_comparison.nb_pk_codes_compares, '', '', ''])
          sec4.push(['  Écarts à réclamer Amazon', `${r.fba_comparison.nb_ecarts} produits`, '', r.fba_comparison.total_ecart_units_abs, '', '', num2(r.fba_comparison.total_ecart_valeur_abs)])
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sec4), '4 - Audits lies')

        // Feuille 5 — Détail SKU par document
        const sec5: any[] = [['Document', 'SKU Amazon', 'PKCode', 'Produit', 'Qté', 'Prix unit. CA$', 'Montant CA$', 'Note']]
        for (const doc of ld.docs) {
          for (const l of doc.lignes) {
            sec5.push([
              docLabels[doc.doc_type] || doc.label,
              l.sku, l.pk_code || '', l.product_name || '',
              Number(l.qty || 0), num2(l.prix_unitaire),
              num2(l.amount), l.notes || '',
            ])
          }
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sec5), '5 - Detail SKU')
      }

      // Relevé de paiement reconstitué
      if (r.releve) {
        const rv = r.releve
        const aoa = [
          ['Catégorie', 'Montant CA$'],
          ['VENTES', num2(rv.ventes.total)],
          ['  Frais produit', num2(rv.ventes.frais_produit)],
          ['  Expédition', num2(rv.ventes.expedition)],
          ['  Remboursements de stock (FBA)', num2(rv.ventes.remboursements_stock_fba)],
          ['REMBOURSEMENTS', num2(rv.remboursements.total)],
          ['  Dépenses remboursées', num2(rv.remboursements.depenses_rembourses)],
          ['  Ventes remboursées (total)', num2(rv.remboursements.ventes_remboursees_total)],
          ['    — Expédition', num2(rv.remboursements.ventes_remboursees_expedition)],
          ['    — Frais produit', num2(rv.remboursements.ventes_remboursees_frais_produit)],
          ['DÉPENSES', num2(rv.depenses.total)],
          ['  Rabais promotionnels', num2(rv.depenses.rabais_promotionnels)],
          ['  Frais Expédié par Amazon (total)', num2(rv.depenses.frais_fba_total)],
          ['    — Frais de stockage mensuels', num2(rv.depenses.frais_fba_stockage)],
          ['    — Autre', num2(rv.depenses.frais_fba_autre)],
          ['  Prix de la publicité', num2(rv.depenses.publicite)],
          ['  Commissions Amazon', num2(rv.depenses.commissions_amazon)],
          ['  Remboursements inversés (FBA)', num2(rv.depenses.remboursements_inverses_fba)],
          [],
          ['PROFITS NETS (= dépôt bancaire)', num2(rv.profits_nets_calcules)],
        ]
        if (rv.reste_non_classe && Math.abs(rv.reste_non_classe) >= 0.01) {
          aoa.push([], ['⚠ Reste non classé', num2(rv.reste_non_classe)])
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Releve reconstitue')
      }

      // Flux par amount type
      const fluxRows = [['Amount type', 'Nb lignes', 'Total CA$'],
        ...(r.flux || []).map((f: any) => [f.amount_type, f.count, num2(f.total)])]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fluxRows), 'Flux par type')

      // Reimbursements (CSV pièces perdues)
      const reimbHeader = ['Reimb. ID', 'SKU', 'FNSKU', 'Traction', 'Raison', 'Produit', 'Qty cash', 'Qty inv', 'Montant CA$', 'Case ID']
      const reimbRows = [reimbHeader, ...(r.reimbursements || []).map((x: any) => [
        x.reimbursement_id, x.sku || '', x.fnsku || '', x.traction_code || '', x.reason || '',
        x.product_name || '', Number(x.quantity_reimbursed_cash || 0), Number(x.quantity_reimbursed_inventory || 0),
        num2(x.amount_total), x.case_id || '',
      ])]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(reimbRows), 'Reimbursements')

      // Ajustements FBA cash
      const fbaHeader = ['Reimb. ID', 'SKU Amazon', 'Produit', 'Raison', 'Qté cash', 'Qté avec mult.', 'Mult.', 'Mapping manuel', 'Montant CA$', 'Pk_code Traction', 'Stock actuel', 'Nouveau stock']
      const fbaRows = [fbaHeader, ...(r.ajustements_fba || []).map((a: any) => [
        a.reimbursement_id, a.sku, a.product_name || '', a.reason || '',
        Number(a.qty_cash || 0), Number(a.qty_cash_lautopak || 0), Number(a.multiplier || 1), a.manual_mapping ? 'Oui' : 'Non',
        num2(a.amount), a.pk_code_to_adjust || '',
        a.current_traction_qty != null ? a.current_traction_qty : '',
        a.current_traction_qty != null ? a.current_traction_qty - Number(a.qty_cash || 0) : '',
      ])]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fbaRows), 'Ajust. FBA cash')

      // Ajustements audit physique
      const ajHeader = ['Base code', 'Description', 'Whse théo (net)', 'Whse compté', 'Δ Whse', 'FBM théo', 'FBM compté', 'Δ FBM', 'Coût unit', 'Valeur écart CA$', 'SP à tagger']
      const ajRows = [ajHeader, ...(r.ajustements || []).map((a: any) => [
        a.base_code, a.description || '',
        Number(a.warehouse_theorique_net || 0), a.warehouse_compte ?? '',
        Number(a.warehouse_ecart || 0), Number(a.fbm_theorique || 0),
        a.fbm_compte ?? '', Number(a.fbm_ecart || 0),
        num2(a.coutant), num2(a.valeur_ecart),
        a.has_oubli ? Number(a.sans_prefix_theorique || 0) : '',
      ])]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ajRows), 'Ajust. inventaire')

      // Unsellable
      const unsHeader = ['SKU', 'Traction', 'Produit', 'Qté', 'Valeur estimée CA$']
      const unsRows = [unsHeader, ...(r.unsellable || []).map((u: any) => [
        u.sku, u.traction_code || '', u.product_name || '',
        Number(u.qty || 0), num2(u.valeur),
      ])]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(unsRows), 'Unsellable')

      const fname = `Rapport_Amazon_${r.settlement.settlement_id}_${fmtDate(r.settlement.settlement_end)}.xlsx`
      XLSX.writeFile(wb, fname)
    } catch (e: any) {
      alert('Erreur export Excel : ' + (e?.message || e))
    }
  }

  async function chargerUnsellableSuivi() {
    try {
      const r = await fetch('/api/amazon/unsellable-suivi')
      const j = await r.json()
      if (!j.erreur) setUnsellableSuivi(j)
    } catch {}
  }

  async function chargerMultimapping() {
    try {
      const r = await fetch('/api/amazon/sku-pkcodes')
      const j = await r.json()
      if (j.mappings) setMultimappingList(j.mappings)
    } catch {}
  }
  async function ajouterMapping(amazon_sku: string, pk_code: string) {
    if (!amazon_sku.trim() || !pk_code.trim()) return
    try {
      const r = await fetch('/api/amazon/sku-pkcodes', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ amazon_sku: amazon_sku.trim(), pk_code: pk_code.trim() }),
      })
      const j = await r.json()
      if (j.success) {
        setNewMappingSku(''); setNewMappingPk('')
        await chargerMultimapping()
      } else alert('Erreur : ' + j.erreur)
    } catch (e: any) { alert('Exception : ' + e.message) }
  }
  async function supprimerMappingMulti(id: number) {
    try {
      await fetch(`/api/amazon/sku-pkcodes?id=${id}`, { method: 'DELETE' })
      await chargerMultimapping()
    } catch {}
  }

  async function chargerArchives() {
    try {
      const r = await fetch('/api/amazon/archives')
      const j = await r.json()
      if (j.archives) setArchivesList(j.archives)
    } catch {}
  }

  async function toggleLautopakReimbFacturee(settlementId: string, pkCode: string, dejaFacturee: boolean) {
    const nowIso = new Date().toISOString()
    const employe = profil?.nom || profil?.email || 'Inconnu'
    const key = 'reimb:' + pkCode   // namespace pour éviter collision avec orders
    setLautopakReimbLines((prev: any) => {
      if (!prev) return prev
      const newLignes = prev.lignes.map((l: any) =>
        l.pk_code === pkCode
          ? { ...l, facturee: !dejaFacturee, facturee_le: !dejaFacturee ? nowIso : null, facturee_par: !dejaFacturee ? employe : null }
          : l
      )
      return { ...prev, lignes: newLignes }
    })
    try {
      const r = await fetch('/api/amazon/lautopak-facturees', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          settlement_id: settlementId, sku: key, employe,
          action: dejaFacturee ? 'uncheck' : 'check',
        }),
      })
      if (!r.ok) {
        let msg = 'HTTP ' + r.status
        try { const j = await r.json(); msg += ' — ' + (j.erreur || JSON.stringify(j)) } catch {}
        throw new Error(msg)
      }
    } catch (e: any) {
      setLautopakReimbLines((prev: any) => {
        if (!prev) return prev
        const newLignes = prev.lignes.map((l: any) => l.pk_code === pkCode ? { ...l, facturee: dejaFacturee } : l)
        return { ...prev, lignes: newLignes }
      })
      alert('Erreur : ' + e.message)
    }
  }

  async function toggleLautopakFacturee(settlementId: string, pkCodeKey: string, dejaFacturee: boolean) {
    // Mise à jour optimiste : la ligne bouge immédiatement (match par pk_code)
    const nowIso = new Date().toISOString()
    const employe = profil?.nom || profil?.email || 'Inconnu'
    setLautopakLines((prev: any) => {
      if (!prev) return prev
      const newLignes = prev.lignes.map((l: any) =>
        l.pk_code === pkCodeKey
          ? { ...l, facturee: !dejaFacturee, facturee_le: !dejaFacturee ? nowIso : null, facturee_par: !dejaFacturee ? employe : null }
          : l
      )
      return { ...prev, lignes: newLignes }
    })
    // Sauvegarde en arrière-plan (on stocke pkCodeKey dans la colonne sku de la table)
    try {
      const r = await fetch('/api/amazon/lautopak-facturees', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          settlement_id: settlementId, sku: pkCodeKey, employe,
          action: dejaFacturee ? 'uncheck' : 'check',
        }),
      })
      if (!r.ok) {
        let msg = 'HTTP ' + r.status
        try { const j = await r.json(); msg += ' — ' + (j.erreur || JSON.stringify(j)) } catch {}
        throw new Error(msg)
      }
    } catch (e: any) {
      // Rollback
      setLautopakLines((prev: any) => {
        if (!prev) return prev
        const newLignes = prev.lignes.map((l: any) =>
          l.pk_code === pkCodeKey ? { ...l, facturee: dejaFacturee } : l
        )
        return { ...prev, lignes: newLignes }
      })
      console.error('[lautopak-facturees]', e)
      alert('Erreur de sauvegarde : ' + e.message)
    }
  }

  async function saveUnsellableAction(settlementId: string, sku: string, tractionCode: string | null, patch: { action_type?: string|null; amazon_ref?: string; notes?: string }) {
    // Optimistic update — applique immédiatement le changement sur l'item dans closureDetail
    let snapshot: any = null
    setClosureDetail((prev: any) => {
      if (!prev?.steps) return prev
      snapshot = prev
      const newSteps = prev.steps.map((st: any) => {
        if (st.key !== '3_unsellable' || !st.items) return st
        const newItems = st.items.map((u: any) => {
          if (u.sku !== sku) return u
          const cur = u.action || {}
          const next = {
            ...cur,
            ...patch,
            action_le: patch.action_type !== undefined
              ? (patch.action_type ? new Date().toISOString() : null)
              : cur.action_le,
            action_par: patch.action_type !== undefined
              ? (patch.action_type ? (profil?.nom || profil?.email || 'Inconnu') : null)
              : cur.action_par,
          }
          return { ...u, action: next }
        })
        return { ...st, items: newItems }
      })
      return { ...prev, steps: newSteps }
    })
    try {
      const r = await fetch('/api/amazon/unsellable-actions', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          settlement_id: settlementId,
          sku, traction_code: tractionCode,
          ...patch,
          employe: profil?.nom || profil?.email || 'Inconnu',
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.erreur) {
        if (snapshot) setClosureDetail(snapshot)
        alert('Erreur sauvegarde unsellable : ' + (j.erreur || `HTTP ${r.status}`))
        return
      }
      if (closureActif) await chargerClosureDetail(closureActif)
      // Rafraîchir le Suivi unsellable en arrière-plan pour qu'il soit à jour
      // la prochaine fois que l'utilisateur ouvre cet onglet.
      chargerUnsellableSuivi()
    } catch (e: any) {
      if (snapshot) setClosureDetail(snapshot)
      alert('Erreur : ' + e.message)
    }
  }

  async function appliquerRemovalAuto(settlementId: string, sku: string, tractionCode: string|null, orderId: string) {
    // Pré-remplit action_type='removal' + amazon_ref=order_id en un seul appel
    try {
      const r = await fetch('/api/amazon/unsellable-actions', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          settlement_id: settlementId, sku, traction_code: tractionCode,
          action_type: 'removal',
          amazon_ref: orderId,
          employe: profil?.nom || profil?.email || 'Inconnu',
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.erreur) {
        alert('Erreur : ' + (j.erreur || `HTTP ${r.status}`))
        return
      }
      if (closureActif) await chargerClosureDetail(closureActif)
      chargerUnsellableSuivi()
    } catch (e: any) { alert('Erreur : ' + e.message) }
  }

  async function marquerUnsellableTraite(settlementId: string, sku: string) {
    if (!confirm(`Sortir ce SKU (${sku}) de la liste à traiter ?\n\nIl restera visible dans l'onglet 🔥 Suivi unsellable pour le suivi historique.`)) return
    try {
      const r = await fetch('/api/amazon/unsellable-actions', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          settlement_id: settlementId,
          sku,
          action: 'traiter',
          employe: profil?.nom || profil?.email || 'Inconnu',
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.erreur) {
        alert('Erreur : ' + (j.erreur || `HTTP ${r.status}`))
        return
      }
      if (closureActif) await chargerClosureDetail(closureActif)
      chargerUnsellableSuivi()
    } catch (e: any) { alert('Erreur : ' + e.message) }
  }

  async function toggleAjustementReimbursement(reimbursementId: string, pkCode: string | null, dejaAjuste: boolean) {
    try {
      await fetch('/api/amazon/reimbursements', {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          reimbursement_id: reimbursementId,
          pk_code: pkCode,
          employe: profil?.nom || profil?.email || 'Inconnu',
          action: dejaAjuste ? 'unmark' : 'mark',
        }),
      })
      if (closureActif) await chargerClosureDetail(closureActif)
    } catch (e: any) { alert('Erreur : ' + e.message) }
  }

  async function chargerReleveMatch(settlementId: string) {
    setReleveMatch(null)
    try {
      const r = await fetch(`/api/amazon/closure/releve-match?id=${encodeURIComponent(settlementId)}`)
      const j = await r.json()
      if (!j.erreur) setReleveMatch(j)
      else alert('Erreur : ' + j.erreur)
    } catch (e: any) { alert('Exception : ' + e.message) }
  }

  async function chargerLautopakReimbLines(settlementId: string) {
    setLautopakReimbLines(null)
    try {
      const r = await fetch(`/api/amazon/closure/lautopak-reimb-lines?id=${encodeURIComponent(settlementId)}`)
      const j = await r.json()
      if (!j.erreur) setLautopakReimbLines(j)
      else alert('Erreur : ' + j.erreur)
    } catch (e: any) { alert('Exception : ' + e.message) }
  }

  async function sauverReimbInvoice(settlementId: string) {
    if (!reimbInvoiceRef.trim() || !reimbInvoiceDate) return
    try {
      const r = await fetch('/api/amazon/settlements', {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          settlement_id: settlementId,
          lautopak_reimb_invoice_ref: reimbInvoiceRef.trim(),
          lautopak_reimb_invoice_date: reimbInvoiceDate,
        }),
      })
      const j = await r.json()
      if (j.success) {
        setReimbInvoiceRef(''); setReimbInvoiceDate('')
        await chargerClosureDetail(settlementId)
      } else alert('Erreur : ' + (j.erreur || 'inconnue'))
    } catch (e: any) { alert('Exception : ' + e.message) }
  }

  async function chargerLautopakLines(settlementId: string) {
    setLautopakLoading(true)
    setLautopakLines(null)
    try {
      const r = await fetch(`/api/amazon/closure/lautopak-lines?id=${encodeURIComponent(settlementId)}`)
      const j = await r.json()
      if (!j.erreur) setLautopakLines(j)
      else alert('Erreur : ' + j.erreur)
    } catch (e: any) { alert('Exception : ' + e.message) }
    setLautopakLoading(false)
  }

  function exportLautopakCsv(data: any) {
    if (!data || !data.lignes) return
    const headers = ['SKU','Code Traction','Produit','Qté','Prix unitaire','Montant']
    const rows = data.lignes.map((l: any) => [
      l.sku, l.traction_code || '', l.product_name || '',
      l.qty, l.prix_unitaire.toFixed(2), l.amount.toFixed(2),
    ])
    const csv = [headers, ...rows].map(r => r.map(v => {
      const s = String(v ?? '')
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s
    }).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `lautopak_${data.settlement_id}_${new Date().toISOString().slice(0,10)}.csv`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  async function chargerAuditDetail(auditId: number) {
    try {
      const r = await fetch(`/api/amazon/audits/${auditId}`)
      const j = await r.json()
      if (!j.erreur) {
        setOpenAudit(j.audit)
        setAuditCounts(j.counts || [])
        setAuditStats(j.stats || {})
        // Pré-remplir input "total compté" avec la somme des champs existants.
        // Migration douce : un audit historique avec hub=3, fbm=2 affiche 5.
        const pre: Record<string, {total?:string}> = {}
        for (const c of (j.counts || [])) {
          pre[c.base_code] = {
            total: c.total_compte != null ? String(c.total_compte) : '',
          }
        }
        setAuditInput(pre)
      }
    } catch {}
  }

  async function backfillAudits() {
    if (!confirm('Créer un audit pour chaque settlement existant qui n\'en a pas encore ? (Sync Traction incluse)')) return
    setCreatingAudit(true)
    try {
      const r = await fetch('/api/amazon/audits/backfill', { method: 'POST' })
      const j = await r.json()
      if (j.success) {
        setImportLog(l => [...l, `🔒 Backfill : ${j.created} audits créés, ${j.skipped} déjà existants (${j.total_settlements} settlements)`])
        await chargerAudits()
      } else {
        alert(j.erreur || 'Erreur backfill')
      }
    } catch (e:any) { alert(e.message) }
    setCreatingAudit(false)
  }

  async function creerAudit() {
    if (!newAuditMois) return
    setCreatingAudit(true)
    try {
      const r = await fetch('/api/amazon/audits', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ mois: newAuditMois, started_by: profil?.email || profil?.nom || 'Inconnu' })
      })
      const j = await r.json()
      if (j.success) {
        await chargerAudits()
        await chargerAuditDetail(j.audit.id)
      } else {
        alert(j.erreur || 'Erreur')
      }
    } catch (e:any) { alert(e.message) }
    setCreatingAudit(false)
  }

  async function sauvegarderComptage(base_code: string) {
    if (!openAudit) return
    const input = auditInput[base_code] || {}
    if (input.total === undefined) return
    const body: any = {
      base_code,
      counted_by: profil?.email || profil?.nom || 'Inconnu',
      total_compte: input.total === '' ? null : Number(input.total),
    }
    try {
      await fetch(`/api/amazon/audits/${openAudit.id}`, {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body)
      })
      await chargerAuditDetail(openAudit.id)
    } catch (e:any) { alert(e.message) }
  }

  async function marquerRestantsZero() {
    if (!openAudit) return
    const restants = (auditCounts || []).filter((c:any) =>
      Number(c.total_theorique_net||0) > 0 && c.total_compte == null
    ).length
    if (restants === 0) { alert('Aucun SKU restant à marquer.'); return }
    if (!confirm(`Marquer les ${restants} SKU non comptés à 0 ?\n\nCela signifie : "physiquement, je n'en ai trouvé aucun". Tu pourras revenir corriger après en éditant la ligne.`)) return
    try {
      const r = await fetch(`/api/amazon/audits/${openAudit.id}`, {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ action: 'mark_zero_remaining', counted_by: profil?.email || profil?.nom || 'Inconnu' })
      })
      const j = await r.json()
      if (j.success) {
        await chargerAuditDetail(openAudit.id)
      } else {
        alert(j.erreur || 'Erreur')
      }
    } catch (e:any) { alert(e.message) }
  }

  function ouvrirFinalisation() {
    setShowFinaliseModal(true)
  }

  async function finaliserAudit() {
    if (!openAudit) return
    try {
      await fetch(`/api/amazon/audits/${openAudit.id}`, {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ action: 'finalize', finished_by: profil?.email || profil?.nom || 'Inconnu' })
      })
      setShowFinaliseModal(false)
      await chargerAudits()
      await chargerAuditDetail(openAudit.id)
    } catch (e:any) { alert(e.message) }
  }

  async function reouvrirAudit() {
    if (!openAudit) return
    try {
      await fetch(`/api/amazon/audits/${openAudit.id}`, {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ action: 'reopen' })
      })
      await chargerAudits()
      await chargerAuditDetail(openAudit.id)
    } catch (e:any) { alert(e.message) }
  }

  async function rafraichirAudit() {
    if (!openAudit) return
    if (!confirm(`Rafraîchir les valeurs théoriques de l'audit "${openAudit.label}" ?\n\nLe stock Traction sera d'abord re-syncronisé depuis le feed, puis les théoriques (FBA Amazon, FBA Traction, HUB, FBM) seront recalculés.\n\nLes comptages physiques déjà saisis sont préservés.`)) return
    try {
      // 1. Re-sync Traction depuis le feed pour avoir le stock actuel
      const rSync = await fetch('/api/amazon/sync-traction', { method: 'POST' })
      const jSync = await rSync.json()
      if (jSync.erreur) { alert('Erreur sync Traction : ' + jSync.erreur); return }
      // 2. Recalculer les théoriques de l'audit avec le nouveau snapshot
      const r = await fetch(`/api/amazon/audits/${openAudit.id}/refresh`, { method: 'POST' })
      const j = await r.json()
      if (j.success) {
        alert(`✓ Rafraîchi : ${j.updated} lignes mises à jour${j.inserted ? `, ${j.inserted} nouvelles lignes` : ''} (snapshot ${j.snapshot_date || 'n/a'})`)
        await chargerAuditDetail(openAudit.id)
      } else {
        alert(j.erreur || 'Erreur')
      }
    } catch (e:any) { alert(e.message) }
  }

  async function supprimerAudit(id: number, label: string) {
    if (!confirm(`Supprimer définitivement l'audit "${label}" ?`)) return
    try {
      await fetch('/api/amazon/audits', {
        method: 'DELETE',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ id })
      })
      if (openAudit?.id === id) { setOpenAudit(null); setAuditCounts([]) }
      await chargerAudits()
    } catch (e:any) { alert(e.message) }
  }

  function exportAuditCsv() {
    if (!openAudit || !auditCounts.length) return
    const headers = ['Base','Description','Warehouse attendu','Warehouse compté','Warehouse écart','Oubli (SP brut)','FBM théo','FBM compté','FBM écart','FBA Amazon','FBA Traction','Coût unit','Valeur écart Warehouse','Valeur écart FBM','Notes']
    const rows = auditCounts.map((c:any) => [
      c.base_code,
      (c.description||'').replace(/"/g,'""'),
      c.warehouse_theorique_net, c.warehouse_compte??'', c.warehouse_ecart??'',
      c.sans_prefix_theorique,
      c.fbm_theorique, c.fbm_compte??'', c.fbm_ecart??'',
      c.fba_amazon_theorique, c.fba_traction_theorique,
      c.coutant, c.valeur_warehouse_ecart, c.valeur_fbm_ecart,
      (c.notes||'').replace(/"/g,'""'),
    ].map(v => `"${v}"`).join(','))
    const csv = [headers.join(','), ...rows].join('\n')
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit_${openAudit.mois}_${openAudit.id}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Feuille de comptage simplifiée — un seul champ "Compté" par SKU.
  //   mode='tout'   : tous les SKU avec stock physique attendu > 0
  //   mode='ecarts' : seulement ceux avec écart non nul (recomptage)
  function exporterFeuilleComptage(mode: 'tout' | 'ecarts') {
    if (!openAudit || !auditCounts.length) return
    let rows = auditCounts.filter((c:any) => {
      const tot = Number(c.total_theorique_net||0)
      if (tot === 0) return false
      if (mode === 'ecarts') return !!c.has_ecart_total
      return true
    })
    if (rows.length === 0) {
      alert(mode === 'ecarts'
        ? 'Aucun écart à recompter — tous les comptages saisis sont alignés avec le théorique.'
        : 'Aucun base product à compter.')
      return
    }
    rows = rows.sort((a:any, b:any) => String(a.base_code).localeCompare(String(b.base_code)))

    const headers = ['Base SKU', 'Description', 'Théorique', 'Compté', 'Écart', 'Notes']
    const csvRows = rows.map((c:any) => {
      const theo = Number(c.total_theorique_net||0)
      const compte = mode === 'ecarts' && c.total_compte != null ? c.total_compte : ''
      const ecart = mode === 'ecarts' && c.total_ecart != null ? c.total_ecart : ''
      return [
        c.base_code,
        (c.description||'').replace(/"/g,'""'),
        theo > 0 ? theo : '',
        compte,
        ecart,
        ''
      ].map(v => `"${v}"`).join(',')
    })
    // Ligne titre + colonnes vides faciles à imprimer
    const titre = mode === 'ecarts'
      ? `Recomptage écarts — Audit ${openAudit.label||openAudit.mois} — ${rows.length} SKU à recompter`
      : `Feuille de comptage — Audit ${openAudit.label||openAudit.mois} — ${rows.length} SKU`
    const csv = [
      `"${titre}"`,
      `"Date impression : ${new Date().toLocaleDateString('fr-CA')} — Compté par : ___________________"`,
      '',
      headers.map(h => `"${h}"`).join(','),
      ...csvRows
    ].join('\n')
    const blob = new Blob(['\ufeff' + csv], {type:'text/csv;charset=utf-8'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = mode === 'ecarts'
      ? `recomptage_ecarts_${openAudit.mois}_${openAudit.id}.csv`
      : `feuille_comptage_${openAudit.mois}_${openAudit.id}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function toggleWatchlist(amazon_sku: string, currently: boolean) {
    try {
      await fetch('/api/amazon/watchlist', {
        method: currently ? 'DELETE' : 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ amazon_sku })
      })
      await charger()
    } catch {}
  }

  async function reconcilierRemboursements(silencieux: boolean = false) {
    try {
      const r = await fetch('/api/amazon/reconcile', { method: 'POST' })
      const j = await r.json()
      if (j.success) {
        if (!silencieux || j.matched > 0) {
          setImportLog(l => [...l, `🔗 Réconciliation : ${j.matched}/${j.total_reimbursements} remboursements attribués • ${j.unmatched} orphelins`])
        }
        await charger()
        setDetailCache({})  // force reload settlement details
      } else if (!silencieux) {
        setImportLog(l => [...l, `❌ Réconciliation : ${j.erreur || 'erreur'}`])
      }
    } catch (e:any) {
      if (!silencieux) setImportLog(l => [...l, `❌ Réconciliation : ${e.message}`])
    }
  }

  async function autoResolve(silencieux: boolean = false) {
    try {
      const r = await fetch('/api/amazon/sku-mapping/auto-resolve', { method: 'POST' })
      const j = await r.json()
      if (j.success && j.resolved > 0) {
        setImportLog(l => [...l, `🔁 Auto-résolution : ${j.resolved}/${j.total_unresolved} SKU mappés automatiquement (≥95%)`])
        await charger()
      } else if (!silencieux) {
        setImportLog(l => [...l, `🔁 Auto-résolution : ${j.message || 'aucun nouveau match'}`])
      }
    } catch (e:any) {
      if (!silencieux) setImportLog(l => [...l, `❌ Auto-résolution : ${e.message}`])
    }
  }

  useEffect(() => { charger(); chargerClosureList(); chargerAudits() }, [])
  // Lance l'auto-résolution dès qu'on ouvre la vue mapping (silencieux si rien à faire)
  useEffect(() => {
    if (vue === 'mapping' && unresolved.length > 0) autoResolve(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vue])

  async function syncTraction() {
    setSyncing(true)
    setImportLog(l => [...l, '🔄 Synchronisation du flux Traction...'])
    try {
      const r = await fetch('/api/amazon/sync-traction', { method: 'POST' })
      const j = await r.json()
      if (j.success) {
        const parts = Object.entries(j.par_ligne || {}).map(([k,v]:any) => `${k}=${v}`).join(', ')
        setImportLog(l => [...l, `✅ Traction synchronisé : ${j.lignes} lignes (${parts})`])
      } else {
        setImportLog(l => [...l, `❌ Erreur Traction : ${j.erreur || 'inconnue'}`])
      }
      await charger()
    } catch (e:any) {
      setImportLog(l => [...l, `❌ Exception Traction : ${e.message}`])
    }
    setSyncing(false)
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setImporting(true)
    for (const file of Array.from(files)) {
      setImportLog(l => [...l, `📥 Import ${file.name}...`])
      try {
        const fd = new FormData()
        fd.append('file', file)
        const r = await fetch('/api/amazon/import', { method: 'POST', body: fd })
        const j = await r.json()
        if (j.success) {
          let msg = `✅ ${file.name} : type=${j.type}`
          if (j.settlement_id) msg += ` settlement=${j.settlement_id}`
          if (j.transactions_inserted != null) msg += ` • ${j.transactions_inserted} transactions`
          if (j.rows_inserted != null) msg += ` • ${j.rows_inserted} lignes`
          if (j.snapshot_date) msg += ` snapshot=${j.snapshot_date}`
          if (j.unresolved_sku) msg += ` • ${j.unresolved_sku} SKU non résolus`
          if (j.duplicates_deduped) msg += ` • ${j.duplicates_deduped} doublons dédupliqués`
          if (j.traction_sync?.success) msg += ` • 🔄 ${j.traction_sync.lignes} lignes Traction`
          if (j.audit?.success) {
            if (j.audit.skipped) msg += ` • 🔒 Audit conservé (existant pour ce settlement)`
            else if (j.audit.audit?.id) msg += ` • 🔒 Audit auto créé (id ${j.audit.audit.id}, ${j.audit.total} base products)`
          }
          setImportLog(l => [...l, msg])
        } else {
          setImportLog(l => [...l, `❌ ${file.name} : ${j.erreur || 'erreur inconnue'}`])
        }
      } catch (e:any) {
        setImportLog(l => [...l, `❌ ${file.name} : ${e.message}`])
      }
    }
    setImporting(false)
    await charger()
    // Auto-réconciliation des remboursements après tout import
    await reconcilierRemboursements(true)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function validerMapping(amazon_sku: string) {
    const traction_code = (mappingInput[amazon_sku] || '').trim()
    if (!traction_code) { alert('Entrez un code Traction'); return }
    try {
      const r = await fetch('/api/amazon/sku-mapping', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ amazon_sku, traction_code })
      })
      const j = await r.json()
      if (j.success) {
        setMappingInput(prev => { const n = {...prev}; delete n[amazon_sku]; return n })
        await charger()
      } else {
        alert(j.erreur || 'Erreur')
      }
    } catch (e:any) { alert(e.message) }
  }

  async function supprimerMapping(amazon_sku: string) {
    if (!confirm(`Supprimer le mapping ${amazon_sku} ?`)) return
    await fetch('/api/amazon/sku-mapping', {
      method: 'DELETE',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ amazon_sku })
    })
    await charger()
  }

  const counts = data.counts || {}
  const settlements = data.settlements || []

  // Avertissement audit mensuel manquant — visible à partir du 1er jour ouvrable du mois
  const moisCourant = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })()
  const auditMoisCourant = audits.find((a: any) => a.mois === moisCourant)
  const showAuditWarning = (() => {
    if (auditMoisCourant) return false
    const today = new Date()
    let premier = new Date(today.getFullYear(), today.getMonth(), 1)
    while (premier.getDay() === 0 || premier.getDay() === 6) premier.setDate(premier.getDate() + 1)
    today.setHours(0, 0, 0, 0)
    return today >= premier
  })()

  async function demarrerAuditMois() {
    setNewAuditMois(moisCourant)
    setCreatingAudit(true)
    try {
      const r = await fetch('/api/amazon/audits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mois: moisCourant,
          label: `Audit mensuel ${moisCourant}`,
          started_by: profil?.email || profil?.nom || 'Inconnu',
        }),
      })
      const j = await r.json()
      if (j.success) {
        await chargerAudits()
        setVue('audit')
        if (j.audit?.id) await chargerAuditDetail(j.audit.id)
      } else {
        alert(j.erreur || 'Erreur')
      }
    } catch (e: any) { alert(e.message) }
    setCreatingAudit(false)
  }

  return (
    <div>
      {/* Header */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:10,marginBottom:12}}>
        <div>
          <div style={{fontSize:20,fontWeight:900}}>📦 Amazon</div>
          <div style={{fontSize:11,color:sub,marginTop:2}}>Phase 1 — Import, synchronisation Traction, mapping SKU</div>
        </div>
        <button onClick={charger} disabled={loading} style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'7px 12px',fontWeight:700,cursor:'pointer',fontSize:12}}>
          {loading?'⏳':'🔄 Actualiser'}
        </button>
      </div>

      {/* Avertissement audit mensuel manquant */}
      {showAuditWarning && (
        <div style={{background:dark?'#2b2411':'#fff8e1',border:`1px solid ${C.yellow}`,borderRadius:10,padding:'12px 16px',marginBottom:12,display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
          <div style={{fontSize:24}}>⚠️</div>
          <div style={{flex:1,minWidth:200}}>
            <div style={{fontSize:13,fontWeight:800,color:C.yellow}}>Audit physique mensuel à faire</div>
            <div style={{fontSize:11,color:sub,marginTop:2,lineHeight:1.5}}>
              Aucun audit créé pour <strong>{moisCourant}</strong>. L'audit mensuel doit être démarré le 1<sup>er</sup> jour ouvrable du mois (compte tout le stock <strong>AMA</strong> dans Traction).
            </div>
          </div>
          <button onClick={demarrerAuditMois} disabled={creatingAudit}
            style={{background:creatingAudit?bdr:C.yellow,color:'#fff',border:'none',borderRadius:8,padding:'10px 16px',fontWeight:800,cursor:creatingAudit?'default':'pointer',fontSize:12,whiteSpace:'nowrap'}}>
            {creatingAudit ? '⏳ Création...' : `📋 Démarrer l'audit ${moisCourant}`}
          </button>
        </div>
      )}

      {/* Stats cards */}
      <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(6,1fr)',gap:8,marginBottom:12}}>
        <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
          <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Lignes Traction</div>
          <div style={{fontSize:20,fontWeight:900,color:C.blue}}>{counts.traction_amazon_lignes||0}</div>
        </div>
        <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.green}`}}>
          <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Settlements</div>
          <div style={{fontSize:20,fontWeight:900,color:C.green}}>{settlements.length}</div>
        </div>
        <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
          <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Transactions</div>
          <div style={{fontSize:20,fontWeight:900,color:C.blue}}>{counts.transactions||0}</div>
        </div>
        <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.yellow}`}}>
          <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>FBA Inv.</div>
          <div style={{fontSize:20,fontWeight:900,color:C.yellow}}>{counts.fba_inventory||0}</div>
        </div>
        <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.green}`}}>
          <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Rembours.</div>
          <div style={{fontSize:20,fontWeight:900,color:C.green}}>{counts.reimbursements||0}</div>
        </div>
        <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.red}`}}>
          <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>SKU non mappés</div>
          <div style={{fontSize:20,fontWeight:900,color:C.red}}>{unresolved.length}</div>
        </div>
      </div>

      {/* Sous-onglets — Fermeture en premier (vue principale simplifiée) */}
      <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
        <button onClick={()=>{setVue('fermeture'); chargerClosureList()}}
          style={{padding:'8px 14px',borderRadius:18,border:`2px solid ${vue==='fermeture'?C.green:bdr}`,background:vue==='fermeture'?(dark?'#0d2a18':'#e6f4ea'):'transparent',color:vue==='fermeture'?C.green:sub,fontWeight:800,cursor:'pointer',fontSize:12}}>
          📋 Fermeture settlements
        </button>
        <button onClick={()=>setVue('import')}
          style={{padding:'8px 14px',borderRadius:18,border:`2px solid ${vue==='import'?C.blue:bdr}`,background:vue==='import'?(dark?'#1a233a':'#e8f0fe'):'transparent',color:vue==='import'?C.blue:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
          📥 Import
        </button>
        <button onClick={()=>{setVue('multimapping'); chargerMultimapping()}}
          style={{padding:'8px 14px',borderRadius:18,border:`2px solid ${vue==='multimapping'?C.blue:bdr}`,background:vue==='multimapping'?(dark?'#1a233a':'#e8f0fe'):'transparent',color:vue==='multimapping'?C.blue:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
          🔗 Multi-mapping SKU
        </button>
        <button onClick={()=>{setVue('profitabilite'); chargerCoutsTransport(); if(closureList[0]) chargerProfitabilite(closureList[0].settlement_id)}}
          style={{padding:'8px 14px',borderRadius:18,border:`2px solid ${vue==='profitabilite'?C.green:bdr}`,background:vue==='profitabilite'?(dark?'#0d2a18':'#e6f4ea'):'transparent',color:vue==='profitabilite'?C.green:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
          💰 Profitabilité
        </button>
        <button onClick={()=>{setVue('forecast'); chargerForecast()}}
          style={{padding:'8px 14px',borderRadius:18,border:`2px solid ${vue==='forecast'?C.blue:bdr}`,background:vue==='forecast'?(dark?'#1a233a':'#e8f0fe'):'transparent',color:vue==='forecast'?C.blue:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
          📈 Prévisionnel
        </button>
        <button onClick={()=>{setVue('unsellable_suivi'); chargerUnsellableSuivi()}}
          style={{padding:'8px 14px',borderRadius:18,border:`2px solid ${vue==='unsellable_suivi'?C.red:bdr}`,background:vue==='unsellable_suivi'?(dark?'#2b1113':'#fce8e6'):'transparent',color:vue==='unsellable_suivi'?C.red:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
          🔥 Suivi unsellable
        </button>
        <button onClick={()=>{setVue('archives'); chargerArchives()}}
          style={{padding:'8px 14px',borderRadius:18,border:`2px solid ${vue==='archives'?sub:bdr}`,background:'transparent',color:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
          🗄 Archives SKU
        </button>
        <div style={{flex:1,minWidth:10}}/>
        <details style={{fontSize:11}}>
          <summary style={{cursor:'pointer',color:sub,padding:'8px 10px'}}>▾ Vues avancées</summary>
          <div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:6}}>
            <button onClick={()=>setVue('settlements')} style={{padding:'5px 10px',borderRadius:12,border:`1px solid ${bdr}`,background:vue==='settlements'?(dark?'#0d2a18':'#e6f4ea'):'transparent',color:sub,cursor:'pointer',fontSize:11}}>💰 Settlements ({settlementsList.length})</button>
            <button onClick={()=>setVue('inventaire')} style={{padding:'5px 10px',borderRadius:12,border:`1px solid ${bdr}`,background:'transparent',color:sub,cursor:'pointer',fontSize:11}}>📊 Écarts inv. ({inventaireGaps.totals?.nb_ecart||0})</button>
            <button onClick={()=>setVue('consolide')} style={{padding:'5px 10px',borderRadius:12,border:`1px solid ${bdr}`,background:'transparent',color:sub,cursor:'pointer',fontSize:11}}>🏭 Consolidé ({consolide.totals?.nb_base_products||0})</button>
            <button onClick={()=>{setVue('audit'); if(!audits.length) chargerAudits()}} style={{padding:'5px 10px',borderRadius:12,border:`1px solid ${bdr}`,background:'transparent',color:sub,cursor:'pointer',fontSize:11}}>📋 Audits ({audits.length})</button>
            <button onClick={()=>setVue('mapping')} style={{padding:'5px 10px',borderRadius:12,border:`1px solid ${bdr}`,background:'transparent',color:sub,cursor:'pointer',fontSize:11}}>🗺 SKU non mappés ({unresolved.length})</button>
          </div>
        </details>
      </div>

      {/* ═══ Vue FERMETURE (principale) ═══ */}
      {vue === 'fermeture' && !closureActif && (() => {
        const ouverts = closureList.filter(s => !s.closed_at)
        const fermes = closureList.filter(s => s.closed_at)
        const fmtDate = (d: string | null) => d ? String(d).split('T')[0] : '—'
        const fmt$ = (n: number) => `${Number(n).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} $`
        return (
          <div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:12,padding:'14px 16px',marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:800,marginBottom:6}}>📋 Fermeture de settlement — Workflow en 6 étapes</div>
              <div style={{fontSize:11,color:sub,lineHeight:1.6}}>
                Chaque settlement Amazon = une période à fermer. Séquentiellement :
                <strong> 1️⃣ LAUTOPAK → 2️⃣ Reimbursements → 3️⃣ Unsellable → 4️⃣ Ajustements Traction → 5️⃣ Audit physique + balance → 6️⃣ Rapport comptable</strong>.
                Tant qu'une étape n'est pas verte, la suivante est verrouillée. Balance bloquante si écart &gt; 1 unité.
              </div>
            </div>

            {/* Ouverts en haut */}
            <div style={{background:card,border:`2px solid ${C.yellow}`,borderRadius:10,overflow:'hidden',marginBottom:12}}>
              <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,fontSize:12,fontWeight:800,color:C.yellow}}>
                ⏳ Settlements ouverts ({ouverts.length})
              </div>
              {ouverts.length === 0 ? (
                <div style={{padding:20,textAlign:'center',color:sub,fontSize:12}}>Aucun settlement ouvert</div>
              ) : (
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead><tr style={{background:thBg}}>
                    <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Settlement</th>
                    <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Période</th>
                    <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Dépôt</th>
                    <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Montant</th>
                    <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>LAUTOPAK</th>
                    <th style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`}}></th>
                  </tr></thead>
                  <tbody>
                    {ouverts.map((s:any) => (
                      <tr key={s.settlement_id} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:11,fontWeight:700}}>{s.settlement_id}</td>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>{fmtDate(s.settlement_start)} → {fmtDate(s.settlement_end)}</td>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:11}}>{fmtDate(s.deposit_date)}</td>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700}}>{fmt$(s.total_amount)}</td>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>{s.lautopak_invoice_ref || <span style={{color:C.red}}>—</span>}</td>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',whiteSpace:'nowrap'}}>
                          <button onClick={()=>chargerClosureDetail(s.settlement_id)}
                            style={{background:C.blue,color:'#fff',border:'none',borderRadius:6,padding:'5px 10px',fontWeight:700,cursor:'pointer',fontSize:11,marginRight:4}}>
                            Ouvrir →
                          </button>
                          <button onClick={()=>supprimerSettlement(s.settlement_id)}
                            title="Supprimer ce settlement"
                            style={{background:'transparent',border:`1px solid ${C.red}`,color:C.red,borderRadius:6,padding:'4px 8px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                            🗑
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Fermés */}
            {fermes.length > 0 && (
              <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden'}}>
                <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,fontSize:12,fontWeight:800,color:C.green}}>
                  ✅ Settlements fermés ({fermes.length})
                </div>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead><tr style={{background:thBg}}>
                    <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Settlement</th>
                    <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Période</th>
                    <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Montant</th>
                    <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>LAUTOPAK</th>
                    <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Fermé</th>
                    <th style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`}}></th>
                  </tr></thead>
                  <tbody>
                    {fermes.map((s:any) => (
                      <tr key={s.settlement_id} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:11}}>{s.settlement_id}</td>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub}}>{fmtDate(s.settlement_start)} → {fmtDate(s.settlement_end)}</td>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmt$(s.total_amount)}</td>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>{s.lautopak_invoice_ref || '—'}</td>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontSize:10,color:sub}}>{fmtDate(s.closed_at)} par {s.closed_by||'?'}</td>
                        <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',whiteSpace:'nowrap'}}>
                          <button onClick={()=>chargerRapport(s.settlement_id)}
                            style={{background:'transparent',border:`1px solid ${C.blue}`,color:C.blue,borderRadius:6,padding:'4px 8px',fontWeight:700,cursor:'pointer',fontSize:10,marginRight:4}}>
                            📊 Rapport
                          </button>
                          <button onClick={()=>chargerClosureDetail(s.settlement_id)}
                            style={{background:'transparent',border:`1px solid ${sub}`,color:sub,borderRadius:6,padding:'4px 8px',fontWeight:700,cursor:'pointer',fontSize:10,marginRight:4}}>
                            Voir
                          </button>
                          <button onClick={()=>supprimerSettlement(s.settlement_id)}
                            title="Supprimer ce settlement"
                            style={{background:'transparent',border:`1px solid ${C.red}`,color:C.red,borderRadius:6,padding:'4px 8px',fontWeight:700,cursor:'pointer',fontSize:10}}>
                            🗑
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })()}

      {/* ═══ Vue FERMETURE — détail d'un settlement (6 étapes) ═══ */}
      {vue === 'fermeture' && closureActif && closureDetail && (() => {
        const s = closureDetail.settlement
        const steps = closureDetail.steps || []
        const fmtDate = (d: string | null) => d ? String(d).split('T')[0] : '—'
        const fmt$ = (n: number) => `${Number(n).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} $`
        const stepIcon = (st: string) => st==='done' ? '✅' : st==='action' ? '⏳' : '🔒'
        const stepColor = (st: string) => st==='done' ? C.green : st==='action' ? C.yellow : sub
        const stepExplications: Record<string, { quoi: string; comment: string; valide: string }> = {
          '1_lautopak': {
            quoi: "Créer une facture LAUTOPAK pour les ventes Amazon du settlement (Orders Principal brut = Frais produit du relevé). En créant la facture dans LAUTOPAK, l'inventaire LAUTOPAK décrémente automatiquement les unités vendues.",
            comment: "1) Clique 🧾 Voir lignes à facturer pour obtenir la liste SKU × qté × prix. 2) Vérifie avec 🧾 Rapprochement relevé que ton TSV matche ton relevé papier. 3) Clique 'Saisir n° LAUTOPAK' pour ouvrir la vue Settlements et inscrire le n° de facture + la date.",
            valide: "AUTO — passe verte dès que lautopak_invoice_ref + lautopak_invoice_date sont remplis.",
          },
          '2_reimbursements': {
            quoi: "Traiter les pièces remboursées par Amazon (Lost/Damaged/CustomerReturn cash) en créant une FACTURE LAUTOPAK SÉPARÉE qui liste ces pièces. Cette facture décrémente l'inventaire LAUTOPAK pour les unités physiquement perdues. Les reimbursements du CSV doivent aussi matcher les lignes 'FBA Inventory Reimbursement' du payments TSV.",
            comment: "1) Clique 🧾 Voir lignes à facturer pour obtenir la liste (SKU × qté × prix cost = total reimbursement). 2) Dans LAUTOPAK, crée une 2e facture pour ces pièces. 3) Reviens ici, saisis le n° + la date → ✓ Enregistrer. 4) Coche ensuite chaque ligne dans le tableau au fur et à mesure.",
            valide: "AUTO — passe verte quand : (a) nb reimbursements CSV = nb lignes payments, ET (b) s'il y a des cash reimbs, le n° de facture LAUTOPAK reimb est saisi.",
          },
          '3_unsellable': {
            quoi: "Traiter chaque SKU avec afn_unsellable > 0 chez Amazon (produits endommagés que Amazon te retient). Soit tu demandes un removal, soit tu fais une réclamation.",
            comment: "1) Regarde la liste sous l'étape. 2) Pour chaque SKU, va dans Amazon Seller Central → Inventory → Unsellable, demande un removal ou ouvre un case. 3) Quand tout est initié, clique ✓ Valider l'étape.",
            valide: "MANUEL — clique ✓ Valider l'étape.",
          },
          '4_ajustements': {
            quoi: "Confirmer que tu as passé DANS LAUTOPAK toutes les décrémentations de stock liées aux reimbursements cash (listés à l'étape 2). L'unité physique n'existe plus, l'inventaire LAUTOPAK doit le refléter.",
            comment: "1) Retourne à l'étape 2, coche chaque reimbursement quand tu as fait l'ajustement dans LAUTOPAK. 2) Tu peux suivre le rapport final section 3b pour la liste complète. 3) Quand tu as tout fait, clique ✓ Valider l'étape ici.",
            valide: "MANUEL — clique ✓ Valider l'étape.",
          },
          '5_audit': {
            quoi: "Audit physique mensuel : compter le stock chez Mathias (FBM prêt à expédier + Surplus HUB + à tagger), comparer à ce que dit la ligne AMA Traction + ce qu'Amazon dit avoir au FBA. Équation : Total AMA Traction = Chez Amazon FBA + FBM Mathias + Surplus HUB Mathias. Bloquant si écart > 1 unité.",
            comment: "1) Clique 'Ouvrir l'audit →'. 2) Compte physiquement : champ FBM (chez Mathias prêt à expédier) + champ HUB (surplus chez Mathias, inclut le sans-préfixe à tagger). 3) La colonne Total compté s'ajuste en live et affiche Δ en rouge si écart. 4) Finalise quand 100% compté et balance OK.",
            valide: "AUTO — passe verte quand audit finalisé + 100% compté + balance OK (écart ≤ 1 sur tous les produits).",
          },
          '6_rapport': {
            quoi: "Valider le rapport comptable final imprimable. Ce PDF contient tout : totaux financiers, flux par type, remboursements ligne-par-ligne, ajustements d'inventaire avec justificatif, unsellable, n° facture LAUTOPAK, signature comptable.",
            comment: "1) Clique 📊 Voir rapport. 2) Vérifie que les totaux ont du sens (profits nets = dépôt bancaire Amazon, ajustements = ce que tu as passé dans LAUTOPAK). 3) Imprime / PDF pour ta comptable si besoin. 4) Reviens ici et clique ✓ Valider l'étape.",
            valide: "MANUEL — clique ✓ Valider l'étape.",
          },
        }
        return (
          <div>
            {/* Header settlement */}
            <div style={{background:card,border:`2px solid ${closureDetail.is_closed?C.green:C.yellow}`,borderRadius:12,padding:'14px 16px',marginBottom:12,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10}}>
              <div>
                <div style={{fontSize:11,color:sub,fontWeight:700,textTransform:'uppercase'}}>Settlement</div>
                <div style={{fontSize:15,fontWeight:900,fontFamily:'monospace'}}>{s.settlement_id}</div>
                <div style={{fontSize:12,color:sub,marginTop:2}}>
                  {fmtDate(s.settlement_start)} → {fmtDate(s.settlement_end)} • Dépôt {fmtDate(s.deposit_date)} • <strong style={{color:C.blue}}>{fmt$(s.total_amount)}</strong>
                  {s.lautopak_invoice_ref && <> • 🧾 LAUTOPAK <strong>{s.lautopak_invoice_ref}</strong></>}
                  {closureDetail.is_closed && <> • <span style={{color:C.green,fontWeight:700}}>🔒 Fermé {fmtDate(s.closed_at)} par {s.closed_by}</span></>}
                </div>
              </div>
              <div style={{display:'flex',gap:8}}>
                <button onClick={()=>{setClosureActif(null); setClosureDetail(null)}}
                  style={{background:'transparent',border:`1px solid ${bdr}`,borderRadius:8,padding:'8px 12px',fontWeight:700,cursor:'pointer',fontSize:12,color:sub}}>
                  ← Liste
                </button>
                <button onClick={()=>chargerReleveMatch(s.settlement_id)}
                  style={{background:C.yellow,color:'#fff',border:'none',borderRadius:8,padding:'8px 12px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                  🧾 Rapprochement relevé
                </button>
                {!closureDetail.is_closed && closureDetail.can_close && (
                  <button onClick={()=>{if(confirm('Fermer définitivement ce settlement ?')) validerEtape(s.settlement_id,'close')}}
                    style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:800,cursor:'pointer',fontSize:12}}>
                    🔒 Fermer le settlement
                  </button>
                )}
                {closureDetail.is_closed && (
                  <button onClick={()=>{if(confirm('Rouvrir ce settlement ?')) validerEtape(s.settlement_id,'reopen')}}
                    style={{background:C.yellow,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                    ↩ Rouvrir
                  </button>
                )}
                <button onClick={()=>supprimerSettlement(s.settlement_id)}
                  title="Supprimer ce settlement complet"
                  style={{background:'transparent',border:`1px solid ${C.red}`,color:C.red,borderRadius:8,padding:'8px 12px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                  🗑 Supprimer
                </button>
              </div>
            </div>

            {/* ╔══════════════════════════════════════════════════════════╗
                NOUVEAU WORKFLOW v2 — 4 documents LAUTOPAK + balance auto
                ╚══════════════════════════════════════════════════════════╝ */}
            {lautopakDocs && lautopakDocs.docs && (() => {
              const d = lautopakDocs
              const docLabels: Record<string, { icon: string; titre: string; aide: string; couleur: string }> = {
                'ventes':              { icon: '📦', titre: 'Facture VENTES',           aide: 'Sortie de stock × prix de vente', couleur: C.blue },
                'note_credit_retours': { icon: '↩️', titre: 'Note crédit RETOURS sellable', aide: 'Unités revenues en bon état au FBA', couleur: C.green },
                'note_credit_pertes':  { icon: '💸', titre: 'Note crédit PERTES/DOMMAGES', aide: 'Unités définitivement perdues (cash $)', couleur: C.red },
                'ajust_audit':         { icon: '⚖️', titre: 'Ajustement INVENTAIRE',    aide: 'Écarts d\'audit physique AMA + FBM',  couleur: C.yellow },
              }
              const tousSaisis = d.docs.every((doc: any) => doc.lignes.length === 0 || doc.numero_facture)
              return (
                <div style={{background:card,border:`2px solid ${d.balance_ok?C.green:C.yellow}`,borderRadius:12,padding:14,marginBottom:14}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10,flexWrap:'wrap',gap:8}}>
                    <div style={{flex:1,minWidth:200}}>
                      <div style={{fontSize:14,fontWeight:900}}>📑 Documents LAUTOPAK à émettre (workflow v2)</div>
                      <div style={{fontSize:11,color:sub,marginTop:2,lineHeight:1.5,maxWidth:680}}>
                        Saisis le n° de chaque facture / note de crédit que tu as créée dans LAUTOPAK pour ce settlement.
                        Tout ce qui touche à une <strong>quantité d'inventaire</strong> passe ici.
                        Le reste (commissions, frais FBA, pub…) va dans le compte agrégé « Coûts Amazon » au rapport final.
                      </div>
                    </div>
                    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                      <button onClick={()=>chargerRapport(s.settlement_id)}
                        title="Ouvrir le rapport comptable imprimable (PDF + Excel)"
                        style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'8px 12px',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                        📊 Voir rapport
                      </button>
                      <button onClick={()=>chargerClosureDetail(s.settlement_id)} disabled={closureLoading}
                        title="Recalculer les 4 documents (utile après ajout d'un multi-mapping ou modification d'un audit FBM)"
                        style={{background:closureLoading?bdr:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'8px 12px',fontWeight:700,cursor:closureLoading?'default':'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                        {closureLoading ? '⏳ Calcul...' : '🔄 Recalculer'}
                      </button>
                    </div>
                  </div>

                  {/* Balance en bandeau — équation cashflow = dépôt bancaire */}
                  <div style={{padding:10,background:dark?'#0d0d0d':'#fafbfc',borderRadius:8,border:`1px solid ${bdr}`,marginBottom:12}}>
                    <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:6}}>Équation comptable (cashflow)</div>
                    <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(5,1fr)',gap:8}}>
                      <div>
                        <div style={{fontSize:9,fontWeight:700,color:sub}}>Cashflow Doc 1+2+3</div>
                        <div style={{fontSize:14,fontWeight:900,color:C.blue}}>{fmt$(d.cashflow_docs?.total||0)}</div>
                      </div>
                      <div style={{fontSize:18,fontWeight:900,color:sub,textAlign:'center',alignSelf:'center'}}>+</div>
                      <div>
                        <div style={{fontSize:9,fontWeight:700,color:sub}}>Coûts Amazon</div>
                        <div style={{fontSize:14,fontWeight:900,color:d.total_couts_amazon<0?C.red:C.green}}>{fmt$(d.total_couts_amazon||0)}</div>
                      </div>
                      <div style={{fontSize:18,fontWeight:900,color:sub,textAlign:'center',alignSelf:'center'}}>=</div>
                      <div>
                        <div style={{fontSize:9,fontWeight:700,color:sub}}>Dépôt bancaire</div>
                        <div style={{fontSize:14,fontWeight:900,color:d.balance_ok?C.green:C.red}}>
                          {fmt$(d.balance_settlement||0)} {d.balance_ok ? '✓' : `⚠ ${fmt$(d.ecart_balance||0)}`}
                        </div>
                      </div>
                    </div>
                    <div style={{fontSize:10,color:sub,marginTop:6,fontStyle:'italic'}}>
                      Doc 4 (Ajust audit) = mouvement comptable pur, hors cashflow.
                      Net stock LAUTOPAK total (4 docs) = <strong>{fmt$(d.net_lautopak||0)}</strong>
                    </div>
                  </div>

                  {/* 4 cartes documents */}
                  <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:10}}>
                    {d.docs.map((doc: any) => {
                      const cfg = docLabels[doc.doc_type] || { icon:'📄', titre:doc.label, aide:'', couleur:sub }
                      const inputState = docInputs[doc.doc_type] || {}
                      const numero = inputState.numero !== undefined ? inputState.numero : (doc.numero_facture || '')
                      const dateF = inputState.date !== undefined ? inputState.date : (doc.date_facture ? String(doc.date_facture).split('T')[0] : '')
                      const isVide = doc.lignes.length === 0 || Math.abs(doc.total) < 0.01
                      const isSaisi = !!doc.numero_facture
                      const colorBordure = isVide ? bdr : isSaisi ? C.green : cfg.couleur
                      return (
                        <div key={doc.doc_type} style={{background:dark?'#0d0d0d':'#fff',border:`2px solid ${colorBordure}`,borderRadius:10,padding:'12px 14px'}}>
                          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8}}>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{fontSize:13,fontWeight:800,color:cfg.couleur}}>{cfg.icon} {cfg.titre}</div>
                              <div style={{fontSize:10,color:sub,marginTop:2,lineHeight:1.4}}>{cfg.aide}</div>
                              <div style={{fontSize:11,color:sub,marginTop:4}}>
                                <strong style={{color:Math.abs(doc.total)<0.01?sub:doc.total<0?C.red:C.blue,fontSize:14}}>{fmt$(doc.total)}</strong>
                                {' • '}
                                {isVide
                                  ? <span style={{color:sub}}>aucune ligne</span>
                                  : <button onClick={()=>setDocDetailModal({doc_type:doc.doc_type})} style={{background:'transparent',border:'none',color:C.blue,fontWeight:700,cursor:'pointer',fontSize:11,padding:0,textDecoration:'underline'}}>
                                      voir {doc.lignes.length} ligne{doc.lignes.length>1?'s':''}
                                    </button>
                                }
                              </div>
                            </div>
                            {isSaisi && <div style={{background:C.green+'22',color:C.green,padding:'2px 8px',borderRadius:6,fontSize:10,fontWeight:700,whiteSpace:'nowrap'}}>✓ saisi</div>}
                          </div>

                          {!isVide && !closureDetail.is_closed && (
                            <div style={{display:'grid',gridTemplateColumns:'2fr 1fr auto',gap:6,marginTop:10}}>
                              <input value={numero} placeholder="N° facture LAUTOPAK"
                                onChange={e=>setDocInputs(p=>({...p,[doc.doc_type]:{...p[doc.doc_type],numero:e.target.value}}))}
                                style={{...S,fontSize:12,padding:'7px 10px',fontFamily:'monospace'}}/>
                              <input type="date" value={dateF}
                                onChange={e=>setDocInputs(p=>({...p,[doc.doc_type]:{...p[doc.doc_type],date:e.target.value}}))}
                                style={{...S,fontSize:12,padding:'7px 10px'}}/>
                              <button
                                onClick={()=>saisirDocLautopak(s.settlement_id, doc.doc_type, { numero_facture: numero || undefined, date_facture: dateF || undefined, montant_total: doc.total })}
                                disabled={!numero || !dateF}
                                style={{background:(!numero||!dateF)?bdr:C.green,color:'#fff',border:'none',borderRadius:6,padding:'7px 12px',fontWeight:700,cursor:(!numero||!dateF)?'default':'pointer',fontSize:11,whiteSpace:'nowrap'}}>
                                ✓ Enregistrer
                              </button>
                            </div>
                          )}
                          {isSaisi && doc.saisi_le && (
                            <div style={{fontSize:10,color:sub,marginTop:6,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                              <span>📅 {fmtDate(doc.date_facture)} • saisi par {doc.saisi_par}</span>
                              {!closureDetail.is_closed && (
                                <button onClick={()=>effacerDocLautopak(s.settlement_id, doc.doc_type)}
                                  style={{background:'transparent',border:'none',color:C.red,fontSize:10,fontWeight:700,cursor:'pointer',padding:0,textDecoration:'underline'}}>
                                  effacer
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* Détail Coûts Amazon — 3 sections identiques au relevé papier */}
                  <details style={{marginTop:10,fontSize:11}}>
                    <summary style={{cursor:'pointer',color:sub,padding:'6px 0',fontWeight:700}}>
                      ▾ Détail des « Coût des ventes Amazon » (compte agrégé, pas de stock — {fmt$(d.total_couts_amazon||0)})
                    </summary>
                    <div style={{padding:'8px 0',fontSize:11}}>
                      <div style={{fontSize:10,color:sub,marginBottom:6,fontStyle:'italic',lineHeight:1.5}}>
                        Le breakdown reproduit les 3 sections du relevé papier d'Amazon (hors les ventes/remboursements déjà capturés par les Docs 1 et 2 ci-dessus).
                        La <strong>Section C — Dépenses</strong> doit matcher exactement la section « Dépenses » de ton scan papier.
                      </div>
                      {(() => {
                        const ca: any = d.couts_amazon || {}
                        const labelsLignes: Record<string, string> = {
                          'A_ventes_expedition': 'Expédition (Order Shipping)',
                          'A_ventes_taxes_net': 'Taxes net (Tax + MarketplaceFacilitatorTax)',
                          'B_remb_depenses_pos': 'Dépenses remboursées (positifs)',
                          'B_remb_depenses_neg': 'Dépenses remboursées (négatifs)',
                          'B_remb_ventes_frais_produit_non_sellable': 'Ventes remboursées : Frais produit (non sellable)',
                          'B_remb_ventes_expedition': 'Ventes remboursées : Expédition',
                          'C_rabais_promotionnels': 'Rabais promotionnels',
                          'C_frais_fba_stockage': 'Frais Expédié par Amazon — Stockage',
                          'C_frais_fba_autres': 'Frais Expédié par Amazon — Autre (RemovalComplete)',
                          'C_frais_fba_abonnement': 'Frais d\'abonnement',
                          'C_publicite': 'Prix de la publicité',
                          'C_commissions_amazon': 'Commissions Amazon',
                          'C_remboursements_inverses': 'Remboursements inversés (FBA)',
                        }
                        const renderLigne = (key: string, indent = 1) => {
                          if (ca[key] === undefined || Math.abs(Number(ca[key])) < 0.01) return null
                          return (
                            <tr key={key}>
                              <td style={{padding:'3px 8px',paddingLeft:8 + indent*16,borderBottom:`1px solid ${bdr}`,color:sub}}>{labelsLignes[key] || key}</td>
                              <td style={{padding:'3px 8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:Number(ca[key])<0?C.red:C.green,fontFamily:'monospace',fontSize:11}}>{fmt$(Number(ca[key]))}</td>
                            </tr>
                          )
                        }
                        return (
                          <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                            <tbody>
                              {/* Section A */}
                              <tr style={{background:dark?'#0d1829':'#e8f0fe'}}>
                                <td style={{padding:'5px 8px',fontWeight:800,color:C.blue}}>A — VENTES (hors Doc 1 = Order Principal)</td>
                                <td style={{padding:'5px 8px',textAlign:'right',fontWeight:800,color:C.blue,fontFamily:'monospace'}}>{fmt$(Number(ca.A_TOTAL_section_A||0))}</td>
                              </tr>
                              {renderLigne('A_ventes_expedition')}
                              {renderLigne('A_ventes_taxes_net')}
                              {/* Section B */}
                              <tr style={{background:dark?'#2b2411':'#fff8e1'}}>
                                <td style={{padding:'5px 8px',fontWeight:800,color:C.yellow}}>B — REMBOURSEMENTS (hors Doc 2 cashflow)</td>
                                <td style={{padding:'5px 8px',textAlign:'right',fontWeight:800,color:C.yellow,fontFamily:'monospace'}}>{fmt$(Number(ca.B_TOTAL_section_B||0))}</td>
                              </tr>
                              {renderLigne('B_remb_depenses_pos')}
                              {renderLigne('B_remb_depenses_neg')}
                              {renderLigne('B_remb_ventes_frais_produit_non_sellable')}
                              {renderLigne('B_remb_ventes_expedition')}
                              {/* Section C */}
                              <tr style={{background:dark?'#2b1113':'#fce8e6'}}>
                                <td style={{padding:'5px 8px',fontWeight:800,color:C.red}}>C — DÉPENSES (= scan papier section Dépenses)</td>
                                <td style={{padding:'5px 8px',textAlign:'right',fontWeight:800,color:C.red,fontFamily:'monospace'}}>{fmt$(Number(ca.C_TOTAL_section_C||0))}</td>
                              </tr>
                              {renderLigne('C_rabais_promotionnels')}
                              {renderLigne('C_frais_fba_stockage')}
                              {renderLigne('C_frais_fba_autres')}
                              {renderLigne('C_frais_fba_abonnement')}
                              {renderLigne('C_publicite')}
                              {renderLigne('C_commissions_amazon')}
                              {renderLigne('C_remboursements_inverses')}
                              {/* Non classé */}
                              {ca.Z_autre_non_classe !== undefined && (
                                <tr style={{background:'#fdf6e3'}}>
                                  <td style={{padding:'4px 8px',color:C.yellow,fontWeight:700}}>⚠ Autre / non classé (à investiguer)</td>
                                  <td style={{padding:'4px 8px',textAlign:'right',color:C.yellow,fontWeight:800,fontFamily:'monospace'}}>{fmt$(Number(ca.Z_autre_non_classe))}</td>
                                </tr>
                              )}
                              {/* Grand total */}
                              <tr style={{background:thBg,borderTop:`2px solid ${bdr}`}}>
                                <td style={{padding:'7px 8px',fontWeight:900}}>= TOTAL Coût des ventes Amazon (A + B + C)</td>
                                <td style={{padding:'7px 8px',textAlign:'right',fontWeight:900,color:Number(d.total_couts_amazon)<0?C.red:C.green,fontFamily:'monospace'}}>{fmt$(d.total_couts_amazon||0)}</td>
                              </tr>
                            </tbody>
                          </table>
                        )
                      })()}
                    </div>
                  </details>

                  {tousSaisis && d.balance_ok && (
                    <div style={{marginTop:10,padding:'12px 14px',background:dark?'#0d2a18':'#e6f4ea',border:`2px solid ${C.green}`,borderRadius:8,display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexWrap:'wrap'}}>
                      <div style={{fontSize:12,color:C.green,fontWeight:700,flex:1,minWidth:200}}>
                        ✅ Tous les documents sont saisis et la balance correspond au dépôt bancaire — settlement prêt à fermer.
                      </div>
                      {!closureDetail.is_closed && (
                        <button onClick={()=>{if(confirm('Fermer définitivement ce settlement ? Il passera en lecture seule.')) validerEtape(s.settlement_id,'close')}}
                          style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'10px 18px',fontWeight:800,cursor:'pointer',fontSize:13,whiteSpace:'nowrap'}}>
                          🔒 Fermer le settlement
                        </button>
                      )}
                    </div>
                  )}
                  {closureDetail.is_closed && (
                    <div style={{marginTop:10,padding:'12px 14px',background:dark?'#0d2a18':'#e6f4ea',border:`2px solid ${C.green}`,borderRadius:8,display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexWrap:'wrap'}}>
                      <div style={{fontSize:12,color:C.green,fontWeight:700}}>
                        🔒 Settlement fermé le {fmtDate(s.closed_at)} par {s.closed_by} — lecture seule.
                      </div>
                      <button onClick={()=>{if(confirm('Rouvrir ce settlement ?')) validerEtape(s.settlement_id,'reopen')}}
                        style={{background:'transparent',border:`1px solid ${C.yellow}`,color:C.yellow,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                        ↩ Rouvrir
                      </button>
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Bloc « Audit FBM » — comptage physique obligatoire à chaque settlement */}
            {(() => {
              const settMois = s.settlement_end ? String(s.settlement_end).slice(0,7) : new Date().toISOString().slice(0,7)
              const a = fbmAuditSettlement
              const isClosed = closureDetail.is_closed
              if (!a) {
                return (
                  <div style={{background:card,border:`2px solid ${C.yellow}`,borderRadius:10,padding:'12px 14px',marginBottom:12,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10}}>
                    <div style={{flex:1,minWidth:200}}>
                      <div style={{fontSize:13,fontWeight:800,color:C.yellow}}>📦 Audit FBM physique — à faire pour fermer ce settlement</div>
                      <div style={{fontSize:11,color:sub,marginTop:3,lineHeight:1.5}}>
                        Compte physiquement le stock <strong>FBM (chez Mathias, prêt à expédier)</strong> pour ce cycle de paiement. Les écarts alimentent automatiquement le Doc 4 (Ajust audit) ci-dessus.
                      </div>
                    </div>
                    {!isClosed && (
                      <button onClick={()=>demarrerAuditFbmSettlement(s.settlement_id, settMois)} disabled={creatingFbmAudit}
                        style={{background:creatingFbmAudit?bdr:C.yellow,color:'#fff',border:'none',borderRadius:8,padding:'10px 16px',fontWeight:800,cursor:creatingFbmAudit?'default':'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                        {creatingFbmAudit ? '⏳ Création...' : '📋 Démarrer l\'audit FBM'}
                      </button>
                    )}
                  </div>
                )
              }
              const pct = a.nb_total > 0 ? Math.round((a.nb_comptes/a.nb_total)*100) : 0
              const isFini = a.statut === 'termine'
              const couleur = isFini ? C.green : (pct>0 ? C.blue : C.yellow)
              return (
                <div style={{background:card,border:`2px solid ${couleur}`,borderRadius:10,padding:'12px 14px',marginBottom:12,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10}}>
                  <div style={{flex:1,minWidth:200}}>
                    <div style={{fontSize:13,fontWeight:800,color:couleur}}>📦 Audit FBM physique — {isFini ? '✓ Terminé' : (pct>0?'En cours':'Démarré, à compter')}</div>
                    <div style={{fontSize:11,color:sub,marginTop:3}}>
                      Audit <strong>{a.label}</strong> • {a.nb_comptes||0}/{a.nb_total||0} produits comptés ({pct}%)
                    </div>
                  </div>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    <button onClick={()=>ouvrirAuditFbmSettlement(a.id)}
                      style={{background:couleur,color:'#fff',border:'none',borderRadius:8,padding:'10px 16px',fontWeight:800,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                      {isFini ? '👁 Voir résultat' : '📝 Continuer le comptage'}
                    </button>
                    {!isClosed && !isFini && (
                      <button onClick={()=>nettoyerAuditFbm(a.id, s.settlement_id)}
                        title="Supprime les lignes des SKU sans transaction FBM dans ce settlement (sauf celles déjà comptées)"
                        style={{background:'transparent',border:`1px solid ${C.blue}`,color:C.blue,borderRadius:8,padding:'10px 14px',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                        🧹 Nettoyer (mouvements seulement)
                      </button>
                    )}
                    {!isClosed && !isFini && pct > 0 && (
                      <button onClick={()=>finaliserAuditFbmDepuisSettlement(a.id, s.settlement_id)}
                        title="Marque l'audit comme terminé sans rouvrir la vue audit"
                        style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'10px 16px',fontWeight:800,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                        ✓ Finaliser
                      </button>
                    )}
                    {!isClosed && isFini && (
                      <button onClick={()=>reouvrirAuditFbmDepuisSettlement(a.id, s.settlement_id)}
                        title="Rouvre l'audit pour modifier les comptages"
                        style={{background:'transparent',border:`1px solid ${C.yellow}`,color:C.yellow,borderRadius:8,padding:'10px 14px',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                        ↩ Rouvrir
                      </button>
                    )}
                  </div>
                </div>
              )
            })()}

            {/* Bloc « Audit FBA auto » — comparaison FBA Amazon vs FBA Traction */}
            {fbaComparison && !fbaComparison.erreur_avertissement && (() => {
              const fc = fbaComparison
              const hasEcart = fc.nb_ecarts > 0
              return (
                <div style={{background:card,border:`2px solid ${hasEcart?C.yellow:C.green}`,borderRadius:10,padding:'12px 14px',marginBottom:12}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8,marginBottom:hasEcart?10:0}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:800}}>🤖 Audit FBA auto (comparaison Amazon vs Traction)</div>
                      <div style={{fontSize:11,color:sub,marginTop:2,lineHeight:1.5}}>
                        Snapshot Amazon du <strong>{fc.snapshot_date}</strong> comparé à ce que dit Traction sur les pk_codes FBA-xxx.
                        {' '}{fc.nb_pk_codes_compares} pk_codes comparés, tolérance ±1 unité par produit.
                      </div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      {hasEcart ? (
                        <>
                          <div style={{fontSize:11,color:sub}}>Écarts à investiguer</div>
                          <div style={{fontSize:18,fontWeight:900,color:C.yellow}}>{fc.nb_ecarts} produit{fc.nb_ecarts>1?'s':''}</div>
                          <div style={{fontSize:11,color:C.yellow,fontWeight:700}}>{fmt$(fc.total_ecart_valeur_abs||0)} valeur</div>
                        </>
                      ) : (
                        <div style={{fontSize:14,fontWeight:900,color:C.green}}>✓ Aucun écart</div>
                      )}
                    </div>
                  </div>
                  {hasEcart && (
                    <details>
                      <summary style={{cursor:'pointer',fontSize:11,color:C.blue,fontWeight:700,padding:'4px 0'}}>
                        ▾ Voir le détail des {fc.nb_ecarts} écart{fc.nb_ecarts>1?'s':''}
                      </summary>
                      <div style={{maxHeight:300,overflow:'auto',marginTop:6,border:`1px solid ${bdr}`,borderRadius:6}}>
                        <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                          <thead style={{position:'sticky',top:0,background:thBg,zIndex:1}}>
                            <tr>
                              <th style={{padding:'6px 8px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Pk_code</th>
                              <th style={{padding:'6px 8px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>SKU Amazon</th>
                              <th style={{padding:'6px 8px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Produit</th>
                              <th style={{padding:'6px 8px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Qté Amazon</th>
                              <th style={{padding:'6px 8px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Qté Traction</th>
                              <th style={{padding:'6px 8px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Δ</th>
                              <th style={{padding:'6px 8px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Valeur</th>
                              <th style={{padding:'6px 8px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {fc.ecarts.map((e: any, i: number) => (
                              <tr key={e.pk_code+i} style={{borderBottom:`1px solid ${bdr}`}}>
                                <td style={{padding:'5px 8px',fontFamily:'monospace',fontWeight:700}}>{e.pk_code}</td>
                                <td style={{padding:'5px 8px',fontFamily:'monospace',fontSize:10,color:sub}}>{e.sku_amazon||'—'}</td>
                                <td style={{padding:'5px 8px',fontSize:10,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={e.product_name||''}>{e.product_name||'—'}</td>
                                <td style={{padding:'5px 8px',textAlign:'right'}}>{e.qty_amazon}</td>
                                <td style={{padding:'5px 8px',textAlign:'right'}}>{e.qty_traction}</td>
                                <td style={{padding:'5px 8px',textAlign:'right',fontWeight:800,color:e.ecart_units<0?C.red:C.yellow}}>{e.ecart_units>0?'+':''}{e.ecart_units}</td>
                                <td style={{padding:'5px 8px',textAlign:'right',fontFamily:'monospace',fontWeight:700,color:e.valeur_ecart<0?C.red:C.yellow}}>{fmt$(e.valeur_ecart)}</td>
                                <td style={{padding:'5px 8px',fontSize:10,color:e.ecart_units<0?C.red:sub}}>{e.action_recommandee}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div style={{fontSize:10,color:sub,marginTop:6,lineHeight:1.5,fontStyle:'italic'}}>
                        💡 Δ négatif = Amazon dit avoir <strong>moins</strong> que Traction → unités probablement perdues, à réclamer Amazon (case Seller Central).
                        Δ positif = Amazon dit avoir <strong>plus</strong> que Traction → vérifier qu'aucun pack n'est mal mappé (multi-mapping).
                      </div>
                    </details>
                  )}
                </div>
              )
            })()}

            {/* Bandeau "📁 Fichiers importés" — les 4 fichiers requis pour ce settlement */}
            {closureDetail.fichiers_importes && (() => {
              const f = closureDetail.fichiers_importes
              // Calcul des plages exactes à exporter dans Seller Central
              const settEnd = s.settlement_end ? new Date(s.settlement_end) : new Date()
              const settStart = s.settlement_start ? new Date(s.settlement_start) : new Date()
              const d60avant = new Date(settEnd); d60avant.setDate(d60avant.getDate() - 60)
              const fmtDateFr = (d: Date) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
              const periodeSettlement = `${fmtDateFr(settStart)} → ${fmtDateFr(settEnd)}`
              const periode60j = `${fmtDateFr(d60avant)} → ${fmtDateFr(settEnd)}`

              const card = (label: string, ok: boolean, detail: string, sublabel: string, dates: string) => (
                <div style={{flex:1,minWidth:200,background:ok?(dark?'#0d2a18':'#e6f4ea'):(dark?'#2b1113':'#fce8e6'),border:`2px solid ${ok?C.green:C.red}`,borderRadius:8,padding:'10px 12px'}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>{sublabel}</div>
                  <div style={{fontSize:13,fontWeight:900,color:ok?C.green:C.red,marginTop:2}}>
                    {ok ? '✅ Importé' : '❌ Manquant'}
                  </div>
                  <div style={{fontSize:10,color:sub,marginTop:2}}>{detail}</div>
                  {!ok && (
                    <div style={{marginTop:6,padding:'5px 8px',background:dark?'#1a1a1a':'#fff',border:`1px dashed ${C.yellow}`,borderRadius:5,fontSize:10,color:C.yellow,fontWeight:700,fontFamily:'monospace'}}>
                      📅 {dates}
                    </div>
                  )}
                </div>
              )
              return (
                <div style={{background:dark?'#0f0f0f':'#fafbfc',border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',marginBottom:10}}>
                  <div style={{fontSize:11,fontWeight:800,color:sub,textTransform:'uppercase',marginBottom:8,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8}}>
                    <span>📁 Fichiers requis pour fermer ce settlement</span>
                    <span style={{fontSize:10,color:sub,fontWeight:400,textTransform:'none'}}>Période settlement : <strong style={{color:C.blue}}>{periodeSettlement}</strong></span>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:8}}>
                    {card('Payments', f.payments.imported,
                      f.payments.imported ? `${f.payments.count} transactions` : 'Settlement → Payments → All Statements',
                      '1️⃣ Settlement TSV',
                      periodeSettlement)}
                    {card('FBA Inv.', f.fba_inventory.imported,
                      f.fba_inventory.imported ? `Snapshot ${f.fba_inventory.snapshot_date} • ${f.fba_inventory.count} SKU` : 'Inventory → All Inventory → snapshot du jour',
                      '2️⃣ FBA Inventory',
                      `Snapshot du jour (${fmtDateFr(new Date())})`)}
                    {card('Reimb.', f.reimbursements.imported,
                      f.reimbursements.imported ? `${f.reimbursements.count} remboursements liés` : 'Payments → Reimbursements (60 derniers jours)',
                      '3️⃣ Reimbursements CSV',
                      periode60j)}
                    {card('Customer Returns', !!closureDetail.customer_returns_count,
                      closureDetail.customer_returns_count ? `${closureDetail.customer_returns_count} retours dans la période` : 'Reports → FBA → Customer Concessions → Returns',
                      '4️⃣ FBA Customer Returns',
                      periode60j)}
                  </div>
                  <div style={{marginTop:8,padding:'8px 10px',background:dark?'#1a233a':'#e8f0fe',border:`1px solid ${C.blue}`,borderRadius:6,fontSize:11,color:C.blue,lineHeight:1.5}}>
                    📋 <strong>Pour télécharger les rapports :</strong> connecte-toi à Seller Central → utilise les chemins ci-dessus → filtre par les dates indiquées en jaune → télécharge en TSV/CSV → glisse-dépose dans <strong>📥 Import</strong> de l'onglet Amazon. Le système détecte automatiquement le type.
                  </div>
                </div>
              )
            })()}

            {/* ═══ ANCIEN WORKFLOW v1 (6 étapes) — masqué par défaut ═══ */}
            <details style={{marginTop:4,marginBottom:10}}>
              <summary style={{cursor:'pointer',padding:'10px 14px',background:dark?'#1a1a1a':'#f5f5f5',border:`1px dashed ${bdr}`,borderRadius:8,fontSize:12,color:sub,fontWeight:700,listStyle:'revert'}}>
                ▾ Afficher l'ancien workflow v1 (6 étapes — rétrocompat)
              </summary>
              <div style={{marginTop:10}}>
                <div style={{background:dark?'#1a233a':'#e8f0fe',border:`1px solid ${C.blue}`,borderRadius:10,padding:'10px 14px',marginBottom:10,fontSize:11,color:C.blue,lineHeight:1.5}}>
                  💡 <strong>Workflow v1</strong> — préservé pour les anciens settlements. Pour les nouveaux, utilise plutôt le bloc « 📑 Documents LAUTOPAK v2 » en haut qui consolide toutes ces étapes en 4 documents avec balance auto.
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {steps.map((st: any, idx: number) => (
                <div key={st.key} style={{background:card,border:`2px solid ${stepColor(st.status)}`,borderRadius:10,padding:'14px 16px',opacity:st.status==='locked'?.55:1}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10,flexWrap:'wrap'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:800,color:stepColor(st.status)}}>
                        {stepIcon(st.status)} Étape {idx+1} — {st.label}
                      </div>
                      <div style={{fontSize:12,color:sub,marginTop:4}}>{st.detail}</div>
                      {st.validated_at && <div style={{fontSize:10,color:sub,marginTop:3}}>Validé le {fmtDate(st.validated_at)} par <strong>{st.validated_by}</strong></div>}
                      {stepExplications[st.key] && (
                        <details style={{marginTop:6}}>
                          <summary style={{cursor:'pointer',fontSize:10,color:C.blue,fontWeight:700}}>ℹ️ Détails (quoi / comment / validation)</summary>
                          <div style={{marginTop:6,background:dark?'#0a0a0a':'#fafbfc',border:`1px solid ${bdr}`,borderRadius:6,padding:'8px 10px',fontSize:11,lineHeight:1.5}}>
                            <div style={{marginBottom:4}}><strong style={{color:sub}}>Quoi :</strong> {stepExplications[st.key].quoi}</div>
                            <div style={{marginBottom:4}}><strong style={{color:sub}}>Comment :</strong> {stepExplications[st.key].comment}</div>
                            <div><strong style={{color:sub}}>Validation :</strong> {stepExplications[st.key].valide}</div>
                          </div>
                        </details>
                      )}
                    </div>
                    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                      {/* Actions spécifiques par étape */}
                      {st.key==='1_lautopak' && st.status!=='locked' && (
                        <>
                          <button onClick={()=>{chargerLautopakLines(s.settlement_id); setShowLautopakModal(true)}}
                            style={{background:C.yellow,color:'#fff',border:'none',borderRadius:8,padding:'6px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                            🧾 Voir lignes à facturer
                          </button>
                          {st.status==='action' && (
                            <button onClick={()=>{setExpandedSettlement(s.settlement_id); setVue('settlements')}}
                              style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'6px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                              Saisir n° LAUTOPAK →
                            </button>
                          )}
                        </>
                      )}
                      {st.key==='5_audit' && s.audit_id && (
                        <>
                          <button onClick={async()=>{
                            if (!confirm(`Rafraîchir les valeurs théoriques de l'audit ?\n\nFBA Amazon, FBA Traction, HUB, FBM seront recalculés à partir du dernier snapshot + mappings actuels.\n\nLes comptages physiques déjà saisis sont préservés.`)) return
                            try {
                              const r = await fetch(`/api/amazon/audits/${s.audit_id}/refresh`, { method: 'POST' })
                              const j = await r.json()
                              if (j.success) {
                                alert(`✓ Rafraîchi : ${j.updated} lignes mises à jour${j.inserted ? `, ${j.inserted} nouvelles lignes` : ''} (snapshot ${j.snapshot_date || 'n/a'})`)
                              } else {
                                alert(j.erreur || 'Erreur')
                              }
                            } catch (e:any) { alert(e.message) }
                          }}
                            title="Recalcule FBA Amazon, FBA Traction, HUB, FBM à partir du dernier snapshot sans toucher aux comptages déjà saisis"
                            style={{background:'transparent',border:`1px solid ${C.blue}`,color:C.blue,borderRadius:8,padding:'6px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                            🔄 Rafraîchir théoriques
                          </button>
                          {st.status==='action' && (
                            <button onClick={()=>{setVue('audit'); chargerAuditDetail(s.audit_id)}}
                              style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'6px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                              Ouvrir l'audit →
                            </button>
                          )}
                        </>
                      )}
                      {(st.key==='3_unsellable' || st.key==='4_ajustements' || st.key==='6_rapport') && st.status!=='locked' && !closureDetail.is_closed && (
                        st.status==='done' ? (
                          <button onClick={()=>validerEtape(s.settlement_id, st.key==='3_unsellable'?3:st.key==='4_ajustements'?4:6, 'unvalidate')}
                            style={{background:'transparent',border:`1px solid ${sub}`,color:sub,borderRadius:8,padding:'6px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                            ↩ Dévalider
                          </button>
                        ) : (
                          <button onClick={()=>validerEtape(s.settlement_id, st.key==='3_unsellable'?3:st.key==='4_ajustements'?4:6)}
                            style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'6px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                            ✓ Valider l'étape
                          </button>
                        )
                      )}
                      {st.key==='6_rapport' && (
                        <button onClick={()=>chargerRapport(s.settlement_id)}
                          style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'6px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                          📊 Voir rapport
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Lignes LAUTOPAK inline pour l'étape 1 (toutes les ventes à facturer) */}
                  {st.key === '1_lautopak' && st.status !== 'locked' && lautopakLines && lautopakLines.lignes && lautopakLines.lignes.length > 0 && (
                    <div style={{marginTop:10,background:dark?'#0d1829':'#e8f0fe',border:`1px solid ${bdr}`,borderRadius:8,overflow:'hidden'}}>
                      <div style={{padding:'10px 12px',fontSize:11,fontWeight:800,color:C.blue,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8,borderBottom:`1px solid ${bdr}`}}>
                        <span>📋 Lignes à entrer dans LAUTOPAK ({lautopakLines.nb_lignes} lignes groupées par PKCode — Orders Principal brut)</span>
                        <span style={{fontSize:10,color:sub,fontWeight:400}}>
                          Total : <strong style={{color:Math.abs(lautopakLines.total_calcule - lautopakLines.frais_produit_settlement)<0.01?C.green:C.red,fontSize:13}}>{fmt$(lautopakLines.total_calcule)}</strong>
                          {' vs Frais produit '}<strong>{fmt$(lautopakLines.frais_produit_settlement)}</strong>
                          {Math.abs(lautopakLines.total_calcule - lautopakLines.frais_produit_settlement) < 0.01 ? ' ✓' : ` (écart ${fmt$(lautopakLines.total_calcule - lautopakLines.frais_produit_settlement)})`}
                        </span>
                      </div>
                      <div style={{overflow:'auto',maxHeight:360}}>
                        <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                          <thead style={{position:'sticky',top:0,background:thBg,zIndex:1}}><tr>
                            <th style={{padding:'6px 8px',textAlign:'center',fontSize:9,color:sub,borderBottom:`1px solid ${bdr}`,width:28}}>✓</th>
                            <th style={{padding:'6px 8px',textAlign:'left',fontSize:9,color:C.green,borderBottom:`1px solid ${bdr}`}}>PKCode</th>
                            <th style={{padding:'6px 8px',textAlign:'left',fontSize:9,color:sub,borderBottom:`1px solid ${bdr}`}}>SKU Amazon (variantes)</th>
                            <th style={{padding:'6px 8px',textAlign:'right',fontSize:9,color:C.yellow,borderBottom:`1px solid ${bdr}`}}>Qté Amz</th>
                            <th style={{padding:'6px 8px',textAlign:'right',fontSize:9,color:C.green,borderBottom:`1px solid ${bdr}`}}>Qté LAUTOPAK</th>
                            <th style={{padding:'6px 8px',textAlign:'right',fontSize:9,color:sub,borderBottom:`1px solid ${bdr}`}}>Prix unit.</th>
                            <th style={{padding:'6px 8px',textAlign:'right',fontSize:9,color:C.blue,borderBottom:`1px solid ${bdr}`}}>Montant</th>
                          </tr></thead>
                          <tbody>
                            {[...lautopakLines.lignes].sort((a:any,b:any)=>((a.facturee?1:0)-(b.facturee?1:0))||(b.amount-a.amount)).map((ll:any, li:number) => {
                              const fact = !!ll.facturee
                              const vars = ll.variantes || []
                              return (
                                <tr key={li} style={{background:fact?(dark?'#0d2a18':'#e6f4ea'):'transparent',opacity:fact?.7:1}}>
                                  <td style={{padding:'3px 8px',textAlign:'center',borderBottom:`1px solid ${bdr}`}}>
                                    <input type="checkbox" checked={fact}
                                      onChange={()=>toggleLautopakFacturee(lautopakLines.settlement_id, ll.pk_code, fact)}
                                      style={{accentColor:C.green,width:14,height:14,cursor:'pointer'}}/>
                                  </td>
                                  <td onClick={()=>ll.pk_code && copyToClipboard(ll.pk_code)} title="Cliquer pour copier"
                                      style={{padding:'4px 8px',fontFamily:'monospace',fontWeight:800,fontSize:11,color:ll.manual_mapping?C.green:C.blue,cursor:ll.pk_code?'pointer':'default',background:copiedCode===ll.pk_code?C.green+'33':'transparent',borderBottom:`1px solid ${bdr}`,textDecoration:fact?'line-through':'none'}}>
                                    {copiedCode===ll.pk_code && ll.pk_code ? '✓ copié' : (<>
                                      {ll.manual_mapping && <span style={{fontSize:9,color:C.green,marginRight:3}}>🔗</span>}
                                      {ll.pk_code}
                                    </>)}
                                  </td>
                                  <td style={{padding:'4px 8px',fontFamily:'monospace',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`,maxWidth:260,overflow:'hidden'}}>
                                    {vars.map((v:any, vi:number) => (
                                      <span key={vi} style={{marginRight:vi<vars.length-1?5:0}}>
                                        <strong onClick={()=>copyToClipboard(v.amazon_sku)} title="Cliquer pour copier"
                                          style={{color:dark?'#e0e0e0':'#333',cursor:'pointer',background:copiedCode===v.amazon_sku?C.green+'33':'transparent',padding:'0 2px',borderRadius:3}}>
                                          {copiedCode===v.amazon_sku ? '✓' : v.amazon_sku}
                                        </strong>
                                        <span style={{color:C.yellow,marginLeft:2}}>({v.qty_amazon})</span>
                                        {v.multiplier > 1 && <span style={{color:sub,fontSize:9}}>×{v.multiplier}</span>}
                                        {vi<vars.length-1 && <span style={{color:sub,margin:'0 2px'}}>+</span>}
                                      </span>
                                    ))}
                                  </td>
                                  <td style={{padding:'4px 8px',textAlign:'right',color:C.yellow,borderBottom:`1px solid ${bdr}`}}>{ll.qty}</td>
                                  <td style={{padding:'4px 8px',textAlign:'right',fontWeight:700,color:fact?sub:C.green,borderBottom:`1px solid ${bdr}`}}>{ll.qty_lautopak || ll.qty}</td>
                                  <td style={{padding:'4px 8px',textAlign:'right',color:sub,fontSize:10,borderBottom:`1px solid ${bdr}`}}>{Number(ll.prix_unitaire||0).toFixed(2)} $</td>
                                  <td style={{padding:'4px 8px',textAlign:'right',fontWeight:800,color:fact?sub:C.blue,borderBottom:`1px solid ${bdr}`}}>{fmt$(ll.amount)}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Détails d'étape quand il y a des items à voir */}
                  {st.items && st.items.length > 0 && st.status !== 'locked' && (
                    <div style={{marginTop:10,background:dark?'#0f0f0f':'#fafbfc',borderRadius:8,border:`1px solid ${bdr}`,overflow:'hidden',maxHeight:360,overflowY:'auto'}}>
                      {st.key==='2_reimbursements' ? (
                        <>
                          {/* Bloc Facture LAUTOPAK séparée pour pièces perdues */}
                          {st.items && st.items.length > 0 && (() => {
                            const ref = s.lautopak_reimb_invoice_ref
                            const date = s.lautopak_reimb_invoice_date
                            const hasInvoice = !!ref && !!date
                            return (
                              <div style={{padding:'10px 12px',background:hasInvoice?(dark?'#0d2a18':'#e6f4ea'):(dark?'#2b1113':'#fce8e6'),borderBottom:`1px solid ${bdr}`}}>
                                <div style={{fontSize:11,fontWeight:800,color:hasInvoice?C.green:C.red,marginBottom:6}}>
                                  {hasInvoice ? '✅' : '🧾'} Facture LAUTOPAK séparée pour pièces perdues/remboursées
                                </div>
                                <div style={{fontSize:10,color:sub,marginBottom:8,lineHeight:1.5}}>
                                  Crée une <strong>2e facture LAUTOPAK</strong> avec les pièces ci-dessous (qui ont été perdues/cassées/retournées perdues et remboursées par Amazon) et inscris son n° ici. Cette facture décrémentera l'inventaire LAUTOPAK pour ces unités disparues.
                                </div>
                                {hasInvoice ? (
                                  <div style={{fontSize:11,display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
                                    <span><strong>N° :</strong> <code style={{background:dark?'#222':'#fff',padding:'2px 6px',borderRadius:4,fontFamily:'monospace'}}>{ref}</code></span>
                                    <span><strong>Date :</strong> {String(date).split('T')[0]}</span>
                                    <button onClick={()=>{chargerLautopakReimbLines(s.settlement_id); setShowLautopakReimbModal(true)}}
                                      style={{background:C.blue,color:'#fff',border:'none',borderRadius:6,padding:'4px 10px',fontWeight:700,cursor:'pointer',fontSize:10}}>
                                      🧾 Voir lignes facturées
                                    </button>
                                    <button onClick={()=>{setReimbInvoiceRef(ref); setReimbInvoiceDate(String(date).split('T')[0])}}
                                      style={{background:'transparent',border:`1px solid ${sub}`,color:sub,borderRadius:6,padding:'4px 10px',fontWeight:700,cursor:'pointer',fontSize:10}}>
                                      ✏️ Modifier
                                    </button>
                                  </div>
                                ) : (
                                  <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'flex-end'}}>
                                    <div>
                                      <div style={{fontSize:9,color:sub,fontWeight:700,marginBottom:3}}>N° facture LAUTOPAK</div>
                                      <input value={reimbInvoiceRef} onChange={e=>setReimbInvoiceRef(e.target.value)}
                                        placeholder="ex: LAU-2026-042"
                                        style={{...S,fontSize:11,padding:'6px 8px',width:140,fontFamily:'monospace'}}/>
                                    </div>
                                    <div>
                                      <div style={{fontSize:9,color:sub,fontWeight:700,marginBottom:3}}>Date</div>
                                      <input type="date" value={reimbInvoiceDate} onChange={e=>setReimbInvoiceDate(e.target.value)}
                                        style={{...S,fontSize:11,padding:'6px 8px'}}/>
                                    </div>
                                    <button onClick={()=>{chargerLautopakReimbLines(s.settlement_id); setShowLautopakReimbModal(true)}}
                                      style={{background:C.blue,color:'#fff',border:'none',borderRadius:6,padding:'7px 10px',fontWeight:700,cursor:'pointer',fontSize:10}}>
                                      🧾 Voir lignes à facturer
                                    </button>
                                    <button onClick={()=>sauverReimbInvoice(s.settlement_id)}
                                      disabled={!reimbInvoiceRef.trim() || !reimbInvoiceDate}
                                      style={{background:(!reimbInvoiceRef.trim() || !reimbInvoiceDate)?bdr:C.green,color:'#fff',border:'none',borderRadius:6,padding:'7px 12px',fontWeight:700,cursor:'pointer',fontSize:10}}>
                                      ✓ Enregistrer
                                    </button>
                                  </div>
                                )}
                              </div>
                            )
                          })()}
                          {/* ─── Bandeau balance (inline, pas de tableau séparé) ─── */}
                          {lautopakReimbLines && lautopakReimbLines.lignes && lautopakReimbLines.lignes.length > 0 && (
                            <div style={{padding:'10px 12px',background:dark?'#0d1829':'#e8f0fe',borderBottom:`1px solid ${bdr}`,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8,fontSize:11}}>
                              <span style={{fontWeight:800,color:C.blue}}>📋 Total à facturer dans LAUTOPAK : {fmt$(lautopakReimbLines.total_facture)} {lautopakReimbLines.balance_ok && '✓'}</span>
                              <span style={{color:sub}}>
                                {lautopakReimbLines.target_settlement != null && <>vs cible settlement {fmt$(lautopakReimbLines.target_settlement)}</>}
                                {' · '}{lautopakReimbLines.nb_lignes} pk_code distincts
                              </span>
                            </div>
                          )}
                          <div style={{padding:'8px 12px',background:dark?'#2b2411':'#fdf6e3',borderBottom:`1px solid ${bdr}`,fontSize:11,fontWeight:700,color:C.yellow}}>
                            ⚠️ Coche chaque reimbursement quand tu fais l'ajustement dans LAUTOPAK. L'étape 2 se valide quand toutes les cases sont cochées + n° de facture LAUTOPAK saisi ci-dessus.
                          </div>
                          <table style={{width:'100%',fontSize:11,borderCollapse:'collapse'}}>
                            <thead><tr style={{background:thBg}}>
                              <th style={{padding:'6px 10px',textAlign:'center',fontSize:9,color:sub,width:30}}>Fait ?</th>
                              <th style={{padding:'6px 10px',textAlign:'left',fontSize:9,color:sub}}>Reimb. ID</th>
                              <th style={{padding:'6px 10px',textAlign:'left',fontSize:9,color:sub}}>SKU Amazon</th>
                              <th style={{padding:'6px 10px',textAlign:'left',fontSize:9,color:C.green}}>PKCode (mapping)</th>
                              <th style={{padding:'6px 10px',textAlign:'left',fontSize:9,color:sub}}>Raison</th>
                              <th style={{padding:'6px 10px',textAlign:'right',fontSize:9,color:C.yellow}}>Qté Amz</th>
                              <th style={{padding:'6px 10px',textAlign:'center',fontSize:9,color:sub}}>× Mult</th>
                              <th style={{padding:'6px 10px',textAlign:'right',fontSize:9,color:C.green}}>Qté LAUTOPAK</th>
                              <th style={{padding:'6px 10px',textAlign:'right',fontSize:9,color:sub}}>Prix unit.</th>
                              <th style={{padding:'6px 10px',textAlign:'right',fontSize:9,color:C.blue}}>Montant</th>
                              <th style={{padding:'6px 10px',textAlign:'right',fontSize:9,color:sub}}>Stock</th>
                            </tr></thead>
                            <tbody>
                              {st.items.map((r:any,i:number) => {
                                const deja = !!r.inventaire_ajuste_le
                                return (
                                  <tr key={i} style={{background:deja?(dark?'#0d2a18':'#e6f4ea'):'transparent'}}>
                                    <td style={{padding:'4px 10px',textAlign:'center',borderBottom:`1px solid ${bdr}`}}>
                                      <input type="checkbox" checked={deja}
                                        onChange={()=>toggleAjustementReimbursement(r.reimbursement_id, r.pk_code_to_adjust, deja)}
                                        style={{accentColor:C.green,width:16,height:16,cursor:'pointer'}}
                                        title={deja ? `Fait le ${String(r.inventaire_ajuste_le).split('T')[0]} par ${r.inventaire_ajuste_par}` : 'Marquer comme ajusté dans LAUTOPAK'}/>
                                    </td>
                                    <td style={{padding:'4px 10px',fontFamily:'monospace',fontSize:10,borderBottom:`1px solid ${bdr}`,textDecoration:deja?'line-through':'none',color:deja?sub:'inherit'}}>{r.reimbursement_id}</td>
                                    <td onClick={()=>copyToClipboard(r.sku)} title={r.product_name ? r.product_name + ' · Cliquer pour copier' : 'Cliquer pour copier'}
                                        style={{padding:'4px 10px',fontFamily:'monospace',borderBottom:`1px solid ${bdr}`,color:deja?sub:'inherit',cursor:'pointer',background:copiedCode===r.sku?C.green+'33':'transparent',transition:'background .2s'}}>
                                      {copiedCode===r.sku ? '✓ copié' : r.sku}
                                      {r.case_matched_action && (
                                        <div style={{fontSize:9,color:C.green,fontWeight:700,marginTop:2}}
                                             title={`Match automatique : case ${r.case_id} ouvert le ${String(r.case_matched_action.action_le||'').split('T')[0]} par ${r.case_matched_action.action_par||'?'} dans settlement ${r.case_matched_action.settlement_id}`}>
                                          🔗 Case {r.case_id} matché
                                        </div>
                                      )}
                                    </td>
                                    <td onClick={()=>r.pk_code_to_adjust && copyToClipboard(r.pk_code_to_adjust)}
                                        title={r.pk_code_to_adjust ? 'Cliquer pour copier' : ''}
                                        style={{padding:'4px 10px',fontFamily:'monospace',fontWeight:700,color:deja?sub:(r.manual_mapping?C.green:(r.found_in_traction?C.red:sub)),borderBottom:`1px solid ${bdr}`,cursor:r.pk_code_to_adjust?'pointer':'default',background:copiedCode===r.pk_code_to_adjust?C.green+'33':'transparent',transition:'background .2s'}}>
                                      {copiedCode===r.pk_code_to_adjust && r.pk_code_to_adjust ? '✓ copié' : (r.pk_code_to_adjust ? (<>
                                        {r.manual_mapping && <span style={{fontSize:9,color:C.green,marginRight:3}}>🔗</span>}
                                        {r.pk_code_to_adjust}
                                      </>) : <span style={{color:sub}}>— non mappé</span>)}
                                    </td>
                                    <td style={{padding:'4px 10px',color:sub,borderBottom:`1px solid ${bdr}`,fontSize:10}}>{r.reason}</td>
                                    <td style={{padding:'4px 10px',textAlign:'right',fontWeight:700,color:deja?sub:C.yellow,borderBottom:`1px solid ${bdr}`}}>{r.qty_cash || ''}</td>
                                    <td style={{padding:'4px 10px',textAlign:'center',color:r.multiplier>1?C.yellow:sub,fontWeight:r.multiplier>1?700:400,borderBottom:`1px solid ${bdr}`}}>×{r.multiplier || 1}</td>
                                    <td style={{padding:'4px 10px',textAlign:'right',fontWeight:700,color:deja?sub:C.green,borderBottom:`1px solid ${bdr}`}}>{r.qty_cash_lautopak || r.qty_cash || ''}</td>
                                    {(() => {
                                      // Prix unit du pk_code group (arrondi balancé) depuis lautopakReimbLines
                                      const grp = lautopakReimbLines?.lignes?.find((g:any) => g.pk_code === r.pk_code_to_adjust)
                                      const pu = grp ? Number(grp.prix_unitaire || 0) : (r.qty_cash > 0 ? Number(r.amount || 0) / Number(r.qty_cash) : 0)
                                      return (
                                        <>
                                          <td style={{padding:'4px 10px',textAlign:'right',color:sub,fontSize:10,borderBottom:`1px solid ${bdr}`}}>{pu.toFixed(2)} $</td>
                                          <td style={{padding:'4px 10px',textAlign:'right',fontWeight:800,color:deja?sub:C.blue,borderBottom:`1px solid ${bdr}`}}>{fmt$(r.amount)}</td>
                                        </>
                                      )
                                    })()}
                                    <td style={{padding:'4px 10px',textAlign:'right',color:sub,borderBottom:`1px solid ${bdr}`}}>{r.current_traction_qty != null ? r.current_traction_qty : '—'}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                          {(() => {
                            const fait = st.items.filter((r:any) => r.inventaire_ajuste_le).length
                            const total = st.items.length
                            const totalMontant = st.items.reduce((s:number, r:any) => s + Number(r.amount || 0), 0)
                            const totalFait = st.items.filter((r:any) => r.inventaire_ajuste_le).reduce((s:number, r:any) => s + Number(r.amount || 0), 0)
                            const saisiKey = s.settlement_id
                            const saisiStr = releveRembStock[saisiKey] || ''
                            const saisiNum = parseFloat(saisiStr.replace(',', '.'))
                            const ecart = !isNaN(saisiNum) ? Number((totalMontant - saisiNum).toFixed(2)) : null
                            return (
                              <div style={{borderTop:`2px solid ${bdr}`}}>
                                {/* Totaux */}
                                <div style={{padding:'10px 12px',background:dark?'#0d1829':'#e8f0fe',borderBottom:`1px solid ${bdr}`,fontSize:12,display:'grid',gridTemplateColumns:isMobile?'1fr':'repeat(3,1fr)',gap:10}}>
                                  <div>
                                    <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Total montant reimbursements</div>
                                    <div style={{fontSize:16,fontWeight:900,color:C.blue}}>{fmt$(totalMontant)}</div>
                                    <div style={{fontSize:10,color:sub}}>{total} ligne{total>1?'s':''} cash</div>
                                  </div>
                                  <div>
                                    <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Progression ajustements</div>
                                    <div style={{fontSize:16,fontWeight:900,color:fait===total?C.green:C.yellow}}>{fait}/{total}</div>
                                    <div style={{fontSize:10,color:sub}}>{fmt$(totalFait)} traité{fait>1?'s':''}</div>
                                  </div>
                                  <div>
                                    <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Rapprochement relevé</div>
                                    <div style={{display:'flex',alignItems:'center',gap:6,marginTop:2}}>
                                      <input type="text" value={saisiStr}
                                        onChange={e=>setReleveRembStock(p=>({...p,[saisiKey]:e.target.value}))}
                                        placeholder="saisir..."
                                        style={{...S,textAlign:'right',fontSize:12,padding:'4px 6px',width:100,fontFamily:'monospace'}}/>
                                      {ecart !== null ? (
                                        <span style={{fontSize:13,fontWeight:800,color:Math.abs(ecart)<0.01?C.green:C.red}}>
                                          {Math.abs(ecart)<0.01 ? '✓' : fmt$(ecart)}
                                        </span>
                                      ) : (
                                        <span style={{fontSize:10,color:sub}}>vs relevé</span>
                                      )}
                                    </div>
                                    <div style={{fontSize:10,color:sub,marginTop:2}}>= "Remb. de stock (FBA)" du relevé</div>
                                  </div>
                                </div>
                                {fait === total && total > 0 && (
                                  <div style={{padding:'6px 12px',background:dark?'#0d2a18':'#e6f4ea',fontSize:11,color:C.green,fontWeight:700,textAlign:'center'}}>
                                    ✓ Tous les reimbursements sont traités dans LAUTOPAK
                                  </div>
                                )}
                              </div>
                            )
                          })()}
                        </>
                      ) : st.key==='3_unsellable' ? (
                        <>
                          <div style={{padding:'8px 12px',background:dark?'#1a233a':'#e8f0fe',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,lineHeight:1.5}}>
                            💡 Choisis une action pour chaque SKU : <strong>Removal</strong> (retour au warehouse), <strong>Case</strong> (réclamation Amazon), ou <strong>Skip</strong> (reporté). Inscris le n° de case/removal dans la colonne Réf. Tes choix sont sauvegardés par settlement + sku.
                            <br/>🤖 Les SKU avec un <strong>removal "Completed"</strong> dans le rapport Amazon sont marqués <span style={{background:C.blue+'22',color:C.blue,padding:'1px 6px',borderRadius:4,fontWeight:700}}>Auto</span> — clique <strong>Appliquer</strong> pour pré-remplir.
                          </div>
                          <table style={{width:'100%',fontSize:11,borderCollapse:'collapse'}}>
                            <thead><tr style={{background:thBg}}>
                              <th style={{padding:'6px 10px',textAlign:'left',fontSize:9,color:sub}}>SKU</th>
                              <th style={{padding:'6px 10px',textAlign:'left',fontSize:9,color:sub}}>Traction</th>
                              <th style={{padding:'6px 10px',textAlign:'left',fontSize:9,color:sub}}>Produit</th>
                              <th style={{padding:'6px 10px',textAlign:'right',fontSize:9,color:sub}}>Qté</th>
                              <th style={{padding:'6px 10px',textAlign:'right',fontSize:9,color:sub}}>Valeur</th>
                              <th style={{padding:'6px 10px',textAlign:'center',fontSize:9,color:sub}}>Action</th>
                              <th style={{padding:'6px 10px',textAlign:'left',fontSize:9,color:sub}}>Réf. Amazon</th>
                              <th style={{padding:'6px 10px',textAlign:'left',fontSize:9,color:sub}}>Notes</th>
                              <th style={{padding:'6px 10px',textAlign:'center',fontSize:9,color:sub}}></th>
                            </tr></thead>
                            <tbody>
                              {st.items.map((u:any,i:number) => {
                                const a = u.action || {}
                                return (
                                  <tr key={i} style={{background:a.action_type?(dark?'#0d2a18':'#e6f4ea'):'transparent'}}>
                                    <td style={{padding:'4px 10px',fontFamily:'monospace',borderBottom:`1px solid ${bdr}`}}>{u.sku}</td>
                                    <td style={{padding:'4px 10px',fontFamily:'monospace',color:u.traction_code?C.blue:C.red,borderBottom:`1px solid ${bdr}`}}>{u.traction_code||'—'}</td>
                                    <td style={{padding:'4px 10px',color:sub,borderBottom:`1px solid ${bdr}`,maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={u.product_name}>{u.product_name||'—'}</td>
                                    <td style={{padding:'4px 10px',textAlign:'right',fontWeight:700,color:C.red,borderBottom:`1px solid ${bdr}`}}>{u.qty}</td>
                                    <td style={{padding:'4px 10px',textAlign:'right',color:C.red,borderBottom:`1px solid ${bdr}`}}>{fmt$(u.valeur)}</td>
                                    <td style={{padding:'4px 6px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                                      <select value={a.action_type || ''} onChange={e=>saveUnsellableAction(s.settlement_id, u.sku, u.traction_code, { action_type: e.target.value || null })}
                                        style={{...S,fontSize:11,padding:'3px 6px',width:100}}>
                                        <option value="">— Choisir</option>
                                        <option value="removal">📦 Removal</option>
                                        <option value="case">📋 Case</option>
                                        <option value="skip">⏭ Skip</option>
                                      </select>
                                    </td>
                                    <td style={{padding:'4px 6px',borderBottom:`1px solid ${bdr}`}}>
                                      <input defaultValue={a.amazon_ref || ''} onBlur={(e:any)=>{ if (e.target.value !== (a.amazon_ref||'')) saveUnsellableAction(s.settlement_id, u.sku, u.traction_code, { amazon_ref: e.target.value }) }}
                                        placeholder="case / removal ID" style={{...S,fontSize:11,padding:'3px 6px',width:130,fontFamily:'monospace'}}/>
                                    </td>
                                    <td style={{padding:'4px 6px',borderBottom:`1px solid ${bdr}`}}>
                                      <input defaultValue={a.notes || ''} onBlur={(e:any)=>{ if (e.target.value !== (a.notes||'')) saveUnsellableAction(s.settlement_id, u.sku, u.traction_code, { notes: e.target.value }) }}
                                        placeholder="notes..." style={{...S,fontSize:11,padding:'3px 6px',width:160}}/>
                                    </td>
                                    <td style={{padding:'4px 6px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                                      {a.action_type && a.amazon_ref ? (
                                        <button onClick={()=>marquerUnsellableTraite(s.settlement_id, u.sku)}
                                          title="Sortir de la liste — restera visible dans le Suivi unsellable"
                                          style={{background:C.green,color:'#fff',border:'none',borderRadius:6,padding:'4px 10px',fontWeight:700,cursor:'pointer',fontSize:10,whiteSpace:'nowrap'}}>
                                          ✓ Sortir
                                        </button>
                                      ) : u.has_removal_completed && u.latest_removal_order_id ? (
                                        <button onClick={()=>appliquerRemovalAuto(s.settlement_id, u.sku, u.traction_code, u.latest_removal_order_id)}
                                          title={`Removal automatique trouvé : ${u.latest_removal_order_id}`}
                                          style={{background:C.blue,color:'#fff',border:'none',borderRadius:6,padding:'4px 10px',fontWeight:700,cursor:'pointer',fontSize:10,whiteSpace:'nowrap'}}>
                                          🤖 Appliquer
                                        </button>
                                      ) : (
                                        <span style={{fontSize:9,color:sub,fontStyle:'italic'}}>action + réf requis</span>
                                      )}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                          {(() => {
                            const fait = st.items.filter((u:any) => u.action?.action_type).length
                            const total = st.items.length
                            return (
                              <div style={{padding:'8px 12px',background:dark?'#0f0f0f':'#fafbfc',borderTop:`1px solid ${bdr}`,fontSize:11,color:sub,display:'flex',justifyContent:'space-between'}}>
                                <span>Actions enregistrées : <strong style={{color:fait===total?C.green:C.yellow}}>{fait}/{total}</strong></span>
                                {fait === total && total > 0 && <span style={{color:C.green,fontWeight:700}}>✓ Toutes les actions unsellable sont enregistrées</span>}
                              </div>
                            )
                          })()}
                        </>
                      ) : st.key==='5_audit' ? (
                        <table style={{width:'100%',fontSize:11,borderCollapse:'collapse'}}>
                          <thead><tr style={{background:thBg}}>
                            <th style={{padding:'6px 10px',textAlign:'left',fontSize:9,color:sub}}>Base code</th>
                            <th style={{padding:'6px 10px',textAlign:'left',fontSize:9,color:sub}}>Description</th>
                            <th style={{padding:'6px 10px',textAlign:'right',fontSize:9,color:sub}}>Traction</th>
                            <th style={{padding:'6px 10px',textAlign:'right',fontSize:9,color:sub}}>Physique</th>
                            <th style={{padding:'6px 10px',textAlign:'right',fontSize:9,color:C.red}}>Écart</th>
                          </tr></thead>
                          <tbody>
                            {st.items.map((r:any,i:number) => (
                              <tr key={i} title={`HUB ${r.breakdown.hub} + FBM ${r.breakdown.fbm} + SP ${r.breakdown.sp} + FBA-Tract ${r.breakdown.fba_traction} vs Whse comptés ${r.breakdown.whse_compte||0} + FBM comptés ${r.breakdown.fbm_compte||0} + FBA-Amz ${r.breakdown.fba_amazon}`}>
                                <td style={{padding:'4px 10px',fontFamily:'monospace',fontWeight:700,borderBottom:`1px solid ${bdr}`}}>{r.base_code}</td>
                                <td style={{padding:'4px 10px',color:sub,borderBottom:`1px solid ${bdr}`,maxWidth:260,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.description||'—'}</td>
                                <td style={{padding:'4px 10px',textAlign:'right',borderBottom:`1px solid ${bdr}`}}>{r.traction_total}</td>
                                <td style={{padding:'4px 10px',textAlign:'right',borderBottom:`1px solid ${bdr}`}}>{r.physique_total}</td>
                                <td style={{padding:'4px 10px',textAlign:'right',fontWeight:800,color:C.red,borderBottom:`1px solid ${bdr}`}}>{r.ecart>0?'+':''}{r.ecart}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : null}
                    </div>
                  )}
                </div>
              ))}
                </div>
              </div>
            </details>
          </div>
        )
      })()}

      {/* ═══ Modal LIGNES À FACTURER LAUTOPAK (ouverture explicite) ═══ */}
      {showLautopakModal && (lautopakLoading || lautopakLines) && (() => {
        const fmt$ = (n: number) => `${n<0?'−':''}${Math.abs(Number(n||0)).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} $`
        return (
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}
               onClick={()=>setShowLautopakModal(false)}>
            <div onClick={(e:any)=>e.stopPropagation()} style={{background:card,borderRadius:12,padding:0,maxWidth:1100,width:'100%',maxHeight:'92vh',overflow:'hidden',display:'flex',flexDirection:'column',border:`1px solid ${bdr}`}}>
              <div style={{padding:'14px 18px',borderBottom:`1px solid ${bdr}`,display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                <div>
                  <div style={{fontSize:14,fontWeight:900}}>🧾 Lignes à facturer dans LAUTOPAK</div>
                  {lautopakLines && (
                    <div style={{fontSize:11,color:sub,marginTop:2,fontFamily:'monospace'}}>Settlement {lautopakLines.settlement_id}</div>
                  )}
                </div>
                <div style={{display:'flex',gap:6}}>
                  {lautopakLines && (
                    <button onClick={()=>exportLautopakCsv(lautopakLines)}
                      style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'8px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                      📥 Export CSV
                    </button>
                  )}
                  <button onClick={()=>setShowLautopakModal(false)}
                    style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'8px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                    ✕ Fermer
                  </button>
                </div>
              </div>

              {lautopakLoading && (
                <div style={{padding:60,textAlign:'center',color:sub,fontSize:13}}>⏳ Chargement des lignes...</div>
              )}

              {lautopakLines && (
                <>
                  {/* Bandeau balance */}
                  <div style={{padding:'12px 18px',background:lautopakLines.balance_ok?(dark?'#0d2a18':'#e6f4ea'):(dark?'#2b1113':'#fce8e6'),borderBottom:`2px solid ${lautopakLines.balance_ok?C.green:C.red}`,display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(4,1fr)',gap:10}}>
                    <div>
                      <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Frais produit (attendu)</div>
                      <div style={{fontSize:16,fontWeight:900,color:C.blue}}>{fmt$(lautopakLines.frais_produit_settlement)}</div>
                      <div style={{fontSize:9,color:sub}}>Somme "Principal" du settlement</div>
                    </div>
                    <div>
                      <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Total calculé (lignes)</div>
                      <div style={{fontSize:16,fontWeight:900}}>{fmt$(lautopakLines.total_calcule)}</div>
                      <div style={{fontSize:9,color:sub}}>{lautopakLines.nb_lignes} SKU distincts</div>
                    </div>
                    <div>
                      <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Écart</div>
                      <div style={{fontSize:16,fontWeight:900,color:lautopakLines.balance_ok?C.green:C.red}}>{fmt$(lautopakLines.ecart)}</div>
                    </div>
                    <div>
                      <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Balance</div>
                      <div style={{fontSize:18,fontWeight:900,color:lautopakLines.balance_ok?C.green:C.red}}>
                        {lautopakLines.balance_ok ? '✓ OK' : '⚠ Écart'}
                      </div>
                    </div>
                  </div>

                  {/* Info */}
                  <div style={{padding:'8px 18px',fontSize:11,color:sub,background:dark?'#0f0f0f':'#fafbfc',borderBottom:`1px solid ${bdr}`,lineHeight:1.5}}>
                    <strong>{lautopakLines.nb_lignes} lignes Orders Principal (brut)</strong> → à facturer dans LAUTOPAK.
                    Total = <strong>{fmt$(lautopakLines.total_calcule)}</strong> qui correspond au "Frais de produits" de ton relevé Amazon.
                    {lautopakLines.nb_refunds > 0 && (
                      <> Les <strong>{lautopakLines.nb_refunds} refunds</strong> ({fmt$(lautopakLines.total_refunds)}) sont listés séparément en bas — traite-les comme notes de crédit / retours clients dans ton compte distinct.</>
                    )}
                  </div>
                  {lautopakLines.breakdown && lautopakLines.breakdown.length > 0 && (
                    <details style={{borderBottom:`1px solid ${bdr}`,background:dark?'#0d0d0d':'#fafbfc'}}>
                      <summary style={{padding:'8px 18px',cursor:'pointer',fontSize:11,color:sub,fontWeight:700}}>
                        ▾ Décomposition par catégorie (amount_description) — utile pour matcher le relevé imprimé Amazon
                      </summary>
                      <div style={{padding:'4px 18px 12px'}}>
                        <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                          <thead><tr style={{background:thBg}}>
                            <th style={{padding:'6px 10px',textAlign:'left',fontSize:10,color:sub}}>amount_description</th>
                            <th style={{padding:'6px 10px',textAlign:'right',fontSize:10,color:sub}}>Nb lignes</th>
                            <th style={{padding:'6px 10px',textAlign:'right',fontSize:10,color:sub}}>Total</th>
                          </tr></thead>
                          <tbody>
                            {lautopakLines.breakdown.map((b:any) => (
                              <tr key={b.amount_description} style={{background:b.amount_description==='Principal'?(dark?'#0d2a18':'#e6f4ea'):'transparent'}}>
                                <td style={{padding:'4px 10px',borderBottom:`1px solid ${bdr}`,fontWeight:b.amount_description==='Principal'?700:400}}>
                                  {b.amount_description==='Principal' && '✓ '}{b.amount_description}
                                </td>
                                <td style={{padding:'4px 10px',textAlign:'right',color:sub,borderBottom:`1px solid ${bdr}`}}>{b.count}</td>
                                <td style={{padding:'4px 10px',textAlign:'right',fontWeight:700,color:b.total>=0?C.blue:C.red,borderBottom:`1px solid ${bdr}`}}>{fmt$(b.total)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div style={{fontSize:10,color:sub,marginTop:8,lineHeight:1.5}}>
                          💡 Astuce : identifie quelle(s) combinaison(s) de lignes ci-dessus = <strong>{fmt$(lautopakLines.frais_produit_settlement)}</strong> ou le montant exact de ton relevé. Dis-moi lesquelles, et j'ajoute ces catégories au calcul.
                        </div>
                      </div>
                    </details>
                  )}

                  {/* Tableau Orders (pour facture LAUTOPAK) — non cochées en haut, cochées en bas */}
                  <div style={{overflow:'auto',flex:1}}>
                    {(() => {
                      const sorted = [...lautopakLines.lignes].sort((a:any,b:any) => {
                        const fa = a.facturee ? 1 : 0
                        const fb = b.facturee ? 1 : 0
                        if (fa !== fb) return fa - fb  // non cochées d'abord
                        return b.amount - a.amount     // puis par montant décroissant
                      })
                      const faitCount = sorted.filter((l:any) => l.facturee).length
                      return (
                        <>
                          <div style={{padding:'8px 18px 4px',fontSize:11,fontWeight:800,color:C.blue,background:dark?'#0d1829':'#e8f0fe',display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8}}>
                            <span>📋 Lignes à entrer dans LAUTOPAK (Orders Principal brut)</span>
                            <span style={{fontSize:10,color:sub,fontWeight:400}}>Coche au fur et à mesure → la ligne descend en bas. Progression : <strong style={{color:faitCount===sorted.length?C.green:C.yellow}}>{faitCount}/{sorted.length}</strong></span>
                          </div>
                          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                            <thead style={{position:'sticky',top:0,background:thBg,zIndex:1}}><tr>
                              <th style={{padding:'8px 10px',textAlign:'center',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`,width:30}}>✓</th>
                              <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:C.green,borderBottom:`1px solid ${bdr}`}}>PKCode (mapping)</th>
                              <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>SKU Amazon (variantes)</th>
                              <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Produit</th>
                              <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:C.yellow,borderBottom:`1px solid ${bdr}`}}>Qté Amz</th>
                              <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:C.green,borderBottom:`1px solid ${bdr}`}}>Qté LAUTOPAK</th>
                              <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Prix unit. (arrondi)</th>
                              <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:C.blue,borderBottom:`1px solid ${bdr}`}}>Montant</th>
                            </tr></thead>
                            <tbody>
                              {sorted.map((l:any, i:number) => {
                                const fact = !!l.facturee
                                const variantes = l.variantes || []
                                const hasManual = !!l.manual_mapping
                                const hasMultiplePrices = variantes.length > 1 || variantes.some((v:any) => v.multiplier > 1)
                                const expanded = !!expandedPk[l.pk_code]
                                return (<React.Fragment key={l.pk_code+i}>
                                  <tr style={{background:fact?(dark?'#0d2a18':'#e6f4ea'):'transparent',opacity:fact?.7:1}}>
                                    <td style={{padding:'4px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                                      <input type="checkbox" checked={fact}
                                        onChange={()=>toggleLautopakFacturee(lautopakLines.settlement_id, l.pk_code, fact)}
                                        title={fact ? `Facturée le ${String(l.facturee_le||'').split('T')[0]} par ${l.facturee_par||'?'}` : 'Marquer comme saisie dans LAUTOPAK'}
                                        style={{accentColor:C.green,width:16,height:16,cursor:'pointer'}}/>
                                    </td>
                                    {/* PKCode */}
                                    <td onClick={()=>copyToClipboard(l.pk_code)} title="Cliquer pour copier"
                                        style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:800,fontSize:12,color:hasManual?C.green:C.blue,cursor:'pointer',textDecoration:fact?'line-through':'none',background:copiedCode===l.pk_code?C.green+'33':'transparent',transition:'background .2s'}}>
                                      {copiedCode===l.pk_code ? '✓ copié' : (<>
                                        {hasManual && <span style={{fontSize:9,color:C.green,marginRight:4}}>🔗</span>}
                                        {l.pk_code}
                                      </>)}
                                    </td>
                                    {/* SKU Amazon variantes — inline + dépliable */}
                                    <td style={{padding:'4px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:10}}>
                                      {hasMultiplePrices && (
                                        <button onClick={()=>setExpandedPk(p=>({...p,[l.pk_code]:!expanded}))}
                                          style={{background:'transparent',border:'none',color:sub,cursor:'pointer',padding:'0 4px 0 0',fontSize:9}}>
                                          {expanded ? '▼' : '▶'}
                                        </button>
                                      )}
                                      <span style={{color:sub}}>
                                        {variantes.map((v:any, vi:number) => (
                                          <span key={vi} style={{marginRight:vi<variantes.length-1?6:0}}>
                                            <strong onClick={()=>copyToClipboard(v.amazon_sku)} title="Cliquer pour copier"
                                              style={{color:dark?'#e0e0e0':'#333',cursor:'pointer',background:copiedCode===v.amazon_sku?C.green+'33':'transparent',padding:'1px 3px',borderRadius:3}}>
                                              {copiedCode===v.amazon_sku ? '✓' : v.amazon_sku}
                                            </strong>
                                            <span style={{color:C.yellow,marginLeft:2}}>({v.qty_amazon})</span>
                                            {v.multiplier > 1 && <span style={{color:sub,fontSize:9}}>×{v.multiplier}</span>}
                                            {vi<variantes.length-1 && <span style={{color:sub,margin:'0 2px'}}> + </span>}
                                          </span>
                                        ))}
                                      </span>
                                    </td>
                                    <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:11,maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l.product_name}>{l.product_name||'—'}</td>
                                    <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:C.yellow,fontSize:11}}>{l.qty}</td>
                                    <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:fact?sub:C.green}}>
                                      {l.qty_lautopak || l.qty}
                                      {hasManual && variantes.some((v:any)=>v.multiplier>1) && (
                                        <div style={{fontSize:9,color:sub,fontWeight:400}}>
                                          = {variantes.map((v:any) => v.multiplier > 1 ? `${v.qty_amazon}×${v.multiplier}` : `${v.qty_amazon}`).join(' + ')}
                                        </div>
                                      )}
                                    </td>
                                    <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub,fontSize:11}}>{Number(l.prix_unitaire || 0).toFixed(2)} $</td>
                                    <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800,color:fact?sub:C.blue}}>{fmt$(l.amount)}</td>
                                  </tr>
                                  {hasMultiplePrices && expanded && (
                                    <tr style={{background:dark?'#0a0a0a':'#f5f7fa'}}>
                                      <td colSpan={8} style={{padding:'6px 18px',borderBottom:`1px solid ${bdr}`}}>
                                        <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase',marginBottom:4}}>Détail des ventes par variante Amazon :</div>
                                        <table style={{width:'100%',fontSize:10,borderCollapse:'collapse'}}>
                                          <thead><tr>
                                            <th style={{padding:'3px 8px',textAlign:'left',color:sub,fontSize:9}}>SKU Amazon</th>
                                            <th style={{padding:'3px 8px',textAlign:'right',color:sub,fontSize:9}}>Ventes Amazon</th>
                                            <th style={{padding:'3px 8px',textAlign:'center',color:sub,fontSize:9}}>×Mult.</th>
                                            <th style={{padding:'3px 8px',textAlign:'right',color:sub,fontSize:9}}>Qté LAUTOPAK</th>
                                            <th style={{padding:'3px 8px',textAlign:'right',color:sub,fontSize:9}}>Montant source</th>
                                          </tr></thead>
                                          <tbody>
                                            {variantes.map((v:any, vi:number) => (
                                              <tr key={vi}>
                                                <td style={{padding:'3px 8px',fontFamily:'monospace',fontWeight:700}}>{v.amazon_sku}</td>
                                                <td style={{padding:'3px 8px',textAlign:'right',fontWeight:700,color:C.yellow}}>{v.qty_amazon}</td>
                                                <td style={{padding:'3px 8px',textAlign:'center',color:v.multiplier>1?C.yellow:sub,fontWeight:v.multiplier>1?700:400}}>×{v.multiplier}</td>
                                                <td style={{padding:'3px 8px',textAlign:'right',fontWeight:700,color:C.green}}>{v.qty_lautopak}</td>
                                                <td style={{padding:'3px 8px',textAlign:'right',color:sub}}>{fmt$(v.amount_source)}</td>
                                              </tr>
                                            ))}
                                            <tr style={{fontWeight:800,borderTop:`1px solid ${bdr}`}}>
                                              <td style={{padding:'3px 8px',textAlign:'right',color:sub}}>Total :</td>
                                              <td style={{padding:'3px 8px',textAlign:'right',color:C.yellow}}>{l.qty} ventes</td>
                                              <td></td>
                                              <td style={{padding:'3px 8px',textAlign:'right',color:C.green}}>{l.qty_lautopak} unités</td>
                                              <td style={{padding:'3px 8px',textAlign:'right',color:C.blue}}>{fmt$(l.amount)}</td>
                                            </tr>
                                          </tbody>
                                        </table>
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>)
                              })}
                            </tbody>
                            <tfoot>
                              <tr style={{background:dark?'#1a1a1a':'#f0f0f0'}}>
                                <td colSpan={7} style={{padding:'10px',textAlign:'right',fontWeight:900,borderTop:`2px solid ${bdr}`}}>TOTAL LAUTOPAK (doit = Frais produit {fmt$(lautopakLines.frais_produit_settlement)}) :</td>
                                <td style={{padding:'10px',textAlign:'right',fontWeight:900,fontSize:14,color:Math.abs(lautopakLines.total_calcule - lautopakLines.frais_produit_settlement)<0.01?C.green:C.red,borderTop:`2px solid ${bdr}`}}>{fmt$(lautopakLines.total_calcule)}</td>
                              </tr>
                              {lautopakLines.balance_info && lautopakLines.balance_info.orders_adjustments > 0 && (
                                <tr><td colSpan={8} style={{padding:'6px 10px',fontSize:10,color:sub,fontStyle:'italic'}}>💡 {lautopakLines.balance_info.orders_adjustments} ligne(s) ajustée(s) par ±0,10 $ pour balancer avec le settlement (résiduel : {fmt$(lautopakLines.balance_info.orders_delta_residuel)}).</td></tr>
                              )}
                            </tfoot>
                          </table>
                        </>
                      )
                    })()}

                    {/* Refunds séparés */}
                    {lautopakLines.refunds_lignes && lautopakLines.refunds_lignes.length > 0 && (
                      <>
                        <div style={{padding:'12px 18px 4px',fontSize:11,fontWeight:800,color:C.red,background:dark?'#2b1113':'#fce8e6',marginTop:8}}>
                          🔙 Refunds / Notes de crédit (NE PAS inclure dans la facture LAUTOPAK principale)
                        </div>
                        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                          <thead style={{background:thBg}}><tr>
                            <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>SKU Amazon</th>
                            <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Code Traction</th>
                            <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Produit</th>
                            <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:C.red,borderBottom:`1px solid ${bdr}`}}>Qté refund</th>
                            <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Prix unit.</th>
                            <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:C.red,borderBottom:`1px solid ${bdr}`}}>Montant</th>
                          </tr></thead>
                          <tbody>
                            {lautopakLines.refunds_lignes.map((l:any, i:number) => (
                              <tr key={i} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                                <td onClick={()=>copyToClipboard(l.sku)} title="Cliquer pour copier"
                                    style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700,fontSize:11,cursor:'pointer',background:copiedCode===l.sku?C.green+'33':'transparent',transition:'background .2s'}}>
                                  {copiedCode===l.sku ? '✓ copié' : l.sku}
                                </td>
                                <td onClick={()=>l.traction_code && copyToClipboard(l.traction_code)} title={l.traction_code ? (l.manual_mapping ? 'Multi-mapping manuel · Cliquer pour copier' : 'Cliquer pour copier') : ''}
                                    style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:11,color:l.traction_code?C.blue:C.red,cursor:l.traction_code?'pointer':'default',background:copiedCode===l.traction_code?C.green+'33':'transparent',transition:'background .2s'}}>
                                  {copiedCode===l.traction_code && l.traction_code ? '✓ copié' : (<>
                                    {l.manual_mapping && <span style={{fontSize:9,color:C.green,marginRight:4}}>🔗</span>}
                                    {l.traction_code||'— non mappé'}
                                  </>)}
                                </td>
                                <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:11,maxWidth:280,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l.product_name}>{l.product_name||'—'}</td>
                                <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:C.red}}>-{l.qty}</td>
                                <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub,fontSize:11}}>{Math.abs(l.prix_unitaire).toFixed(2)} $</td>
                                <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800,color:C.red}}>{fmt$(l.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr style={{background:dark?'#1a1a1a':'#f0f0f0'}}>
                              <td colSpan={5} style={{padding:'10px',textAlign:'right',fontWeight:900,borderTop:`2px solid ${bdr}`,color:C.red}}>TOTAL REFUNDS :</td>
                              <td style={{padding:'10px',textAlign:'right',fontWeight:900,fontSize:14,color:C.red,borderTop:`2px solid ${bdr}`}}>{fmt$(lautopakLines.total_refunds)}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })()}

      {/* ═══ Modal DÉTAIL LIGNES d'un document LAUTOPAK v2 ═══ */}
      {docDetailModal && lautopakDocs && (() => {
        const fmt$ = (n: number) => `${n<0?'−':''}${Math.abs(Number(n||0)).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} $`
        const doc = lautopakDocs.docs.find((d: any) => d.doc_type === docDetailModal.doc_type)
        if (!doc) return null
        return (
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}
               onClick={()=>setDocDetailModal(null)}>
            <div onClick={(e:any)=>e.stopPropagation()} style={{background:card,borderRadius:12,maxWidth:900,width:'100%',maxHeight:'92vh',overflow:'hidden',display:'flex',flexDirection:'column',border:`1px solid ${bdr}`}}>
              <div style={{padding:'14px 18px',borderBottom:`1px solid ${bdr}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div>
                  <div style={{fontSize:14,fontWeight:900}}>{doc.label}</div>
                  <div style={{fontSize:11,color:sub,marginTop:2}}>{doc.lignes.length} ligne{doc.lignes.length>1?'s':''} • Total <strong style={{color:doc.total<0?C.red:C.blue}}>{fmt$(doc.total)}</strong></div>
                </div>
                <button onClick={()=>setDocDetailModal(null)}
                  style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'8px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>✕ Fermer</button>
              </div>
              <div style={{overflow:'auto',flex:1}}>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead style={{position:'sticky',top:0,background:thBg,zIndex:1}}>
                    <tr>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>SKU Amazon</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>PKCode Traction</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Produit</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Qté</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Prix unit.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Montant</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.lignes.map((l: any, i: number) => (
                      <tr key={l.sku+i} style={{borderBottom:`1px solid ${bdr}`}}>
                        <td style={{padding:'6px 10px',fontFamily:'monospace',fontWeight:700}}>{l.sku}</td>
                        <td style={{padding:'6px 10px',fontFamily:'monospace',fontSize:11,color:sub}}>{l.pk_code||'—'}</td>
                        <td style={{padding:'6px 10px',fontSize:11,maxWidth:240,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l.product_name||''}>{l.product_name||'—'}</td>
                        <td style={{padding:'6px 10px',textAlign:'right',fontWeight:700,color:l.qty<0?C.red:undefined}}>{l.qty}</td>
                        <td style={{padding:'6px 10px',textAlign:'right',fontFamily:'monospace'}}>{fmt$(l.prix_unitaire||0)}</td>
                        <td style={{padding:'6px 10px',textAlign:'right',fontWeight:700,color:l.amount<0?C.red:C.blue,fontFamily:'monospace'}}>{fmt$(l.amount)}</td>
                        <td style={{padding:'6px 10px',fontSize:10,color:sub}}>{l.notes||''}</td>
                      </tr>
                    ))}
                    <tr style={{background:thBg,borderTop:`2px solid ${bdr}`}}>
                      <td colSpan={5} style={{padding:'8px 10px',fontWeight:900}}>TOTAL</td>
                      <td style={{padding:'8px 10px',textAlign:'right',fontWeight:900,color:doc.total<0?C.red:C.blue,fontFamily:'monospace'}}>{fmt$(doc.total)}</td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{padding:'10px 18px',borderTop:`1px solid ${bdr}`,fontSize:11,color:sub,lineHeight:1.5}}>
                💡 Crée ce document dans LAUTOPAK avec ces lignes (qté × prix unitaire), puis reviens ici saisir le n° de facture obtenu.
              </div>
            </div>
          </div>
        )
      })()}

      {/* ═══ Modal LIGNES FACTURE LAUTOPAK REIMBURSEMENTS (ouverture explicite) ═══ */}
      {showLautopakReimbModal && lautopakReimbLines && (() => {
        const fmt$ = (n: number) => `${n<0?'−':''}${Math.abs(Number(n||0)).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} $`
        return (
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}
               onClick={()=>setShowLautopakReimbModal(false)}>
            <div onClick={(e:any)=>e.stopPropagation()} style={{background:card,borderRadius:12,maxWidth:1000,width:'100%',maxHeight:'92vh',overflow:'hidden',display:'flex',flexDirection:'column',border:`1px solid ${bdr}`}}>
              <div style={{padding:'14px 18px',borderBottom:`1px solid ${bdr}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div>
                  <div style={{fontSize:14,fontWeight:900}}>🧾 Lignes à facturer dans la 2e facture LAUTOPAK (pièces perdues)</div>
                  <div style={{fontSize:11,color:sub,marginTop:2,fontFamily:'monospace'}}>Settlement {lautopakReimbLines.settlement_id}</div>
                </div>
                <button onClick={()=>setShowLautopakReimbModal(false)}
                  style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'8px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>✕ Fermer</button>
              </div>
              <div style={{padding:'10px 18px',background:dark?'#0f0f0f':'#fafbfc',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,lineHeight:1.5}}>
                Ces <strong>{lautopakReimbLines.nb_lignes} lignes</strong> correspondent aux unités physiquement perdues/cassées/retournées non-récupérées, pour lesquelles Amazon t'a remboursé en cash.
                Total à facturer dans LAUTOPAK = <strong style={{color:C.blue}}>{fmt$(lautopakReimbLines.total_facture)}</strong> (= somme des remboursements Amazon).
              </div>
              <div style={{overflow:'auto',flex:1}}>
                {lautopakReimbLines.lignes.length === 0 ? (
                  <div style={{padding:30,textAlign:'center',color:sub,fontSize:13}}>Aucun reimbursement cash — rien à facturer.</div>
                ) : (
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                    <thead style={{position:'sticky',top:0,background:thBg,zIndex:1}}><tr>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:C.green,borderBottom:`1px solid ${bdr}`}}>PKCode (mapping)</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>SKU Amazon (variantes)</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Produit</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Raisons</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:C.yellow,borderBottom:`1px solid ${bdr}`}}>Qté Amz</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:C.green,borderBottom:`1px solid ${bdr}`}}>Qté LAUTOPAK</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Prix unit. (arrondi)</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:C.blue,borderBottom:`1px solid ${bdr}`}}>Montant</th>
                    </tr></thead>
                    <tbody>
                      {lautopakReimbLines.lignes.map((l:any, i:number) => {
                        const variantes = l.variantes || []
                        const hasManual = !!l.manual_mapping
                        return (
                          <tr key={i} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                            <td onClick={()=>l.pk_code && copyToClipboard(l.pk_code)} title={l.pk_code ? 'Cliquer pour copier' : ''}
                                style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:800,fontSize:12,color:hasManual?C.green:C.red,cursor:l.pk_code?'pointer':'default',background:copiedCode===l.pk_code?C.green+'33':'transparent',transition:'background .2s'}}>
                              {copiedCode===l.pk_code && l.pk_code ? '✓ copié' : (<>
                                {hasManual && <span style={{fontSize:9,color:C.green,marginRight:4}}>🔗</span>}
                                {l.pk_code || '—'}
                              </>)}
                            </td>
                            <td style={{padding:'4px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:10,color:sub}}>
                              {variantes.map((v:any, vi:number) => (
                                <span key={vi} style={{marginRight:vi<variantes.length-1?6:0}}>
                                  <strong onClick={()=>copyToClipboard(v.amazon_sku)} title="Cliquer pour copier"
                                    style={{color:dark?'#e0e0e0':'#333',cursor:'pointer',background:copiedCode===v.amazon_sku?C.green+'33':'transparent',padding:'1px 3px',borderRadius:3}}>
                                    {copiedCode===v.amazon_sku ? '✓' : v.amazon_sku}
                                  </strong>
                                  <span style={{color:C.yellow,marginLeft:2}}>({v.qty})</span>
                                  {v.multiplier > 1 && <span style={{color:sub,fontSize:9}}>×{v.multiplier}</span>}
                                  {vi<variantes.length-1 && <span style={{color:sub,margin:'0 2px'}}> + </span>}
                                </span>
                              ))}
                            </td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:11,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l.product_name}>{l.product_name||'—'}</td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:10,maxWidth:140,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l.reason}>{l.reason}</td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:C.yellow,fontSize:11}}>{l.qty}</td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:C.green}}>{l.qty_lautopak || l.qty}</td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub,fontSize:11}}>{Number(l.prix_unitaire||0).toFixed(2)} $</td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800,color:C.blue}}>{fmt$(l.amount||l.montant)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{background:dark?'#1a1a1a':'#f0f0f0'}}>
                        <td colSpan={7} style={{padding:'10px',textAlign:'right',fontWeight:900,borderTop:`2px solid ${bdr}`}}>
                          TOTAL FACTURE LAUTOPAK {lautopakReimbLines.target_settlement != null && `(cible ${fmt$(lautopakReimbLines.target_settlement)})`} :
                        </td>
                        <td style={{padding:'10px',textAlign:'right',fontWeight:900,fontSize:14,color:lautopakReimbLines.balance_ok===false?C.red:C.green,borderTop:`2px solid ${bdr}`}}>
                          {fmt$(lautopakReimbLines.total_facture)} {lautopakReimbLines.balance_ok ? '✓' : ''}
                        </td>
                      </tr>
                      {lautopakReimbLines.adjustments > 0 && (
                        <tr><td colSpan={8} style={{padding:'6px 10px',fontSize:10,color:sub,fontStyle:'italic'}}>💡 {lautopakReimbLines.adjustments} ligne(s) ajustée(s) par ±0,10 $ pour balancer avec le total des cash reimbursements.</td></tr>
                      )}
                    </tfoot>
                  </table>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* ═══ Modal RAPPROCHEMENT RELEVÉ AMAZON ═══ */}
      {releveMatch && (() => {
        const fmt$ = (n: number) => `${n<0?'−':''}${Math.abs(Number(n||0)).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} $`
        // Saisie du relevé papier
        const saisi = (k: string) => {
          const v = parseFloat((releveSaisi[k] || '').replace(',', '.'))
          return isNaN(v) ? null : v
        }
        const ligne = (label: string, calc: number, key: string, composants?: any[], indent = 0, bold = false, neg = false) => {
          const v = saisi(key)
          const diff = v !== null ? Number((calc - v).toFixed(2)) : null
          const hasComp = composants && composants.length > 0
          const open = !!releveExpanded[key]
          return (
            <React.Fragment key={key}>
              <tr style={{background:diff !== null && Math.abs(diff) > 0.01 ? (dark?'#2b1113':'#fce8e6') : 'transparent'}}>
                <td style={{padding:'5px 10px',paddingLeft:10+indent*20,fontWeight:bold?800:400,fontSize:bold?12:11,borderBottom:`1px solid ${bdr}`}}>
                  {hasComp ? (
                    <button onClick={()=>setReleveExpanded(p=>({...p,[key]:!open}))}
                      style={{background:'transparent',border:'none',color:sub,cursor:'pointer',padding:'0 4px 0 0',fontSize:10,fontFamily:'monospace'}}>
                      {open ? '▼' : '▶'}
                    </button>
                  ) : <span style={{display:'inline-block',width:14}}/>}
                  {label}
                  {hasComp && <span style={{marginLeft:6,fontSize:10,color:sub,fontWeight:400}}>({composants!.length})</span>}
                </td>
                <td style={{padding:'5px 10px',textAlign:'right',fontWeight:bold?800:600,fontFamily:'monospace',fontSize:12,borderBottom:`1px solid ${bdr}`,color:neg&&calc<0?C.red:bold?C.blue:'inherit'}}>{fmt$(calc)}</td>
                <td style={{padding:'2px 4px',borderBottom:`1px solid ${bdr}`}}>
                  <input type="text" value={releveSaisi[key] || ''} onChange={e=>setReleveSaisi(p=>({...p,[key]:e.target.value}))}
                    placeholder="saisir..." style={{...S,textAlign:'right',fontSize:11,padding:'4px 6px',width:110,fontFamily:'monospace'}}/>
                </td>
                <td style={{padding:'5px 10px',textAlign:'right',fontWeight:700,fontSize:11,color:diff === null ? sub : Math.abs(diff) < 0.01 ? C.green : C.red,borderBottom:`1px solid ${bdr}`}}>
                  {diff === null ? '—' : Math.abs(diff) < 0.01 ? '✓' : fmt$(diff)}
                </td>
              </tr>
              {hasComp && open && composants!.map((c: any, ci: number) => (
                <tr key={`${key}-c-${ci}`} style={{background:dark?'#0a0a0a':'#fafbfc'}}>
                  <td style={{padding:'3px 10px',paddingLeft:30+indent*20,fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`,fontFamily:'monospace'}}>
                    ↳ {c.amount_description}
                    <span style={{marginLeft:6,fontStyle:'italic'}}>[{c.transaction_type}]</span>
                    <span style={{marginLeft:6,color:sub}}>· {c.count} lignes</span>
                  </td>
                  <td style={{padding:'3px 10px',textAlign:'right',fontFamily:'monospace',fontSize:11,borderBottom:`1px solid ${bdr}`,color:c.total<0?C.red:'inherit'}}>{fmt$(c.total)}</td>
                  <td colSpan={2} style={{borderBottom:`1px solid ${bdr}`}}></td>
                </tr>
              ))}
            </React.Fragment>
          )
        }
        return (
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}
               onClick={()=>{setReleveMatch(null); setReleveSaisi({})}}>
            <div onClick={(e:any)=>e.stopPropagation()} style={{background:card,borderRadius:12,maxWidth:900,width:'100%',maxHeight:'92vh',overflow:'hidden',display:'flex',flexDirection:'column',border:`1px solid ${bdr}`}}>
              <div style={{padding:'14px 18px',borderBottom:`1px solid ${bdr}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div>
                  <div style={{fontSize:14,fontWeight:900}}>🧾 Rapprochement avec le relevé de paiement Amazon</div>
                  <div style={{fontSize:11,color:sub,marginTop:2}}>Saisis les montants de ton relevé imprimé pour vérifier que ton TSV correspond</div>
                </div>
                <button onClick={()=>{setReleveMatch(null); setReleveSaisi({})}}
                  style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'8px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>✕ Fermer</button>
              </div>
              <div style={{overflow:'auto',flex:1,padding:'0 0 14px'}}>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead><tr style={{background:thBg,position:'sticky',top:0}}>
                    <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Catégorie relevé Amazon</th>
                    <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Calculé TSV</th>
                    <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`,width:130}}>Relevé papier</th>
                    <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Écart</th>
                  </tr></thead>
                  <tbody>
                    {/* VENTES */}
                    {ligne('VENTES', releveMatch.ventes.total, 'ventes_total', undefined, 0, true)}
                    {ligne('Frais produit', releveMatch.ventes.frais_produit, 'frais_produit', releveMatch.ventes.frais_produit_composants, 1)}
                    {ligne('Expédition', releveMatch.ventes.expedition, 'expedition_ventes', releveMatch.ventes.expedition_composants, 1)}
                    {ligne('Remboursements de stock (FBA)', releveMatch.ventes.remboursements_stock_fba, 'remb_stock_fba', releveMatch.ventes.remboursements_stock_fba_composants, 1)}

                    {/* REMBOURSEMENTS */}
                    {ligne('REMBOURSEMENTS', releveMatch.remboursements.total, 'remb_total', undefined, 0, true, true)}
                    {ligne('Dépenses remboursées', releveMatch.remboursements.depenses_rembourses, 'depenses_rembourses', releveMatch.remboursements.depenses_rembourses_composants, 1)}
                    {ligne('Ventes remboursées', releveMatch.remboursements.ventes_remboursees_total, 'ventes_remb_total', undefined, 1, false, true)}
                    {ligne('— Expédition', releveMatch.remboursements.ventes_remboursees_expedition, 'ventes_remb_exp', releveMatch.remboursements.ventes_remb_exp_composants, 2, false, true)}
                    {ligne('— Frais produit', releveMatch.remboursements.ventes_remboursees_frais_produit, 'ventes_remb_produit', releveMatch.remboursements.ventes_remb_produit_composants, 2, false, true)}

                    {/* DÉPENSES */}
                    {ligne('DÉPENSES', releveMatch.depenses.total, 'dep_total', undefined, 0, true, true)}
                    {ligne('Rabais promotionnels', releveMatch.depenses.rabais_promotionnels, 'rabais_promo', releveMatch.depenses.rabais_composants, 1, false, true)}
                    {ligne('Frais Expédié par Amazon', releveMatch.depenses.frais_fba_total, 'frais_fba', undefined, 1, false, true)}
                    {ligne('— Frais de stockage mensuels', releveMatch.depenses.frais_fba_stockage, 'frais_fba_stockage', releveMatch.depenses.frais_fba_stockage_composants, 2, false, true)}
                    {ligne('— Autre', releveMatch.depenses.frais_fba_autre, 'frais_fba_autre', releveMatch.depenses.frais_fba_autre_composants, 2, false, true)}
                    {ligne('Prix de la publicité', releveMatch.depenses.publicite, 'publicite', releveMatch.depenses.publicite_composants, 1, false, true)}
                    {ligne('Commissions Amazon', releveMatch.depenses.commissions_amazon, 'commissions', releveMatch.depenses.commissions_composants, 1, false, true)}
                    {ligne('Remboursements inversés (FBA)', releveMatch.depenses.remboursements_inverses_fba, 'remb_inverses', releveMatch.depenses.remb_inverses_composants, 1, false, true)}

                    {/* PROFITS NETS */}
                    <tr><td colSpan={4} style={{padding:6,borderBottom:'none'}}></td></tr>
                    {ligne('PROFITS NETS (dépôt bancaire)', releveMatch.profits_nets_calcules, 'profits_nets', undefined, 0, true)}

                    {releveMatch.non_classes_composants && releveMatch.non_classes_composants.length > 0 && (
                      <>
                        <tr style={{background:dark?'#2b2411':'#fdf6e3'}}>
                          <td colSpan={4} style={{padding:'10px',fontSize:11,color:C.yellow,fontWeight:700}}>
                            ⚠️ {releveMatch.non_classes_composants.length} amount_description{releveMatch.non_classes_composants.length>1?'s':''} non classé{releveMatch.non_classes_composants.length>1?'s':''} — total {fmt$(releveMatch.reste_non_classe)} (probablement à ajouter au mapping d'une catégorie)
                          </td>
                        </tr>
                        {releveMatch.non_classes_composants.map((c:any, i:number) => (
                          <tr key={`nc-${i}`} style={{background:dark?'#1a1408':'#fffbea'}}>
                            <td style={{padding:'4px 10px',paddingLeft:30,fontSize:10,color:C.yellow,fontFamily:'monospace'}}>
                              ↳ {c.amount_description} <span style={{fontStyle:'italic'}}>[{c.transaction_type}]</span> · {c.count} lignes
                            </td>
                            <td style={{padding:'4px 10px',textAlign:'right',fontFamily:'monospace',fontSize:11,color:c.total<0?C.red:C.yellow}}>{fmt$(c.total)}</td>
                            <td colSpan={2}></td>
                          </tr>
                        ))}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{padding:'10px 18px',borderTop:`1px solid ${bdr}`,fontSize:11,color:sub,lineHeight:1.5}}>
                💡 Saisis les montants de ton relevé papier dans les champs à droite. Les lignes où l'écart ≥ 0,01 $ s'affichent en rouge. Quand toutes les lignes sont ✓ vertes, ton TSV correspond à 100% au relevé Amazon.
              </div>
            </div>
          </div>
        )
      })()}

      {/* ═══ Vue MULTI-MAPPING SKU → PKCodes ═══ */}
      {vue === 'multimapping' && (() => {
        // Grouper par amazon_sku
        const q = searchMultimapping.trim().toLowerCase()
        const filtered = multimappingList.filter((m:any) =>
          !q || m.amazon_sku.toLowerCase().includes(q) || m.pk_code.toLowerCase().includes(q)
        )
        const bySku = new Map<string, any[]>()
        for (const m of filtered) {
          if (!bySku.has(m.amazon_sku)) bySku.set(m.amazon_sku, [])
          bySku.get(m.amazon_sku)!.push(m)
        }
        return (
          <div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:12,padding:'14px 16px',marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:800,marginBottom:6}}>🔗 Multi-mapping SKU Amazon → PKCodes Traction</div>
              <div style={{fontSize:11,color:sub,lineHeight:1.6,marginBottom:10}}>
                Associe un SKU Amazon (FBA ou FBM) à UN ou PLUSIEURS PKCodes Traction. Le stock Traction affiché pour ce SKU sera la <strong>somme</strong> des stocks AMA des PKCodes mappés.
                <br/>
                <strong>Multiplicateur</strong> = combien d'unités Traction pour 1 unité Amazon (pack). Exemple : <code style={{background:dark?'#222':'#f0f0f0',padding:'1px 6px',borderRadius:3}}>FBM-78920-4 → FBM-78920 × 4</code> signifie que 1 pack vendu sur Amazon = 4 unités Traction à décrémenter. 10 unités Traction = 2 packs Amazon.
              </div>
              {/* Formulaire ajout */}
              <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'flex-end',marginTop:10}}>
                <div style={{flex:1,minWidth:180}}>
                  <div style={{fontSize:10,color:sub,fontWeight:700,marginBottom:4}}>SKU Amazon</div>
                  <input value={newMappingSku} onChange={e=>setNewMappingSku(e.target.value)} placeholder="ex: FBM-78920-4"
                    style={{...S,fontSize:12,padding:'8px 10px',width:'100%',fontFamily:'monospace'}}/>
                </div>
                <div style={{flex:1,minWidth:180}}>
                  <div style={{fontSize:10,color:sub,fontWeight:700,marginBottom:4}}>PKCode Traction</div>
                  <input value={newMappingPk} onChange={e=>setNewMappingPk(e.target.value)} placeholder="ex: FBM-78920"
                    style={{...S,fontSize:12,padding:'8px 10px',width:'100%',fontFamily:'monospace'}}/>
                </div>
                <button onClick={()=>ajouterMapping(newMappingSku, newMappingPk)} disabled={!newMappingSku.trim() || !newMappingPk.trim()}
                  style={{background:(!newMappingSku.trim()||!newMappingPk.trim())?bdr:C.green,color:'#fff',border:'none',borderRadius:8,padding:'10px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                  ➕ Ajouter (mult = 1)
                </button>
              </div>
              <div style={{fontSize:10,color:sub,marginTop:6}}>Le multiplicateur est fixé à 1 à l'ajout. Tu peux le modifier ensuite en cliquant sur le chiffre dans le tableau.</div>
            </div>

            {/* Recherche */}
            <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:10,display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
              <input value={searchMultimapping} onChange={e=>setSearchMultimapping(e.target.value)} placeholder="🔍 Chercher par SKU ou PKCode..."
                style={{...S,maxWidth:300,fontSize:12,padding:'7px 10px'}}/>
              <div style={{fontSize:11,color:sub,marginLeft:'auto'}}>{multimappingList.length} mappings · {bySku.size} SKU uniques</div>
            </div>

            {/* Tableau groupé par SKU */}
            <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
              {bySku.size === 0 ? (
                <div style={{padding:30,textAlign:'center',color:sub,fontSize:13}}>Aucun mapping. Ajoute le premier ci-dessus.</div>
              ) : (
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead><tr style={{background:thBg}}>
                    <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>SKU Amazon</th>
                    <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>PKCode Traction</th>
                    <th style={{padding:'8px 10px',textAlign:'center',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`,width:110}}>Multiplicateur</th>
                    <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Stock AMA actuel</th>
                    <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Équiv. unités Amazon</th>
                    <th style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,width:60}}></th>
                  </tr></thead>
                  <tbody>
                    {[...bySku.entries()].map(([sku, list]) => (
                      <React.Fragment key={sku}>
                        {list.map((m:any, i:number) => (
                          <tr key={m.id} style={{borderTop:i===0?`2px solid ${bdr}`:'none'}}>
                            {i===0 && <td rowSpan={list.length} style={{padding:'8px 10px',fontFamily:'monospace',fontWeight:800,borderBottom:`1px solid ${bdr}`,verticalAlign:'top',background:dark?'#0f0f0f':'#fafbfc'}}>{sku}<div style={{fontSize:10,color:sub,fontWeight:400,marginTop:3}}>{list.length} PKCode{list.length>1?'s':''}</div></td>}
                            <td style={{padding:'6px 10px',fontFamily:'monospace',borderBottom:`1px solid ${bdr}`}}>{m.pk_code}{m.current_stock_ama==null && <span style={{color:C.yellow,marginLeft:6,fontSize:10}}>(absent feed)</span>}</td>
                            <td style={{padding:'4px 10px',textAlign:'center',borderBottom:`1px solid ${bdr}`}}>
                              <input type="number" min="1" step="1" defaultValue={m.multiplier || 1}
                                onBlur={async(e:any) => {
                                  const v = parseFloat(e.target.value)
                                  if (v > 0 && v !== m.multiplier) {
                                    await fetch('/api/amazon/sku-pkcodes', {
                                      method: 'PATCH',
                                      headers: {'Content-Type':'application/json'},
                                      body: JSON.stringify({ id: m.id, multiplier: v }),
                                    })
                                    await chargerMultimapping()
                                  }
                                }}
                                style={{...S,width:70,textAlign:'center',fontSize:12,padding:'4px 6px',fontWeight:700}}/>
                            </td>
                            <td style={{padding:'6px 10px',textAlign:'right',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{m.current_stock_ama != null ? m.current_stock_ama : <span style={{color:sub}}>—</span>}</td>
                            <td style={{padding:'6px 10px',textAlign:'right',borderBottom:`1px solid ${bdr}`,color:C.blue,fontWeight:700}}>
                              {m.current_stock_ama != null ? Math.floor(m.current_stock_ama / (m.multiplier || 1)) : <span style={{color:sub}}>—</span>}
                              {(m.multiplier || 1) > 1 && <div style={{fontSize:9,color:sub,fontWeight:400}}>÷ {m.multiplier}</div>}
                            </td>
                            <td style={{padding:'6px 10px',textAlign:'center',borderBottom:`1px solid ${bdr}`}}>
                              <button onClick={()=>supprimerMappingMulti(m.id)} title="Supprimer ce mapping"
                                style={{background:'transparent',border:`1px solid ${C.red}`,color:C.red,borderRadius:6,padding:'3px 8px',cursor:'pointer',fontSize:11}}>✕</button>
                            </td>
                          </tr>
                        ))}
                        {/* Ligne totale du SKU si multi */}
                        {list.length > 1 && (() => {
                          const totalEquiv = list.reduce((s:number,m:any) => s + (m.current_stock_ama != null ? Math.floor(m.current_stock_ama / (m.multiplier || 1)) : 0), 0)
                          return (
                            <tr style={{background:dark?'#0d2a18':'#e6f4ea',fontWeight:700}}>
                              <td colSpan={4} style={{padding:'6px 10px',textAlign:'right',fontSize:11,color:C.green,borderBottom:`1px solid ${bdr}`}}>Total équiv. unités Amazon pour ce SKU :</td>
                              <td style={{padding:'6px 10px',textAlign:'right',fontSize:13,color:C.green,borderBottom:`1px solid ${bdr}`}}>{totalEquiv}</td>
                              <td style={{borderBottom:`1px solid ${bdr}`}}></td>
                            </tr>
                          )
                        })()}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )
      })()}

      {/* ═══ Vue SUIVI UNSELLABLE ═══ */}
      {/* ═══ Vue PROFITABILITÉ par settlement ═══ */}
      {vue === 'profitabilite' && (() => {
        const fmt$ = (n: number) => `${Number(n||0).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} $`
        const transportByPk = new Map(coutsTransport.map((c:any)=>[c.pk_code, Number(c.cout_unitaire)]))
        return (
          <div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'14px 16px',marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                <div>
                  <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>💰 Profitabilité par PKCode</div>
                  <div style={{fontSize:11,color:sub,maxWidth:680,lineHeight:1.5}}>
                    Marge par produit pour un settlement : Revenu − Coûtant Traction − Commissions Amazon − FBA Fees − Pub (au prorata) − Transport (saisi manuellement). Drill-down sur les variantes Amazon (packs) en cliquant sur une ligne.
                  </div>
                </div>
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <span style={{fontSize:11,color:sub}}>Settlement :</span>
                  <select value={profitSettlementId} onChange={e=>chargerProfitabilite(e.target.value)}
                    style={{...S,fontSize:12,padding:'8px 10px',minWidth:180}}>
                    <option value="">— choisir —</option>
                    {closureList.map((s:any)=>(
                      <option key={s.settlement_id} value={s.settlement_id}>
                        {s.settlement_id} ({String(s.settlement_start||'').split('T')[0]} → {String(s.settlement_end||'').split('T')[0]})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {!profitabiliteData && (
              <div style={{textAlign:'center',padding:30,color:sub,fontSize:13}}>
                Sélectionne un settlement ci-dessus pour voir la profitabilité par PKCode.
              </div>
            )}

            {profitabiliteData && (() => {
              const t = profitabiliteData.totaux
              const nbSansCoutant = profitabiliteData.nb_skus_sans_coutant || 0
              return (
                <>
                  {nbSansCoutant > 0 && (
                    <div style={{background:dark?'#2b1113':'#fce8e6',border:`1px solid ${C.red}`,borderRadius:8,padding:'10px 14px',marginBottom:12,fontSize:12,color:C.red,display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                      <span style={{fontSize:18}}>⚠️</span>
                      <div style={{flex:1,minWidth:200}}>
                        <strong>{nbSansCoutant} SKU{nbSansCoutant>1?'s':''} sans coûtant Traction</strong> — la marge calculée pour ces lignes est faussée (= 100% revenu).
                        Vérifie dans Traction que le prix coûtant est bien renseigné, ou pour les nouveautés non encore syncées tu peux faire « 🔄 Sync Traction ».
                      </div>
                      <details style={{fontSize:11}}>
                        <summary style={{cursor:'pointer',color:C.red,fontWeight:700}}>Voir la liste</summary>
                        <div style={{marginTop:6,maxHeight:120,overflowY:'auto',background:dark?'#1a1a1a':'#fff',padding:'6px 10px',borderRadius:6,fontFamily:'monospace',fontSize:10,lineHeight:1.6}}>
                          {(profitabiliteData.skus_sans_coutant || []).join(', ')}
                        </div>
                      </details>
                    </div>
                  )}
                  {/* Totaux */}
                  <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(6,1fr)',gap:8,marginBottom:14}}>
                    <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
                      <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Ventes net</div>
                      <div style={{fontSize:18,fontWeight:900,color:C.blue}}>{fmt$(t.ventes_net)}</div>
                      <div style={{fontSize:10,color:sub}}>{t.qty_lautopak} unités</div>
                    </div>
                    <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.red}`}}>
                      <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Coûtant</div>
                      <div style={{fontSize:18,fontWeight:900,color:C.red}}>{fmt$(t.coutant)}</div>
                    </div>
                    <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.red}`}}>
                      <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Commissions</div>
                      <div style={{fontSize:18,fontWeight:900,color:C.red}}>{fmt$(t.commissions)}</div>
                    </div>
                    <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.red}`}}>
                      <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>FBA + Pub</div>
                      <div style={{fontSize:18,fontWeight:900,color:C.red}}>{fmt$(t.fba_fees + t.pub)}</div>
                    </div>
                    <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.yellow}`}}>
                      <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Transport</div>
                      <div style={{fontSize:18,fontWeight:900,color:C.yellow}}>{fmt$(t.transport)}</div>
                    </div>
                    <div style={{background:card,border:`2px solid ${t.marge_brute>=0?C.green:C.red}`,borderRadius:10,padding:'10px 12px'}}>
                      <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Marge brute</div>
                      <div style={{fontSize:18,fontWeight:900,color:t.marge_brute>=0?C.green:C.red}}>{fmt$(t.marge_brute)}</div>
                      <div style={{fontSize:10,color:sub}}>{t.marge_pct != null ? `${t.marge_pct}%` : '—'}</div>
                    </div>
                  </div>

                  {/* Tableau des PKCode */}
                  <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden'}}>
                    <div style={{overflowX:'auto'}}>
                      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                        <thead style={{background:thBg}}>
                          <tr>
                            <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`,width:40}}></th>
                            <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>PKCode</th>
                            <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Produit</th>
                            <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Qté</th>
                            <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Ventes</th>
                            <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Coûtant</th>
                            <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Comm.</th>
                            <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>FBA+Pub</th>
                            <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Transport $/u</th>
                            <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Marge $</th>
                            <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Marge %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {profitabiliteData.lignes.map((l: any, i: number) => {
                            const isExp = drilldownPk === l.pk_code
                            const transportSaisi = transportByPk.get(l.pk_code)
                            return (
                              <React.Fragment key={l.pk_code+i}>
                                <tr onClick={()=>setDrilldownPk(isExp?null:l.pk_code)}
                                  style={{borderBottom:`1px solid ${bdr}`,cursor:'pointer',background:isExp?(dark?'#1a233a':'#e8f0fe'):'transparent'}}
                                  onMouseEnter={(e:any)=>!isExp && (e.currentTarget.style.background=hvr)}
                                  onMouseLeave={(e:any)=>!isExp && (e.currentTarget.style.background='transparent')}>
                                  <td style={{padding:'6px 10px',color:sub}}>{l.nb_variantes>1 ? (isExp?'▼':'▶') : ''}</td>
                                  <td style={{padding:'6px 10px',fontFamily:'monospace',fontWeight:700}}>{l.pk_code}</td>
                                  <td style={{padding:'6px 10px',fontSize:11,maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l.product_name||''}>{l.product_name||'—'}</td>
                                  <td style={{padding:'6px 10px',textAlign:'right',fontWeight:700}}>{l.qty_lautopak}{l.qty_refund>0&&<span style={{color:C.red,fontSize:10}}>(−{l.qty_refund})</span>}</td>
                                  <td style={{padding:'6px 10px',textAlign:'right',color:C.blue,fontFamily:'monospace'}}>{fmt$(l.ventes_net)}</td>
                                  <td style={{padding:'6px 10px',textAlign:'right',color:l.coutant_manquant?C.yellow:l.coutant_source==='manuel'?C.yellow:C.red,fontFamily:'monospace',background:l.coutant_manquant?(dark?'#2b2411':'#fff8e1'):undefined,cursor:'pointer'}}
                                      onClick={(e:any)=>{e.stopPropagation();setEditingCoutant({pk_code:l.pk_code,cout:String(l.coutant_unitaire||''),source:l.coutant_source})}}
                                      title={l.coutant_manquant ? '⚠ Pas de coûtant trouvé. Clique pour saisir manuellement.' : l.coutant_source==='manuel' ? `✏️ Coûtant manuel : ${l.coutant_unitaire} $/u (clique pour modifier)` : `Coûtant Traction : ${l.coutant_unitaire} $/u (clique pour overrider manuellement)`}>
                                    {l.coutant_manquant ? <span>⚠ + saisir</span> : (
                                      <>
                                        {l.coutant_source==='manuel' && <span style={{fontSize:9}}>✏️ </span>}
                                        {fmt$(l.coutant)}
                                      </>
                                    )}
                                  </td>
                                  <td style={{padding:'6px 10px',textAlign:'right',color:C.red,fontFamily:'monospace',fontSize:11}}>{fmt$(l.commissions)}</td>
                                  <td style={{padding:'6px 10px',textAlign:'right',color:C.red,fontFamily:'monospace',fontSize:11}}>{fmt$(l.fba_fees+l.pub)}</td>
                                  <td style={{padding:'6px 10px',textAlign:'right'}} onClick={(e:any)=>{e.stopPropagation();setEditingTransport({pk_code:l.pk_code,cout:String(transportSaisi||'')})}}>
                                    {transportSaisi !== undefined ? (
                                      <span style={{color:C.yellow,fontFamily:'monospace',fontWeight:700,cursor:'pointer'}}>{fmt$(transportSaisi)}</span>
                                    ) : (
                                      <span style={{color:sub,fontSize:10,fontStyle:'italic',cursor:'pointer',textDecoration:'underline'}}>+ saisir</span>
                                    )}
                                  </td>
                                  <td style={{padding:'6px 10px',textAlign:'right',fontWeight:800,color:l.marge_brute>=0?C.green:C.red,fontFamily:'monospace'}}>{fmt$(l.marge_brute)}</td>
                                  <td style={{padding:'6px 10px',textAlign:'right',fontWeight:800,color:l.marge_pct!=null?(l.marge_pct>=20?C.green:l.marge_pct>=10?C.yellow:C.red):sub}}>
                                    {l.marge_pct != null ? `${l.marge_pct}%` : '—'}
                                  </td>
                                </tr>
                                {isExp && l.variantes && l.variantes.length > 0 && (
                                  <tr style={{background:dark?'#0d0d0d':'#fafbfc',borderBottom:`1px solid ${bdr}`}}>
                                    <td colSpan={11} style={{padding:'8px 14px'}}>
                                      <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase',marginBottom:4}}>Variantes Amazon regroupées sous ce PKCode</div>
                                      <table style={{width:'100%',fontSize:11}}>
                                        <thead><tr>
                                          <th style={{padding:'4px 8px',textAlign:'left',color:sub}}>SKU Amazon</th>
                                          <th style={{padding:'4px 8px',textAlign:'right',color:sub}}>Qté Amazon</th>
                                          <th style={{padding:'4px 8px',textAlign:'right',color:sub}}>Multiplier</th>
                                          <th style={{padding:'4px 8px',textAlign:'right',color:sub}}>Qté Traction</th>
                                          <th style={{padding:'4px 8px',textAlign:'right',color:sub}}>Revenu</th>
                                          <th style={{padding:'4px 8px',textAlign:'right',color:sub}}>Refunds</th>
                                        </tr></thead>
                                        <tbody>
                                          {l.variantes.map((v:any) => (
                                            <tr key={v.amazon_sku}>
                                              <td style={{padding:'3px 8px',fontFamily:'monospace',fontWeight:700}}>{v.amazon_sku}</td>
                                              <td style={{padding:'3px 8px',textAlign:'right'}}>{v.qty_amazon}</td>
                                              <td style={{padding:'3px 8px',textAlign:'right',color:C.yellow,fontWeight:700}}>×{v.multiplier}</td>
                                              <td style={{padding:'3px 8px',textAlign:'right',fontWeight:700}}>{v.qty_amazon * v.multiplier}</td>
                                              <td style={{padding:'3px 8px',textAlign:'right',color:C.blue,fontFamily:'monospace'}}>{fmt$(v.revenu)}</td>
                                              <td style={{padding:'3px 8px',textAlign:'right',color:C.red,fontFamily:'monospace'}}>{v.refunds<0?fmt$(v.refunds):'—'}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Modal saisie coûtant manuel */}
                  {editingCoutant && (
                    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}
                         onClick={()=>setEditingCoutant(null)}>
                      <div onClick={(e:any)=>e.stopPropagation()} style={{background:card,borderRadius:12,maxWidth:480,width:'100%',border:`2px solid ${C.red}`,padding:18}}>
                        <div style={{fontSize:14,fontWeight:900,marginBottom:6,color:C.red}}>💰 Coûtant unitaire manuel</div>
                        <div style={{fontSize:11,color:sub,marginBottom:14,lineHeight:1.5}}>
                          PKCode : <code style={{background:dark?'#222':'#eee',padding:'2px 6px',borderRadius:4,fontFamily:'monospace'}}>{editingCoutant.pk_code}</code><br/>
                          {editingCoutant.source === 'manuel' ? (
                            <span>Tu as déjà saisi un coûtant manuel pour ce PKCode. Modification ci-dessous.</span>
                          ) : editingCoutant.source === 'aucun' ? (
                            <span>Aucun coûtant trouvé dans Traction. Saisis-le manuellement ici.</span>
                          ) : (
                            <span>Coûtant actuel issu de Traction. Saisir une valeur ici override Traction.</span>
                          )}
                        </div>
                        <input type="number" step="0.01" value={editingCoutant.cout}
                          onChange={e=>setEditingCoutant({...editingCoutant, cout:e.target.value})}
                          placeholder="0,00" autoFocus
                          style={{...S,fontSize:14,padding:'10px 12px',width:'100%',marginBottom:14}}/>
                        <div style={{display:'flex',gap:8,justifyContent:'space-between',flexWrap:'wrap'}}>
                          <div>
                            {editingCoutant.source === 'manuel' && (
                              <button onClick={async()=>{
                                await effacerCoutantManuel(editingCoutant.pk_code)
                                setEditingCoutant(null)
                              }}
                                style={{background:'transparent',border:`1px solid ${C.red}`,color:C.red,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                                🗑 Retirer (utiliser Traction)
                              </button>
                            )}
                          </div>
                          <div style={{display:'flex',gap:8}}>
                            <button onClick={()=>setEditingCoutant(null)}
                              style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                              Annuler
                            </button>
                            <button onClick={async()=>{
                              const c = Number(editingCoutant.cout)
                              if (isNaN(c) || c <= 0) { alert('Coûtant invalide (doit être > 0)'); return }
                              await saisirCoutant(editingCoutant.pk_code, c)
                              setEditingCoutant(null)
                            }}
                              style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                              ✓ Enregistrer
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Modal saisie coût transport */}
                  {editingTransport && (
                    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}
                         onClick={()=>setEditingTransport(null)}>
                      <div onClick={(e:any)=>e.stopPropagation()} style={{background:card,borderRadius:12,maxWidth:420,width:'100%',border:`2px solid ${C.yellow}`,padding:18}}>
                        <div style={{fontSize:14,fontWeight:900,marginBottom:6,color:C.yellow}}>🚚 Coût de transport unitaire</div>
                        <div style={{fontSize:11,color:sub,marginBottom:14,lineHeight:1.5}}>
                          PKCode : <code style={{background:dark?'#222':'#eee',padding:'2px 6px',borderRadius:4,fontFamily:'monospace'}}>{editingTransport.pk_code}</code><br/>
                          Coût par unité physique (vers FBA pour les FBA-, livraison client pour les FBM-).
                        </div>
                        <input type="number" step="0.01" value={editingTransport.cout}
                          onChange={e=>setEditingTransport({...editingTransport, cout:e.target.value})}
                          placeholder="0,00"
                          style={{...S,fontSize:14,padding:'10px 12px',width:'100%',marginBottom:14}}/>
                        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
                          <button onClick={()=>setEditingTransport(null)}
                            style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                            Annuler
                          </button>
                          <button onClick={async()=>{
                            const c = Number(editingTransport.cout)
                            if (isNaN(c) || c < 0) { alert('Coût invalide'); return }
                            await saisirCoutTransport(editingTransport.pk_code, c)
                            setEditingTransport(null)
                          }}
                            style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                            ✓ Enregistrer
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        )
      })()}

      {/* ═══ Vue PRÉVISIONNEL DE VENTE ═══ */}
      {vue === 'forecast' && (() => {
        const fmt$ = (n: number) => `${Number(n||0).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} $`
        if (!forecastData) return <div style={{textAlign:'center',padding:30,color:sub}}>⏳ Chargement...</div>
        const confLabels: Record<string, { label: string; color: string }> = {
          'aucune': { label: 'Aucune donnée', color: C.red },
          'low': { label: 'Faible (< 30j)', color: C.red },
          'medium': { label: 'Moyenne (30-90j)', color: C.yellow },
          'high': { label: 'Bonne (90-180j)', color: C.green },
          'very-high': { label: 'Très bonne (180j+)', color: C.green },
        }
        const conf = confLabels[forecastData.confiance] || { label: forecastData.confiance, color: sub }
        return (
          <div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'14px 16px',marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:800,marginBottom:6}}>📈 Prévisionnel de vente par PKCode</div>
              <div style={{fontSize:11,color:sub,lineHeight:1.5,marginBottom:10}}>
                Calcul basé sur l'historique des settlements importés. Plus tu auras de settlements, plus la prévision sera fiable.
                Le système s'auto-ajuste à chaque nouveau settlement importé.
              </div>
              <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(4,1fr)',gap:8}}>
                <div style={{background:dark?'#0f0f0f':'#fafbfc',borderRadius:8,padding:'8px 12px'}}>
                  <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Settlements</div>
                  <div style={{fontSize:18,fontWeight:900}}>{forecastData.nb_settlements}</div>
                </div>
                <div style={{background:dark?'#0f0f0f':'#fafbfc',borderRadius:8,padding:'8px 12px'}}>
                  <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Jours d'historique</div>
                  <div style={{fontSize:18,fontWeight:900}}>{forecastData.jours_historique}</div>
                </div>
                <div style={{background:dark?'#0f0f0f':'#fafbfc',borderRadius:8,padding:'8px 12px'}}>
                  <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Confiance</div>
                  <div style={{fontSize:14,fontWeight:900,color:conf.color}}>{conf.label}</div>
                </div>
                <div style={{background:dark?'#0f0f0f':'#fafbfc',borderRadius:8,padding:'8px 12px'}}>
                  <div style={{fontSize:10,color:sub,fontWeight:700,textTransform:'uppercase'}}>Produits suivis</div>
                  <div style={{fontSize:18,fontWeight:900}}>{forecastData.lignes.length}</div>
                </div>
              </div>
            </div>

            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden'}}>
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead style={{background:thBg}}>
                    <tr>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>PKCode</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Produit</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Historique total</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Vente moy/jour</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`,background:C.blue+'22'}}>Prév. 30j</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`,background:C.blue+'22'}}>Prév. 60j</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`,background:C.blue+'22'}}>Prév. 90j</th>
                      <th style={{padding:'8px 10px',textAlign:'center',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Stabilité</th>
                    </tr>
                  </thead>
                  <tbody>
                    {forecastData.lignes.map((l: any, i: number) => {
                      const stab = l.coefficient_variation
                      const stabColor = stab === null ? sub : stab < 0.3 ? C.green : stab < 0.7 ? C.yellow : C.red
                      const stabLabel = stab === null ? 'N/A' : stab < 0.3 ? 'Stable' : stab < 0.7 ? 'Variable' : 'Erratique'
                      return (
                        <tr key={l.pk_code+i} style={{borderBottom:`1px solid ${bdr}`}}>
                          <td style={{padding:'6px 10px',fontFamily:'monospace',fontWeight:700}}>{l.pk_code}</td>
                          <td style={{padding:'6px 10px',fontSize:11,maxWidth:240,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l.product_name||''}>{l.product_name||'—'}</td>
                          <td style={{padding:'6px 10px',textAlign:'right',fontWeight:700}}>{l.qty_historique}</td>
                          <td style={{padding:'6px 10px',textAlign:'right',color:sub,fontFamily:'monospace'}}>{l.vente_moy_par_jour}</td>
                          <td style={{padding:'6px 10px',textAlign:'right',fontWeight:800,color:C.blue,background:C.blue+'11'}}>{l.prevision_30j}</td>
                          <td style={{padding:'6px 10px',textAlign:'right',fontWeight:700,color:C.blue,background:C.blue+'11'}}>{l.prevision_60j}</td>
                          <td style={{padding:'6px 10px',textAlign:'right',fontWeight:700,color:C.blue,background:C.blue+'11'}}>{l.prevision_90j}</td>
                          <td style={{padding:'6px 10px',textAlign:'center'}}>
                            <span style={{background:stabColor+'22',color:stabColor,padding:'2px 6px',borderRadius:6,fontSize:10,fontWeight:700}}>{stabLabel}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )
      })()}

      {vue === 'unsellable_suivi' && (() => {
        const data = unsellableSuivi
        if (!data) return <div style={{textAlign:'center',padding:40,color:sub}}>⏳ Chargement...</div>
        const actions = data.actions || []
        const stats = data.stats || {}
        const filtered = actions.filter((a:any) => {
          if (filtUnsellableStatut === 'en_attente' && a.statut !== 'en_attente') return false
          if (filtUnsellableStatut === 'resolu' && !['resolu','resolu_reimb'].includes(a.statut)) return false
          return true
        })
        const statutBadge: Record<string, {label: string; color: string}> = {
          resolu_case_match: {label:'✅ Case matché',   color:C.green},
          resolu:            {label:'✅ Résolu',         color:C.green},
          resolu_reimb:      {label:'✅ Reimbursé',      color:C.green},
          partiel_reimb:     {label:'⚠ Partiel remb.',  color:C.yellow},
          en_attente:        {label:'⏳ En attente',     color:C.red},
        }
        const fmtDate = (d:string|null) => d ? String(d).split('T')[0] : '—'
        const fmt$ = (n:number) => `${Number(n||0).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} $`
        return (
          <div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:12,padding:'14px 16px',marginBottom:12}}>
              <div style={{fontSize:14,fontWeight:800,marginBottom:6}}>🔥 Suivi historique des unsellable (toutes périodes)</div>
              <div style={{fontSize:11,color:sub,lineHeight:1.5}}>
                Liste de toutes les actions enregistrées à l'étape 3 de chaque fermeture de settlement.
                Statut déduit automatiquement :
                <strong style={{color:C.green}}> ✅ Résolu</strong> si plus d'unsellable dans le dernier snapshot FBA,
                <strong style={{color:C.green}}> ✅ Reimbursé</strong> si Amazon a remboursé après l'action,
                <strong style={{color:C.yellow}}> ⚠ Partiel</strong> si remboursement partiel,
                <strong style={{color:C.red}}> ⏳ En attente</strong> sinon.
                {data.last_snapshot_date && <> Dernier snapshot FBA : <strong>{data.last_snapshot_date}</strong>.</>}
              </div>
            </div>

            {/* Stats cards */}
            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(5,1fr)',gap:8,marginBottom:12}}>
              <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${sub}`}}>
                <div style={{fontSize:10,fontWeight:700,color:sub,textTransform:'uppercase'}}>Total actions</div>
                <div style={{fontSize:20,fontWeight:900}}>{stats.total||0}</div>
              </div>
              <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.green}`}}>
                <div style={{fontSize:10,fontWeight:700,color:sub,textTransform:'uppercase'}}>Résolus</div>
                <div style={{fontSize:20,fontWeight:900,color:C.green}}>{stats.resolu||0}</div>
              </div>
              <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.red}`}}>
                <div style={{fontSize:10,fontWeight:700,color:sub,textTransform:'uppercase'}}>En attente</div>
                <div style={{fontSize:20,fontWeight:900,color:C.red}}>{stats.en_attente||0}</div>
              </div>
              <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
                <div style={{fontSize:10,fontWeight:700,color:sub,textTransform:'uppercase'}}>Type d'actions</div>
                <div style={{fontSize:12,fontWeight:700}}>📦 {stats.par_action?.removal||0} · 📋 {stats.par_action?.case||0} · ⏭ {stats.par_action?.skip||0}</div>
              </div>
              <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.green}`}}>
                <div style={{fontSize:10,fontWeight:700,color:sub,textTransform:'uppercase'}}>$ remboursé cumulé</div>
                <div style={{fontSize:16,fontWeight:900,color:C.green}}>{fmt$(stats.total_reimb_cumule||0)}</div>
              </div>
            </div>

            {/* Filtres */}
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 14px',marginBottom:10,display:'flex',gap:6,flexWrap:'wrap'}}>
              {[
                {id:'tous', label:`Tous (${actions.length})`, color:sub},
                {id:'en_attente', label:`⏳ En attente (${stats.en_attente||0})`, color:C.red},
                {id:'resolu', label:`✅ Résolus (${stats.resolu||0})`, color:C.green},
              ].map((f:any) => (
                <button key={f.id} onClick={()=>setFiltUnsellableStatut(f.id)}
                  style={{padding:'6px 11px',borderRadius:14,border:`1px solid ${filtUnsellableStatut===f.id?f.color:bdr}`,background:filtUnsellableStatut===f.id?f.color+'22':'transparent',color:filtUnsellableStatut===f.id?f.color:sub,fontWeight:700,cursor:'pointer',fontSize:11}}>
                  {f.label}
                </button>
              ))}
              <button onClick={chargerUnsellableSuivi}
                style={{padding:'6px 11px',borderRadius:14,border:`1px solid ${bdr}`,background:'transparent',color:sub,fontWeight:700,cursor:'pointer',fontSize:11,marginLeft:'auto'}}>
                🔄 Rafraîchir
              </button>
            </div>

            {/* Tableau */}
            <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
              {filtered.length === 0 ? (
                <div style={{padding:30,textAlign:'center',color:sub,fontSize:13}}>Aucune action unsellable enregistrée</div>
              ) : (
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                    <thead><tr style={{background:thBg}}>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Statut</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Settlement</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>SKU</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Traction</th>
                      <th style={{padding:'8px 10px',textAlign:'center',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Action</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Réf. Amazon</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Date action</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Qté encore unsell.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:C.green,borderBottom:`1px solid ${bdr}`}}>$ reimbursé</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Notes</th>
                    </tr></thead>
                    <tbody>
                      {filtered.map((a:any,i:number) => {
                        const b = statutBadge[a.statut] || statutBadge.en_attente
                        const iconAction = a.action_type==='removal'?'📦':a.action_type==='case'?'📋':a.action_type==='skip'?'⏭':'—'
                        return (
                          <tr key={i} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`}}>
                              <span style={{background:b.color+'22',color:b.color,padding:'2px 7px',borderRadius:8,fontSize:10,fontWeight:700,whiteSpace:'nowrap'}}>{b.label}</span>
                            </td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:10}}>
                              {a.settlement_id}
                              {a.settlement_end && <div style={{fontSize:9,color:sub}}>{fmtDate(a.settlement_end)}</div>}
                            </td>
                            <td onClick={()=>copyToClipboard(a.sku)} title="Cliquer pour copier"
                                style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700,cursor:'pointer',background:copiedCode===a.sku?C.green+'33':'transparent'}}>
                              {copiedCode===a.sku ? '✓ copié' : a.sku}
                            </td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',color:a.traction_code?C.blue:sub,fontSize:10}}>{a.traction_code||'—'}</td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{iconAction} {a.action_type||'—'}</td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:10,color:sub}}>
                              {a.amazon_ref||'—'}
                              {a.has_case_match && <div style={{fontSize:9,color:C.green,fontWeight:700,marginTop:2}}>🔗 Case matché</div>}
                            </td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:10}}>{fmtDate(a.action_le)}{a.action_par && <div style={{fontSize:9}}>{a.action_par}</div>}</td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:a.still_unsellable_qty>0?C.red:C.green}}>{a.still_unsellable_qty||0}</td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:a.total_reimb_ulterieur>0?C.green:sub}}>{a.total_reimb_ulterieur>0?fmt$(a.total_reimb_ulterieur):'—'}</td>
                            <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:10,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={a.notes}>{a.notes||'—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* ═══ Vue ARCHIVES SKU ═══ */}
      {vue === 'archives' && (
        <div>
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'14px 16px',marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:800,marginBottom:4}}>🗄 Archives SKU Traction</div>
            <div style={{fontSize:11,color:sub,lineHeight:1.5}}>
              Pk_codes qui existaient dans le feed Traction et qui n'y sont plus (renommés ou supprimés). Gardés en historique pour la traçabilité.
              Si un code réapparait, il sort automatiquement de cette liste.
            </div>
          </div>
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden'}}>
            {archivesList.length === 0 ? (
              <div style={{padding:30,textAlign:'center',color:sub,fontSize:13}}>Aucun SKU archivé</div>
            ) : (
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead><tr style={{background:thBg}}>
                  <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>PKCode</th>
                  <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Code ligne</th>
                  <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Description (dernière)</th>
                  <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Dernière qté</th>
                  <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Coût</th>
                  <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:sub,borderBottom:`1px solid ${bdr}`}}>Disparu le</th>
                </tr></thead>
                <tbody>
                  {archivesList.map((a:any) => (
                    <tr key={a.id}>
                      <td style={{padding:'6px 10px',fontFamily:'monospace',fontWeight:700,borderBottom:`1px solid ${bdr}`}}>{a.pk_code}</td>
                      <td style={{padding:'6px 10px',color:sub,borderBottom:`1px solid ${bdr}`}}>{a.code_ligne}</td>
                      <td style={{padding:'6px 10px',color:sub,borderBottom:`1px solid ${bdr}`,maxWidth:300,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{a.last_desc_fra||'—'}</td>
                      <td style={{padding:'6px 10px',textAlign:'right',borderBottom:`1px solid ${bdr}`}}>{a.last_qty_dispo}</td>
                      <td style={{padding:'6px 10px',textAlign:'right',color:sub,borderBottom:`1px solid ${bdr}`}}>{Number(a.last_prix_coutant||0).toFixed(2)} $</td>
                      <td style={{padding:'6px 10px',color:sub,fontSize:10,borderBottom:`1px solid ${bdr}`}}>{String(a.first_disappeared_at).split('T')[0]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ═══ Vue RAPPORT (imprimable) ═══ */}
      {vue === 'rapport' && rapportData && (() => {
        const r = rapportData
        const fmt$ = (n: number) => `${n<0?'−':''}${Math.abs(Number(n||0)).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} $`
        const fmtDate = (d: string | null) => d ? String(d).split('T')[0] : '—'
        return (
          <div className="scoa-rapport-wrapper">
            <style>{`
              @media print {
                body { background: #fff !important; }
                .scoa-no-print { display: none !important; }
                .scoa-rapport { box-shadow: none !important; margin: 0 !important; padding: 10mm !important; border: none !important; }
                .scoa-rapport table { page-break-inside: auto; }
                .scoa-rapport tr { page-break-inside: avoid; page-break-after: auto; }
                .scoa-rapport h1, .scoa-rapport h2, .scoa-rapport h3 { page-break-after: avoid; }
              }
              .scoa-rapport { background: #fff; color: #000; padding: 28px 32px; max-width: 900px; margin: 0 auto; font-family: 'DM Sans', Arial, sans-serif; font-size: 12px; line-height: 1.5; }
              .scoa-rapport h1 { font-size: 22px; margin: 0 0 4px; }
              .scoa-rapport h2 { font-size: 15px; margin: 22px 0 8px; border-bottom: 2px solid #000; padding-bottom: 4px; }
              .scoa-rapport h3 { font-size: 13px; margin: 14px 0 6px; }
              .scoa-rapport table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; }
              .scoa-rapport th, .scoa-rapport td { padding: 5px 8px; border-bottom: 1px solid #ddd; text-align: left; }
              .scoa-rapport th { background: #f4f4f4; font-size: 10px; text-transform: uppercase; }
              .scoa-rapport .num { text-align: right; font-family: monospace; }
              .scoa-rapport .tot-row { font-weight: 800; border-top: 2px solid #000; }
              .scoa-rapport .bloc-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px; margin: 10px 0 20px; }
              .scoa-rapport .bloc-meta div { background: #f8f8f8; padding: 8px 10px; border: 1px solid #ddd; }
              .scoa-rapport .bloc-meta strong { display: block; font-size: 10px; text-transform: uppercase; color: #555; }
            `}</style>

            {/* Barre d'action (non imprimée) */}
            <div className="scoa-no-print" style={{maxWidth:900,margin:'0 auto 12px',display:'flex',gap:8,justifyContent:'space-between',flexWrap:'wrap'}}>
              <button onClick={()=>{setVue('fermeture'); setRapportData(null)}}
                style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                ← Retour
              </button>
              <div style={{display:'flex',gap:8}}>
                <button onClick={()=>exporterRapportXlsx(r)}
                  style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                  📊 Export Excel
                </button>
                <button onClick={()=>window.print()}
                  style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                  🖨 Imprimer / PDF
                </button>
              </div>
            </div>

            {/* Contenu rapport */}
            <div className="scoa-rapport" style={{border:`1px solid ${bdr}`,boxShadow:dark?'none':'0 2px 12px rgba(0,0,0,.06)'}}>
              <h1>Rapport de fermeture Amazon — Settlement</h1>
              <div style={{fontSize:11,color:'#666',marginBottom:6}}>Généré le {fmtDate(r.genere_le)}</div>

              <div className="bloc-meta">
                <div><strong>Settlement ID</strong>{r.settlement.settlement_id}</div>
                <div><strong>Période</strong>{fmtDate(r.settlement.settlement_start)} → {fmtDate(r.settlement.settlement_end)}</div>
                <div><strong>Date de dépôt</strong>{fmtDate(r.settlement.deposit_date)}</div>
                <div><strong>Dépôt bancaire</strong>{fmt$(r.settlement.total_amount)}</div>
                <div><strong>Statut</strong>{r.settlement.closed_at ? `🔒 Fermé le ${fmtDate(r.settlement.closed_at)} par ${r.settlement.closed_by}` : '⏳ En cours'}</div>
                <div></div>
              </div>

              {/* ═══════════════ WORKFLOW v2 — 5 SECTIONS POUR LE COMPTABLE ═══════════════ */}
              {r.lautopak_docs && (() => {
                const ld = r.lautopak_docs
                const docLabels: Record<string, { num: string; titre: string }> = {
                  'ventes':              { num:'1', titre:'Facture VENTES' },
                  'note_credit_retours': { num:'2', titre:'Note de crédit RETOURS sellable' },
                  'note_credit_pertes':  { num:'3', titre:'Note de crédit PERTES / DOMMAGES' },
                  'ajust_audit':         { num:'4', titre:'Ajustement INVENTAIRE (audits)' },
                }
                return (
                  <>
                    <h2>1. Documents LAUTOPAK émis</h2>
                    <div style={{fontSize:11,color:'#666',marginBottom:6}}>
                      Liste des 4 documents (factures + notes de crédit) à saisir dans LAUTOPAK pour ce settlement. Tout ce qui touche à une quantité d'inventaire passe par un de ces documents avec un n° de référence.
                    </div>
                    <table>
                      <thead><tr>
                        <th style={{width:30}}>#</th>
                        <th>Type de document</th>
                        <th>N° facture</th>
                        <th>Date</th>
                        <th className="num">Nb lignes</th>
                        <th className="num">Montant</th>
                      </tr></thead>
                      <tbody>
                        {ld.docs.map((doc: any, i: number) => {
                          const cfg = docLabels[doc.doc_type] || { num: String(i+1), titre: doc.label }
                          const isVide = doc.lignes.length === 0 || Math.abs(doc.total) < 0.01
                          return (
                            <tr key={doc.doc_type}>
                              <td style={{fontWeight:700}}>{cfg.num}</td>
                              <td>{cfg.titre}</td>
                              <td style={{fontFamily:'monospace',fontWeight:700}}>
                                {doc.numero_facture
                                  ? doc.numero_facture
                                  : isVide
                                    ? <span style={{color:'#080'}}>✓ Sans objet</span>
                                    : <span style={{color:'#c00'}}>⚠ NON SAISI</span>}
                              </td>
                              <td>{doc.date_facture ? fmtDate(doc.date_facture) : (isVide ? '—' : '—')}</td>
                              <td className="num">{doc.lignes.length}</td>
                              <td className="num" style={{fontWeight:800,color:isVide?'#888':doc.total<0?'#c00':'#000'}}>{fmt$(doc.total)}</td>
                            </tr>
                          )
                        })}
                        <tr className="tot-row">
                          <td colSpan={5}>Net stock LAUTOPAK total (4 docs)</td>
                          <td className="num">{fmt$(ld.net_lautopak||0)}</td>
                        </tr>
                      </tbody>
                    </table>

                    <h2>2. Coût des ventes Amazon (compte agrégé, sans stock)</h2>
                    <div style={{fontSize:11,color:'#666',marginBottom:6}}>
                      Tout ce qui n'implique aucune quantité d'inventaire → compte de charges agrégé. Décomposition reproduit les 3 sections du relevé papier Amazon.
                    </div>
                    {(() => {
                      const ca = ld.couts_amazon || {}
                      const labels: Record<string,string> = {
                        'A_ventes_expedition': 'Expédition (Order Shipping)',
                        'A_ventes_taxes_net': 'Taxes net (Tax + MarketplaceFacilitatorTax)',
                        'B_remb_depenses_pos': 'Dépenses remboursées (positifs)',
                        'B_remb_depenses_neg': 'Dépenses remboursées (négatifs)',
                        'B_remb_ventes_frais_produit_non_sellable': 'Ventes remboursées : Frais produit (non sellable)',
                        'B_remb_ventes_expedition': 'Ventes remboursées : Expédition',
                        'C_rabais_promotionnels': 'Rabais promotionnels',
                        'C_frais_fba_stockage': 'Frais Expédié par Amazon — Stockage',
                        'C_frais_fba_autres': 'Frais Expédié par Amazon — Autre (RemovalComplete)',
                        'C_frais_fba_abonnement': 'Frais d\'abonnement',
                        'C_publicite': 'Prix de la publicité',
                        'C_commissions_amazon': 'Commissions Amazon',
                        'C_remboursements_inverses': 'Remboursements inversés (FBA)',
                      }
                      const Sec = ({letter, total, color}: any) => (
                        <tr style={{background:color, fontWeight:800}}>
                          <td>{letter === 'A' ? 'Section A — VENTES (hors Doc 1)' : letter === 'B' ? 'Section B — REMBOURSEMENTS (hors Doc 2 cashflow)' : 'Section C — DÉPENSES (= relevé papier)'}</td>
                          <td className="num">{fmt$(Number(total||0))}</td>
                        </tr>
                      )
                      const Sub = ({k}: any) => {
                        if (ca[k] === undefined || Math.abs(Number(ca[k])) < 0.01) return null
                        return (
                          <tr>
                            <td style={{paddingLeft:24,color:'#666'}}>{labels[k] || k}</td>
                            <td className="num" style={{color:Number(ca[k])<0?'#c00':'#000'}}>{fmt$(Number(ca[k]))}</td>
                          </tr>
                        )
                      }
                      return (
                        <table>
                          <tbody>
                            <Sec letter="A" total={ca.A_TOTAL_section_A} color="#e8f0fe" />
                            <Sub k="A_ventes_expedition" />
                            <Sub k="A_ventes_taxes_net" />
                            <Sec letter="B" total={ca.B_TOTAL_section_B} color="#fff8e1" />
                            <Sub k="B_remb_depenses_pos" />
                            <Sub k="B_remb_depenses_neg" />
                            <Sub k="B_remb_ventes_frais_produit_non_sellable" />
                            <Sub k="B_remb_ventes_expedition" />
                            <Sec letter="C" total={ca.C_TOTAL_section_C} color="#fce8e6" />
                            <Sub k="C_rabais_promotionnels" />
                            <Sub k="C_frais_fba_stockage" />
                            <Sub k="C_frais_fba_autres" />
                            <Sub k="C_frais_fba_abonnement" />
                            <Sub k="C_publicite" />
                            <Sub k="C_commissions_amazon" />
                            <Sub k="C_remboursements_inverses" />
                            {ca.Z_autre_non_classe !== undefined && (
                              <tr style={{background:'#fff3cd'}}>
                                <td>⚠ Autre / non classé</td>
                                <td className="num">{fmt$(Number(ca.Z_autre_non_classe))}</td>
                              </tr>
                            )}
                            <tr className="tot-row">
                              <td>= TOTAL Coût des ventes Amazon</td>
                              <td className="num">{fmt$(ld.total_couts_amazon||0)}</td>
                            </tr>
                          </tbody>
                        </table>
                      )
                    })()}

                    <h2>3. Vérification de balance comptable</h2>
                    <div style={{fontSize:11,color:'#666',marginBottom:6}}>
                      Le total des cashflows des documents LAUTOPAK + le compte « Coût des ventes Amazon » doit égaler le dépôt bancaire reçu d'Amazon.
                    </div>
                    <table>
                      <tbody>
                        <tr><td>Cashflow Doc 1 (Vente = Order Principal du TSV)</td><td className="num">{fmt$(ld.cashflow_docs?.doc1_ventes||0)}</td></tr>
                        <tr><td>Cashflow Doc 2 (Retours sellable = part du Refund Principal)</td><td className="num">{fmt$(ld.cashflow_docs?.doc2_retours||0)}</td></tr>
                        <tr><td>Cashflow Doc 3 (Pertes = Reim Amazon dans TSV)</td><td className="num">{fmt$(ld.cashflow_docs?.doc3_pertes||0)}</td></tr>
                        <tr><td><em>Doc 4 (Audit) — mouvement comptable pur, hors cashflow</em></td><td className="num"><em>0,00 $</em></td></tr>
                        <tr style={{borderTop:'1px solid #000'}}><td>+ Total cashflow documents</td><td className="num" style={{fontWeight:800}}>{fmt$(ld.cashflow_docs?.total||0)}</td></tr>
                        <tr><td>+ Coût des ventes Amazon (compte agrégé)</td><td className="num">{fmt$(ld.total_couts_amazon||0)}</td></tr>
                        <tr className="tot-row"><td>= Dépôt bancaire calculé</td><td className="num">{fmt$(ld.balance_calcul||0)}</td></tr>
                        <tr><td>Dépôt bancaire réel (TSV settlement)</td><td className="num" style={{fontWeight:800}}>{fmt$(ld.balance_settlement||0)}</td></tr>
                        <tr style={{background:ld.balance_ok?'#e6f4ea':'#fce8e6'}}>
                          <td style={{fontWeight:800,color:ld.balance_ok?'#080':'#c00'}}>{ld.balance_ok?'✓ Balance OK':'⚠ Écart'}</td>
                          <td className="num" style={{fontWeight:800,color:ld.balance_ok?'#080':'#c00'}}>{ld.balance_ok?'0,00 $':fmt$(ld.ecart_balance||0)}</td>
                        </tr>
                      </tbody>
                    </table>

                    <h2>4. Audits liés à ce settlement</h2>
                    {(!r.audits_lies || r.audits_lies.length === 0) ? (
                      <div style={{color:'#666',fontStyle:'italic'}}>Aucun audit physique lié à ce settlement.</div>
                    ) : (
                      <table>
                        <thead><tr>
                          <th>Type</th>
                          <th>Libellé</th>
                          <th>Statut</th>
                          <th className="num">Comptés</th>
                          <th className="num">Total</th>
                          <th>Démarré</th>
                          <th>Terminé</th>
                        </tr></thead>
                        <tbody>
                          {r.audits_lies.map((a: any) => {
                            const labelType = a.audit_type === 'settlement_fbm' ? 'FBM (settlement)' :
                                              a.audit_type === 'settlement_fba' ? 'FBA snapshot' :
                                              a.audit_type === 'mensuel_ama' ? 'AMA mensuel' : a.audit_type
                            return (
                              <tr key={a.id}>
                                <td><strong>{labelType}</strong></td>
                                <td>{a.label||'—'}</td>
                                <td>{a.statut === 'termine' ? '✓ Terminé' : '⏳ En cours'}</td>
                                <td className="num">{a.nb_comptes||0}</td>
                                <td className="num">{a.nb_total||0}</td>
                                <td>{a.started_at ? fmtDate(a.started_at) : '—'}</td>
                                <td>{a.finished_at ? fmtDate(a.finished_at) : '—'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                    {r.fba_comparison && !r.fba_comparison.erreur_avertissement && (
                      <div style={{fontSize:11,color:'#666',marginTop:6}}>
                        <strong>Audit FBA auto</strong> (snapshot {r.fba_comparison.snapshot_date}) :
                        {r.fba_comparison.nb_ecarts === 0 ? ' ✓ Aucun écart Amazon vs Traction.' : ` ${r.fba_comparison.nb_ecarts} produit${r.fba_comparison.nb_ecarts>1?'s':''} avec écart, ${fmt$(r.fba_comparison.total_ecart_valeur_abs||0)} valeur — à réclamer Amazon.`}
                      </div>
                    )}

                    <h2>5. Détail des mouvements par SKU</h2>
                    <div style={{fontSize:11,color:'#666',marginBottom:6}}>
                      Liste exhaustive de toutes les lignes des 4 documents LAUTOPAK pour cette période.
                    </div>
                    {ld.docs.map((doc: any) => doc.lignes.length === 0 ? null : (
                      <div key={doc.doc_type} style={{marginBottom:14}}>
                        <h3>{docLabels[doc.doc_type]?.titre || doc.label} ({doc.lignes.length} lignes — {fmt$(doc.total)})</h3>
                        <table>
                          <thead><tr>
                            <th>SKU Amazon</th>
                            <th>PKCode Traction</th>
                            <th>Produit</th>
                            <th className="num">Qté</th>
                            <th className="num">Prix unit.</th>
                            <th className="num">Montant</th>
                          </tr></thead>
                          <tbody>
                            {doc.lignes.map((l: any, i: number) => (
                              <tr key={l.sku+i}>
                                <td style={{fontFamily:'monospace',fontWeight:700}}>{l.sku}</td>
                                <td style={{fontFamily:'monospace',fontSize:10}}>{l.pk_code||'—'}</td>
                                <td style={{fontSize:11,maxWidth:240,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l.product_name||''}>{l.product_name||'—'}</td>
                                <td className="num">{l.qty}</td>
                                <td className="num">{fmt$(l.prix_unitaire||0)}</td>
                                <td className="num" style={{color:l.amount<0?'#c00':'#000'}}>{fmt$(l.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </>
                )
              })()}

              {/* ═══════════════ ANCIENNES SECTIONS (rétrocompat workflow v1) ═══════════════ */}
              <div style={{marginTop:30,paddingTop:14,borderTop:'2px solid #ccc',fontSize:11,color:'#666'}}>
                <em>Les sections suivantes sont conservées pour rétrocompatibilité avec le workflow v1.
                Pour ce settlement géré en v2, elles dupliquent partiellement les sections 1-5 ci-dessus.</em>
              </div>

              {r.releve && (() => {
                const rv = r.releve
                const Row = ({ label, val, bold, indent }: any) => (
                  <tr style={bold?{borderTop:'1px solid #000',borderBottom:'1px solid #000'}:{}}>
                    <td style={{paddingLeft:(indent||0)*16+8,fontWeight:bold?800:400}}>{label}</td>
                    <td className="num" style={{fontWeight:bold?800:400}}>{fmt$(val)}</td>
                  </tr>
                )
                return (
                  <>
                    <h2>1. Relevé de paiement Amazon (reconstitué)</h2>
                    <div style={{fontSize:11,color:'#666',marginBottom:6}}>
                      Recompose les 4 sections du relevé papier d'Amazon à partir des transactions du TSV settlement. Sert de pièce justificative pour le rapprochement bancaire.
                    </div>
                    <table>
                      <tbody>
                        <Row label="VENTES" val={rv.ventes.total} bold />
                        <Row label="Frais produit" val={rv.ventes.frais_produit} indent={1} />
                        <Row label="Expédition" val={rv.ventes.expedition} indent={1} />
                        <Row label="Remboursements de stock (FBA)" val={rv.ventes.remboursements_stock_fba} indent={1} />

                        <Row label="REMBOURSEMENTS" val={rv.remboursements.total} bold />
                        <Row label="Dépenses remboursées" val={rv.remboursements.depenses_rembourses} indent={1} />
                        <Row label="Ventes remboursées" val={rv.remboursements.ventes_remboursees_total} indent={1} />
                        <Row label="— Expédition" val={rv.remboursements.ventes_remboursees_expedition} indent={2} />
                        <Row label="— Frais produit" val={rv.remboursements.ventes_remboursees_frais_produit} indent={2} />

                        <Row label="DÉPENSES" val={rv.depenses.total} bold />
                        <Row label="Rabais promotionnels" val={rv.depenses.rabais_promotionnels} indent={1} />
                        <Row label="Frais Expédié par Amazon" val={rv.depenses.frais_fba_total} indent={1} />
                        <Row label="— Frais de stockage mensuels" val={rv.depenses.frais_fba_stockage} indent={2} />
                        <Row label="— Autre" val={rv.depenses.frais_fba_autre} indent={2} />
                        <Row label="Prix de la publicité" val={rv.depenses.publicite} indent={1} />
                        <Row label="Commissions Amazon" val={rv.depenses.commissions_amazon} indent={1} />
                        <Row label="Remboursements inversés (FBA)" val={rv.depenses.remboursements_inverses_fba} indent={1} />

                        <tr><td colSpan={2} style={{padding:6,borderBottom:'none'}}></td></tr>
                        <Row label="PROFITS NETS (= dépôt bancaire)" val={rv.profits_nets_calcules} bold />
                      </tbody>
                    </table>
                    {rv.reste_non_classe && Math.abs(rv.reste_non_classe) >= 0.01 && (
                      <div style={{fontSize:10,color:'#c00',marginTop:4}}>
                        ⚠ Reste non classé : {fmt$(rv.reste_non_classe)} ({rv.non_classes_composants?.length || 0} amount_description non mappé)
                      </div>
                    )}
                  </>
                )
              })()}

              <h2>2. Totaux financiers</h2>
              <table>
                <tbody>
                  <tr><td>Dépôt Amazon</td><td className="num">{fmt$(r.totaux.total_depot_amazon)}</td></tr>
                  <tr><td>Remboursements attribués à ce settlement</td><td className="num">{fmt$(r.totaux.total_reimbursements)}</td></tr>
                  <tr><td>Ajustement inventaire net (valeur)</td><td className="num">{fmt$(r.totaux.total_ajustement_inventaire_net)}</td></tr>
                  <tr><td>Unsellable en attente (valeur)</td><td className="num">{fmt$(r.totaux.total_unsellable)}</td></tr>
                </tbody>
              </table>

              <h2>3. Flux du settlement par type</h2>
              <table>
                <thead><tr><th>Amount type</th><th className="num">Nb lignes</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {r.flux.map((f:any,i:number) => (
                    <tr key={i}><td>{f.amount_type}</td><td className="num">{f.count}</td><td className="num">{fmt$(f.total)}</td></tr>
                  ))}
                </tbody>
              </table>

              <h2>4. Remboursements matchés ({r.reimbursements.length})</h2>
              {r.reimbursements.length === 0 ? <div style={{color:'#666'}}>Aucun remboursement attribué à ce settlement.</div> : (
                <table>
                  <thead><tr><th>Reimb. ID</th><th>SKU</th><th>Traction</th><th>Raison</th><th className="num">Montant</th></tr></thead>
                  <tbody>
                    {r.reimbursements.map((x:any,i:number) => (
                      <tr key={i}>
                        <td style={{fontFamily:'monospace'}}>{x.reimbursement_id}</td>
                        <td style={{fontFamily:'monospace'}}>{x.sku||'—'}</td>
                        <td style={{fontFamily:'monospace'}}>{x.traction_code||'—'}</td>
                        <td>{x.reason}</td>
                        <td className="num">{fmt$(x.amount_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {r.ajustements_fba && r.ajustements_fba.length > 0 && (
                <>
                  <h2>4b. Ajustements Traction FBA — Reimbursements cash</h2>
                  <div style={{fontSize:11,color:'#666',marginBottom:6}}>
                    Amazon a remboursé ces unités en cash ($) → elles sont physiquement perdues.
                    Il faut <strong>décrémenter la ligne FBA-xxx correspondante</strong> dans Traction du nombre indiqué.
                  </div>
                  <table>
                    <thead><tr>
                      <th>Reimb. ID</th><th>SKU Amazon</th><th>Produit</th><th>Raison</th>
                      <th className="num">Qté</th><th className="num">Montant</th>
                      <th>Pk_code Traction à ajuster</th><th className="num">Stock actuel</th><th className="num">Nouveau stock</th>
                    </tr></thead>
                    <tbody>
                      {r.ajustements_fba.map((a:any, i:number) => (
                        <tr key={i}>
                          <td style={{fontFamily:'monospace',fontSize:10}}>{a.reimbursement_id}</td>
                          <td style={{fontFamily:'monospace'}}>{a.sku}</td>
                          <td style={{fontSize:10,maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{a.product_name||'—'}</td>
                          <td style={{fontSize:10}}>{a.reason}</td>
                          <td className="num" style={{color:'#c00',fontWeight:700}}>−{a.qty_cash}</td>
                          <td className="num">{fmt$(a.amount)}</td>
                          <td style={{fontFamily:'monospace',fontWeight:700}}>{a.pk_code_to_adjust || '—'}</td>
                          <td className="num">{a.current_traction_qty != null ? a.current_traction_qty : '—'}</td>
                          <td className="num" style={{fontWeight:700}}>{a.current_traction_qty != null ? a.current_traction_qty - a.qty_cash : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <h2>5. Ajustements d'inventaire ({r.ajustements.length})</h2>
              {r.ajustements.length === 0 ? <div style={{color:'#666'}}>Aucun ajustement nécessaire — inventaire équilibré.</div> : (
                <table>
                  <thead><tr><th>Base code</th><th>Description</th><th className="num">Whse théo</th><th className="num">Whse compté</th><th className="num">Δ Whse</th><th className="num">FBM théo</th><th className="num">FBM compté</th><th className="num">Δ FBM</th><th className="num">Coût unit</th><th className="num">Valeur</th></tr></thead>
                  <tbody>
                    {r.ajustements.map((a:any,i:number) => (
                      <tr key={i}>
                        <td style={{fontFamily:'monospace',fontWeight:700}}>{a.base_code}</td>
                        <td>{a.description||'—'}{a.has_oubli?` 🏷 (${a.sans_prefix_theorique} SP à tagger)`:''}</td>
                        <td className="num">{a.warehouse_theorique_net}</td>
                        <td className="num">{a.warehouse_compte??'—'}</td>
                        <td className="num" style={{color:a.warehouse_ecart!==0?'#c00':'#000'}}>{a.warehouse_ecart>0?'+':''}{a.warehouse_ecart}</td>
                        <td className="num">{a.fbm_theorique}</td>
                        <td className="num">{a.fbm_compte??'—'}</td>
                        <td className="num" style={{color:a.fbm_ecart!==0?'#c00':'#000'}}>{a.fbm_ecart>0?'+':''}{a.fbm_ecart}</td>
                        <td className="num">{Number(a.coutant).toFixed(2)} $</td>
                        <td className="num" style={{color:a.valeur_ecart<0?'#c00':'#000',fontWeight:700}}>{fmt$(a.valeur_ecart)}</td>
                      </tr>
                    ))}
                    <tr className="tot-row"><td colSpan={9}>Total ajustement net</td><td className="num">{fmt$(r.totaux.total_ajustement_inventaire_net)}</td></tr>
                    <tr><td colSpan={9} style={{fontSize:10,color:'#666'}}>Total ajustement absolu (valeur des erreurs)</td><td className="num" style={{color:'#666',fontSize:10}}>{fmt$(r.totaux.total_ajustement_inventaire_abs)}</td></tr>
                  </tbody>
                </table>
              )}

              <h2>6. Unsellable à réclamer ({r.unsellable.length})</h2>
              {r.unsellable.length === 0 ? <div style={{color:'#666'}}>Aucun unsellable au snapshot de cette période.</div> : (
                <table>
                  <thead><tr><th>SKU</th><th>Traction</th><th>Produit</th><th className="num">Qté</th><th className="num">Valeur estimée</th></tr></thead>
                  <tbody>
                    {r.unsellable.map((u:any,i:number) => (
                      <tr key={i}>
                        <td style={{fontFamily:'monospace'}}>{u.sku}</td>
                        <td style={{fontFamily:'monospace'}}>{u.traction_code||'—'}</td>
                        <td>{u.product_name||'—'}</td>
                        <td className="num">{u.qty}</td>
                        <td className="num">{fmt$(u.valeur)}</td>
                      </tr>
                    ))}
                    <tr className="tot-row"><td colSpan={4}>Total unsellable</td><td className="num">{fmt$(r.totaux.total_unsellable)}</td></tr>
                  </tbody>
                </table>
              )}

              <h2>7. Justification (audit physique)</h2>
              <div style={{fontSize:11,color:'#666'}}>
                {r.audit_stats.nb_counted}/{r.audit_stats.nb_total} base products comptés. Valeur d'écart absolue totale : {fmt$(r.audit_stats.valeur_ecart_abs)}.
                Chaque ligne ci-dessus a été comptée physiquement à l'entrepôt pendant cette période.
              </div>

              <div style={{marginTop:30,borderTop:'2px solid #000',paddingTop:10,fontSize:11,color:'#666',display:'flex',justifyContent:'space-between'}}>
                <div>Validation comptable : _______________________</div>
                <div>Date : _______________</div>
              </div>
            </div>
          </div>
        )
      })()}

      {vue === 'import' && (
        <div>
          {/* Bloc Traction sync */}
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'14px 16px',marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
              <div>
                <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>1️⃣ Synchroniser Traction</div>
                <div style={{fontSize:11,color:sub}}>Charge les pièces Traction sur les lignes AMA/FBA/FBM. À refaire quand tu modifies des pièces dans Traction.</div>
              </div>
              <button onClick={syncTraction} disabled={syncing}
                style={{background:syncing?bdr:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'10px 18px',fontWeight:700,cursor:syncing?'default':'pointer',fontSize:13}}>
                {syncing?'⏳ Sync...':'🔄 Sync Traction'}
              </button>
            </div>
          </div>

          {/* Bloc Réconciliation */}
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'14px 16px',marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
              <div>
                <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>🔗 Réconcilier remboursements ↔ settlements</div>
                <div style={{fontSize:11,color:sub}}>Matching exact SKU + montant entre le CSV reimbursements et les lignes FBA Inventory Reimbursement du payments. Déclenché auto après chaque import.</div>
              </div>
              <button onClick={()=>reconcilierRemboursements(false)}
                style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'10px 18px',fontWeight:700,cursor:'pointer',fontSize:13}}>
                🔗 Réconcilier
              </button>
            </div>
          </div>

          {/* Dropzone upload */}
          <div style={{background:card,border:`2px dashed ${bdr}`,borderRadius:10,padding:'20px',marginBottom:12,textAlign:'center'}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>2️⃣ Importer les fichiers Amazon</div>
            <div style={{fontSize:11,color:sub,marginBottom:14,lineHeight:1.5}}>
              Détection automatique du type. Tu peux sélectionner plusieurs fichiers à la fois.<br/>
              Fichiers supportés : <strong>settlement payments (TSV)</strong>, <strong>FBA inventory (CSV)</strong>, <strong>reimbursements (CSV)</strong>, <strong>removal orders (CSV)</strong> 🆕.
            </div>
            <input ref={fileRef} type="file" multiple accept=".txt,.csv,.tsv"
              onChange={e=>onFiles(e.target.files)} disabled={importing}
              style={{display:'block',margin:'0 auto',fontSize:13}}/>
            {importing && <div style={{marginTop:10,color:C.blue,fontWeight:700}}>⏳ Import en cours...</div>}
          </div>

          {/* Log import */}
          {importLog.length > 0 && (
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <div style={{fontSize:12,fontWeight:700,color:sub}}>📋 JOURNAL D'IMPORT</div>
                <button onClick={()=>setImportLog([])} style={{background:'transparent',border:`1px solid ${bdr}`,borderRadius:6,padding:'3px 8px',cursor:'pointer',fontSize:11,color:sub}}>Effacer</button>
              </div>
              <div style={{fontFamily:'monospace',fontSize:11,maxHeight:220,overflowY:'auto',color:sub,lineHeight:1.7}}>
                {importLog.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </div>
          )}

          {/* Liste settlements */}
          <div>
            <div style={{fontSize:14,fontWeight:800,marginBottom:8}}>📋 Settlements importés ({settlements.length})</div>
            <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
              {settlements.length === 0
                ? <div style={{textAlign:'center',padding:30,color:sub,fontSize:13}}>Aucun settlement importé pour le moment</div>
                : <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                      <thead><tr style={{background:thBg}}>
                        <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Settlement ID</th>
                        <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Période</th>
                        <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Montant</th>
                        <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Déposé le</th>
                        <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Statut</th>
                      </tr></thead>
                      <tbody>
                        {settlements.map((s:any) => (
                          <tr key={s.id} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:11}}>{s.settlement_id}</td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,whiteSpace:'nowrap'}}>
                              {s.settlement_start ? new Date(s.settlement_start).toLocaleDateString('fr-CA',{month:'short',day:'numeric'}) : '—'}
                              {' → '}
                              {s.settlement_end ? new Date(s.settlement_end).toLocaleDateString('fr-CA',{month:'short',day:'numeric'}) : '—'}
                            </td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:C.green}}>
                              {Number(s.total_amount||0).toFixed(2)} {s.currency||''}
                            </td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,whiteSpace:'nowrap'}}>
                              {s.deposit_date ? new Date(s.deposit_date).toLocaleDateString('fr-CA',{year:'numeric',month:'short',day:'numeric'}) : '—'}
                            </td>
                            <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`}}>
                              <span style={{background:s.lautopak_status==='facture'?C.green+'22':C.yellow+'22',color:s.lautopak_status==='facture'?C.green:C.yellow,padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>
                                {s.lautopak_status==='facture'?'✓ Facturé':'⏳ En attente'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
              }
            </div>
          </div>
        </div>
      )}

      {vue === 'settlements' && (() => {
        const fmt$ = (n: number) => `${n>=0?'':'−'}${Math.abs(n).toFixed(2)}$`
        const filtered = settlementsList.filter((s:any) => {
          if (filtLautopak === 'pending' && s.lautopak_status !== 'pending') return false
          if (filtLautopak === 'facture' && s.lautopak_status !== 'facture') return false
          if (searchSettlement) {
            const q = searchSettlement.toLowerCase()
            if (!String(s.settlement_id||'').toLowerCase().includes(q) &&
                !String(s.lautopak_invoice_ref||'').toLowerCase().includes(q)) return false
          }
          return true
        })
        const nbPending = settlementsList.filter((s:any)=>s.lautopak_status==='pending').length
        const nbFacture = settlementsList.filter((s:any)=>s.lautopak_status==='facture').length
        const sommePending = settlementsList.filter((s:any)=>s.lautopak_status==='pending').reduce((a:number,s:any)=>a+Number(s.computed_net||s.total_amount||0),0)

        return (
        <div>
          {/* Stats en haut */}
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:10,display:'flex',gap:18,flexWrap:'wrap',alignItems:'center',fontSize:12}}>
            <div><span style={{color:sub}}>Total settlements : </span><strong style={{fontSize:15}}>{settlementsList.length}</strong></div>
            <div style={{color:sub}}>•</div>
            <div><span style={{color:C.yellow}}>⏳ En attente : <strong>{nbPending}</strong></span></div>
            <div><span style={{color:C.green}}>✓ Facturés : <strong>{nbFacture}</strong></span></div>
            <div style={{color:sub}}>•</div>
            <div><span style={{color:sub}}>Net en attente : </span><strong style={{color:C.red}}>{fmt$(sommePending)}</strong></div>
          </div>

          {/* Filtres */}
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:10,display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
            <input value={searchSettlement} onChange={e=>setSearchSettlement(e.target.value)} placeholder="🔍 N° settlement ou facture LAUTOPAK..."
              style={{...S,maxWidth:260,fontSize:12,padding:'7px 10px'}}/>
            <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
              {[
                {id:'tous', label:`Tous (${settlementsList.length})`, color:sub},
                {id:'pending', label:`⏳ En attente (${nbPending})`, color:C.yellow},
                {id:'facture', label:`✓ Facturés (${nbFacture})`, color:C.green},
              ].map(f => (
                <button key={f.id} onClick={()=>setFiltLautopak(f.id as any)}
                  style={{padding:'6px 11px',borderRadius:14,border:`1px solid ${filtLautopak===f.id?f.color:bdr}`,background:filtLautopak===f.id?f.color+'22':'transparent',color:filtLautopak===f.id?f.color:sub,fontWeight:700,cursor:'pointer',fontSize:11}}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Liste compacte */}
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
            {filtered.length === 0
              ? <div style={{textAlign:'center',padding:40,color:sub,fontSize:13}}>Aucun settlement</div>
              : <>
                  {filtered.map((s:any) => {
                    const isExp = expandedSettlement === s.settlement_id
                    const net = Number(s.computed_net || s.total_amount || 0)
                    const fbaN = Number(s.computed_fba_net || 0)
                    const fbmN = Number(s.computed_fbm_net || 0)
                    const detail = detailCache[s.settlement_id]
                    const input = lautopakInput[s.settlement_id] || { ref:'', date:'', notes:'' }
                    return (
                      <div key={s.settlement_id} style={{borderBottom:`1px solid ${bdr}`}}>
                        {/* Ligne compacte */}
                        <div onClick={()=>toggleSettlement(s.settlement_id)}
                          onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr}
                          onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}
                          style={{display:'flex',gap:12,padding:'12px 14px',alignItems:'center',cursor:'pointer',flexWrap:'wrap'}}>
                          <span style={{color:sub,fontFamily:'sans-serif',width:12}}>{isExp?'▼':'▶'}</span>
                          <div style={{flex:'2 1 200px',minWidth:180}}>
                            <div style={{fontWeight:800,fontSize:13,fontFamily:'monospace'}}>{s.settlement_id}</div>
                            <div style={{fontSize:11,color:sub,marginTop:2}}>
                              {s.settlement_start ? new Date(s.settlement_start).toLocaleDateString('fr-CA',{month:'short',day:'numeric'}) : '—'}
                              {' → '}
                              {s.settlement_end ? new Date(s.settlement_end).toLocaleDateString('fr-CA',{month:'short',day:'numeric'}) : '—'}
                              {s.deposit_date && <span> • déposé {new Date(s.deposit_date).toLocaleDateString('fr-CA',{month:'short',day:'numeric'})}</span>}
                            </div>
                          </div>
                          <div style={{textAlign:'right',minWidth:130}}>
                            <div style={{fontSize:20,fontWeight:900,color:net>=0?C.green:C.red}}>{fmt$(net)} <span style={{fontSize:11,color:sub}}>{s.currency||''}</span></div>
                            <div style={{fontSize:10,color:sub,marginTop:2}}>
                              FBA : <strong style={{color:dark?'#bbb':'#555'}}>{fmt$(fbaN)}</strong>
                              {' • FBM : '}<strong style={{color:dark?'#bbb':'#555'}}>{fmt$(fbmN)}</strong>
                            </div>
                          </div>
                          <div style={{minWidth:120,textAlign:'right'}}>
                            <div style={{fontSize:11,color:sub}}>{s.nb_orders||0} commandes</div>
                            <div style={{fontSize:10,color:sub}}>{s.nb_transactions||0} lignes</div>
                          </div>
                          <div style={{minWidth:120,textAlign:'right'}}>
                            {s.lautopak_status === 'facture'
                              ? <div>
                                  <span style={{background:C.green+'22',color:C.green,padding:'3px 10px',borderRadius:12,fontSize:11,fontWeight:700}}>✓ Facturé</span>
                                  {s.lautopak_invoice_ref && <div style={{fontSize:10,color:sub,marginTop:3,fontFamily:'monospace'}}>#{s.lautopak_invoice_ref}</div>}
                                </div>
                              : <span style={{background:C.yellow+'22',color:C.yellow,padding:'3px 10px',borderRadius:12,fontSize:11,fontWeight:700}}>⏳ En attente</span>
                            }
                          </div>
                        </div>

                        {/* Détail déplié */}
                        {isExp && (
                          <div style={{background:dark?'#0f0f0f':'#fafbfc',padding:'16px 18px',borderTop:`1px solid ${bdr}`}}>
                            {loadingDetail === s.settlement_id && !detail
                              ? <div style={{textAlign:'center',padding:20,color:sub}}>⏳ Chargement du détail...</div>
                              : !detail
                                ? <div style={{textAlign:'center',padding:20,color:sub}}>Aucune donnée</div>
                                : <div>
                                    {/* Totaux */}
                                    <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(4,1fr)',gap:10,marginBottom:14}}>
                                      <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.green}`}}>
                                        <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Total net calculé</div>
                                        <div style={{fontSize:20,fontWeight:900,color:C.green}}>{fmt$(detail.totals.brut)}</div>
                                      </div>
                                      <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
                                        <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>FBA net</div>
                                        <div style={{fontSize:20,fontWeight:900,color:C.blue}}>{fmt$(detail.totals.fba)}</div>
                                      </div>
                                      <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.yellow}`}}>
                                        <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>FBM net</div>
                                        <div style={{fontSize:20,fontWeight:900,color:C.yellow}}>{fmt$(detail.totals.fbm)}</div>
                                      </div>
                                      <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px'}}>
                                        <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Commandes</div>
                                        <div style={{fontSize:20,fontWeight:900}}>{detail.totals.nb_orders}</div>
                                      </div>
                                    </div>

                                    {/* Breakdown par catégorie */}
                                    <div style={{fontSize:12,fontWeight:800,marginBottom:6,color:sub,textTransform:'uppercase'}}>📊 Breakdown financier</div>
                                    <div style={{background:card,borderRadius:8,border:`1px solid ${bdr}`,overflow:'hidden',marginBottom:14}}>
                                      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                                        <thead><tr style={{background:thBg}}>
                                          <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Catégorie</th>
                                          <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>#</th>
                                          <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>FBA</th>
                                          <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>FBM</th>
                                          <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Total</th>
                                        </tr></thead>
                                        <tbody>
                                          {detail.breakdown.map((b:any) => (
                                            <tr key={b.category}>
                                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontWeight:600}}>{b.category}</td>
                                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub,fontSize:11}}>{b.count}</td>
                                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:b.fba>=0?C.green:C.red,fontWeight:700}}>{fmt$(b.fba)}</td>
                                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:b.fbm>=0?C.green:C.red,fontWeight:700}}>{fmt$(b.fbm)}</td>
                                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:b.brut>=0?C.green:C.red,fontWeight:800}}>{fmt$(b.brut)}</td>
                                            </tr>
                                          ))}
                                          <tr style={{background:thBg}}>
                                            <td style={{padding:'9px 10px',fontWeight:900}}>TOTAL NET</td>
                                            <td style={{padding:'9px 10px',textAlign:'right',color:sub,fontSize:11}}>{detail.totals.nb_transactions}</td>
                                            <td style={{padding:'9px 10px',textAlign:'right',fontWeight:900,color:detail.totals.fba>=0?C.green:C.red}}>{fmt$(detail.totals.fba)}</td>
                                            <td style={{padding:'9px 10px',textAlign:'right',fontWeight:900,color:detail.totals.fbm>=0?C.green:C.red}}>{fmt$(detail.totals.fbm)}</td>
                                            <td style={{padding:'9px 10px',textAlign:'right',fontWeight:900,fontSize:14,color:detail.totals.brut>=0?C.green:C.red}}>{fmt$(detail.totals.brut)}</td>
                                          </tr>
                                        </tbody>
                                      </table>
                                    </div>

                                    {/* ─── Balance settlement ≟ dépôt Amazon ─── */}
                                    {detail.totals && s.total_amount != null && (() => {
                                      const depotAmazon = Number(s.total_amount || 0)
                                      const sommeBreakdown = Number(detail.totals.brut || 0)
                                      const delta = sommeBreakdown - depotAmazon
                                      const balanced = Math.abs(delta) < 0.01
                                      return (
                                        <div style={{background:balanced?(dark?'#0d2a18':'#e6f4ea'):(dark?'#2b1113':'#fce8e6'),border:`2px solid ${balanced?C.green:C.red}`,borderRadius:10,padding:'12px 14px',marginBottom:12,display:'flex',gap:16,flexWrap:'wrap',alignItems:'center',justifyContent:'space-between'}}>
                                          <div style={{fontWeight:900,color:balanced?C.green:C.red,fontSize:14}}>
                                            {balanced?'✅ BALANCE SETTLEMENT OK':'⚠️ ÉCART DE BALANCE SETTLEMENT'}
                                          </div>
                                          <div style={{display:'flex',gap:16,flexWrap:'wrap',fontSize:12}}>
                                            <div><span style={{color:sub}}>💰 Dépôt Amazon : </span><strong>{fmt$(depotAmazon)}</strong></div>
                                            <div><span style={{color:sub}}>Σ Breakdown : </span><strong>{fmt$(sommeBreakdown)}</strong></div>
                                            <div><span style={{color:sub}}>Delta : </span><strong style={{color:balanced?C.green:C.red}}>{fmt$(delta)}</strong></div>
                                          </div>
                                          {!balanced && (
                                            <div style={{flexBasis:'100%',fontSize:11,color:sub,marginTop:4,lineHeight:1.5}}>
                                              💡 Causes possibles : {delta>0?'transactions en trop (catégorisation incorrecte)':'transactions manquantes (type/description non reconnu par le parseur)'}. Vérifie les lignes « Non catégorisé » dans le breakdown ci-dessus.
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })()}

                                    {/* ─── Mouvements d'inventaire (ce qu'il faut rentrer dans LAUTOPAK) ─── */}
                                    {detail.mouvements && detail.mouvements.length > 0 && (
                                      <>
                                        <div style={{fontSize:12,fontWeight:800,marginBottom:6,color:C.green,textTransform:'uppercase'}}>
                                          📦 Mouvements d'inventaire — qté nette à déduire dans LAUTOPAK ({detail.mouvements.length} SKU)
                                        </div>
                                        <div style={{fontSize:10,color:sub,marginBottom:8}}>
                                          <strong>Net LAUTOPAK</strong> = Vendu − Retourné + Perdu − Trouvé.
                                          Convention LAUTOPAK : <span style={{color:C.green,fontWeight:700}}>+ = sortie inventaire</span>, <span style={{color:C.red,fontWeight:700}}>− = ajout inventaire</span>.
                                          Perdu = WAREHOUSE_LOST/DAMAGE/REVERSAL (Amazon paie). Trouvé = COMPENSATED_CLAWBACK (Amazon reprend son argent car unité retrouvée).
                                        </div>
                                        {detail.lost_qualite && detail.lost_qualite.sku_count > 0 && (
                                          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:8,padding:'8px 12px',marginBottom:8,fontSize:11,display:'flex',gap:14,flexWrap:'wrap',alignItems:'center'}}>
                                            <span style={{color:sub,fontWeight:700}}>Qualité pertes :</span>
                                            <span>💰 <strong>{fmt$(detail.lost_qualite.total_amount)}</strong> reçus</span>
                                            {detail.lost_qualite.sku_csv_exact > 0 && (
                                              <span>✅ <strong style={{color:C.green}}>{detail.lost_qualite.sku_csv_exact}</strong>/{detail.lost_qualite.sku_count} SKU exacts (CSV)</span>
                                            )}
                                            {detail.lost_qualite.sku_avec_prix > 0 && (
                                              <span>🎯 <strong style={{color:C.blue}}>{detail.lost_qualite.sku_avec_prix}</strong> SKU estimés (prix unitaire)</span>
                                            )}
                                            {detail.lost_qualite.sku_sans_prix > 0 && (
                                              <span style={{color:C.yellow}}>⚠️ <strong>{detail.lost_qualite.sku_sans_prix}</strong> SKU sans prix — importe un CSV couvrant la période pour avoir les qty exactes</span>
                                            )}
                                          </div>
                                        )}
                                        <div style={{background:card,borderRadius:8,border:`2px solid ${C.green}33`,overflow:'hidden',marginBottom:14,maxHeight:360,overflowY:'auto'}}>
                                          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                                            <thead><tr style={{background:thBg,position:'sticky',top:0,zIndex:1}}>
                                              <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>SKU Amazon</th>
                                              <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Traction</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Vendu</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Retourné</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Perdu</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Trouvé</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>$ reçu</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.green,borderBottom:`1px solid ${bdr}`}}>Net LAUTOPAK</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Coût unit.</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Valeur nette</th>
                                            </tr></thead>
                                            <tbody>
                                              {detail.mouvements.map((m:any) => {
                                                const lostBadge = m.lost_method === 'csv_exact' ? '✅' : m.lost_method === 'csv_historique' ? '🎯' : m.lost_method === 'coutant_traction' ? '📊' : m.lost_method === 'assume_1_par_ligne' ? '⚠️' : ''
                                                const foundBadge = m.found_method === 'csv_historique' ? '🎯' : m.found_method === 'coutant_traction' ? '📊' : m.found_method === 'assume_1_par_ligne' ? '⚠️' : ''
                                                const netAmount = (m.lost_amount || 0) - (m.found_amount || 0)
                                                return (
                                                <tr key={m.sku}>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700}}>{m.sku}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',color:m.traction_code?C.blue:C.red,fontSize:11}}>{m.traction_code||'— non mappé'}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:m.sold>0?C.green:sub}}>{m.sold||''}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:m.returned>0?C.yellow:sub}}>{m.returned>0?`−${m.returned}`:''}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:m.lost>0?C.red:sub}} title={m.lost_method||''}>
                                                    {m.lost>0?`+${m.lost} ${lostBadge}`:''}
                                                  </td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:m.found>0?C.blue:sub}} title={m.found_method||''}>
                                                    {m.found>0?`−${m.found} ${foundBadge}`:''}
                                                  </td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:netAmount!==0?(netAmount>0?C.green:C.red):sub,fontSize:11}}>
                                                    {netAmount!==0?fmt$(netAmount):''}
                                                  </td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontSize:14,fontWeight:900,color:m.net>0?C.green:m.net<0?C.red:sub}}>
                                                    {m.net>0?'+':''}{m.net}
                                                  </td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub,fontSize:11}}>{m.coutant>0?`${m.coutant.toFixed(2)}$`:'—'}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:m.valeur_net>=0?C.green:C.red}}>{m.valeur_net!==0?fmt$(m.valeur_net):'—'}</td>
                                                </tr>
                                              )})}
                                              <tr style={{background:thBg}}>
                                                <td colSpan={2} style={{padding:'9px 10px',fontWeight:900}}>TOTAUX</td>
                                                <td style={{padding:'9px 10px',textAlign:'right',fontWeight:900,color:C.green}}>{detail.mouv_totals.sold}</td>
                                                <td style={{padding:'9px 10px',textAlign:'right',fontWeight:900,color:C.yellow}}>−{detail.mouv_totals.returned}</td>
                                                <td style={{padding:'9px 10px',textAlign:'right',fontWeight:900,color:C.red}}>+{detail.mouv_totals.lost}</td>
                                                <td style={{padding:'9px 10px',textAlign:'right',fontWeight:900,color:C.blue}}>−{detail.mouv_totals.found||0}</td>
                                                <td style={{padding:'9px 10px',textAlign:'right',fontWeight:900,color:C.green}}>{fmt$((detail.mouv_totals.lost_amount||0) - (detail.mouv_totals.found_amount||0))}</td>
                                                <td style={{padding:'9px 10px',textAlign:'right',fontSize:14,fontWeight:900,color:C.green}}>{detail.mouv_totals.net>0?'+':''}{detail.mouv_totals.net}</td>
                                                <td></td>
                                                <td style={{padding:'9px 10px',textAlign:'right',fontWeight:900,color:C.green}}>{fmt$(detail.mouv_totals.valeur_net)}</td>
                                              </tr>
                                            </tbody>
                                          </table>
                                        </div>
                                      </>
                                    )}

                                    {/* ─── Traçage remboursements (preuve + écart prix coûtant) ─── */}
                                    {((detail.reimbursements && detail.reimbursements.length > 0) || (detail.reimb_balance && detail.reimb_balance.money_in_payments !== 0)) && (
                                      <>
                                        <div style={{fontSize:12,fontWeight:800,marginBottom:6,color:C.red,textTransform:'uppercase'}}>
                                          💸 Remboursements Amazon ({detail.reimbursements?.length || 0}) — traçage prix coûtant
                                        </div>
                                        <div style={{fontSize:10,color:sub,marginBottom:8}}>
                                          Attribution unique par fenêtre de dates (chaque remboursement compte dans 1 seul settlement).
                                          Écart = montant remboursé − prix coûtant Traction (rouge = Amazon sous-remboursé).
                                        </div>

                                        {/* Couverture CSV (info seulement - les mouvements sont calculés depuis payments) */}
                                        {detail.reimb_balance && detail.reimb_balance.money_in_payments !== 0 && (
                                          <div style={{background:detail.reimb_balance.balanced?(dark?'#0d2a18':'#e6f4ea'):(dark?'#1a1a2e':'#fffbea'),border:`1px solid ${detail.reimb_balance.balanced?C.green:C.yellow}`,borderRadius:10,padding:'10px 14px',marginBottom:10,display:'flex',gap:14,flexWrap:'wrap',alignItems:'center',fontSize:11}}>
                                            <div style={{fontWeight:800,color:detail.reimb_balance.balanced?C.green:C.yellow}}>
                                              {detail.reimb_balance.balanced?'✅ CSV couvre 100% des remboursements du settlement':'ℹ️ CSV partiel ou daté hors fenêtre'}
                                            </div>
                                            <div style={{color:sub}}>•</div>
                                            <div><span style={{color:sub}}>Payments reçus : </span><strong>{fmt$(detail.reimb_balance.money_in_payments)}</strong></div>
                                            <div><span style={{color:sub}}>CSV attribués : </span><strong>{fmt$(detail.reimb_balance.money_in_csv)}</strong></div>
                                            {!detail.reimb_balance.balanced && (
                                              <div style={{color:sub,flexBasis:'100%',fontSize:10,marginTop:4}}>
                                                💡 Les mouvements d'inventaire ci-dessus sont calculés depuis le fichier payments (source garantie) — pas d'incidence sur les quantités LAUTOPAK.
                                              </div>
                                            )}
                                          </div>
                                        )}

                                        {/* Stats remboursements */}
                                        <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(4,1fr)',gap:8,marginBottom:10}}>
                                          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:8,padding:'8px 10px',borderLeft:`3px solid ${C.blue}`}}>
                                            <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',color:sub}}>Remboursé par Amazon</div>
                                            <div style={{fontSize:16,fontWeight:900,color:C.green}}>{fmt$(detail.reimb_totals.amount_total)}</div>
                                          </div>
                                          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:8,padding:'8px 10px',borderLeft:`3px solid ${sub}`}}>
                                            <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',color:sub}}>Coûtant Traction</div>
                                            <div style={{fontSize:16,fontWeight:900}}>{fmt$(detail.reimb_totals.coutant_total)}</div>
                                          </div>
                                          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:8,padding:'8px 10px',borderLeft:`3px solid ${detail.reimb_totals.ecart_total>=0?C.green:C.red}`}}>
                                            <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',color:sub}}>Écart total</div>
                                            <div style={{fontSize:16,fontWeight:900,color:detail.reimb_totals.ecart_total>=0?C.green:C.red}}>{fmt$(detail.reimb_totals.ecart_total)}</div>
                                          </div>
                                          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:8,padding:'8px 10px',borderLeft:`3px solid ${C.yellow}`}}>
                                            <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',color:sub}}>Qté perdues / remplacées</div>
                                            <div style={{fontSize:14,fontWeight:900}}><span style={{color:C.red}}>{detail.reimb_totals.qty_cash} cash</span> / <span style={{color:C.blue}}>{detail.reimb_totals.qty_inventory} inv</span></div>
                                          </div>
                                        </div>
                                        <div style={{background:card,borderRadius:8,border:`2px solid ${C.red}33`,overflow:'hidden',marginBottom:14,maxHeight:400,overflowY:'auto'}}>
                                          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                                            <thead><tr style={{background:thBg,position:'sticky',top:0,zIndex:1}}>
                                              <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Date</th>
                                              <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Raison</th>
                                              <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Reimb. ID</th>
                                              <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>SKU</th>
                                              <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Traction</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Qté $</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Qté inv</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>$/unité</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Coût Tract.</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Total $</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`1px solid ${bdr}`}}>Écart</th>
                                            </tr></thead>
                                            <tbody>
                                              {detail.reimbursements.map((r:any) => {
                                                const isDamage = r.reason && String(r.reason).toLowerCase().includes('damage')
                                                const isLost = r.reason && String(r.reason).toLowerCase().includes('lost')
                                                const reasonColor = isDamage ? C.yellow : isLost ? C.red : sub
                                                return (
                                                <tr key={r.reimbursement_id}>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,whiteSpace:'nowrap'}}>{r.approval_date?new Date(r.approval_date).toLocaleDateString('fr-CA',{month:'short',day:'numeric'}):'—'}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>
                                                    <span style={{background:reasonColor+'22',color:reasonColor,padding:'2px 6px',borderRadius:6,fontWeight:700,fontSize:10}}>{r.reason||'—'}</span>
                                                  </td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:10,color:sub}}>{r.reimbursement_id}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700,fontSize:11}}>{r.sku||'—'}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',color:r.traction_code?C.blue:C.red,fontSize:11}}>{r.traction_code||'— non mappé'}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:r.qty_cash>0?C.red:sub,fontWeight:700}}>{r.qty_cash||''}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:r.qty_inventory>0?C.blue:sub,fontWeight:700}}>{r.qty_inventory||''}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:C.green}}>{Number(r.amount_per_unit||0).toFixed(2)}$</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:r.traction_coutant>0?sub:C.red,fontSize:11}}>{r.traction_coutant>0?`${r.traction_coutant.toFixed(2)}$`:'?'}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:C.green}}>{Number(r.amount_total||0).toFixed(2)}$</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:900,color:r.ecart_total>=0?C.green:C.red}}>
                                                    {r.traction_coutant>0?fmt$(r.ecart_total):'?'}
                                                  </td>
                                                </tr>
                                              )})}
                                            </tbody>
                                          </table>
                                        </div>
                                      </>
                                    )}

                                    {/* Top SKU */}
                                    {detail.top_skus && detail.top_skus.length > 0 && (
                                      <>
                                        <div style={{fontSize:12,fontWeight:800,marginBottom:6,color:sub,textTransform:'uppercase'}}>🏆 Top SKU vendus ({detail.top_skus.length})</div>
                                        <div style={{background:card,borderRadius:8,border:`1px solid ${bdr}`,overflow:'hidden',marginBottom:14,maxHeight:260,overflowY:'auto'}}>
                                          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                                            <thead><tr style={{background:thBg,position:'sticky',top:0}}>
                                              <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>SKU Amazon</th>
                                              <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Traction</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Qté</th>
                                              <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Revenu</th>
                                            </tr></thead>
                                            <tbody>
                                              {detail.top_skus.map((t:any) => (
                                                <tr key={t.sku}>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700}}>{t.sku}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',color:t.traction_code?C.blue:C.red,fontSize:11}}>{t.traction_code||'— non mappé'}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700}}>{t.qty}</td>
                                                  <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:C.green}}>{fmt$(t.revenue)}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      </>
                                    )}

                                    {/* Formulaire LAUTOPAK */}
                                    <div style={{background:card,borderRadius:10,border:`2px solid ${s.lautopak_status==='facture'?C.green:C.yellow}`,padding:'14px 16px'}}>
                                      <div style={{fontSize:13,fontWeight:800,marginBottom:10,color:s.lautopak_status==='facture'?C.green:C.yellow}}>
                                        {s.lautopak_status==='facture'?'✓ FACTURE LAUTOPAK':'⏳ FACTURER DANS LAUTOPAK'}
                                      </div>
                                      <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'2fr 1fr',gap:10,marginBottom:10}}>
                                        <div>
                                          <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:4}}>N° de facture LAUTOPAK *</div>
                                          <input value={input.ref} onChange={e=>setLautopakInput(prev=>({...prev,[s.settlement_id]:{...input,ref:e.target.value}}))}
                                            placeholder="Ex: F-2026-04-001"
                                            style={{...S,fontSize:13,padding:'8px 12px',fontFamily:'monospace'}}/>
                                        </div>
                                        <div>
                                          <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:4}}>Date facture</div>
                                          <input type="date" value={input.date} onChange={e=>setLautopakInput(prev=>({...prev,[s.settlement_id]:{...input,date:e.target.value}}))}
                                            style={{...S,fontSize:13,padding:'8px 12px'}}/>
                                        </div>
                                      </div>
                                      <div style={{marginBottom:10}}>
                                        <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:4}}>Notes</div>
                                        <textarea value={input.notes} onChange={e=>setLautopakInput(prev=>({...prev,[s.settlement_id]:{...input,notes:e.target.value}}))}
                                          placeholder="Notes optionnelles..."
                                          rows={2} style={{...S,fontSize:12,padding:'8px 12px',resize:'vertical',width:'100%'}}/>
                                      </div>
                                      <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
                                        {s.lautopak_status === 'facture' && (
                                          <button onClick={()=>annulerFacture(s.settlement_id)}
                                            style={{background:'transparent',color:C.yellow,border:`1px solid ${C.yellow}`,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                                            ↩ Annuler facturation
                                          </button>
                                        )}
                                        <button onClick={()=>marquerFacture(s.settlement_id)}
                                          style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'10px 16px',fontWeight:800,cursor:'pointer',fontSize:13}}>
                                          {s.lautopak_status === 'facture' ? '💾 Mettre à jour' : '✓ Marquer facturé LAUTOPAK'}
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                            }
                          </div>
                        )}
                      </div>
                    )
                  })}
                </>
            }
          </div>
        </div>
        )
      })()}

      {vue === 'inventaire' && (() => {
        const fmt$ = (n: number) => `${n>=0?'':'−'}${Math.abs(n).toFixed(2)}$`
        const t = inventaireGaps.totals || {}
        const d = inventaireGaps.dashboard
        const h = inventaireGaps.history
        const allRows: any[] = inventaireGaps.rows || []
        const q = searchGap.trim().toLowerCase()
        const filtered = allRows.filter(r => {
          if (filtGap === 'action' && r.action === 'ok') return false
          if (filtGap === 'unsellable' && r.action !== 'unsellable') return false
          if (filtGap === 'rupture_fba' && r.action !== 'rupture_fba') return false
          if (filtGap === 'reclamation' && r.action !== 'reclamation') return false
          if (filtGap === 'ajust_traction' && r.action !== 'ajust_traction') return false
          if (filtGap === 'watched' && !r.is_watched) return false
          if (filtGap === 'ok' && r.action !== 'ok') return false
          if (q && !String(r.sku||'').toLowerCase().includes(q) && !String(r.traction_code||'').toLowerCase().includes(q)) return false
          return true
        })
        const actionIcon: Record<string, string> = {
          unsellable: '🔥', rupture_fba: '🚨', reclamation: '💰',
          ajust_traction: '📝', non_mappe: '🗺', ok: '✓',
        }
        const actionLabel: Record<string, string> = {
          unsellable: 'Unsellable', rupture_fba: 'Rupture FBA', reclamation: 'Réclamation',
          ajust_traction: 'Ajuster Traction', non_mappe: 'Non mappé', ok: 'OK',
        }
        const actionColor: Record<string, string> = {
          unsellable: C.red, rupture_fba: C.red, reclamation: C.yellow,
          ajust_traction: C.blue, non_mappe: sub, ok: C.green,
        }
        return (
        <div>
          {/* Header + snapshot date */}
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap',marginBottom:10}}>
            <div>
              <div style={{fontSize:13,fontWeight:800}}>📊 Comparaison Amazon FBA ↔ Traction</div>
              <div style={{fontSize:11,color:sub,marginTop:2}}>
                Compare le dernier snapshot FBA (afn fulfillable + inbound + reserved) au stock Traction <strong>CodeLigne AMA</strong> (QTYMINUSRESERVED), regroupé par base produit (A2883424 = A2883424 + FBA-2883424 + HUB-2883424 + 2883424). Survole la colonne Traction pour voir le détail des variantes sommées.
              </div>
            </div>
            <div style={{fontSize:11,color:sub,textAlign:'right',lineHeight:1.5}}>
              {inventaireGaps.snapshot_date && <>📅 Snapshot FBA : <strong>{inventaireGaps.snapshot_date}</strong><br/></>}
              {inventaireGaps.traction_synced_at && <>🔄 Sync Traction : <strong>{new Date(inventaireGaps.traction_synced_at).toLocaleString('fr-CA',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</strong></>}
            </div>
          </div>

          {/* ─── DASHBOARD SANTÉ FBA ─── */}
          {d && (
            <div style={{background:card,border:`2px solid ${bdr}`,borderRadius:12,padding:'14px 16px',marginBottom:12}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10,flexWrap:'wrap',gap:8}}>
                <div style={{fontSize:13,fontWeight:900}}>💼 SANTÉ INVENTAIRE FBA</div>
                {h && (
                  <button onClick={()=>setShowHistory(v=>!v)}
                    style={{background:'transparent',border:`1px solid ${bdr}`,borderRadius:6,padding:'5px 10px',cursor:'pointer',fontSize:11,color:sub}}>
                    {showHistory?'▼':'▶'} Historique ({h.nb_changed} changements depuis {h.previous_date})
                  </button>
                )}
              </div>
              {/* Valeurs globales */}
              <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(4,1fr)',gap:8,marginBottom:10}}>
                <div style={{background:dark?'#0d2a18':'#e6f4ea',borderRadius:8,padding:'10px 12px',borderLeft:`3px solid ${C.green}`}}>
                  <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',color:sub}}>Valeur FBA dispo</div>
                  <div style={{fontSize:18,fontWeight:900,color:C.green}}>{fmt$(d.value_fba_dispo)}</div>
                  <div style={{fontSize:10,color:sub}}>{d.total_fba_units} unités</div>
                </div>
                <div style={{background:dark?'#1a233a':'#e8f0fe',borderRadius:8,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
                  <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',color:sub}}>Valeur Traction</div>
                  <div style={{fontSize:18,fontWeight:900,color:C.blue}}>{fmt$(d.value_traction)}</div>
                  <div style={{fontSize:10,color:sub}}>{d.total_traction_units} unités</div>
                </div>
                <div style={{background:card,borderRadius:8,padding:'10px 12px',borderLeft:`3px solid ${d.delta_value>=0?C.blue:C.red}`}}>
                  <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',color:sub}}>Delta valeur</div>
                  <div style={{fontSize:18,fontWeight:900,color:d.delta_value>=0?C.blue:C.red}}>{fmt$(d.delta_value)}</div>
                  <div style={{fontSize:10,color:sub}}>FBA − Traction</div>
                </div>
                <div style={{background:d.value_fba_unsellable>0?(dark?'#2b1113':'#fce8e6'):card,borderRadius:8,padding:'10px 12px',borderLeft:`3px solid ${d.value_fba_unsellable>0?C.red:sub}`}}>
                  <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',color:sub}}>🔥 Unsellable</div>
                  <div style={{fontSize:18,fontWeight:900,color:d.value_fba_unsellable>0?C.red:sub}}>{fmt$(d.value_fba_unsellable)}</div>
                  <div style={{fontSize:10,color:sub}}>{d.total_unsellable_units} unités perdues</div>
                </div>
              </div>

              {/* Cartes d'actions */}
              <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(5,1fr)',gap:6,marginBottom:10}}>
                {[
                  {k:'unsellable', icon:'🔥', label:'À réclamer', color:C.red},
                  {k:'rupture_fba', icon:'🚨', label:'Rupture FBA', color:C.red},
                  {k:'reclamation', icon:'💰', label:'Réclamation', color:C.yellow},
                  {k:'ajust_traction', icon:'📝', label:'Ajuster Traction', color:C.blue},
                  {k:'non_mappe', icon:'🗺', label:'Non mappés', color:sub},
                ].map(a => {
                  const stats = d.actions[a.k] || {count:0, value:0}
                  return (
                    <button key={a.k} onClick={()=>setFiltGap(a.k as any)}
                      style={{background:filtGap===a.k?a.color+'22':card,border:`1px solid ${filtGap===a.k?a.color:bdr}`,borderRadius:8,padding:'8px 10px',cursor:'pointer',textAlign:'left'}}>
                      <div style={{fontSize:10,color:sub,fontWeight:700}}>{a.icon} {a.label}</div>
                      <div style={{fontSize:16,fontWeight:900,color:a.color}}>{stats.count}</div>
                      {stats.value > 0 && <div style={{fontSize:10,color:sub}}>{fmt$(stats.value)}</div>}
                    </button>
                  )
                })}
              </div>

              {/* Top pertes / gains */}
              {(d.top_pertes.length > 0 || d.top_gains.length > 0) && (
                <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:10}}>
                  {d.top_pertes.length > 0 && (
                    <div>
                      <div style={{fontSize:10,fontWeight:800,color:C.red,textTransform:'uppercase',marginBottom:4}}>⬇️ Top pertes (Amazon &lt; Traction)</div>
                      <div style={{background:dark?'#1a1a1a':'#fafbfc',borderRadius:6,padding:'6px 8px',fontSize:11}}>
                        {d.top_pertes.map((p:any) => (
                          <div key={p.sku} style={{display:'flex',justifyContent:'space-between',padding:'3px 0',borderBottom:`1px solid ${bdr}`}}>
                            <span style={{fontFamily:'monospace',fontWeight:700}}>{p.sku}</span>
                            <span style={{color:C.red,fontWeight:700}}>{p.ecart} → {fmt$(p.valeur_ecart)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {d.top_gains.length > 0 && (
                    <div>
                      <div style={{fontSize:10,fontWeight:800,color:C.blue,textTransform:'uppercase',marginBottom:4}}>⬆️ Top gains (Amazon &gt; Traction)</div>
                      <div style={{background:dark?'#1a1a1a':'#fafbfc',borderRadius:6,padding:'6px 8px',fontSize:11}}>
                        {d.top_gains.map((p:any) => (
                          <div key={p.sku} style={{display:'flex',justifyContent:'space-between',padding:'3px 0',borderBottom:`1px solid ${bdr}`}}>
                            <span style={{fontFamily:'monospace',fontWeight:700}}>{p.sku}</span>
                            <span style={{color:C.blue,fontWeight:700}}>+{p.ecart} → {fmt$(p.valeur_ecart)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Historique déplié */}
              {showHistory && h && (
                <div style={{marginTop:10,background:dark?'#1a1a1a':'#fafbfc',borderRadius:8,padding:'10px 12px'}}>
                  <div style={{fontSize:11,fontWeight:800,marginBottom:6}}>📈 Évolution depuis {h.previous_date}</div>
                  <div style={{display:'flex',gap:14,flexWrap:'wrap',fontSize:12,marginBottom:8}}>
                    <span>Unités : <strong style={{color:h.delta_units>=0?C.green:C.red}}>{h.delta_units>=0?'+':''}{h.delta_units}</strong></span>
                    <span>Valeur : <strong style={{color:h.delta_value>=0?C.green:C.red}}>{fmt$(h.delta_value)}</strong></span>
                    <span style={{color:C.red}}>⬇️ Dégradés : <strong>{h.nb_degraded}</strong></span>
                    <span style={{color:C.green}}>⬆️ Améliorés : <strong>{h.nb_improved}</strong></span>
                  </div>
                  {h.top_deltas && h.top_deltas.length > 0 && (
                    <div style={{maxHeight:200,overflowY:'auto'}}>
                      <table style={{width:'100%',fontSize:11,borderCollapse:'collapse'}}>
                        <thead><tr style={{background:thBg}}>
                          <th style={{padding:'5px 8px',textAlign:'left',color:sub,fontSize:9}}>SKU</th>
                          <th style={{padding:'5px 8px',textAlign:'right',color:sub,fontSize:9}}>Avant</th>
                          <th style={{padding:'5px 8px',textAlign:'right',color:sub,fontSize:9}}>Après</th>
                          <th style={{padding:'5px 8px',textAlign:'right',color:sub,fontSize:9}}>Δ</th>
                          <th style={{padding:'5px 8px',textAlign:'right',color:sub,fontSize:9}}>Valeur</th>
                        </tr></thead>
                        <tbody>
                          {h.top_deltas.map((dt:any) => (
                            <tr key={dt.sku}>
                              <td style={{padding:'3px 8px',fontFamily:'monospace',fontWeight:700}}>{dt.sku}</td>
                              <td style={{padding:'3px 8px',textAlign:'right',color:sub}}>{dt.prev_qty}</td>
                              <td style={{padding:'3px 8px',textAlign:'right',color:sub}}>{dt.current_qty}</td>
                              <td style={{padding:'3px 8px',textAlign:'right',fontWeight:700,color:dt.diff>=0?C.green:C.red}}>{dt.diff>=0?'+':''}{dt.diff}</td>
                              <td style={{padding:'3px 8px',textAlign:'right',fontWeight:700,color:dt.value_diff>=0?C.green:C.red}}>{fmt$(dt.value_diff)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Stats */}
          <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(5,1fr)',gap:8,marginBottom:10}}>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${sub}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Total SKU FBA</div>
              <div style={{fontSize:20,fontWeight:900}}>{t.nb_total||0}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.red}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Avec écart</div>
              <div style={{fontSize:20,fontWeight:900,color:C.red}}>{t.nb_ecart||0}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.green}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>OK (pas d'écart)</div>
              <div style={{fontSize:20,fontWeight:900,color:C.green}}>{t.nb_ok||0}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Valeur écart net</div>
              <div style={{fontSize:18,fontWeight:900,color:(t.valeur_ecart_net||0)>=0?C.green:C.red}}>{fmt$(t.valeur_ecart_net||0)}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.yellow}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Valeur écart abs</div>
              <div style={{fontSize:18,fontWeight:900,color:C.yellow}}>{fmt$(t.valeur_ecart_abs||0)}</div>
            </div>
          </div>

          {/* Filtres */}
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:10,display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
            <input value={searchGap} onChange={e=>setSearchGap(e.target.value)} placeholder="🔍 SKU ou code Traction..."
              style={{...S,maxWidth:220,fontSize:12,padding:'7px 10px'}}/>
            <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
              {[
                {id:'action', label:`⚠️ Actions (${(d?.actions?.unsellable?.count||0)+(d?.actions?.rupture_fba?.count||0)+(d?.actions?.reclamation?.count||0)+(d?.actions?.ajust_traction?.count||0)})`, color:C.red},
                {id:'watched', label:`⭐ Watchlist (${d?.watched_count||0})`, color:C.yellow},
                {id:'ok', label:`✅ OK (${d?.actions?.ok?.count||t.nb_ok||0})`, color:C.green},
                {id:'tous', label:`Tous (${t.nb_total||0})`, color:sub},
              ].map(f => (
                <button key={f.id} onClick={()=>setFiltGap(f.id as any)}
                  style={{padding:'6px 11px',borderRadius:14,border:`1px solid ${filtGap===f.id?f.color:bdr}`,background:filtGap===f.id?f.color+'22':'transparent',color:filtGap===f.id?f.color:sub,fontWeight:700,cursor:'pointer',fontSize:11}}>
                  {f.label}
                </button>
              ))}
            </div>
            <label style={{display:'flex',alignItems:'center',gap:6,fontSize:11,color:sub,cursor:'pointer',marginLeft:'auto'}}>
              <input type="checkbox" checked={showFbm} onChange={e=>setShowFbm(e.target.checked)}/>
              Colonne FBM cross-check
            </label>
          </div>

          {/* Tableau des écarts */}
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
            {filtered.length === 0
              ? <div style={{textAlign:'center',padding:40,color:sub,fontSize:13}}>
                  {inventaireGaps.snapshot_date
                    ? 'Aucun résultat avec ces filtres'
                    : 'Aucun snapshot FBA importé — importe ton fichier CSV d\'inventaire FBA'}
                </div>
              : <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                    <thead><tr style={{background:thBg}}>
                      <th style={{padding:'8px 6px',borderBottom:`1px solid ${bdr}`,width:24}}></th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Action</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>SKU</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Traction</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Description</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>FBA dispo</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Inb.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`1px solid ${bdr}`}}>Unsell.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Traction</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`1px solid ${bdr}`}}>Écart</th>
                      {showFbm && <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>MFN</th>}
                      {showFbm && <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Tract.FBM</th>}
                      {showFbm && <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>ΔFBM</th>}
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Coût</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`1px solid ${bdr}`}}>Valeur écart</th>
                    </tr></thead>
                    <tbody>
                      {filtered.map((r:any) => (
                        <tr key={r.sku} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                          <td style={{padding:'4px 6px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                            <button onClick={()=>toggleWatchlist(r.sku, r.is_watched)}
                              title={r.is_watched?'Retirer de la watchlist':'Ajouter à la watchlist'}
                              style={{background:'transparent',border:'none',cursor:'pointer',fontSize:14,padding:0}}>
                              {r.is_watched?'⭐':'☆'}
                            </button>
                          </td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`}}>
                            <span style={{background:actionColor[r.action]+'22',color:actionColor[r.action],padding:'2px 7px',borderRadius:8,fontSize:10,fontWeight:700,whiteSpace:'nowrap'}}>
                              {actionIcon[r.action]} {actionLabel[r.action]}
                            </span>
                          </td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700,fontSize:11}}>{r.sku}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',color:r.traction_code?C.blue:C.red,fontSize:11}}>{r.traction_code||'— non mappé'}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={r.product_name}>{r.product_name||'—'}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800,color:C.blue}}>{r.amazon_dispo}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:r.amazon_inbound>0?C.blue:sub,fontSize:11}}>{r.amazon_inbound||''}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:r.amazon_unsellable>0?C.red:sub,fontSize:11,fontWeight:r.amazon_unsellable>0?800:400}}>{r.amazon_unsellable||''}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800,color:r.traction_code?C.green:sub,cursor:(r.traction_variants||[]).length?'help':'default'}}
                              title={(r.traction_variants||[]).filter((v:any)=>v.code_ligne==='AMA').map((v:any)=>`${v.pk_code} (${v.code_ligne}) : ${v.qty_dispo}`).join('\n') || 'Aucune variante AMA trouvée'}>
                            {r.traction_code?r.traction_qty:'?'}
                          </td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontSize:14,fontWeight:900,color:r.ecart===0?C.green:r.ecart>0?C.blue:C.red}}>
                            {r.ecart>0?'+':''}{r.ecart}
                          </td>
                          {showFbm && <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub,fontSize:11}}>{r.mfn_fulfillable||'—'}</td>}
                          {showFbm && <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub,fontSize:11}}>{r.traction_fbm||'—'}</td>}
                          {showFbm && <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:r.ecart_fbm===0?sub:r.ecart_fbm>0?C.blue:C.red,fontSize:11}}>{r.ecart_fbm!==0?(r.ecart_fbm>0?'+':'')+r.ecart_fbm:'—'}</td>}
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub,fontSize:11}}>{r.coutant>0?`${Number(r.coutant).toFixed(2)}$`:'—'}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800,color:r.valeur_ecart===0?sub:r.valeur_ecart>0?C.blue:C.red}}>
                            {r.valeur_ecart!==0?fmt$(r.valeur_ecart):'—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
            }
          </div>

          {/* Légende */}
          <div style={{marginTop:10,fontSize:11,color:sub,lineHeight:1.6}}>
            <div><strong style={{color:C.blue}}>Écart positif</strong> : Amazon a <em>plus</em> que Traction → Traction sous-déclare (stock à réajuster +)</div>
            <div><strong style={{color:C.red}}>Écart négatif</strong> : Amazon a <em>moins</em> que Traction → unités manquantes chez Amazon (à investiguer, possible réclamation)</div>
            <div><strong>Traction</strong> = somme QTYMINUSRESERVED sur toutes lignes AMA/FBA/FBM du même PKCode (tous fournisseurs confondus)</div>
          </div>
        </div>
        )
      })()}

      {vue === 'consolide' && (() => {
        const fmt$ = (n: number) => `${n>=0?'':'−'}${Math.abs(n).toFixed(2)}$`
        const ct = consolide.totals || {}
        const products: any[] = consolide.products || []
        const q = searchConsolide.trim().toLowerCase()
        const filtered = products.filter(p => {
          if (filtConsolide === 'oublis' && !p.has_oubli) return false
          if (filtConsolide === 'ecart_fba' && p.ecart_fba === 0) return false
          if (filtConsolide === 'ecart_fbm' && p.ecart_fbm === 0) return false
          if (filtConsolide === 'ok' && p.action !== 'ok') return false
          if (q) {
            if (p.base.toLowerCase().includes(q)) return true
            if (p.description && p.description.toLowerCase().includes(q)) return true
            if ((p.variants||[]).some((v:any) => v.pk_code.toLowerCase().includes(q))) return true
            return false
          }
          return true
        })
        const actionBadge: Record<string, {icon:string, label:string, color:string}> = {
          unsellable:           {icon:'🔥', label:'Unsellable',        color:C.red},
          oubli_sans_prefixe:   {icon:'🏷', label:'Oubli sans préfixe', color:C.yellow},
          reclamation_fba:      {icon:'💰', label:'Réclamation FBA',   color:C.red},
          ajuster_traction_fba: {icon:'📝', label:'Ajust Traction FBA', color:C.blue},
          ecart_fbm:            {icon:'⚠️', label:'Écart FBM',         color:C.red},
          ajuster_traction_fbm: {icon:'📝', label:'Ajust Traction FBM', color:C.blue},
          ok:                   {icon:'✓',  label:'OK',                color:C.green},
          empty:                {icon:'∅',  label:'Vide',              color:sub},
        }
        return (
        <div>
          {/* Header */}
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap',marginBottom:12}}>
            <div>
              <div style={{fontSize:14,fontWeight:900}}>🏭 Inventaire Amazon consolidé (par base product)</div>
              <div style={{fontSize:11,color:sub,marginTop:3,lineHeight:1.5}}>
                Chaque ligne = un produit logique. Le stock Traction est séparé par emplacement physique (HUB / FBA / FBM / sans préfixe).
                Les colonnes « Amazon » montrent la réalité Amazon du dernier snapshot FBA.
                Les <strong style={{color:C.yellow}}>oublis</strong> sont des pièces sur les lignes AMA/FBA/FBM sans préfixe HUB/FBA/FBM → à tagger.
              </div>
            </div>
            {consolide.snapshot_date && <div style={{fontSize:11,color:sub}}>📅 Snapshot FBA : <strong>{consolide.snapshot_date}</strong></div>}
          </div>

          {/* Cartes totaux */}
          <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(6,1fr)',gap:8,marginBottom:12}}>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${sub}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Base products</div>
              <div style={{fontSize:20,fontWeight:900}}>{ct.nb_base_products||0}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.yellow}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>🏷 Oublis</div>
              <div style={{fontSize:20,fontWeight:900,color:C.yellow}}>{ct.nb_oublis||0}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>HUB Traction</div>
              <div style={{fontSize:18,fontWeight:900,color:C.blue}}>{ct.total_hub||0}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.green}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>FBA Traction → Amazon</div>
              <div style={{fontSize:14,fontWeight:900}}><span style={{color:C.green}}>{ct.total_fba_traction||0}</span> / <span style={{color:C.blue}}>{ct.total_fba_amazon||0}</span></div>
              <div style={{fontSize:9,color:C.red,marginTop:2}}>écart$ {fmt$(ct.valeur_ecart_fba_abs||0)}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.yellow}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>FBM Traction → Amazon</div>
              <div style={{fontSize:14,fontWeight:900}}><span style={{color:C.green}}>{ct.total_fbm_traction||0}</span> / <span style={{color:C.blue}}>{ct.total_fbm_amazon||0}</span></div>
              <div style={{fontSize:9,color:C.red,marginTop:2}}>écart$ {fmt$(ct.valeur_ecart_fbm_abs||0)}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${sub}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Stock total Traction</div>
              <div style={{fontSize:20,fontWeight:900}}>{ct.total_traction||0}</div>
            </div>
          </div>

          {/* Filtres */}
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:10,display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
            <input value={searchConsolide} onChange={e=>setSearchConsolide(e.target.value)} placeholder="🔍 Base code, SKU, description..."
              style={{...S,maxWidth:260,fontSize:12,padding:'7px 10px'}}/>
            <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
              {[
                {id:'tous', label:`Tous (${products.length})`, color:sub},
                {id:'oublis', label:`🏷 Oublis (${ct.nb_oublis||0})`, color:C.yellow},
                {id:'ecart_fba', label:`⚠️ Écart FBA (${ct.nb_ecart_fba||0})`, color:C.red},
                {id:'ecart_fbm', label:`⚠️ Écart FBM (${ct.nb_ecart_fbm||0})`, color:C.red},
                {id:'ok', label:`✅ OK`, color:C.green},
              ].map(f => (
                <button key={f.id} onClick={()=>setFiltConsolide(f.id as any)}
                  style={{padding:'6px 11px',borderRadius:14,border:`1px solid ${filtConsolide===f.id?f.color:bdr}`,background:filtConsolide===f.id?f.color+'22':'transparent',color:filtConsolide===f.id?f.color:sub,fontWeight:700,cursor:'pointer',fontSize:11}}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Tableau consolidé */}
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
            {filtered.length === 0
              ? <div style={{textAlign:'center',padding:40,color:sub,fontSize:13}}>Aucun résultat</div>
              : <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                    <thead><tr style={{background:thBg}}>
                      <th style={{padding:'8px 6px',borderBottom:`1px solid ${bdr}`,width:16}}></th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Action</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Base code</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Description</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`1px solid ${bdr}`}}>HUB</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.yellow,borderBottom:`1px solid ${bdr}`}}>🏷 Sans préfix</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.green,borderBottom:`1px solid ${bdr}`}}>FBA Tract.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`1px solid ${bdr}`}}>FBA Amz</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`1px solid ${bdr}`}}>ΔFBA</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.green,borderBottom:`1px solid ${bdr}`}}>FBM Tract.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`1px solid ${bdr}`}}>FBM Amz</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`1px solid ${bdr}`}}>ΔFBM</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Total</th>
                    </tr></thead>
                    <tbody>
                      {filtered.map((p:any) => {
                        const badge = actionBadge[p.action] || actionBadge.ok
                        const isExp = expandedBase === p.base
                        return (
                          <React.Fragment key={p.base}>
                            <tr onClick={()=>setExpandedBase(isExp?null:p.base)}
                              onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr}
                              onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}
                              style={{cursor:'pointer'}}>
                              <td style={{padding:'6px 6px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:11}}>{isExp?'▼':'▶'}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`}}>
                                <span style={{background:badge.color+'22',color:badge.color,padding:'2px 6px',borderRadius:8,fontSize:10,fontWeight:700,whiteSpace:'nowrap'}}>{badge.icon} {badge.label}</span>
                              </td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700}}>{p.base}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={p.description}>{p.description||'—'}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:p.hub_qty>0?C.blue:sub}}>{p.hub_qty||''}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:p.sans_prefix_qty>0?800:400,color:p.has_oubli?C.yellow:sub}}>{p.sans_prefix_qty||''}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:p.fba_qty_traction>0?C.green:sub}}>{p.fba_qty_traction||''}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:p.fba_qty_amazon>0?C.blue:sub}}>{p.fba_qty_amazon||''}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontSize:13,fontWeight:900,color:p.ecart_fba===0?sub:p.ecart_fba>0?C.blue:C.red}}>{p.ecart_fba!==0?(p.ecart_fba>0?'+':'')+p.ecart_fba:''}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:p.fbm_qty_traction>0?C.green:sub}}>{p.fbm_qty_traction||''}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:p.fbm_qty_amazon>0?C.blue:sub}}>{p.fbm_qty_amazon||''}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontSize:13,fontWeight:900,color:p.ecart_fbm===0?sub:p.ecart_fbm>0?C.blue:C.red}}>{p.ecart_fbm!==0?(p.ecart_fbm>0?'+':'')+p.ecart_fbm:''}</td>
                              <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800}}>{p.traction_total}</td>
                            </tr>
                            {isExp && (
                              <tr>
                                <td colSpan={13} style={{padding:'10px 16px',borderBottom:`2px solid ${bdr}`,background:dark?'#0f0f0f':'#fafbfc'}}>
                                  <div style={{fontSize:11,fontWeight:800,marginBottom:6,color:sub,textTransform:'uppercase'}}>
                                    🔎 Détail audit — {p.base} : {p.variants.length} variant{p.variants.length>1?'s':''} Traction
                                  </div>
                                  <div style={{background:card,borderRadius:6,border:`1px solid ${bdr}`,overflow:'hidden'}}>
                                    <table style={{width:'100%',fontSize:11,borderCollapse:'collapse'}}>
                                      <thead><tr style={{background:thBg}}>
                                        <th style={{padding:'5px 8px',textAlign:'left',fontSize:9,color:sub}}>PKCode</th>
                                        <th style={{padding:'5px 8px',textAlign:'left',fontSize:9,color:sub}}>Location</th>
                                        <th style={{padding:'5px 8px',textAlign:'left',fontSize:9,color:sub}}>Code ligne</th>
                                        <th style={{padding:'5px 8px',textAlign:'left',fontSize:9,color:sub}}>Fournisseur</th>
                                        <th style={{padding:'5px 8px',textAlign:'right',fontSize:9,color:sub}}>QTY</th>
                                        <th style={{padding:'5px 8px',textAlign:'right',fontSize:9,color:sub}}>Dispo</th>
                                      </tr></thead>
                                      <tbody>
                                        {p.variants.map((v:any, i:number) => (
                                          <tr key={i}>
                                            <td style={{padding:'4px 8px',fontFamily:'monospace',fontWeight:700}}>{v.pk_code}</td>
                                            <td style={{padding:'4px 8px'}}>
                                              <span style={{background:(v.location==='HUB'?C.blue:v.location==='FBA'?C.green:v.location==='FBM'?C.yellow:sub)+'22',color:v.location==='HUB'?C.blue:v.location==='FBA'?C.green:v.location==='FBM'?C.yellow:sub,padding:'1px 6px',borderRadius:6,fontSize:9,fontWeight:700}}>{v.location}</span>
                                            </td>
                                            <td style={{padding:'4px 8px',color:sub}}>{v.code_ligne}</td>
                                            <td style={{padding:'4px 8px',color:sub,fontSize:10}}>{v.pk_fournisseur||'—'}</td>
                                            <td style={{padding:'4px 8px',textAlign:'right'}}>{v.qty}</td>
                                            <td style={{padding:'4px 8px',textAlign:'right',fontWeight:700}}>{v.qty_dispo}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                  {/* Synthèse audit pour comptable */}
                                  <div style={{marginTop:10,background:dark?'#1a1a1a':'#fff',border:`1px solid ${bdr}`,borderRadius:6,padding:'10px 12px'}}>
                                    <div style={{fontSize:11,fontWeight:800,marginBottom:6}}>📋 Rapport audit pour ce base code</div>
                                    <div style={{fontSize:11,lineHeight:1.8}}>
                                      <div>• <strong style={{color:C.blue}}>À l'entrepôt HUB</strong> : <strong>{p.hub_qty}</strong> unité{p.hub_qty>1?'s':''}</div>
                                      <div>• <strong style={{color:C.green}}>Chez Amazon FBA (Traction)</strong> : <strong>{p.fba_qty_traction}</strong> | <strong style={{color:C.blue}}>Amazon dit</strong> : <strong>{p.fba_qty_amazon}</strong> {p.ecart_fba!==0 && <span style={{color:C.red,fontWeight:700}}>(écart {p.ecart_fba>0?'+':''}{p.ecart_fba})</span>}</div>
                                      <div>• <strong style={{color:C.yellow}}>FBM (Traction)</strong> : <strong>{p.fbm_qty_traction}</strong> | <strong style={{color:C.blue}}>Amazon dit</strong> : <strong>{p.fbm_qty_amazon}</strong> {p.ecart_fbm!==0 && <span style={{color:C.red,fontWeight:700}}>(écart {p.ecart_fbm>0?'+':''}{p.ecart_fbm})</span>}</div>
                                      {p.sans_prefix_qty > 0 && <div>• <strong style={{color:C.yellow}}>🏷 Sans préfixe (à tagger)</strong> : <strong>{p.sans_prefix_qty}</strong></div>}
                                      <div style={{borderTop:`1px solid ${bdr}`,marginTop:6,paddingTop:6}}>
                                        = <strong>Total Traction : {p.traction_total}</strong> unités
                                      </div>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
            }
          </div>
        </div>
        )
      })()}

      {vue === 'audit' && (() => {
        const fmt$ = (n: number) => `${n>=0?'':'−'}${Math.abs(n).toFixed(2)}$`
        const fmtDate = (d:string) => d ? new Date(d).toLocaleDateString('fr-CA',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'
        const filteredCounts = (auditCounts || []).filter((c:any) => {
          // Vue simple : on ne montre que les SKU avec stock physique attendu chez Mathias
          // (sauf le filtre "tous" qui inclut tout pour debug).
          const aCompter = Number(c.total_theorique_net || 0) > 0
          if (auditFiltre !== 'tous' && !aCompter) return false
          if (auditFiltre === 'restants' && c.total_compte != null) return false
          if (auditFiltre === 'comptes' && c.total_compte == null) return false
          if (auditFiltre === 'ecarts' && !c.has_ecart_total) return false
          if (auditSearch) {
            const q = auditSearch.trim().toLowerCase()
            if (!String(c.base_code||'').toLowerCase().includes(q) && !String(c.description||'').toLowerCase().includes(q)) return false
          }
          return true
        })
        const termine = openAudit?.statut === 'termine'
        return (
        <div>
          {/* Header création */}
          {!openAudit && (
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'14px 16px',marginBottom:12}}>
              <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>📋 Audit mensuel inventaire</div>
              <div style={{fontSize:11,color:sub,marginBottom:10,lineHeight:1.5}}>
                🔒 Un audit est <strong>créé automatiquement</strong> à chaque import de settlement (gel de Traction + Amazon à cet instant). Tu peux aussi en créer un manuellement ou backfiller les settlements existants.
              </div>
              <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
                <input type="month" value={newAuditMois} onChange={e=>setNewAuditMois(e.target.value)}
                  style={{...S,maxWidth:160,fontSize:12,padding:'8px 12px'}}/>
                <button onClick={creerAudit} disabled={creatingAudit || !newAuditMois}
                  style={{background:creatingAudit?bdr:C.green,color:'#fff',border:'none',borderRadius:8,padding:'10px 16px',fontWeight:700,cursor:creatingAudit?'default':'pointer',fontSize:12}}>
                  {creatingAudit?'⏳':'➕ Audit manuel'}
                </button>
                <button onClick={backfillAudits} disabled={creatingAudit}
                  style={{background:creatingAudit?bdr:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'10px 16px',fontWeight:700,cursor:creatingAudit?'default':'pointer',fontSize:12,marginLeft:'auto'}}>
                  🔒 Créer audits pour settlements existants
                </button>
              </div>
            </div>
          )}

          {/* Liste des audits */}
          {!openAudit && (
            <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden',marginBottom:10}}>
              <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,fontSize:12,fontWeight:700,color:sub}}>
                HISTORIQUE DES AUDITS ({audits.length})
              </div>
              {audits.length === 0
                ? <div style={{textAlign:'center',padding:30,color:sub,fontSize:13}}>Aucun audit encore créé</div>
                : <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                      <thead><tr style={{background:thBg}}>
                        <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Mois</th>
                        <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Libellé</th>
                        <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Statut</th>
                        <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Progression</th>
                        <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Démarré</th>
                        <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Terminé</th>
                        <th style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`}}></th>
                      </tr></thead>
                      <tbody>
                        {audits.map((a:any) => {
                          const pct = a.nb_total > 0 ? Math.round((a.nb_comptes/a.nb_total)*100) : 0
                          return (
                            <tr key={a.id} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                              <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{a.mois}</td>
                              <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,fontSize:12}}>
                                {a.label||'—'}
                                {a.settlement_id && (
                                  <div style={{marginTop:3}}>
                                    <span title={`Settlement ${a.settlement_id}`} style={{background:C.blue+'22',color:C.blue,padding:'2px 6px',borderRadius:6,fontSize:9,fontWeight:700,fontFamily:'monospace'}}>🔗 {a.settlement_id}</span>
                                  </div>
                                )}
                              </td>
                              <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`}}>
                                <span style={{background:(a.statut==='termine'?C.green:C.yellow)+'22',color:a.statut==='termine'?C.green:C.yellow,padding:'2px 8px',borderRadius:8,fontSize:10,fontWeight:700}}>
                                  {a.statut==='termine'?'✓ Terminé':'⏳ En cours'}
                                </span>
                              </td>
                              <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontSize:11,color:sub}}>{a.nb_comptes||0}/{a.nb_total||0} <strong style={{color:pct===100?C.green:C.blue}}>({pct}%)</strong></td>
                              <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,whiteSpace:'nowrap'}}>{fmtDate(a.started_at)}</td>
                              <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,whiteSpace:'nowrap'}}>{a.finished_at?fmtDate(a.finished_at):'—'}</td>
                              <td style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',whiteSpace:'nowrap'}}>
                                <button onClick={()=>chargerAuditDetail(a.id)}
                                  style={{background:C.blue,color:'#fff',border:'none',borderRadius:6,padding:'5px 10px',fontWeight:700,cursor:'pointer',fontSize:11,marginRight:4}}>
                                  Ouvrir
                                </button>
                                <button onClick={()=>supprimerAudit(a.id, a.label||a.mois)}
                                  style={{background:'transparent',color:C.red,border:`1px solid ${C.red}`,borderRadius:6,padding:'4px 8px',cursor:'pointer',fontSize:10,fontWeight:700}}>
                                  🗑
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
              }
            </div>
          )}

          {/* Détail audit ouvert */}
          {openAudit && (
            <div>
              {/* Header audit ouvert */}
              <div style={{background:card,border:`2px solid ${termine?C.green:C.yellow}`,borderRadius:10,padding:'14px 16px',marginBottom:10,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10}}>
                <div>
                  <div style={{fontSize:14,fontWeight:900}}>{openAudit.label} <span style={{fontSize:11,color:sub,marginLeft:8}}>({openAudit.mois})</span></div>
                  <div style={{fontSize:11,color:sub,marginTop:2}}>
                    {termine?'✓ Terminé':'⏳ En cours'} •
                    Démarré par <strong>{openAudit.started_by||'—'}</strong> le {fmtDate(openAudit.started_at)}
                    {openAudit.finished_at && ` • Terminé le ${fmtDate(openAudit.finished_at)}`}
                  </div>
                </div>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={()=>retourDepuisAudit(openAudit)}
                    title={openAudit?.settlement_id ? `Retour au settlement ${openAudit.settlement_id}` : 'Retour à la liste des audits'}
                    style={{background:'transparent',border:`1px solid ${bdr}`,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12,color:sub}}>
                    {openAudit?.settlement_id ? '← Retour au settlement' : '← Retour'}
                  </button>
                  <button onClick={()=>exporterFeuilleComptage('tout')}
                    title="Génère un CSV avec colonnes vides pour comptage manuel — tous les SKU avec stock attendu"
                    style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                    📋 Feuille comptage
                  </button>
                  <button onClick={()=>exporterFeuilleComptage('ecarts')}
                    title="Génère un CSV avec uniquement les SKU qui ont un écart entre théorique et compté (recomptage)"
                    style={{background:C.yellow,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                    🔄 Recompte écarts
                  </button>
                  <button onClick={exportAuditCsv}
                    title="Export complet pour analyse Excel (théorique, compté, écarts, valeurs)"
                    style={{background:'transparent',border:`1px solid ${C.blue}`,color:C.blue,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                    📥 Export complet
                  </button>
                  <button onClick={rafraichirAudit}
                    title="Recalcule FBA Amazon, FBA Traction, HUB, FBM à partir du dernier snapshot sans toucher aux comptages déjà saisis"
                    style={{background:'transparent',border:`1px solid ${C.blue}`,color:C.blue,borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                    🔄 Rafraîchir théoriques
                  </button>
                  {!termine ? (
                    <button onClick={ouvrirFinalisation}
                      style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                      ✓ Finaliser
                    </button>
                  ) : (
                    <button onClick={reouvrirAudit}
                      style={{background:C.yellow,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                      ↩ Rouvrir
                    </button>
                  )}
                </div>
              </div>

              {/* Stats simples — vue compteur */}
              <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(6,1fr)',gap:8,marginBottom:10}}>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',borderLeft:`4px solid ${sub}`}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>SKU à compter</div>
                  <div style={{fontSize:24,fontWeight:900}}>{auditStats.a_compter||0}</div>
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',borderLeft:`4px solid ${C.green}`}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>✓ Comptés</div>
                  <div style={{fontSize:24,fontWeight:900,color:C.green}}>{auditStats.a_compter_comptes||0}</div>
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',borderLeft:`4px solid ${C.yellow}`}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>⏳ Restants</div>
                  <div style={{fontSize:24,fontWeight:900,color:C.yellow}}>{auditStats.a_compter_restants||0}</div>
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',borderLeft:`4px solid ${C.red}`}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>⚠️ Avec écart</div>
                  <div style={{fontSize:24,fontWeight:900,color:C.red}}>{auditStats.a_compter_avec_ecart||0}</div>
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',borderLeft:`4px solid ${C.red}`}} title="Valeur des SKU dont le compté est inférieur au théorique (manquant physiquement)">
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>💸 Manques $</div>
                  <div style={{fontSize:18,fontWeight:900,color:C.red}}>−{fmt$(auditStats.valeur_manques||0).replace('−','')}</div>
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',borderLeft:`4px solid ${C.blue}`}} title="Valeur des SKU dont le compté est supérieur au théorique (surplus physique)">
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>📦 Surplus $</div>
                  <div style={{fontSize:18,fontWeight:900,color:C.blue}}>+{fmt$(auditStats.valeur_surplus||0).replace('−','')}</div>
                </div>
              </div>

              {/* Filtres */}
              <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:10,display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
                <input value={auditSearch} onChange={e=>setAuditSearch(e.target.value)} placeholder="🔍 SKU ou description..."
                  style={{...S,maxWidth:260,fontSize:13,padding:'8px 12px'}}/>
                <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                  {[
                    {id:'restants', label:`⏳ Restants (${auditStats.a_compter_restants||0})`, color:C.yellow},
                    {id:'comptes', label:`✓ Comptés (${auditStats.a_compter_comptes||0})`, color:C.green},
                    {id:'ecarts', label:`⚠️ Avec écart (${auditStats.a_compter_avec_ecart||0})`, color:C.red},
                    {id:'tous', label:`Tous (${auditStats.total||0})`, color:sub},
                  ].map(f => (
                    <button key={f.id} onClick={()=>setAuditFiltre(f.id as any)}
                      style={{padding:'7px 13px',borderRadius:14,border:`1px solid ${auditFiltre===f.id?f.color:bdr}`,background:auditFiltre===f.id?f.color+'22':'transparent',color:auditFiltre===f.id?f.color:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
                      {f.label}
                    </button>
                  ))}
                </div>
                {!termine && (auditStats.a_compter_restants||0) > 0 && (
                  <button onClick={marquerRestantsZero}
                    title="Marque les SKU non comptés à 0 (pour clore l'audit quand tu n'en as physiquement plus)"
                    style={{marginLeft:'auto',background:'transparent',border:`1px solid ${C.yellow}`,color:C.yellow,borderRadius:8,padding:'7px 12px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                    ⏭ Marquer le reste à 0
                  </button>
                )}
              </div>

              {/* Liste compteur — un seul champ Compté par SKU */}
              <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
                {filteredCounts.length === 0
                  ? <div style={{textAlign:'center',padding:40,color:sub,fontSize:13}}>Aucun résultat</div>
                  : <div style={{overflowX:'auto'}}>
                      <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                        <thead>
                          <tr style={{background:thBg}}>
                            <th style={{padding:'10px 12px',textAlign:'left',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>SKU</th>
                            <th style={{padding:'10px 12px',textAlign:'left',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Description</th>
                            <th style={{padding:'10px 12px',textAlign:'right',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`1px solid ${bdr}`}}>Théorique</th>
                            <th style={{padding:'10px 12px',textAlign:'center',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.green,borderBottom:`1px solid ${bdr}`}}>Compté</th>
                            <th style={{padding:'10px 12px',textAlign:'center',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`1px solid ${bdr}`}}>Écart</th>
                            <th style={{padding:'10px 12px',textAlign:'right',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Valeur</th>
                            <th style={{padding:'10px 12px',textAlign:'center',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Statut</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredCounts.map((c:any) => {
                            const input = auditInput[c.base_code] || {}
                            const theo = Number(c.total_theorique_net||0)
                            // Valeur live (input non sauvegardé) > valeur sauvée
                            const inputVal = input.total !== undefined && input.total !== '' ? Number(input.total) : null
                            const savedVal = c.total_compte != null ? Number(c.total_compte) : null
                            const compte = inputVal != null ? inputVal : savedVal
                            const ecart = compte != null ? compte - theo : null
                            const valeur = ecart != null ? ecart * Number(c.coutant||0) : null
                            const isCompte = savedVal != null
                            const hasEcart = ecart != null && ecart !== 0
                            const rowBg = !isCompte
                              ? 'transparent'
                              : hasEcart
                                ? (dark?'#2b1113':'#fff8f8')
                                : (dark?'#0d2a18':'#e6f4ea')
                            return (
                              <tr key={c.base_code} style={{background:rowBg,borderLeft:isCompte?`3px solid ${hasEcart?C.red:C.green}`:`3px solid transparent`}}>
                                <td style={{padding:'10px 12px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:800,fontSize:14}}>{c.base_code}</td>
                                <td style={{padding:'10px 12px',borderBottom:`1px solid ${bdr}`,fontSize:12,color:sub,maxWidth:280,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={c.description}>{c.description||'—'}</td>
                                <td style={{padding:'10px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,fontSize:16,color:C.blue}}>{theo}</td>
                                <td style={{padding:'8px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                                  <input type="number" disabled={termine}
                                    value={input.total ?? ''}
                                    onChange={e=>setAuditInput(prev=>({...prev,[c.base_code]:{total:e.target.value}}))}
                                    onBlur={()=>sauvegarderComptage(c.base_code)}
                                    onKeyDown={(e:any)=>{ if (e.key === 'Enter') { e.target.blur() } }}
                                    style={{width:90,padding:'9px 10px',fontSize:16,fontWeight:800,border:`2px solid ${!isCompte?bdr:hasEcart?C.red:C.green}`,borderRadius:8,textAlign:'center',background:dark?'#1a1a1a':'#fff',color:dark?'#fff':'#000'}}/>
                                </td>
                                <td style={{padding:'10px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                                  {ecart == null
                                    ? <span style={{color:sub,fontSize:12}}>—</span>
                                    : ecart === 0
                                      ? <span style={{color:C.green,fontWeight:900,fontSize:14}}>✓ 0</span>
                                      : <span style={{background:(ecart<0?C.red:C.blue)+'22',color:ecart<0?C.red:C.blue,padding:'4px 10px',borderRadius:8,fontWeight:900,fontSize:14}}>{ecart>0?'+':''}{ecart}</span>}
                                </td>
                                <td style={{padding:'10px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,fontSize:12,color:!valeur||valeur===0?sub:valeur<0?C.red:C.blue}}>
                                  {valeur==null||valeur===0?'—':fmt$(valeur)}
                                </td>
                                <td style={{padding:'10px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                                  {!isCompte
                                    ? <span style={{color:C.yellow,fontSize:11,fontWeight:700}}>⏳ Restant</span>
                                    : hasEcart
                                      ? <span style={{color:C.red,fontSize:11,fontWeight:700}}>⚠️ Écart</span>
                                      : <span style={{color:C.green,fontSize:18,fontWeight:900}}>✓</span>}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                }
              </div>

              {/* Réconciliation FBA Amazon vs Traction (vue admin/compta repliable) */}
              {(() => {
                const fbaRows = (auditCounts || []).filter((c:any) =>
                  Number(c.fba_amazon_theorique||0) > 0 || Number(c.fba_traction_theorique||0) > 0
                ).filter((c:any) => {
                  const fbaT = Number(c.fba_traction_theorique||0)
                  const fbaA = Number(c.fba_amazon_theorique||0)
                  return Math.abs(fbaA - fbaT) > 1
                })
                if (fbaRows.length === 0) return null
                return (
                  <div style={{marginTop:14,background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
                    <button onClick={()=>setShowFbaReconcil(!showFbaReconcil)}
                      style={{width:'100%',background:'transparent',border:'none',padding:'12px 16px',display:'flex',justifyContent:'space-between',alignItems:'center',cursor:'pointer',color:dark?'#fff':'#1a1a1a'}}>
                      <div style={{display:'flex',alignItems:'center',gap:10}}>
                        <span style={{fontSize:13,fontWeight:800}}>📦 Réconciliation FBA Amazon ↔ Traction</span>
                        <span style={{background:C.red+'22',color:C.red,padding:'2px 8px',borderRadius:8,fontSize:11,fontWeight:700}}>{fbaRows.length} écart{fbaRows.length>1?'s':''}</span>
                      </div>
                      <span style={{color:sub,fontSize:13}}>{showFbaReconcil ? '▼' : '▶'}</span>
                    </button>
                    {showFbaReconcil && (
                      <div style={{borderTop:`1px solid ${bdr}`,overflowX:'auto'}}>
                        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                          <thead><tr style={{background:thBg}}>
                            <th style={{padding:'8px 12px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>SKU</th>
                            <th style={{padding:'8px 12px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Description</th>
                            <th style={{padding:'8px 12px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`1px solid ${bdr}`}}>FBA Traction</th>
                            <th style={{padding:'8px 12px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`1px solid ${bdr}`}}>Chez Amazon</th>
                            <th style={{padding:'8px 12px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`1px solid ${bdr}`}}>Δ FBA</th>
                          </tr></thead>
                          <tbody>
                            {fbaRows.map((c:any) => {
                              const fbaT = Number(c.fba_traction_theorique||0)
                              const fbaA = Number(c.fba_amazon_theorique||0)
                              const d = fbaA - fbaT
                              return (
                                <tr key={c.base_code}>
                                  <td style={{padding:'7px 12px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700}}>{c.base_code}</td>
                                  <td style={{padding:'7px 12px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={c.description}>{c.description||'—'}</td>
                                  <td style={{padding:'7px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700}}>{fbaT}</td>
                                  <td style={{padding:'7px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700}}>{fbaA}</td>
                                  <td style={{padding:'7px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:900,color:d<0?C.red:C.blue}}>{d>0?'+':''}{d}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Modal de finalisation intelligente */}
              {showFinaliseModal && !termine && (() => {
                const restants = (auditCounts || []).filter((c:any) =>
                  Number(c.total_theorique_net||0) > 0 && c.total_compte == null
                ).length
                const avecEcart = auditStats.a_compter_avec_ecart || 0
                return (
                  <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}
                       onClick={()=>setShowFinaliseModal(false)}>
                    <div onClick={(e:any)=>e.stopPropagation()} style={{background:card,borderRadius:14,maxWidth:520,width:'100%',border:`2px solid ${C.green}`,padding:22,boxShadow:'0 10px 40px rgba(0,0,0,.4)'}}>
                      <div style={{fontSize:18,fontWeight:900,color:C.green,marginBottom:6}}>✓ Finaliser l'audit</div>
                      <div style={{fontSize:12,color:sub,marginBottom:16}}>{openAudit.label} — {openAudit.mois}</div>

                      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:16}}>
                        <div style={{background:dark?'#0d2a18':'#e6f4ea',borderRadius:10,padding:'12px',textAlign:'center',border:`1px solid ${C.green}33`}}>
                          <div style={{fontSize:10,color:sub,textTransform:'uppercase',fontWeight:700}}>Comptés</div>
                          <div style={{fontSize:24,fontWeight:900,color:C.green}}>{auditStats.a_compter_comptes||0}</div>
                        </div>
                        <div style={{background:restants>0?(dark?'#2b2411':'#fffcf5'):(dark?'#1a1a1a':'#f8f9fa'),borderRadius:10,padding:'12px',textAlign:'center',border:`1px solid ${restants>0?C.yellow+'66':bdr}`}}>
                          <div style={{fontSize:10,color:sub,textTransform:'uppercase',fontWeight:700}}>Restants</div>
                          <div style={{fontSize:24,fontWeight:900,color:restants>0?C.yellow:sub}}>{restants}</div>
                        </div>
                      </div>

                      {restants > 0 && (
                        <div style={{background:dark?'#2b2411':'#fef9e6',border:`1px solid ${C.yellow}`,borderRadius:10,padding:'12px 14px',marginBottom:14,fontSize:12,color:dark?'#ffc107':'#856404',lineHeight:1.5}}>
                          ⚠️ Il reste <strong>{restants} SKU non comptés</strong>. Tu peux soit :
                          <ul style={{margin:'8px 0 0 0',paddingLeft:18}}>
                            <li>Les marquer à 0 (si tu n'en as physiquement plus)</li>
                            <li>Les laisser tels quels (l'audit se ferme avec ces SKU non comptés)</li>
                            <li>Annuler et continuer à compter</li>
                          </ul>
                        </div>
                      )}

                      {avecEcart > 0 && (
                        <div style={{background:dark?'#2b1113':'#fce8e6',border:`1px solid ${C.red}`,borderRadius:10,padding:'12px 14px',marginBottom:14,fontSize:12,color:C.red,lineHeight:1.5}}>
                          ⚠️ <strong>{avecEcart} SKU avec écart</strong> — vérifie l'onglet <strong>Avec écart</strong> avant de finaliser. Manques : <strong>{fmt$(auditStats.valeur_manques||0).replace('−','')}</strong> · Surplus : <strong>+{fmt$(auditStats.valeur_surplus||0).replace('−','')}</strong>
                        </div>
                      )}

                      <div style={{display:'flex',gap:8,justifyContent:'flex-end',flexWrap:'wrap'}}>
                        <button onClick={()=>setShowFinaliseModal(false)}
                          style={{background:'transparent',border:`1px solid ${bdr}`,color:sub,borderRadius:8,padding:'10px 16px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                          Annuler
                        </button>
                        {restants > 0 && (
                          <button onClick={async()=>{ await marquerRestantsZero() }}
                            style={{background:'transparent',border:`1px solid ${C.yellow}`,color:C.yellow,borderRadius:8,padding:'10px 16px',fontWeight:700,cursor:'pointer',fontSize:12}}>
                            ⏭ Marquer reste à 0
                          </button>
                        )}
                        <button onClick={finaliserAudit}
                          style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'10px 18px',fontWeight:800,cursor:'pointer',fontSize:13}}>
                          ✓ Finaliser maintenant
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}
        </div>
        )
      })()}

      {vue === 'mapping' && (
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,marginBottom:10,flexWrap:'wrap'}}>
            <div style={{fontSize:11,color:sub,maxWidth:600}}>
              Ces SKU Amazon n'ont pas pu être résolus automatiquement en code Traction.
              Le champ est pré-rempli avec la meilleure suggestion (si ≥80%). Les matches ≥95% sont déjà auto-appliqués.
            </div>
            <button onClick={()=>autoResolve(false)}
              style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
              🔁 Auto-résoudre (≥95%)
            </button>
          </div>

          {unresolved.length === 0
            ? <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,textAlign:'center',padding:30,color:sub}}>✅ Tous les SKU sont résolus</div>
            : <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden',marginBottom:14}}>
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                    <thead><tr style={{background:thBg}}>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>SKU Amazon</th>
                      <th style={{padding:'8px 10px',textAlign:'center',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}># lignes</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Sources</th>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Code Traction</th>
                      <th style={{padding:'8px 10px',borderBottom:`1px solid ${bdr}`}}></th>
                    </tr></thead>
                    <tbody>
                      {unresolved.map((u:any) => {
                        const suggestions = u.suggestions || []
                        const topSug = suggestions[0]
                        return (
                        <tr key={u.amazon_sku} style={{borderBottom:`1px solid ${bdr}`}}>
                          <td style={{padding:'10px',fontFamily:'monospace',fontWeight:700,verticalAlign:'top'}}>{u.amazon_sku}</td>
                          <td style={{padding:'10px',textAlign:'center',color:sub,verticalAlign:'top'}}>{u.count}</td>
                          <td style={{padding:'10px',fontSize:11,color:sub,verticalAlign:'top'}}>{(u.sources||[]).join(', ')}</td>
                          <td style={{padding:'10px',verticalAlign:'top'}}>
                            <input
                              value={mappingInput[u.amazon_sku] ?? (topSug?.traction_code || '')}
                              onChange={e=>setMappingInput(prev=>({...prev,[u.amazon_sku]:e.target.value}))}
                              placeholder="PKCode Traction..."
                              style={{...S,fontSize:12,padding:'5px 8px',minWidth:160,fontFamily:'monospace',borderColor:topSug?(topSug.score>=0.9?C.green:C.yellow):bdr}}
                              onKeyDown={e=>{ if (e.key==='Enter') validerMapping(u.amazon_sku) }}/>
                            {suggestions.length > 0 && (
                              <div style={{marginTop:6,display:'flex',gap:4,flexWrap:'wrap',alignItems:'center'}}>
                                <span style={{fontSize:10,color:sub,fontWeight:700}}>
                                  {topSug.score>=0.9?'💡':'⚠️'} Propositions :
                                </span>
                                {suggestions.map((s:any) => {
                                  const scoreColor = s.score>=0.95 ? C.green : s.score>=0.88 ? C.blue : C.yellow
                                  const isChosen = (mappingInput[u.amazon_sku] ?? topSug?.traction_code) === s.traction_code
                                  return (
                                    <button key={s.traction_code}
                                      onClick={()=>setMappingInput(prev=>({...prev,[u.amazon_sku]:s.traction_code}))}
                                      title={`Source: ${s.source} · Score: ${(s.score*100).toFixed(0)}%`}
                                      style={{background:isChosen?scoreColor+'33':'transparent',border:`1px solid ${scoreColor}`,borderRadius:10,padding:'3px 8px',fontFamily:'monospace',fontSize:11,cursor:'pointer',color:scoreColor,fontWeight:700}}>
                                      {s.traction_code} <span style={{fontSize:9,opacity:0.8}}>{(s.score*100).toFixed(0)}%</span>
                                    </button>
                                  )
                                })}
                              </div>
                            )}
                          </td>
                          <td style={{padding:'10px',textAlign:'right',verticalAlign:'top'}}>
                            <button onClick={()=>{
                                const codeToUse = mappingInput[u.amazon_sku] ?? topSug?.traction_code
                                if (codeToUse && mappingInput[u.amazon_sku] === undefined) {
                                  setMappingInput(prev=>({...prev, [u.amazon_sku]: codeToUse}))
                                }
                                validerMapping(u.amazon_sku)
                              }}
                              style={{background:C.green,color:'#fff',border:'none',borderRadius:6,padding:'5px 12px',fontWeight:700,cursor:'pointer',fontSize:11}}>
                              ✓ Mapper
                            </button>
                          </td>
                        </tr>
                      )})}
                    </tbody>
                  </table>
                </div>
              </div>
          }

          {/* Mappings existants */}
          <div style={{fontSize:12,fontWeight:700,color:sub,marginBottom:6}}>Mappings mémorisés ({mappings.length})</div>
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
            {mappings.length === 0
              ? <div style={{textAlign:'center',padding:20,color:sub,fontSize:12}}>Aucun mapping enregistré</div>
              : <div style={{overflowX:'auto',maxHeight:400}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                    <thead><tr style={{background:thBg,position:'sticky',top:0}}>
                      <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>SKU Amazon</th>
                      <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>→ Traction</th>
                      <th style={{padding:'7px 10px',textAlign:'center',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Source</th>
                      <th style={{padding:'7px 10px',textAlign:'center',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`1px solid ${bdr}`}}>Confiance</th>
                      <th style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`}}></th>
                    </tr></thead>
                    <tbody>
                      {mappings.map((m:any) => (
                        <tr key={m.id}>
                          <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700}}>{m.amazon_sku}</td>
                          <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',color:C.blue}}>{m.traction_code}</td>
                          <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                            <span style={{background:m.source==='manuel'?C.green+'22':C.blue+'22',color:m.source==='manuel'?C.green:C.blue,padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>
                              {m.source}
                            </span>
                          </td>
                          <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontSize:11,color:sub}}>{Number(m.confidence||0).toFixed(2)}</td>
                          <td style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>
                            <button onClick={()=>supprimerMapping(m.amazon_sku)}
                              style={{background:'transparent',color:C.red,border:`1px solid ${C.red}`,borderRadius:6,padding:'3px 8px',fontSize:11,cursor:'pointer',fontWeight:700}}>
                              🗑
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
            }
          </div>
        </div>
      )}
    </div>
  )
}

// ── SCOA — Vue « Performance FNI » (style standard dashboard) ───────────────

// Explications affichées dans les tooltips ⓘ — centralisées pour maintenance
const FNI_EXPL = {
  unites:        "Nombre de véhicules vendus sur la période.",
  prix_vente:    "Somme des prix de vente véhicule (hors produits FNI).",
  ventes_fni:    "Montant total des produits FNI (financement, garantie, etc.) vendus avec les véhicules.",
  profit_fni:    "Profit dégagé sur les produits FNI uniquement (pas le profit véhicule).",
  marge_fni:     "Profit FNI ÷ Prix de Vente. Mesure la contribution du FNI au chiffre d'affaires véhicule. Cible interne : 9 %.",
  attach_fni:    "% de deals avec au moins un produit FNI vendu. Mesure ta capacité à vendre du FNI.",
  fni_par_u:     "Profit FNI ÷ Nombre total d'unités vendues. Combien chaque vente rapporte en FNI en moyenne (incluant les cash deals).",
  cash_deals:    "Nombre de deals vendus SANS produit FNI. Chaque cash deal = manque à gagner.",
  pct_cash:      "Cash deals ÷ Unités totales. Plus c'est bas, mieux c'est (= tu as vendu du FNI à plus de monde).",
  manque:        "Si tu avais le FNI/unité du meilleur vendeur sur chacune de tes marques, combien tu aurais gagné en plus. Formule : tes_unités × (meilleur_FNI/u − ton_FNI/u).",
  manque_marge:  "Variante du manque à gagner basée sur la marge FNI : tes_ventes_fni × (meilleure_marge − ta_marge).",
  occasion:      "Véhicules d'occasion : tout #stock avec au moins une lettre (ex. C24-0001B, AC25-0331). Regroupés ensemble, peu importe la marque réelle.",
  medailles:     "Top 3 vendeurs par catégorie. 🥇 Or = #1, 🥈 Argent = #2, 🥉 Bronze = #3.",
  classement:    "Pour chaque marque : qui domine en profit FNI (et la marge totale de l'équipe sur cette marque).",
  mensuel_cash:  "Pour chaque mois : combien de deals financés (bleu) vs en cash (jaune). % cash sous chaque colonne.",
  comparatif:    "Tes valeurs vs la moyenne de toute l'équipe. ▲ vert = au-dessus, ▼ rouge = en-dessous.",
  detail_mensuel:"Mois par mois, tes chiffres FNI : unités, ventes FNI, profit FNI, % marge, attach, % cash, FNI/u.",
  perf_marque:   "Performance détaillée de ce vendeur sur chacune de ses marques.",
  vendor_card:   "Synthèse de chaque vendeur avec écart vs moyenne du groupe (▲▼).",
  cible_9:       "Cible interne Mathias Marine : 9 % de marge brute FNI. 🟢 ≥9 % · 🟡 7-9 % · 🔴 <7 %.",
}

function ScoaFniView({dashboard, ventes, loading, filtDebut, filtFin, isMobile, dark, card, bdr, sub, thBg, C, S, onAllerImport, onRefresh}: any) {
  const [sousVue, setSousVue] = useState<string>('comparatif')
  const [analyseIa, setAnalyseIa] = useState<{texte: string, manque: number, duree: number, generee_le?: string|null, sauvegardee?: boolean}|null>(null)
  const [analyseLoading, setAnalyseLoading] = useState(false)
  const [fniAssignments, setFniAssignments] = useState<any[]>([])
  const [fniAssignMsg, setFniAssignMsg] = useState<string|null>(null)
  const [fniAssignLoading, setFniAssignLoading] = useState(false)
  const fileRefFniAssign = useRef<HTMLInputElement|null>(null)

  useEffect(() => {
    fetch('/api/scoa/fni-assignments').then(r => r.json()).then(d => {
      if (d.assignments) setFniAssignments(d.assignments)
    }).catch(()=>{})
  }, [])

  async function importerFniAssignments(file: File) {
    setFniAssignLoading(true)
    setFniAssignMsg('⏳ Import en cours…')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/scoa/fni-assignments/import', { method:'POST', body: fd })
      const d = await r.json()
      if (r.ok && d.success) {
        const diag = d.diagnostic
        let msg = `✅ ${d.upserted} attributions sauvegardées`
        if (diag) {
          msg += ` · ${diag.ventes_matchees}/${d.upserted} stocks matchés en DB`
          if (diag.ventes_avec_vendeur_change > 0) {
            msg += ` · 🔄 ${diag.ventes_avec_vendeur_change} ventes ré-attribuées`
          } else {
            msg += ` · ⚠️ Aucune vente ré-attribuée (les mappings confirment l'existant)`
          }
        }
        setFniAssignMsg(msg)
        if (diag && diag.exemples_changements?.length) {
          console.log('Exemples de ré-attributions :', diag.exemples_changements)
        }
        // Recharger la liste + rafraichir le dashboard
        const r2 = await fetch('/api/scoa/fni-assignments')
        const d2 = await r2.json()
        if (d2.assignments) setFniAssignments(d2.assignments)
        if (typeof onRefresh === 'function') onRefresh()
        setTimeout(()=>setFniAssignMsg(null), 12000)
      } else {
        setFniAssignMsg(`❌ ${d.erreur || 'Erreur import'}`)
      }
    } catch (e:any) {
      setFniAssignMsg(`❌ ${e.message}`)
    } finally {
      setFniAssignLoading(false)
      if (fileRefFniAssign.current) fileRefFniAssign.current.value = ''
    }
  }

  async function lancerAnalyseIa(vendeur_nom: string) {
    setAnalyseLoading(true)
    setAnalyseIa(null)
    try {
      const r = await fetch('/api/scoa/fni-analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendeur_nom, filtDebut, filtFin }),
      })
      const d = await r.json()
      if (r.ok && d.analyse) {
        setAnalyseIa({ texte: d.analyse, manque: d.manque_total || 0, duree: d.duree_ms || 0, generee_le: d.generee_le, sauvegardee: true })
      } else {
        setAnalyseIa({ texte: `❌ ${d.erreur || 'Analyse impossible'}`, manque: 0, duree: 0 })
      }
    } catch (e:any) {
      setAnalyseIa({ texte: `❌ Erreur : ${e.message}`, manque: 0, duree: 0 })
    }
    setAnalyseLoading(false)
  }

  // Au changement de vendeur : charger l'analyse sauvegardée (si elle existe)
  useEffect(() => {
    setAnalyseIa(null)
    if (sousVue === 'comparatif') return
    let actif = true
    ;(async () => {
      try {
        const r = await fetch(`/api/scoa/fni-analyse?vendeur_nom=${encodeURIComponent(sousVue)}`)
        if (!r.ok) return
        const d = await r.json()
        if (actif && d.analyse) {
          setAnalyseIa({ texte: d.analyse, manque: d.manque_total || 0, duree: d.duree_ms || 0, generee_le: d.generee_le, sauvegardee: true })
        }
      } catch {}
    })()
    return () => { actif = false }
  }, [sousVue])

  // Helper tooltip — petit "i" cerclé. Sans-serif gras pour être lisible
  // en petit (sinon l'italique serif ressemble à un "?").
  const Info = ({ t }: { t: string }) => (
    <span title={t} aria-label={t} className="scoa-fni-no-print"
      style={{
        display:'inline-flex',alignItems:'center',justifyContent:'center',
        width:14,height:14,marginLeft:5,borderRadius:'50%',
        background:C.blue,color:'#fff',
        fontSize:10,fontWeight:900,lineHeight:1,
        cursor:'help',verticalAlign:'middle',
        fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontStyle:'normal',
        userSelect:'none',
      }}>
      i
    </span>
  )

  const fmt$ = (n: number) => '$' + (Math.round(n||0)).toLocaleString('fr-CA')
  const fmtPct = (n: number) => ((n||0) * 100).toFixed(1).replace('.', ',') + '%'
  const fmtInt = (n: number) => Math.round(n||0).toLocaleString('fr-CA')

  if (loading) {
    return <div style={{textAlign:'center',padding:40,color:sub,fontSize:13}}>⏳ Chargement…</div>
  }
  if (!dashboard || dashboard.nb_total === 0) {
    return (
      <div style={{background:card,border:`1px dashed ${bdr}`,borderRadius:10,textAlign:'center',padding:40,color:sub}}>
        <div style={{fontSize:14,fontWeight:700,marginBottom:8}}>Aucune vente importée</div>
        <div style={{fontSize:12,marginBottom:14}}>Importe un rapport SCOA (PDF) pour activer le dashboard FNI.</div>
        <button onClick={onAllerImport}
          style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'9px 16px',fontWeight:700,cursor:'pointer',fontSize:12}}>
          📥 Aller à l'import
        </button>
      </div>
    )
  }

  const g = dashboard.global || {}
  const parMarque: any[] = dashboard.par_marque || []
  const parVendeur: any[] = dashboard.par_vendeur || []
  const topFniParMarque: any[] = dashboard.top_fni_par_marque || []

  const cashDeals = (g.nb || 0) - (g.nb_avec_fni || 0)
  const pctCash = g.nb ? (cashDeals / g.nb) : 0
  // % Marge FNI = Profit FNI ÷ Prix de Vente (pas ÷ Ventes FNI).
  // Mesure la contribution du FNI au chiffre d'affaires véhicule.
  const pctMargeFni = g.total_prix > 0 ? g.total_profit_fni / g.total_prix : 0
  const fniParUnite = g.nb ? g.total_profit_fni / g.nb : 0

  // Agrégation mensuelle.
  // Un deal est compté « financé » si profit_fni != 0 (FNI sold, profitable
  // ou non) et « cash » si profit_fni = 0 (aucun produit FNI vendu).
  const parMois = (() => {
    const m = new Map<string, { units:number, cash:number, fni:number }>()
    for (const v of (ventes || [])) {
      if (!v.date_vente) continue
      const key = String(v.date_vente).slice(0, 7)
      if (!m.has(key)) m.set(key, { units:0, cash:0, fni:0 })
      const e = m.get(key)!
      e.units++
      if (Math.abs(Number(v.profit_fni || 0)) > 0.01) e.fni++; else e.cash++
    }
    return [...m.entries()]
      .map(([mois, e]) => ({ mois, ...e, pct_cash: e.units ? e.cash/e.units : 0 }))
      .sort((a, b) => a.mois.localeCompare(b.mois))
  })()

  // Convertit "2025-11" → "Novembre 2025" (mois en français)
  const MOIS_FR_LONG = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']
  const MOIS_FR_COURT = ['Jan','Fév','Mar','Avr','Mai','Juin','Juil','Août','Sep','Oct','Nov','Déc']
  const moisLabel = (key: string, court = false) => {
    const m = /^(\d{4})-(\d{2})$/.exec(key)
    if (!m) return key
    const noMois = parseInt(m[2], 10) - 1
    if (noMois < 0 || noMois > 11) return key
    return court ? MOIS_FR_COURT[noMois] : `${MOIS_FR_LONG[noMois]} ${m[1]}`
  }

  const CIBLE_FNI = 0.09
  const SEUIL_AMBRE = 0.07
  const periode = (filtDebut || filtFin) ? `${filtDebut||'…'} → ${filtFin||'…'}` : 'Toute la période'

  const topVendeurs = [...parVendeur].sort((a,b)=>b.total_profit_fni - a.total_profit_fni).slice(0, 6)

  // Détecte les « marques fantômes » = fragments de noms d'entreprises clientes
  // mal interprétés par le parser SCOA (cas : nom de client avec un numéro
  // stock-like dedans). Ex : « Inc. », « Inc », « Qc », « In », « Ltée ».
  // Ces deals sont valides côté ventes mais leur marque est inutilisable.
  // Le fix permanent est dans le parser (commit 899daeb + ré-import).
  const SUFFIXES_ENTREPRISE = new Set(['INC','INC.','QC','IN','LTD','LTD.','LTÉE','LTEE','ENR','CO','CORP','SA','SARL','SAS','EURL'])
  const estMarqueFantome = (marque: string): boolean => {
    if (!marque) return true
    const m = marque.trim().toUpperCase()
    if (m.length <= 3 && SUFFIXES_ENTREPRISE.has(m)) return true
    if (m.endsWith('.') && m.length <= 5) return true   // "Inc.", "Ltd.", "Co."
    if (SUFFIXES_ENTREPRISE.has(m)) return true
    return false
  }

  // Reconstruit la performance par marque pour un vendeur précis directement
  // depuis les ventes brutes (et non depuis topFniParMarque qui limite à top 3).
  // Ça garantit que le tableau « Performance par marque » contient TOUTES les
  // marques du vendeur et que son total matche le total mensuel.
  const marquesPourVendeur = (nomV: string) => {
    const m = new Map<string, any>()
    for (const v of (ventes || [])) {
      if (v.vendeur_nom !== nomV) continue
      const k = v.marque || 'Inconnue'
      if (!m.has(k)) m.set(k, { units:0, prix:0, ventes_fni:0, profit_fni:0, nb_avec_fni:0 })
      const e = m.get(k)
      e.units++
      e.prix       += Number(v.prix_vente || 0)
      e.ventes_fni += Number(v.ventes_fni || 0)
      e.profit_fni += Number(v.profit_fni || 0)
      if (Math.abs(Number(v.profit_fni || 0)) > 0.01) e.nb_avec_fni++
    }
    return [...m.entries()]
      .filter(([marque]) => !estMarqueFantome(marque))
      .map(([marque, e]) => ({
        marque,
        units: e.units,
        prix_vente: e.prix,
        ventes_fni: e.ventes_fni,
        profit_fni: e.profit_fni,
        pct_marge_fni: e.prix > 0 ? e.profit_fni / e.prix : 0,
        cash_deals: e.units - e.nb_avec_fni,
        pct_cash: e.units ? (e.units - e.nb_avec_fni) / e.units : 0,
        fni_par_unite: e.units ? e.profit_fni / e.units : 0,
        attach_fni: e.units ? e.nb_avec_fni / e.units : 0,
      })).sort((a, b) => b.units - a.units)
  }

  const margeColor = (pct: number) => pct >= CIBLE_FNI ? C.green : pct >= SEUIL_AMBRE ? C.yellow : C.red
  const margeBadge = (pct: number) => {
    const col = margeColor(pct)
    return <span style={{background:col+'22',color:col,padding:'2px 8px',borderRadius:6,fontSize:11,fontWeight:700,whiteSpace:'nowrap'}}>{fmtPct(pct)}</span>
  }

  // Moyennes du groupe — pour comparer chaque vendeur
  const grpMargeFni    = pctMargeFni
  const grpAttachFni   = g.attach_fni || 0
  const grpFniParUnite = fniParUnite
  const grpPctCash     = pctCash
  const deltaBadge = (val: number, ref: number, positifEstBon = true) => {
    const diff = val - ref
    const isPositif = positifEstBon ? diff >= 0 : diff <= 0
    const col = Math.abs(diff) < 0.005 ? sub : (isPositif ? C.green : C.red)
    const arr = diff > 0 ? '▲' : diff < 0 ? '▼' : '='
    return <span style={{color:col,fontSize:10,fontWeight:700,marginLeft:4}}>{arr} {fmtPct(Math.abs(diff))}</span>
  }
  const delta$Badge = (val: number, ref: number, positifEstBon = true) => {
    const diff = val - ref
    const isPositif = positifEstBon ? diff >= 0 : diff <= 0
    const col = Math.abs(diff) < 1 ? sub : (isPositif ? C.green : C.red)
    const arr = diff > 0 ? '▲' : diff < 0 ? '▼' : '='
    return <span style={{color:col,fontSize:10,fontWeight:700,marginLeft:4}}>{arr} {fmt$(Math.abs(diff))}</span>
  }

  // ─── Manque à gagner par vendeur × marque ─────────────────────────────
  // Pour chaque marque, on identifie le meilleur vendeur (FNI/u le plus élevé).
  // Pour chaque autre vendeur sur cette marque :
  //   manque = ses_unités × (meilleur_FNI_par_u - son_FNI_par_u)
  // = "Si tu avais le FNI/u du meilleur sur cette marque, tu aurais gagné X de plus."
  const manquesParVendeur = (() => {
    const map = new Map<string, { marque:string, units:number, monFniU:number, bestFniU:number, bestVendeur:string, manque:number, monProfitFni:number, manqueMarge:number }[]>()
    for (const m of topFniParMarque) {
      if (!m.top_vendeurs || m.top_vendeurs.length === 0) continue
      // Tri par FNI/u décroissant pour trouver le meilleur sur la marque
      const sortedFniU = [...m.top_vendeurs].sort((a:any, b:any) => {
        const aF = a.nb ? a.total_profit_fni / a.nb : 0
        const bF = b.nb ? b.total_profit_fni / b.nb : 0
        return bF - aF
      })
      const best = sortedFniU[0]
      const bestFniPerU = best.nb ? best.total_profit_fni / best.nb : 0
      // Meilleur % marge sur la marque (= profit_fni / prix_vente)
      const bestMarge = Math.max(0, ...m.top_vendeurs.map((x:any) => x.total_prix > 0 ? x.total_profit_fni / x.total_prix : 0))

      for (const v of m.top_vendeurs) {
        const vFniPerU = v.nb ? v.total_profit_fni / v.nb : 0
        const manque = Math.max(0, v.nb * (bestFniPerU - vFniPerU))
        const vMarge = v.total_prix > 0 ? v.total_profit_fni / v.total_prix : 0
        const manqueMarge = Math.max(0, v.total_prix * (bestMarge - vMarge))
        if (!map.has(v.vendeur_nom)) map.set(v.vendeur_nom, [])
        map.get(v.vendeur_nom)!.push({
          marque: m.marque,
          units: v.nb,
          monFniU: vFniPerU,
          bestFniU: bestFniPerU,
          bestVendeur: best.vendeur_nom,
          manque,
          monProfitFni: v.total_profit_fni,
          manqueMarge,
        })
      }
    }
    return map
  })()

  const manqueTotalParVendeur = (nomV: string) => {
    const lst = manquesParVendeur.get(nomV) || []
    return lst.reduce((s, x) => s + x.manque, 0)
  }
  const manqueTotalEquipe = topVendeurs.reduce((s, v) => s + manqueTotalParVendeur(v.vendeur_nom), 0)

  // ─── Médailles : top 3 par catégorie ──────────────────────────────────
  const medailles = (() => {
    const cats: { titre:string, icon:string, format:(v:any)=>string, value:(v:any)=>number, desc:string, positifEstBon:boolean }[] = [
      { titre:'Profit FNI total',   icon:'💰', format: v => fmt$(v.total_profit_fni), value: v => v.total_profit_fni, desc:'$ FNI rapportés', positifEstBon:true },
      { titre:'% Marge FNI',        icon:'📊', format: v => fmtPct(v.total_prix>0 ? v.total_profit_fni/v.total_prix : 0), value: v => v.total_prix>0 ? v.total_profit_fni/v.total_prix : 0, desc:'profit FNI / prix vente', positifEstBon:true },
      { titre:'Attach FNI',         icon:'🔗', format: v => fmtPct(v.attach_fni), value: v => v.attach_fni, desc:'% deals avec FNI', positifEstBon:true },
      { titre:'FNI / unité',        icon:'💵', format: v => fmt$(v.nb ? v.total_profit_fni/v.nb : 0), value: v => v.nb ? v.total_profit_fni/v.nb : 0, desc:'$ FNI par vente', positifEstBon:true },
      { titre:'Moins de cash',      icon:'🚫', format: v => fmtPct(v.nb ? (v.nb - v.nb_avec_fni)/v.nb : 0), value: v => v.nb ? -(v.nb - v.nb_avec_fni)/v.nb : 0, desc:'plus c\'est bas, mieux c\'est', positifEstBon:true },
    ]
    return cats.map(c => {
      const ranking = [...topVendeurs].sort((a,b) => c.value(b) - c.value(a))
      return {
        ...c,
        gagnant: ranking[0] || null,
        podium: ranking.slice(0, 3),
      }
    })
  })()

  // Mensuel par vendeur — calculé depuis ventes brutes filtrées par vendeur_nom
  const moisParVendeur = (nomV: string) => {
    const m = new Map<string, { units:number, prix:number, ventes_fni:number, profit_fni:number, cash:number, fni:number }>()
    for (const v of (ventes || [])) {
      if (!v.date_vente || v.vendeur_nom !== nomV) continue
      const key = String(v.date_vente).slice(0, 7)
      if (!m.has(key)) m.set(key, { units:0, prix:0, ventes_fni:0, profit_fni:0, cash:0, fni:0 })
      const e = m.get(key)!
      e.units++
      e.prix += Number(v.prix_vente||0)
      e.ventes_fni += Number(v.ventes_fni||0)
      e.profit_fni += Number(v.profit_fni||0)
      // « Financé » = profit_fni != 0 (FNI vendu, profitable ou non)
      if (Math.abs(Number(v.profit_fni||0)) > 0.01) e.fni++; else e.cash++
    }
    return [...m.entries()]
      .map(([mois, e]) => ({
        mois, ...e,
        pct_marge_fni: e.prix > 0 ? e.profit_fni/e.prix : 0,
        pct_cash: e.units ? e.cash/e.units : 0,
        attach: e.units ? e.fni/e.units : 0,
        fni_par_unite: e.units ? e.profit_fni/e.units : 0,
      }))
      .sort((a, b) => a.mois.localeCompare(b.mois))
  }

  return (
    <div>
      {/* En-tête + bouton import */}
      <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',marginBottom:12,display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
        <div style={{flex:1,minWidth:220}}>
          <div style={{fontSize:14,fontWeight:900,color:C.blue}}>🏆 Performance FNI — Comparatif vendeurs</div>
          <div style={{fontSize:11,color:sub,marginTop:2}}>
            Cible 9 % marge brute FNI · Période : {periode} · Données : {fmtInt(g.nb)} unités importées (PDF SCOA)
          </div>
        </div>
        <input ref={fileRefFniAssign} type="file" accept=".xlsx,.xls"
          style={{display:'none'}}
          onChange={e => { const f = e.target.files?.[0]; if (f) importerFniAssignments(f) }}/>
        <button onClick={()=>fileRefFniAssign.current?.click()} disabled={fniAssignLoading}
          title="Excel à 2 colonnes : FNI (nom du spécialiste) + Stock (#stock). Les ventes de ces stocks seront attribuées au FNI indiqué, peu importe le vendeur du véhicule."
          style={{background:'transparent',color:C.blue,border:`1px solid ${C.blue}`,borderRadius:8,padding:'8px 12px',fontWeight:700,cursor:fniAssignLoading?'wait':'pointer',fontSize:12,whiteSpace:'nowrap'}}>
          📋 Attributions FNI ({fniAssignments.length})
        </button>
        <button onClick={onAllerImport}
          style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
          📥 Importer un rapport FNI
        </button>
      </div>
      {fniAssignMsg && (
        <div style={{marginBottom:10,padding:'8px 12px',borderRadius:6,fontSize:12,fontWeight:600,
          background: fniAssignMsg.startsWith('✅') ? '#e6f4ea' : fniAssignMsg.startsWith('❌') ? '#fce8e6' : '#e8f0fe',
          color: fniAssignMsg.startsWith('✅') ? C.green : fniAssignMsg.startsWith('❌') ? C.red : C.blue}}>
          {fniAssignMsg}
        </div>
      )}

      {/* Sous-tabs : Comparatif + un par vendeur */}
      <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
        <button onClick={()=>setSousVue('comparatif')}
          style={{padding:'7px 12px',borderRadius:16,border:`2px solid ${sousVue==='comparatif'?C.yellow:bdr}`,background:sousVue==='comparatif'?(dark?'#2b2411':'#fffcf5'):'transparent',color:sousVue==='comparatif'?C.yellow:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
          🏆 Comparatif global
        </button>
        {topVendeurs.map(v => (
          <button key={v.vendeur_nom} onClick={()=>setSousVue(v.vendeur_nom)}
            style={{padding:'7px 12px',borderRadius:16,border:`2px solid ${sousVue===v.vendeur_nom?C.blue:bdr}`,background:sousVue===v.vendeur_nom?(dark?'#1a233a':'#e8f0fe'):'transparent',color:sousVue===v.vendeur_nom?C.blue:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
            👤 {v.vendeur_nom} <span style={{opacity:.6,fontSize:10}}>({v.nb})</span>
          </button>
        ))}
      </div>

      {/* ─── COMPARATIF ─────────────────────────────────────────────── */}
      {sousVue === 'comparatif' && <>

        {/* KPIs globaux FNI */}
        <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(6,1fr)',gap:8,marginBottom:12}}>
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${sub}`}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Unités totales<Info t={FNI_EXPL.unites}/></div>
            <div style={{fontSize:20,fontWeight:900}}>{fmtInt(g.nb)}</div>
          </div>
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Ventes FNI<Info t={FNI_EXPL.ventes_fni}/></div>
            <div style={{fontSize:16,fontWeight:900,color:C.blue}}>{fmt$(g.total_ventes_fni)}</div>
          </div>
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.green}`}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Profit FNI<Info t={FNI_EXPL.profit_fni}/></div>
            <div style={{fontSize:16,fontWeight:900,color:C.green}}>{fmt$(g.total_profit_fni)}</div>
          </div>
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${margeColor(pctMargeFni)}`}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>% Marge FNI<Info t={FNI_EXPL.marge_fni}/></div>
            <div style={{fontSize:16,fontWeight:900,color:margeColor(pctMargeFni)}}>{fmtPct(pctMargeFni)}</div>
            <div style={{fontSize:10,color:sub}}>cible 9%</div>
          </div>
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.yellow}`}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Cash deals<Info t={FNI_EXPL.cash_deals}/></div>
            <div style={{fontSize:16,fontWeight:900,color:C.yellow}}>{cashDeals}</div>
            <div style={{fontSize:10,color:sub}}>{fmtPct(pctCash)} des ventes</div>
          </div>
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${sub}`}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>FNI / unité<Info t={FNI_EXPL.fni_par_u}/></div>
            <div style={{fontSize:16,fontWeight:900}}>{fmt$(fniParUnite)}</div>
          </div>
        </div>

        {/* 🏅 Tableau des médailles — top 3 par catégorie */}
        {topVendeurs.length > 0 && (
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>🏅 Tableau des médailles<Info t={FNI_EXPL.medailles}/></div>
            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'repeat(auto-fit, minmax(190px, 1fr))',gap:8}}>
              {medailles.map(m => (
                <div key={m.titre} style={{padding:'10px 12px',background:dark?'#0f0f0f':'#fafbfc',border:`1px solid ${bdr}`,borderTop:`3px solid ${C.yellow}`,borderRadius:8}}>
                  <div style={{fontSize:10,fontWeight:700,color:sub,textTransform:'uppercase',letterSpacing:'.05em'}}>{m.icon} {m.titre}</div>
                  <div style={{fontSize:10,color:sub,marginBottom:8}}>{m.desc}</div>
                  {m.podium.length === 0 ? <div style={{color:sub,fontSize:11,fontStyle:'italic'}}>—</div> : m.podium.map((v:any, i:number) => (
                    <div key={v.vendeur_nom} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'4px 0',borderTop:i>0?`1px solid ${bdr}`:'none'}}>
                      <div style={{fontSize:12,fontWeight:i===0?800:600}}>
                        <span style={{marginRight:6}}>{i===0?'🥇':i===1?'🥈':'🥉'}</span>
                        {v.vendeur_nom}
                      </div>
                      <div style={{fontSize:11,fontWeight:700,color:i===0?C.green:undefined}}>{m.format(v)}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 💰 Manque à gagner total équipe */}
        {manqueTotalEquipe > 0 && (
          <div style={{background:'#fff8e6',border:`2px solid ${C.yellow}`,borderRadius:10,padding:'14px 16px',marginBottom:12}}>
            <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
              <div style={{fontSize:32}}>💰</div>
              <div style={{flex:1,minWidth:220}}>
                <div style={{fontSize:13,fontWeight:900,color:'#b06a00'}}>Manque à gagner total équipe : {fmt$(manqueTotalEquipe)}<Info t={FNI_EXPL.manque}/></div>
                <div style={{fontSize:11,color:sub,marginTop:2}}>
                  Si chaque vendeur atteignait le FNI/u du meilleur sur chacune de ses marques, l'équipe aurait fait <strong>{fmt$(manqueTotalEquipe)} de plus</strong> sur la période.
                </div>
              </div>
            </div>
            <div style={{marginTop:10,display:'grid',gridTemplateColumns:isMobile?'1fr':'repeat(auto-fit, minmax(180px, 1fr))',gap:8}}>
              {[...topVendeurs].map(v => ({ v, m: manqueTotalParVendeur(v.vendeur_nom) }))
                .sort((a, b) => b.m - a.m)
                .map(({v, m}) => (
                  <div key={v.vendeur_nom} style={{background:'#fff',border:`1px solid ${bdr}`,borderLeft:`3px solid ${m>0?C.red:C.green}`,borderRadius:6,padding:'8px 10px'}}>
                    <div style={{fontSize:11,fontWeight:700}}>{v.vendeur_nom}</div>
                    <div style={{fontSize:14,fontWeight:900,color:m>0?C.red:C.green}}>{m>0 ? fmt$(m) : '✓ Top'}</div>
                    <div style={{fontSize:10,color:sub}}>{m>0 ? 'à rattraper' : 'meilleur sur toutes ses marques'}</div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Vendor cards */}
        <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',marginBottom:12}}>
          <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>👥 Performance par vendeur<Info t={FNI_EXPL.vendor_card}/></div>
          {topVendeurs.length === 0 ? (
            <div style={{color:sub,fontSize:12,fontStyle:'italic',padding:10}}>Aucun vendeur identifié.</div>
          ) : (
            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'repeat(auto-fit, minmax(220px, 1fr))',gap:10}}>
              {topVendeurs.map((v, i) => {
                const vMargeFni = v.total_prix > 0 ? v.total_profit_fni / v.total_prix : 0
                const vPctCash = v.nb ? (v.nb - v.nb_avec_fni) / v.nb : 0
                const vFniParU = v.nb ? v.total_profit_fni / v.nb : 0
                return (
                  <div key={v.vendeur_nom} style={{background:dark?'#0f0f0f':'#fafbfc',border:`1px solid ${bdr}`,borderLeft:`3px solid ${i===0?C.yellow:C.blue}`,borderRadius:8,padding:'10px 12px',position:'relative'}}>
                    {i===0 && <div style={{position:'absolute',top:-8,right:8,background:C.yellow,color:'#fff',padding:'2px 8px',fontSize:9,fontWeight:700,borderRadius:4}}>🏆 #1 FNI</div>}
                    <div style={{fontSize:13,fontWeight:800,marginBottom:2}}>{v.vendeur_nom}</div>
                    <div style={{fontSize:10,color:sub,marginBottom:8}}>{v.nb} unités vendues · <span style={{opacity:.7}}>vs moyenne groupe</span></div>
                    <div style={{fontSize:11,display:'flex',justifyContent:'space-between',padding:'3px 0',borderTop:`1px solid ${bdr}`}}>
                      <span style={{color:sub}}>Profit FNI<Info t={FNI_EXPL.profit_fni}/></span>
                      <span><strong style={{color:C.green}}>{fmt$(v.total_profit_fni)}</strong></span>
                    </div>
                    <div style={{fontSize:11,display:'flex',justifyContent:'space-between',padding:'3px 0',borderTop:`1px solid ${bdr}`}}>
                      <span style={{color:sub}}>% Marge<Info t={FNI_EXPL.marge_fni}/></span>
                      <span><strong style={{color:margeColor(vMargeFni)}}>{fmtPct(vMargeFni)}</strong>{deltaBadge(vMargeFni, grpMargeFni)}</span>
                    </div>
                    <div style={{fontSize:11,display:'flex',justifyContent:'space-between',padding:'3px 0',borderTop:`1px solid ${bdr}`}}>
                      <span style={{color:sub}}>Attach FNI<Info t={FNI_EXPL.attach_fni}/></span>
                      <span><strong>{fmtPct(v.attach_fni)}</strong>{deltaBadge(v.attach_fni, grpAttachFni)}</span>
                    </div>
                    <div style={{fontSize:11,display:'flex',justifyContent:'space-between',padding:'3px 0',borderTop:`1px solid ${bdr}`}}>
                      <span style={{color:sub}}>FNI / u<Info t={FNI_EXPL.fni_par_u}/></span>
                      <span><strong>{fmt$(vFniParU)}</strong>{delta$Badge(vFniParU, grpFniParUnite)}</span>
                    </div>
                    <div style={{fontSize:11,display:'flex',justifyContent:'space-between',padding:'3px 0',borderTop:`1px solid ${bdr}`}}>
                      <span style={{color:sub}}>% Cash<Info t={FNI_EXPL.pct_cash}/></span>
                      <span><strong style={{color:vPctCash>0.4?C.yellow:undefined}}>{fmtPct(vPctCash)}</strong>{deltaBadge(vPctCash, grpPctCash, false)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Classement par marque */}
        <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',marginBottom:12}}>
          <div style={{fontSize:12,fontWeight:800,marginBottom:8}}>🏷 Classement par marque (qui domine le FNI)<Info t={FNI_EXPL.classement}/></div>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,minWidth:600}}>
              <thead>
                <tr style={{background:thBg}}>
                  <th style={{padding:'8px',textAlign:'left',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>Marque</th>
                  <th style={{padding:'8px',textAlign:'right',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>Unités</th>
                  <th style={{padding:'8px',textAlign:'right',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>$ FNI total</th>
                  <th style={{padding:'8px',textAlign:'right',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>% Marge</th>
                  <th style={{padding:'8px',textAlign:'left',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>🏆 Vendeur #1</th>
                </tr>
              </thead>
              <tbody>
                {topFniParMarque.filter(m => !estMarqueFantome(m.marque)).map(m => {
                  const pm = parMarque.find(p => p.marque === m.marque)
                  const margeM = pm && pm.total_prix > 0 ? pm.total_profit_fni / pm.total_prix : 0
                  const top = m.top_vendeurs[0]
                  return (
                    <tr key={m.marque}>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{m.marque}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmtInt(m.nb_total)}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:C.green}}>{fmt$(m.brand_profit_fni_total)}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{margeBadge(margeM)}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>
                        {top ? <><strong>{top.vendeur_nom}</strong> <span style={{color:sub}}>({fmt$(top.total_profit_fni)})</span></> : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Mensuel cash vs FNI — graphique en barres + petit tableau résumé */}
        {parMois.length > 0 && (() => {
          const totalFni = parMois.reduce((s, m) => s + m.fni, 0)
          const totalCash = parMois.reduce((s, m) => s + m.cash, 0)
          const totalUnits = totalFni + totalCash
          const maxUnits = Math.max(...parMois.map(x => x.units), 1)
          return (
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'14px 16px',marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14,flexWrap:'wrap',gap:8}}>
              <div style={{fontSize:13,fontWeight:800}}>📅 Cash deal vs Financement par mois<Info t={FNI_EXPL.mensuel_cash}/></div>
              <div style={{display:'flex',gap:14,fontSize:11,alignItems:'center'}}>
                <span><span style={{display:'inline-block',width:12,height:12,background:C.blue,borderRadius:3,marginRight:5,verticalAlign:'middle'}}></span><strong>{totalFni}</strong> financés ({totalUnits ? fmtPct(totalFni/totalUnits) : '—'})</span>
                <span><span style={{display:'inline-block',width:12,height:12,background:C.yellow,borderRadius:3,marginRight:5,verticalAlign:'middle'}}></span><strong>{totalCash}</strong> cash ({totalUnits ? fmtPct(totalCash/totalUnits) : '—'})</span>
              </div>
            </div>

            {/* Graphique en barres avec noms de mois */}
            <div style={{display:'grid',gridTemplateColumns:`repeat(${Math.max(parMois.length,1)}, 1fr)`,gap:10,alignItems:'flex-end',height:200,padding:'0 4px',borderBottom:`1px solid ${bdr}`}}>
              {parMois.map(m => {
                const hFni = (m.fni / maxUnits) * 180
                const hCash = (m.cash / maxUnits) * 180
                return (
                  <div key={m.mois} style={{display:'flex',flexDirection:'column',justifyContent:'flex-end',alignItems:'center',gap:2,position:'relative'}}>
                    {/* Total au-dessus */}
                    <div style={{fontSize:11,fontWeight:700,color:sub,marginBottom:2}}>{m.units}</div>
                    <div style={{display:'flex',alignItems:'flex-end',gap:5,height:180,width:'100%',justifyContent:'center'}}>
                      <div style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
                        <div title={`${m.fni} financés`} style={{width:22,background:C.blue,height:Math.max(hFni,m.fni>0?6:0),borderRadius:'4px 4px 0 0',position:'relative'}}>
                          {m.fni > 0 && <div style={{position:'absolute',top:-15,left:'50%',transform:'translateX(-50%)',fontSize:10,fontWeight:700,color:C.blue}}>{m.fni}</div>}
                        </div>
                      </div>
                      <div style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
                        <div title={`${m.cash} cash`} style={{width:22,background:C.yellow,height:Math.max(hCash,m.cash>0?6:0),borderRadius:'4px 4px 0 0',position:'relative'}}>
                          {m.cash > 0 && <div style={{position:'absolute',top:-15,left:'50%',transform:'translateX(-50%)',fontSize:10,fontWeight:700,color:C.yellow}}>{m.cash}</div>}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            <div style={{display:'grid',gridTemplateColumns:`repeat(${Math.max(parMois.length,1)}, 1fr)`,gap:10,fontSize:11,textAlign:'center',marginTop:8,padding:'0 4px'}}>
              {parMois.map(m => (
                <div key={m.mois} style={{display:'flex',flexDirection:'column',gap:2}}>
                  <div style={{fontWeight:700}}>{moisLabel(m.mois, true)} <span style={{color:sub,fontWeight:400,fontSize:10}}>{m.mois.slice(2,4)}</span></div>
                  <div style={{fontSize:10}}>
                    <span style={{color:m.pct_cash>0.4?C.red:m.pct_cash>0.25?C.yellow:C.green,fontWeight:700}}>{fmtPct(m.pct_cash)} cash</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Tableau résumé sous le graphique */}
            <div style={{marginTop:14,overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:11,minWidth:500}}>
                <thead>
                  <tr style={{background:thBg}}>
                    <th style={{padding:'7px 8px',textAlign:'left',fontSize:10,fontWeight:700,borderBottom:`1px solid ${bdr}`,textTransform:'uppercase'}}>Mois</th>
                    <th style={{padding:'7px 8px',textAlign:'right',fontSize:10,fontWeight:700,borderBottom:`1px solid ${bdr}`,textTransform:'uppercase'}}>Total</th>
                    <th style={{padding:'7px 8px',textAlign:'right',fontSize:10,fontWeight:700,borderBottom:`1px solid ${bdr}`,textTransform:'uppercase',color:C.blue}}>Financés</th>
                    <th style={{padding:'7px 8px',textAlign:'right',fontSize:10,fontWeight:700,borderBottom:`1px solid ${bdr}`,textTransform:'uppercase',color:C.yellow}}>Cash</th>
                    <th style={{padding:'7px 8px',textAlign:'right',fontSize:10,fontWeight:700,borderBottom:`1px solid ${bdr}`,textTransform:'uppercase'}}>% Financés</th>
                    <th style={{padding:'7px 8px',textAlign:'right',fontSize:10,fontWeight:700,borderBottom:`1px solid ${bdr}`,textTransform:'uppercase'}}>% Cash</th>
                  </tr>
                </thead>
                <tbody>
                  {parMois.map(m => {
                    const pctFin = m.units ? m.fni/m.units : 0
                    return (
                      <tr key={m.mois}>
                        <td style={{padding:'7px 8px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{moisLabel(m.mois)}</td>
                        <td style={{padding:'7px 8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{m.units}</td>
                        <td style={{padding:'7px 8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:C.blue,fontWeight:700}}>{m.fni}</td>
                        <td style={{padding:'7px 8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:C.yellow,fontWeight:700}}>{m.cash}</td>
                        <td style={{padding:'7px 8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}><span style={{background:C.blue+'22',color:C.blue,padding:'2px 7px',borderRadius:4,fontSize:10,fontWeight:700}}>{fmtPct(pctFin)}</span></td>
                        <td style={{padding:'7px 8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}><span style={{background:C.yellow+'22',color:C.yellow,padding:'2px 7px',borderRadius:4,fontSize:10,fontWeight:700}}>{fmtPct(m.pct_cash)}</span></td>
                      </tr>
                    )
                  })}
                  <tr style={{background:dark?'#1a1a1a':'#f0f0f0',fontWeight:800}}>
                    <td style={{padding:'8px',fontSize:11}}>TOTAL</td>
                    <td style={{padding:'8px',textAlign:'right'}}>{totalUnits}</td>
                    <td style={{padding:'8px',textAlign:'right',color:C.blue}}>{totalFni}</td>
                    <td style={{padding:'8px',textAlign:'right',color:C.yellow}}>{totalCash}</td>
                    <td style={{padding:'8px',textAlign:'right'}}>{totalUnits ? fmtPct(totalFni/totalUnits) : '—'}</td>
                    <td style={{padding:'8px',textAlign:'right'}}>{totalUnits ? fmtPct(totalCash/totalUnits) : '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          )
        })()}
      </>}

      {/* ─── PAR VENDEUR ────────────────────────────────────────────── */}
      {sousVue !== 'comparatif' && (() => {
        const v = topVendeurs.find(x => x.vendeur_nom === sousVue) || parVendeur.find(x => x.vendeur_nom === sousVue)
        if (!v) return <div style={{padding:20,color:sub,fontStyle:'italic'}}>Vendeur introuvable.</div>
        const vMarges = marquesPourVendeur(v.vendeur_nom)
        const vMargeFni = v.total_prix > 0 ? v.total_profit_fni / v.total_prix : 0
        const vPctCash = v.nb ? (v.nb - v.nb_avec_fni) / v.nb : 0
        return <>
          {/* CSS @media print : ne montrer que le rapport vendeur quand on imprime */}
          <style>{`
            @media print {
              @page { size: letter portrait; margin: 0.4in; }
              body * { visibility: hidden; }
              .scoa-fni-print, .scoa-fni-print * { visibility: visible; }
              .scoa-fni-print { position: absolute; left: 0; top: 0; width: 100%; }
              .scoa-fni-no-print { display: none !important; }
            }
          `}</style>
          {/* Bandeau actions */}
          <div className="scoa-fni-no-print" style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,padding:'8px 12px',background:'#e8f0fe',border:`1px solid ${C.blue}33`,borderRadius:8,gap:8,flexWrap:'wrap'}}>
            <div style={{fontSize:12,color:C.blue,flex:1,minWidth:180}}>📄 Fiche vendeur de <strong>{v.vendeur_nom}</strong></div>
            <button onClick={()=>lancerAnalyseIa(v.vendeur_nom)} disabled={analyseLoading}
              title={analyseIa ? "Régénère une nouvelle analyse (écrase la précédente)" : "Note managériale IA : positionnement, forces, lacunes, pistes pour aider le vendeur."}
              style={{background:analyseLoading?sub:'#7b1fa2',color:'#fff',border:'none',borderRadius:6,padding:'7px 14px',fontWeight:700,cursor:analyseLoading?'wait':'pointer',fontSize:12,whiteSpace:'nowrap'}}>
              {analyseLoading ? '⏳ Analyse en cours…' : analyseIa ? '🔄 Régénérer l\'analyse' : '🧠 Analyse IA'}
            </button>
            <button onClick={()=>window.print()}
              style={{background:C.blue,color:'#fff',border:'none',borderRadius:6,padding:'7px 14px',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
              🖨 Imprimer la fiche
            </button>
          </div>

          {/* Résultat de l'analyse IA */}
          {analyseIa && (
            <div style={{background:card,border:`2px solid #7b1fa2`,borderRadius:10,padding:'14px 18px',marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,flexWrap:'wrap',gap:8}}>
                <div style={{fontSize:13,fontWeight:900,color:'#7b1fa2'}}>🧠 Note managériale — {v.vendeur_nom}</div>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  {analyseIa.generee_le && (
                    <span style={{fontSize:10,color:sub}}>
                      📅 {new Date(analyseIa.generee_le).toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' })}
                      {analyseIa.duree > 0 && <> · ⏱ {(analyseIa.duree/1000).toFixed(1)}s · Claude Sonnet 4.5</>}
                    </span>
                  )}
                  <button onClick={()=>setAnalyseIa(null)} className="scoa-fni-no-print"
                    title="Masquer (l'analyse reste sauvegardée, elle réapparaitra à la prochaine ouverture)"
                    style={{background:'transparent',border:'none',color:sub,cursor:'pointer',fontSize:14}}>✕</button>
                </div>
              </div>
              <div style={{fontSize:13,lineHeight:1.6,whiteSpace:'pre-wrap',color:dark?'#eee':'#222'}}>{analyseIa.texte}</div>
            </div>
          )}

          <div className="scoa-fni-print">
          <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(8,1fr)',gap:8,marginBottom:12}}>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${sub}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Unités<Info t={FNI_EXPL.unites}/></div>
              <div style={{fontSize:18,fontWeight:900}}>{fmtInt(v.nb)}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Prix vente<Info t={FNI_EXPL.prix_vente}/></div>
              <div style={{fontSize:15,fontWeight:900,color:C.blue}}>{fmt$(v.total_prix)}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Ventes FNI<Info t={FNI_EXPL.ventes_fni}/></div>
              <div style={{fontSize:15,fontWeight:900,color:C.blue}}>{fmt$(v.total_ventes_fni)}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${v.total_profit_fni>=0?C.green:C.red}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Profit FNI<Info t={FNI_EXPL.profit_fni}/></div>
              <div style={{fontSize:15,fontWeight:900,color:v.total_profit_fni>=0?C.green:C.red}}>{fmt$(v.total_profit_fni)}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${margeColor(vMargeFni)}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>% Marge FNI<Info t={FNI_EXPL.marge_fni}/></div>
              <div style={{fontSize:15,fontWeight:900,color:margeColor(vMargeFni)}}>{fmtPct(vMargeFni)}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.yellow}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>% Cash<Info t={FNI_EXPL.pct_cash}/></div>
              <div style={{fontSize:15,fontWeight:900,color:C.yellow}}>{fmtPct(vPctCash)}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${sub}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Attach FNI<Info t={FNI_EXPL.attach_fni}/></div>
              <div style={{fontSize:15,fontWeight:900}}>{fmtPct(v.attach_fni)}</div>
            </div>
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.green}`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>FNI / u<Info t={FNI_EXPL.fni_par_u}/></div>
              <div style={{fontSize:15,fontWeight:900,color:C.green}}>{fmt$(v.nb ? v.total_profit_fni/v.nb : 0)}</div>
            </div>
          </div>

          {/* Comparatif vs moyenne du groupe */}
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:800,marginBottom:8}}>📐 Comparatif vs moyenne du groupe</div>
            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(4,1fr)',gap:8}}>
              <div style={{padding:'8px 10px',border:`1px solid ${bdr}`,borderRadius:6,background:dark?'#0f0f0f':'#fafbfc'}}>
                <div style={{fontSize:10,fontWeight:700,color:sub,textTransform:'uppercase'}}>% Marge FNI</div>
                <div style={{fontSize:14,fontWeight:900,color:margeColor(vMargeFni)}}>{fmtPct(vMargeFni)}</div>
                <div style={{fontSize:10,color:sub,marginTop:2}}>Groupe : <strong>{fmtPct(grpMargeFni)}</strong> {deltaBadge(vMargeFni, grpMargeFni)}</div>
              </div>
              <div style={{padding:'8px 10px',border:`1px solid ${bdr}`,borderRadius:6,background:dark?'#0f0f0f':'#fafbfc'}}>
                <div style={{fontSize:10,fontWeight:700,color:sub,textTransform:'uppercase'}}>Attach FNI</div>
                <div style={{fontSize:14,fontWeight:900}}>{fmtPct(v.attach_fni)}</div>
                <div style={{fontSize:10,color:sub,marginTop:2}}>Groupe : <strong>{fmtPct(grpAttachFni)}</strong> {deltaBadge(v.attach_fni, grpAttachFni)}</div>
              </div>
              <div style={{padding:'8px 10px',border:`1px solid ${bdr}`,borderRadius:6,background:dark?'#0f0f0f':'#fafbfc'}}>
                <div style={{fontSize:10,fontWeight:700,color:sub,textTransform:'uppercase'}}>FNI / u</div>
                <div style={{fontSize:14,fontWeight:900,color:C.green}}>{fmt$(v.nb ? v.total_profit_fni/v.nb : 0)}</div>
                <div style={{fontSize:10,color:sub,marginTop:2}}>Groupe : <strong>{fmt$(grpFniParUnite)}</strong> {delta$Badge(v.nb ? v.total_profit_fni/v.nb : 0, grpFniParUnite)}</div>
              </div>
              <div style={{padding:'8px 10px',border:`1px solid ${bdr}`,borderRadius:6,background:dark?'#0f0f0f':'#fafbfc'}}>
                <div style={{fontSize:10,fontWeight:700,color:sub,textTransform:'uppercase'}}>% Cash</div>
                <div style={{fontSize:14,fontWeight:900,color:C.yellow}}>{fmtPct(vPctCash)}</div>
                <div style={{fontSize:10,color:sub,marginTop:2}}>Groupe : <strong>{fmtPct(grpPctCash)}</strong> {deltaBadge(vPctCash, grpPctCash, false)}</div>
              </div>
            </div>
          </div>

          {/* 🎯 Manque à gagner par marque (coaching) */}
          {(() => {
            const mqList = (manquesParVendeur.get(v.vendeur_nom) || [])
              .filter(x => x.manque > 0)
              .sort((a, b) => b.manque - a.manque)
            const totalMq = mqList.reduce((s, x) => s + x.manque, 0)
            const totalMqMarge = mqList.reduce((s, x) => s + x.manqueMarge, 0)
            const ptsForts = (manquesParVendeur.get(v.vendeur_nom) || [])
              .filter(x => x.bestVendeur === v.vendeur_nom)
              .sort((a, b) => b.monProfitFni - a.monProfitFni)
            return (
              <div style={{background:card,border:`2px solid ${totalMq>0?C.yellow:C.green}`,borderRadius:10,padding:'12px 14px',marginBottom:12}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:8,marginBottom:10}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:900,color:totalMq>0?'#b06a00':C.green}}>🎯 Manque à gagner par marque</div>
                    <div style={{fontSize:11,color:sub,marginTop:2}}>« Si tu avais le FNI/u du meilleur sur chacune de tes marques »</div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div style={{fontSize:10,color:sub,textTransform:'uppercase'}}>Total à rattraper</div>
                    <div style={{fontSize:20,fontWeight:900,color:totalMq>0?C.red:C.green}}>{totalMq>0 ? fmt$(totalMq) : '✓ Top performer'}</div>
                    {totalMqMarge>0 && <div style={{fontSize:10,color:sub}}>via % marge : {fmt$(totalMqMarge)}</div>}
                  </div>
                </div>

                {ptsForts.length > 0 && (
                  <div style={{marginBottom:10,padding:'8px 10px',background:'#e6f4ea',border:`1px solid ${C.green}33`,borderRadius:6}}>
                    <div style={{fontSize:11,fontWeight:800,color:C.green,marginBottom:4}}>🟢 Tes marques fortes — tu domines l'équipe</div>
                    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                      {ptsForts.slice(0, 5).map(p => (
                        <span key={p.marque} style={{background:'#fff',padding:'3px 8px',borderRadius:4,fontSize:11,fontWeight:700,color:C.green,border:`1px solid ${C.green}44`}}>
                          {p.marque} · {fmt$(p.monFniU)}/u
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {mqList.length === 0 ? (
                  <div style={{padding:14,textAlign:'center',color:C.green,fontSize:12,fontWeight:600,fontStyle:'italic'}}>
                    Aucun manque à gagner — tu es au top sur toutes tes marques 🎉
                  </div>
                ) : (
                  <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,minWidth:700}}>
                      <thead>
                        <tr style={{background:thBg}}>
                          <th style={{padding:'8px',textAlign:'left',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>Marque</th>
                          <th style={{padding:'8px',textAlign:'right',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>Mes unités</th>
                          <th style={{padding:'8px',textAlign:'right',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>Mon FNI/u</th>
                          <th style={{padding:'8px',textAlign:'right',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>Meilleur FNI/u</th>
                          <th style={{padding:'8px',textAlign:'left',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>Meilleur</th>
                          <th style={{padding:'8px',textAlign:'right',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>Écart $/u</th>
                          <th style={{padding:'8px',textAlign:'right',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>Manque $</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mqList.map(x => (
                          <tr key={x.marque}>
                            <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{x.marque}</td>
                            <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmtInt(x.units)}</td>
                            <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmt$(x.monFniU)}</td>
                            <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:C.green}}>{fmt$(x.bestFniU)}</td>
                            <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>{x.bestVendeur}</td>
                            <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:C.red}}>−{fmt$(x.bestFniU - x.monFniU)}</td>
                            <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800,color:C.red}}>{fmt$(x.manque)}</td>
                          </tr>
                        ))}
                        <tr style={{background:dark?'#1a1a1a':'#f0f0f0',fontWeight:800}}>
                          <td colSpan={6} style={{padding:'8px',textAlign:'right'}}>TOTAL :</td>
                          <td style={{padding:'8px',textAlign:'right',color:C.red,fontSize:14}}>{fmt$(totalMq)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Détail mensuel */}
          {(() => {
            const moisV = moisParVendeur(v.vendeur_nom)
            if (moisV.length === 0) return null
            return (
              <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',marginBottom:12}}>
                <div style={{fontSize:12,fontWeight:800,marginBottom:8}}>📅 Détail mensuel — {v.vendeur_nom}</div>
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,minWidth:700}}>
                    <thead>
                      <tr style={{background:thBg}}>
                        {['Mois','Unités','Ventes FNI','Profit FNI','% Marge','Attach','% Cash','FNI / u'].map((h,i) => (
                          <th key={h} style={{padding:'8px',textAlign:i===0?'left':'right',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {moisV.map(m => (
                        <tr key={m.mois}>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{moisLabel(m.mois)}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmtInt(m.units)}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmt$(m.ventes_fni)}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:m.profit_fni>=0?C.green:C.red}}>{fmt$(m.profit_fni)}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{margeBadge(m.pct_marge_fni)}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmtPct(m.attach)}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmtPct(m.pct_cash)}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmt$(m.fni_par_unite)}</td>
                        </tr>
                      ))}
                      {/* TOTAL — somme sur tous les mois (= valeurs globales du vendeur) */}
                      {(() => {
                        const totUnits  = moisV.reduce((s:any,m:any)=>s+m.units, 0)
                        const totPrix   = moisV.reduce((s:any,m:any)=>s+m.prix, 0)
                        const totVFni   = moisV.reduce((s:any,m:any)=>s+m.ventes_fni, 0)
                        const totPFni   = moisV.reduce((s:any,m:any)=>s+m.profit_fni, 0)
                        const totFni    = moisV.reduce((s:any,m:any)=>s+m.fni, 0)
                        const totCash   = moisV.reduce((s:any,m:any)=>s+m.cash, 0)
                        const totMarge  = totPrix > 0 ? totPFni/totPrix : 0
                        const totAttach = totUnits ? totFni/totUnits : 0
                        const totPctC   = totUnits ? totCash/totUnits : 0
                        const totFniU   = totUnits ? totPFni/totUnits : 0
                        return (
                          <tr style={{background:dark?'#1a1a1a':'#f0f0f0',fontWeight:800,borderTop:`2px solid ${bdr}`}}>
                            <td style={{padding:'9px 8px'}}>TOTAL</td>
                            <td style={{padding:'9px 8px',textAlign:'right'}}>{fmtInt(totUnits)}</td>
                            <td style={{padding:'9px 8px',textAlign:'right'}}>{fmt$(totVFni)}</td>
                            <td style={{padding:'9px 8px',textAlign:'right',color:totPFni>=0?C.green:C.red}}>{fmt$(totPFni)}</td>
                            <td style={{padding:'9px 8px',textAlign:'right'}}>{margeBadge(totMarge)}</td>
                            <td style={{padding:'9px 8px',textAlign:'right'}}>{fmtPct(totAttach)}</td>
                            <td style={{padding:'9px 8px',textAlign:'right'}}>{fmtPct(totPctC)}</td>
                            <td style={{padding:'9px 8px',textAlign:'right'}}>{fmt$(totFniU)}</td>
                          </tr>
                        )
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}

          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px'}}>
            <div style={{fontSize:12,fontWeight:800,marginBottom:8}}>📊 Performance par marque — {v.vendeur_nom}</div>
            <div style={{fontSize:10,color:sub,marginBottom:10}}>🟢 ≥9% · 🟡 7-9% · 🔴 &lt;7% vs cible</div>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,minWidth:800}}>
                <thead>
                  <tr style={{background:thBg}}>
                    {['Marque','Unités','Prix vente','Ventes FNI','Profit FNI','% Marge','Cash','% Cash','FNI / u'].map((h,i) => (
                      <th key={h} style={{padding:'8px',textAlign:i===0?'left':'right',fontSize:11,fontWeight:700,borderBottom:`2px solid ${bdr}`}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {vMarges.length === 0 ? (
                    <tr><td colSpan={9} style={{padding:20,textAlign:'center',color:sub,fontStyle:'italic'}}>Aucune marque pour ce vendeur.</td></tr>
                  ) : <>
                    {vMarges.map(m => (
                      <tr key={m.marque}>
                        <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{m.marque}</td>
                        <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmtInt(m.units)}</td>
                        <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmt$(m.prix_vente)}</td>
                        <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmt$(m.ventes_fni)}</td>
                        <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:m.profit_fni>=0?C.green:C.red}}>{fmt$(m.profit_fni)}</td>
                        <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{margeBadge(m.pct_marge_fni)}</td>
                        <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmtInt(m.cash_deals)}</td>
                        <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmtPct(m.pct_cash)}</td>
                        <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{fmt$(m.fni_par_unite)}</td>
                      </tr>
                    ))}
                    {/* TOTAL — somme sur toutes les marques (= valeurs globales du vendeur).
                        Doit matcher le TOTAL du tableau « Détail mensuel ». */}
                    {(() => {
                      const totUnits = vMarges.reduce((s,m)=>s+m.units, 0)
                      const totPrix  = vMarges.reduce((s,m)=>s+m.prix_vente, 0)
                      const totVFni  = vMarges.reduce((s,m)=>s+m.ventes_fni, 0)
                      const totPFni  = vMarges.reduce((s,m)=>s+m.profit_fni, 0)
                      const totCash  = vMarges.reduce((s,m)=>s+m.cash_deals, 0)
                      const totMarge = totPrix > 0 ? totPFni/totPrix : 0
                      const totPctC  = totUnits ? totCash/totUnits : 0
                      const totFniU  = totUnits ? totPFni/totUnits : 0
                      return (
                        <tr style={{background:dark?'#1a1a1a':'#f0f0f0',fontWeight:800,borderTop:`2px solid ${bdr}`}}>
                          <td style={{padding:'9px 8px'}}>TOTAL</td>
                          <td style={{padding:'9px 8px',textAlign:'right'}}>{fmtInt(totUnits)}</td>
                          <td style={{padding:'9px 8px',textAlign:'right'}}>{fmt$(totPrix)}</td>
                          <td style={{padding:'9px 8px',textAlign:'right'}}>{fmt$(totVFni)}</td>
                          <td style={{padding:'9px 8px',textAlign:'right',color:totPFni>=0?C.green:C.red}}>{fmt$(totPFni)}</td>
                          <td style={{padding:'9px 8px',textAlign:'right'}}>{margeBadge(totMarge)}</td>
                          <td style={{padding:'9px 8px',textAlign:'right'}}>{fmtInt(totCash)}</td>
                          <td style={{padding:'9px 8px',textAlign:'right'}}>{fmtPct(totPctC)}</td>
                          <td style={{padding:'9px 8px',textAlign:'right'}}>{fmt$(totFniU)}</td>
                        </tr>
                      )
                    })()}
                  </>}
                </tbody>
              </table>
            </div>
          </div>
          </div> {/* /scoa-fni-print */}
        </>
      })()}
    </div>
  )
}

// ── SCOA (Analyse des Ventes véhicules) ──────────────────────────────────────
function ScoaTab({dark, card, bdr, sub, thBg, S, C, hvr, profil}: any) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  // Un seul type d'import : un rapport FNI par vendeur. Les anciens 4 types
  // (ps_neuf, ps_usage, bateau_neuf, bateau_usage) restent acceptés côté API
  // pour les données déjà importées, mais ne sont plus exposés dans l'UI.
  const TYPES = [
    {id:'rapport_fni_vendeur', label:'🏆 Rapport FNI par vendeur', color:'#c89b3c'},
  ] as const

  const [vue, setVue] = useState<'fni'|'import'|'dashboard'|'ventes'>('fni')
  const [dashboard, setDashboard] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)
  const [importLog, setImportLog] = useState<string[]>([])
  const [filtTypes, setFiltTypes] = useState<string[]>(['rapport_fni_vendeur'])
  const [filtDebut, setFiltDebut] = useState<string>('')
  const [filtFin, setFiltFin] = useState<string>('')
  const [tabMarqueTri, setTabMarqueTri] = useState<'profit'|'volume'|'attach'|'marge'>('profit')
  const [ventes, setVentes] = useState<any[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})

  const fileRefFniVendeur = useRef<HTMLInputElement | null>(null)
  const filesRef: Record<string, React.MutableRefObject<HTMLInputElement | null>> = {
    rapport_fni_vendeur: fileRefFniVendeur,
  }

  async function charger() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      filtTypes.forEach(t => params.append('type', t))
      if (filtDebut) params.set('date_debut', filtDebut)
      if (filtFin) params.set('date_fin', filtFin)
      const r = await fetch('/api/scoa/dashboard?' + params.toString())
      const j = await r.json()
      if (!j.erreur) setDashboard(j)
      const r2 = await fetch('/api/scoa/ventes?' + params.toString())
      const j2 = await r2.json()
      if (!j2.erreur) {
        setVentes(j2.ventes || [])
        setCounts(j2.counts || {})
      }
    } catch {}
    setLoading(false)
  }

  useEffect(() => { charger() }, [filtTypes.join(','), filtDebut, filtFin])

  async function uploader(type: string, file: File) {
    setImporting(type)
    setImportLog(l => [...l, `📤 Import ${type} : ${file.name}...`])
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('type', type)
      const r = await fetch('/api/scoa/import', { method: 'POST', body: fd })
      const j = await r.json()
      if (j.success) {
        const replaceTxt = j.deleted > 0 ? ` · ${j.deleted} ancienne(s) écrasée(s)` : ''
        setImportLog(l => [...l, `✅ ${file.name} : ${j.inserted} ventes${replaceTxt} (${j.periode_debut} → ${j.periode_fin})`])
        if (j.warnings?.length) {
          setImportLog(l => [...l, `⚠️ ${j.warnings.length} lignes non parsées (détail ci-dessous) :`])
          for (const w of j.warnings) {
            setImportLog(l => [...l, `   • ${w}`])
          }
        }
        await charger()
      } else {
        setImportLog(l => [...l, `❌ ${file.name} : ${j.erreur}`])
      }
    } catch (e: any) {
      setImportLog(l => [...l, `❌ Exception : ${e.message}`])
    }
    setImporting(null)
  }

  function toggleType(t: string) {
    setFiltTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  }

  const fmt$ = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(Number(n || 0)).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`
  const fmtPct = (n: number) => `${(Number(n || 0) * 100).toFixed(1)} %`
  const fmtInt = (n: number) => Number(n || 0).toLocaleString('fr-CA')
  const typeLabel = (t: string) => TYPES.find(x => x.id === t)?.label || t

  const g = dashboard?.global
  const parMarque = dashboard?.par_marque || []
  const parVendeur = dashboard?.par_vendeur || []
  const parModele = dashboard?.par_modele || []
  const parType = dashboard?.par_type || []
  const signaux = dashboard?.signaux || {}

  const marqueTriee = [...parMarque].sort((a:any, b:any) => {
    if (tabMarqueTri === 'volume') return b.nb - a.nb
    if (tabMarqueTri === 'attach') return b.attach_fni - a.attach_fni
    if (tabMarqueTri === 'marge') return b.marge_brute_pct - a.marge_brute_pct
    return b.total_profit_net - a.total_profit_net
  })

  return (
    <div>
      {/* Tabs internes */}
      <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:14,display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
        {[
          {id:'fni', label:'🏆 Performance FNI', color:'#c89b3c'},
          {id:'import', label:'📥 Import', color:C.green},
        ].map(v => (
          <button key={v.id} onClick={()=>setVue(v.id as any)}
            style={{padding:'8px 14px',borderRadius:18,border:`2px solid ${vue===v.id?v.color:bdr}`,background:vue===v.id?(dark?'#1a233a':'#e8f0fe'):'transparent',color:vue===v.id?v.color:sub,fontWeight:700,cursor:'pointer',fontSize:12}}>
            {v.label}
          </button>
        ))}
        <div style={{marginLeft:'auto',fontSize:11,color:sub}}>
          {Object.entries(counts).map(([t,n]) => (
            <span key={t} style={{marginLeft:10}}>{typeLabel(t)} : <strong>{n}</strong></span>
          ))}
        </div>
      </div>

      {/* ─── Vue PERFORMANCE FNI ─── (rapport généré depuis les données importées) */}
      {vue === 'fni' && (
        <ScoaFniView
          dashboard={dashboard}
          ventes={ventes}
          loading={loading}
          filtDebut={filtDebut}
          filtFin={filtFin}
          isMobile={isMobile}
          dark={dark}
          card={card}
          bdr={bdr}
          sub={sub}
          thBg={thBg}
          C={C}
          S={S}
          onAllerImport={() => setVue('import')}
          onRefresh={charger}
        />
      )}

      {/* ─── Vue IMPORT ─── */}
      {vue === 'import' && (
        <div>
          <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:12,padding:'14px 16px',marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:800,marginBottom:4}}>📥 Importer un rapport SCOA (PDF)</div>
            <div style={{fontSize:11,color:sub,marginBottom:12,lineHeight:1.5}}>
              Charge directement le PDF "Analyse des Ventes" exporté de SCOA. Le format est détecté automatiquement (date, client, stock, marque, modèle, prix, profit véhicule, FNI, profit net).
              Un ré-import pour la même période remplace les lignes existantes.
            </div>
            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:10}}>
              {TYPES.map(t => (
                <div key={t.id} style={{background:dark?'#0f0f0f':'#fafbfc',border:`1px solid ${bdr}`,borderRadius:10,padding:'14px 16px'}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
                    <span style={{fontSize:14,fontWeight:800,color:t.color}}>{t.label}</span>
                    <span style={{marginLeft:'auto',fontSize:11,color:sub}}>
                      {counts[t.id]||0} vente{(counts[t.id]||0)>1?'s':''}
                    </span>
                  </div>
                  <input ref={filesRef[t.id]} type="file" accept=".pdf" hidden
                    onChange={e => { const f = e.target.files?.[0]; if (f) uploader(t.id, f); e.target.value = '' }}/>
                  <button onClick={()=>filesRef[t.id].current?.click()} disabled={importing !== null}
                    style={{background:importing===t.id?bdr:t.color,color:'#fff',border:'none',borderRadius:8,padding:'10px 16px',fontWeight:700,cursor:importing?'default':'pointer',fontSize:12,width:'100%'}}>
                    {importing===t.id?'⏳ Import en cours...':`📄 Sélectionner un PDF ${t.label}`}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {importLog.length > 0 && (
            <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <div style={{fontSize:11,fontWeight:700,color:sub,textTransform:'uppercase'}}>Log d'import</div>
                <button onClick={()=>setImportLog([])} style={{background:'transparent',border:'none',color:sub,cursor:'pointer',fontSize:11}}>✕ Effacer</button>
              </div>
              <div style={{fontFamily:'monospace',fontSize:11,maxHeight:300,overflowY:'auto',whiteSpace:'pre-wrap'}}>
                {importLog.map((l, i) => <div key={i} style={{padding:'2px 0',borderBottom:i<importLog.length-1?`1px solid ${bdr}`:'none'}}>{l}</div>)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── Vue DASHBOARD ─── */}
      {vue === 'dashboard' && (
        <div>
          {/* Filtres */}
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:12,display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
            <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
              {TYPES.map(t => (
                <button key={t.id} onClick={()=>toggleType(t.id)}
                  style={{padding:'6px 11px',borderRadius:14,border:`1px solid ${filtTypes.includes(t.id)?t.color:bdr}`,background:filtTypes.includes(t.id)?t.color+'22':'transparent',color:filtTypes.includes(t.id)?t.color:sub,fontWeight:700,cursor:'pointer',fontSize:11}}>
                  {t.label} ({counts[t.id]||0})
                </button>
              ))}
            </div>
            <div style={{display:'flex',gap:6,alignItems:'center',marginLeft:'auto'}}>
              <label style={{fontSize:11,color:sub}}>Du</label>
              <input type="date" value={filtDebut} onChange={e=>setFiltDebut(e.target.value)} style={{...S,fontSize:11,padding:'6px 8px'}}/>
              <label style={{fontSize:11,color:sub}}>au</label>
              <input type="date" value={filtFin} onChange={e=>setFiltFin(e.target.value)} style={{...S,fontSize:11,padding:'6px 8px'}}/>
              {(filtDebut || filtFin) && (
                <button onClick={()=>{setFiltDebut(''); setFiltFin('')}} style={{background:'transparent',border:'none',color:sub,cursor:'pointer',fontSize:11}}>✕</button>
              )}
            </div>
          </div>

          {loading && <div style={{textAlign:'center',padding:40,color:sub,fontSize:13}}>⏳ Chargement...</div>}

          {!loading && (!dashboard || dashboard.nb_total === 0) && (
            <div style={{background:card,border:`1px dashed ${bdr}`,borderRadius:10,textAlign:'center',padding:40,color:sub}}>
              Aucune vente. Importe un rapport SCOA depuis l'onglet Import.
            </div>
          )}

          {!loading && dashboard && dashboard.nb_total > 0 && (
            <>
              {/* Stats globales */}
              <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(6,1fr)',gap:8,marginBottom:12}}>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${sub}`}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Unités</div>
                  <div style={{fontSize:20,fontWeight:900}}>{fmtInt(g.nb)}</div>
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.blue}`}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Ventes totales</div>
                  <div style={{fontSize:16,fontWeight:900,color:C.blue}}>{fmt$(g.total_prix + g.total_ventes_fni)}</div>
                  <div style={{fontSize:10,color:sub}}>Véh : {fmt$(g.total_prix)}</div>
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${g.total_profit_net>=0?C.green:C.red}`}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Profit net</div>
                  <div style={{fontSize:16,fontWeight:900,color:g.total_profit_net>=0?C.green:C.red}}>{fmt$(g.total_profit_net)}</div>
                  <div style={{fontSize:10,color:sub}}>Moy : {fmt$(g.moy_profit_net)}</div>
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.yellow}`}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Attach FNI</div>
                  <div style={{fontSize:16,fontWeight:900,color:C.yellow}}>{fmtPct(g.attach_fni)}</div>
                  <div style={{fontSize:10,color:sub}}>{g.nb_avec_fni}/{g.nb} ventes</div>
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${C.green}`}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Profit FNI moy.</div>
                  <div style={{fontSize:16,fontWeight:900,color:C.green}}>{fmt$(g.moy_profit_fni_si_present)}</div>
                  <div style={{fontSize:10,color:sub}}>quand FNI vendu</div>
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'10px 12px',borderLeft:`3px solid ${sub}`}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Marge brute</div>
                  <div style={{fontSize:16,fontWeight:900}}>{fmtPct(g.marge_brute_pct)}</div>
                  <div style={{fontSize:10,color:sub}}>Jours moy : {Math.round(g.moy_jours)}</div>
                </div>
              </div>

              {/* Par type */}
              {parType.length > 1 && (
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,padding:'12px 14px',marginBottom:12}}>
                  <div style={{fontSize:12,fontWeight:800,marginBottom:8}}>📂 Répartition par type</div>
                  <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'repeat(4,1fr)',gap:8}}>
                    {parType.map((t:any) => (
                      <div key={t.type} style={{background:dark?'#0f0f0f':'#fafbfc',border:`1px solid ${bdr}`,borderRadius:8,padding:'8px 10px'}}>
                        <div style={{fontSize:10,fontWeight:700,color:sub}}>{typeLabel(t.type)}</div>
                        <div style={{fontSize:14,fontWeight:900,marginTop:2}}>{t.nb} unités</div>
                        <div style={{fontSize:11,color:sub}}>Profit net : <strong style={{color:t.total_profit_net>=0?C.green:C.red}}>{fmt$(t.total_profit_net)}</strong></div>
                        <div style={{fontSize:10,color:sub}}>Attach FNI : {fmtPct(t.attach_fni)} • Marge : {fmtPct(t.marge_brute_pct)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Par MARQUE */}
              <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden',marginBottom:12}}>
                <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8}}>
                  <div style={{fontSize:12,fontWeight:800}}>🏷 Performance par MARQUE ({parMarque.length})</div>
                  <div style={{display:'flex',gap:4}}>
                    {[{k:'profit',l:'Profit net'},{k:'volume',l:'Volume'},{k:'attach',l:'Attach FNI'},{k:'marge',l:'Marge %'}].map(o => (
                      <button key={o.k} onClick={()=>setTabMarqueTri(o.k as any)}
                        style={{padding:'4px 10px',borderRadius:12,border:`1px solid ${tabMarqueTri===o.k?C.blue:bdr}`,background:tabMarqueTri===o.k?C.blue+'22':'transparent',color:tabMarqueTri===o.k?C.blue:sub,cursor:'pointer',fontSize:10,fontWeight:700}}>
                        Tri: {o.l}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                    <thead><tr style={{background:thBg}}>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Marque</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Unités</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Prix moy.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Profit véh moy.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}} title="Moyenne du %Brut véhicule par vente (non pondérée)">% profit moy véh</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.yellow}}>Attach FNI</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.green}}>Profit FNI moy.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Marge %</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Jours moy.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue}}>Profit net total</th>
                    </tr></thead>
                    <tbody>
                      {marqueTriee.map((m:any) => (
                        <tr key={m.marque} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{m.marque}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{m.nb}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{fmt$(m.moy_prix)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:m.moy_profit_veh>=0?C.green:C.red,fontWeight:700}}>{fmt$(m.moy_profit_veh)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:m.moy_pct_brut_veh>=0.10?C.green:m.moy_pct_brut_veh>=0?C.yellow:C.red,fontWeight:700}}>{fmtPct(m.moy_pct_brut_veh)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:m.attach_fni>=0.5?C.green:m.attach_fni>=0.3?C.yellow:C.red,fontWeight:700}}>{fmtPct(m.attach_fni)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{m.nb_avec_fni>0?fmt$(m.moy_profit_fni_si_present):'—'}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:m.marge_brute_pct>=0.10?C.green:m.marge_brute_pct>=0?C.yellow:C.red}}>{fmtPct(m.marge_brute_pct)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{Math.round(m.moy_jours)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:900,color:m.total_profit_net>=0?C.blue:C.red}}>{fmt$(m.total_profit_net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Top FNI par marque : meilleur vendeur FNI pour chaque marque */}
              {(dashboard.top_fni_par_marque||[]).length > 0 && (
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden',marginBottom:12}}>
                  <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,fontSize:12,fontWeight:800}}>
                    🥇 Top vendeurs FNI par marque
                    <span style={{fontSize:10,color:sub,fontWeight:400,marginLeft:8}}>(qui pousse le plus de FNI sur chaque marque + % profit moy véhicule associé)</span>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:1,background:bdr}}>
                    {dashboard.top_fni_par_marque.map((m:any) => (
                      <div key={m.marque} style={{background:card,padding:'10px 14px'}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:6,flexWrap:'wrap',gap:6}}>
                          <div style={{fontSize:13,fontWeight:800}}>{m.marque}</div>
                          <div style={{fontSize:10,color:sub}}>
                            {m.nb_total} ventes • Attach global : <strong style={{color:m.brand_attach>=0.5?C.green:m.brand_attach>=0.3?C.yellow:C.red}}>{fmtPct(m.brand_attach)}</strong>
                            {' • '}% profit moy véh : <strong style={{color:m.brand_moy_pct_brut_veh>=0.10?C.green:m.brand_moy_pct_brut_veh>=0?C.yellow:C.red}}>{fmtPct(m.brand_moy_pct_brut_veh)}</strong>
                          </div>
                        </div>
                        <table style={{width:'100%',fontSize:11,borderCollapse:'collapse'}}>
                          <thead><tr>
                            <th style={{padding:'3px 6px',textAlign:'left',fontSize:9,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>#</th>
                            <th style={{padding:'3px 6px',textAlign:'left',fontSize:9,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Vendeur</th>
                            <th style={{padding:'3px 6px',textAlign:'right',fontSize:9,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>Ventes</th>
                            <th style={{padding:'3px 6px',textAlign:'right',fontSize:9,fontWeight:700,color:C.green,borderBottom:`1px solid ${bdr}`}}>Profit FNI</th>
                            <th style={{padding:'3px 6px',textAlign:'right',fontSize:9,fontWeight:700,color:C.yellow,borderBottom:`1px solid ${bdr}`}}>Attach</th>
                            <th style={{padding:'3px 6px',textAlign:'right',fontSize:9,fontWeight:700,color:sub,borderBottom:`1px solid ${bdr}`}}>%Pr.véh</th>
                          </tr></thead>
                          <tbody>
                            {m.top_vendeurs.map((v:any, i:number) => (
                              <tr key={v.vendeur_nom}>
                                <td style={{padding:'4px 6px',color:i===0?C.yellow:sub,fontWeight:i===0?800:400,fontSize:12}}>{i===0?'🥇':i===1?'🥈':'🥉'}</td>
                                <td style={{padding:'4px 6px',fontWeight:i===0?800:600}}>{v.vendeur_nom}</td>
                                <td style={{padding:'4px 6px',textAlign:'right',color:sub}}>{v.nb_avec_fni}/{v.nb}</td>
                                <td style={{padding:'4px 6px',textAlign:'right',fontWeight:700,color:v.total_profit_fni>0?C.green:sub}}>{fmt$(v.total_profit_fni)}</td>
                                <td style={{padding:'4px 6px',textAlign:'right',color:v.attach_fni>=0.5?C.green:v.attach_fni>=0.3?C.yellow:C.red,fontWeight:700}}>{fmtPct(v.attach_fni)}</td>
                                <td style={{padding:'4px 6px',textAlign:'right',color:v.moy_pct_brut_veh>=0.10?C.green:v.moy_pct_brut_veh>=0?sub:C.red}}>{fmtPct(v.moy_pct_brut_veh)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Par VENDEUR */}
              <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden',marginBottom:12}}>
                <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,fontSize:12,fontWeight:800}}>
                  👤 Performance par VENDEUR ({parVendeur.length})
                </div>
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                    <thead><tr style={{background:thBg}}>
                      <th style={{padding:'8px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Vendeur</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Unités</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Ventes véh</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Profit véh moy.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.yellow}}>Attach FNI</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.green}}>FNI vendu</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Marge %</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Jours moy.</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue}}>Profit net</th>
                      <th style={{padding:'8px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue}}>Profit net moy.</th>
                    </tr></thead>
                    <tbody>
                      {parVendeur.map((v:any) => (
                        <tr key={v.vendeur_nom} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{v.vendeur_nom}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right'}}>{v.nb}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{fmt$(v.total_prix)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:v.moy_profit_veh>=0?C.green:C.red,fontWeight:700}}>{fmt$(v.moy_profit_veh)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:v.attach_fni>=0.5?C.green:v.attach_fni>=0.3?C.yellow:C.red,fontWeight:700}}>{fmtPct(v.attach_fni)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{fmt$(v.total_profit_fni)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:v.marge_brute_pct>=0.10?C.green:v.marge_brute_pct>=0?C.yellow:C.red}}>{fmtPct(v.marge_brute_pct)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{Math.round(v.moy_jours)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:900,color:v.total_profit_net>=0?C.blue:C.red}}>{fmt$(v.total_profit_net)}</td>
                          <td style={{padding:'7px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700,color:v.moy_profit_net>=0?C.blue:C.red}}>{fmt$(v.moy_profit_net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Signaux perf */}
              <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:10,marginBottom:12}}>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden'}}>
                  <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,fontSize:12,fontWeight:800,color:C.green}}>⬆️ Top 10 Profits Nets</div>
                  {(signaux.top_profits||[]).length === 0 ? <div style={{padding:20,color:sub,textAlign:'center',fontSize:12}}>—</div> : (
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                      <tbody>
                        {signaux.top_profits.map((t:any, i:number) => (
                          <tr key={i}>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700}}>{t.stock}</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,color:sub}}>{t.marque} {t.modele}</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800,color:C.green}}>{fmt$(t.profit_net)}</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub,fontSize:10}}>{Number(t.pct_profit).toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden'}}>
                  <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,fontSize:12,fontWeight:800,color:C.red}}>⬇️ Top 10 Flops (profit négatif)</div>
                  {(signaux.flops||[]).length === 0 ? <div style={{padding:20,color:sub,textAlign:'center',fontSize:12}}>Aucun flop 🎉</div> : (
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                      <tbody>
                        {signaux.flops.map((t:any, i:number) => (
                          <tr key={i}>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700}}>{t.stock}</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,color:sub}}>{t.marque} {t.modele}</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800,color:C.red}}>{fmt$(t.profit_net)}</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub,fontSize:10}}>{t.vendeur||'—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden'}}>
                  <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,fontSize:12,fontWeight:800,color:C.yellow}}>⏳ Rotation lente (&gt; 365 jours)</div>
                  {(signaux.rotation_lente||[]).length === 0 ? <div style={{padding:20,color:sub,textAlign:'center',fontSize:12}}>—</div> : (
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                      <tbody>
                        {signaux.rotation_lente.map((t:any, i:number) => (
                          <tr key={i}>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700}}>{t.stock}</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,color:sub}}>{t.marque} {t.modele}</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800,color:C.yellow}}>{t.jours} j</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:t.profit_net>=0?C.green:C.red,fontSize:10}}>{fmt$(t.profit_net)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden'}}>
                  <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,fontSize:12,fontWeight:800,color:C.red}}>🎯 FNI attach faible (&lt; 30%)</div>
                  {(signaux.fni_attach_faible||[]).length === 0 ? <div style={{padding:20,color:sub,textAlign:'center',fontSize:12}}>Tous vendeurs &gt; 30% ✓</div> : (
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                      <tbody>
                        {signaux.fni_attach_faible.map((t:any, i:number) => (
                          <tr key={i}>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{t.vendeur_nom}</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:C.red,fontWeight:700}}>{fmtPct(t.attach_fni)}</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub,fontSize:10}}>{t.nb} ventes</td>
                            <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:C.red,fontSize:10}} title="Estimation : manque à gagner si l'attach atteignait 50%">~{fmt$(t.manque_a_gagner_estime)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* Top modèles */}
              <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:10,overflow:'hidden'}}>
                <div style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,fontSize:12,fontWeight:800}}>🚀 Top modèles vendus</div>
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                    <thead><tr style={{background:thBg}}>
                      <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Marque</th>
                      <th style={{padding:'7px 10px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Modèle</th>
                      <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Unités</th>
                      <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Prix moy.</th>
                      <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Profit net moy.</th>
                      <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Jours moy.</th>
                      <th style={{padding:'7px 10px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue}}>Profit net total</th>
                    </tr></thead>
                    <tbody>
                      {parModele.slice(0, 30).map((m:any, i:number) => (
                        <tr key={i}>
                          <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{m.marque}</td>
                          <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,color:sub}}>{m.modele}</td>
                          <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:700}}>{m.nb}</td>
                          <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{fmt$(m.moy_prix)}</td>
                          <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:m.moy_profit_net>=0?C.green:C.red}}>{fmt$(m.moy_profit_net)}</td>
                          <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{Math.round(m.moy_jours)}</td>
                          <td style={{padding:'5px 10px',borderBottom:`1px solid ${bdr}`,textAlign:'right',fontWeight:800,color:m.total_profit_net>=0?C.blue:C.red}}>{fmt$(m.total_profit_net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── Vue VENTES (liste brute) ─── */}
      {vue === 'ventes' && (
        <div>
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,padding:'10px 14px',marginBottom:10,display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
            <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
              {TYPES.map(t => (
                <button key={t.id} onClick={()=>toggleType(t.id)}
                  style={{padding:'6px 11px',borderRadius:14,border:`1px solid ${filtTypes.includes(t.id)?t.color:bdr}`,background:filtTypes.includes(t.id)?t.color+'22':'transparent',color:filtTypes.includes(t.id)?t.color:sub,fontWeight:700,cursor:'pointer',fontSize:11}}>
                  {t.label}
                </button>
              ))}
            </div>
            <div style={{marginLeft:'auto',fontSize:11,color:sub}}>{ventes.length} ventes</div>
          </div>
          <div style={{background:card,borderRadius:10,border:`1px solid ${bdr}`,overflow:'hidden'}}>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                <thead><tr style={{background:thBg}}>
                  <th style={{padding:'7px 8px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Date</th>
                  <th style={{padding:'7px 8px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Type</th>
                  <th style={{padding:'7px 8px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Stock</th>
                  <th style={{padding:'7px 8px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Marque / Modèle</th>
                  <th style={{padding:'7px 8px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Client</th>
                  <th style={{padding:'7px 8px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Vendeur</th>
                  <th style={{padding:'7px 8px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Prix</th>
                  <th style={{padding:'7px 8px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Profit véh</th>
                  <th style={{padding:'7px 8px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.yellow}}>FNI</th>
                  <th style={{padding:'7px 8px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue}}>Profit net</th>
                  <th style={{padding:'7px 8px',textAlign:'right',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub}}>Jours</th>
                </tr></thead>
                <tbody>
                  {ventes.map(v => (
                    <tr key={v.id} onMouseEnter={(e:any)=>e.currentTarget.style.background=hvr} onMouseLeave={(e:any)=>e.currentTarget.style.background='transparent'}>
                      <td style={{padding:'5px 8px',borderBottom:`1px solid ${bdr}`,color:sub}}>{v.date_vente}</td>
                      <td style={{padding:'5px 8px',borderBottom:`1px solid ${bdr}`}}>
                        <span style={{background:(TYPES.find(t=>t.id===v.type)?.color||sub)+'22',color:TYPES.find(t=>t.id===v.type)?.color||sub,padding:'1px 6px',borderRadius:6,fontSize:9,fontWeight:700}}>{(TYPES.find(t=>t.id===v.type)?.label||v.type).replace(/^[^\s]+\s/, '')}</span>
                      </td>
                      <td style={{padding:'5px 8px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontWeight:700}}>{v.stock_num}</td>
                      <td style={{padding:'5px 8px',borderBottom:`1px solid ${bdr}`}}><strong>{v.marque}</strong> <span style={{color:sub}}>{v.modele} {v.annee}</span></td>
                      <td style={{padding:'5px 8px',borderBottom:`1px solid ${bdr}`,color:sub,maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={v.client}>{v.client||'—'}</td>
                      <td style={{padding:'5px 8px',borderBottom:`1px solid ${bdr}`,color:sub}}>{v.vendeur_nom||'—'}</td>
                      <td style={{padding:'5px 8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{fmt$(v.prix_vente)}</td>
                      <td style={{padding:'5px 8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:Number(v.profit_vehicule)>=0?C.green:C.red,fontWeight:700}}>{fmt$(v.profit_vehicule)}</td>
                      <td style={{padding:'5px 8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:Number(v.ventes_fni)>0?C.yellow:sub}}>{Number(v.ventes_fni)>0?fmt$(v.ventes_fni):'—'}</td>
                      <td style={{padding:'5px 8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:Number(v.profit_net_total)>=0?C.blue:C.red,fontWeight:800}}>{fmt$(v.profit_net_total)}</td>
                      <td style={{padding:'5px 8px',borderBottom:`1px solid ${bdr}`,textAlign:'right',color:sub}}>{v.nb_jours}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

