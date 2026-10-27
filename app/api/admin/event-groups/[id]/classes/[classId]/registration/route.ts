import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
const validId = (value: string) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))

export async function PATCH(request: Request, context: { params: Promise<{ id: string; classId: string }> }) {
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers })
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return fail(authorization.error, authorization.status)
    const { id, classId } = await context.params
    if (!validId(id) || !validId(classId)) return fail('開催回IDまたはクラスIDが不正です', 400)
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return fail('許可されていないリクエストです', 403)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('JSON形式で送信してください', 415)
    let body: unknown
    try { body = await request.json() } catch { return fail('JSON形式が不正です', 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('受付状態の指定が不正です', 400)
    const input = body as Record<string, unknown>
    if (Object.keys(input).length !== 2 || Object.keys(input).some(key => key !== 'registration_enabled' && key !== 'expected_registration_enabled') ||
      typeof input.registration_enabled !== 'boolean' || typeof input.expected_registration_enabled !== 'boolean' || input.registration_enabled === input.expected_registration_enabled)
      return fail('受付状態の指定が不正です', 400)
    const db = await createClient()
    const { data: current, error: readError } = await db.from('schedules').select('id,event_group_id,registration_enabled')
      .eq('id', Number(classId)).eq('event_group_id', Number(id)).maybeSingle()
    if (readError) return fail('クラスの受付状態を確認できませんでした', 500)
    if (!current) return fail('対象開催回のクラスが見つかりません', 404)
    if (current.registration_enabled !== input.expected_registration_enabled) return fail('受付状態が変更されています。再取得して確認してください', 409)
    // Compare membership AND reception in the atomic UPDATE; never write other fields.
    const { data, error } = await db.from('schedules').update({ registration_enabled: input.registration_enabled })
      .eq('id', Number(classId)).eq('event_group_id', Number(id)).eq('registration_enabled', input.expected_registration_enabled)
      .select('id,event_group_id,registration_enabled').maybeSingle()
    if (error) return fail('受付状態を更新できませんでした。最新状態を再取得してください', ['23503', '23514', '40001', '40P01'].includes(error.code) ? 409 : 500)
    if (!data) return fail('クラスの所属または受付状態が変更されています。再取得して確認してください', 409)
    if (data.id !== Number(classId) || data.event_group_id !== Number(id) || data.registration_enabled !== input.registration_enabled)
      return fail('更新結果を確認できませんでした。最新状態を再取得してください', 500)
    return NextResponse.json({ schedule: data }, { headers })
  } catch {
    return fail('受付状態の変更結果を確認できませんでした。最新状態を再取得してください', 500)
  }
}
