'use client'

import { useRef, useState } from 'react'

type Props = {
  itemId: number
  status: 'active' | 'cancelled'
  participantName: string
  eventGroupTitle?: string
  classTitle?: string
  date?: string
  startTime?: string | null
  disabled?: boolean
  onCancelled: () => void
}

export default function CancelRegistrationItem({ itemId, status, participantName, eventGroupTitle, classTitle, date, startTime, disabled, onCancelled }: Props) {
  const [busy, setBusy] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const knownTarget = !!participantName.trim() && !!eventGroupTitle?.trim() && !!classTitle?.trim()

  async function cancel() {
    if (disabled || status !== 'active' || !knownTarget || completed || inFlight.current) return
    inFlight.current = true
    let succeeded = false
    setError('')
    try {
      if (!window.confirm(`次のクラスへの申込を取り消しますか？\n参加者：${participantName}\n講習会：${eventGroupTitle}\nクラス：${classTitle}\n日時：${date ?? '不明'} ${startTime ?? ''}\n申込明細ID：${itemId}\n他のクラスの申込は変更されません。取消履歴は残ります。`)) return
      setBusy(true)
      const response = await fetch(`/api/admin/registration-items/${itemId}/cancel`, { method: 'POST', cache: 'no-store' })
      if (!response.ok) {
        const message = response.status === 401 ? 'ログインし直してください。' : response.status === 403 ? '管理者権限またはリクエスト元を確認してください。'
          : response.status === 404 ? '申込明細が見つかりません。一覧を再取得してください。'
          : response.status === 409 ? '取消済み、または別の操作で状態が変わっています。一覧を再取得してください。'
          : '申込クラスを取り消せませんでした。'
        setError(message)
        return
      }
      const result = await response.json()
      if (result.success !== true) { setError('取消結果を確認できませんでした。一覧を再取得してください。'); return }
      setCompleted(true)
      succeeded = true
      // Keep the guard locked until the refreshed list replaces this row.
      onCancelled()
    } catch {
      setError('取消結果を確認できませんでした。一覧を再取得してから再操作してください。')
    } finally {
      if (!succeeded) inFlight.current = false
      setBusy(false)
    }
  }

  if (status !== 'active') return null
  return <div style={{ marginTop: 8 }}>
    <button type="button" disabled={disabled || busy || completed || !knownTarget} onClick={cancel}
      aria-label={`${participantName}・${eventGroupTitle ?? '講習会不明'}・${classTitle ?? 'クラス不明'}の申込を取消`}
      style={{ border: '1px solid #B91C1C', borderRadius: 8, padding: '6px 10px', color: '#B91C1C', background: '#FEF2F2', cursor: disabled || busy || completed || !knownTarget ? 'not-allowed' : 'pointer', opacity: disabled || busy || completed || !knownTarget ? .5 : 1 }}>
      {completed ? '取消完了・一覧更新待ち' : busy ? '取消中...' : '申込を取消'}
    </button>
    {!knownTarget && <p>対象情報を確認できないため取消できません。一覧を再取得してください。</p>}
    {error && <p role="alert" style={{ color: '#B91C1C', marginTop: 8 }}>{error}</p>}
  </div>
}
