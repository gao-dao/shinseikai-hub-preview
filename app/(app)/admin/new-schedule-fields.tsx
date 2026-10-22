'use client'

import { useEffect, useState } from 'react'

export type Group = { id: number; title: string; registration_open: boolean }

export async function loadAllEventGroups(fetcher: typeof fetch, signal: AbortSignal): Promise<Group[]> {
  const groups: Group[] = []
  let page = 1
  while (true) {
    const response = await fetcher(`/api/admin/event-groups?page=${page}`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error('講習会グループを取得できませんでした。')
    const data = await response.json()
    if (!Array.isArray(data.eventGroups) || data.page !== page || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.pageSize) || data.pageSize <= 0) {
      throw new Error('講習会グループを確認できませんでした。')
    }
    for (const group of data.eventGroups) {
      if (!Number.isSafeInteger(group.id) || group.id <= 0 || typeof group.title !== 'string' || typeof group.registration_open !== 'boolean') throw new Error('講習会グループを確認できませんでした。')
      groups.push({ id: group.id, title: group.title, registration_open: group.registration_open })
    }
    if (page * data.pageSize >= data.total) return groups
    if (data.eventGroups.length === 0) throw new Error('講習会グループを確認できませんでした。')
    page += 1
  }
}

// Mounted only for new schedules; unmounting on edit/cancel discards these values.
export default function NewScheduleFields({ fixedGroup }: { fixedGroup?: Group } = {}) {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [group, setGroup] = useState('')
  const [capacity, setCapacity] = useState('')
  const [enabled, setEnabled] = useState(false)
  const validCapacity = /^[1-9][0-9]*$/.test(capacity) && Number(capacity) <= 2147483647
  const fixedValid = fixedGroup !== undefined && Number.isSafeInteger(fixedGroup.id) && fixedGroup.id > 0
  const canEnable = (fixedGroup ? fixedValid : !loading && !error && group !== '') && validCapacity

  useEffect(() => {
    if (fixedGroup) return
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      setError('')
      setGroups([])
      setGroup('')
      setEnabled(false)
      try {
        const data = await loadAllEventGroups(fetch, controller.signal)
        if (!controller.signal.aborted) setGroups(data)
      } catch {
        if (!controller.signal.aborted) setError('講習会グループを取得できませんでした。関連付けなしの予定は作成できます。')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [reload, fixedGroup])

  const fieldStyle = { width: '100%', background: '#fff', border: '1px solid #EDE8DF', borderRadius: 10, padding: '12px 14px', marginBottom: 12, font: 'inherit' }
  return (
    <div style={{ borderTop: '1px solid #EDE8DF', paddingTop: 12 }}>
      {fixedGroup ? <p>対象グループ：{fixedGroup.title}（{fixedGroup.registration_open ? '受付中' : '停止中'}）</p> : <>
      <label htmlFor="new-schedule-group" style={{ display: 'block', marginBottom: 6 }}>講習会グループ</label>
      <select id="new-schedule-group" name="new_event_group_id" style={fieldStyle} value={group} disabled={loading || !!error}
        onChange={event => { setGroup(event.target.value); setEnabled(false) }}>
        <option value="">関連付けなし</option>
        {groups.map(item => <option key={item.id} value={item.id}>{item.title}（{item.registration_open ? '受付中' : '停止中'}）</option>)}
      </select>
      {loading && <p role="status">講習会グループを読み込み中...</p>}
      {error && <p role="alert">{error} <button type="button" className="edit-btn" onClick={() => setReload(value => value + 1)}>再取得</button></p>}
      </>}
      <label htmlFor="new-schedule-capacity" style={{ display: 'block', marginBottom: 6 }}>定員（任意・1〜2147483647）</label>
      <input id="new-schedule-capacity" name="new_capacity" style={fieldStyle} type="text" inputMode="numeric" pattern="[1-9][0-9]*" value={capacity}
        onChange={event => { setCapacity(event.target.value); setEnabled(false) }} placeholder="未設定" />
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input type="checkbox" name="new_registration_enabled" checked={enabled && !!canEnable} disabled={!canEnable} onChange={event => setEnabled(event.target.checked)} />
        クラス受付を有効にする
      </label>
      <p style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>グループと定員が必要です。グループ側が停止中の場合、クラスを有効にしても公開申込の受付は開始されません。</p>
    </div>
  )
}
