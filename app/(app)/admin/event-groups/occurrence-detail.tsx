'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { loadDetailClasses, type DetailClass } from '@/lib/event-groups/detail'
import ClassRegistrationControl from './class-registration-control'
import type { Occurrence } from '@/lib/event-groups/admin-overview'

const timeRange = (row: DetailClass) => `${row.start_time?.slice(0, 5) ?? '開始時刻未設定'}${row.end_time ? `〜${row.end_time.slice(0, 5)}` : ''}`
export default function OccurrenceDetail({ group, refreshToken = 0 }: { group: Occurrence; refreshToken?: number }) {
  const [result, setResult] = useState<{ id: number; rows: DetailClass[] } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setResult(null); setError('')
      try { const rows = await loadDetailClasses(group.id, controller.signal); if (!controller.signal.aborted) setResult({ id: group.id, rows }) }
      catch { if (!controller.signal.aborted) setError('日時・会場・クラス・申込数を取得できませんでした。管理操作の「一覧を再取得」から再取得してください。') }
    }
    void load()
    return () => controller.abort()
  }, [group.id, refreshToken])
  function refreshed(row: DetailClass) {
    setResult(current => current?.id === group.id ? { ...current, rows: current.rows.map(item => item.id === row.id ? row : item) } : current)
  }
  const rows = result?.id === group.id ? result.rows : null
  const single = rows?.length === 1 ? rows[0] : null
  const singleStatus = !single ? null : group.is_cancelled || group.is_hidden ? '受付停止（開催中止・非表示）'
    : !group.registration_open ? '受付停止（開催回全体が停止中）' : !single.registration_enabled ? '受付停止（クラス受付が停止中）'
    : single.capacity === null ? '受付不可（定員未設定）' : single.registeredCount >= single.capacity ? '受付不可（満員）' : '受付可能'
  const dates = rows ? [...new Set(rows.map(row => row.date))] : []
  const venues = rows ? [...new Set(rows.map(row => row.location))] : []
  const period = group.start_date ? group.end_date && group.end_date !== group.start_date ? `${group.start_date} 〜 ${group.end_date}` : group.start_date : dates.length === 1 ? dates[0] : dates.length > 1 ? `${dates[0]} 〜 ${dates[dates.length - 1]}` : '未設定'
  const bookings = rows?.reduce((sum, row) => sum + row.registeredCount, 0)
  return <div className="detail-reading">
    {group.is_cancelled && <p role="status"><strong>開催中止</strong>：新規申込は受け付けません。既存申込は自動取消されません。</p>}
    {group.is_hidden && <p role="status">一覧から非表示（管理者のみ閲覧可能）</p>}
    <dl className="detail-basics" aria-label="開催日時と会場"><div><dt>開催日時</dt><dd>{single ? `${single.date} ${timeRange(single)}` : period}</dd></div><div><dt>会場</dt><dd>{rows === null ? error ? '確認できません' : '確認中' : rows.length === 0 ? 'クラス未登録のため未設定' : single ? single.location || '未設定' : venues.length === 1 ? venues[0] || '未設定' : 'クラスごとに異なります（下記参照）'}</dd></div></dl>
    {group.description && <p className="detail-description">{group.description}</p>}
    {error && <p role="alert">{error}</p>}
    {!rows && !error && <p role="status">クラス・申込状況を読み込み中...</p>}
    {rows?.length === 0 && <p>クラス未登録</p>}
    {rows && rows.length > 1 && <section aria-label="クラス情報"><h2>クラス情報</h2><ol className="detail-classes">{rows.map(row => <li key={row.id}><h3>{row.title}</h3><p>{row.date} {timeRange(row)}</p>{venues.length > 1 && <p>会場：{row.location || '未設定'}</p>}<ClassRegistrationControl key={`${group.id}-${row.id}`} groupId={group.id} row={row} parentOpen={group.registration_open} onRefreshed={refreshed} /></li>)}</ol></section>}
    <section aria-label="申込状況" className="detail-applications"><h2>申込状況</h2><p>グループ全体の申込受付：<strong>{group.registration_open ? '受付中' : '停止中'}</strong></p>
      {single && <><h3>{single.title}</h3><ClassRegistrationControl key={`${group.id}-${single.id}`} groupId={group.id} row={single} parentOpen={group.registration_open} onRefreshed={refreshed} showControls={false} />
        <p>現在の公開申込：<strong>{singleStatus}</strong></p>
        <p className="detail-note">受付の開始・停止は「グループ全体の受付を開始／停止」で操作してください。</p>
        {!single.registration_enabled && <p className="single-reception-help">クラス受付が停止中です。グループ全体の受付だけを開始しても申し込めません。<Link href={`/admin/event-groups/${group.id}/edit`}>編集画面でクラス受付を変更</Link>し、「クラスの詳細設定（定員・個別日程・受付）」の「クラスの受付を有効にする」をONにして確認・保存してください。</p>}
      </>}
      {rows && rows.length > 1 && <p>有効クラス申込：{Number.isSafeInteger(bookings) ? `${bookings}件（延べ）` : '集計できません'}。同じ人の複数クラス申込を含みます。</p>}
      {!rows && <p>定員・申込数・クラス受付状態は確認できません。</p>}
      <p className="detail-note">グループ全体が停止中の場合、クラス受付が有効でも公開申込は受け付けません。</p>
    </section>
    <style>{`
      .detail-reading{font-size:16px;line-height:1.7}.detail-basics{display:grid;gap:18px;margin:0 0 24px}.detail-basics dt{color:#657078;font-size:13px}.detail-basics dd{margin:4px 0 0;font-size:20px;font-weight:600;overflow-wrap:anywhere}.detail-description{white-space:pre-wrap;overflow-wrap:anywhere}.detail-classes{padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px}.detail-classes li{border:1px solid #e7e1d8;border-radius:12px;padding:18px}.detail-classes h3{margin:0 0 10px!important}.detail-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px}.detail-stats dt,.detail-note{font-size:13px;color:#657078}.detail-stats dd{margin:2px 0 0}.detail-applications{border-top:1px solid #e7e1d8;margin-top:24px;padding-top:20px}.class-reception-count dd{font-size:24px;font-weight:700}.class-reception-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.class-reception-actions button{min-height:44px;padding:10px 16px;cursor:pointer}.class-reception-actions button:focus-visible{outline:3px solid #8a5d3b;outline-offset:3px}.class-reception-actions button:disabled{opacity:.55;cursor:default}.class-reception [role=status],.class-reception [role=alert]{overflow-wrap:anywhere}.single-reception-help a{display:inline-block;padding:8px 0;min-height:44px;box-sizing:border-box}.single-reception-help a:focus-visible{outline:3px solid #8a5d3b;outline-offset:3px}.detail-reading [role=alert]{color:#b91c1c}@media(min-width:800px){.detail-basics{grid-template-columns:1fr 1fr}}`
    }</style>
  </div>
}
