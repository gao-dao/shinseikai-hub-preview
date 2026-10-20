'use client'

import { useEffect, useRef, useState } from 'react'
import { loadAllEventGroups } from '../new-schedule-fields'
import { validateProxyRegistration } from '@/lib/registrations/proxy-registration'
import type { RegistrationClass } from '@/lib/registrations/class-availability'

export async function loadProxyClasses(groupId: number, fetcher: typeof fetch, signal: AbortSignal): Promise<RegistrationClass[]> {
  const classes: RegistrationClass[] = []
  const seen = new Set<number>()
  let page = 1
  while (true) {
    const response = await fetcher(`/api/admin/event-groups/${groupId}/classes?page=${page}`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error('クラス候補を取得できませんでした。')
    const data = await response.json()
    if (!Array.isArray(data.schedules) || data.page !== page || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.pageSize) || data.pageSize <= 0) throw new Error('クラス候補を確認できませんでした。')
    for (const item of data.schedules) {
      if (!Number.isSafeInteger(item.id) || item.id <= 0 || seen.has(item.id) || typeof item.title !== 'string' || typeof item.date !== 'string' || typeof item.selectable !== 'boolean' ||
        !Number.isSafeInteger(item.registeredCount) || item.registeredCount < 0 ||
        (item.remainingCapacity !== null && (!Number.isSafeInteger(item.remainingCapacity) || item.remainingCapacity < 0)) ||
        (item.selectable && (!Number.isInteger(item.capacity) || item.capacity <= 0 || item.remainingCapacity === null || item.remainingCapacity <= 0))) throw new Error('クラス候補・空き枠を確認できませんでした。')
      seen.add(item.id)
      classes.push(item)
    }
    if (page * data.pageSize >= data.total) return classes
    if (data.schedules.length === 0) throw new Error('クラス候補を確認できませんでした。')
    page += 1
  }
}

