import 'server-only'
import { createAnonymousClient } from '@/lib/supabase/anonymous'
import { occurrencePhase, tokyoDay } from '@/lib/event-groups/presentation'
import { validGroup, minuteTime, type GuideGroup } from '@/lib/event-groups/public-guide'

type Client = ReturnType<typeof createAnonymousClient>
type ClassMetadata = { id: number; event_group_id: number; date: string; type: string }
type Independent = { id: number; event_group_id: null; title: string; date: string; start_time: string | null; end_time: string | null; location: string; type: string }
export type ScheduleItem = { key: string; title: string; date: string; period: string; place: string; type: string; href: string | null }
const groupBatch = 50
const rowBatch = 500
const readLimit = 100000

// Detect truncated responses instead of publishing a type/date based on partial classes.
function completePage<T extends { id: number }>(data: T[] | null, error: unknown, count: number | null, offset: number, size: number, expected: number | undefined, seen: Set<number>): data is T[] {
  if (error || !data || count === null || !Number.isSafeInteger(count) || count < 0 || (expected !== undefined && count !== expected) || data.length !== Math.min(size, Math.max(count - offset, 0))) throw new Error('incomplete schedule metadata')
  for (const row of data) {
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || seen.has(row.id)) throw new Error('invalid schedule metadata')
    seen.add(row.id)
  }
  return true
}
function classType(rows: ClassMetadata[]) {
  const types = new Set(rows.map(row => row.type))
  if ([...types].some(type => type !== '稽古会' && type !== '一般参加')) return null
  return types.size === 2 ? '稽古会・一般参加' : rows[0]?.type ?? null
}
async function classesFor(client: Client, ids: number[]) {
  const rows = new Map<number, ClassMetadata[]>(ids.map(id => [id, []]))
  const seen = new Set<number>()
  let expected: number | undefined
  for (let offset = 0; offset < readLimit; offset += rowBatch) {
    const { data, error, count } = await client.from('schedules').select('id,event_group_id,date,type', { count: 'exact' })
      .in('event_group_id', ids).order('id').range(offset, offset + rowBatch - 1)
    if (completePage(data, error, count, offset, rowBatch, expected, seen)) {
      expected = count!
      for (const row of data) {
        if (!rows.has(row.event_group_id)) throw new Error('unexpected occurrence')
        rows.get(row.event_group_id)!.push(row as ClassMetadata)
      }
      if (seen.size === count) return rows
    }
  }
  throw new Error('class metadata read limit')
}
export async function loadScheduleIndex(client = createAnonymousClient(), today = tokyoDay()) {
  const items: ScheduleItem[] = []
  let expected: number | undefined
  const seen = new Set<number>()
  let groupsComplete = false
  // Preserve historical entries. Existing public detail pages accept upcoming groups only.
  for (let offset = 0; offset < readLimit; offset += groupBatch) {
    const { data, error, count } = await client.from('event_groups')
      .select('id,title,city,start_date,end_date,is_cancelled,is_hidden', { count: 'exact' })
      .eq('is_cancelled', false).eq('is_hidden', false).not('start_date', 'is', null).not('end_date', 'is', null)
      .order('id').range(offset, offset + groupBatch - 1)
    if (completePage(data, error, count, offset, groupBatch, expected, seen)) {
      expected = count!
      const groups = data as GuideGroup[]
      const classes = groups.length ? await classesFor(client, groups.map(row => row.id)) : new Map<number, ClassMetadata[]>()
      for (const group of groups) {
        if (!validGroup(group) || group.is_cancelled !== false || group.is_hidden !== false) continue
        const rows = classes.get(group.id)!
        const phase = occurrencePhase(group, rows.map(row => row.date), today)
        const type = classType(rows)
        if (phase === 'unknown' || !type) continue
        items.push({ key: `group-${group.id}`, title: group.title, date: group.start_date,
          period: group.start_date === group.end_date ? group.start_date : `${group.start_date}〜${group.end_date}`,
          place: group.city ?? '', type, href: phase === 'upcoming' ? `/events/${group.id}` : null })
      }
      if (seen.size === count) { groupsComplete = true; break }
    }
  }
  if (!groupsComplete) throw new Error('occurrence read limit')
  expected = undefined; seen.clear()
  for (let offset = 0; offset < readLimit; offset += rowBatch) {
    const { data, error, count } = await client.from('schedules')
      .select('id,event_group_id,title,date,start_time,end_time,location,type', { count: 'exact' })
      .is('event_group_id', null).order('id').range(offset, offset + rowBatch - 1)
    if (completePage(data, error, count, offset, rowBatch, expected, seen)) {
      expected = count!
      for (const row of data as Independent[]) {
        if (row.event_group_id !== null) throw new Error('unexpected linked class')
        const start = minuteTime(row.start_time), end = minuteTime(row.end_time)
        const time = start ? `${start}${end ? `〜${end}` : ''}` : end ? `終了 ${end}` : ''
        items.push({ key: `schedule-${row.id}`, title: row.title, date: row.date ?? '',
          period: [row.date || '日付未設定', time].filter(Boolean).join(' '), place: row.location ?? '', type: row.type, href: null })
      }
      if (seen.size === count) return items.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.period.localeCompare(b.period) || a.key.localeCompare(b.key))
    }
  }
  throw new Error('independent schedule read limit')
}
