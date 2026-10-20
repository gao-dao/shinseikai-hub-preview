import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { validateNewSchedule } from '@/lib/schedules/new-schedule'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
const pageSize = 50

export async function POST(request: Request) {
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers })
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return fail(authorization.error, authorization.status)
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return fail('許可されていないリクエストです', 403)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('JSON形式で送信してください', 415)
    let body: unknown
    try { body = await request.json() } catch { return fail('JSON形式が不正です', 400) }
    const validation = validateNewSchedule(body)
    if (!validation.data) return fail(validation.error, 400)
    const payload = validation.data
    const supabase = await createClient()
    if (payload.event_group_id !== null) {
      const { data, error } = await supabase.from('event_groups').select('id').eq('id', payload.event_group_id).maybeSingle()
      if (error) return fail('講習会グループを確認できませんでした', 500)
      if (!data) return fail('指定した講習会グループは存在しません', 400)
    }
    const { data, error } = await supabase.from('schedules').insert(payload).select('id').single()
    if (error) return fail(error.code === '23503' ? '講習会グループの状態が変わりました。選択肢を再取得してください' : '予定を作成できませんでした', error.code === '23503' ? 409 : 500)
    if (!data) return fail('予定の作成結果を確認できませんでした', 500)
    return NextResponse.json({ schedule: data }, { status: 201, headers })
  } catch {
    return fail('予定を作成できませんでした', 500)
  }
}

export async function GET(request: Request) {
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) {
      return NextResponse.json({ error: authorization.error }, { status: authorization.status, headers })
    }
    const value = new URL(request.url).searchParams.get('page') ?? '1'
    const page = Number(value)
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(page) || page > 1_000_000) {
      return NextResponse.json({ error: 'ページ番号が不正です' }, { status: 400, headers })
    }

    const supabase = await createClient()
    // Count in PostgreSQL rather than downloading items: row limits must not
    // truncate counts. Left embeds preserve schedules with no group or history.
    const { data, error, count } = await supabase.from('schedules')
      .select(`
        id, title, date, start_time, end_time, location, type,
        event_group_id, capacity, registration_enabled,
        event_groups!schedules_event_group_id_fkey(id, title),
        history_items:registration_items!registration_items_schedule_group_fkey(count),
        active_items:registration_items!registration_items_schedule_group_fkey(count)
      `, { count: 'exact' })
      .eq('active_items.status', 'active')
      .order('date', { ascending: true }).order('id', { ascending: true })
      .range((page - 1) * pageSize, page * pageSize - 1)

    if (error || !data || count === null) throw new Error('Schedule query failed')
    const schedules = data.map(({ history_items, active_items, ...schedule }) => {
      const historyCount = history_items?.[0]?.count
      const activeCount = active_items?.[0]?.count
      // Missing aggregates are unknown, never equivalent to zero history.
      if (!Number.isSafeInteger(historyCount) || !Number.isSafeInteger(activeCount) ||
          historyCount < 0 || activeCount < 0 || activeCount > historyCount) {
        throw new Error('Invalid registration counts')
      }
      return { ...schedule, activeRegistrationCount: activeCount, hasRegistrationHistory: historyCount > 0 }
    })
    return NextResponse.json({ schedules, page, pageSize, total: count }, { headers })
  } catch {
    return NextResponse.json({ error: '予定・申込状況を取得できませんでした' }, { status: 500, headers })
  }
}
