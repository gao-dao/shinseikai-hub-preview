import { calendarDay, occurrencePhase, tokyoDay } from './presentation'

export type GuideGroup = { id: number; title: string; description: string | null; city: string | null; start_date: string; end_date: string; registration_open: boolean; is_cancelled: boolean; is_hidden: boolean }
export type GuideClass = { id: number; event_group_id: number; title: string; date: string; start_time: string | null; end_time: string | null; location: string }
export function publishable(group: GuideGroup, dates: readonly string[], today: string) {
  return group.is_hidden === false && group.is_cancelled === false && occurrencePhase(group, dates, today) === 'upcoming'
}
export function minuteTime(value: string | null): string {
  return value && /^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?$/.test(value) ? value.slice(0, 5) : ''
}
export function timeRange(row: Pick<GuideClass, 'start_time' | 'end_time'>) {
  const start = minuteTime(row.start_time), end = minuteTime(row.end_time)
  return start ? `${start}${end ? `〜${end}` : ''}` : '開始時刻未設定'
}
export function sortClasses(rows: readonly GuideClass[]) {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date) || (a.start_time ?? '').localeCompare(b.start_time ?? '') || a.id - b.id)
}
export function commonVenue(rows: readonly GuideClass[]) {
  return rows.length && rows[0].location && rows.every(row => row.location === rows[0].location) ? rows[0].location : null
}
export function guidePage(value: unknown) {
  if (value === undefined) return 1
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 1000) throw new Error('invalid page')
  return Number(value)
}
export function guideToday(now = new Date()) { return tokyoDay(now) }
export function validGroup(group: GuideGroup) {
  return Number.isSafeInteger(group.id) && group.id > 0 && typeof group.title === 'string' && calendarDay(group.start_date) && calendarDay(group.end_date) && group.start_date <= group.end_date
}
