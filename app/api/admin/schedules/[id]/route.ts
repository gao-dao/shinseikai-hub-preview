import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { validateNewSchedule } from '@/lib/schedules/new-schedule'
import { scheduleEditRestriction } from '@/lib/schedules/edit-schedule'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
const fields = ['title', 'date', 'start_time', 'end_time', 'location', 'type', 'event_group_id', 'capacity', 'registration_enabled'] as const

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers })
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return fail(authorization.error, authorization.status)
    const { id } = await context.params
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) return fail('予定IDが不正です', 400)
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return fail('許可されていないリクエストです', 403)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('JSON形式で送信してください', 415)
    let body: unknown
    try { body = await request.json() } catch { return fail('JSON形式が不正です', 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('入力内容が不正です', 400)
    const { expected, ...changes } = body as Record<string, unknown>
    if (Object.keys(changes).length === 0 || Object.keys(changes).some(key => !fields.some(field => field === key))) return fail('更新項目が不正です', 400)

    const supabase = await createClient()
    const { data: row, error: readError } = await supabase.from('schedules')
      .select(`title, date, start_time, end_time, location, type, event_group_id, capacity, registration_enabled,
        history_items:registration_items!registration_items_schedule_group_fkey(count),
        active_items:registration_items!registration_items_schedule_group_fkey(count)`)
      .eq('id', Number(id)).eq('active_items.status', 'active').maybeSingle()
    if (readError) return fail('予定・申込状況を確認できませんでした', 500)
    if (!row) return fail('予定が見つかりません', 404)
    const { history_items, active_items, ...original } = row
    const historyCount = history_items?.[0]?.count
    const activeCount = active_items?.[0]?.count
    if (!Number.isSafeInteger(historyCount) || !Number.isSafeInteger(activeCount) || historyCount < 0 || activeCount < 0 || activeCount > historyCount) {
      return fail('申込状況を確認できないため更新できません', 500)
    }
    if (expected !== undefined) {
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length !== fields.length || Object.keys(expected).some(key => !fields.some(field => field === key))) return fail('編集前の予定情報が不正です', 400)
      if (fields.some(key => (expected as Record<string, unknown>)[key] !== original[key])) return fail('予定が別の操作で変更されています。一覧を再取得して編集し直してください', 409)
    }
    const validation = validateNewSchedule({ ...original, ...changes })
    if (!validation.data) return fail(validation.error, 400)
    const payload = validation.data
    const restriction = scheduleEditRestriction(payload, original, { hasRegistrationHistory: historyCount > 0, activeRegistrationCount: activeCount })
    if (restriction) return fail(restriction, 409)
    if (payload.event_group_id !== null) {
      const { data, error } = await supabase.from('event_groups').select('id').eq('id', payload.event_group_id).maybeSingle()
      if (error) return fail('講習会グループを確認できませんでした', 500)
      if (!data) return fail('指定した講習会グループは存在しません', 400)
    }

    // One atomic UPDATE. Compare the read snapshot so another administrator's
    // changes during this request are not silently overwritten. Foreign keys and
    // the capacity trigger remain the final guard against concurrent submissions.
    let update = supabase.from('schedules').update(payload).eq('id', Number(id))
    for (const key of fields) {
      update = original[key] === null ? update.is(key, null) : update.eq(key, original[key])
    }
    const { data, error } = await update.select('id').maybeSingle()
    if (error) {
      if (error.code === '23503') return fail('申込履歴または講習会グループの状態が変わったため更新できません。一覧を再取得してください', 409)
      if (error.code === '23514') return fail('定員や受付設定が現在の申込状況と一致しないため更新できません。一覧を再取得してください', 409)
      if (error.code === '40001' || error.code === '40P01') return fail('別の操作と競合しました。一覧を再取得してから再操作してください', 409)
      return fail('予定を更新できませんでした', 500)
    }
    if (!data) return fail('予定が変更または削除されたため更新できません。一覧を再取得してください', 409)
    return NextResponse.json({ schedule: data }, { headers })
  } catch {
    return fail('予定を更新できませんでした', 500)
  }
}
