import 'server-only'
import { createAnonymousClient } from '@/lib/supabase/anonymous'
import { publicClassAvailability, type PublicClass } from '@/lib/registrations/public-availability'

export type ReceptionDisplay = { label: string; tone: 'open' | 'full' | 'closed' | 'unknown' }
export type GuideReceptionClass = { id: number; date: string; type?: string | null; capacity: number | null; registration_enabled: boolean }
type Client = ReturnType<typeof createAnonymousClient>
type Availability = { schedule_id: number; capacity: number; registered_count: number; remaining_capacity: number; is_full: boolean }
const unknown: ReceptionDisplay = { label: '申込状況を確認できません', tone: 'unknown' }

// Display aggregation only; canRegister and class statuses still come from the existing helper.
export function guideReceptionDisplay(registrationOpen: boolean, classes: Pick<PublicClass, 'canRegister' | 'status'>[]): ReceptionDisplay {
  if (!registrationOpen) return { label: '受付停止中', tone: 'closed' }
  if (classes.some(item => item.canRegister)) return { label: '受付中', tone: 'open' }
  const eligible = classes.filter(item => item.status !== 'クラス受付停止中')
  if (classes.length && !eligible.length) return { label: '受付停止中', tone: 'closed' }
  if (eligible.some(item => item.status === '残席確認不可')) return unknown
  if (eligible.length && eligible.every(item => item.status === '満員')) return { label: '満員', tone: 'full' }
  return { label: '現在受付できません', tone: 'unknown' }
}

export async function loadGuideReception(groupId: number, registrationOpen: boolean, rows: GuideReceptionClass[], client: Client, signal = AbortSignal.timeout(3000)): Promise<ReceptionDisplay> {
  if (!registrationOpen) return guideReceptionDisplay(false, [])
  if (rows.some(row => typeof row.registration_enabled !== 'boolean' || (row.capacity !== null && (!Number.isInteger(row.capacity) || row.capacity <= 0)))) return unknown
  const ids = rows.filter(row => row.registration_enabled && row.capacity !== null).map(row => row.id)
  const availability: Availability[] = []
  if (ids.length) {
    // The listing shares one deadline; bounded pages avoid Data API row-limit truncation.
    try {
      for (let offset = 0; offset < ids.length; offset += 50) {
        if (signal.aborted) throw new Error('availability timeout')
        const batch = ids.slice(offset, offset + 50)
        const result = await client.rpc('get_event_group_availability', { p_event_group_id: groupId })
          .in('schedule_id', batch).range(0, batch.length - 1).abortSignal(signal)
        if (result.error || !Array.isArray(result.data) || result.data.some(row => !row || !Number.isSafeInteger(row.schedule_id))) throw new Error('availability unavailable')
        availability.push(...result.data as Availability[])
      }
    } catch { return unknown }
  }
  const classes = rows.map(row => {
    const matches = availability.filter(item => item.schedule_id === row.id)
    return publicClassAvailability({ ...row, title: '', start_time: null, end_time: null }, matches.length === 1 ? matches[0] : undefined)
  })
  return guideReceptionDisplay(true, classes)
}
