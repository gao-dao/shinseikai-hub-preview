export type Occurrence = { id: number; title: string; description: string | null; city: string | null; start_date: string | null; end_date: string | null; registration_open: boolean }
export type ClassSummary = { classCount: number; activeClassBookings: number; classDates: unknown[] }
export function validOccurrence(value: unknown): value is Occurrence {
  if (!value || typeof value !== 'object') return false
  const v = value as Occurrence
  return Number.isSafeInteger(v.id) && v.id > 0 && typeof v.title === 'string' && typeof v.registration_open === 'boolean' &&
    ['description', 'city', 'start_date', 'end_date'].every(key => v[key as keyof Occurrence] === null || typeof v[key as keyof Occurrence] === 'string')
}
export async function loadOccurrencePage(page: number, signal: AbortSignal) {
  const response = await fetch(`/api/admin/event-groups?page=${page}`, { cache: 'no-store', signal })
  if (!response.ok) throw new Error('開催回を取得できませんでした。ログイン状態を確認してください。')
  const data = await response.json()
  if (!Array.isArray(data.eventGroups) || !data.eventGroups.every(validOccurrence) || data.page !== page ||
    !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.pageSize) || data.pageSize <= 0 ||
    new Set(data.eventGroups.map((v: Occurrence) => v.id)).size !== data.eventGroups.length ||
    data.eventGroups.length !== Math.min(data.pageSize, Math.max(data.total - (page - 1) * data.pageSize, 0))) throw new Error('開催回の情報を確認できませんでした。')
  return data as { eventGroups: Occurrence[]; page: number; pageSize: number; total: number }
}
export async function findOccurrence(id: number, signal: AbortSignal): Promise<Occurrence> {
  for (let page = 1; page <= 1000; page++) {
    const data = await loadOccurrencePage(page, signal)
    const found = data.eventGroups.find(v => v.id === id)
    if (found) return found
    if (page * data.pageSize >= data.total) break
  }
  throw new Error('開催回が見つからないか、取得範囲を超えています。一覧から再確認してください。')
}
export async function loadClassSummary(id: number, signal: AbortSignal): Promise<ClassSummary> {
  let total: number | undefined
  let count = 0, bookings = 0
  const ids = new Set<number>(), classDates: unknown[] = []
  for (let page = 1; page <= 100; page++) {
    const response = await fetch(`/api/admin/event-groups/${id}/classes?page=${page}`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error('クラス集計を取得できませんでした')
    const data = await response.json()
    if (!Array.isArray(data.schedules) || data.page !== page || !Number.isSafeInteger(data.total) || data.total < 0 ||
      !Number.isSafeInteger(data.pageSize) || data.pageSize <= 0 || (total !== undefined && total !== data.total) ||
      data.schedules.length !== Math.min(data.pageSize, Math.max(data.total - (page - 1) * data.pageSize, 0))) throw new Error('集計を確認できませんでした')
    total = data.total
    for (const row of data.schedules) {
      if (!Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id) || !Number.isSafeInteger(row.registeredCount) || row.registeredCount < 0) throw new Error('集計を確認できませんでした')
      ids.add(row.id); classDates.push(row.date); count++; bookings += row.registeredCount
      if (!Number.isSafeInteger(bookings)) throw new Error('集計範囲を超えています')
    }
    if (count === total) return { classCount: total, activeClassBookings: bookings, classDates }
  }
  throw new Error('集計の取得範囲を超えています')
}
