'use client'
import { useRef, useState } from 'react'
import { validLifecycle } from '@/lib/event-groups/lifecycle'
export default function OccurrenceState({ group, disabled = false, onUpdated }: { group: { id: number; title: string; is_cancelled?: boolean; is_hidden?: boolean; registration_open: boolean; state_version?: number }; disabled?: boolean; onUpdated(): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const inFlight = useRef(false)
  async function change(action: 'cancel' | 'hide' | 'show') {
    if (disabled || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const url = `/api/admin/event-groups/${group.id}/state`
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw Error('状態・申込履歴を確認できないため操作できません。')
      const current = await response.json(), g = current.eventGroup
      if (!validLifecycle(g) || g.id !== group.id || typeof g.title !== 'string' || !Number.isSafeInteger(current.registrationCount) || current.registrationCount < 0) throw Error('状態・申込履歴を確認できないため操作できません。')
      const label = action === 'cancel' ? '開催中止にする' : action === 'hide' ? '一覧から非表示にする' : '一覧に再表示する'
      if (!window.confirm(`「${g.title}」を${label}操作です。
確認時点の申込履歴：${current.registrationCount}件（取消済みを含む）。
申込は自動取消されません。申込者への連絡は別途必要です。
グループの受付は停止し、再表示しても自動再開しません。
${action === 'cancel' ? '開催中止は解除できません。' : ''}
実行しますか？`)) return
      const result = await fetch(url, { method: 'PATCH', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, expected_state_version: g.state_version }) })
      if (!result.ok) { setError(result.status === 409 ? '他の操作で状態が変更されました。最新情報を再取得してください。' : '変更結果を確認できません。再送せず最新情報を再取得してください。'); return }
      const body = await result.json()
      if (!validLifecycle(body.eventGroup) || body.eventGroup.id !== group.id) throw Error('変更結果を確認できません。最新情報を再取得してください。')
      setMessage(`${label}操作が完了しました。受付は停止中です。`); onUpdated()
    } catch { setError('状態・変更結果を確認できません。再送せず最新情報を再取得してください。') }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <details><summary>その他の操作</summary>
    <p>申込・取消履歴は保持します。中止・非表示にしても既存申込は自動取消されず、申込者への連絡は別途必要です。</p>
    <button type="button" disabled={disabled || busy || group.is_cancelled === true} onClick={() => void change('cancel')}>開催中止にする</button>
    <button type="button" disabled={disabled || busy} onClick={() => void change(group.is_hidden ? 'show' : 'hide')}>{group.is_hidden ? '一覧に再表示する' : '一覧から非表示にする'}</button>
    <button type="button" disabled={disabled || busy} onClick={onUpdated}>最新情報を再取得</button>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </details>
}
