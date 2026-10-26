import { occurrencePhase, type OccurrencePhase } from './presentation'
export type IndexGroup = { id: number; title: string; city: string | null; start_date: string | null; end_date: string | null; is_cancelled: boolean; is_hidden: boolean }
export type IndexItem = IndexGroup & { phase: OccurrencePhase }
export type IndexOptions = { history: boolean; page: number; q: string; state: 'all' | 'ended' | 'cancelled' | 'hidden' }
export type IndexResult = { items: IndexItem[]; total: number; upcoming: number; review: number; page: number; pageSize: number }
export function indexOptions(history: boolean, params: Record<string, unknown> = {}): IndexOptions {
  const raw = params.page ?? '1', q = params.q ?? '', state = params.state ?? 'all'
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 1000 || typeof q !== 'string' || q.length > 100 || typeof state !== 'string' || !['all','ended','cancelled','hidden'].includes(state)) throw new Error('invalid filters')
  return { history, page: Number(raw), q: history ? q.trim() : '', state: history ? state as IndexOptions['state'] : 'all' }
}
export function classifyIndex(group: IndexGroup, dates: readonly unknown[], today: string): IndexItem {
  return { ...group, phase: occurrencePhase(group, dates, today) }
}
export function indexMatches(item: IndexItem, options: IndexOptions) {
  if (!options.history) return !item.is_cancelled && !item.is_hidden && item.phase !== 'ended'
  if (options.state === 'ended') return item.phase === 'ended'
  if (options.state === 'cancelled') return item.is_cancelled
  if (options.state === 'hidden') return item.is_hidden
  return item.phase === 'ended' || item.is_cancelled || item.is_hidden
}
export function indexLabels(item: IndexItem) {
  return [item.phase === 'ended' ? '開催終了' : item.phase === 'unknown' ? '日付要確認' : '', item.is_cancelled ? '開催中止' : '', item.is_hidden ? '非表示' : ''].filter(Boolean)
}
export function sortIndex(items: IndexItem[], history: boolean) {
  return [...items].sort((a,b) => {
    if (!history && (a.phase === 'unknown') !== (b.phase === 'unknown')) return a.phase === 'unknown' ? 1 : -1
    const left = a.start_date ?? (history ? '' : '9999-99-99'), right = b.start_date ?? (history ? '' : '9999-99-99')
    return (history ? right.localeCompare(left) : left.localeCompare(right)) || a.id - b.id
  })
}
export function indexHref(options: IndexOptions, page: number) {
  const query = new URLSearchParams()
  if (options.history && options.q) query.set('q',options.q)
  if (options.history && options.state !== 'all') query.set('state',options.state)
  if (page > 1) query.set('page',String(page))
  return `/admin/event-groups${options.history ? '/history' : ''}${query.size ? `?${query}` : ''}`
}

// Only canonical history filters may cross detail/edit routes. Never redirect to arbitrary URLs.
export function adminReturnHref(value: unknown): string {
  const fallback = '/admin/event-groups', history = '/admin/event-groups/history'
  if (value === fallback || value === undefined) return fallback
  if (typeof value !== 'string' || value.length > 2048 || /[\\#\u0000-\u001f\u007f]/.test(value)) return fallback
  const [path, query = '', ...extra] = value.split('?')
  if (path !== history || extra.length) return fallback
  const params = new URLSearchParams(query)
  for (const key of params.keys()) {
    if (!['q','state','page'].includes(key) || params.getAll(key).length !== 1 || /[\u0000-\u001f\u007f]/.test(params.get(key) ?? '')) return fallback
  }
  try {
    const options = indexOptions(true, Object.fromEntries(params))
    return indexHref(options, options.page)
  } catch { return fallback }
}
