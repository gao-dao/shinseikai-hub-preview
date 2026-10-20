'use client'

import { useEffect, useState } from 'react'
import { loadAllEventGroups } from './new-schedule-fields'
import type { RegistrationSettings, ScheduleHistory } from '@/lib/schedules/edit-schedule'

type Props = {
  schedule: RegistrationSettings
  history?: ScheduleHistory
  historyLoading: boolean
  historyError: string
  groupTitle?: string
}

export default function EditScheduleFields({ schedule, history, historyLoading, historyError, groupTitle }: Props) {
  const [group, setGroup] = useState(schedule.event_group_id === null ? '' : String(schedule.event_group_id))
  const [capacity, setCapacity] = useState(schedule.capacity === null ? '' : String(schedule.capacity))
  const [enabled, setEnabled] = useState(schedule.registration_enabled)
  const [groups, setGroups] = useState<Awaited<ReturnType<typeof loadAllEventGroups>>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const known = !historyLoading && !historyError && !!history && typeof history.hasRegistrationHistory === 'boolean' && Number.isSafeInteger(history.activeRegistrationCount) && history.activeRegistrationCount >= 0
  const validCapacity = /^[1-9][0-9]*$/.test(capacity) && Number(capacity) <= 2147483647
  const canEnable = known && group !== '' && validCapacity
  const groupReason = !known ? '申込状況が不明なため、グループの変更・解除と定員変更はできません。申込状況を再取得してください。'
    : history.hasRegistrationHistory ? '取消済みを含む申込履歴があるため、グループの変更・関連付け解除はできません。' : ''

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      setError('')
      try {
        const data = await loadAllEventGroups(fetch, controller.signal)
        if (!controller.signal.aborted) setGroups(data)
      } catch {
        if (!controller.signal.aborted) setError('講習会グループの選択肢を取得できませんでした。現在の関連付けを維持します。')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [reload])

  const style = { width: '100%', background: '#fff', border: '1px solid #EDE8DF', borderRadius: 10, padding: '12px 14px', marginBottom: 12, font: 'inherit' }
  return <div style={{ borderTop: '1px solid #EDE8DF', paddingTop: 12 }}>
    <input type="hidden" name="edit_event_group_id" value={group} />
    <input type="hidden" name="edit_capacity" value={capacity} />
    <input type="hidden" name="edit_registration_enabled" value={enabled ? 'true' : 'false'} />
    <label htmlFor="edit-schedule-group" style={{ display: 'block', marginBottom: 6 }}>講習会グループ</label>
    <select id="edit-schedule-group" style={style} value={group} disabled={!known || history?.hasRegistrationHistory || loading || !!error}
      aria-describedby="edit-schedule-group-reason" onChange={event => { setGroup(event.target.value); setEnabled(false) }}>
      <option value="">関連付けなし</option>
      {group !== '' && !groups.some(item => String(item.id) === group) && <option value={group}>{groupTitle || `現在のグループ（ID: ${group}）`}</option>}
      {groups.map(item => <option key={item.id} value={item.id}>{item.title}（{item.registration_open ? '受付中' : '停止中'}）</option>)}
    </select>
    <p id="edit-schedule-group-reason" style={{ fontSize: 12, marginBottom: 12 }}>{groupReason}</p>
    {loading && <p role="status">講習会グループを読み込み中...</p>}
    {error && <p role="alert">{error} <button type="button" className="edit-btn" onClick={() => setReload(value => value + 1)}>再取得</button></p>}
    <label htmlFor="edit-schedule-capacity" style={{ display: 'block', marginBottom: 6 }}>定員（任意・1〜2147483647）</label>
    <input id="edit-schedule-capacity" style={style} type="text" inputMode="numeric" pattern="[1-9][0-9]*" value={capacity} disabled={!known}
      onChange={event => {
        const value = event.target.value
        setCapacity(value)
        if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 2147483647) setEnabled(false)
      }} placeholder="未設定" />
    {known && <p style={{ fontSize: 12, marginBottom: 12 }}>有効申込数：{history.activeRegistrationCount}件{history.activeRegistrationCount > 0 ? '（この人数未満・未設定には変更できません）' : ''}</p>}
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
      <input type="checkbox" checked={enabled} disabled={!canEnable} onChange={event => setEnabled(event.target.checked)} />クラス受付を有効にする
    </label>
    <p style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>受付を無効にしても既存の申込は取り消されません。グループ側の受付状態は変更されません。</p>
  </div>
}
