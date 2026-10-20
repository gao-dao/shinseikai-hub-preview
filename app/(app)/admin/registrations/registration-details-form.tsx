'use client'

import { useRef, useState } from 'react'
import { validateRegistrationDetails, type RegistrationDetails } from '@/lib/registrations/details'

type Props = { registration: RegistrationDetails & { id: number }; onSaved: () => void; onCancel: () => void }

export default function RegistrationDetailsForm({ registration, onSaved, onCancel }: Props) {
  const [name, setName] = useState(registration.name)
  const [contact, setContact] = useState(registration.contact)
  const [notes, setNotes] = useState(registration.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    setError('')
    const validation = validateRegistrationDetails({ name, contact, notes })
    if (!validation.data) { setError(validation.error); return }
    inFlight.current = true
    setSaving(true)
    try {
      const response = await fetch(`/api/admin/registrations/${registration.id}`, {
        method: 'PATCH', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validation.data),
      })
      if (!response.ok) {
        const message = response.status === 401 ? 'ログインし直してください。' : response.status === 403 ? '管理者権限またはリクエスト元を確認してください。'
          : response.status === 404 ? '申込が見つかりません。一覧を再取得してください。' : response.status === 400 ? '氏名・連絡先・備考の入力内容を確認してください。'
          : response.status === 409 ? '別の操作と競合しました。一覧を再取得してから再操作してください。' : '申込者情報を更新できませんでした。'
        setError(message)
        return
      }
      const result = await response.json()
      if (result.success !== true) { setError('更新結果を確認できませんでした。一覧を再取得してください。'); return }
      onSaved()
    } catch {
      setError('更新結果を確認できませんでした。一覧を再取得してから再操作してください。')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  const fieldStyle = { width: '100%', border: '1px solid #EDE8DF', borderRadius: 8, padding: 10, margin: '6px 0 14px', font: 'inherit' }
  const buttonStyle = { border: '1px solid #6B1F2B', borderRadius: 8, padding: '8px 16px', background: '#F7EEF0', color: '#6B1F2B', cursor: 'pointer' }
  return <form onSubmit={save} aria-labelledby="registration-edit-title" style={{ background: '#fff', border: '1px solid #EDE8DF', borderRadius: 14, padding: 20, margin: '20px 0' }}>
    <h2 id="registration-edit-title" style={{ fontSize: 18, marginBottom: 16 }}>申込者情報の編集</h2>
    <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <label htmlFor="registration-edit-name">氏名（必須・100文字以内）</label>
      <input id="registration-edit-name" style={fieldStyle} value={name} onChange={event => setName(event.target.value)} required />
      <label htmlFor="registration-edit-contact">連絡先（必須・254文字以内）</label>
      <input id="registration-edit-contact" style={fieldStyle} value={contact} onChange={event => setContact(event.target.value)} required />
      <label htmlFor="registration-edit-notes">備考（2000文字以内）</label>
      <textarea id="registration-edit-notes" style={fieldStyle} rows={4} value={notes} onChange={event => setNotes(event.target.value)} />
      <div style={{ display: 'flex', gap: 12 }}>
        <button type="submit" style={buttonStyle}>{saving ? '更新中...' : '更新する'}</button>
        <button type="button" style={buttonStyle} onClick={onCancel}>キャンセル</button>
      </div>
    </fieldset>
    {error && <p role="alert" style={{ color: '#B91C1C', marginTop: 12 }}>{error}</p>}
  </form>
}
