'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { validateProxyRegistration } from '@/lib/registrations/proxy-registration'
import { PublicRegistrationAttempt, loadPublicRegistrationClasses } from '@/lib/registrations/public-form'
import type { PublicClass } from '@/lib/registrations/public-availability'
import TurnstileWidget from './turnstile-widget'

type Input = NonNullable<ReturnType<typeof validateProxyRegistration>['data']>
type Stage = 'initializing' | 'editing' | 'confirming' | 'pending' | 'success' | 'blocked'

export default function RegistrationForm({ group, onClose }: { group: { id: number; title: string }; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>('initializing')
  const [name, setName] = useState(''), [contact, setContact] = useState(''), [notes, setNotes] = useState('')
  const [classes, setClasses] = useState<PublicClass[]>([]), [selected, setSelected] = useState<number[]>([])
  const [loading, setLoading] = useState(true), [classesError, setClassesError] = useState('')
  const [error, setError] = useState(''), [review, setReview] = useState<Input | null>(null)
  const [token, setToken] = useState(''), [generation, setGeneration] = useState(0)
  const [saving, setSaving] = useState(false), [reload, setReload] = useState(0)
  const attempt = useRef<PublicRegistrationAttempt | null>(null)
  const inFlight = useRef(false)
  const onToken = useCallback((value: string) => setToken(value), [])

  useEffect(() => {
    let active = true
    async function initialize() {
      try {
        const controller = new PublicRegistrationAttempt(window.sessionStorage, () => crypto.randomUUID())
        if (active) { attempt.current = controller; setStage(controller.phase === 'ready' ? 'editing' : controller.phase === 'success' ? 'success' : 'blocked') }
      } catch { if (active) setStage('blocked') }
    }
    void initialize()
    const warn = (event: BeforeUnloadEvent) => {
      if (attempt.current?.phase === 'pending') { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => { active = false; window.removeEventListener('beforeunload', warn) }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true); setClassesError('')
      try {
        const result = await loadPublicRegistrationClasses(group.id, fetch, controller.signal)
        if (!controller.signal.aborted) { setClasses(result); setSelected(value => value.filter(id => result.some(item => item.id === id && item.canRegister))) }
      } catch { if (!controller.signal.aborted) { setClasses([]); setClassesError('クラス・残席を取得できませんでした。受付停止中の場合もあります。一覧を更新してください。') } }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [group.id, reload])

  function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current || stage !== 'editing' || loading || classesError) return
    setError('')
    if (!selected.length) { setError('参加するクラスを1つ以上選択してください'); return }
    const validation = validateProxyRegistration({ event_group_id: group.id, name, contact, notes, schedule_ids: selected })
    if (!validation.data) { setError(validation.error!); return }
    if (selected.some(id => !classes.find(item => item.id === id)?.canRegister)) { setError('受付可能なクラスを選択してください'); return }
    setReview(validation.data); setToken(''); setStage('confirming')
  }

  async function submit() {
    if (inFlight.current || !token || !review || !attempt.current || !['confirming', 'pending'].includes(stage)) return
    inFlight.current = true; setSaving(true); setError('')
    const currentToken = token
    setToken('')
    try {
      if (!attempt.current.prepare(review)) { setError('申込状態を安全に保存できないため送信していません。ブラウザの保存設定を確認してください。'); return }
      setStage('pending')
      const result = await attempt.current.submit(currentToken, fetch)
      if (result.kind === 'success') setStage('success')
      else setError(result.message + (result.retryAfterSeconds ? ` ${result.retryAfterSeconds}秒以上おいて再確認してください。` : ''))
    } finally {
      setToken(''); setGeneration(value => value + 1)
      inFlight.current = false; setSaving(false)
    }
  }
  function startNew() {
    if (!attempt.current?.startNew()) { setError('新しい申込を開始できません。主催者へお問い合わせください。'); return }
    setName(''); setContact(''); setNotes(''); setSelected([]); setReview(null); setError(''); setToken(''); setStage('editing'); setReload(value => value + 1)
  }

  return <section className="events-group events-registration" aria-label="講習会への参加申込">
    <h2>{stage === 'success' ? '申込完了' : '参加申込'}</h2>
    {stage !== 'blocked' && stage !== 'success' && <p>講習会：{group.title}</p>}
    {stage === 'initializing' && <p role="status">申込状態を確認中...</p>}
    {stage === 'blocked' && <p role="alert">前の申込結果が不明、または申込状態を保存できません。個人情報はブラウザに保存していないため、このページでは再送内容を復元できません。新しく申し込まず、主催者へ受付状況をお問い合わせください。</p>}
    {stage === 'success' && <>
      <p role="status">申込を受け付けました。後日追加で申し込む場合は、新しい申込を開始してください。</p>
      <button type="button" onClick={startNew}>新しい申込を始める</button>
    </>}
    {stage === 'editing' && <form onSubmit={confirm}>
      <label htmlFor="public-name">氏名（必須・100文字以内）</label>
      <input id="public-name" required autoComplete="name" value={name} onChange={event => setName(event.target.value)} />
      <label htmlFor="public-contact">連絡先（必須・254文字以内）</label>
      <input id="public-contact" required value={contact} onChange={event => setContact(event.target.value)} />
      <label htmlFor="public-notes">備考（2000文字以内）</label>
      <textarea id="public-notes" rows={3} value={notes} onChange={event => setNotes(event.target.value)} />
      {loading && <p role="status">クラス・残席を読み込み中...</p>}
      {classesError && <p role="alert">{classesError}</p>}
      <fieldset disabled={loading || !!classesError}>
        <legend>参加するクラス（複数選択可・最大50件）</legend>
        {!loading && !classesError && classes.length === 0 && <p>申込対象のクラスはありません。</p>}
        {classes.map(item => <label key={item.id} className="events-class">
          <input type="checkbox" checked={selected.includes(item.id)} disabled={!item.canRegister || (!selected.includes(item.id) && selected.length >= 50)}
            onChange={event => { if (event.target.checked && !item.canRegister) return; setSelected(value => event.target.checked ? value.includes(item.id) ? value : [...value, item.id] : value.filter(id => id !== item.id)) }} />
          {' '}{item.title} ／ {item.date} {item.start_time ?? '開始時刻未設定'}〜{item.end_time ?? '終了時刻未設定'}
          <span>定員：{item.capacity ?? '未設定'} ／ 残席：{item.remainingCapacity ?? '確認不可'} ／ {item.status}</span>
        </label>)}
      </fieldset>
      <p>残席は確認時点の情報です。送信時に受付状態・定員を再確認します。</p>
      <button type="button" disabled={loading} onClick={() => setReload(value => value + 1)}>クラス・残席を再取得</button>{' '}
      <button type="submit" disabled={loading || !!classesError}>入力内容を確認する</button>
    </form>}
    {(stage === 'confirming' || stage === 'pending') && review && <>
      <h3>申込内容の確認</h3>
      <dl><dt>氏名</dt><dd>{review.name}</dd><dt>連絡先</dt><dd>{review.contact}</dd><dt>備考</dt><dd>{review.notes ?? 'なし'}</dd></dl>
      <ul>{review.schedule_ids.map(id => { const item = classes.find(row => row.id === id); return <li key={id}>{item?.title} ／ {item?.date} {item?.start_time ?? ''}〜{item?.end_time ?? ''}</li> })}</ul>
      {stage === 'pending' && <p>送信済みの内容を固定しています。結果が不明な場合も、操作確認をやり直して同じ申込を再確認できます。再読み込み後は送信内容を復元できません。</p>}
      {!saving && <TurnstileWidget onToken={onToken} generation={generation} />}
      <div className="events-actions">
        <button type="button" disabled={saving || !token} onClick={() => { void submit() }}>{saving ? '送信中...' : stage === 'pending' ? '同じ申込の結果を再確認する' : 'この内容で申し込む'}</button>
        <button type="button" disabled={saving} onClick={() => { setToken(''); setGeneration(value => value + 1) }}>操作確認をやり直す</button>
        {stage === 'confirming' && <button type="button" onClick={() => { setReview(null); setToken(''); setStage('editing') }}>入力を修正する</button>}
      </div>
    </>}
    {error && <p role="alert">{error}</p>}
    {stage !== 'pending' && !saving && <button type="button" onClick={onClose}>閉じる</button>}
  </section>
}
