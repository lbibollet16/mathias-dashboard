'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function AuthCallback() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [erreur, setErreur] = useState('')
  const [msgOk, setMsgOk] = useState('')
  const [type, setType] = useState<'recovery' | 'invite' | null>(null)

  useEffect(() => {
    const hash = window.location.hash
    const searchParams = new URLSearchParams(window.location.search)
    const code = searchParams.get('code')

    if (code) {
      // Nouveau format Supabase PKCE
      supabase.auth.exchangeCodeForSession(code).then(({ data, error }) => {
        if (error) { setErreur('Lien invalide ou expiré.'); setInitializing(false); return }
        if (data.session) {
          const t = searchParams.get('type')
          setType(t === 'recovery' ? 'recovery' : 'invite')
        }
        setInitializing(false)
      })
    } else if (hash && hash.includes('access_token')) {
      // Ancien format hash
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) {
          const params = new URLSearchParams(hash.replace('#', ''))
          const t = params.get('type')
          setType(t === 'invite' ? 'invite' : 'recovery')
        } else {
          setErreur('Lien invalide ou expiré.')
        }
        setInitializing(false)
      })
    } else {
      setErreur('Lien invalide ou expiré. Demande une nouvelle invitation.')
      setInitializing(false)
    }
  }, [])

  async function setNewPassword(e: any) {
    e.preventDefault()
    if (password !== confirm) { setErreur('Les mots de passe ne correspondent pas'); return }
    if (password.length < 8) { setErreur('Minimum 8 caractères'); return }
    setLoading(true); setErreur('')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) { setErreur(error.message); setLoading(false); return }
    setMsgOk('Mot de passe créé! Redirection...')
    setTimeout(() => window.location.href = '/', 2000)
  }

  const S: any = {
    width: '100%', padding: '12px 14px', borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(255,255,255,0.08)', color: '#fff',
    fontSize: 14, outline: 'none', boxSizing: 'border-box'
  }

  return (
    <div style={{minHeight:'100vh',background:'linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#0f172a 100%)',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:"'DM Sans',sans-serif",padding:20}}>
      <div style={{width:'100%',maxWidth:420}}>
        <div style={{textAlign:'center',marginBottom:32}}>
          <div style={{fontSize:48,marginBottom:8}}>⚓</div>
          <h1 style={{color:'#fff',margin:0,fontSize:24,fontWeight:800}}>Mathias Marine Sports</h1>
        </div>
        <div style={{background:'rgba(255,255,255,0.05)',backdropFilter:'blur(20px)',borderRadius:20,padding:'32px 36px',border:'1px solid rgba(255,255,255,0.1)',boxShadow:'0 25px 50px rgba(0,0,0,0.5)'}}>
          {initializing ? (
            <div style={{textAlign:'center',color:'#94a3b8',padding:20}}>
              <div style={{fontSize:32,marginBottom:12}}>⏳</div>
              <p>Vérification du lien...</p>
            </div>
          ) : erreur && !type ? (
            <div>
              <h2 style={{color:'#fff',margin:'0 0 16px'}}>❌ Lien invalide</h2>
              <div style={{background:'#ef444422',border:'1px solid #ef4444',borderRadius:10,padding:'12px 14px',color:'#fca5a5',fontSize:13,marginBottom:20}}>{erreur}</div>
              <a href="/login" style={{color:'#60a5fa',fontSize:13}}>← Retour à la connexion</a>
            </div>
          ) : (
            <>
              <h2 style={{color:'#fff',margin:'0 0 8px',fontSize:20,fontWeight:700}}>
                {type==='invite' ? '👋 Bienvenue!' : '🔑 Nouveau mot de passe'}
              </h2>
              <p style={{color:'#94a3b8',fontSize:13,margin:'0 0 24px'}}>
                {type==='invite' ? 'Crée ton mot de passe pour accéder au dashboard.' : 'Entre ton nouveau mot de passe.'}
              </p>
              {erreur && <div style={{background:'#ef444422',border:'1px solid #ef4444',borderRadius:10,padding:'10px 14px',marginBottom:16,color:'#fca5a5',fontSize:13}}>⚠️ {erreur}</div>}
              {msgOk && <div style={{background:'#10b98122',border:'1px solid #10b981',borderRadius:10,padding:'10px 14px',marginBottom:16,color:'#6ee7b7',fontSize:13}}>✅ {msgOk}</div>}
              <form onSubmit={setNewPassword}>
                <div style={{marginBottom:16}}>
                  <label style={{color:'#94a3b8',fontSize:12,fontWeight:700,textTransform:'uppercase',display:'block',marginBottom:6}}>Nouveau mot de passe</label>
                  <input type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={8} placeholder="Minimum 8 caractères" style={S} autoFocus/>
                </div>
                <div style={{marginBottom:24}}>
                  <label style={{color:'#94a3b8',fontSize:12,fontWeight:700,textTransform:'uppercase',display:'block',marginBottom:6}}>Confirmer</label>
                  <input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} required placeholder="Répète le mot de passe" style={S}/>
                </div>
                <button type="submit" disabled={loading} style={{width:'100%',padding:'13px 0',borderRadius:10,border:'none',background:loading?'#334155':'linear-gradient(135deg,#1a73e8,#0d47a1)',color:'#fff',fontSize:15,fontWeight:700,cursor:loading?'not-allowed':'pointer'}}>
                  {loading ? 'Enregistrement...' : 'Créer mon mot de passe →'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
