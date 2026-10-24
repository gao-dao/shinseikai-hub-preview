import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { tokyoDay } from './presentation'
import { classifyIndex, indexMatches, sortIndex, type IndexGroup, type IndexOptions, type IndexResult } from './admin-index'
const batch = 100, dateBatch = 500
export const indexPageSize = 20
// Called only after requireAdmin in both page entry points. Uses the caller's SSR
// session and existing RLS, never a service-role client or an applicant query.
export async function loadAdminIndex(options: IndexOptions, client?: Awaited<ReturnType<typeof createClient>>, today = tokyoDay()): Promise<IndexResult> {
  const db = client ?? await createClient()
  const matches = []
  const seenGroups = new Set<number>()
  let expectedGroups: number | undefined
  for (let offset = 0; offset < 10000; offset += batch) {
    let query = db.from('event_groups').select('id,title,city,start_date,end_date,is_cancelled,is_hidden', { count: 'exact' })
    if (!options.history) query = query.eq('is_cancelled', false).eq('is_hidden', false)
    else {
      if (options.q) query = query.ilike('title', `%${options.q.replace(/[\\%_]/g, '\\$&')}%`)
      if (options.state === 'cancelled') query = query.eq('is_cancelled', true)
      else if (options.state === 'hidden') query = query.eq('is_hidden', true)
      else if (options.state === 'ended') query = query.lt('end_date', today)
      else query = query.or(`is_cancelled.eq.true,is_hidden.eq.true,end_date.lt.${today}`)
    }
    const { data, error, count } = await query.order('id').range(offset, offset + batch - 1)
    if (error || !data || count === null || !Number.isSafeInteger(count) || count < 0 || (expectedGroups !== undefined && expectedGroups !== count) || data.length !== Math.min(batch, Math.max(count-offset,0))) throw new Error('incomplete groups')
    expectedGroups = count
    const groups = data as IndexGroup[]
    for (const group of groups) {
      if (!Number.isSafeInteger(group.id) || group.id <= 0 || seenGroups.has(group.id) || typeof group.title !== 'string' || typeof group.is_cancelled !== 'boolean' || typeof group.is_hidden !== 'boolean') throw new Error('invalid group')
      seenGroups.add(group.id)
    }
    const dates = new Map<number, unknown[]>(groups.map(group => [group.id, []]))
    if (groups.length) {
      const seenDates = new Set<number>()
      let expectedDates: number | undefined
      let complete = false
      for (let start = 0; start < 100000; start += dateBatch) {
        const { data: rows, error, count } = await db.from('schedules').select('id,event_group_id,date', { count: 'exact' })
          .in('event_group_id', groups.map(group => group.id)).order('id').range(start, start + dateBatch - 1)
        if (error || !rows || count === null || !Number.isSafeInteger(count) || count < 0 || (expectedDates !== undefined && expectedDates !== count) || rows.length !== Math.min(dateBatch,Math.max(count-start,0))) throw new Error('incomplete class dates')
        expectedDates = count
        for (const row of rows) {
          if (!Number.isSafeInteger(row.id) || row.id <= 0 || seenDates.has(row.id) || !dates.has(row.event_group_id)) throw new Error('invalid class dates')
          seenDates.add(row.id); dates.get(row.event_group_id)!.push(row.date)
        }
        if (seenDates.size === count) { complete = true; break }
      }
      if (!complete) throw new Error('class date read limit')
    }
    for (const group of groups) {
      const item = classifyIndex(group, dates.get(group.id)!, today)
      if (indexMatches(item, options)) matches.push(item)
    }
    if (seenGroups.size === count) {
      const sorted = sortIndex(matches, options.history), start = (options.page-1)*indexPageSize
      return { items: sorted.slice(start,start+indexPageSize), total: sorted.length, upcoming: sorted.filter(item=>item.phase==='upcoming').length, review: sorted.filter(item=>item.phase==='unknown').length, page: options.page, pageSize: indexPageSize }
    }
  }
  throw new Error('group read limit')
}
