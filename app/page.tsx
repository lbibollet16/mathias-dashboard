'use client'
import { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabaseCli = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const ROLES_ONGLETS: Record<string, string[]> = {
  admin:      ['calc','import','booking','retours','negatifs','commandes','fournitures','inventaire','utilisateurs'],
  gestionnaire: ['calc','import','booking','retours','negatifs','commandes','fournitures','inventaire'],
  commis:     ['commandes','fournitures'],
  employe_piece: ['fournitures','negatifs'],
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
      <nav style={{background:dark?'#111':C.blue,color:'#fff',padding:'0 20px',height:54,display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,zIndex:200,boxShadow:'0 2px 8px rgba(0,0,0,.2)'}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:20}}>🤖</span>
          <span style={{fontWeight:700,fontSize:15}}>Mathias Marine Sports</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          {data?.calcule_le && <span style={{fontSize:11,opacity:.6,background:'rgba(255,255,255,.12)',padding:'3px 10px',borderRadius:20}}>Cache: {new Date(data.calcule_le).toLocaleDateString('fr-CA')}</span>}
          <button onClick={()=>setDark(!dark)} style={{background:'rgba(255,255,255,.15)',border:'none',borderRadius:8,width:34,height:34,cursor:'pointer',fontSize:16,color:'#fff'}}>{dark?'☀️':'🌙'}</button>
        </div>
      </nav>

      {/* TABS */}
      <div style={{background:dark?'#141414':'#e2e6ef',borderBottom:`1px solid ${bdr}`,padding:'0 20px',display:'flex'}}>
        {[{id:'calc',l:'Calculateur Achats'},{id:'import',l:'Importer Ventes'},{id:'retours',l:'Retours RMA'},{id:'booking',l:'Booking'},{id:'negatifs',l:'Pièces Négatives',d:true},{id:'commandes',l:'📋 Commandes du Jour'},{id:'fournitures',l:'💡 Suggestions'},{id:'inventaire',l:'📦 Inventaire Cyclique'},{id:'utilisateurs',l:'👥 Utilisateurs'}].filter(t=>(ROLES_ONGLETS[profil?.role||'commis']||ROLES_ONGLETS['commis']).includes(t.id)).map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:'12px 16px',border:'none',background:'transparent',cursor:'pointer',fontSize:13,fontWeight:600,color:tab===t.id?C.blue:t.d?C.red:sub,borderBottom:tab===t.id?`3px solid ${C.blue}`:'3px solid transparent',transition:'all .15s'}}>
            {t.l}
          </button>
        ))}
      </div>

      <div style={{maxWidth:1700,margin:'0 auto',padding:'18px 16px'}}>

        {/* ── CALCULATEUR ─────────────────────────────────────────── */}
        {tab==='calc' && <>
          <div style={{background:card,borderRadius:12,padding:'14px 18px',marginBottom:14,display:'flex',gap:12,flexWrap:'wrap',alignItems:'flex-start',border:`1px solid ${bdr}`}}>

            {/* ABC */}
            <div style={{flex:1,minWidth:130}}>
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
            <div style={{display:'flex',gap:10,alignItems:'center'}}>
              <button onClick={lancerSync} disabled={syncing} style={{background:syncing?sub:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'9px 18px',fontSize:13,fontWeight:700,cursor:syncing?'default':'pointer'}}>
                {syncing?'⏳ Sync en cours...':'🔄 Synchroniser ERP maintenant'}
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
    <div style={{background:card,borderRadius:12,padding:'14px 18px',marginBottom:14,display:'flex',gap:12,flexWrap:'wrap',alignItems:'flex-end',border:`1px solid ${bdr}`}}>
      <div style={{flex:2,minWidth:200}}>
        <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Fournisseur</div>
        <select value={filtFourn} onChange={e=>setFiltFourn(e.target.value)} style={S}>
          <option value="ALL">Tous ({fournisseurs.length})</option>
          {fournisseurs.map((f:string) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>
      <div style={{flex:1,fontSize:13,color:sub,padding:'8px 0'}}>
        <div>📅 {dateStr}</div>
        <div style={{marginTop:4}}><strong style={{color:dark?'#e8e8e8':'#1a1a1a'}}>{suggestions.length}</strong> pièces affichées</div>
      </div>
      <div style={{background:dark?'#1a233a':'#e8f0fe',border:`2px solid ${C.blue}`,borderRadius:10,padding:'10px 18px',textAlign:'right',minWidth:200}}>
        <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.blue,marginBottom:3}}>Total affiché</div>
        <div style={{fontSize:24,fontWeight:900,color:C.blue}}>{totalCommande.toLocaleString('fr-CA',{minimumFractionDigits:2})} $</div>
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

  // Import
  const [importFile, setImportFile] = useState<File|null>(null)
  const [importStatus, setImportStatus] = useState('')
  const [importLoading, setImportLoading] = useState(false)

  // État de la session de comptage
  const [etape, setEtape] = useState<'localisation'|'piece'|'quantite'>('localisation')
  const [locInput, setLocInput] = useState('')
  const [pieceInput, setPieceInput] = useState('')
  const [qteInput, setQteInput] = useState('')
  const [locActive, setLocActive] = useState<any>(null) // {loc, pieces}
  const [pieceActive, setPieceActive] = useState<any>(null) // info pièce
  const [modeRapide, setModeRapide] = useState(false) // qte=1 auto
  const [erreur, setErreur] = useState('')
  const [avertissement, setAvertissement] = useState('')
  const [comptesDuJour, setComptesDuJour] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [dernierSauvegarde, setDernierSauvegarde] = useState<any>(null)

  // Rapport
  const [comptages, setComptages] = useState<any[]>([])
  const [filtDate, setFiltDate] = useState('')
  const [filtEmploye, setFiltEmploye] = useState('ALL')
  const [filtEcart, setFiltEcart] = useState('ALL')

  const locRef = useRef<HTMLInputElement>(null)
  const pieceRef = useRef<HTMLInputElement>(null)
  const qteRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (sousOnglet === 'rapport') chargerComptages()
  }, [sousOnglet])

  // Sons de feedback
  function sonOk() { try { const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.setValueAtTime(0.3, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2); o.start(); o.stop(ctx.currentTime + 0.2); } catch {} }
  function sonErreur() { try { const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = 220; g.gain.setValueAtTime(0.3, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4); o.start(); o.stop(ctx.currentTime + 0.4); } catch {} }

  // ÉTAPE 1 — Scanner localisation
  async function scanLocalisation(e?: any) {
    if (e) e.preventDefault()
    const loc = locInput.trim().toUpperCase()
    if (!loc) return
    setLoading(true); setErreur(''); setAvertissement('')

    const r = await fetch('/api/inventaire/localisations?loc=' + encodeURIComponent(loc))
    const data = await r.json()

    if (!Array.isArray(data) || data.length === 0) {
      setErreur('❌ Localisation "' + loc + '" inconnue — vérifie le code')
      sonErreur()
      setLocInput('')
      setLoading(false)
      setTimeout(() => locRef.current?.focus(), 100)
      return
    }

    setLocActive({ loc, pieces: data })
    setLocInput('')
    setEtape('piece')
    sonOk()
    setLoading(false)
    setTimeout(() => pieceRef.current?.focus(), 100)
  }

  // ÉTAPE 2 — Scanner pièce
  async function scanPiece(e?: any) {
    if (e) e.preventDefault()
    const code = pieceInput.trim().toUpperCase()
    if (!code) return
    setLoading(true); setErreur(''); setAvertissement('')

    // Chercher la pièce dans la localisation active
    const pieceDansLoc = locActive?.pieces?.find((p:any) =>
      p.code_piece.trim().toUpperCase() === code
    )

    if (!pieceDansLoc) {
      // La pièce n'est pas dans cette localisation — chercher si elle existe ailleurs
      const r = await fetch('/api/sku-lookup?sku=' + encodeURIComponent(code))
      const j = await r.json()

      if (!j.found) {
        setErreur('❌ Pièce "' + code + '" inconnue dans le système')
        sonErreur()
        setPieceInput('')
        setLoading(false)
        setTimeout(() => pieceRef.current?.focus(), 100)
        return
      }

      // Pièce existe mais pas dans cette localisation
      const rLoc = await fetch('/api/inventaire/localisations?code=' + encodeURIComponent(code))
      const locData = await rLoc.json()
      const autresLocs = Array.isArray(locData) && locData.length > 0
        ? locData.flatMap((p:any) => [p.localisation1,p.localisation2,p.localisation3,p.localisation4].filter(Boolean))
        : []

      if (autresLocs.length > 0) {
        setErreur(`🚫 Piece "${code}" pas dans localisation ${locActive.loc}. Bonne place: ${autresLocs.join(', ')}`)
      } else {
        setErreur(`⚠️ Piece "${code}" sans localisation assignee. Entrer manuellement.`)
      }
      sonErreur()
      setPieceInput('')
      setLoading(false)
      setTimeout(() => pieceRef.current?.focus(), 100)
      return
    }

    // Pièce valide dans la localisation
    const rStock = await fetch('/api/inventaire/stock?codes=' + encodeURIComponent(code))
    let stockInfo = { stock: 0, reserve: 0 }
    if (rStock.ok) {
      const stocks = await rStock.json()
      if (stocks.length > 0) stockInfo = { stock: stocks[0].stock, reserve: stocks[0].reserve }
    }

    setPieceActive({ ...pieceDansLoc, stockSys: (stockInfo.stock + stockInfo.reserve), reserve: stockInfo.reserve, stock: stockInfo.stock })
    setPieceInput('')

    if (modeRapide) {
      // Mode rapide — sauvegarder directement avec qte=1
      await sauvegarderComptage(pieceDansLoc, stockInfo, 1)
    } else {
      setEtape('quantite')
      setLoading(false)
      setTimeout(() => qteRef.current?.focus(), 100)
    }
  }

  // ÉTAPE 3 — Sauvegarder comptage
  async function sauvegarderComptage(piece: any, stockInfo: any, qte?: number) {
    const qteFinal = qte !== undefined ? qte : parseFloat(qteInput)
    if (isNaN(qteFinal)) { setErreur('Quantité invalide'); return }
    setLoading(true)

    const qteSysteme = (stockInfo?.stock || 0) + (stockInfo?.reserve || 0)
    await fetch('/api/inventaire/comptages', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        code_piece: piece.code_piece,
        localisation: locActive.loc,
        qte_comptee: qteFinal,
        qte_systeme: qteSysteme,
        qte_reservee: stockInfo?.reserve || 0,
        employe,
        note: null
      })
    })

    const nouveau = { code_piece: piece.code_piece, description: piece.description, qte_comptee: qteFinal, qte_systeme: qteSysteme, ecart: qteFinal - qteSysteme, heure: new Date().toLocaleTimeString('fr-CA') }
    setComptesDuJour(prev => [nouveau, ...prev.filter((c:any) => c.code_piece !== piece.code_piece)])
    setDernierSauvegarde(nouveau)
    setQteInput('')
    setPieceActive(null)
    setEtape('piece')
    sonOk()
    setLoading(false)
    setTimeout(() => pieceRef.current?.focus(), 100)
  }

  async function soumettreQuantite(e?: any) {
    if (e) e.preventDefault()
    if (!pieceActive) return
    await sauvegarderComptage(pieceActive, { stock: pieceActive.stock, reserve: pieceActive.reserve }, undefined)
  }

  function annulerDernier() {
    if (!dernierSauvegarde) return
    setComptesDuJour(prev => prev.filter((c:any) => c.code_piece !== dernierSauvegarde.code_piece))
    setDernierSauvegarde(null)
    // Note: on ne supprime pas de Supabase car c'est une action rapide
  }

  function changerLocalisation() {
    setEtape('localisation')
    setLocActive(null)
    setPieceActive(null)
    setLocInput('')
    setPieceInput('')
    setQteInput('')
    setErreur('')
    setTimeout(() => locRef.current?.focus(), 100)
  }

  async function importerLocalisations(e: any) {
    e.preventDefault()
    if (!importFile) return
    setImportLoading(true); setImportStatus('')
    const fd = new FormData()
    fd.append('file', importFile)
    const r = await fetch('/api/inventaire/import', { method: 'POST', body: fd })
    const j = await r.json()
    if (j.success) setImportStatus('✅ ' + j.total + ' pièces importées')
    else setImportStatus('❌ ' + j.erreur)
    setImportLoading(false)
    setImportFile(null)
  }

  async function chargerComptages() {
    const r = await fetch('/api/inventaire/comptages')
    if (r.ok) setComptages(await r.json())
  }

  const employes = Array.from(new Set(comptages.map((c:any) => c.employe))).sort() as string[]
  const comptagesFiltres = comptages.filter((c:any) => {
    if (filtDate && !c.date_comptage.startsWith(filtDate)) return false
    if (filtEmploye !== 'ALL' && c.employe !== filtEmploye) return false
    if (filtEcart === 'ecart' && c.ecart === 0) return false
    if (filtEcart === 'ok' && c.ecart !== 0) return false
    return true
  })

  return <>
    {/* Sous-onglets */}
    <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center',justifyContent:'space-between'}}>
      <div style={{display:'flex',gap:8}}>
        <button onClick={()=>setSousOnglet('compter')} style={{padding:'8px 18px',borderRadius:20,border:`2px solid ${sousOnglet==='compter'?C.blue:bdr}`,background:sousOnglet==='compter'?(dark?'#1a233a':'#e8f0fe'):'transparent',color:sousOnglet==='compter'?C.blue:sub,fontSize:13,fontWeight:700,cursor:'pointer'}}>
          📦 Compter
        </button>
        <button onClick={()=>setSousOnglet('rapport')} style={{padding:'8px 18px',borderRadius:20,border:`2px solid ${sousOnglet==='rapport'?C.blue:bdr}`,background:sousOnglet==='rapport'?(dark?'#1a233a':'#e8f0fe'):'transparent',color:sousOnglet==='rapport'?C.blue:sub,fontSize:13,fontWeight:700,cursor:'pointer'}}>
          📊 Rapport
        </button>
      </div>
      {sousOnglet==='compter' && (
        <div style={{display:'flex',gap:10,alignItems:'center'}}>
          {/* Mode rapide toggle */}
          <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13}}>
            <div onClick={()=>setModeRapide(!modeRapide)} style={{width:40,height:22,borderRadius:11,background:modeRapide?C.green:'#94a3b8',position:'relative',cursor:'pointer',transition:'all .2s'}}>
              <div style={{position:'absolute',top:3,left:modeRapide?21:3,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'all .2s'}}/>
            </div>
            <span style={{color:modeRapide?C.green:sub,fontWeight:600}}>⚡ Mode rapide (qté=1)</span>
          </label>
        </div>
      )}
    </div>

    {sousOnglet === 'compter' ? <>

      {/* Import fichier */}
      <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,padding:'12px 18px',marginBottom:16}}>
        <form onSubmit={importerLocalisations} style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
          <span style={{fontSize:13,fontWeight:600,color:sub}}>📥 Mettre à jour les localisations :</span>
          <input type="file" accept=".xlsx,.xls" onChange={e=>setImportFile(e.target.files?.[0]||null)} style={{...S,flex:1,minWidth:180,fontSize:12}}/>
          <button type="submit" disabled={!importFile||importLoading} style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'7px 14px',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
            {importLoading?'Import...':'📥 Importer'}
          </button>
          {importStatus && <span style={{fontSize:12,color:importStatus.startsWith('✅')?C.green:C.red,fontWeight:600}}>{importStatus}</span>}
        </form>
      </div>

      {/* Zone principale de scan */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 320px',gap:16,alignItems:'start'}}>

        {/* Panneau de scan */}
        <div>
          {/* Localisation active */}
          {locActive ? (
            <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`2px solid ${C.green}`,borderRadius:14,padding:'16px 20px',marginBottom:16,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div>
                <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.green,marginBottom:4}}>📍 Localisation active</div>
                <div style={{fontSize:32,fontWeight:900,color:C.green,letterSpacing:2}}>{locActive.loc}</div>
                <div style={{fontSize:12,color:sub,marginTop:2}}>{locActive.pieces.length} pièces dans cette localisation</div>
              </div>
              <button onClick={changerLocalisation} style={{background:'none',border:`1px solid ${C.green}`,borderRadius:8,padding:'8px 14px',color:C.green,cursor:'pointer',fontWeight:700,fontSize:12}}>
                🔄 Changer
              </button>
            </div>
          ) : (
            <div style={{background:dark?'#1a1a2e':'#f0f4ff',border:`2px dashed ${C.blue}`,borderRadius:14,padding:'20px',marginBottom:16,textAlign:'center'}}>
              <div style={{fontSize:32,marginBottom:8}}>📍</div>
              <div style={{fontSize:15,fontWeight:700,color:C.blue}}>Scanner une localisation pour commencer</div>
            </div>
          )}

          {/* Champ scan localisation */}
          {etape === 'localisation' && (
            <div style={{background:card,borderRadius:14,border:`2px solid ${C.blue}`,padding:'20px',marginBottom:16}}>
              <div style={{fontSize:13,fontWeight:700,color:C.blue,marginBottom:10}}>📍 Scanner / Entrer une localisation</div>
              <form onSubmit={scanLocalisation} style={{display:'flex',gap:10}}>
                <input ref={locRef} value={locInput} onChange={e=>{setLocInput(e.target.value);setErreur('')}}
                  placeholder="Ex: PSC4-36, BA21..."
                  style={{...S,flex:1,fontSize:18,fontWeight:700,letterSpacing:1}} autoFocus/>
                <button type="submit" disabled={loading} style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'0 20px',fontWeight:700,cursor:'pointer',fontSize:14}}>
                  {loading?'...':'OK'}
                </button>
              </form>
            </div>
          )}

          {/* Champ scan pièce */}
          {etape === 'piece' && locActive && (
            <div style={{background:card,borderRadius:14,border:`2px solid ${C.yellow}`,padding:'20px',marginBottom:16}}>
              <div style={{fontSize:13,fontWeight:700,color:C.yellow,marginBottom:10}}>
                🔍 Scanner une pièce {modeRapide && <span style={{background:C.green,color:'#fff',padding:'2px 8px',borderRadius:10,fontSize:11,marginLeft:6}}>⚡ Mode rapide — qté=1</span>}
              </div>
              <form onSubmit={scanPiece} style={{display:'flex',gap:10}}>
                <input ref={pieceRef} value={pieceInput} onChange={e=>{setPieceInput(e.target.value);setErreur('')}}
                  placeholder="Scanner code-barres ou taper le SKU..."
                  style={{...S,flex:1,fontSize:18,fontWeight:700}} autoFocus/>
                <button type="submit" disabled={loading} style={{background:C.yellow,color:'#fff',border:'none',borderRadius:8,padding:'0 20px',fontWeight:700,cursor:'pointer',fontSize:14}}>
                  {loading?'...':'OK'}
                </button>
              </form>
            </div>
          )}

          {/* Champ quantité */}
          {etape === 'quantite' && pieceActive && (
            <div style={{background:card,borderRadius:14,border:`2px solid ${C.green}`,padding:'20px',marginBottom:16}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:14}}>
                <div>
                  <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.green,marginBottom:4}}>✅ Pièce trouvée</div>
                  <div style={{fontSize:18,fontWeight:900}}>{pieceActive.code_piece}</div>
                  <div style={{fontSize:13,color:sub,marginTop:2}}>{pieceActive.description}</div>
                  <div style={{fontSize:12,marginTop:6,display:'flex',gap:16}}>
                    <span style={{color:C.blue}}>Stock système: <strong>{pieceActive.stockSys}</strong></span>
                    {pieceActive.reserve > 0 && <span style={{color:C.yellow}}>Réservé: <strong>{pieceActive.reserve}</strong></span>}
                  </div>
                </div>
                <button onClick={()=>{setEtape('piece');setPieceActive(null);setQteInput('');setTimeout(()=>pieceRef.current?.focus(),100)}}
                  style={{background:'none',border:`1px solid ${bdr}`,borderRadius:8,padding:'6px 12px',color:sub,cursor:'pointer',fontSize:12}}>
                  ← Annuler
                </button>
              </div>
              <form onSubmit={soumettreQuantite} style={{display:'flex',gap:10}}>
                <input ref={qteRef} type="number" step="any" value={qteInput}
                  onChange={e=>{setQteInput(e.target.value);setErreur('')}}
                  placeholder="Quantité comptée..."
                  style={{...S,flex:1,fontSize:24,fontWeight:900,textAlign:'center'}} autoFocus/>
                <button type="submit" disabled={loading||!qteInput} style={{background:C.green,color:'#fff',border:'none',borderRadius:8,padding:'0 24px',fontWeight:700,cursor:qteInput?'pointer':'not-allowed',fontSize:16}}>
                  {loading?'...':'✅ OK'}
                </button>
              </form>
            </div>
          )}

          {/* Message erreur */}
          {erreur && (
            <div style={{background:C.red+'22',border:`2px solid ${C.red}`,borderRadius:10,padding:'12px 16px',marginBottom:12,color:C.red,fontWeight:700,fontSize:14}}>
              {erreur}
            </div>
          )}

          {/* Dernier sauvegardé */}
          {dernierSauvegarde && etape === 'piece' && (
            <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`1px solid ${C.green}33`,borderRadius:10,padding:'10px 14px',marginBottom:12,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontSize:13,color:C.green,fontWeight:600}}>
                ✅ {dernierSauvegarde.code_piece} — {dernierSauvegarde.qte_comptee} unités
                {dernierSauvegarde.ecart !== 0 && <span style={{color:C.red,marginLeft:8}}>Écart: {dernierSauvegarde.ecart>0?'+':''}{dernierSauvegarde.ecart}</span>}
              </span>
              <button onClick={annulerDernier} style={{background:'none',border:`1px solid ${bdr}`,borderRadius:6,padding:'4px 10px',fontSize:11,color:sub,cursor:'pointer'}}>↩ Annuler</button>
            </div>
          )}
        </div>

        {/* Panneau comptages de la session */}
        <div style={{background:card,borderRadius:14,border:`1px solid ${bdr}`,overflow:'hidden',position:'sticky',top:80}}>
          <div style={{padding:'12px 16px',borderBottom:`1px solid ${bdr}`,background:thBg,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span style={{fontSize:13,fontWeight:700}}>📋 Session ({comptesDuJour.length})</span>
            {comptesDuJour.length > 0 && <span style={{fontSize:11,color:sub}}>👤 {employe}</span>}
          </div>
          <div style={{maxHeight:500,overflowY:'auto'}}>
            {comptesDuJour.length === 0
              ? <div style={{textAlign:'center',padding:30,color:sub,fontSize:13}}>Aucun comptage encore</div>
              : comptesDuJour.map((c:any, i:number) => (
                  <div key={i} style={{padding:'10px 14px',borderBottom:`1px solid ${bdr}`,background:i===0?(dark?'#0d2a18':'#f0fff4'):'transparent'}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                      <div>
                        <div style={{fontSize:12,fontWeight:700}}>{c.code_piece}</div>
                        <div style={{fontSize:10,color:sub,marginTop:1}}>{c.heure}</div>
                      </div>
                      <div style={{textAlign:'right'}}>
                        <div style={{fontSize:14,fontWeight:900,color:C.green}}>{c.qte_comptee}</div>
                        {c.ecart !== 0 && <div style={{fontSize:10,fontWeight:700,color:C.red}}>{c.ecart>0?'+':''}{c.ecart}</div>}
                      </div>
                    </div>
                  </div>
                ))
            }
          </div>
        </div>
      </div>

    </> : <>
      {/* Rapport */}
      <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,padding:'14px 18px',marginBottom:14,display:'flex',gap:12,flexWrap:'wrap',alignItems:'flex-end'}}>
        <div style={{flex:1,minWidth:150}}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Date</div>
          <input type="date" value={filtDate} onChange={e=>setFiltDate(e.target.value)} style={S}/>
        </div>
        <div style={{flex:1,minWidth:150}}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Employé</div>
          <select value={filtEmploye} onChange={e=>setFiltEmploye(e.target.value)} style={S}>
            <option value="ALL">Tous</option>
            {employes.map((emp:string)=><option key={emp} value={emp}>{emp}</option>)}
          </select>
        </div>
        <div style={{flex:1,minWidth:150}}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Écarts</div>
          <select value={filtEcart} onChange={e=>setFiltEcart(e.target.value)} style={S}>
            <option value="ALL">Tous</option>
            <option value="ecart">Avec écart seulement</option>
            <option value="ok">Sans écart seulement</option>
          </select>
        </div>
        <button onClick={chargerComptages} style={{background:C.blue,color:'#fff',border:'none',borderRadius:8,padding:'8px 16px',fontWeight:700,cursor:'pointer'}}>🔄 Rafraîchir</button>
        <div style={{background:dark?'#2b1113':'#fce8e6',border:`2px solid ${C.red}`,borderRadius:10,padding:'10px 16px',textAlign:'center',minWidth:130}}>
          <div style={{fontSize:11,fontWeight:700,color:C.red,textTransform:'uppercase'}}>Écarts</div>
          <div style={{fontSize:22,fontWeight:900,color:C.red}}>{comptagesFiltres.filter((c:any)=>c.ecart!==0).length}</div>
        </div>
        <div style={{background:dark?'#0d2a18':'#e6f4ea',border:`2px solid ${C.green}`,borderRadius:10,padding:'10px 16px',textAlign:'center',minWidth:130}}>
          <div style={{fontSize:11,fontWeight:700,color:C.green,textTransform:'uppercase'}}>Total</div>
          <div style={{fontSize:22,fontWeight:900,color:C.green}}>{comptagesFiltres.length}</div>
        </div>
      </div>

      <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
            <thead><tr style={{background:thBg}}>
              <th style={{padding:'10px 12px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'left'}}>Code Pièce</th>
              <th style={{padding:'10px 12px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Localisation</th>
              <th style={{padding:'10px 12px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Stock système</th>
              <th style={{padding:'10px 12px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.yellow,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Réservé</th>
              <th style={{padding:'10px 12px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.green,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Qté comptée</th>
              <th style={{padding:'10px 12px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.red,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Écart</th>
              <th style={{padding:'10px 12px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`}}>Employé</th>
              <th style={{padding:'10px 12px',fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Date & Heure</th>
            </tr></thead>
            <tbody>
              {comptagesFiltres.length === 0
                ? <tr><td colSpan={8} style={{textAlign:'center',padding:60,color:sub}}>Aucun comptage trouvé</td></tr>
                : comptagesFiltres.map((c:any)=>(
                    <tr key={c.id} onMouseEnter={e=>e.currentTarget.style.background=hvr} onMouseLeave={e=>e.currentTarget.style.background='transparent'}
                      style={{background:c.ecart!==0?(dark?'#2b1113':'#fff8f8'):'transparent'}}>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${bdr}`,fontWeight:700,fontFamily:'monospace',fontSize:12}}>{c.code_piece}</td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>
                        <span style={{background:dark?'#1a233a':'#e8f0fe',color:C.blue,padding:'2px 8px',borderRadius:4,fontSize:12,fontWeight:600}}>{c.localisation}</span>
                      </td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700}}>{c.qte_systeme}</td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.yellow}}>{c.qte_reservee}</td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:700,color:C.green}}>{c.qte_comptee}</td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:900,color:c.ecart===0?C.green:C.red}}>
                        {c.ecart>0?'+':''}{c.ecart}
                      </td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${bdr}`}}>
                        <span style={{background:C.blue+'22',color:C.blue,padding:'2px 8px',borderRadius:10,fontSize:11}}>👤 {c.employe}</span>
                      </td>
                      <td style={{padding:'9px 12px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:sub,fontSize:12,whiteSpace:'nowrap'}}>
                        {new Date(c.date_comptage).toLocaleDateString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
                      </td>
                    </tr>
                  ))
              }
            </tbody>
          </table>
        </div>
      </div>
    </>}
  </>
}


// ── Utilisateurs Tab ─────────────────────────────────────────────────────────
function UtilisateursTab({dark, card, bdr, sub, thBg, S, C, hvr}: any) {
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
  const [filtFourn, setFiltFourn] = useState('ALL')
  const [filtLignes, setFiltLignes] = useState<string[]>([])
  const [ddLigneOpen, setDdLigneOpen] = useState(false)
  const ddLigneRef = useRef<HTMLDivElement>(null)
  const [sousOnglet, setSousOnglet] = useState<'actif'|'verifie'>('actif')
  const [noteModal, setNoteModal] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    serv_detail: '', serv_interne: '', serv_gar: '', pce_detail: '',
    recept_comm: '', dec_physique: '', autre: '', qte_reelle: '', commentaire: ''
  })

  const employe = profil?.nom || profil?.email || 'Inconnu'

  // Codes déjà vérifiés
  const codesVerifies = new Set(negsVerifies.map((v:any) => v.code_piece))

  // Dédupliquer par code_piece
  const dedup = new Map<string, any>()
  for (const n of negs) {
    if (!dedup.has(n.code_piece) || new Date(n.date_apparition) > new Date(dedup.get(n.code_piece).date_apparition)) {
      dedup.set(n.code_piece, n)
    }
  }
  const negsUniques = Array.from(dedup.values())

  const fournisseurs = Array.from(new Set(negsUniques.map((n: any) => n.fournisseur))).sort() as string[]
  const lignes = Array.from(new Set(negsUniques.map((n: any) => n.ligne))).sort() as string[]

  // Filtrer selon sous-onglet
  const negsActifs = negsUniques.filter((n:any) => !codesVerifies.has(n.code_piece))
  const filtered = negsActifs.filter((n: any) => {
    if (filtFourn !== 'ALL' && n.fournisseur !== filtFourn) return false
    if (filtLignes.length > 0 && !filtLignes.includes(n.ligne)) return false
    return true
  }).sort((a: any, b: any) => Math.abs(b.stock_negatif * b.cout_unitaire) - Math.abs(a.stock_negatif * a.cout_unitaire))

  const totalErreur = filtered.reduce((s: number, n: any) => s + Math.abs(n.stock_negatif * n.cout_unitaire), 0)

  const champs = [
    {key:'serv_detail', label:'Serv. détail'},
    {key:'serv_interne', label:'Serv. interne'},
    {key:'serv_gar', label:'Serv. gar.'},
    {key:'pce_detail', label:'Pce détail'},
    {key:'recept_comm', label:'Récept. comm.'},
    {key:'dec_physique', label:'Déc. physique'},
    {key:'autre', label:'Autre'},
  ]

  function getAjustement() {
    const somme = champs.reduce((s, c) => s + (parseFloat((form as any)[c.key]) || 0), 0)
    const reelle = parseFloat(form.qte_reelle) || 0
    const stockNeg = noteModal ? Number(noteModal.stock_negatif) : 0
    // Ajustement = qté réelle tablette - (stock système + transactions)
    return reelle - (stockNeg + somme)
  }

  function formComplet() {
    return champs.every(c => (form as any)[c.key] !== '') && form.qte_reelle !== ''
  }

  async function marquerVerifie(e: any) {
    e.preventDefault()
    if (!formComplet()) return
    const n = noteModal
    const val = Math.abs(n.stock_negatif * n.cout_unitaire)
    const ajustement = getAjustement()
    setLoading(true)

    // Sauvegarder la pièce principale
    await fetch('/api/negatifs-verifies', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        code_piece: n.code_piece, employe,
        stock_au_moment: n.stock_negatif,
        valeur_au_moment: val,
        serv_detail: parseFloat(form.serv_detail) || 0,
        serv_interne: parseFloat(form.serv_interne) || 0,
        serv_gar: parseFloat(form.serv_gar) || 0,
        pce_detail: parseFloat(form.pce_detail) || 0,
        recept_comm: parseFloat(form.recept_comm) || 0,
        dec_physique: parseFloat(form.dec_physique) || 0,
        autre: parseFloat(form.autre) || 0,
        qte_reelle: parseFloat(form.qte_reelle) || 0,
        ajustement,
        commentaire: form.commentaire || null,
        note: null
      })
    })

    // Sauvegarder les pièces alternatives si remplies
    const altCodes: string[] = (alts && alts.get && alts.get(n.code_piece)) || []
    for (const ac of altCodes) {
      const fKey = `alt_${ac}`
      const altForm = (form as any)[fKey]
      if (!altForm || altForm.qte_reelle === '') continue
      const norm = (s:string) => s.trim().toLowerCase().replace(/\s+/g,'')
      const altItem = (negs||[]).find((ni:any) => norm(ni.code_piece) === norm(ac))
      const stockAlt = altItem ? Number(altItem.stock_negatif) : 0
      const sommeAlt = ['serv_detail','serv_interne','serv_gar','pce_detail','recept_comm','dec_physique','autre']
        .reduce((s,k) => s + (parseFloat(altForm[k])||0), 0)
      const ajustAlt = (parseFloat(altForm.qte_reelle)||0) - (stockAlt + sommeAlt)
      await fetch('/api/negatifs-verifies', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          code_piece: ac, employe,
          stock_au_moment: stockAlt,
          valeur_au_moment: 0,
          serv_detail: parseFloat(altForm.serv_detail)||0,
          serv_interne: parseFloat(altForm.serv_interne)||0,
          serv_gar: parseFloat(altForm.serv_gar)||0,
          pce_detail: parseFloat(altForm.pce_detail)||0,
          recept_comm: parseFloat(altForm.recept_comm)||0,
          dec_physique: parseFloat(altForm.dec_physique)||0,
          autre: parseFloat(altForm.autre)||0,
          qte_reelle: parseFloat(altForm.qte_reelle)||0,
          ajustement: ajustAlt,
          commentaire: `Alt. de ${n.code_piece}${form.commentaire ? ' — ' + form.commentaire : ''}`,
          note: null
        })
      })
    }

    const r = await fetch('/api/negatifs-verifies')
    if (r.ok) setNegsVerifies(await r.json())
    setNoteModal(null)
    setForm({serv_detail:'',serv_interne:'',serv_gar:'',pce_detail:'',recept_comm:'',dec_physique:'',autre:'',qte_reelle:'',commentaire:''})
    setLoading(false)
  }

  async function retablir(code_piece: string) {
    await fetch('/api/negatifs-verifies', {
      method: 'DELETE',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ code_piece })
    })
    const r = await fetch('/api/negatifs-verifies')
    if (r.ok) setNegsVerifies(await r.json())
  }

  return <>
    {/* Modal formulaire ajustement */}
    {noteModal && (() => {
      // Chercher les alternatives de la pièce
      const altCodes: string[] = (alts && alts.get && alts.get(noteModal.code_piece)) || []
      const allItems: any[] = data?.liste_complete || []
      const altItems = altCodes.map((ac:string) => {
        const norm = (s:string) => s.trim().toLowerCase().replace(/\s+/g,'')
        // Chercher d'abord dans les négatifs, sinon dans liste_complete
        const inNegs = (negs||[]).find((n:any) => norm(n.code_piece) === norm(ac))
        if (inNegs) return inNegs
        const inAll = allItems.find((n:any) => norm(n.pk) === norm(ac))
        if (inAll) return { code_piece: inAll.pk, description: inAll.desc, stock_negatif: inAll.stock, fournisseur: inAll.fournisseur }
        return { code_piece: ac, description: ac, stock_negatif: 0, fournisseur: '' }
      })

      const champs = [
        {key:'serv_detail', label:'Serv. détail', desc:'Ventes débitées service détail'},
        {key:'serv_interne', label:'Serv. interne', desc:'Ventes débitées service interne'},
        {key:'serv_gar', label:'Serv. gar.', desc:'Ventes débitées service garantie'},
        {key:'pce_detail', label:'Pce détail', desc:'Ventes pièces au détail'},
        {key:'recept_comm', label:'Récept. comm.', desc:'Réceptions de commandes'},
        {key:'dec_physique', label:'Déc. physique', desc:'Ajustement prise inventaire annuelle'},
        {key:'autre', label:'Autre', desc:'Autres ajustements/erreurs inventaire'},
      ]

      function calcAjust(stockSys: number, f: any) {
        const somme = champs.reduce((s,c) => s + (parseFloat(f[c.key])||0), 0)
        const reelle = parseFloat(f.qte_reelle) || 0
        return reelle - (stockSys + somme)
      }

      const ajustPrincipal = calcAjust(Number(noteModal.stock_negatif), form)
      const hasAlt = altCodes.length > 0

      return (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
          <div style={{background:card,borderRadius:16,width:'100%',maxWidth:hasAlt?920:560,border:`1px solid ${bdr}`,boxShadow:'0 20px 60px rgba(0,0,0,.5)',maxHeight:'92vh',overflowY:'auto'}}>
            
            {/* Header */}
            <div style={{padding:'20px 24px',borderBottom:`1px solid ${bdr}`,position:'sticky',top:0,background:card,zIndex:10}}>
              <h3 style={{margin:'0 0 4px',fontSize:17}}>✅ Vérification inventaire</h3>
              <div style={{display:'flex',gap:16,flexWrap:'wrap'}}>
                <span style={{color:sub,fontSize:13}}><strong style={{color:dark?'#e8e8e8':'#1a1a1a'}}>{noteModal.code_piece}</strong> — {noteModal.description}</span>
                <span style={{color:C.red,fontSize:13,fontWeight:700}}>Stock système: {noteModal.stock_negatif}</span>
              </div>
              {hasAlt && <div style={{marginTop:6,fontSize:12,color:C.blue}}>🔄 Pièce alternative détectée — remplis les 2 sections</div>}
            </div>

            <form onSubmit={marquerVerifie}>
              <div style={{padding:'20px 24px',display:'grid',gridTemplateColumns:hasAlt?'1fr 1fr':'1fr',gap:20}}>
                
                {/* Section pièce principale */}
                <div>
                  <div style={{background:dark?'#1a1a2e':'#f0f4ff',borderRadius:10,padding:'10px 14px',marginBottom:14,border:`1px solid ${C.blue}33`}}>
                    <div style={{fontSize:12,fontWeight:700,color:C.blue}}>📦 Pièce principale</div>
                    <div style={{fontSize:13,fontWeight:700,marginTop:2}}>{noteModal.code_piece}</div>
                    <div style={{fontSize:11,color:sub}}>{noteModal.description}</div>
                  </div>

                  {/* Champs transactions */}
                  <div style={{marginBottom:14}}>
                    <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:8}}>Transactions</div>
                    <div style={{display:'flex',flexDirection:'column',gap:6}}>
                      {champs.map(c => (
                        <div key={c.key} style={{display:'flex',alignItems:'center',gap:8}}>
                          <div style={{flex:1}}>
                            <div style={{fontSize:12,fontWeight:600}}>{c.label}</div>
                            <div style={{fontSize:10,color:sub}}>{c.desc}</div>
                          </div>
                          <input type="number" step="any" required
                            value={(form as any)[c.key]}
                            onChange={e=>setForm(prev=>({...prev,[c.key]:e.target.value}))}
                            placeholder="0"
                            style={{...S,width:80,textAlign:'center',padding:'6px 8px'}}/>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Qté réelle */}
                  <div style={{background:dark?'#0d2a18':'#e6f4ea',borderRadius:10,padding:'12px 14px',marginBottom:12,border:`1px solid ${C.green}33`}}>
                    <label style={{fontSize:12,fontWeight:700,color:C.green,display:'block',marginBottom:6}}>📦 Qté réelle sur tablette *</label>
                    <input type="number" step="any" required value={form.qte_reelle}
                      onChange={e=>setForm(prev=>({...prev,qte_reelle:e.target.value}))}
                      placeholder="Compter les unités..."
                      style={{...S,fontWeight:700,fontSize:15,textAlign:'center'}}/>
                  </div>

                  {/* Ajustement principal */}
                  {form.qte_reelle !== '' && (
                    <div style={{background:dark?'#1a233a':'#e8f0fe',borderRadius:10,padding:'10px 14px',border:`1px solid ${C.blue}33`}}>
                      <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.blue,marginBottom:2}}>Ajustement à faire</div>
                      <div style={{fontSize:24,fontWeight:900,color:ajustPrincipal>=0?C.green:C.red}}>
                        {ajustPrincipal>=0?'+':''}{ajustPrincipal.toFixed(0)} unités
                      </div>
                      <div style={{fontSize:10,color:sub,marginTop:2}}>
                        {form.qte_reelle} tablette − ({noteModal.stock_negatif} système + {champs.reduce((s,c)=>s+(parseFloat((form as any)[c.key])||0),0).toFixed(0)} transactions)
                      </div>
                    </div>
                  )}
                </div>

                {/* Section pièce alternative */}
                {hasAlt && altItems.map((altItem: any) => {
                  const fKey = `alt_${altItem.code_piece}`
                  const altForm = (form as any)[fKey] || {serv_detail:'',serv_interne:'',serv_gar:'',pce_detail:'',recept_comm:'',dec_physique:'',autre:'',qte_reelle:''}
                  const ajustAlt = altForm.qte_reelle !== '' ? calcAjust(Number(altItem.stock_negatif||0), altForm) : null

                  return (
                    <div key={altItem.code_piece}>
                      <div style={{background:dark?'#1a2a1a':'#f0fff4',borderRadius:10,padding:'10px 14px',marginBottom:14,border:`1px solid ${C.green}33`}}>
                        <div style={{fontSize:12,fontWeight:700,color:C.green}}>🔄 Pièce alternative</div>
                        <div style={{fontSize:13,fontWeight:700,marginTop:2}}>{altItem.code_piece}</div>
                        <div style={{fontSize:11,color:sub}}>{altItem.description}</div>
                        <div style={{fontSize:11,color:C.red,fontWeight:700,marginTop:2}}>Stock système: {altItem.stock_negatif||0}</div>
                      </div>

                      <div style={{marginBottom:14}}>
                        <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:8}}>Transactions</div>
                        <div style={{display:'flex',flexDirection:'column',gap:6}}>
                          {champs.map(c => (
                            <div key={c.key} style={{display:'flex',alignItems:'center',gap:8}}>
                              <div style={{flex:1}}>
                                <div style={{fontSize:12,fontWeight:600}}>{c.label}</div>
                                <div style={{fontSize:10,color:sub}}>{c.desc}</div>
                              </div>
                              <input type="number" step="any" required
                                value={altForm[c.key]}
                                onChange={e=>setForm(prev=>({...prev,[fKey]:{...altForm,[c.key]:e.target.value}}))}
                                placeholder="0"
                                style={{...S,width:80,textAlign:'center',padding:'6px 8px'}}/>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div style={{background:dark?'#0d2a18':'#e6f4ea',borderRadius:10,padding:'12px 14px',marginBottom:12,border:`1px solid ${C.green}33`}}>
                        <label style={{fontSize:12,fontWeight:700,color:C.green,display:'block',marginBottom:6}}>📦 Qté réelle sur tablette *</label>
                        <input type="number" step="any" required value={altForm.qte_reelle}
                          onChange={e=>setForm(prev=>({...prev,[fKey]:{...altForm,qte_reelle:e.target.value}}))}
                          placeholder="Compter les unités..."
                          style={{...S,fontWeight:700,fontSize:15,textAlign:'center'}}/>
                      </div>

                      {altForm.qte_reelle !== '' && ajustAlt !== null && (
                        <div style={{background:dark?'#1a233a':'#e8f0fe',borderRadius:10,padding:'10px 14px',border:`1px solid ${C.blue}33`}}>
                          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.blue,marginBottom:2}}>Ajustement à faire</div>
                          <div style={{fontSize:24,fontWeight:900,color:ajustAlt>=0?C.green:C.red}}>
                            {ajustAlt>=0?'+':''}{ajustAlt.toFixed(0)} unités
                          </div>
                          <div style={{fontSize:10,color:sub,marginTop:2}}>
                            {altForm.qte_reelle} tablette − ({altItem.stock_negatif||0} système + {champs.reduce((s,c)=>s+(parseFloat(altForm[c.key])||0),0).toFixed(0)} transactions)
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Commentaire + boutons */}
              <div style={{padding:'0 24px 20px 24px'}}>
                <div style={{marginBottom:16}}>
                  <label style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,display:'block',marginBottom:6}}>Commentaire (optionnel)</label>
                  <input value={form.commentaire} onChange={e=>setForm(prev=>({...prev,commentaire:e.target.value}))}
                    placeholder="Ex: Trouvé en arrière-boutique, donné la pièce alternative au client..." style={S}/>
                </div>
                <div style={{display:'flex',gap:10}}>
                  <button type="button" onClick={()=>{setNoteModal(null);setForm({serv_detail:'',serv_interne:'',serv_gar:'',pce_detail:'',recept_comm:'',dec_physique:'',autre:'',qte_reelle:'',commentaire:''})}}
                    style={{flex:1,background:'none',border:`1px solid ${bdr}`,borderRadius:8,padding:'11px 0',cursor:'pointer',color:sub,fontWeight:600}}>Annuler</button>
                  <button type="submit" disabled={loading||!formComplet()}
                    style={{flex:2,background:formComplet()?C.green:'#94a3b8',color:'#fff',border:'none',borderRadius:8,padding:'11px 0',fontWeight:700,cursor:formComplet()?'pointer':'not-allowed',fontSize:14}}>
                    {loading?'Enregistrement...':'✅ Confirmer la vérification'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )
    })()}

    {/* Sous-onglets */}
    <div style={{display:'flex',gap:8,marginBottom:14}}>
      <button onClick={()=>setSousOnglet('actif')} style={{padding:'7px 16px',borderRadius:20,border:`2px solid ${sousOnglet==='actif'?C.red:bdr}`,background:sousOnglet==='actif'?C.red+'22':'transparent',color:sousOnglet==='actif'?C.red:sub,fontSize:12,fontWeight:700,cursor:'pointer'}}>
        🔴 À vérifier ({negsActifs.length})
      </button>
      <button onClick={()=>setSousOnglet('verifie')} style={{padding:'7px 16px',borderRadius:20,border:`2px solid ${sousOnglet==='verifie'?C.green:bdr}`,background:sousOnglet==='verifie'?C.green+'22':'transparent',color:sousOnglet==='verifie'?C.green:sub,fontSize:12,fontWeight:700,cursor:'pointer'}}>
        ✅ Vérifié ({negsVerifies.length})
      </button>
    </div>

    {sousOnglet === 'actif' ? <>
      {/* Filtres + Total */}
      <div style={{background:card,borderRadius:12,padding:'14px 18px',marginBottom:14,display:'flex',gap:12,flexWrap:'wrap',alignItems:'flex-end',border:`1px solid ${bdr}`}}>
        <div style={{flex:1,minWidth:180}}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>Fournisseur</div>
          <select value={filtFourn} onChange={e=>setFiltFourn(e.target.value)} style={S}>
            <option value="ALL">Tous ({negsActifs.length})</option>
            {fournisseurs.map((f:string)=><option key={f} value={f}>{f} ({negsActifs.filter((n:any)=>n.fournisseur===f).length})</option>)}
          </select>
        </div>
        <div style={{flex:1.2,minWidth:160}} ref={ddLigneRef}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:sub,marginBottom:5}}>
            Lignes {filtLignes.length>0&&<span style={{color:C.blue}}>({filtLignes.length})</span>}
          </div>
          <div style={{position:'relative'}}>
            <button onClick={()=>setDdLigneOpen(!ddLigneOpen)} style={{...S,display:'flex',justifyContent:'space-between',alignItems:'center',cursor:'pointer',textAlign:'left'}}>
              <span style={{fontSize:13}}>{filtLignes.length===0?'Toutes':filtLignes.length===1?filtLignes[0]:`${filtLignes.length} sélectionnées`}</span>
              <span style={{fontSize:10}}>{ddLigneOpen?'▲':'▼'}</span>
            </button>
            {ddLigneOpen && (
              <div style={{position:'absolute',top:'105%',left:0,right:0,background:card,border:`1px solid ${bdr}`,borderRadius:8,zIndex:500,boxShadow:'0 4px 16px rgba(0,0,0,.15)',maxHeight:220,overflowY:'auto'}}>
                <div style={{padding:'6px 10px',borderBottom:`1px solid ${bdr}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{fontSize:11,color:sub}}>Sélectionner lignes</span>
                  {filtLignes.length>0&&<button onClick={()=>setFiltLignes([])} style={{fontSize:11,color:C.red,background:'none',border:'none',cursor:'pointer',padding:0}}>Tout décocher</button>}
                </div>
                {lignes.map((l:string)=>(
                  <label key={l} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 12px',cursor:'pointer',fontSize:13,borderBottom:`1px solid ${dark?'#222':'#f5f5f5'}`}}
                    onMouseEnter={e=>(e.currentTarget.style.background=hvr)}
                    onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>
                    <input type="checkbox" checked={filtLignes.includes(l)} onChange={()=>setFiltLignes(prev=>prev.includes(l)?prev.filter(x=>x!==l):[...prev,l])} style={{accentColor:C.blue}}/>
                    {l}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        <div style={{flex:1,minWidth:140,display:'flex',alignItems:'center',gap:10}}>
          {(filtFourn!=='ALL'||filtLignes.length>0) && (
            <button onClick={()=>{setFiltFourn('ALL');setFiltLignes([]);setDdLigneOpen(false)}} style={{background:'none',border:`1px solid ${bdr}`,borderRadius:6,padding:'6px 12px',fontSize:12,color:sub,cursor:'pointer'}}>Réinitialiser</button>
          )}
        </div>
        <div style={{background:dark?'#2b1113':'#fce8e6',border:`2px solid ${C.red}`,borderRadius:10,padding:'10px 18px',textAlign:'right',minWidth:200}}>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',color:C.red,marginBottom:3}}>Erreur inventaire ({filtered.length} pièces)</div>
          <div style={{fontSize:24,fontWeight:900,color:C.red}}>− {totalErreur.toLocaleString('fr-CA',{minimumFractionDigits:2})} $</div>
        </div>
      </div>

      {/* Tableau actif */}
      <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
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
                          <button onClick={()=>setNoteModal(n)}
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
    </> : <>
      {/* Tableau vérifié */}
      <div style={{background:card,borderRadius:12,border:`1px solid ${bdr}`,overflow:'hidden'}}>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr style={{background:thBg}}>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`}}>Code Pièce</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Stock syst.</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Serv. détail</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Serv. interne</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Serv. gar.</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Pce détail</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Récept. comm.</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Déc. physique</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Autre</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.green,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Qté tablette</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:C.blue,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Ajustement</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`}}>Commentaire</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`}}>Vérifié par</th>
              <th style={{padding:'9px 8px',fontSize:10,fontWeight:700,textTransform:'uppercase',color:sub,borderBottom:`2px solid ${bdr}`,textAlign:'center'}}>Date</th>
            </tr></thead>
            <tbody>
              {negsVerifies.length===0
                ? <tr><td colSpan={14} style={{textAlign:'center',padding:60,color:sub}}>Aucune pièce vérifiée</td></tr>
                : negsVerifies.map((v:any)=>(
                    <tr key={v.id} onMouseEnter={e=>e.currentTarget.style.background=hvr} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontWeight:700}}>{v.code_piece}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.red,fontWeight:700}}>{v.stock_au_moment}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{v.serv_detail ?? '—'}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{v.serv_interne ?? '—'}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{v.serv_gar ?? '—'}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{v.pce_detail ?? '—'}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{v.recept_comm ?? '—'}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{v.dec_physique ?? '—'}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center'}}>{v.autre ?? '—'}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:C.green,fontWeight:700}}>{v.qte_reelle ?? '—'}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',fontWeight:900,color:Number(v.ajustement)>=0?C.green:C.red}}>
                        {Number(v.ajustement)>=0?'+':''}{Number(v.ajustement).toFixed(0)}
                      </td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,color:sub,fontSize:11,maxWidth:150,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={v.commentaire||''}>{v.commentaire||'—'}</td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,fontWeight:600}}>
                        <span style={{background:C.blue+'22',color:C.blue,padding:'2px 6px',borderRadius:10,fontSize:10}}>👤 {v.employe}</span>
                      </td>
                      <td style={{padding:'8px',borderBottom:`1px solid ${bdr}`,textAlign:'center',color:sub,fontSize:11,whiteSpace:'nowrap'}}>
                        {new Date(v.date_verification).toLocaleDateString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
                      </td>
                    </tr>
                  ))
              }
            </tbody>
          </table>
        </div>
      </div>
    </>}
  </>
}


