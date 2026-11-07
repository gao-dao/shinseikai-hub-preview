import 'server-only'
import { createAnonymousClient } from '@/lib/supabase/anonymous'
import { guideToday, publishable, validGroup, sortClasses, classType, practiceParticipationNotice, type GuideGroup, type GuideClass } from './public-guide'

type Client = ReturnType<typeof createAnonymousClient>
const columns = 'id,title,description,participation_notes,city,start_date,end_date,registration_open,is_cancelled,is_hidden'
const batchSize = 50
const classBatch = 500
export const guidePageSize = 20

// No visitor cookies or service credentials. No applicant, capacity or availability reads.
function candidates(client: Client, today: string) {
  return client.from('event_groups').select(columns).eq('is_hidden', false).eq('is_cancelled', false)
    .gte('end_date', today).not('start_date', 'is', null).not('end_date', 'is', null)
}
async function classMetadata(client: Client, ids: number[]) {
  const rows = new Map<number, { date: string; type?: string | null }[]>(ids.map(id => [id, []]))
  const seen = new Set<number>()
  let expected: number | undefined
  for (let offset = 0; offset < 100000; offset += classBatch) {
    const { data, error, count } = await client.from('schedules').select('id,event_group_id,date,type', { count: 'exact' })
      .in('event_group_id', ids).order('id').range(offset, offset + classBatch - 1)
    if (error || !data || count === null || !Number.isSafeInteger(count) || count < 0 || (expected !== undefined && count !== expected) || data.length !== Math.min(classBatch, Math.max(count - offset, 0))) throw new Error('incomplete class dates')
    expected = count
    for (const row of data) {
      if (!rows.has(row.event_group_id) || seen.has(row.id)) throw new Error('invalid class dates')
      seen.add(row.id); rows.get(row.event_group_id)!.push({ date: row.date, type: row.type })
    }
    if (seen.size === count) return rows
  }
  throw new Error('class date read limit')
}
export async function loadGuidePage(page: number, client = createAnonymousClient(), today = guideToday()) {
  const start = (page - 1) * guidePageSize
  let eligible = 0
  const items: Array<GuideGroup & { classCount: number; typeLabel: string | null; participationNotice: string | null }> = []
  // Bounded metadata batches; validation precedes visitor-facing pagination.
  // Deep pages rescan preceding candidates; an aggregate read-only RPC could optimize this later.
  for (let offset = 0; offset < 10000; offset += batchSize) {
    const { data, error } = await candidates(client, today).order('start_date').order('id').range(offset, offset + batchSize - 1)
    if (error || !data) throw new Error('guide unavailable')
    const groups = data as GuideGroup[]
    const metadata = groups.length ? await classMetadata(client, groups.map(group => group.id)) : new Map<number, { date: string; type?: string | null }[]>()
    for (const group of groups) {
      const rows = metadata.get(group.id)!, days = rows.map(row => row.date)
      if (!validGroup(group) || !publishable(group, days, today)) continue
      if (eligible++ < start) continue
      items.push({ ...group, classCount: days.length, typeLabel: classType(rows), participationNotice: practiceParticipationNotice(rows) })
      if (items.length > guidePageSize) return { items: items.slice(0, guidePageSize), hasNext: true, page }
    }
    if (groups.length < batchSize) return { items, hasNext: false, page }
  }
  throw new Error('guide read limit')
}
export async function loadGuideDetail(id: number, client = createAnonymousClient(), today = guideToday()) {
  const { data: group, error } = await candidates(client, today).eq('id', id).maybeSingle()
  if (error) throw new Error('guide unavailable')
  if (!group || !validGroup(group as GuideGroup)) return null
  const rows: GuideClass[] = []
  let expected: number | undefined
  const ids = new Set<number>()
  for (let offset = 0; offset < 100000; offset += classBatch) {
    const { data, error, count } = await client.from('schedules').select('id,event_group_id,title,date,start_time,end_time,location,type', { count: 'exact' })
      .eq('event_group_id', id).order('id').range(offset, offset + classBatch - 1)
    if (error || !data || count === null || !Number.isSafeInteger(count) || count < 0 || (expected !== undefined && expected !== count) || data.length !== Math.min(classBatch, Math.max(count - offset, 0))) throw new Error('incomplete classes')
    expected = count
    for (const row of data) {
      if (row.event_group_id !== id || ids.has(row.id)) throw new Error('invalid classes')
      ids.add(row.id); rows.push(row as GuideClass)
    }
    if (rows.length === count) return publishable(group as GuideGroup, rows.map(row => row.date), today) ? { group: group as GuideGroup, classes: sortClasses(rows) } : null
  }
  throw new Error('class read limit')
}
