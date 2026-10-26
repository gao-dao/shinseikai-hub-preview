import Link from 'next/link'
import { notFound } from 'next/navigation'
import { loadGuideDetail } from '@/lib/event-groups/public-guide-server'
import { commonVenue, timeRange } from '@/lib/event-groups/public-guide'
import styles from '../guide.module.css'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export default async function EventDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) notFound()
  let result: Awaited<ReturnType<typeof loadGuideDetail>>
  try { result = await loadGuideDetail(Number(id)) } catch {
    return <main className={styles.page}><div className={styles.inner}><Link href="/events">← 開催案内</Link><p role="alert">開催情報を取得できませんでした。時間をおいて再度お試しください。</p></div></main>
  }
  if (!result) notFound()
  const { group, classes } = result
  const venue = commonVenue(classes), single = classes.length === 1 ? classes[0] : null
  return <main className={styles.page}><div className={styles.inner}>
    <nav className={styles.nav}><Link href="/events">← 開催案内</Link><Link href="/">ホーム</Link></nav>
    <h1>{group.title}</h1>
    <p>開催日時：{single ? `${single.date} ${timeRange(single)}` : `${group.start_date}${group.end_date !== group.start_date ? `〜${group.end_date}` : ''}`}</p>
    <p>会場：{venue || (classes.length > 1 ? 'クラスごとの会場をご確認ください' : '未設定')}</p>
    {!single && classes.length > 0 && <section><h2>クラス情報</h2><ul className={styles.classes}>{classes.map(row => <li key={row.id}>
      <h3>{row.title}</h3><p>{row.date} {timeRange(row)}</p>{!venue && <p>会場：{row.location || '未設定'}</p>}
    </li>)}</ul></section>}
    {group.description && <p className={styles.description}>{group.description}</p>}
    <section className={styles.participation}><h2>参加方法</h2>
      <p>参加希望・お問い合わせの連絡先は、主催者の案内をご確認ください。お問い合わせのみで参加確定とはなりません。</p>
      {group.registration_open ? <p><Link href={`/events?view=registration&groupId=${group.id}`}>Web申込の受付状況を確認する →</Link></p> : <p>現在、Web申込の受付は停止しています。</p>}
    </section>
  </div></main>
}
