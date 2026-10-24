'use client'

import { occurrencePhase, tokyoDay } from '@/lib/event-groups/presentation'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { loadOccurrencePage, loadClassSummary, type Occurrence, type ClassSummary } from '@/lib/event-groups/admin-overview'

export default function OccurrenceList() {
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [data, setData] = useState<{ eventGroups: Occurrence[]; total: number; pageSize: number } | null>(null)
  const [summaries, setSummaries] = useState<Record<number, ClassSummary | 'error'>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [today, setToday] = useState(() => tokyoDay())
  useEffect(() => {
    const timer = setInterval(() => setToday(tokyoDay()), 30000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true); setError(''); setData(null); setSummaries({})
      try {
        const result = await loadOccurrencePage(page, controller.signal)
        if (controller.signal.aborted) return
        setData(result); setLoading(false)
        // Bound parallel requests; fetch every class page before showing totals.
        let index = 0
        await Promise.all(Array.from({ length: Math.min(4, result.eventGroups.length) }, async () => {
          while (index < result.eventGroups.length && !controller.signal.aborted) {
            const group = result.eventGroups[index++]
            try {
              const summary = await loadClassSummary(group.id, controller.signal)
              if (!controller.signal.aborted) setSummaries(old => ({ ...old, [group.id]: summary }))
            } catch { if (!controller.signal.aborted) setSummaries(old => ({ ...old, [group.id]: 'error' })) }
          }
        }))
      } catch { if (!controller.signal.aborted) setError('開催回を取得できませんでした。ログイン状態を確認し、再取得してください。') }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load(); return () => controller.abort()
  }, [page, reload])
  return <main className="occurrence-page">
    <header><div><p className="eyebrow">開催・募集・参加者をまとめて管理</p><h1>開催回一覧</h1></div>
      <Link className="primary" href="/admin/event-groups/new">＋ 開催回を作成</Link></header>
    <nav aria-label="管理メニュー"><strong>開催回</strong><Link href="/admin/schedules">予定管理</Link><Link href="/admin/videos">動画管理</Link><Link href="/admin/passwords">パスワード管理</Link><Link href="/admin/registrations">全開催回の申込一覧</Link></nav>
    <div className="toolbar"><p>開催回を選ぶと、基本情報・クラス・受付操作を確認できます。</p><button disabled={loading} onClick={() => setReload(v => v + 1)}>一覧を再取得</button></div>
    <p className="note">申込状況は取得時点の有効クラス申込の延べ件数です。同じ人の複数クラス申込を含み、申込者数ではありません。</p>
    {loading && <p role="status">開催回を読み込み中...</p>}
    {error && <p role="alert">{error}</p>}
    {data?.total === 0 && <p>開催回はまだありません。「開催回を作成」から登録してください。</p>}
    <p className="note">日本時間の最終開催日の翌日から開催終了に分類します。分類はこのページ内の開催回が対象です。受付状態は変更しません。</p>
    {(['upcoming', 'unknown', 'ended'] as const).map(phase => <section key={phase} aria-label={phase === 'upcoming' ? '開催予定' : phase === 'ended' ? '開催終了' : '日付未設定・要確認'}>
    <h2>{phase === 'upcoming' ? '開催予定' : phase === 'ended' ? '開催終了' : '日付未設定・要確認'}</h2>
    <div className="cards">{data?.eventGroups.filter(group => { const summary = summaries[group.id]; return occurrencePhase(group, summary && summary !== 'error' ? summary.classDates : undefined, today) === phase }).map(group => {
      const summary = summaries[group.id]
      return <article key={group.id} className="occurrence-card">
        {phase === 'unknown' && <p className="note">日付未設定、開催期間との不整合、またはクラス日付の確認待ちです。詳細で確認してください。</p>}
        <span className={group.registration_open ? 'badge open' : 'badge'}>{group.registration_open ? '募集中' : '受付停止中'}</span>
        <h2><Link href={`/admin/event-groups/${group.id}`}>{group.title}</Link></h2>
        <dl><div><dt>開催日</dt><dd>{group.start_date ? group.end_date && group.end_date !== group.start_date ? `${group.start_date} 〜 ${group.end_date}` : group.start_date : '未設定'}</dd></div>
          <div><dt>開催地</dt><dd>{group.city ?? '未設定'}</dd></div>
          <div><dt>クラス数</dt><dd>{summary === 'error' ? '取得できません' : summary ? `${summary.classCount}クラス` : '確認中'}</dd></div>
          <div><dt>申込状況</dt><dd>{summary === 'error' ? '取得できません' : summary ? `有効クラス申込 ${summary.activeClassBookings}件（延べ）` : '確認中'}</dd></div></dl>
        <Link className="detail" href={`/admin/event-groups/${group.id}`}>開催回の詳細へ →</Link>
      </article>
    })}</div></section>)}
    {data && <nav aria-label="開催回のページ切替"><button disabled={loading || page <= 1} onClick={() => setPage(v => v - 1)}>前のページ</button><span>全{data.total}件・{page}ページ目</span><button disabled={loading || page * data.pageSize >= data.total} onClick={() => setPage(v => v + 1)}>次のページ</button></nav>}
    <style jsx>{`
      .occurrence-page{flex:1;overflow-y:auto;padding:32px;max-width:1200px;width:100%;margin:auto;color:#29353b}header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:24px}h1{font-size:28px;margin:4px 0}.eyebrow,.note{color:#657078;font-size:13px}.primary{background:#6b1f2b;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;white-space:nowrap}nav{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:14px 0}nav a{color:#6b1f2b}.toolbar{display:flex;gap:12px;align-items:center;justify-content:space-between}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:20px 0}.occurrence-card{background:white;border:1px solid #e7e1d8;border-radius:16px;padding:24px}h2{font-size:20px;overflow-wrap:anywhere}h2 a,.detail{color:#6b1f2b}.badge{font-size:12px;background:#edf0f1;border-radius:20px;padding:5px 12px}.badge.open{background:#e6f3eb;color:#256446}dl div{display:grid;grid-template-columns:85px 1fr;gap:10px;margin:12px 0}dt{color:#657078;font-size:13px}dd{margin:0;overflow-wrap:anywhere}button{border:1px solid #d9d2c8;border-radius:8px;background:white;padding:10px 14px;font:inherit;cursor:pointer}button:disabled{opacity:.5}a:focus-visible,button:focus-visible{outline:3px solid #b48538;outline-offset:3px}@media(max-width:640px){.occurrence-page{padding:20px 16px}header,.toolbar{align-items:stretch;flex-direction:column}.cards{grid-template-columns:1fr}.primary{text-align:center}.occurrence-card{padding:20px}nav{gap:14px;font-size:14px}}
    `}</style>
  </main>
}
