'use client'

import { useRef, useState } from 'react'

type Props = { id: number; title: string; registrationOpen: boolean; stateVersion?: number; disabled?: boolean; compact?: boolean; onUpdated: () => void }

export default function RegistrationControl({ id, title, registrationOpen, stateVersion, disabled = false, compact = false, onUpdated }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const url = `/api/admin/event-groups/${id}/registration`

  async function change() {
    if (disabled || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      let expectedVersion = stateVersion
      if (!registrationOpen) {
        const check = await fetch(url, { cache: 'no-store' })
        if (!check.ok) {
          setError(check.status === 401 ? 'ログインし直してください。' : check.status === 403 ? '管理者権限がありません。' : '受付開始に必要な情報を確認できませんでした。')
          return
        }
        const eligibility = await check.json()
        if (eligibility.id !== id || eligibility.registration_open !== registrationOpen) {
          setError('受付状態を確認できませんでした。一覧を再取得してください。')
          return
        }
        expectedVersion = eligibility.state_version
        if (eligibility.canOpen !== true) {
          setError(typeof eligibility.reason === 'string' ? eligibility.reason : '受付開始に必要な情報を確認できませんでした。')
          return
        }
      }
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion! < 0) { setError('開催状態を確認できません。最新情報を再取得してください。'); return }
      const action = registrationOpen ? '停止' : '開始'
      const detail = registrationOpen ? '既存の申込・取消履歴は変更されません。' : '受付対象のクラスへの申込を受け付ける設定になります。'
      if (!window.confirm(`「${title}」の申込受付を${action}しますか？\n${detail}`)) return
      const response = await fetch(url, {
        method: 'PATCH', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registration_open: !registrationOpen, expected_registration_open: registrationOpen, expected_state_version: expectedVersion }),
      })
      if (!response.ok) {
        if (response.status === 401) { setError('ログインし直してください。'); return }
        if (response.status === 403) { setError('管理者権限またはリクエスト元を確認してください。'); return }
        const data = await response.json()
        setError(typeof data.error === 'string' ? data.error : '受付状態を更新できませんでした。')
        return
      }
      const data = await response.json()
      if (data.eventGroup?.id !== id || data.eventGroup?.registration_open !== !registrationOpen) {
        setError('更新結果を確認できませんでした。一覧を再取得してください。')
        return
      }
      onUpdated()
    } catch {
      setError('受付状態の変更結果を確認できませんでした。一覧を再取得してから再操作してください。')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <div style={{ marginTop: 12 }}>
    <button className="reception-primary" type="button" disabled={busy || disabled} onClick={change} aria-label={`${title}：${compact ? '受付を' : 'グループ全体の受付を'}${registrationOpen ? '停止' : '開始'}`}>
      {busy ? '確認・更新中...' : `${compact ? '受付を' : 'グループ全体の受付を'}${registrationOpen ? '停止' : '開始'}`}
    </button>
    {error && <p role="alert" style={{ color: '#B91C1C', marginTop: 8 }}>{error}</p>}
  </div>
}
