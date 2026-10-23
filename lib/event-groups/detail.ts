export type DetailClass = { id: number; title: string; date: string; start_time: string | null; location: string; capacity: number | null; registeredCount: number; registration_enabled: boolean }
function valid(value: unknown): value is DetailClass {
  if (!value || typeof value !== 'object') return false
  const v = value as DetailClass
  return Number.isSafeInteger(v.id) && v.id > 0 && ['title', 'date', 'location'].every(k => typeof v[k as keyof DetailClass] === 'string') && (v.start_time === null || typeof v.start_time === 'string') && (v.capacity === null || (Number.isSafeInteger(v.capacity) && v.capacity > 0)) && Number.isSafeInteger(v.registeredCount) && v.registeredCount >= 0 && typeof v.registration_enabled === 'boolean'
}
// Complete reads only: never classify a paginated first row as a standalone event.
export async function loadDetailClasses(id: number, signal: AbortSignal): Promise<DetailClass[]> {
  const rows: DetailClass[] = [], ids = new Set<number>()
  let total: number | undefined
  for (let page = 1; page <= 100; page++) {
    const response = await fetch(`/api/admin/event-groups/${id}/classes?page=${page}`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error('class read failed')
    const data = await response.json()
    if (!Array.isArray(data.schedules) || data.page !== page || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.pageSize) || data.pageSize <= 0 || (total !== undefined && total !== data.total) || data.schedules.length !== Math.min(data.pageSize, Math.max(data.total - (page - 1) * data.pageSize, 0))) throw new Error('incomplete class read')
    total = data.total
    for (const row of data.schedules) { if (!valid(row) || ids.has(row.id)) throw new Error('invalid class'); ids.add(row.id); rows.push(row) }
    if (rows.length === total) return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.start_time ?? '').localeCompare(b.start_time ?? '') || a.id - b.id)
  }
  throw new Error('class read limit exceeded')
}
