import { validateEventGroupOccurrence } from './validation'
import { validateNewSchedule } from '../schedules/new-schedule'

export type OccurrenceGroup = { title: string; description: string | null; city: string | null; start_date: string; end_date: string }
export type OccurrenceClass = { id: number | null; end_time?: string | null; title: string; date: string; start_time: string | null; location: string; type: '稽古会' | '一般参加'; capacity: number | null; registration_enabled: boolean }
export type OccurrenceSnapshot = { group: Omit<OccurrenceGroup, 'start_date' | 'end_date'> & { start_date: string | null; end_date: string | null; registration_open: boolean }; classes: (OccurrenceClass & { id: number; end_time: string | null })[] }
export type OccurrenceInput = { group_id: number | null; group: OccurrenceGroup; classes: OccurrenceClass[]; expected: OccurrenceSnapshot | null }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k))
export const validId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const groupFields = ['title', 'description', 'city', 'start_date', 'end_date']
const classFields = ['id', 'title', 'date', 'start_time', 'location', 'type', 'capacity', 'registration_enabled']

// Snapshot values are compared verbatim in PostgreSQL; never trim or normalize them.
export function validSnapshot(v: unknown): v is OccurrenceSnapshot {
  if (!object(v) || !exact(v, ['group', 'classes']) || !object(v.group) || !exact(v.group, [...groupFields, 'registration_open']) || !Array.isArray(v.classes)) return false
  const group = v.group
  if (typeof group.title !== 'string' || typeof group.registration_open !== 'boolean' || ['description', 'city', 'start_date', 'end_date'].some(k => group[k] !== null && typeof group[k] !== 'string')) return false
  const ids = new Set<number>()
  return v.classes.every(row => {
    if (!object(row) || !exact(row, [...classFields, 'end_time']) || !validId(row.id) || ids.has(row.id)) return false
    ids.add(row.id)
    return ['title', 'date', 'location', 'type'].every(k => typeof row[k] === 'string') && ['start_time', 'end_time'].every(k => row[k] === null || typeof row[k] === 'string') && (row.capacity === null || (validId(row.capacity) && row.capacity <= 2147483647)) && typeof row.registration_enabled === 'boolean'
  })
}
export function validateOccurrenceInput(value: unknown): { data: OccurrenceInput; error?: never } | { error: string; data?: never } {
  const fail = (error: string) => ({ error })
  if (!object(value) || !exact(value, ['group_id', 'group', 'classes', 'expected'])) return fail('保存内容の形式が不正です。')
  if (value.group_id !== null && !validId(value.group_id)) return fail('開催回IDが不正です。')
  if ((value.group_id === null && value.expected !== null) || (value.group_id !== null && !validSnapshot(value.expected))) return fail('編集開始時の情報が必要です。再読み込みしてください。')
  if (!object(value.group) || !exact(value.group, groupFields)) return fail('開催回の入力項目が不正です。')
  const g = value.group
  if (typeof g.title !== 'string' || !g.title.trim() || Array.from(g.title.trim()).length > 200) return fail('開催名は1〜200文字で入力してください。')
  if (g.description !== null && (typeof g.description !== 'string' || Array.from(g.description).length > 3000)) return fail('説明は3000文字以内で入力してください。')
  const occurrence = validateEventGroupOccurrence({ city: g.city, start_date: g.start_date, end_date: g.end_date })
  if (!occurrence.data || !occurrence.data.start_date || !occurrence.data.end_date) return fail(occurrence.error || '開催期間を入力してください。')
  if (!Array.isArray(value.classes) || value.classes.length < 1 || value.classes.length > 100) return fail('クラスは1〜100件で登録してください。')
  const classes: OccurrenceClass[] = [], ids = new Set<number>()
  for (const row of value.classes) {
    if (!object(row) || !exact(row, Object.hasOwn(row, 'end_time') ? [...classFields, 'end_time'] : classFields) || (row.id !== null && !validId(row.id))) return fail('クラスの入力項目が不正です。')
    if (row.id !== null) { if (ids.has(row.id as number)) return fail('同じクラスが重複しています。'); ids.add(row.id as number) }
    const explicitEnd = Object.hasOwn(row, 'end_time')
    if (explicitEnd && row.end_time !== null && (typeof row.end_time !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(row.end_time))) return fail('終了時刻を時・分で入力してください。')
    const checked = validateNewSchedule({ ...Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'id')), end_time: explicitEnd ? row.end_time : null, event_group_id: value.group_id ?? 1 })
    if (!checked.data || !checked.data.start_time || !checked.data.location.trim() || Array.from(checked.data.title).length > 200 || Array.from(checked.data.location).length > 500) return fail(checked.error || 'クラス名・開始時刻・会場を確認してください。')
    if (row.id === null && checked.data.capacity === null) return fail('新規クラスの定員を入力してください。')
    if (row.date as string < occurrence.data.start_date || row.date as string > occurrence.data.end_date) return fail('クラスの日付を開催期間内にしてください。')
    const saved = row.id === null ? null : (value.expected as OccurrenceSnapshot | null)?.classes.find(item => item.id === row.id)
    const end = explicitEnd ? row.end_time as string | null : saved?.end_time ?? null
    // Legacy values remain untouched; validate chronology only when either time changes.
    if ((explicitEnd || checked.data.start_time !== saved?.start_time) && end !== null && (end.length === 5 ? end + ':00' : end) < (checked.data.start_time.length === 5 ? checked.data.start_time + ':00' : checked.data.start_time)) return fail('終了時刻は開始時刻以降にしてください。')
    classes.push({ ...(explicitEnd ? { end_time: row.end_time as string | null } : {}), id: row.id as number | null, title: checked.data.title, date: checked.data.date, start_time: checked.data.start_time, location: checked.data.location, type: checked.data.type, capacity: checked.data.capacity, registration_enabled: checked.data.registration_enabled })
  }
  if (value.group_id === null && ids.size) return fail('新規開催回に既存クラスは指定できません。')
  if (value.group_id !== null) {
    const snapshot = value.expected as OccurrenceSnapshot
    if (ids.size !== snapshot.classes.length || snapshot.classes.some(row => !ids.has(row.id))) return fail('既存クラスを取り除くことはできません。最新情報を再取得してください。')
  }
  return { data: { group_id: value.group_id as number | null, group: { title: g.title.trim(), description: g.description as string | null, ...occurrence.data } as OccurrenceGroup, classes, expected: value.expected as OccurrenceSnapshot | null } }
}
