'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import RegistrationControl from './registration-control'
import GroupClasses from './group-classes'
import { findOccurrence } from '@/lib/event-groups/admin-overview'
import NewScheduleForm from '../new-schedule-form'
import { validateEventGroupOccurrence, type EventGroupOccurrence } from '@/lib/event-groups/validation'

type Group = { id: number; title: string; description: string | null; registration_open: boolean } & EventGroupOccurrence
type List = { eventGroups: Group[]; page: number; pageSize: number; total: number }

export default function EventGroups({ groupId, createOnly = false }: { groupId?: number; createOnly?: boolean } = {}) {
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [result, setResult] = useState<List | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const submitting = useRef(false)
  const [formError, setFormError] = useState('')
  const [message, setMessage] = useState('')

  const [city, setCity] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [editing, setEditing] = useState<{ id: number; expected: EventGroupOccurrence } | null>(null)
  const [editCity, setEditCity] = useState('')
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')
  const [editError, setEditError] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [latest, setLatest] = useState<Group | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const editBusy = useRef(false)

  const [addingGroup, setAddingGroup] = useState<Group | null>(null)
  const [creatingClass, setCreatingClass] = useState(false)
  const [classRefresh, setClassRefresh] = useState<Record<number, number>>({})
  const [classSuccess, setClassSuccess] = useState<Record<number, string>>({})
  const addingGroupRef = useRef<number | null>(null)
  const classBusy = useRef(false)
  const classDirty = useRef(false)

  function closeClassForm(): boolean {
    if (classBusy.current) return false
    if (classDirty.current && !window.confirm('未保存の予定入力を破棄しますか？')) return false
    addingGroupRef.current = null; classDirty.current = false; setAddingGroup(null)
    return true
  }

  function toggleClassForm(group: Group) {
    if (classBusy.current || editing || editBusy.current) return
    if (addingGroupRef.current === group.id) { closeClassForm(); return }
    if (addingGroupRef.current !== null && !closeClassForm()) return
    addingGroupRef.current = group.id
    setAddingGroup({ ...group })
  }

  function beginEdit(group: Group) {
    if (classBusy.current || addingGroupRef.current !== null) return
    setEditing({ id: group.id, expected: { city: group.city, start_date: group.start_date, end_date: group.end_date } })
    setEditCity(group.city ?? ''); setEditStart(group.start_date ?? ''); setEditEnd(group.end_date ?? '')
    setEditError(''); setConflict(false); setLatest(null)
  }

  async function saveEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing || editBusy.current || conflict) return
    const validation = validateEventGroupOccurrence({ city: editCity, start_date: editStart, end_date: editEnd })
    if (!validation.data) { setEditError(validation.error); return }
    editBusy.current = true; setEditSaving(true); setEditError('')
    try {
      const response = await fetch(`/api/admin/event-groups/${editing.id}`, {
        method: 'PATCH', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validation.data, expected: editing.expected }),
      })
      if (response.status === 409) {
        setConflict(true)
        setEditError('他の管理者によって開催情報が変更されました。最新情報を読み込み、内容を確認してから編集し直してください。')
        return
      }
      if (!response.ok) {
        setEditError(response.status === 401 ? 'ログインし直してください。' : response.status === 403 ? '更新する権限がありません。' : '開催情報を保存できませんでした。入力内容を確認してください。')
        return
      }
      const data = await response.json()
      if (data.eventGroup?.id !== editing.id || !['city', 'start_date', 'end_date'].every(key => data.eventGroup[key] === validation.data[key as keyof EventGroupOccurrence])) throw new Error('Invalid update response')
      setEditing(null); setMessage('開催情報を更新しました。'); setReload(value => value + 1)
    } catch {
      setEditError('更新結果を確認できませんでした。入力内容は保持されています。一覧を再取得して登録状況を確認してください。')
    } finally { editBusy.current = false; setEditSaving(false) }
  }

  async function refreshConflict() {
    if (!editing || editBusy.current) return
    editBusy.current = true; setRefreshing(true); setLatest(null)
    try {
      let currentPage = 1
      for (;;) {
        const response = await fetch(`/api/admin/event-groups?page=${currentPage}`, { cache: 'no-store' })
        if (!response.ok) throw new Error('Reload failed')
        const data: List = await response.json()
        if (!Array.isArray(data.eventGroups) || data.page !== currentPage || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.pageSize) || data.pageSize <= 0) throw new Error('Invalid list')
        const group = data.eventGroups.find(item => item.id === editing.id)
        if (group) {
          if (![group.city, group.start_date, group.end_date].every(value => value === null || typeof value === 'string')) throw new Error('Invalid occurrence')
          setLatest(group); setReload(value => value + 1); return
        }
        if (currentPage * data.pageSize >= data.total || data.eventGroups.length === 0) throw new Error('Group unavailable')
        currentPage += 1
      }
    } catch { setEditError('最新情報を取得できませんでした。入力内容は保持されています。再取得してください。') }
    finally { editBusy.current = false; setRefreshing(false) }
  }

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      if (addingGroupRef.current === null) setResult(null)
      setListError('')
      try {
        if (createOnly) { setLoading(false); return }
        if (groupId) {
          const group = await findOccurrence(groupId, controller.signal)
          if (!controller.signal.aborted) setResult({ eventGroups: [group], page: 1, pageSize: 1, total: 1 })
          return
        }
        const response = await fetch(`/api/admin/event-groups?page=${page}`, { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error(response.status === 401 ? 'ログインし直してください。' : response.status === 403 ? '管理者権限がありません。' : '一覧を取得できませんでした。')
        const data: List = await response.json()
        if (!controller.signal.aborted) setResult(data)
      } catch (error) {
        if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : '一覧を取得できませんでした。')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [page, reload, groupId, createOnly])

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    if (addingGroupRef.current !== null) { setFormError('予定追加フォームを閉じてからグループを作成してください。'); return }
    setMessage('')
    setFormError('')
    if (!title.trim() || Array.from(title.trim()).length > 200 || Array.from(description).length > 3000) {
      setFormError('タイトルは1〜200文字、説明は3000文字以内で入力してください。')
      return
    }
    const occurrence = validateEventGroupOccurrence({ city, start_date: startDate, end_date: endDate })
    if (!occurrence.data) { setFormError(occurrence.error); return }
    submitting.current = true
    setSaving(true)
    try {
      const response = await fetch('/api/admin/event-groups', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, ...occurrence.data }),
      })
      if (!response.ok) {
        const data = await response.json()
        setFormError(response.status === 401 ? 'ログインし直してください。' : response.status === 403 ? '作成する権限がないか、許可されていないリクエストです。' : data.error || '作成できませんでした。')
        return
      }
      setTitle('')
      setDescription('')
      setCity(''); setStartDate(''); setEndDate('')
      setMessage('講習会グループを作成しました。申込受付は停止中です。')
      setPage(1)
      setReload(value => value + 1)
    } catch {
      setFormError('作成結果を確認できませんでした。一覧を再取得し、登録の有無を確認してから再操作してください。')
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  return (
    <section className="eg-page" aria-labelledby="event-groups-title">
      <style>{`
        .eg-page { flex: 1; overflow-y: auto; padding: 24px 20px; background: #FAF7F0; }
        .eg-page h1 { font-size: 20px; color: #6B1F2B; margin: 20px 0; }
        .eg-card { background: #fff; border: 1px solid #EDE8DF; border-radius: 14px; padding: 24px; margin-bottom: 20px; box-shadow: 0 4px 16px rgba(0,0,0,.04); }
        .eg-page h2 { font-size: 16px; margin-bottom: 14px; }
        .eg-page label { display: block; font-size: 13px; font-weight: 700; margin: 12px 0 6px; }
        .eg-page input, .eg-page textarea { width: 100%; border: 1px solid #EDE8DF; border-radius: 10px; padding: 12px 14px; font: inherit; background: #fff; }
        .eg-page button { padding: 10px 16px; border: 1px solid #6B1F2B; border-radius: 8px; background: #F7EEF0; color: #6B1F2B; cursor: pointer; font: inherit; }
        .eg-page button:disabled { opacity: .5; cursor: default; }
        .eg-page .eg-submit { background: #6B1F2B; color: #fff; margin-top: 16px; }
        .eg-page a { color: #6B1F2B; }
        .eg-page { scroll-behavior: smooth; }
        .eg-page h1 { font-size: 28px; margin: 20px 0; }
        .eg-page h3 { margin: 24px 0 12px; scroll-margin-top: 16px; }
        .occurrence-nav { display: flex; flex-wrap: wrap; gap: 14px; padding: 16px 0; }
        .occurrence-applications { border-top: 1px solid #e7e1d8; margin-top: 24px; padding-top: 8px; }
        .eg-page button { min-height: 44px; margin: 4px 6px 4px 0; }
        @media(max-width:640px) { .eg-page { padding: 20px 16px; } .eg-card { padding: 16px; } .eg-page button { max-width: 100%; white-space: normal; } }
        .eg-description { white-space: pre-wrap; overflow-wrap: anywhere; margin: 12px 0; }
      `}</style>
      <Link href="/admin/event-groups">← 開催回一覧へ</Link>
      <h1 id="event-groups-title">{groupId ? '開催回の詳細' : '開催回を作成'}</h1>
      <nav className="occurrence-nav" aria-label="管理メニュー"><Link href="/admin/schedules">予定管理</Link><Link href="/admin/videos">動画管理</Link><Link href="/admin/passwords">パスワード管理</Link><Link href="/admin/registrations">全開催回の申込一覧</Link></nav>
      {!groupId && <form onSubmit={create} className="eg-card">
        <h2>開催回の基本情報</h2>
        <p>新規作成時の申込受付は停止中になります。</p>
        <label htmlFor="eg-title">タイトル（必須・200文字以内）</label>
        <input id="eg-title" value={title} onChange={event => setTitle(event.target.value)} required disabled={saving} />
        <label htmlFor="eg-description">説明（3000文字以内）</label>
        <textarea id="eg-description" value={description} onChange={event => setDescription(event.target.value)} rows={4} disabled={saving} />
        <label htmlFor="eg-city">開催地（任意・100文字以内）</label>
        <input id="eg-city" value={city} onChange={event => setCity(event.target.value)} disabled={saving} />
        <label htmlFor="eg-start">開始日（任意）</label>
        <input id="eg-start" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} disabled={saving} />
        <label htmlFor="eg-end">終了日（任意）</label>
        <input id="eg-end" type="date" value={endDate} onChange={event => setEndDate(event.target.value)} disabled={saving} />
        <p>開始日と終了日は両方入力するか、両方空欄にしてください。</p>
        <button className="eg-submit" type="submit" disabled={saving || addingGroup !== null}>{saving ? '作成中...' : '作成する'}</button>
        {formError && <p role="alert" style={{ color: '#B91C1C', marginTop: 12 }}>{formError}</p>}
        <p role="status" style={{ marginTop: 12 }}>{message}</p>
      </form>}
      {groupId && <p role="status">{message}</p>}
      {editing && <form className="eg-card" aria-label="開催情報の編集" onSubmit={saveEdit}>
        <h2>開催情報の編集</h2>
        <label htmlFor="eg-edit-city">開催地（任意・100文字以内）</label>
        <input id="eg-edit-city" value={editCity} onChange={event => setEditCity(event.target.value)} disabled={editSaving || refreshing || conflict} />
        <label htmlFor="eg-edit-start">開始日（任意）</label>
        <input id="eg-edit-start" type="date" value={editStart} onChange={event => setEditStart(event.target.value)} disabled={editSaving || refreshing || conflict} />
        <label htmlFor="eg-edit-end">終了日（任意）</label>
        <input id="eg-edit-end" type="date" value={editEnd} onChange={event => setEditEnd(event.target.value)} disabled={editSaving || refreshing || conflict} />
        <p>開始日と終了日は両方入力するか、両方空欄にしてください。</p>
        <button type="submit" disabled={editSaving || refreshing || conflict}>{editSaving ? '保存中...' : '開催情報を保存'}</button>
        <button type="button" disabled={editSaving || refreshing} onClick={() => { setEditing(null); setEditError(''); setLatest(null); setConflict(false) }}>編集をキャンセル</button>
        {editError && <p role="alert">{editError}</p>}
        {conflict && <button type="button" disabled={refreshing || editSaving} onClick={refreshConflict}>{refreshing ? '再取得中...' : '最新情報を再取得'}</button>}
        {latest && <div role="status">
          <p>最新の開催地：{latest.city ?? '未設定'} ／ 開始日：{latest.start_date ?? '未設定'} ／ 終了日：{latest.end_date ?? '未設定'}</p>
          <button type="button" disabled={refreshing || editSaving} onClick={() => beginEdit(latest)}>最新情報で編集を再開</button>
        </div>}
      </form>}
      {!createOnly && <>
      {!groupId && <h2>登録済みの開催回</h2>}
      <button onClick={() => setReload(value => value + 1)} disabled={loading || addingGroup !== null}>一覧を再取得</button>
      <p role="status" style={{ margin: '16px 0' }}>{loading ? '読み込み中...' : result ? `全${result.total}件・${result.page}ページ目` : ''}</p>
      {listError && <p role="alert">{listError} <Link href="/login">ログイン画面へ</Link></p>}
      {result?.eventGroups.length === 0 && <p>表示する講習会グループはありません。</p>}
      {result?.eventGroups.map(group => <article className="eg-card" key={group.id}>
        <h2 style={{ overflowWrap: 'anywhere' }}>{group.title}</h2>
        <nav className="occurrence-nav" aria-label="開催回の項目"><a href={`#basic-${group.id}`}>基本情報</a><a href={`#classes-${group.id}`}>クラス・受付</a><a href={`#applications-${group.id}`}>申込管理</a></nav>
        <h3 id={`basic-${group.id}`}>基本情報</h3>
        <Link href={`/admin/event-groups/${group.id}/edit`}>開催回と全クラスをまとめて編集</Link>
        <p className="eg-description">{group.description || '説明なし'}</p>
        <p>グループ全体の申込受付：<strong>{group.registration_open ? '受付中' : '停止中'}</strong></p>
        <p>開催地：{group.city ?? '未設定'} ／ 開始日：{group.start_date ?? '未設定'} ／ 終了日：{group.end_date ?? '未設定'}</p>
        <button type="button" disabled={editing !== null || addingGroup !== null} onClick={() => beginEdit(group)}>開催情報を編集</button>
        <h3 id={`classes-${group.id}`}>クラス・受付</h3>
        <button type="button" disabled={editing !== null || creatingClass} aria-expanded={addingGroup?.id === group.id}
          onClick={() => toggleClassForm(group)}>{groupId ? '＋ クラスを追加' : 'このグループに予定を追加'}</button>
        {addingGroup?.id === group.id && <div>
          <NewScheduleForm key={addingGroup.id} hideEndTime={!!groupId} fixedGroup={{ id: addingGroup.id, title: addingGroup.title, registration_open: group.registration_open }}
            onBusyChange={busy => { classBusy.current = busy; setCreatingClass(busy) }}
            onDirtyChange={dirty => { classDirty.current = dirty }}
            onCreated={() => {
              // Successful persistence must not go through the discard-confirmation path.
              addingGroupRef.current = null; classDirty.current = false; setAddingGroup(null)
              setClassSuccess(value => ({ ...value, [group.id]: '予定を保存しました。所属クラス一覧をご確認ください。' }))
              setClassRefresh(value => ({ ...value, [group.id]: (value[group.id] ?? 0) + 1 }))
            }} />
          <button type="button" disabled={creatingClass} onClick={closeClassForm}>予定追加を閉じる</button>
        </div>}
        {classSuccess[group.id] && <p role="status">{classSuccess[group.id]}</p>}
        <GroupClasses key={`${group.id}-${classRefresh[group.id] ?? 0}`} groupId={group.id}
          hideEndTime={!!groupId} initiallyExpanded={!!groupId || (classRefresh[group.id] ?? 0) > 0} />
        <RegistrationControl id={group.id} title={group.title} registrationOpen={group.registration_open} onUpdated={() => setReload(value => value + 1)} />
        <section id={`applications-${group.id}`} className="occurrence-applications"><h3>申込管理</h3>
          <p>開催回別のサーバー絞り込みは未対応です。ここでは一部の申込を全件として表示しません。</p>
          <Link href="/admin/registrations">全開催回の申込一覧を開く</Link><p>一覧の「対象講習会」で「{group.title}」を確認してください。情報編集・クラス追加・取消は申込一覧で行えます。</p>
        </section>
      </article>)}
      {!groupId && result && <nav aria-label="講習会グループのページ切替" style={{ display: 'flex', gap: 16 }}>
        <button disabled={addingGroup !== null || page <= 1} onClick={() => setPage(value => value - 1)}>前のページ</button>
        <button disabled={addingGroup !== null || page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>次のページ</button>
      </nav>}
      </>}
    </section>
  )
}
