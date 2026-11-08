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
      const label = action === 'cancel' ? '開催中止にする' : action === 'hide' ? '一覧から削除' : '一覧に戻す'
      if (!window.confirm(`「${g.title}」を${label}操作です。
確認時点の申込履歴：${current.registrationCount}件（取消済みを含む）。
申込は自動取消されません。申込者への連絡は別途必要です。
グループの受付は停止し、一覧に戻しても自動再開しません。
${action === 'cancel' ? '開催中止は解除できません。' : 'DB上のデータは削除しません。開催・申込履歴は保持され、再表示できます。'}
実行しますか？`)) return
      const result = await fetch(url, { method: 'PATCH', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, expected_state_version: g.state_version }) })
      if (!result.ok) { setError(result.status === 409 ? '他の操作で状態が変更されました。最新情報を再取得してください。' : '変更結果を確認できません。再送せず最新情報を再取得してください。'); return }
      const body = await result.json()
      if (!validLifecycle(body.eventGroup) || body.eventGroup.id !== group.id) throw Error('変更結果を確認できません。最新情報を再取得してください。')
      setMessage(`${label}操作が完了しました。受付は停止中です。`); onUpdated()
    } catch { setError('状態・変更結果を確認できません。再送せず最新情報を再取得してください。') }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <details className="occurrence-lifecycle"><summary>その他の操作</summary>
    <p>「一覧から削除」はDB上の削除ではありません。開催・申込履歴は保持され、再表示できます。中止・一覧からの削除をしても既存申込は自動取消されず、申込者への連絡は別途必要です。一覧に戻しても受付は自動再開しません。</p>
    <div className="occurrence-lifecycle-actions">
      <button data-admin-action={group.is_hidden ? 'secondary' : 'danger'} className="reception-secondary" type="button" disabled={disabled || busy} onClick={() => void change(group.is_hidden ? 'show' : 'hide')}>{group.is_hidden ? '一覧に戻す' : '一覧から削除'}</button>
      <button data-admin-action="secondary" className="reception-secondary" type="button" disabled={disabled || busy} onClick={onUpdated}>最新情報を再取得</button>
    </div>
    <div className="occurrence-cancellation">
      <h3>開催中止</h3>
      <p className="occurrence-cancellation-note"><strong>注意：</strong>{group.is_cancelled ? '開催中止済みです。中止は解除できません。' : '開催中止は元に戻せません。受付の一時停止は、通常の受付操作で行ってください。'}</p>
      <button data-admin-action="danger" className="reception-caution" type="button" disabled={disabled || busy || group.is_cancelled === true} onClick={() => void change('cancel')}>{group.is_cancelled ? '開催中止済み' : '開催中止にする'}</button>
    </div>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </details>
}
