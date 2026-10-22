'use client'

import { useRef, useState } from 'react'
import NewScheduleFields, { type Group } from './new-schedule-fields'
import { parseRegistrationFields, validateNewSchedule, type NewSchedule } from '@/lib/schedules/new-schedule'

type Props = {
  fixedGroup?: Group
  onCreated?: () => void
  onBusyChange?: (busy: boolean) => void
  onDirtyChange?: (dirty: boolean) => void
}

export default function NewScheduleForm({ fixedGroup, onCreated, onBusyChange, onDirtyChange }: Props) {
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [location, setLocation] = useState('')
  const [type, setType] = useState<NewSchedule['type']>('稽古会')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [fieldsKey, setFieldsKey] = useState(0)
  const inFlight = useRef(false)

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    if (fixedGroup && (!Number.isSafeInteger(fixedGroup.id) || fixedGroup.id <= 0)) {
      setMessage('エラー: 対象グループを確認してください'); return
    }
    const form = new FormData(event.currentTarget)
    // Never trust a hidden/select value when the caller fixes the group.
    const groupId = fixedGroup ? String(fixedGroup.id) : String(form.get('new_event_group_id') ?? '')
    const fields = parseRegistrationFields(groupId, String(form.get('new_capacity') ?? ''), form.get('new_registration_enabled') === 'on')
    if (fields.error) { setMessage('エラー: ' + fields.error); return }
    const validation = validateNewSchedule({ title, date, start_time: start || null, end_time: end || null, location, type, ...fields.data })
    if (!validation.data) { setMessage('エラー: ' + validation.error); return }
    inFlight.current = true; setSaving(true); onBusyChange?.(true); setMessage('')
    let created = false
    try {
      const response = await fetch('/api/admin/schedules', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validation.data),
      })
      if (!response.ok) {
        const error = response.status === 401 ? 'ログインし直してください' : response.status === 403 ? '管理者権限またはリクエスト元を確認してください' : response.status === 400 ? '入力内容と講習会グループを確認してください' : '予定を作成できませんでした。登録状況を確認してから再操作してください'
        setMessage('エラー: ' + error); return
      }
      setTitle(''); setDate(''); setStart(''); setEnd(''); setLocation(''); setType('稽古会')
      setFieldsKey(value => value + 1)
      onDirtyChange?.(false)
      setMessage('スケジュールを追加しました！')
      created = true
    } catch {
      setMessage('エラー: 作成結果を確認できませんでした。予定一覧を確認してから再操作してください')
    } finally { inFlight.current = false; setSaving(false); onBusyChange?.(false) }
    if (created) onCreated?.()
  }

  return <div className="form-card">
    <div className="list-hd">＋ 予定を追加</div>
    <form onSubmit={create} onChange={() => onDirtyChange?.(true)} aria-label="予定の新規作成">
      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label>タイトル *<input name="title" value={title} onChange={event => setTitle(event.target.value)} required placeholder="通常稽古" /></label>
        <label>日付 *<input name="date" type="date" value={date} onChange={event => setDate(event.target.value)} required /></label>
        <label>開始時間<input name="start_time" type="time" value={start} onChange={event => setStart(event.target.value)} /></label>
        <label>終了時間<input name="end_time" type="time" value={end} onChange={event => setEnd(event.target.value)} /></label>
        <label>場所<input name="location" value={location} onChange={event => setLocation(event.target.value)} placeholder="道場A" /></label>
        <label>種別<select name="type" value={type} onChange={event => setType(event.target.value as NewSchedule['type'])}>
          <option value="稽古会">稽古会</option><option value="一般参加">一般参加</option>
        </select></label>
        <NewScheduleFields key={fieldsKey} fixedGroup={fixedGroup} />
        <button type="submit">{saving ? '作成中...' : '追加する'}</button>
        {message && <p role={message.startsWith('エラー:') ? 'alert' : 'status'}>{message}</p>}
      </fieldset>
    </form>
    <style jsx>{`
      label { display: block; font-size: 11px; font-weight: 700; color: #64748B; margin-bottom: 6px; }
      input, select { display: block; width: 100%; background: #fff; border: 1px solid #EDE8DF; border-radius: 10px; padding: 12px 14px; font-size: 13px; margin-bottom: 12px; box-sizing: border-box; }
      button { width: 100%; padding: 12px; background: #6B1F2B; border: none; border-radius: 10px; color: white; font-weight: 700; cursor: pointer; }
      fieldset:disabled { opacity: .7; }
    `}</style>
  </div>
}
