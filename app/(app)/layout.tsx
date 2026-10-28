'use client'
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const supabase = useMemo(() => createClient(), [])
  const [session, setSession] = useState<{ checked: boolean; logged: boolean; admin: boolean }>({ checked: false, logged: false, admin: false })
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setSession({ checked: false, logged: false, admin: false })
    async function check() {
      try {
        const { data: { user }, error } = await supabase.auth.getUser()
        if (!user || error) {
          if (active) setSession({ checked: true, logged: false, admin: false })
          return
        }
        const { data: profile, error: profileError } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
        if (active) setSession({ checked: true, logged: true, admin: !profileError && profile?.role === 'admin' })
      } catch {
        if (active) setSession({ checked: true, logged: false, admin: false })
      }
    }
    void check()
    return () => { active = false }
  }, [pathname, supabase])

  async function logout() {
    if (signingOut) return
    setSigningOut(true)
    setError('')
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' })
      if (error) throw error
      router.push('/login')
    } catch {
      setError('ログアウトできませんでした。時間をおいてお試しください。')
    } finally { setSigningOut(false) }
  }
  const links = [
    { href: '/', label: 'ホーム' },
    { href: '/events', label: '開催案内' },
    { href: '/schedule', label: 'スケジュール' },
    ...(session.logged ? [{ href: '/videos', label: '動画ライブラリ' }] : []),
    ...(session.admin ? [{ href: '/admin', label: '管理ホーム' }] : []),
  ]
  return <>
    <style>{`
      * { box-sizing: border-box; }
      html, body { height: 100%; background: #FAF7F0; color: #1E293B; }
      .hub-shell { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
      .hub-content { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
      .hub-error { color: #6b1f2b; padding: 8px 24px; font-size: 13px; }
    `}</style>
    <div className="hub-shell">
      <header className="hub-header">
        <Link href="/" className="hub-brand">心勢会HUB</Link>
        <nav className="hub-nav" aria-label={session.admin ? '管理者メニュー' : session.logged ? '会員メニュー' : '公開メニュー'}>
          {links.map(link => <Link key={link.href} href={link.href} aria-current={(pathname === link.href) ? 'page' : undefined}>{link.label}</Link>)}
          {session.checked && (session.logged
            ? <button type="button" disabled={signingOut} onClick={logout}>{signingOut ? 'ログアウト中…' : 'ログアウト'}</button>
            : <Link href="/login">ログイン →</Link>)}
        </nav>
      </header>
      {error && <p className="hub-error" role="alert">{error}</p>}
      <div className="hub-content">{children}</div>
    </div>
  </>
}
