'use client'

import { useEffect, useRef, useState } from 'react'

type Candidate = { id: number; title: string; date: string; start_time: string | null; end_time: string | null; capacity: number | null; registeredCount: number; remainingCapacity: number | null; alreadyRegistered: boolean; selectable: boolean; unavailableReason: string | null }
type Props = { registrationId: number; participantName: string; eventGroupTitle: string; onSaved: () => void; onCancel: () => void }

export async function loadRegistrationCandidates(id: number, fetcher: typeof fetch, signal: AbortSignal): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  let page = 1
  while (true) {
    const response = await fetcher(`/api/admin/registrations/${id}/items?page=${page}`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error('追加候補を取得できませんでした。ログイン状態と申込を確認してください。')
    const data = await response.json()
    if (!Array.isArray(data.schedules) || data.page !== page || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.pageSize) || data.pageSize <= 0) throw new Error('追加候補を確認できませんでした。')
    for (const item of data.schedules) {
      if (!Number.isSafeInteger(item.id) || item.id <= 0 || typeof item.title !== 'string' || typeof item.date !== 'string' || typeof item.selectable !== 'boolean' ||
        !Number.isSafeInteger(item.registeredCount) || item.registeredCount < 0 || (item.remainingCapacity !== null && (!Number.isSafeInteger(item.remainingCapacity) || item.remainingCapacity < 0))) throw new Error('追加候補を確認できませんでした。')
      candidates.push(item)
    }
    if (page * data.pageSize >= data.total) return candidates
    if (data.schedules.length === 0) throw new Error('追加候補を確認できませんでした。')
    page += 1
  }
}

export default function AddRegistrationItems({ registrationId, participantName, eventGroupTitle, onSaved, onCancel }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const inFlight = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const items = await loadRegistrationCandidates(registrationId, fetch, controller.signal)
        if (!controller.signal.aborted) setCandidates(items)
      } catch {
        if (!controller.signal.aborted) setLoadError('追加候補を取得できませんでした。候補を再取得してください。')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [registrationId, reload])

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current || loading || loadError) return
    setError('')
    const targets = selected.map(id => candidates.find(item => item.id === id))
    if (selected.length === 0 || selected.length > 50 || targets.some(item => !item?.selectable)) {
      setError('追加可能なクラスを1〜50件選択してください。')
      return
    }
    inFlight.current = true
    let succeeded = false
    try {
      const summary = targets.map(item => `${item!.title}（${item!.date} ${item!.start_time ?? ''}〜${item!.end_time ?? ''}、ID: ${item!.id}）`).join('\n')
      if (!window.confirm(`次のクラスを追加しますか？\n参加者：${participantName}\n講習会：${eventGroupTitle}\n${summary}\n選択したクラスをまとめて追加します。`)) return
      setSaving(true)
      const response = await fetch(`/api/admin/registrations/${registrationId}/items`, {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule_ids: selected }),
      })
      if (!response.ok) {
        setError(response.status === 401 ? 'ログインし直してください。' : response.status === 403 ? '管理者権限またはリクエスト元を確認してください。'
          : response.status === 404 ? '申込が見つかりません。' : response.status === 409 ? '重複・満員・受付状態の変更により追加できませんでした。候補を再取得して確認してください。'
          : response.status === 400 ? '選択したクラスを確認してください。' : 'クラスを追加できませんでした。')
        return
      }
      const result = await response.json()
      if (result.success !== true) { setError('追加結果を確認できませんでした。申込一覧を確認してください。'); return }
      succeeded = true
      onSaved()
    } catch {
      setError('追加結果を確認できませんでした。申込一覧を確認してから再操作してください。')
    } finally {
      if (!succeeded) { inFlight.current = false; setSaving(false) }
    }
  }

  return <form onSubmit={add} aria-labelledby="add-items-title" style={{ background: '#fff', border: '1px solid #EDE8DF', borderRadius: 14, padding: 20, margin: '20px 0' }}>
    <h2 id="add-items-title" style={{ fontSize: 18 }}>クラスを追加</h2>
    <p>参加者：{participantName} ／ 講習会：{eventGroupTitle}</p>
    <p style={{ fontSize: 12, margin: '12px 0' }}>グループ全体の公開受付が停止中でも追加できます。取消済みクラスへの再申込も可能です。クラス受付が無効・満員の場合は追加できません。</p>
    <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <button type="button" disabled={loading} onClick={() => setReload(value => value + 1)}>候補を再取得</button>
      {loading && <p role="status">追加候補を読み込み中...</p>}
      {loadError && <p role="alert">{loadError}</p>}
      {!loading && !loadError && candidates.length === 0 && <p>この講習会グループのクラスはありません。</p>}
      {!loading && !loadError && candidates.map(item => <label key={item.id} style={{ display: 'block', padding: '12px 0', borderBottom: '1px solid #EDE8DF' }}>
        <input type="checkbox" checked={selected.includes(item.id)} disabled={!item.selectable && !selected.includes(item.id)} onChange={event => {
          if (event.target.checked && !item.selectable) return
          setSelected(value => event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id))
        }} />{' '}{item.title} ／ {item.date} {item.start_time ?? ''}〜{item.end_time ?? ''}
        <span style={{ display: 'block', fontSize: 13 }}>定員：{item.capacity ?? '未設定'} ／ 有効申込数：{item.registeredCount} ／ 残席：{item.remainingCapacity ?? '確認不可'}{item.unavailableReason ? ` ／ ${item.unavailableReason}` : ''}</span>
      </label>)}
      {error && <p role="alert" style={{ color: '#B91C1C', marginTop: 12 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <button type="submit" disabled={loading || !!loadError || selected.length === 0}>{saving ? '追加中...' : '選択したクラスを確認して追加'}</button>
        <button type="button" onClick={onCancel}>キャンセル</button>
      </div>
    </fieldset>
  </form>
}
