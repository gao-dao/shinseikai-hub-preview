// Presentation only: never mutate stored data, class identity, or request order.
export function tokyoDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: string) => parts.find(value => value.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
export function calendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
export type OccurrencePhase = 'upcoming' | 'ended' | 'unknown'
export function occurrencePhase(group: { start_date: string | null; end_date: string | null }, dates: readonly unknown[] | undefined, today: string): OccurrencePhase {
  if (!calendarDay(today) || !calendarDay(group.start_date) || !calendarDay(group.end_date) || group.start_date > group.end_date || !dates) return 'unknown'
  if (dates.some(date => !calendarDay(date) || date < group.start_date! || date > group.end_date!)) return 'unknown'
  // A declared last day without a class on that day may be stale: do not archive it.
  if (dates.length && [...dates].sort().at(-1) !== group.end_date) return 'unknown'
  return group.end_date < today ? 'ended' : 'upcoming'
}
export function chronologicalRows<T>(rows: readonly T[], date: (row: T) => string, time: (row: T) => string): T[] {
  return rows.map((row, index) => ({ row, index })).sort((a, b) =>
    (date(a.row) || '9999-99-99').localeCompare(date(b.row) || '9999-99-99') ||
    (time(a.row) || '99:99').localeCompare(time(b.row) || '99:99') || a.index - b.index
  ).map(value => value.row)
}
