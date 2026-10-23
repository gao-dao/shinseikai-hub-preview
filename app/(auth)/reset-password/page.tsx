'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function ResetPasswordPage() {
  const [email, setEmail] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const supabase = createClient()

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setMsg('')
    setError('')
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: new URL('/update-password', window.location.origin).href
    })
    if (error) {
      setError('エラーが発生しました: ' + error.message)
    } else {
      setMsg('パスワードリセットのメールを送信しました。メールをご確認ください。')
    }
    setLoading(false)
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#FAF7F0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Noto Sans JP', sans-serif", padding: '20px'
    }}>
      <div style={{
        width: '100%', maxWidth: '400px',
        background: '#FFFFFF', border: '1px solid #EDE8DF',
        borderRadius: '16px', padding: '48px 32px',
        boxShadow: '0 10px 40px rgba(0,0,0,.08)'
      }}>
        <h1 style={{
          fontSize: '24px', fontWeight: '700',
          color: '#1E293B', textAlign: 'center',
          letterSpacing: '0.05em', marginBottom: '8px'
        }}>心勢会HUB</h1>
        <p style={{
          color: '#6B1F2B', textAlign: 'center', fontSize: '11px',
          fontWeight: '500', letterSpacing: '0.2em', marginBottom: '32px'
        }}>Password Reset</p>

        <form onSubmit={handleReset}>
          <div style={{ marginBottom: '24px' }}>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: '700', color: '#64748B', marginBottom: '8px', textTransform: 'uppercase' }}>
              登録済みのメールアドレス
            </label>
            <input
              type="email" value={email}
              onChange={e => setEmail(e.target.value)}
              required
              style={{
                width: '100%', background: '#FFFFFF',
                border: '1px solid #EDE8DF', borderRadius: '10px',
                color: '#1E293B', fontSize: '14px', padding: '12px 14px',
                outline: 'none', boxSizing: 'border-box'
              }}
            />
          </div>
          {error && <p style={{ color: '#EF4444', fontSize: '12px', marginBottom: '16px', textAlign: 'center' }}>{error}</p>}
          {msg && <p style={{ color: '#10B981', fontSize: '12px', marginBottom: '16px', textAlign: 'center' }}>{msg}</p>}
          <button
            type="submit" disabled={loading}
            style={{
              width: '100%', padding: '14px',
              background: 'linear-gradient(135deg, #6B1F2B, #8A3041)',
              border: 'none', borderRadius: '10px',
              color: '#FFFFFF', fontWeight: '700', fontSize: '14px',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
              boxShadow: '0 4px 12px rgba(107,31,43,.2)'
            }}
          >
            {loading ? '送信中...' : 'リセットメールを送信'}
          </button>
          <p style={{ textAlign: 'center', marginTop: '24px', fontSize: '13px', color: '#94A3B8' }}>
            <a href="/login" style={{ color: '#6B1F2B', textDecoration: 'none', fontWeight: '500' }}>ログインに戻る</a>
          </p>
        </form>
      </div>
    </div>
  )
}
