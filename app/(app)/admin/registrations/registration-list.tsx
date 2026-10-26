'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import RegistrationDetailsForm from './registration-details-form'
import CancelRegistrationItem from './cancel-registration-item'
import AddRegistrationItems from './add-registration-items'
import ProxyRegistrationForm from './proxy-registration-form'

type Registration = {
  id: number
  name: string
  contact: string
  notes: string | null
  created_at: string
  event_groups: { title: string } | null
  registration_items: {
    id: number
    status: 'active' | 'cancelled'
    cancelled_at: string | null
    schedules: { title: string; date: string; start_time: string | null } | null
  }[]
}

type ListResponse = { registrations: Registration[]; page: number; pageSize: number; total: number; nextCursor: string | null }

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value))
}

export default function RegistrationList() {
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [result, setResult] = useState<ListResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Registration | null>(null)
  const [message, setMessage] = useState('')
  const [adding, setAdding] = useState<Registration | null>(null)
  const [proxyOpen, setProxyOpen] = useState(false)
  const [cursors, setCursors] = useState<string[]>([''])
  const cursor = cursors[page - 1] ?? ''

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      setResult(null)
      setError('')
      try {
        const response = await fetch(`/api/admin/registration-browser?resource=history&page=${page}&cursor=${encodeURIComponent(cursor)}`, {
          cache: 'no-store', signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(response.status === 401 ? 'ログインし直してください。' :
            response.status === 403 ? '管理者権限がありません。' : '申込一覧を取得できませんでした。')
        }
        const data: ListResponse = await response.json()
        if (!controller.signal.aborted) setResult(data)
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '申込一覧を取得できませんでした。')
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [page, reload, cursor])

  return (
    <section aria-labelledby="registrations-title" style={{ flex: 1, overflowY: 'auto', padding: '24px 20px' }}>
      <Link href="/admin/event-groups" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, color: '#6B1F2B', textUnderlineOffset: 4 }}>← 開催回管理へ</Link>
      <h1 id="registrations-title" style={{ fontSize: 22, margin: '20px 0' }}>参加申込一覧</h1>
      <p style={{ marginBottom: 16 }}>取消済みのクラスも含めて表示します。日時は日本時間です。</p>
      <button type="button" disabled={proxyOpen || editing !== null || adding !== null} onClick={() => { setMessage(''); setProxyOpen(true) }}
        style={{ padding: '8px 16px', border: '1px solid #6B1F2B', borderRadius: 8, color: '#6B1F2B', background: '#F7EEF0' }}>代理申込を登録</button>
      {' '}<button type="button" disabled={loading || proxyOpen || editing !== null || adding !== null} onClick={() => { setPage(1); setCursors(['']); setReload(value => value + 1) }}>一覧を再取得</button>
      {proxyOpen && <ProxyRegistrationForm onCancel={() => setProxyOpen(false)} onSaved={() => {
        setProxyOpen(false); setMessage('代理申込を登録しました。'); setPage(1); setCursors(['']); setReload(value => value + 1)
      }} />}
      {editing && <RegistrationDetailsForm key={editing.id} registration={editing} onCancel={() => setEditing(null)} onSaved={() => {
        setEditing(null)
        setMessage('申込者情報を更新しました。')
        setReload(value => value + 1)
      }} />}
      {message && <p role="status">{message}</p>}
      {adding && <AddRegistrationItems key={adding.id} registrationId={adding.id} participantName={adding.name} eventGroupTitle={adding.event_groups?.title ?? '講習会情報なし'}
        onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); setMessage('申込クラスを追加しました。'); setReload(value => value + 1) }} />}
      <div role="status" aria-live="polite">
        {loading && <p>読み込み中...</p>}
        {result && <p>全{result.total}件・{result.page}ページ目</p>}
      </div>
      {error && <div role="alert"><p>{error}</p><Link href="/login">ログイン画面へ</Link>{' '}<button onClick={() => setReload(value => value + 1)}>再取得</button></div>}
      {result && result.registrations.length === 0 && <p style={{ marginTop: 20 }}>表示する申込はありません。</p>}
      {result && result.registrations.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 16 }}>
          <table style={{ width: '100%', minWidth: 850, borderCollapse: 'collapse', background: '#fff' }}>
            <thead><tr>{['申込者名', '連絡先', '対象講習会', '申込クラス・状態', '申込日時', '情報編集', 'クラス追加'].map(label =>
              <th key={label} scope="col" style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid #EDE8DF' }}>{label}</th>
            )}</tr></thead>
            <tbody>{result.registrations.map(registration => (
              <tr key={registration.id} style={{ borderBottom: '1px solid #EDE8DF', verticalAlign: 'top' }}>
                <td style={{ padding: 12, overflowWrap: 'anywhere' }}>{registration.name}</td>
                <td style={{ padding: 12, overflowWrap: 'anywhere' }}>{registration.contact}</td>
                <td style={{ padding: 12 }}>{registration.event_groups?.title ?? '関連先不明'}</td>
                <td style={{ padding: 12 }}>
                  {registration.registration_items.length === 0 ? '申込クラスなし' : (
                    <ul style={{ paddingLeft: 20 }}>{registration.registration_items.map(item => (
                      <li key={item.id} style={{ marginBottom: 8 }}>
                        <div>{item.schedules?.title ?? '関連先不明'}</div>
                        {item.schedules && <div>{item.schedules.date} {item.schedules.start_time ?? ''}</div>}
                        <strong>{item.status === 'active' ? '有効' : '取消済み'}</strong>
                        {item.cancelled_at && <div>取消日時：{formatDate(item.cancelled_at)}</div>}
                        <CancelRegistrationItem itemId={item.id} status={item.status} participantName={registration.name}
                          eventGroupTitle={registration.event_groups?.title} classTitle={item.schedules?.title}
                          date={item.schedules?.date} startTime={item.schedules?.start_time} disabled={editing !== null || adding !== null || proxyOpen}
                          onCancelled={() => { setMessage('申込クラスを取り消しました。'); setReload(value => value + 1) }} />
                      </li>
                    ))}</ul>
                  )}
                </td>
                <td style={{ padding: 12, whiteSpace: 'nowrap' }}>{formatDate(registration.created_at)}</td>
                <td style={{ padding: 12 }}><button type="button" disabled={editing !== null || adding !== null || proxyOpen} onClick={() => { setMessage(''); setEditing(registration) }}
                  style={{ padding: '8px 12px', border: '1px solid #6B1F2B', borderRadius: 8, color: '#6B1F2B', background: '#F7EEF0', whiteSpace: 'nowrap' }}>情報を編集</button></td>
                <td style={{ padding: 12 }}><button type="button" disabled={editing !== null || adding !== null || proxyOpen} onClick={() => { setMessage(''); setAdding(registration) }}
                  style={{ padding: '8px 12px', border: '1px solid #6B1F2B', borderRadius: 8, color: '#6B1F2B', background: '#F7EEF0', whiteSpace: 'nowrap' }}>クラスを追加</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {result && <nav aria-label="申込一覧のページ切替" style={{ display: 'flex', gap: 16, marginTop: 20 }}>
        <button disabled={loading || editing !== null || adding !== null || proxyOpen || page <= 1} onClick={() => setPage(value => value - 1)}>前のページ</button>
        <button disabled={loading || editing !== null || adding !== null || proxyOpen || !result.nextCursor} onClick={() => { if (result.nextCursor) { setCursors(old => [...old.slice(0, page), result.nextCursor!]); setPage(value => value + 1) } }}>次のページ</button>
      </nav>}
    </section>
  )
}
