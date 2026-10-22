'use client'

import { useEffect, useState } from 'react'

type ClassItem = {
  id: number; title: string; date: string; start_time: string | null; end_time: string | null
  location: string; capacity: number | null; registeredCount: number; registration_enabled: boolean
}
type ClassPage = { schedules: ClassItem[]; page: number; pageSize: number; total: number }
function validClass(value: unknown): value is ClassItem {
  if (!value || typeof value !== 'object') return false
  const row = value as ClassItem
  return Number.isSafeInteger(row.id) && row.id > 0 &&
    typeof row.title === 'string' && typeof row.date === 'string' && typeof row.location === 'string' &&
    (row.start_time === null || typeof row.start_time === 'string') &&
    (row.end_time === null || typeof row.end_time === 'string') &&
    (row.capacity === null || (Number.isSafeInteger(row.capacity) && row.capacity > 0)) &&
    Number.isSafeInteger(row.registeredCount) && row.registeredCount >= 0 && typeof row.registration_enabled === 'boolean'
}

export default function GroupClasses({ groupId, refreshToken = 0 }: { groupId: number; refreshToken?: number }) {
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [result, setResult] = useState<ClassPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const regionId = `group-classes-${groupId}`
  useEffect(() => {
    if (!expanded) return
    const controller = new AbortController()
    async function load() {
      setLoading(true); setResult(null); setError('')
      try {
        const response = await fetch(`/api/admin/event-groups/${groupId}/classes?page=${page}`, { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error('Classes unavailable')
        const data: ClassPage = await response.json()
        if (!Array.isArray(data.schedules) || !data.schedules.every(validClass) ||
            new Set(data.schedules.map(item => item.id)).size !== data.schedules.length ||
            data.page !== page || !Number.isSafeInteger(data.pageSize) || data.pageSize <= 0 ||
            !Number.isSafeInteger(data.total) || data.total < 0 || data.schedules.length > data.pageSize ||
            data.schedules.length !== Math.min(data.pageSize, Math.max(data.total - (page - 1) * data.pageSize, 0))) throw new Error('Invalid class metadata')
        if (!controller.signal.aborted) setResult(data)
      } catch {
        if (!controller.signal.aborted) setError('所属クラスを取得できませんでした。申込数・受付状態は確認できません。再取得してください。')
      } finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [expanded, groupId, page, reload, refreshToken])

  return <div style={{ marginTop: 12 }}>
    <button type="button" aria-expanded={expanded} aria-controls={regionId}
      onClick={() => { setResult(null); setError(''); setExpanded(value => !value) }}>
      {expanded ? '所属クラス一覧を閉じる' : '所属クラス一覧を表示'}
    </button>
    {expanded && <section id={regionId} aria-label="所属クラス一覧">
      <p>以下はクラス単位の受付設定です。グループ全体が停止中の場合、クラスが有効でも公開申込は受け付けません。</p>
      {loading && <p role="status">所属クラスを読み込み中...</p>}
      {error && <p role="alert">{error}</p>}
      {result && result.total === 0 && <p>クラス未登録</p>}
      {result && <>
        <ul>{result.schedules.map(item => <li key={item.id}>
          <h3>{item.title}</h3>
          <p>日時：{item.date} {item.start_time ?? '未設定'}〜{item.end_time ?? '未設定'}</p>
          <p>会場：{item.location || '未設定'}</p>
          <p>定員：{item.capacity === null ? '未設定' : `${item.capacity}名`} ／ 有効申込数：{item.registeredCount}件</p>
          <p>クラス受付：{item.registration_enabled ? '有効' : '無効'}</p>
        </li>)}</ul>
        <p>全{result.total}クラス・{result.page}ページ目</p>
        <button type="button" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>前のクラス</button>
        <button type="button" disabled={loading || page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>次のクラス</button>
      </>}
      <button type="button" disabled={loading} onClick={() => { setResult(null); setError(''); setReload(value => value + 1) }}>所属クラスを再取得</button>
    </section>}
  </div>
}
