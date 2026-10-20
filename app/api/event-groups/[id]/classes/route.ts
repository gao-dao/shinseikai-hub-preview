import { NextResponse } from 'next/server'
import { createAnonymousClient } from '@/lib/supabase/anonymous'
import { publicClassAvailability } from '@/lib/registrations/public-availability'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store, max-age=0' }
const pageSize = 50

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers })
  try {
    const { id } = await context.params
    const value = new URL(request.url).searchParams.get('page') ?? '1'
    const page = Number(value)
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)) || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(page) || page > 1_000_000) return fail('講習会IDまたはページ番号が不正です', 400)
    const supabase = createAnonymousClient()
    const { data: group, error: groupError } = await supabase.from('event_groups').select('id')
      .eq('id', Number(id)).eq('registration_open', true).maybeSingle()
    if (groupError) return fail('講習会を確認できませんでした', 500)
    if (!group) return fail('受付中の講習会が見つかりません', 404)
    const { data, error, count } = await supabase.from('schedules')
      .select('id, title, date, start_time, end_time, capacity, registration_enabled', { count: 'exact' })
      .eq('event_group_id', Number(id)).order('date', { ascending: true }).order('start_time', { ascending: true }).order('id', { ascending: true })
      .range((page - 1) * pageSize, page * pageSize - 1)
    if (error || !data || count === null || !Number.isSafeInteger(count) || count < 0) return fail('クラスを取得できませんでした', 500)

    // Fetch counts only through the safe RPC, limited to this schedule page so
    // even groups exceeding the Data API row limit have no missing availability.
    let availability: Awaited<ReturnType<typeof readAvailability>> = null
    if (data.length > 0) {
      try { availability = await readAvailability() } catch { /* Unknown seats stay unavailable. */ }
    }
    async function readAvailability() {
      const result = await supabase.rpc('get_event_group_availability', { p_event_group_id: Number(id) }).in('schedule_id', data!.map(item => item.id))
      return result.error || !Array.isArray(result.data) ? null : result.data as { schedule_id: number; capacity: number; registered_count: number; remaining_capacity: number; is_full: boolean }[]
    }
    const schedules = data.map(schedule => {
      const matches = availability?.filter(item => item.schedule_id === schedule.id) ?? []
      return publicClassAvailability(schedule, matches.length === 1 ? matches[0] : undefined)
    })
    return NextResponse.json({ schedules, page, pageSize, total: count }, { headers })
  } catch {
    return fail('クラス・残席を確認できませんでした', 500)
  }
}
