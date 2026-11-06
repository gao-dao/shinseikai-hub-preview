import TypeLabels from '../type-labels'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { loadGuideDetail } from '@/lib/event-groups/public-guide-server'
import { commonVenue, timeRange, classType } from '@/lib/event-groups/public-guide'
import styles from '../guide.module.css'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export default async function EventDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) notFound()
  let result: Awaited<ReturnType<typeof loadGuideDetail>>
  try { result = await loadGuideDetail(Number(id)) } catch {
    return <div className="hub-public-shell"><header className="hub-header"><Link href="/" className="hub-brand">心勢会HUB</Link><nav className="hub-nav" aria-label="公開メニュー"><Link href="/">ホーム</Link><Link href="/events" aria-current="page">開催案内</Link><Link href="/schedule">スケジュール</Link><Link href="/admin" prefetch={false}>管理ホーム</Link><Link href="/login">ログイン</Link></nav></header><main className={styles.page}><div className={styles.inner}><Link href="/events">← 開催案内</Link><p role="alert">開催情報を取得できませんでした。時間をおいて再度お試しください。</p></div></main></div>
  }
  if (!result) notFound()
  const { group, classes } = result
  const venue = commonVenue(classes), single = classes.length === 1 ? classes[0] : null
  const typeLabel = classType(classes)
  return <div className="hub-public-shell"><header className="hub-header"><Link href="/" className="hub-brand">心勢会HUB</Link><nav className="hub-nav" aria-label="公開メニュー"><Link href="/">ホーム</Link><Link href="/events" aria-current="page">開催案内</Link><Link href="/schedule">スケジュール</Link><Link href="/admin" prefetch={false}>管理ホーム</Link><Link href="/login">ログイン</Link></nav></header><main className={styles.page}><div className={styles.inner}>
    <nav className={styles.nav} aria-label="開催案内へ戻る"><Link href="/events">← 開催案内</Link></nav>
    <h1>{group.title}</h1>
    <p>開催日時：{single ? `${single.date} ${timeRange(single)}` : `${group.start_date}${group.end_date !== group.start_date ? `〜${group.end_date}` : ''}`}</p>
    <p>会場：{venue || (classes.length > 1 ? 'クラスごとの会場をご確認ください' : '未設定')}</p>
    {typeLabel && <p className={styles.meta}><TypeLabels label={typeLabel} /></p>}
    {!single && classes.length > 0 && <section><h2>クラス情報</h2><ul className={styles.classes}>{classes.map(row => <li key={row.id}>
      <h3>{row.title}</h3><p>{row.date} {timeRange(row)}</p>{!venue && <p>会場：{row.location || '未設定'}</p>}
    </li>)}</ul></section>}
    {group.description && <p className={styles.description}>{group.description}</p>}
    {group.participation_notes?.trim() && <section><h2>参加にあたって</h2><p className={styles.description}>{group.participation_notes}</p></section>}
    <div className={styles.participation}>
      {group.registration_open ? <p><Link href={`/events?view=registration&groupId=${group.id}`} className={styles.webLink}>Web申込ページへ</Link></p> : <p>現在、Web申込の受付は停止しています。</p>}
    </div>
  </div></main></div>
}
