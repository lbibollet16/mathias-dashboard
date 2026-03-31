'use client'
import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'reset'>('login')
  const [loading, setLoading] = useState(false)
  const [erreur, setErreur] = useState('')
  const [msgOk, setMsgOk] = useState('')

  async function login(e: any) {
    e.preventDefault()
    setLoading(true); setErreur('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setErreur('Email ou mot de passe incorrect')
    } else {
      window.location.href = '/'
    }
    setLoading(false)
  }

  async function resetPassword(e: any) {
    e.preventDefault()
    setLoading(true); setErreur('')
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?type=recovery`
    })
    if (error) setErreur(error.message)
    else setMsgOk('Email envoyé ! Vérifie ta boîte de réception.')
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
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>⚓</div>
          <h1 style={{ color: '#fff', margin: 0, fontSize: 24, fontWeight: 800 }}>Mathias Marine Sports</h1>
          <p style={{ color: '#94a3b8', margin: '6px 0 0', fontSize: 14 }}>Système de gestion inventaire</p>
        </div>

        {/* Card */}
        <div style={{
          background: 'rgba(255,255,255,0.05)',
          backdropFilter: 'blur(20px)',
          borderRadius: 20,
          padding: '32px 36px',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 25px 50px rgba(0,0,0,0.5)'
        }}>
          <h2 style={{ color: '#fff', margin: '0 0 24px', fontSize: 20, fontWeight: 700 }}>
            {mode === 'login' ? '🔐 Connexion' : '🔑 Réinitialiser le mot de passe'}
          </h2>

          {erreur && (
            <div style={{ background: '#ef444422', border: '1px solid #ef4444', borderRadius: 10, padding: '10px 14px', marginBottom: 16, color: '#fca5a5', fontSize: 13 }}>
              ⚠️ {erreur}
            </div>
          )}
          {msgOk && (
            <div style={{ background: '#10b98122', border: '1px solid #10b981', borderRadius: 10, padding: '10px 14px', marginBottom: 16, color: '#6ee7b7', fontSize: 13 }}>
              ✅ {msgOk}
            </div>
          )}

          <form onSubmit={mode === 'login' ? login : resetPassword}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Email</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)} required
                placeholder="ton@email.com"
                style={{
                  width: '100%', padding: '12px 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)',
                  background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 14,
                  outline: 'none', boxSizing: 'border-box'
                }}
              />
            </div>

            {mode === 'login' && (
              <div style={{ marginBottom: 24 }}>
                <label style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Mot de passe</label>
                <input
                  type="password" value={password} onChange={e => setPassword(e.target.value)} required
                  placeholder="••••••••"
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)',
                    background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 14,
                    outline: 'none', boxSizing: 'border-box'
                  }}
                />
              </div>
            )}

            <button type="submit" disabled={loading} style={{
              width: '100%', padding: '13px 0', borderRadius: 10, border: 'none',
              background: loading ? '#334155' : 'linear-gradient(135deg, #1a73e8, #0d47a1)',
              color: '#fff', fontSize: 15, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
              boxShadow: '0 4px 15px rgba(26,115,232,0.4)'
            }}>
              {loading ? 'Chargement...' : mode === 'login' ? 'Se connecter' : 'Envoyer le lien'}
            </button>
          </form>

          <div style={{ textAlign: 'center', marginTop: 20 }}>
            {mode === 'login'
              ? <button onClick={() => { setMode('reset'); setErreur(''); setMsgOk('') }}
                  style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>
                  Mot de passe oublié ?
                </button>
              : <button onClick={() => { setMode('login'); setErreur(''); setMsgOk('') }}
                  style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>
                  ← Retour à la connexion
                </button>
            }
          </div>
        </div>
      </div>
    </div>
  )
}
