'use client'
import { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabaseCli = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const ROLES_ONGLETS: Record<string, string[]> = {
  admin:        ['calc','import','booking','retours','negatifs','commandes','fournitures','inventaire','utilisateurs'],
  gestionnaire: ['calc','import','booking','retours','negatifs','commandes','fournitures','inventaire'],
  commis:       ['commandes','fournitures','retours'],
  employe_piece: ['fournitures','negatifs','inventaire','retours'],
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
      const [d, l, n, a, f, nv] = await Promise.all([
        fetch('/api/calculateur').then(r=>r.json()),
        fetch('/api/lots').then(r=>r.json()),
        fetch('/api/negatifs').then(r=>r.json()),
        fetch('/api/alternatives').then(r=>r.json()),
        fetch('/api/fournitures').then(r=>r.json()),
        fetch('/api/negatifs-verifies').then(r=>r.json()),
      ])
      setData(d); setLots(Array.isArray(l)?l:[]); setNegs(Array.isArray(n)?n:[])
      if(f&&f.catalogue) setFournituresData(f)
      if(Array.isArray(nv)) setNegsVerifies(nv)
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
    let b=0, m=mNow
    for (let i=0;i<cov;i++) {
      const vMois = it.ventesMoyParMois?.[m] ?? 0
      // Si pas de données pour ce mois, utilise EMA comme fallback
      b += vMois > 0 ? vMois : it.moyMois
      m=(m+1)%12
    }
    return b
  }
  function getQte(it: Item) {
    if (cov===0) return 0
    const q = Math.ceil(getBesoin(it)+(it.stockSecurite||0)-Math.max(0,it.stock))
    return it.saison==='Sur Commande'?0:Math.max(0,q)
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
      <div style={{background:dark?'#141414':'#e2e6ef',borderBottom:`1px solid ${bdr}`,overflowX:'auto',display:'flex',WebkitOverflowScrolling:'touch',scrollbarWidth:'none'}}>
        {[{id:'calc',l:isMobile?'🧮 Calc':'Calculateur Achats'},{id:'import',l:isMobile?'📥 Import':'Importer Ventes'},{id:'retours',l:isMobile?'🔄 RMA':'Retours RMA'},{id:'booking',l:'Booking'},{id:'negatifs',l:isMobile?'🔴 Négatifs':'Pièces Négatives',d:true},{id:'commandes',l:'📋 Commandes'},{id:'fournitures',l:'💡 Suggestions'},{id:'inventaire',l:'📦 Inventaire'},{id:'utilisateurs',l:'👥 Utilisateurs'}].filter(t=>(ROLES_ONGLETS[profil?.role||'commis']||ROLES_ONGLETS['commis']).includes(t.id)).map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:isMobile?'10px 12px':'12px 16px',border:'none',background:'transparent',cursor:'pointer',fontSize:isMobile?12:13,fontWeight:600,color:tab===t.id?C.blue:t.d?C.red:sub,borderBottom:tab===t.id?`3px solid ${C.blue}`:'3px solid transparent',transition:'all .15s',whiteSpace:'nowrap',flexShrink:0}}>
            {t.l}
          </button>
        ))}
      </div>

      <div style={{maxWidth:1700,margin:'0 auto',padding:isMobile?'10px 10px':'18px 16px'}}>

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
          <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
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
        {tab==='negatifs' && <NegatifsTab negs={negs} dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} alts={alts} negsVerifies={negsVerifies} setNegsVerifies={setNegsVerifies} profil={profil} data={data}/>}
        {tab==='commandes' && <CommandesTab data={data} dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} altsMap={alts} fournituresData={fournituresData} setFournituresData={setFournituresData} profil={profil}/>}
        {tab==='inventaire' && <InventaireTab dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} profil={profil}/>}
        {tab==='utilisateurs' && <UtilisateursTab dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr}/>}
        {tab==='fournitures' && <FournituresTab fournituresData={fournituresData} setFournituresData={setFournituresData} dark={dark} card={card} bdr={bdr} sub={sub} thBg={thBg} S={S} C={C} hvr={hvr} data={data} profil={profil}/>}
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}*{box-sizing:border-box}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-thumb{background:${dark?'#444':'#ccc'};border-radius:3px}`}</style>
    </div>
  )
}

// ── Commandes du Jour ────────────────────────────────────────────────────────
function CommandesTab({data, dark, card, bdr, sub, thBg, S, C, hvr, altsMap, fournituresData, setFournituresData, profil}: any) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const [filtFourn, setFiltFourn] = useState('ALL')
  const employe = profil?.nom || profil?.email || 'Inconnu'
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
    if (filtreStatut === 'verifie') return s?.statut === 'verifie'
    return true
  })

  const fournisseurs = Array.from(new Set(toutesLignes.map(it => it.fournisseur))).sort() as string[]
  const totalCommande = suggestions.reduce((s: number, it: any) => s + it.totalLigne, 0)
  const nbAttente = toutesLignes.filter(it => getSuivi(it.pk)?.statut === 'commande_faite').length
  const nbVerifie = toutesLignes.filter(it => getSuivi(it.pk)?.statut === 'verifie').length

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
              <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Action</th>
            </tr></thead>
            <tbody>
              {(fournituresData?.demandes||[]).filter((d:any)=>d.statut==='en_attente').map((d:any) => (
                <tr key={d.id} onMouseEnter={e=>e.currentTarget.style.background=hvr} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontWeight:600}}>{d.employe}</td>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:12}}>{d.sku||'—'}</td>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={d.description}>{d.description}</td>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:12}}>{d.fournisseur||'—'}</td>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700}}>{d.quantite}</td>
                  <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                    <div style={{display:'flex',gap:6,justifyContent:'center'}}>
                      <button onClick={async()=>{await fetch('/api/fournitures',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:d.id,statut:'traitée'})});const r=await fetch('/api/fournitures');if(r.ok&&setFournituresData)setFournituresData(await r.json())}}
                        style={{background:C.green,color:'#fff',border:'none',borderRadius:6,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>✅ Commandé</button>
                      <button onClick={async()=>{await fetch('/api/fournitures',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:d.id,statut:'annulée'})});const r=await fetch('/api/fournitures');if(r.ok&&setFournituresData)setFournituresData(await r.json())}}
                        style={{background:C.red+'22',color:C.red,border:'none',borderRadius:6,padding:'5px 8px',fontSize:11,fontWeight:700,cursor:'pointer'}}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
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
  const [skuInfo, setSkuInfo] = useState<any>(null)
  const [skuErreur, setSkuErreur] = useState('')
  const [loading, setLoading] = useState(false)
  const [msgOk, setMsgOk] = useState('')
  const [rapportEmploye, setRapportEmploye] = useState('ALL')

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
    if (!sku.trim()) return
    setLoading(true)
    const item = chercherSku(sku.trim())
    await fetch('/api/fournitures', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        employe,
        sku: sku.trim(),
        description: skuInfo?.desc || sku.trim(),
        fournisseur: skuInfo?.fournisseur || '',
        categorie: 'Suggestion',
        quantite: qte,
        unite: 'unité',
        note: note
      })
    })
    setSku(''); setQte(1); setNote(''); setSkuInfo(null)
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

      {/* Formulaire */}
      <div style={{background:card,borderRadius:14,border:`1px solid ${bdr}`,padding:'24px 28px',marginBottom:20}}>
        <form onSubmit={soumettre}>
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

          {/* Quantité + Note */}
          <div style={{display:'grid',gridTemplateColumns:'160px 1fr',gap:12,marginBottom:16}}>
            <div>
              <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:6}}>
                Quantité demandée
                {besoin2mois > 0 && <span style={{color:C.blue,fontWeight:400,marginLeft:6,textTransform:'none'}}>({besoin2mois.toFixed(0)} suggérée)</span>}
              </label>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <button type="button" onClick={()=>setQte(q=>Math.max(1,q-1))} style={{width:34,height:34,borderRadius:8,border:`1px solid ${bdr}`,background:'none',cursor:'pointer',fontSize:18,fontWeight:700,color:sub}}>−</button>
                <input type="number" value={qte} onChange={e=>setQte(Math.max(1,Number(e.target.value)))} min={1} style={{...S,textAlign:'center',width:60,fontWeight:700,fontSize:16}}/>
                <button type="button" onClick={()=>setQte(q=>q+1)} style={{width:34,height:34,borderRadius:8,border:`1px solid ${bdr}`,background:C.blue,cursor:'pointer',fontSize:18,fontWeight:700,color:'#fff'}}>+</button>
              </div>
            </div>
            <div>
              <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:6}}>Note (optionnel)</label>
              <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Ex: Urgent, pour le client X..." style={S}/>
            </div>
          </div>

          <button type="submit" disabled={loading||!sku.trim()}
            style={{width:'100%',background:(!sku.trim())?sub:C.blue,color:'#fff',border:'none',borderRadius:10,padding:'13px 0',fontSize:15,fontWeight:700,cursor:sku.trim()?'pointer':'not-allowed',opacity:sku.trim()?1:0.6}}>
            {loading ? 'Envoi...' : '💡 Envoyer la suggestion → Commandes du Jour'}
          </button>
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
                  <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Statut</th>
                  <th style={{padding:'9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Date</th>
                  <th style={{padding:'9px',borderBottom:`2px solid ${bdr}`}}></th>
                </tr></thead>
                <tbody>
                  {demandesFiltrees.map((d:any) => (
                    <tr key={d.id} onMouseEnter={e=>e.currentTarget.style.background=hvr} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontWeight:600}}>{d.employe}</td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,fontFamily:'monospace',fontSize:12}}>{d.sku||'—'}</td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={d.description}>{d.description}</td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:12}}>{d.fournisseur||'—'}</td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700}}>{d.quantite}</td>
                      <td style={{padding:'9px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                        <span style={{background:d.statut==='en_attente'?C.yellow+'22':d.statut==='annulée'?C.red+'22':C.green+'22',color:d.statut==='en_attente'?C.yellow:d.statut==='annulée'?C.red:C.green,padding:'3px 8px',borderRadius:20,fontSize:11,fontWeight:700}}>
                          {d.statut==='en_attente'?'⏳ En attente':d.statut==='annulée'?'✕ Annulée':'✅ Traitée'}
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
function InventaireTab({dark, card, bdr, sub, thBg, S, C, hvr, profil}: any) {
  const employe = profil?.nom || profil?.email || 'Inconnu'
  const [sousOnglet, setSousOnglet] = useState<'compter'|'rapport'>('compter')
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
  const [photoFile, setPhotoFile] = useState<File|null>(null)
  const [photoPreview, setPhotoPreview] = useState<string|null>(null)
  const [pendingComptage, setPendingComptage] = useState<any>(null)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)

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
  const pieceScanRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (sousOnglet === 'rapport') chargerComptages()
  }, [sousOnglet])

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
  function onLocScan(e: any) {
    const f = e.target.files?.[0]
    if (!f) return
    // Sur mobile, le scan renvoie l'image — on utilise BarcodeDetector si disponible
    const reader = new FileReader()
    reader.onload = async () => {
      if ('BarcodeDetector' in window) {
        try {
          const img = new Image()
          img.src = reader.result as string
          await new Promise(r => img.onload = r)
          const detector = new (window as any).BarcodeDetector()
          const barcodes = await detector.detect(img)
          if (barcodes.length > 0) {
            const val = barcodes[0].rawValue.trim().toUpperCase()
            setLocInput(val)
            setTimeout(() => scanLocalisationVal(val, true), 100)
            return
          }
        } catch {}
      }
      // Fallback — ne pas ouvrir le clavier automatiquement sur mobile
    }
    reader.readAsDataURL(f)
    e.target.value = ''
  }

  function onPieceScan(e: any) {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = async () => {
      if ('BarcodeDetector' in window) {
        try {
          const img = new Image()
          img.src = reader.result as string
          await new Promise(r => img.onload = r)
          const detector = new (window as any).BarcodeDetector()
          const barcodes = await detector.detect(img)
          if (barcodes.length > 0) {
            const val = barcodes[0].rawValue.trim().toUpperCase()
            setPieceInput(val)
            setTimeout(() => scanPieceVal(val, true), 100)
            return
          }
        } catch {}
      }
      // Fallback — ne pas ouvrir le clavier automatiquement sur mobile
    }
    reader.readAsDataURL(f)
    e.target.value = ''
  }

  async function scanLocalisationVal(loc: string, fromCamera = false) {
    if (!loc) return
    setLoading(true); setErreur(''); setShowCreerLoc(false)
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
    const rStock = await fetch('/api/inventaire/stock?codes=' + encodeURIComponent(codes))
    const map = new Map<string,{stock:number,reserve:number}>()
    if (rStock.ok) {
      const stocks = await rStock.json()
      for (const s of stocks) map.set(s.code_piece, { stock: s.stock, reserve: s.reserve })
    }
    setStockMap(map); setPiecesLoc(data); setLocActive(loc)
    setLocInput(''); setEtape('piece'); setComptesDuJour([]); sonOk(); setLoading(false)
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

  async function scanPieceVal(code: string, fromCamera = false) {
    if (!code) return
    setLoading(true); setErreur('')
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
      setErreur(autresLocs.length > 0
        ? `🚫 Piece "${code}" pas dans ${locActive}. Bonne place: ${autresLocs.join(', ')}`
        : `⚠️ Piece "${code}" sans localisation assignee.`)
      sonErr(); setPieceInput(''); setLoading(false)
      if (!fromCamera) setTimeout(() => pieceRef.current?.focus(), 100); return
    }
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
    await fetch('/api/inventaire/comptages', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        code_piece: piece.code_piece, localisation: locActive,
        qte_comptee: qte, qte_systeme: qteSysteme, qte_reservee: stockInfo.reserve||0,
        employe, photo_url: photoUrl
      })
    })
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

  const employes = Array.from(new Set(comptages.map((c:any)=>c.employe))).sort() as string[]
  const cFiltres = comptages.filter((c:any)=>{
    if (filtDate && !c.date_comptage.startsWith(filtDate)) return false
    if (filtEmploye!=='ALL' && c.employe!==filtEmploye) return false
    if (filtEcart==='ecart' && c.ecart===0) return false
    if (filtEcart==='ok' && c.ecart!==0) return false
    return true
  })

  const btnPrimary: any = {border:'none',borderRadius:12,fontWeight:800,cursor:'pointer',color:'#fff',width:'100%',padding:isMobile?'16px 0':'10px 0',fontSize:isMobile?17:14}

  return <>
    {/* Sous-onglets */}
    <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center',justifyContent:'space-between'}}>
      <div style={{display:'flex',gap:8}}>
        <button onClick={()=>setSousOnglet('compter')} style={{padding:isMobile?'10px 18px':'8px 16px',borderRadius:20,border:`2px solid ${sousOnglet==='compter'?C.blue:bdr}`,background:sousOnglet==='compter'?(dark?'#1a233a':'#e8f0fe'):'transparent',color:sousOnglet==='compter'?C.blue:sub,fontSize:isMobile?14:13,fontWeight:700,cursor:'pointer'}}>📦 Compter</button>
        <button onClick={()=>setSousOnglet('rapport')} style={{padding:isMobile?'10px 18px':'8px 16px',borderRadius:20,border:`2px solid ${sousOnglet==='rapport'?C.blue:bdr}`,background:sousOnglet==='rapport'?(dark?'#1a233a':'#e8f0fe'):'transparent',color:sousOnglet==='rapport'?C.blue:sub,fontSize:isMobile?14:13,fontWeight:700,cursor:'pointer'}}>📊 Rapport</button>
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

    {sousOnglet==='compter' ? <>

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
                    <button type="button" onClick={()=>locScanRef.current?.click()}
                      style={{...btnPrimary,background:dark?'#1a233a':'#e8f0fe',color:C.blue,border:`2px solid ${C.blue}`,fontSize:15}}>
                      📷 Scanner
                    </button>
                  )}
                  <button type="submit" disabled={loading} style={{...btnPrimary,background:C.blue}}>
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
                    <button type="button" onClick={()=>pieceScanRef.current?.click()}
                      style={{...btnPrimary,background:dark?'#2b2411':'#fff8e1',color:C.yellow,border:`2px solid ${C.yellow}`,fontSize:15}}>
                      📷 Scanner
                    </button>
                  )}
                  <button type="submit" disabled={loading} style={{...btnPrimary,background:C.yellow}}>
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
                  style={{background:'none',border:`1px solid ${bdr}`,borderRadius:8,padding:'6px 12px',color:sub,cursor:'pointer',fontSize:12,marginLeft:10}}>
                  ↩ Mauvaise
                </button>
              </div>
              <form onSubmit={soumettreQte} style={{display:'flex',flexDirection:'column',gap:10}}>
                <input ref={qteRef} type="number" inputMode="numeric" step="any" value={qteInput}
                  onChange={e=>{setQteInput(e.target.value);setErreur('')}}
                  placeholder="Quantité sur tablette"
                  style={{...S,fontSize:isMobile?36:22,fontWeight:900,textAlign:'center',padding:isMobile?'20px 14px':'12px 14px',borderRadius:12}} autoFocus/>
                <button type="submit" disabled={loading||!qteInput} style={{...btnPrimary,background:qteInput?C.green:'#94a3b8'}}>
                  {loading?'Sauvegarde...':'✅ Confirmer'}
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

          {/* Erreur */}
          {erreur && (
            <div style={{background:C.red+'22',border:`2px solid ${C.red}`,borderRadius:12,padding:'14px 16px',marginBottom:12,color:C.red,fontWeight:700,fontSize:isMobile?15:13}}>
              {erreur}
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
                        </div>
                      </div>
                    </div>
                  ))
              }
            </div>
          </div>
        )}
      </div>

    </> : <>
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
                          {c.photo_url&&<div style={{marginTop:4}}><a href={c.photo_url} target="_blank" rel="noreferrer" style={{fontSize:20}}>📸</a></div>}
                        </div>
                      </div>
                      <div style={{background:dark?'#1a1a1a':'#f8f9fa',borderRadius:8,padding:'8px 10px',marginBottom:6}}>
                        <div style={{display:'flex',gap:12,fontSize:12,flexWrap:'wrap'}}>
                          <span style={{color:sub}}>Stock comptage: <strong style={{color:C.blue}}>{c.qte_systeme}</strong></span>
                          {estReconcilie&&<span style={{color:sub}}>Stock J+1: <strong style={{color:C.blue}}>{c.stock_apres_sync}</strong></span>}
                          <span style={{color:sub}}>Compté: <strong style={{color:C.green}}>{c.qte_comptee}</strong></span>
                        </div>
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
    </>}
  </>
}


// ── Utilisateurs Tab ─────────────────────────────────────────────────────────
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

  const ROLES = [
    {val:'admin', label:'Admin', desc:'Accès complet + gestion utilisateurs', color:C.red},
    {val:'gestionnaire', label:'Gestionnaire', desc:'Tous les onglets sauf utilisateurs', color:C.blue},
    {val:'commis', label:'Commis', desc:'Commandes du Jour + Suggestions', color:C.green},
    {val:'employe_piece', label:'Employé pièce', desc:'Suggestions + Pièces Négatives', color:C.yellow},
  ]

  useEffect(() => { chargerUsers() }, [])

  async function chargerUsers() {
    setLoading(true)
    const r = await fetch('/api/auth/users')
    if (r.ok) setUsers(await r.json())
    setLoading(false)
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

  async function changerRole(id: string, role: string) {
    await fetch('/api/auth/users', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, role }) })
    await chargerUsers()
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

  return <>
    {/* Modal invitation */}
    {showInvite && (
      <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.6)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <div style={{background:card,borderRadius:16,padding:32,width:480,border:`1px solid ${bdr}`,boxShadow:'0 20px 60px rgba(0,0,0,.3)'}}>
          <h3 style={{margin:'0 0 6px',fontSize:18}}>📧 Inviter un utilisateur</h3>
          <p style={{color:sub,fontSize:13,margin:'0 0 20px'}}>Un email d'invitation sera envoyé automatiquement.</p>
          {erreur && <div style={{background:C.red+'22',border:`1px solid ${C.red}`,borderRadius:8,padding:'8px 12px',marginBottom:12,color:C.red,fontSize:13}}>{erreur}</div>}
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
              <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:8}}>Rôle *</label>
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                {ROLES.map(r => (
                  <label key={r.val} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',borderRadius:10,border:`2px solid ${invRole===r.val?r.color:bdr}`,cursor:'pointer',background:invRole===r.val?r.color+'11':'transparent'}}>
                    <input type="radio" name="role" value={r.val} checked={invRole===r.val} onChange={()=>setInvRole(r.val)} style={{accentColor:r.color}}/>
                    <div>
                      <div style={{fontWeight:700,fontSize:13,color:invRole===r.val?r.color:'inherit'}}>{r.label}</div>
                      <div style={{fontSize:11,color:sub}}>{r.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            <div style={{display:'flex',gap:10}}>
              <button type="button" onClick={()=>{setShowInvite(false);setErreur('')}} style={{flex:1,background:'none',border:`1px solid ${bdr}`,borderRadius:8,padding:'10px 0',cursor:'pointer',color:sub,fontWeight:600}}>Annuler</button>
              <button type="submit" disabled={invLoading} style={{flex:2,background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'10px 0',fontWeight:700,cursor:'pointer',fontSize:14}}>
                {invLoading ? 'Envoi...' : '📧 Envoyer invitation'}
              </button>
            </div>
          </form>
        </div>
      </div>
    )}

    {/* Header */}
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20,flexWrap:'wrap',gap:10}}>
      <div>
        <h2 style={{margin:0,fontSize:20,fontWeight:800}}>👥 Gestion des utilisateurs</h2>
        <p style={{color:sub,fontSize:13,margin:'4px 0 0'}}>{users.length} utilisateur{users.length>1?'s':''}</p>
      </div>
      <button onClick={()=>setShowInvite(true)} style={{background:C.blue,color:'#fff',border:'none',borderRadius:10,padding:'10px 20px',fontSize:14,fontWeight:700,cursor:'pointer'}}>
        + Inviter un utilisateur
      </button>
    </div>

    {msgOk && <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`1px solid ${C.green}`,borderRadius:10,padding:'12px 16px',marginBottom:16,color:C.green,fontWeight:700}}>{msgOk}</div>}

    {/* Tableau utilisateurs */}
    <div style={{background:card,borderRadius:14,border:`1px solid ${bdr}`,overflow:'hidden'}}>
      {loading
        ? <div style={{textAlign:'center',padding:60,color:sub}}>Chargement...</div>
        : users.length === 0
          ? <div style={{textAlign:'center',padding:60,color:sub}}>
              <div style={{fontSize:40,marginBottom:10}}>👥</div>
              <p>Aucun utilisateur — invite le premier !</p>
            </div>
          : isMobile
            ? <div style={{display:'flex',flexDirection:'column',gap:10,padding:'10px'}}>
                {users.map((u:any) => {
                  const roleInfo = ROLES.find(r=>r.val===u.role) || ROLES[2]
                  return (
                    <div key={u.id} style={{background:dark?'#1a1a1a':'#f8f9fa',borderRadius:12,padding:'14px 16px',border:`1px solid ${bdr}`}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
                        <div>
                          <div style={{fontWeight:700,fontSize:15}}>{u.nom}</div>
                          <div style={{fontSize:12,color:sub,marginTop:2}}>{u.email}</div>
                        </div>
                        <span style={{background:u.actif?C.green+'22':C.red+'22',color:u.actif?C.green:C.red,padding:'4px 10px',borderRadius:20,fontSize:12,fontWeight:700}}>
                          {u.actif?'✅':'🚫'}
                        </span>
                      </div>
                      <div style={{marginBottom:10}}>
                        <select value={u.role} onChange={e=>changerRole(u.id,e.target.value)}
                          style={{...S,border:`2px solid ${roleInfo.color}`,color:roleInfo.color,fontWeight:700,background:'transparent',borderRadius:8}}>
                          {ROLES.map(r=><option key={r.val} value={r.val}>{r.label}</option>)}
                        </select>
                      </div>
                      <div style={{display:'flex',gap:8}}>
                        <button onClick={()=>toggleActif(u.id,!u.actif)}
                          style={{flex:1,background:u.actif?C.yellow+'22':C.green+'22',color:u.actif?C.yellow:C.green,border:'none',borderRadius:8,padding:'10px 0',fontSize:13,fontWeight:700,cursor:'pointer'}}>
                          {u.actif?'Désactiver':'Activer'}
                        </button>
                        <button onClick={()=>supprimer(u.id,u.nom)}
                          style={{flex:1,background:C.red+'22',color:C.red,border:'none',borderRadius:8,padding:'10px 0',fontSize:13,fontWeight:700,cursor:'pointer'}}>
                          Supprimer
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            : <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
              <thead><tr style={{background:thBg}}>
                <th style={{padding:'12px 16px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Nom</th>
                <th style={{padding:'12px 16px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Email</th>
                <th style={{padding:'12px 16px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Rôle</th>
                <th style={{padding:'12px 16px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Statut</th>
                <th style={{padding:'12px 16px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Actions</th>
              </tr></thead>
              <tbody>
                {users.map((u:any) => {
                  const roleInfo = ROLES.find(r=>r.val===u.role) || ROLES[2]
                  return (
                    <tr key={u.id} onMouseEnter={e=>e.currentTarget.style.background=hvr} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      <td style={{padding:'12px 16px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{u.nom}</td>
                      <td style={{padding:'12px 16px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:12}}>{u.email}</td>
                      <td style={{padding:'12px 16px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                        <select value={u.role} onChange={e=>changerRole(u.id,e.target.value)}
                          style={{...S,fontSize:12,padding:'4px 8px',border:`1px solid ${roleInfo.color}`,color:roleInfo.color,fontWeight:700,background:'transparent',borderRadius:8,cursor:'pointer'}}>
                          {ROLES.map(r=><option key={r.val} value={r.val}>{r.label}</option>)}
                        </select>
                      </td>
                      <td style={{padding:'12px 16px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                        <span style={{background:u.actif?C.green+'22':C.red+'22',color:u.actif?C.green:C.red,padding:'3px 10px',borderRadius:20,fontSize:11,fontWeight:700}}>
                          {u.actif?'✅ Actif':'🚫 Inactif'}
                        </span>
                      </td>
                      <td style={{padding:'12px 16px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                        <div style={{display:'flex',gap:6,justifyContent:'center'}}>
                          <button onClick={()=>toggleActif(u.id,!u.actif)}
                            style={{background:u.actif?C.yellow+'22':C.green+'22',color:u.actif?C.yellow:C.green,border:'none',borderRadius:6,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>
                            {u.actif?'Désactiver':'Activer'}
                          </button>
                          <button onClick={()=>supprimer(u.id,u.nom)}
                            style={{background:C.red+'22',color:C.red,border:'none',borderRadius:6,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>
                            Supprimer
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
      }
    </div>

    {/* Légende des rôles */}
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))',gap:10,marginTop:16}}>
      {ROLES.map(r=>(
        <div key={r.val} style={{background:card,borderRadius:10,padding:'12px 16px',border:`1px solid ${r.color}22`}}>
          <div style={{fontWeight:700,fontSize:13,color:r.color,marginBottom:4}}>{r.label}</div>
          <div style={{fontSize:12,color:sub}}>{r.desc}</div>
        </div>
      ))}
    </div>
  </>
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

function NegatifsTab({negs, dark, card, bdr, sub, thBg, S, C, hvr, alts, negsVerifies, setNegsVerifies, profil, data}: any) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const employe = profil?.nom || profil?.email || 'Inconnu'
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
    'Stock vendu non reçu en inventaire',
    "Erreur de comptage lors d'un inventaire antérieur",
    'Ajustement incorrect (Déc. physique ou Autre)',
    'Pièce alternative utilisée sous ce SKU',
    'Retour fournisseur non traité',
    'Double facturation',
    'Autre raison',
  ]

  const CAUSES_SANS_PHOTO = ['Pièce non réceptionnée mais facturée (logiciel/service)']

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
    const exemptTout = f.causeIdx === 0 // Pièce non réceptionnée = juste cause + commentaire requis
    if (exemptTout) return f.cause !== '' && f.commentaire_compta !== ''
    return champsDef.every(c => f[c.key] !== '') && f.qte_reelle !== '' && f.cause !== '' && f.commentaire_compta !== ''
  }
    // Index 0 = Pièce non réceptionnée mais facturée — pas de photo
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
      } catch {}
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

    const photoObl2 = photoObligatoire(ajust, form.cause, form.causeIdx)
    if (photoObl2 && photoFiles.length === 0) {
      alert('📸 Photo obligatoire car écart > 1 unité !')
      photoRef.current?.click()
      return
    }

    setLoading(true)

    // Upload photos
    const photoUrls = await uploadPhotos(n.code_piece, 'NEG')

    // Calculer ajustement alternatif
    let altAjust = null
    if (hasAlt) {
      const altItem = (data?.liste_complete||[]).find((x:any) => x.pk === altCodes[0])
      const altStockSys = altItem ? altItem.stock : 0
      altAjust = getAjust(altStockSys, altForm)
    }

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
        photo_url:     photoUrls[0] || null,
        photo_url2:    photoUrls[1] || null,
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

    const r = await fetch('/api/negatifs-verifies')
    if (r.ok) setNegsVerifies(await r.json())
    setNoteModal(null)
    setForm(emptyForm()); setAltForm(emptyForm())
    setPhotoFiles([]); setPhotoPreviews([])
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
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6}}>
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
                      padding:'14px 0',borderRadius:10,fontWeight:700,fontSize:18,cursor:'pointer',
                      border:`1px solid ${bdr}`,
                      background: k==='⌫'?(dark?'#2b1113':'#fce8e6'):k==='±'?(dark?'#1a233a':'#e8f0fe'):(dark?'#222':'#fff'),
                      color: k==='⌫'?C.red:k==='±'?C.blue:'inherit'
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
      const allFormsComplet = formComplet(form) && (!hasAlt || formComplet(altForm))

      return (
        <div style={{position:'fixed',inset:0,background:dark?'#0d0d0d':'#f0f2f5',zIndex:9999,overflowY:'auto',fontFamily:"'DM Sans',sans-serif"}}>
          {/* Header fixe */}
          <div style={{position:'sticky',top:0,background:dark?'#111':C.red,color:'#fff',padding:'14px 16px',zIndex:10,display:'flex',justifyContent:'space-between',alignItems:'center',boxShadow:'0 2px 8px rgba(0,0,0,.2)',gap:8}}>
            <div>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',opacity:.8}}>Vérification inventaire</div>
              <div style={{fontSize:18,fontWeight:900,letterSpacing:1}}>{n.code_piece}</div>
            </div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>{setForm(emptyForm());setAltForm(emptyForm());setPhotoFiles([]);setPhotoPreviews([])}}
                style={{background:'rgba(255,255,255,.15)',border:'1px solid rgba(255,255,255,.4)',borderRadius:10,padding:'8px 12px',color:'#fff',cursor:'pointer',fontSize:13,fontWeight:700}}>
                🔄 Réinitialiser
              </button>
              <button onClick={()=>{setNoteModal(null);setForm(emptyForm());setAltForm(emptyForm());setPhotoFiles([]);setPhotoPreviews([])}}
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
                  {photoObligatoire(ajust, form.cause, form.causeIdx) && photoFiles.length === 0 && (
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
                    <label key={cause} style={{display:'flex',alignItems:'center',gap:10,background:form.cause===cause?(dark?'#1a233a':'#e8f0fe'):dark?'#1a1a1a':'#f8f9fa',borderRadius:10,padding:'12px 14px',border:`2px solid ${form.cause===cause?C.blue:bdr}`,cursor:'pointer'}}>
                      <input type="radio" name="cause" value={cause} checked={form.cause===cause} onChange={()=>setForm((p:any)=>({...p,cause:cause,causeIdx:causeIdx}))} style={{accentColor:C.blue,width:18,height:18}}/>
                      <span style={{fontSize:13,fontWeight:form.cause===cause?700:400,color:form.cause===cause?C.blue:'inherit'}}>{cause}</span>
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
            <div style={{background:card,borderRadius:14,padding:'16px',marginBottom:16,border:`2px solid ${photoObligatoire(ajust, form.cause, form.causeIdx)&&photoFiles.length===0?C.red:photoFiles.length>0?C.green:bdr}`}}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:10}}>
                📸 Photos {photoObligatoire(ajust, form.cause, form.causeIdx)?'(obligatoire — écart > 1)':'(optionnel)'}
              </div>
              {photoPreviews.length > 0 && (
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
                  {photoPreviews.map((p,i) => (
                    <div key={i} style={{position:'relative'}}>
                      <img src={p} style={{width:'100%',borderRadius:10,height:120,objectFit:'cover'}} alt={`Photo ${i+1}`}/>
                      <button onClick={()=>{setPhotoFiles(prev=>prev.filter((_,j)=>j!==i));setPhotoPreviews(prev=>prev.filter((_,j)=>j!==i))}}
                        style={{position:'absolute',top:4,right:4,background:C.red,border:'none',borderRadius:'50%',width:24,height:24,color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700}}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" onClick={()=>photoRef.current?.click()}
                style={{...btnStyle,background:C.blue,fontSize:15,padding:'14px 0'}}>
                📷 {photoPreviews.length > 0 ? 'Ajouter une autre photo' : 'Prendre une photo'}
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
            <button onClick={soumettre} disabled={loading||!allFormsComplet||(photoObligatoire(getAjust(Number(noteModal?.stock_negatif),form),form.cause)&&photoFiles.length===0)}
              style={{...btnStyle,background:allFormsComplet&&(!photoObligatoire(ajust, form.cause, form.causeIdx)||photoFiles.length>0)?C.green:'#94a3b8',marginBottom:32,fontSize:18,padding:'18px 0'}}>
              {loading?'Enregistrement...':'✅ Confirmer la vérification'}
            </button>
          </div>
        </div>
      )
    })()}

    {/* Sous-onglets */}
    <div style={{display:'flex',gap:8,marginBottom:14}}>
      <button onClick={()=>setSousOnglet('actif')} style={{padding:isMobile?'10px 16px':'7px 16px',borderRadius:20,border:`2px solid ${sousOnglet==='actif'?C.red:bdr}`,background:sousOnglet==='actif'?C.red+'22':'transparent',color:sousOnglet==='actif'?C.red:sub,fontSize:isMobile?14:12,fontWeight:700,cursor:'pointer'}}>
        🔴 À vérifier ({negsActifs.length})
      </button>
      <button onClick={()=>setSousOnglet('verifie')} style={{padding:isMobile?'10px 16px':'7px 16px',borderRadius:20,border:`2px solid ${sousOnglet==='verifie'?C.green:bdr}`,background:sousOnglet==='verifie'?C.green+'22':'transparent',color:sousOnglet==='verifie'?C.green:sub,fontSize:isMobile?14:12,fontWeight:700,cursor:'pointer'}}>
        ✅ Vérifié ({negsVerifies.length})
      </button>
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
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Stock</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'right'}}>Coût Un.</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`2px solid ${bdr}`,textAlign:'right'}}>Valeur</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Détecté le</th>
                  <th style={{padding:'10px 9px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Action</th>
                </tr></thead>
                <tbody>
                  {filtered.length===0
                    ? <tr><td colSpan={9} style={{textAlign:'center',padding:60,color:sub}}>✅ Aucune pièce négative</td></tr>
                    : filtered.map((n:any)=>{
                        const val=Math.abs(n.stock_negatif*n.cout_unitaire)
                        const bgR=val>500?(dark?'#2b1113':'#fff8f8'):val>100?(dark?'#2b2411':'#fffcf5'):'transparent'
                        const dateStr=n.date_apparition?new Date(n.date_apparition).toLocaleDateString('fr-CA',{month:'short',day:'numeric'}):'—'
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
              {negsVerifies.length===0
                ? <div style={{textAlign:'center',padding:40,color:sub}}>Aucune pièce vérifiée</div>
                : negsVerifies.map((v:any)=>(
                    <div key={v.id} style={{background:card,borderRadius:14,border:`2px solid ${Number(v.ajustement)!==0?C.red:C.green}`,padding:'16px',marginBottom:4}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12}}>
                        <div>
                          <div style={{fontWeight:900,fontSize:17,fontFamily:'monospace'}}>{v.code_piece}</div>
                          <div style={{fontSize:12,color:sub,marginTop:2}}>👤 {v.employe}</div>
                          <div style={{fontSize:11,color:sub}}>{new Date(v.date_verification).toLocaleDateString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
                        </div>
                        <div style={{textAlign:'right'}}>
                          <div style={{fontSize:11,color:sub,marginBottom:2}}>Ajustement</div>
                          <div style={{fontSize:28,fontWeight:900,color:Number(v.ajustement)===0?C.green:C.red}}>
                            {Number(v.ajustement)>=0?'+':''}{Number(v.ajustement).toFixed(0)}
                          </div>
                          <div style={{display:'flex',gap:6,justifyContent:'flex-end',marginTop:4}}>
                            {v.photo_url&&<a href={v.photo_url} target="_blank" rel="noreferrer" style={{fontSize:22}}>📸</a>}
                            {v.photo_url2&&<a href={v.photo_url2} target="_blank" rel="noreferrer" style={{fontSize:22}}>📸</a>}
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
                      {v.cause&&<div style={{background:dark?'#1a233a':'#e8f0fe',borderRadius:8,padding:'10px 12px',fontSize:13,color:C.blue,marginBottom:8,fontWeight:600}}>📋 {v.cause}</div>}
                      {v.commentaire&&<div style={{background:dark?'#1a1a1a':'#f8f9fa',borderRadius:8,padding:'10px 12px',fontSize:12,color:sub,marginBottom:8}}>💬 {v.commentaire}</div>}
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
                  {negsVerifies.length===0
                    ? <tr><td colSpan={19} style={{textAlign:'center',padding:60,color:sub}}>Aucune pièce vérifiée</td></tr>
                    : negsVerifies.map((v:any)=>(
                        <tr key={v.id} onMouseEnter={e=>e.currentTarget.style.background=hvr} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontWeight:700,fontFamily:'monospace',fontSize:11}}>{v.code_piece}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.red,fontWeight:700}}>{v.stock_au_moment}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:900,color:Number(v.ajustement)>=0?C.green:C.red}}>
                            {Number(v.ajustement)>=0?'+':''}{Number(v.ajustement).toFixed(0)}
                          </td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:C.blue,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={v.cause}>{v.cause||'—'}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11,color:sub,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={v.commentaire}>{v.commentaire||'—'}</td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontSize:11}}>
                            {v.alt_code_piece&&<div style={{color:C.green,fontWeight:700}}>{v.alt_code_piece}<br/><span style={{color:Number(v.alt_ajustement)>=0?C.green:C.red}}>{Number(v.alt_ajustement)>=0?'+':''}{Number(v.alt_ajustement)?.toFixed(0)}</span></div>}
                          </td>
                          <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                            <div style={{display:'flex',gap:4,justifyContent:'center'}}>
                              {v.photo_url&&<a href={v.photo_url} target="_blank" rel="noreferrer" style={{fontSize:16}}>📸</a>}
                              {v.photo_url2&&<a href={v.photo_url2} target="_blank" rel="noreferrer" style={{fontSize:16}}>📸</a>}
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


