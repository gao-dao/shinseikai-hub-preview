import Link from 'next/link'
import { loadScheduleIndex } from '@/lib/schedule/public-schedule'
import styles from './schedule.module.css'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function SchedulePage() {
  let items: Awaited<ReturnType<typeof loadScheduleIndex>>
  try { items = await loadScheduleIndex() } catch {
    return <main className={styles.page}><h1>スケジュール</h1><p role="alert">スケジュールを取得できませんでした。時間をおいて再度お試しください。</p></main>
  }
  return <main className={styles.page}>
    <h1>スケジュール</h1>
    {items.length === 0 ? <p>スケジュールはまだ登録されていません</p> : <ul className={styles.list}>
      {items.map(item => <li key={item.key} className={styles.item}>
        <h2>{item.href ? <Link href={item.href} prefetch={false}>{item.title}</Link> : item.title}</h2>
        <p>{item.period}</p>
        {item.place && <p>{item.place}</p>}
        <p className={styles.type}>{item.type}</p>
      </li>)}
    </ul>}
  </main>
}
