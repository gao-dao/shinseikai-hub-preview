import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/supabase/require-admin'
import styles from './event-groups/admin-index.module.css'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const links = [
  { href: '/admin/event-groups', label: '開催回管理', description: '開催回の作成・編集と受付管理', icon: 'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Zm2 10h3m4 0h3m-10 4h3' },
  { href: '/admin/registrations', label: '申込者管理', description: '申込者情報と申込状況を確認', icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z' },
  { href: '/admin/videos', label: '動画管理', description: '動画の追加・編集', icon: 'm10 8 6 4-6 4V8ZM5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z' },
  { href: '/admin/event-groups/history', label: '開催履歴', description: '終了・中止・非表示の開催回を確認', icon: 'M3 11a9 9 0 1 1 2.6 7M3 4v7h7m2-5v6l4 2' },
  { href: '/admin/passwords', label: 'パスワード管理', description: '管理者・会員のパスワードを管理', icon: 'M7 14a5 5 0 1 1 4.9-6H22v4h-3v3h-4l-3.1-3A5 5 0 0 1 7 14ZM7 8h.01' },
]
const publicLinks = [
  { href: '/events', label: '開催案内' },
  { href: '/schedule', label: 'スケジュール' },
  { href: '/videos', label: '動画ライブラリ' },
]

export default async function AdminPage() {
  const auth = await requireAdmin()
  if (!auth.ok) redirect(auth.status === 401 ? '/login' : '/videos')
  return <main className={styles.page}>
    <header className={styles.homeHeader}>
      <div><p className={styles.homeBrand}>心勢会HUB</p><h1 className={styles.homeTitle}>管理ホーム</h1></div>
      <span className={styles.homeRole}>管理者</span>
    </header>
    <nav aria-label="管理メニュー"><ul className={styles.homeGrid}>{links.map(link =>
      <li key={link.href}><Link className={styles.homeCard} href={link.href} prefetch={false}>
        <svg className={styles.homeIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={link.icon} /></svg>
        <span className={styles.homeCardText}><strong>{link.label}</strong><span>{link.description}</span></span>
        <span className={styles.homeArrow} aria-hidden="true">→</span>
      </Link></li>
    )}</ul></nav>
    <section className={styles.homePublic} aria-labelledby="admin-public-title">
      <h2 id="admin-public-title" className={styles.homePublicTitle}>公開ページ</h2>
      <nav className={styles.homePublicLinks} aria-label="公開ページ">{publicLinks.map(link =>
        <Link key={link.href} href={link.href} prefetch={false}>{link.label}</Link>
      )}</nav>
    </section>
  </main>
}