export default function ProxyRegistrationForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [notes, setNotes] = useState('')
  const [group, setGroup] = useState('')
  const [candidates, setCandidates] = useState<RegistrationClass[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [groups, setGroups] = useState<Awaited<ReturnType<typeof loadAllEventGroups>>>([])
  const [groupsLoading, setGroupsLoading] = useState(true)
  const [groupsError, setGroupsError] = useState('')
  const [classesLoading, setClassesLoading] = useState(false)
  const [classesError, setClassesError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [groupsReload, setGroupsReload] = useState(0)
  const [classesReload, setClassesReload] = useState(0)
  const [loadedFor, setLoadedFor] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const inFlight = useRef(false)
  const candidatesReady = group !== '' && loadedFor === group && !classesLoading && !classesError

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setGroupsLoading(true)
      setGroupsError('')
      try {
        const items = await loadAllEventGroups(fetch, controller.signal)
        if (!controller.signal.aborted) setGroups(items)
      } catch {
        if (!controller.signal.aborted) setGroupsError('講習会グループを取得できませんでした。再取得してください。')
      } finally {
        if (!controller.signal.aborted) setGroupsLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [groupsReload])

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setClassesError('')
      setLoadedFor('')
      if (!group) { setClassesLoading(false); return }
      setClassesLoading(true)
      try {
        const items = await loadProxyClasses(Number(group), fetch, controller.signal)
        if (!controller.signal.aborted) { setCandidates(items); setLoadedFor(group) }
      } catch {
        if (!controller.signal.aborted) setClassesError('クラス候補を取得できませんでした。再取得してください。')
      } finally {
        if (!controller.signal.aborted) setClassesLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [group, classesReload])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current || uncertain || groupsLoading || groupsError || !candidatesReady) return
    setError('')
    if (selected.length === 0) { setError('参加するクラスを1つ以上選択してください'); return }
    const validation = validateProxyRegistration({ event_group_id: Number(group), name, contact, notes, schedule_ids: selected })
    if (!validation.data) { setError(validation.error!); return }
    const lecture = groups.find(item => String(item.id) === group)
    const targets = selected.map(id => candidates.find(item => item.id === id))
    if (!lecture || targets.some(item => !item?.selectable)) { setError('講習会と追加可能なクラスを確認してください。'); return }
    inFlight.current = true
    let succeeded = false
    try {
      const summary = targets.map(item => `${item!.title}（${item!.date} ${item!.start_time ?? ''}〜${item!.end_time ?? ''}）`).join('\n')
      if (!window.confirm(`代理申込を登録しますか？\n氏名：${validation.data.name}\n連絡先：${validation.data.contact}\n備考：${validation.data.notes ?? 'なし'}\n講習会：${lecture.title}\n${summary}\n残席は参考情報です。登録時に再判定します。`)) return
      setSaving(true)
      const response = await fetch('/api/admin/registrations', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validation.data),
      })
      if (!response.ok) {
        if (response.status >= 500) {
          setUncertain(true)
          setError('登録結果を確認できません。登録済みの可能性があるため、フォームを閉じて申込一覧を確認してください。自動再送は行いません。')
        } else {
          setError(response.status === 401 ? 'ログインし直してください。' : response.status === 403 ? '管理者権限またはリクエスト元を確認してください。'
            : response.status === 404 ? '講習会が見つかりません。' : response.status === 409 ? '満員またはクラス設定が変わったため登録できませんでした。候補を再取得してください。' : '入力内容・講習会・選択クラスを確認してください。')
        }
        return
      }
      const result = await response.json()
      if (result.success !== true) throw new Error('Unverified registration result')
      succeeded = true
      onSaved()
    } catch {
      setUncertain(true)
      setError('登録結果を確認できません。登録済みの可能性があるため、フォームを閉じて申込一覧を確認してください。自動再送は行いません。')
    } finally {
      if (!succeeded) { inFlight.current = false; setSaving(false) }
    }
  }

  const fieldStyle = { width: '100%', border: '1px solid #EDE8DF', borderRadius: 8, padding: 10, margin: '6px 0 14px', font: 'inherit' }
  return <form onSubmit={submit} aria-labelledby="proxy-registration-title" style={{ background: '#fff', border: '1px solid #EDE8DF', borderRadius: 14, padding: 20, margin: '20px 0' }}>
    <h2 id="proxy-registration-title" style={{ fontSize: 18, marginBottom: 12 }}>代理申込を登録</h2>
    <p style={{ marginBottom: 12 }}>電話・対面で受けた申込を登録します。グループ全体の受付停止中も登録できます。</p>
    <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <label htmlFor="proxy-name">氏名（必須・100文字以内）</label>
      <input id="proxy-name" style={fieldStyle} required value={name} onChange={event => setName(event.target.value)} />
      <label htmlFor="proxy-contact">連絡先（必須・254文字以内）</label>
      <input id="proxy-contact" style={fieldStyle} required value={contact} onChange={event => setContact(event.target.value)} />
      <label htmlFor="proxy-notes">備考（2000文字以内）</label>
      <textarea id="proxy-notes" style={fieldStyle} rows={3} value={notes} onChange={event => setNotes(event.target.value)} />
      <label htmlFor="proxy-group">講習会グループ（必須）</label>
      <select id="proxy-group" style={fieldStyle} value={group} required disabled={groupsLoading || !!groupsError} onChange={event => {
        setGroup(event.target.value); setSelected([]); setCandidates([]); setLoadedFor(''); setClassesError(''); setError('')
      }}>
        <option value="">選択してください</option>
        {groups.map(item => <option key={item.id} value={item.id}>{item.title}（{item.registration_open ? '受付中' : '停止中'}）</option>)}
      </select>
      {groupsLoading && <p role="status">講習会を読み込み中...</p>}
      {groupsError && <p role="alert">{groupsError}</p>}
      <button type="button" disabled={groupsLoading} onClick={() => setGroupsReload(value => value + 1)}>講習会を再取得</button>{' '}
      <button type="button" disabled={!group || classesLoading} onClick={() => { setLoadedFor(''); setClassesReload(value => value + 1) }}>クラス候補を再取得</button>
      {classesLoading && <p role="status">クラス候補を読み込み中...</p>}
      {classesError && <p role="alert">{classesError}</p>}
      {candidatesReady && candidates.length === 0 && <p>この講習会にクラスはありません。</p>}
      {candidatesReady && candidates.map(item => <label key={item.id} style={{ display: 'block', padding: '12px 0', borderBottom: '1px solid #EDE8DF' }}>
        <input type="checkbox" checked={selected.includes(item.id)} disabled={!item.selectable && !selected.includes(item.id)} onChange={event => {
          if (event.target.checked && !item.selectable) return
          setSelected(value => event.target.checked ? value.includes(item.id) ? value : [...value, item.id] : value.filter(id => id !== item.id))
        }} />{' '}{item.title} ／ {item.date} {item.start_time ?? ''}〜{item.end_time ?? ''}
        <span style={{ display: 'block', fontSize: 13 }}>定員：{item.capacity ?? '未設定'} ／ 有効申込数：{item.registeredCount} ／ 残席：{item.remainingCapacity ?? '確認不可'}{item.unavailableReason ? ` ／ ${item.unavailableReason}` : ''}</span>
      </label>)}
      <p style={{ fontSize: 12, marginTop: 12 }}>残席は参考情報です。登録時にDBで再判定します。同じ参加者の別申込がないかも確認してください。</p>
      {error && <p role="alert" style={{ color: '#B91C1C', marginTop: 12 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <button type="submit" disabled={uncertain || groupsLoading || !!groupsError || !candidatesReady}>{saving ? '登録中...' : '内容を確認して登録'}</button>
        <button type="button" onClick={onCancel}>{uncertain ? '閉じて一覧を確認' : 'キャンセル'}</button>
      </div>
    </fieldset>
  </form>
}
