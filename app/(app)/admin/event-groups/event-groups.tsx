'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import RegistrationControl from './registration-control'

type Group = { id: number; title: string; description: string | null; registration_open: boolean }
type List = { eventGroups: Group[]; page: number; pageSize: number; total: number }

export default function EventGroups() {
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

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      setResult(null)
      setListError('')
      try {
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
  }, [page, reload])

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    setMessage('')
    setFormError('')
    if (!title.trim() || Array.from(title.trim()).length > 200 || Array.from(description).length > 3000) {
      setFormError('タイトルは1〜200文字、説明は3000文字以内で入力してください。')
      return
    }
    submitting.current = true
    setSaving(true)
    try {
      const response = await fetch('/api/admin/event-groups', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description }),
      })
      if (!response.ok) {
        const data = await response.json()
        setFormError(response.status === 401 ? 'ログインし直してください。' : response.status === 403 ? '作成する権限がないか、許可されていないリクエストです。' : data.error || '作成できませんでした。')
        return
      }
      setTitle('')
      setDescription('')
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
        .eg-description { white-space: pre-wrap; overflow-wrap: anywhere; margin: 12px 0; }
      `}</style>
      <Link href="/admin">← 管理パネルへ戻る</Link>
      <h1 id="event-groups-title">講習会グループ管理</h1>
      <form onSubmit={create} className="eg-card">
        <h2>講習会グループの新規作成</h2>
        <p>新規作成時の申込受付は停止中になります。</p>
        <label htmlFor="eg-title">タイトル（必須・200文字以内）</label>
        <input id="eg-title" value={title} onChange={event => setTitle(event.target.value)} required disabled={saving} />
        <label htmlFor="eg-description">説明（3000文字以内）</label>
        <textarea id="eg-description" value={description} onChange={event => setDescription(event.target.value)} rows={4} disabled={saving} />
        <button className="eg-submit" type="submit" disabled={saving}>{saving ? '作成中...' : '作成する'}</button>
        {formError && <p role="alert" style={{ color: '#B91C1C', marginTop: 12 }}>{formError}</p>}
        <p role="status" style={{ marginTop: 12 }}>{message}</p>
      </form>
      <h2>登録済みの講習会グループ</h2>
      <button onClick={() => setReload(value => value + 1)} disabled={loading}>一覧を再取得</button>
      <p role="status" style={{ margin: '16px 0' }}>{loading ? '読み込み中...' : result ? `全${result.total}件・${result.page}ページ目` : ''}</p>
      {listError && <p role="alert">{listError} <Link href="/login">ログイン画面へ</Link></p>}
      {result?.eventGroups.length === 0 && <p>表示する講習会グループはありません。</p>}
      {result?.eventGroups.map(group => <article className="eg-card" key={group.id}>
        <h2 style={{ overflowWrap: 'anywhere' }}>{group.title}</h2>
        <p className="eg-description">{group.description || '説明なし'}</p>
        <p>申込受付：<strong>{group.registration_open ? '受付中' : '停止中'}</strong></p>
        <RegistrationControl id={group.id} title={group.title} registrationOpen={group.registration_open} onUpdated={() => setReload(value => value + 1)} />
      </article>)}
      {result && <nav aria-label="講習会グループのページ切替" style={{ display: 'flex', gap: 16 }}>
        <button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>前のページ</button>
        <button disabled={page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>次のページ</button>
      </nav>}
    </section>
  )
}
