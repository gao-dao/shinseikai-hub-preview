'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import RegistrationForm from './registration-form'
import type { PublicClass } from '@/lib/registrations/public-availability'

type Group = { id: number; title: string; description: string | null }
type GroupList = { eventGroups: Group[]; page: number; pageSize: number; total: number }
type ClassList = { schedules: PublicClass[]; page: number; pageSize: number; total: number }

export function PublicClassCard({ item }: { item: PublicClass }) {
  return <li className="events-class">
    <h3>{item.title}</h3>
    <p>開催日時：{item.date} {item.start_time ?? '開始時刻未設定'}〜{item.end_time ?? '終了時刻未設定'}</p>
    <p>定員：{item.capacity === null ? '未設定' : `${item.capacity}名`} ／ 残席：{item.remainingCapacity === null ? '確認できません' : `${item.remainingCapacity}名`}</p>
    <p className={item.canRegister ? 'events-available' : 'events-unavailable'}>受付状況：<strong>{item.status}</strong></p>
  </li>
}

export function EventClasses({ groupId }: { groupId: number }) {
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [result, setResult] = useState<ClassList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      setResult(null)
      setError('')
      try {
        const response = await fetch(`/api/event-groups/${groupId}/classes?page=${page}`, { cache: 'no-store', credentials: 'omit', signal: controller.signal })
        if (!response.ok) throw new Error(response.status === 404 ? 'この講習会は受付停止中、または見つかりません。一覧を更新してください。' : 'クラス・残席を確認できませんでした。受付可否は不明です。')
        const data: ClassList = await response.json()
        if (!controller.signal.aborted) setResult(data)
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'クラス・残席を確認できませんでした。')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [groupId, page, reload])

  return <div aria-label="クラス一覧">
    {loading && <p role="status">クラス・残席を読み込み中...</p>}
    {error && <p role="alert">{error}</p>}
    {result && result.schedules.length === 0 && <p>表示するクラスはありません。</p>}
    {result && <>
      <ul className="events-classes">{result.schedules.map(item => <PublicClassCard key={item.id} item={item} />)}</ul>
      <p>クラス全{result.total}件・{result.page}ページ目</p>
      <nav aria-label="クラスのページ切替" className="events-actions">
        <button disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>前のクラス</button>
        <button disabled={loading || page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>次のクラス</button>
      </nav>
    </>}
    <button disabled={loading} onClick={() => setReload(value => value + 1)}>クラス・残席を更新</button>
  </div>
}

export default function EventsList() {
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [result, setResult] = useState<GroupList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [registrationGroup, setRegistrationGroup] = useState<Group | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      setResult(null)
      setError('')
      try {
        const response = await fetch(`/api/event-groups?page=${page}`, { cache: 'no-store', credentials: 'omit', signal: controller.signal })
        if (!response.ok) throw new Error('講習会を取得できませんでした。時間をおいて再度お試しください。')
        const data: GroupList = await response.json()
        if (!controller.signal.aborted) setResult(data)
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '講習会を取得できませんでした。')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [page, reload])

  return <main className="events-page">
    <style>{`
      .events-page { min-height: 100vh; background: #FAF7F0; color: #1E293B; padding: 28px 20px 60px; }
      .events-inner { max-width: 960px; margin: 0 auto; }
      .events-page h1 { font-size: 26px; color: #6B1F2B; margin: 20px 0 12px; }
      .events-page h2 { font-size: 21px; margin-bottom: 12px; overflow-wrap: anywhere; }
      .events-page h3 { font-size: 17px; margin-bottom: 8px; overflow-wrap: anywhere; }
      .events-page p { margin: 10px 0; line-height: 1.7; }
      .events-page a { color: #6B1F2B; }
      .events-group { margin: 24px 0; padding: 22px; background: #fff; border: 1px solid #EDE8DF; border-radius: 14px; box-shadow: 0 4px 16px rgba(0,0,0,.04); }
      .events-registration input:not([type="checkbox"]), .events-registration textarea { display: block; width: 100%; padding: 10px; margin: 6px 0 16px; border: 1px solid #CBD5E1; border-radius: 6px; background: #fff; }
      .events-registration label, .events-registration span { display: block; }
      .events-registration fieldset { border: 1px solid #EDE8DF; padding: 12px; margin: 16px 0; }
      .events-registration dd { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0 14px; }
      .events-description { white-space: pre-wrap; overflow-wrap: anywhere; }
      .events-classes { list-style: none; padding: 0; }
      .events-class { padding: 18px 0; border-top: 1px solid #EDE8DF; }
      .events-available { color: #166534; }
      .events-unavailable { color: #64748B; }
      .events-page button { padding: 8px 14px; border: 1px solid #6B1F2B; border-radius: 8px; color: #6B1F2B; background: #F7EEF0; cursor: pointer; font: inherit; }
      .events-page button:disabled { opacity: .5; cursor: default; }
      .events-actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 14px 0; }
      @media(max-width:640px) { .events-page { padding: 16px 12px 40px; } .events-group { padding: 16px; } }
    `}</style>
    <div className="events-inner">
      <Link href="/schedule">スケジュールへ</Link>
      <h1>公開講習会</h1>
      <p>公開受付中の講習会とクラス情報です。残席は確認時点の情報です。</p>
      {registrationGroup && <RegistrationForm key={registrationGroup.id} group={registrationGroup} onClose={() => setRegistrationGroup(null)} />}
      <button disabled={loading} onClick={() => { setPage(1); setReload(value => value + 1) }}>講習会一覧を更新</button>
      {loading && <p role="status">講習会を読み込み中...</p>}
      {error && <p role="alert">{error}</p>}
      {result && result.eventGroups.length === 0 && <p>現在、公開受付中の講習会はありません。</p>}
      {result?.eventGroups.map(group => <article className="events-group" key={group.id}>
        <h2>{group.title}</h2>
        {group.description && <p className="events-description">{group.description}</p>}
        <EventClasses groupId={group.id} />
        <button type="button" disabled={registrationGroup !== null} onClick={() => setRegistrationGroup(group)}>この講習会に申し込む</button>
      </article>)}
      {result && <>
        <p>講習会全{result.total}件・{result.page}ページ目</p>
        <nav aria-label="講習会のページ切替" className="events-actions">
          <button disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>前の講習会</button>
          <button disabled={loading || page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>次の講習会</button>
        </nav>
      </>}
    </div>
  </main>
}
