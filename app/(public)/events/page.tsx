import type { Metadata } from 'next'
import Link from 'next/link'
import EventsList from './events-list'
import { loadGuidePage, loadGuideDetail } from '@/lib/event-groups/public-guide-server'
import { guidePage } from '@/lib/event-groups/public-guide'
import styles from './guide.module.css'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const metadata: Metadata = { title: '開催案内 | 心勢会HUB' }
export default async function EventsPage({ searchParams }: { searchParams: Promise<{ page?: string; view?: string; groupId?: string | string[] }> }) {
  const params = await searchParams
  // Preserve the existing registration UI and APIs without coupling announcement visibility to reception.
  if (params.view === 'registration') {
    if (params.groupId === undefined) return <EventsList key="list" />
    let target: Awaited<ReturnType<typeof loadGuideDetail>> = null
    let message = '指定された開催回はWeb申込を受け付けていないか、公開されていません。'
    if (typeof params.groupId === 'string' && /^[1-9][0-9]*$/.test(params.groupId) && Number.isSafeInteger(Number(params.groupId))) {
      try { target = await loadGuideDetail(Number(params.groupId)) }
      catch { message = '開催情報を確認できませんでした。時間をおいて再度お試しください。' }
    }
    if (target?.group.registration_open === true) {
      const { id, title, description } = target.group
      return <EventsList key={id} initialGroup={{ id, title, description }} />
    }
    return <main className={styles.page}><div className={styles.inner}><h1>Web申込</h1><p role="alert">{message}</p><Link href="/events?view=registration">Web申込一覧へ</Link>{' ／ '}<Link href="/events">開催案内へ</Link></div></main>
  }
  let result: Awaited<ReturnType<typeof loadGuidePage>> | null = null
  let error = ''
  try { result = await loadGuidePage(guidePage(params.page)) } catch { error = '開催案内を取得できませんでした。時間をおいて再度お試しください。' }
  return <div className="hub-public-shell"><header className="hub-header"><Link href="/" className="hub-brand">心勢会HUB</Link><nav className="hub-nav" aria-label="公開メニュー"><Link href="/">ホーム</Link><Link href="/events" aria-current="page">開催案内</Link><Link href="/schedule">スケジュール</Link><Link href="/admin" prefetch={false}>管理ホーム</Link><Link href="/login">ログイン</Link></nav></header><main className={styles.page}><div className={`${styles.inner} ${styles.listing}`}>
    <h1>開催案内</h1>
    {error && <p role="alert">{error}</p>}
    {result && <>
      {result.items.length === 0 && <p>掲載中の開催案内はありません。</p>}
      <ul className={styles.list}>{result.items.map(group => <li key={group.id}><Link className={styles.item} href={`/events/${group.id}`}>
        <h2>{group.title} →</h2><span className={styles.date}>{group.start_date}{group.end_date !== group.start_date ? `〜${group.end_date}` : ''}</span>
        <span className={styles.meta}>地域：{group.city || '未設定'}{group.classCount > 1 ? ` ／ ${group.classCount}クラス` : ''}</span>
      </Link></li>)}</ul>
      <nav className={styles.pagination} aria-label="開催案内のページ切替">
        {result.page > 1 && <Link href={`/events?page=${result.page - 1}`}>← 前へ</Link>}
        {result.hasNext && <Link href={`/events?page=${result.page + 1}`}>次へ →</Link>}
      </nav>
    </>}
  </div></main></div>
}
