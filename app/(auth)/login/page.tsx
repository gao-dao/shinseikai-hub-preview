'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

type Role = 'member' | 'admin'

export default function LoginPage() {
  const [role, setRole] = useState<Role>('member')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const busy = useRef(false)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy.current) return
    busy.current = true
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, password }),
      })
      if (!response.ok) {
        setError(response.status === 429 ? 'しばらく待ってからログインしてください' : 'ログインできませんでした。入力内容を確認するか、時間をおいてお試しください。')
        return
      }
      const result = await response.json()
      if (result.success !== true) throw new Error('LOGIN_UNCONFIRMED')
      // A fresh document avoids reusing a browser client with an older session.
      window.location.assign('/videos')
    } catch {
      setError('ログイン結果を確認できませんでした。画面を再読み込みして確認してください。')
    } finally {
      busy.current = false
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', background: '#FFFFFF',
    border: '1px solid #EDE8DF', borderRadius: '10px',
    color: '#1E293B', fontSize: '14px', padding: '12px 14px',
    outline: 'none', boxSizing: 'border-box',
    fontFamily: "'Noto Sans JP', sans-serif",
    transition: 'border-color .2s',
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#FAF7F0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Noto Sans JP', sans-serif", padding: '20px'
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&display=swap');
        .login-card { box-shadow: 0 10px 40px rgba(0,0,0,.08); }
        .role-btn {
          flex: 1; padding: 12px 8px;
          background: #fff; border: 1px solid #EDE8DF;
          border-radius: 10px; color: #64748B;
          font-size: 13px; font-weight: 500;
          cursor: pointer; transition: all .2s;
          font-family: 'Noto Sans JP', sans-serif;
          letter-spacing: .05em;
        }
        .role-btn.active {
          background: #6B1F2B;
          border-color: #6B1F2B; color: #fff; font-weight: 700;
          box-shadow: 0 2px 8px rgba(107,31,43,.3);
        }
        .role-btn:hover:not(.active) { border-color: #6B1F2B; color: #6B1F2B; }
        .input-focus:focus { border-color: #6B1F2B !important; }
      `}</style>
      <div className="login-card" style={{
        width: '100%', maxWidth: '400px',
        background: '#FFFFFF', border: '1px solid #EDE8DF',
        borderRadius: '16px', padding: '48px 32px'
      }}>
        <h1 style={{
          fontSize: '24px', fontWeight: '700',
          color: '#1E293B', textAlign: 'center',
          letterSpacing: '0.05em', marginBottom: '8px'
        }}>心勢会HUB</h1>
        <p style={{
          color: '#6B1F2B', textAlign: 'center', fontSize: '11px',
          fontWeight: '500', letterSpacing: '0.2em', marginBottom: '40px'
        }}>SHINSEIKAI-HUB</p>

        <form onSubmit={handleLogin}>
          {/* ロール選択 */}
          <div style={{ marginBottom: '24px' }}>
            <label style={{
              display: 'block', fontSize: '11px', fontWeight: '700',
              color: '#64748B', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.1em'
            }}>ログイン種別</label>
            <div style={{ display: 'flex', gap: '10px' }}>
              {(['member', 'admin'] as Role[]).map(r => (
                <button
                  key={r}
                  type="button"
                  disabled={loading}
                  onClick={() => setRole(r)}
                  className={`role-btn${role === r ? ' active' : ''}`}
                >
                  {r === 'member' ? '会　員' : '管理者'}
                </button>
              ))}
            </div>
          </div>

          {/* パスワード */}
          <div style={{ marginBottom: '32px' }}>
            <label style={{
              display: 'block', fontSize: '11px', fontWeight: '700',
              color: '#64748B', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.1em'
            }}>パスワード</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder="パスワードを入力"
              style={inputStyle}
              className="input-focus"
            />
          </div>

          {error && (
            <p style={{
              color: '#6B1F2B', fontSize: '12px', fontWeight: '500',
              marginBottom: '20px', textAlign: 'center'
            }}>{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '14px',
              background: 'linear-gradient(135deg, #6B1F2B, #8A3041)',
              border: 'none', borderRadius: '10px',
              color: '#FFFFFF', fontWeight: '700', fontSize: '14px',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1, letterSpacing: '0.05em',
              boxShadow: '0 4px 12px rgba(107,31,43,.2)'
            }}
          >
            {loading ? 'ログイン中...' : 'ログイン'}
          </button>

          <div style={{ textAlign: 'center', marginTop: '32px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <button
              type="button"
              onClick={() => router.push('/schedule')}
              style={{
                background: '#FAF7F0', border: '1px solid #EDE8DF', borderRadius: '10px',
                color: '#64748B', padding: '12px', fontSize: '13px', cursor: 'pointer',
                fontFamily: "'Noto Sans JP', sans-serif", fontWeight: '500',
                transition: 'all .2s'
              }}
              onMouseOver={e => { e.currentTarget.style.borderColor = '#6B1F2B'; e.currentTarget.style.color = '#6B1F2B'; }}
              onMouseOut={e => { e.currentTarget.style.borderColor = '#EDE8DF'; e.currentTarget.style.color = '#64748B'; }}
            >
              🗓️ ログインせずにスケジュールを見る
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
