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
  const [erreur, setErreur] = useState('')
  const [msgOk, setMsgOk] = useState('')
  const [type, setType] = useState<'recovery' | 'invite' | null>(null)

  useEffect(() => {
    const hash = window.location.hash
    const params = new URLSearchParams(hash.replace('#', '?'))
    const t = params.get('type') as any
    setType(t === 'recovery' || t === 'invite' ? t : 'recovery')
  }, [])

  async function setNewPassword(e: any) {
    e.preventDefault()
    if (password !== confirm) { setErreur('Les mots de passe ne correspondent pas'); return }
    if (password.length < 8) { setErreur('Minimum 8 caractères'); return }
    setLoading(true); setErreur('')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) setErreur(error.message)
    else {
      setMsgOk('Mot de passe créé ! Redirection...')
      setTimeout(() => window.location.href = '/', 2000)
    }
    setLoading(false)
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'DM Sans', sans-serif", padding: 20
    }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>⚓</div>
          <h1 style={{ color: '#fff', margin: 0, fontSize: 24, fontWeight: 800 }}>Mathias Marine Sports</h1>
        </div>
        <div style={{
          background: 'rgba(255,255,255,0.05)', backdropFilter: 'blur(20px)',
          borderRadius: 20, padding: '32px 36px',
          border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 25px 50px rgba(0,0,0,0.5)'
        }}>
          <h2 style={{ color: '#fff', margin: '0 0 8px', fontSize: 20, fontWeight: 700 }}>
            {type === 'invite' ? '👋 Bienvenue!' : '🔑 Nouveau mot de passe'}
          </h2>
          <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 24px' }}>
            {type === 'invite' ? 'Crée ton mot de passe pour accéder au dashboard.' : 'Entre ton nouveau mot de passe.'}
          </p>

          {erreur && <div style={{ background: '#ef444422', border: '1px solid #ef4444', borderRadius: 10, padding: '10px 14px', marginBottom: 16, color: '#fca5a5', fontSize: 13 }}>⚠️ {erreur}</div>}
          {msgOk && <div style={{ background: '#10b98122', border: '1px solid #10b981', borderRadius: 10, padding: '10px 14px', marginBottom: 16, color: '#6ee7b7', fontSize: 13 }}>✅ {msgOk}</div>}

          <form onSubmit={setNewPassword}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Nouveau mot de passe</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8}
                placeholder="Minimum 8 caractères"
                style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 14, outline: 'none', boxSizing: 'border-box' }}/>
            </div>
            <div style={{ marginBottom: 24 }}>
              <label style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Confirmer</label>
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required
                placeholder="Répète le mot de passe"
                style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 14, outline: 'none', boxSizing: 'border-box' }}/>
            </div>
            <button type="submit" disabled={loading} style={{
              width: '100%', padding: '13px 0', borderRadius: 10, border: 'none',
              background: 'linear-gradient(135deg, #1a73e8, #0d47a1)',
              color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer'
            }}>
              {loading ? 'Enregistrement...' : 'Créer mon mot de passe'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
