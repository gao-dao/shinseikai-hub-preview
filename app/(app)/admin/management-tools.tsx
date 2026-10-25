'use client'
import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ScheduleRegistrationStatus, useScheduleRegistrationStatuses } from './schedule-registration-status'
import { deleteScheduleSafely, scheduleDeletionBlockReason } from './schedule-deletion'
import NewScheduleForm from './new-schedule-form'
import EditScheduleFields from './edit-schedule-fields'
import { parseRegistrationFields, validateNewSchedule } from '@/lib/schedules/new-schedule'
import { scheduleEditRestriction } from '@/lib/schedules/edit-schedule'

type Video = { id: number; title: string; description: string; url: string; duration: string; tag: string }
type ScheduleType = '稽古会' | '一般参加'
type Schedule = { id: number; title: string; date: string; start_time: string | null; end_time: string | null; location: string; type: ScheduleType; event_group_id: number | null; capacity: number | null; registration_enabled: boolean }

export default function AdminPage({ initialTab = 'videos' }: { initialTab?: 'videos' | 'schedules' | 'passwords' } = {}) {
  const [tab] = useState<'videos' | 'schedules' | 'passwords'>(initialTab)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [videos, setVideos] = useState<Video[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const scheduleStatuses = useScheduleRegistrationStatuses(isAdmin && tab === 'schedules', schedules)
  const latestScheduleStatuses = useRef(scheduleStatuses)
  useLayoutEffect(() => { latestScheduleStatuses.current = scheduleStatuses }, [scheduleStatuses])
  const deleting = useRef(false)
  const [deletingSchedule, setDeletingSchedule] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [editVideo, setEditVideo] = useState<Video | null>(null)
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null)

  const [vTitle, setVTitle] = useState('')
  const [vDesc, setVDesc] = useState('')
  const [vUrl, setVUrl] = useState('')
  const [vDuration, setVDuration] = useState('')
  const [vTag, setVTag] = useState('基本型')
  const [vMsg, setVMsg] = useState('')

  const [sTitle, setSTitle] = useState('')
  const [sDate, setSDate] = useState('')
  const [sStart, setSStart] = useState('')
  const [sEnd, setSEnd] = useState('')
  const [sLocation, setSLocation] = useState('')
  const [sType, setSType] = useState<ScheduleType>('稽古会')
  const [sMsg, setSMsg] = useState('')
  const [creatingSchedule, setCreatingSchedule] = useState(false)

  // パスワード変更
  const [adminNewPw, setAdminNewPw] = useState('')
  const [adminNewPw2, setAdminNewPw2] = useState('')
  const [adminPwMsg, setAdminPwMsg] = useState('')
  const [memberNewPw, setMemberNewPw] = useState('')
  const [memberNewPw2, setMemberNewPw2] = useState('')
  const [memberPwMsg, setMemberPwMsg] = useState('')
  const [updatingSchedule, setUpdatingSchedule] = useState(false)
  const updatingScheduleRef = useRef(false)
  const [editScheduleKey, setEditScheduleKey] = useState(0)
  const editHeading = useRef<HTMLHeadingElement>(null)
  const [editFocusRequest, setEditFocusRequest] = useState(0)
  useEffect(() => {
    if (!editFocusRequest || !editHeading.current) return
    editHeading.current.focus({ preventScroll: true })
    editHeading.current.scrollIntoView({ behavior: 'instant', block: 'start' })
  }, [editFocusRequest])


  const changeAdminPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (adminNewPw !== adminNewPw2) { setAdminPwMsg('パスワードが一致しません'); return }
    const { error } = await supabase.auth.updateUser({ password: adminNewPw })
    if (error) { setAdminPwMsg('エラー: ' + error.message); return }
    setAdminPwMsg('管理者パスワードを更新しました')
    setAdminNewPw(''); setAdminNewPw2('')
    setTimeout(() => setAdminPwMsg(''), 3000)
  }

  const changeMemberPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (memberNewPw !== memberNewPw2) { setMemberPwMsg('パスワードが一致しません'); return }
    const res = await fetch('/api/admin/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'member_shared', newPassword: memberNewPw })
    })
    const result = await res.json()
    if (!res.ok) { setMemberPwMsg('エラー: ' + result.error); return }
    setMemberPwMsg('会員共通パスワードを更新しました')
    setMemberNewPw(''); setMemberNewPw2('')
    setTimeout(() => setMemberPwMsg(''), 3000)
  }

  const fetchVideos = useCallback(async () => {
    const { data } = await supabase.from('videos').select('*').order('created_at', { ascending: false })
    if (data) setVideos(data as Video[])
  }, [supabase])

  const fetchSchedules = useCallback(async () => {
    const { data } = await supabase.from('schedules').select('*').order('date', { ascending: true })
    if (data) setSchedules(data as Schedule[])
  }, [supabase])

  useEffect(() => {
    const check = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single()
      if (data?.role !== 'admin') { router.push('/videos'); return }
      setIsAdmin(true)
      setLoading(false)
    }
    check()
  }, [router, supabase])

  useEffect(() => {
    if (!isAdmin) return
    const loadData = async () => {
      await Promise.all([fetchVideos(), fetchSchedules()])
    }
    void loadData()
  }, [isAdmin, fetchVideos, fetchSchedules])

  const addVideo = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editVideo) {
      const { error } = await supabase.from('videos').update({
        title: vTitle, description: vDesc, url: vUrl, duration: vDuration, tag: vTag
      }).eq('id', editVideo.id)
      if (error) { setVMsg('エラーが発生しました'); return }
      setVMsg('動画を更新しました！')
      setEditVideo(null)
    } else {
      const { error } = await supabase.from('videos').insert({
        title: vTitle, description: vDesc, url: vUrl, duration: vDuration, tag: vTag
      })
      if (error) { setVMsg('エラーが発生しました'); return }
      setVMsg('動画を追加しました！')
    }
    setVTitle(''); setVDesc(''); setVUrl(''); setVDuration(''); setVTag('基本型')
    fetchVideos()
    setTimeout(() => setVMsg(''), 3000)
  }

  const deleteVideo = async (id: number) => {
    if (!confirm('この動画を削除しますか？')) return
    await supabase.from('videos').delete().eq('id', id)
    fetchVideos()
  }

  const startEditVideo = (v: Video) => {
    setEditVideo(v)
    setVTitle(v.title); setVDesc(v.description ?? ''); setVUrl(v.url)
    setVDuration(v.duration ?? ''); setVTag(v.tag ?? '')
    setEditFocusRequest(value => value + 1)
  }

  const addSchedule = async (e: React.FormEvent) => {
    e.preventDefault()
    const payload = {
      title: sTitle,
      date: sDate,
      start_time: sStart || null,
      end_time: sEnd || null,
      location: sLocation,
      type: sType
    }
    if (editSchedule) {
      if (updatingScheduleRef.current) return
      const form = new FormData(e.currentTarget as HTMLFormElement)
      const fields = parseRegistrationFields(String(form.get('edit_event_group_id') ?? ''), String(form.get('edit_capacity') ?? ''), form.get('edit_registration_enabled') === 'true')
      if (fields.error) { setSMsg('エラー: ' + fields.error); return }
      const validation = validateNewSchedule({ ...payload, ...fields.data })
      if (!validation.data) { setSMsg('エラー: ' + validation.error); return }
      const history = !scheduleStatuses.loading && !scheduleStatuses.error ? scheduleStatuses.statuses[String(editSchedule.id)] : undefined
      const restriction = scheduleEditRestriction(validation.data, editSchedule, history)
      if (restriction) { setSMsg('エラー: ' + restriction); return }
      updatingScheduleRef.current = true
      setUpdatingSchedule(true)
      setSMsg('')
      try {
        const { id, ...expected } = editSchedule
        // Explicit fields only: the browser's schedule query also returns created_at.
        const snapshot = { title: expected.title, date: expected.date, start_time: expected.start_time, end_time: expected.end_time,
          location: expected.location, type: expected.type, event_group_id: expected.event_group_id, capacity: expected.capacity, registration_enabled: expected.registration_enabled }
        const response = await fetch(`/api/admin/schedules/${id}`, {
          method: 'PATCH', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...validation.data, expected: snapshot }),
        })
        if (!response.ok) {
          const message = response.status === 401 ? 'ログインし直してください' : response.status === 403 ? '管理者権限またはリクエスト元を確認してください'
            : response.status === 409 ? '申込状況や予定の状態が変わったため更新できません。一覧・申込状況を再取得して編集し直してください'
            : response.status === 404 ? '予定が見つかりません' : response.status === 400 ? '入力内容と講習会グループを確認してください' : '予定を更新できませんでした'
          setSMsg('エラー: ' + message)
          return
        }
        setSMsg('スケジュールを更新しました！')
        setEditSchedule(null)
        scheduleStatuses.refresh()
      } catch {
        setSMsg('エラー: 更新結果を確認できませんでした。予定一覧を確認してから再操作してください')
        return
      } finally {
        updatingScheduleRef.current = false
        setUpdatingSchedule(false)
      }
    }
    setSTitle(''); setSDate(''); setSStart(''); setSEnd(''); setSLocation(''); setSType('稽古会')
    fetchSchedules()
    setTimeout(() => setSMsg(''), 3000)
  }

  const deleteSchedule = async (id: number) => {
    if (deleting.current) return
    deleting.current = true
    setDeletingSchedule(true)
    setDeleteError(null)
    try {
      const message = await deleteScheduleSafely({
        id,
        getBlockReason: () => {
          const latest = latestScheduleStatuses.current
          return scheduleDeletionBlockReason({ loading: latest.loading, error: latest.error, status: latest.statuses[String(id)] })
        },
        confirmDelete: () => confirm('このスケジュールを削除しますか？'),
        remove: () => supabase.from('schedules').delete().eq('id', id).select('id'),
        refresh: fetchSchedules,
      })
      setDeleteError(message)
    } finally {
      deleting.current = false
      setDeletingSchedule(false)
    }
  }

  const startEditSchedule = (s: Schedule) => {
    setEditScheduleKey(value => value + 1)
    setSMsg('')
    setEditSchedule(s)
    setSTitle(s.title); setSDate(s.date); setSStart(s.start_time || '')
    setSEnd(s.end_time || ''); setSLocation(s.location); setSType(s.type)
    setEditFocusRequest(value => value + 1)
  }

  if (loading) return <div style={{ padding: '40px', color: '#6868a0', textAlign: 'center' }}>読み込み中...</div>
  if (!isAdmin) return null

  const inputStyle = {
    width: '100%', background: '#fff', border: '1px solid #EDE8DF',
    borderRadius: '10px', color: '#1E293B', fontSize: '13px',
    padding: '12px 14px', marginBottom: '12px',
    fontFamily: "'Noto Sans JP', sans-serif", boxSizing: 'border-box' as const,
    transition: 'border-color .2s'
  }
  const labelStyle = { display: 'block' as const, fontSize: '11px', fontWeight: '700' as const, color: '#64748B', marginBottom: '6px', textTransform: 'uppercase' as const }
  const btnStyle = {
    width: '100%', padding: '14px',
    background: 'linear-gradient(135deg, #6B1F2B, #8A3041)',
    border: 'none', borderRadius: '10px',
    color: '#fff', fontWeight: '700' as const, fontSize: '14px',
    cursor: 'pointer', marginTop: '4px', boxShadow: '0 4px 12px rgba(107,31,43,.15)'
  }

  return (
    <>
      <style>{`
        .sp { flex: 1; overflow-y: auto; padding: 24px 20px; background: #FAF7F0; }
        .sec-hd { font-size: 13px; font-weight: 700; color: #6B1F2B; letter-spacing: .15em; text-transform: uppercase; margin-bottom: 20px; display: flex; align-items: center; gap: 12px; }
        .sec-hd::before, .sec-hd::after { content: ''; flex: 1; height: 1px; background: #EDE8DF; }
        .tabs { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px; }
        .tab { flex: 1; padding: 12px; background: #fff; border: 1px solid #EDE8DF; border-radius: 12px; color: #64748B; font-size: 12px; font-weight: 500; cursor: pointer; text-align: center; transition: all .2s; box-shadow: 0 2px 4px rgba(0,0,0,.04); }
        .tab:hover { border-color: #6B1F2B; color: #6B1F2B; }
        .tab.act { background: #6B1F2B; border-color: #6B1F2B; color: #fff; font-weight: 700; box-shadow: 0 4px 12px rgba(107,31,43,.2); }
        .form-card { background: #fff; border: 1px solid #EDE8DF; border-radius: 14px; padding: 24px; margin-bottom: 24px; box-shadow: 0 4px 16px rgba(0,0,0,.04); }
        .form-card.editing { border-color: #6B1F2B; border-width: 2px; }
        .success { color: #10B981; font-size: 12px; font-weight: 500; text-align: center; margin-top: 12px; }
        .error { color: #EF4444; font-size: 12px; font-weight: 500; text-align: center; margin-top: 12px; }
        .list-card { background: #fff; border: 1px solid #EDE8DF; border-radius: 12px; padding: 18px 20px; margin-bottom: 12px; display: flex; align-items: center; gap: 14px; box-shadow: 0 2px 8px rgba(0,0,0,.04); }
        .list-title { flex: 1; font-size: 14px; font-weight: 700; color: #1E293B; }
        .list-sub { font-size: 12px; color: #64748B; margin-top: 4px; }
        .edit-btn { padding: 8px 16px; background: #F7EEF0; border: 1px solid #6B1F2B; border-radius: 8px; color: #6B1F2B; font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: all .2s; }
        .edit-btn:hover { background: #6B1F2B; color: #fff; }
        .del-btn { padding: 8px 16px; background: #FEF2F2; border: 1px solid #EF4444; border-radius: 8px; color: #EF4444; font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: all .2s; }
        .del-btn:hover { background: #EF4444; color: #fff; }
        .cancel-btn { width: 100%; padding: 12px; background: transparent; border: 1px solid #EDE8DF; border-radius: 10px; color: #64748B; font-size: 13px; font-weight: 500; cursor: pointer; margin-top: 10px; transition: all .2s; }
        .cancel-btn:hover { background: #F8FAFC; border-color: #94A3B8; color: #475569; }
        .list-hd { font-size: 11px; font-weight: 700; letter-spacing: .1em; color: #94A3B8; margin-bottom: 14px; text-transform: uppercase; }
        .management-tools :focus-visible { outline: 2px solid #6B1F2B; outline-offset: 3px; }
        .management-tools .tab, .management-tools button, .management-tools a.edit-btn { min-height: 44px; }
        .management-tools .tab, .management-tools a.edit-btn { display: inline-flex; align-items: center; justify-content: center; }
        .management-tools .tab { min-width: 120px; }
        .management-tools button:disabled { opacity: .5; cursor: not-allowed; }
        .management-tools .list-hd { scroll-margin-top: 16px; }
        .management-tools .list-card { flex-wrap: wrap; }
        .management-tools .list-title { overflow-wrap: anywhere; }
        @media(max-width:640px) { .management-tools .form-card { padding: 16px; } .management-tools .edit-btn, .management-tools .del-btn { font-size: 13px; } }
      `}</style>
      <div className="sp management-tools">
        <div className="sec-hd">{tab === 'schedules' ? '予定管理' : tab === 'passwords' ? 'パスワード管理' : '動画管理'}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-end', marginBottom: '16px' }}>
          <Link href="/admin/event-groups" prefetch={false} className="edit-btn" style={{ textDecoration: 'none' }}>
            開催回管理
          </Link>
          <Link href="/admin/registrations" prefetch={false} className="edit-btn" style={{ textDecoration: 'none' }}>
            参加申込一覧
          </Link>
        </div>
        <div className="tabs">
          <Link className={`tab${tab === 'videos' ? ' act' : ''}`} aria-current={tab === 'videos' ? 'page' : undefined} href="/admin/videos">▶ 動画管理</Link>
          <Link className={`tab${tab === 'schedules' ? ' act' : ''}`} aria-current={tab === 'schedules' ? 'page' : undefined} href="/admin/schedules">📅 予定管理</Link>
          <Link className={`tab${tab === 'passwords' ? ' act' : ''}`} aria-current={tab === 'passwords' ? 'page' : undefined} href="/admin/passwords">🔑 パスワード管理</Link>
        </div>

        {tab === 'videos' && (
          <>
            <div className={`form-card${editVideo ? ' editing' : ''}`}>
              <h2 className="list-hd" ref={editHeading} tabIndex={-1}>{editVideo ? '動画を編集' : '動画を追加'}</h2>
              <form onSubmit={addVideo}>
                <label htmlFor="management-vTitle" style={labelStyle}>タイトル *</label>
                <input id="management-vTitle" style={inputStyle} value={vTitle} onChange={e => setVTitle(e.target.value)} required placeholder="基本形 第一段" />
                <label htmlFor="management-vDesc" style={labelStyle}>説明</label>
                <input id="management-vDesc" style={inputStyle} value={vDesc} onChange={e => setVDesc(e.target.value)} placeholder="正拳突き・前蹴りの基礎" />
                <label htmlFor="management-vUrl" style={labelStyle}>動画URL *</label>
                <input id="management-vUrl" style={inputStyle} value={vUrl} onChange={e => setVUrl(e.target.value)} required placeholder="https://www.youtube.com/watch?v=xxxxx" />
                <label htmlFor="management-vDuration" style={labelStyle}>再生時間</label>
                <input id="management-vDuration" style={inputStyle} value={vDuration} onChange={e => setVDuration(e.target.value)} placeholder="12:34" />
                <label htmlFor="management-vTag" style={labelStyle}>タグ</label>
                <select id="management-vTag" style={inputStyle} value={vTag} onChange={e => setVTag(e.target.value)}>
                  <option>基本型</option><option>稽古動画</option><option>参考動画</option>
                </select>
                <button type="submit" style={btnStyle}>{editVideo ? '更新する' : '追加する'}</button>
                {editVideo && <button type="button" className="cancel-btn" onClick={() => { setEditVideo(null); setVTitle(''); setVDesc(''); setVUrl(''); setVDuration(''); setVTag('基本型') }}>キャンセル</button>}
                {vMsg && <div className={vMsg.includes('エラー') ? 'error' : 'success'}>{vMsg}</div>}
              </form>
            </div>
            <div className="list-hd">登録済み動画 ({videos.length}件)</div>
            {videos.map(v => (
              <div key={v.id} className="list-card">
                <div style={{ flex: 1 }}>
                  <div className="list-title">{v.title}</div>
                  <div className="list-sub">{v.tag} · {v.duration}</div>
                </div>
                <button className="edit-btn" onClick={() => startEditVideo(v)}>編集</button>
                <button className="del-btn" onClick={() => deleteVideo(v.id)}>削除</button>
              </div>
            ))}
          </>
        )}

        {tab === 'schedules' && (
          <>
            {!editSchedule && <NewScheduleForm onCreated={() => { void fetchSchedules(); scheduleStatuses.refresh() }} onBusyChange={setCreatingSchedule} />}
            {editSchedule && <div className={`form-card${editSchedule ? ' editing' : ''}`}>
              <h2 className="list-hd" ref={editHeading} tabIndex={-1}>予定を編集</h2>
              <form onSubmit={addSchedule}>
                <fieldset disabled={creatingSchedule || updatingSchedule} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                <label htmlFor="management-sTitle" style={labelStyle}>タイトル *</label>
                <input id="management-sTitle" style={inputStyle} value={sTitle} onChange={e => setSTitle(e.target.value)} required placeholder="通常稽古" />
                <label htmlFor="management-sDate" style={labelStyle}>日付 *</label>
                <input id="management-sDate" style={inputStyle} type="date" value={sDate} onChange={e => setSDate(e.target.value)} required />
                <label htmlFor="management-sStart" style={labelStyle}>開始時間</label>
                <input id="management-sStart" style={inputStyle} type="time" value={sStart} onChange={e => setSStart(e.target.value)} />
                <label htmlFor="management-sEnd" style={labelStyle}>終了時間</label>
                <input id="management-sEnd" style={inputStyle} type="time" value={sEnd} onChange={e => setSEnd(e.target.value)} />
                <label htmlFor="management-sLocation" style={labelStyle}>場所</label>
                <input id="management-sLocation" style={inputStyle} value={sLocation} onChange={e => setSLocation(e.target.value)} placeholder="道場A" />
                <label htmlFor="management-sType" style={labelStyle}>種別</label>
                <select id="management-sType" style={inputStyle} value={sType} onChange={e => setSType(e.target.value as ScheduleType)}>
                  <option value="稽古会">稽古会</option>
                  <option value="一般参加">一般参加</option>
                </select>
                {<EditScheduleFields key={`${editSchedule.id}-${editScheduleKey}`} schedule={editSchedule}
                  history={scheduleStatuses.statuses[String(editSchedule.id)]} historyLoading={scheduleStatuses.loading} historyError={scheduleStatuses.error}
                  groupTitle={scheduleStatuses.statuses[String(editSchedule.id)]?.event_groups?.title} />}
                <button type="submit" style={btnStyle} disabled={!!editSchedule && (scheduleStatuses.loading || !!scheduleStatuses.error || !scheduleStatuses.statuses[String(editSchedule.id)])}>{editSchedule ? updatingSchedule ? '更新中...' : '更新する' : creatingSchedule ? '作成中...' : '追加する'}</button>
                {editSchedule && <button type="button" className="cancel-btn" onClick={() => { setEditSchedule(null); setSTitle(''); setSDate(''); setSStart(''); setSEnd(''); setSLocation(''); setSType('稽古会'); setSMsg('') }}>キャンセル</button>}
                {sMsg && <div className={sMsg.includes('エラー') ? 'error' : 'success'}>{sMsg}</div>}
                </fieldset>
              </form>
            </div>}
            <div className="list-hd">登録済み予定 ({schedules.length}件)</div>
            <div style={{ marginBottom: '14px' }}>
              <button type="button" className="edit-btn" disabled={scheduleStatuses.loading} onClick={scheduleStatuses.refresh}>申込状況を再取得</button>
              {scheduleStatuses.error && <p role="alert" style={{ color: '#B91C1C', marginTop: '8px' }}>{scheduleStatuses.error} 履歴の有無は不明です。</p>}
              {deleteError && <p role="alert" style={{ color: '#B91C1C', marginTop: '8px' }}>{deleteError}</p>}
            </div>
            {schedules.map(s => {
              const deleteReason = scheduleDeletionBlockReason({ loading: scheduleStatuses.loading, error: scheduleStatuses.error, status: scheduleStatuses.statuses[String(s.id)] })
              return (
              <div key={s.id} className="list-card">
                <div style={{ flex: 1 }}>
                  <div className="list-title">{s.title}</div>
                  <div className="list-sub">{s.date} · {s.start_time || '--:--'}〜{s.end_time || '--:--'} · {s.location}</div>
                  <ScheduleRegistrationStatus status={scheduleStatuses.statuses[String(s.id)]} loading={scheduleStatuses.loading} />
                </div>
                <button className="edit-btn" disabled={creatingSchedule || updatingSchedule} onClick={() => startEditSchedule(s)}>編集</button>
                <div>
                  <button className="del-btn" disabled={deletingSchedule || updatingSchedule || deleteReason !== null} aria-describedby={deleteReason ? `schedule-delete-reason-${s.id}` : undefined}
                    style={deletingSchedule || updatingSchedule || deleteReason !== null ? { opacity: .5, cursor: 'not-allowed' } : undefined}
                    onClick={() => deleteSchedule(s.id)}>削除</button>
                  {deleteReason && <p id={`schedule-delete-reason-${s.id}`} className="list-sub" style={{ maxWidth: '180px' }}>{deleteReason}</p>}
                </div>
              </div>
              )
            })}
          </>
        )}

        {tab === 'passwords' && (
          <>
            {/* 管理者パスワード変更 */}
            <div className="form-card">
              <div className="list-hd">🔑 管理者パスワード変更</div>
              <form onSubmit={changeAdminPassword}>
                <label htmlFor="management-adminNewPw" style={labelStyle}>新しいパスワード *（6文字以上）</label>
                <input id="management-adminNewPw" style={inputStyle} type="password" value={adminNewPw} onChange={e => setAdminNewPw(e.target.value)} required minLength={6} />
                <label htmlFor="management-adminNewPw2" style={labelStyle}>確認用パスワード *</label>
                <input id="management-adminNewPw2" style={inputStyle} type="password" value={adminNewPw2} onChange={e => setAdminNewPw2(e.target.value)} required minLength={6} />
                <button type="submit" style={btnStyle}>更新する</button>
                {adminPwMsg && <div className={adminPwMsg.includes('エラー') ? 'error' : 'success'}>{adminPwMsg}</div>}
              </form>
            </div>

            {/* 会員共通パスワード変更 */}
            <div className="form-card">
              <div className="list-hd">👥 会員共通パスワード変更</div>
              <p style={{ fontSize: '11px', color: '#6868a0', marginBottom: '14px', lineHeight: '1.7' }}>
                会員全員が共通で使用するパスワードを変更します。<br />
                <span style={{ color: '#c8a84b' }}>事前に .env.local の MEMBER_SHARED_EMAIL を設定してください。</span>
              </p>
              <form onSubmit={changeMemberPassword}>
                <label htmlFor="management-memberNewPw" style={labelStyle}>新しいパスワード *（6文字以上）</label>
                <input id="management-memberNewPw" style={inputStyle} type="password" value={memberNewPw} onChange={e => setMemberNewPw(e.target.value)} required minLength={6} />
                <label htmlFor="management-memberNewPw2" style={labelStyle}>確認用パスワード *</label>
                <input id="management-memberNewPw2" style={inputStyle} type="password" value={memberNewPw2} onChange={e => setMemberNewPw2(e.target.value)} required minLength={6} />
                <button type="submit" style={btnStyle}>更新する</button>
                {memberPwMsg && <div className={memberPwMsg.includes('エラー') ? 'error' : 'success'}>{memberPwMsg}</div>}
              </form>
            </div>
          </>
        )}
      </div>
    </>
  )
}
