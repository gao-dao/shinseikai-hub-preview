'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { validateOccurrenceInput, validSnapshot, type OccurrenceInput, type OccurrenceSnapshot } from '@/lib/event-groups/occurrence-editor'
import { createOccurrenceSaver } from '@/lib/event-groups/occurrence-save'

type Row = { key: number; id: number | null; title: string; date: string; location: string; start: string; capacity: string; enabled: boolean; type: '稽古会' | '一般参加'; ownDate: boolean; ownLocation: boolean }
const blankRow = (key: number): Row => ({ key, id: null, title: '', date: '', location: '', start: '', capacity: '10', enabled: false, type: '一般参加', ownDate: false, ownLocation: false })
export default function OccurrenceEditor({ groupId }: { groupId?: number }) {
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [city, setCity] = useState('')
  const [date, setDate] = useState(''), [venue, setVenue] = useState(''), [rows, setRows] = useState<Row[]>([blankRow(0)])
  const [expected, setExpected] = useState<OccurrenceSnapshot | null>(null), [loading, setLoading] = useState(!!groupId)
  const [error, setError] = useState(''), [fatal, setFatal] = useState(false), [review, setReview] = useState<OccurrenceInput | null>(null)
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [saved, setSaved] = useState<number | null>(null)
  const [reload, setReload] = useState(0)
  const busyRef = useRef(false), counter = useRef(1), saver = useRef<ReturnType<typeof createOccurrenceSaver> | null>(null)
  const dirty = useRef(false)
  useEffect(() => {
    const storageKey = `shinseikai:occurrence-save:${groupId ?? 'new'}`
    const instance = createOccurrenceSaver(fetch, () => crypto.randomUUID(), { read: () => sessionStorage.getItem(storageKey), write: value => sessionStorage.setItem(storageKey, value), clear: () => sessionStorage.removeItem(storageKey) })
    saver.current = instance
    const controller = new AbortController()
    async function load() {
      setLoading(true); setError(''); setFatal(false)
      try {
        const pending = instance.restore(groupId ?? null)
        if (pending) { setReview(pending.input); setUnknown(true); dirty.current = true; return }
        if (!groupId) return
        const response = await fetch(`/api/admin/occurrences/${groupId}`, { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error('開催回を取得できませんでした。再取得してください。')
        const data = await response.json()
        if (!validSnapshot(data.snapshot) || data.snapshot.classes.length > 100) throw new Error('開催回の全クラスを確認できません。予定管理で確認してください。')
        if (controller.signal.aborted) return
        const snapshot: OccurrenceSnapshot = data.snapshot
        setExpected(snapshot); setTitle(snapshot.group.title); setDescription(snapshot.group.description ?? ''); setCity(snapshot.group.city ?? '')
        const commonDate = snapshot.classes[0]?.date ?? snapshot.group.start_date ?? '', commonVenue = snapshot.classes[0]?.location ?? ''
        setDate(commonDate); setVenue(commonVenue)
        setRows(snapshot.classes.length ? snapshot.classes.map((row, i) => ({ key: i, id: row.id, title: row.title, date: row.date, location: row.location, start: row.start_time ?? '', capacity: row.capacity === null ? '' : String(row.capacity), enabled: row.registration_enabled, type: row.type, ownDate: row.date !== commonDate, ownLocation: row.location !== commonVenue })) : [blankRow(0)])
        counter.current = Math.max(snapshot.classes.length, 1); dirty.current = false
      } catch (e) { if (!controller.signal.aborted) { setFatal(true); setError(e instanceof Error ? e.message : '開催回を確認できませんでした。') } }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [groupId, reload])
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty.current || busyRef.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])
  function changeRow(key: number, patch: Partial<Row>) { dirty.current = true; setRows(old => old.map(row => row.key === key ? { ...row, ...patch } : row)) }
  function confirm(event: React.FormEvent) {
    event.preventDefault(); setError('')
    if (busyRef.current || loading || fatal) return
    const classes = rows.map(row => ({ id: row.id, title: rows.length === 1 && row.id === null ? title : row.title, date: row.ownDate ? row.date : date, location: row.ownLocation ? row.location : venue, start_time: row.start || null, capacity: row.capacity === '' ? null : /^[1-9][0-9]*$/.test(row.capacity) ? Number(row.capacity) : -1, registration_enabled: row.enabled, type: row.type }))
    const dates = classes.map(row => row.date).sort()
    const result = validateOccurrenceInput({ group_id: groupId ?? null, group: { title, description: description || null, city: city || null, start_date: dates[0], end_date: dates[dates.length - 1] }, classes, expected })
    if (!result.data) { setError(result.error); return }
    setReview(result.data)
  }
  async function save() {
    if (busyRef.current || !review || !saver.current) return
    busyRef.current = true; setBusy(true); setError('')
    try {
      const result = await saver.current.save(review)
      if (result.state === 'saved') { dirty.current = false; setSaved(result.groupId); setUnknown(false) }
      else { setError(result.error); setUnknown(result.state === 'unknown') }
    } finally { busyRef.current = false; setBusy(false) }
  }
  function fresh() {
    if (busyRef.current || unknown) return
    if (dirty.current && !window.confirm('未保存の入力を破棄し、最新情報を読み込みますか？')) return
    setReview(null); setReload(v => v + 1)
  }
  return <main className="editor">
    <Link href="/admin/event-groups" onClick={event => { if (busyRef.current || (dirty.current && !window.confirm('未保存の入力があります。一覧へ移動しますか？'))) event.preventDefault() }}>← 開催回一覧</Link>
    <h1>{groupId ? '開催回をまとめて編集' : '開催回を作成'}</h1>
    <p>講習会・稽古会・単独開催を同じ画面で登録できます。保存と受付開始は別の操作です。</p>
    {loading && <p role="status">全クラスを読み込み中...</p>}
    {error && <p role="alert">{error}</p>}
    {saved !== null ? <section><h2>開催回とクラスを保存しました</h2><p role="status">グループ全体の受付状態は変更していません。</p><p>募集するクラスの受付を有効にしてから、開催回の詳細でグループ全体の受付を開始してください。</p><Link href={`/admin/event-groups/${saved}`}>開催回の詳細・受付操作へ</Link></section> : <>
      {groupId && !unknown && <button type="button" disabled={busy || loading} onClick={fresh}>最新情報を再取得</button>}
      {!review && !loading && !fatal && <form onSubmit={confirm} onChange={() => { dirty.current = true }}>
        <section><h2>基本情報</h2><label>開催名<input value={title} maxLength={200} required onChange={e => setTitle(e.target.value)} /></label>
          <div className="grid"><label>開催日（共通）<input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label><label>会場（共通）<input required maxLength={500} value={venue} onChange={e => setVenue(e.target.value)} /></label></div>
          <details><summary>開催回の詳細設定</summary><label>開催地（都市・任意）<input value={city} onChange={e => setCity(e.target.value)} /></label><label>説明（任意）<textarea value={description} onChange={e => setDescription(e.target.value)} /></label></details>
        </section>
        {rows.map((row, i) => <section key={row.key}><h2>{rows.length > 1 ? `クラス ${i + 1}` : 'クラス・開始時刻'}</h2>
          {(rows.length > 1 || row.id !== null) && <label>クラス名<input required value={row.title} maxLength={200} onChange={e => changeRow(row.key, { title: e.target.value })} /></label>}
          <p>クラス受付：{row.enabled ? '有効' : '無効（詳細設定で変更できます）'}</p>
          <label>開始時刻<input type="time" step="1" required value={row.start} onChange={e => changeRow(row.key, { start: e.target.value })} /></label>
          <details><summary>クラスの詳細設定（定員・個別日程・受付）</summary>
            <label><input type="checkbox" checked={row.ownDate} onChange={e => changeRow(row.key, { ownDate: e.target.checked, date: row.date || date })} />このクラスだけ日付を変更</label>{row.ownDate && <label>個別の開催日<input type="date" required value={row.date} onChange={e => changeRow(row.key, { date: e.target.value })} /></label>}
            <label><input type="checkbox" checked={row.ownLocation} onChange={e => changeRow(row.key, { ownLocation: e.target.checked, location: row.location || venue })} />このクラスだけ会場を変更</label>{row.ownLocation && <label>個別の会場<input required value={row.location} onChange={e => changeRow(row.key, { location: e.target.value })} /></label>}
            <label>定員<input type="number" min="1" max="2147483647" step="1" value={row.capacity} onChange={e => changeRow(row.key, { capacity: e.target.value })} /></label>
            <label>種別<select value={row.type} onChange={e => changeRow(row.key, { type: e.target.value as Row['type'] })}><option>一般参加</option><option>稽古会</option></select></label>
            <label><input type="checkbox" checked={row.enabled} onChange={e => changeRow(row.key, { enabled: e.target.checked })} />クラスの受付を有効にする</label><p>グループ全体の受付は詳細画面で別途開始します。</p>
          </details>
          {row.id === null && rows.length > 1 ? <button type="button" onClick={() => { dirty.current = true; setRows(old => old.filter(r => r.key !== row.key)) }}>この入力行を取り除く</button> : row.id !== null && <p>登録済みクラスはこの画面から削除しません。申込・取消履歴は保持します。</p>}
        </section>)}
        <button type="button" disabled={rows.length >= 100} onClick={() => { dirty.current = true; setRows(old => [...old.map(row => ({ ...row, title: row.title || title })), blankRow(counter.current++)]) }}>＋クラスを追加</button>
        <button className="primary" type="submit">開催回と全クラスを確認</button>
      </form>}
      {review && <section aria-label="保存前の確認"><h2>保存前の確認</h2><p>開催地：{review.group.city ?? '未設定'} ／ 説明：{review.group.description || 'なし'}</p><p>{review.group.title} ／ {review.group.start_date} 〜 {review.group.end_date}</p>
        <ul>{review.classes.map((row, i) => <li key={i}><strong>{row.title}</strong><p>{row.date} {row.start_time} ／ {row.location}</p><p>種別：{row.type} ／ 定員：{row.capacity ?? '未設定'}名 ／ クラス受付：{row.registration_enabled ? '有効' : '無効'}</p></li>)}</ul>
        <p>開催期間はクラスの日付から決まります。全クラスを一括保存し、受付状態は自動で開始しません。</p>
        {!unknown && <button disabled={busy} onClick={() => { setReview(null); setError('') }}>入力へ戻る</button>}
        <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? '保存結果を確認中...' : unknown ? '同じ保存キー・内容で再確認' : 'まとめて保存'}</button>
        {unknown && <p>結果不明のため入力変更と新しい保存を停止しています。自動再送は行いません。</p>}
      </section>}
    </>}
    <style jsx>{`.editor{width:100%;max-width:1000px;margin:auto;padding:32px;overflow:auto;color:#29353b}h1{font-size:28px}section{background:white;border:1px solid #e7e1d8;border-radius:14px;padding:24px;margin:20px 0}label{display:block;margin:14px 0}input:not([type=checkbox]),textarea,select{display:block;width:100%;padding:12px;border:1px solid #c9c9c9;border-radius:8px;margin-top:8px;font:inherit}input[type=checkbox]{margin-right:8px}button{min-height:44px;padding:10px 16px;margin:8px 8px 8px 0;border:1px solid #d9d2c8;border-radius:8px;cursor:pointer;background:white;font:inherit}button:disabled{opacity:.5;cursor:default}.primary{background:#6b1f2b;color:white}summary{cursor:pointer;padding:12px 0}li{margin-bottom:16px}p[role=alert]{color:#b91c1c;white-space:pre-wrap}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}a{color:#6b1f2b}@media(max-width:640px){.editor{padding:20px 16px}.grid{grid-template-columns:1fr;gap:0}section{padding:16px}button{width:100%;margin-right:0}}`}</style>
  </main>
}
