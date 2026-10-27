'use client'
import { useEffect, useRef, useState } from 'react'
import { loadDetailClasses, type DetailClass } from '@/lib/event-groups/detail'

export default function ClassRegistrationControl({ groupId, row, parentOpen, onRefreshed, showControls = true, showParentNotice = true }: {
  groupId: number; row: DetailClass; parentOpen: boolean; showControls?: boolean; showParentNotice?: boolean; onRefreshed: (row: DetailClass) => void
}) {
  const [busy, setBusy] = useState(false)
  const [needsCheck, setNeedsCheck] = useState(false)
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  async function run(change: boolean) {
    if (!showControls || inFlight.current || (change && needsCheck)) return
    inFlight.current = true; setBusy(true); setMessage('')
    let notice = ''
    try {
      if (change) {
        try {
          const response = await fetch(`/api/admin/event-groups/${groupId}/classes/${row.id}/registration`, {
            method: 'PATCH', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ registration_enabled: !row.registration_enabled, expected_registration_enabled: row.registration_enabled }),
          })
          const data = await response.json()
          if (!response.ok) notice = typeof data.error === 'string' ? data.error : '変更できませんでした。最新状態を確認してください。'
          else if (data.schedule?.id !== row.id || data.schedule?.event_group_id !== groupId || data.schedule?.registration_enabled !== !row.registration_enabled)
            notice = '変更結果を確認できませんでした。最新状態を確認してください。'
        } catch { notice = '変更結果を確認できませんでした。最新状態を確認してください。' }
      }
      // A read, never a repeated mutation, resolves a lost/ambiguous PATCH response.
      const rows = await loadDetailClasses(groupId, new AbortController().signal)
      const current = rows.find(item => item.id === row.id)
      if (!current) throw new Error('class unavailable')
      if (alive.current) { onRefreshed(current); setNeedsCheck(false); setMessage(notice ? `${notice} 最新状態を再取得しました。` : '最新の受付状態・申込数・残席を取得しました。') }
    } catch {
      if (alive.current) { setNeedsCheck(true); setMessage('最新状態を確認できません。表示中の人数・残席・受付状態は古い可能性があります。「最新状態を再取得」で確認するまで受付操作はできません。') }
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }

  return <div className="class-reception">
    <dl className="detail-stats"><div><dt>クラス受付</dt><dd>{row.registration_enabled ? '受付中' : '受付停止'}</dd></div><div><dt>定員</dt><dd>{row.capacity === null ? '未設定' : `${row.capacity}名`}</dd></div><div className="class-reception-count"><dt>有効申込数</dt><dd>{row.registeredCount}件</dd></div><div><dt>残席</dt><dd>{row.capacity === null ? '確認できません' : `${Math.max(row.capacity - row.registeredCount, 0)}名`}</dd></div></dl>
    {!parentOpen && showParentNotice && <p className="detail-note">開催回全体が受付停止中です。クラス受付がONでも公開申込は受け付けません。</p>}
    {showControls && <div className="class-reception-actions"><button type="button" disabled={busy || needsCheck} aria-label={`${row.title}：受付を${row.registration_enabled ? '停止' : '開始'}`} onClick={() => void run(true)}>{busy ? '確認・更新中…' : row.registration_enabled ? '受付を停止' : '受付を開始'}</button>
      {needsCheck && <button type="button" disabled={busy} onClick={() => void run(false)}>最新状態を再取得</button>}</div>}
    {message && <p role={needsCheck ? 'alert' : 'status'}>{message}</p>}
  </div>
}
