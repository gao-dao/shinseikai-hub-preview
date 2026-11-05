import Link from 'next/link'
import styles from './event-groups/admin-index.module.css'

const links = [
  { href: '/admin', label: '管理ホーム' },
  { href: '/admin/event-groups', label: '開催回管理' },
  { href: '/admin/registrations', label: '申込者管理' },
  { href: '/admin/videos', label: '動画管理' },
  { href: '/admin/event-groups/history', label: '開催履歴' },
  { href: '/admin/passwords', label: 'パスワード管理' },
] as const

// Presentation only. The existing app layout gates visibility by verified role;
// every administrative page retains its own server-side authorization.
export default function AdminNavigation({ pathname }: { pathname: string }) {
  const active = [...links].sort((a, b) => b.href.length - a.href.length)
    .find(link => pathname === link.href || pathname.startsWith(`${link.href}/`))?.href
  return <nav className={`${styles.nav} ${styles.adminNav}`} aria-label="管理画面メニュー">
    {links.map(link => <Link key={link.href} href={link.href} prefetch={false} aria-current={active === link.href ? 'page' : undefined}>{link.label}</Link>)}
  </nav>
}
