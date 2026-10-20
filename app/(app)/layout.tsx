'use client'
import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'


const tabs = [
  { id: 'videos', icon: '▶', label: '動画ライブラリ', path: '/videos' },
  { id: 'schedule', icon: '📅', label: 'スケジュール', path: '/schedule' },
  { id: 'admin', icon: '⚙️', label: '管理パネル', path: '/admin' },
]

const titles: Record<string, string> = {
  '/videos': '動画ライブラリ',
  '/schedule': 'スケジュール',
  '/admin': '管理パネル',
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const supabase = createClient()
  const [isLogged, setIsLogged] = useState(false)
  const [userChecked, setUserChecked] = useState(false)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setIsLogged(!!user)
      setUserChecked(true)
    })
  }, [pathname, supabase])

  const handleAuth = async () => {
    if (isLogged) {
      await supabase.auth.signOut({ scope: 'local' })
    }
    router.push('/login')
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; background: #FAF7F0; color: #1E293B; font-family: 'Noto Sans JP', sans-serif; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #e2d9cc; border-radius: 4px; }
        .shell { display: flex; height: 100vh; height: 100dvh; overflow: hidden; }
        .sidebar { width: 220px; min-width: 220px; background: #fff; border-right: 1px solid #EDE8DF; display: flex; flex-direction: column; position: relative; overflow: hidden; box-shadow: 2px 0 8px rgba(0,0,0,.04); }
        .sidebar::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, #6B1F2B, #8A3041); }
        .logo { padding: 22px 20px 18px; border-bottom: 1px solid #EDE8DF; }
        .logo-kanji { font-size: 18px; font-weight: 700; color: #1E293B; letter-spacing: .08em; }
        .logo-en { font-size: 9px; color: #6B1F2B; letter-spacing: .3em; margin-top: 3px; font-weight: 500; }
        .snav { padding: 14px 0; flex: 1; }
        .snav-item { display: flex; align-items: center; gap: 12px; padding: 11px 20px; cursor: pointer; font-size: 12px; color: #64748B; border-left: 3px solid transparent; transition: all .18s; letter-spacing: .05em; }
        .snav-item:hover { color: #1E293B; background: #FAF7F0; }
        .snav-item.act { color: #6B1F2B; border-left-color: #6B1F2B; background: #F7EEF0; font-weight: 700; }
        .logout-btn { margin: 12px 16px; padding: 8px; background: transparent; border: 1px solid #EDE8DF; border-radius: 8px; color: #94A3B8; font-size: 11px; cursor: pointer; transition: all .18s; }
        .logout-btn:hover { color: #6B1F2B; border-color: #6B1F2B; background: #F7EEF0; }
        .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
        .topbar { height: 52px; padding: 0 20px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; background: #fff; border-bottom: 1px solid #EDE8DF; box-shadow: 0 1px 4px rgba(0,0,0,.04); }
        .topbar-ttl { font-size: 14px; font-weight: 700; color: #1E293B; letter-spacing: .08em; }
        .content { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
        .bnav { display: none; background: #fff; border-top: 1px solid #EDE8DF; flex-shrink: 0; position: relative; box-shadow: 0 -2px 8px rgba(0,0,0,.04); }
        .bnav::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, #6B1F2B, #8A3041); }
        .bnav-inner { display: flex; height: 60px; }
        .bitem { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; cursor: pointer; color: #94A3B8; font-size: 9px; letter-spacing: .06em; transition: color .18s; -webkit-tap-highlight-color: transparent; }
        .bitem.act { color: #6B1F2B; }
        .bico { font-size: 20px; line-height: 1; }
        .topbar-logout { background: transparent; border: 1px solid #EDE8DF; border-radius: 6px; color: #94A3B8; font-size: 10px; padding: 5px 10px; cursor: pointer; transition: all .18s; display: none; }
        .topbar-logout:hover { color: #6B1F2B; border-color: #6B1F2B; }
        @media(max-width:640px) { 
          .sidebar { display: none !important; } 
          .bnav { display: block; } 
          .topbar { padding: 0 14px; } 
          .topbar-logout { display: block; }
        }
        @supports(padding-bottom:env(safe-area-inset-bottom)) { .bnav { padding-bottom: env(safe-area-inset-bottom); } }
      `}</style>
      <div className="shell">
        <aside className="sidebar">
          <div className="logo">
            <div className="logo-kanji">心勢会HUB</div>
            <div className="logo-en">SHINSEIKAI-HUB</div>
          </div>
          <nav className="snav">
            {tabs.map(t => (
              <div key={t.id} className={`snav-item${pathname === t.path ? ' act' : ''}`}
                onClick={() => router.push(t.path)}>
                <span style={{ fontSize: '15px', width: '18px', textAlign: 'center' }}>{t.icon}</span>
                {t.label}
              </div>
            ))}
          </nav>
          {userChecked && (
            <button className="logout-btn" onClick={handleAuth}>{isLogged ? 'ログアウト' : 'ログイン'}</button>
          )}
        </aside>
        <div className="main">
          <div className="topbar">
            <div className="topbar-ttl">{titles[pathname] || '心勢会HUB'}</div>
            {userChecked && (
              <button className="topbar-logout" onClick={handleAuth}>{isLogged ? 'ログアウト' : 'ログイン'}</button>
            )}
          </div>
          <div className="content">{children}</div>
          <div className="bnav">
            <div className="bnav-inner">
              {tabs.map(t => (
                <div key={t.id} className={`bitem${pathname === t.path ? ' act' : ''}`}
                  onClick={() => router.push(t.path)}>
                  <span className="bico">{t.icon}</span>
                  <span>{t.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
