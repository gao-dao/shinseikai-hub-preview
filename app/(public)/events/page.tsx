import type { Metadata } from 'next'
import Link from 'next/link'
import EventsList from './events-list'
import { loadGuidePage } from '@/lib/event-groups/public-guide-server'
import { guidePage } from '@/lib/event-groups/public-guide'
import styles from './guide.module.css'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const metadata: Metadata = { title: '開催案内 | 心勢会HUB' }
export default async function EventsPage({ searchParams }: { searchParams: Promise<{ page?: string; view?: string }> }) {
  const params = await searchParams
  // Preserve the existing registration UI and APIs without coupling announcement visibility to reception.
  if (params.view === 'registration') return <EventsList />
  let result: Awaited<ReturnType<typeof loadGuidePage>> | null = null
  let error = ''
  try { result = await loadGuidePage(guidePage(params.page)) } catch { error = '開催案内を取得できませんでした。時間をおいて再度お試しください。' }
  return <main className={styles.page}><div className={styles.inner}>
    <nav className={styles.nav} aria-label="公開メニュー"><Link href="/">ホーム</Link><Link href="/schedule">従来のスケジュール →</Link><Link href="/login">ログイン →</Link></nav>
    <h1>開催案内</h1>
    {error && <p role="alert">{error}</p>}
    {result && <>
      {result.items.length === 0 && <p>掲載中の開催案内はありません。</p>}
      <ul className={styles.list}>{result.items.map(group => <li key={group.id}><Link className={styles.item} href={`/events/${group.id}`}>
        <strong>{group.title} →</strong><span>{group.start_date}{group.end_date !== group.start_date ? `〜${group.end_date}` : ''}</span>
        <span>地域：{group.city || '未設定'}{group.classCount > 1 ? ` ／ ${group.classCount}クラス` : ''}</span>
      </Link></li>)}</ul>
      <nav className={styles.pagination} aria-label="開催案内のページ切替">
        {result.page > 1 && <Link href={`/events?page=${result.page - 1}`}>← 前へ</Link>}
        {result.hasNext && <Link href={`/events?page=${result.page + 1}`}>次へ →</Link>}
      </nav>
    </>}
    <p><Link href="/events?view=registration">既存のWeb申込ページ →</Link></p>
  </div></main>
}
