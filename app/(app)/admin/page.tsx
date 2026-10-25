import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/supabase/require-admin'
import styles from './event-groups/admin-index.module.css'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const links = [
  { href: '/admin/event-groups', label: '開催回管理' },
  { href: '/admin/registrations', label: '申込者管理' },
  { href: '/admin/schedules', label: '予定管理' },
  { href: '/admin/videos', label: '動画管理' },
  { href: '/admin/event-groups/history', label: '開催記録・履歴' },
  { href: '/admin/passwords', label: 'パスワード管理' },
]

export default async function AdminPage() {
  const auth = await requireAdmin()
  if (!auth.ok) redirect(auth.status === 401 ? '/login' : '/videos')
  return <main className={styles.page}>
    <h1>管理ホーム</h1>
    <nav aria-label="管理メニュー"><ul className={styles.homeGrid}>{links.map(link =>
      <li key={link.href}><Link className={styles.homeCard} href={link.href} prefetch={false}>{link.label}</Link></li>
    )}</ul></nav>
  </main>
}
