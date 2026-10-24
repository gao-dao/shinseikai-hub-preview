import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
type Context = { params: Promise<{ id: string }> }
type Client = Awaited<ReturnType<typeof createClient>>

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers })
}

function validId(id: string) {
  return /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id))
}

async function openingCondition(supabase: Client, id: number): Promise<string | null> {
  // Exact HEAD counts do not download schedules and cannot be truncated by the
  // Data API row limit. Check every enabled class, including invalid legacy data.
  const results = await Promise.all([
    supabase.from('schedules').select('id', { count: 'exact', head: true }).eq('event_group_id', id),
    supabase.from('schedules').select('id', { count: 'exact', head: true }).eq('event_group_id', id).eq('registration_enabled', true),
    supabase.from('schedules').select('id', { count: 'exact', head: true }).eq('event_group_id', id).eq('registration_enabled', true).or('capacity.is.null,capacity.lte.0'),
  ])
  if (results.some(result => result.error || result.count === null || !Number.isSafeInteger(result.count) || result.count < 0)) throw new Error('Opening information unavailable')
  const [all, enabled, invalid] = results.map(result => result.count!)
  if (enabled > all || invalid > enabled) throw new Error('Inconsistent opening information')
  if (all === 0) return '所属する予定がないため受付を開始できません。予定を関連付けてください。'
  if (enabled === 0) return '受付対象のクラスがありません。予定のクラス受付を有効にしてください。'
  if (invalid > 0) return '受付対象クラスに正の定員が設定されていないため受付を開始できません。'
  return null
}

// The screen checks eligibility before confirmation; PATCH independently checks
// again. This endpoint contains no applicant information.
export async function GET(_request: Request, context: Context) {
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return fail(authorization.error, authorization.status)
    const { id } = await context.params
    if (!validId(id)) return fail('講習会グループIDが不正です', 400)
    const supabase = await createClient()
    const { data, error } = await supabase.from('event_groups').select('id, registration_open, is_cancelled, is_hidden, state_version').eq('id', Number(id)).maybeSingle()
    if (error) return fail('講習会グループを確認できませんでした', 500)
    if (!data) return fail('講習会グループが見つかりません', 404)
    if (typeof data.registration_open !== 'boolean') return fail('受付状態を確認できませんでした', 500)
    const reason = data.is_cancelled || data.is_hidden ? '開催中止・非表示中は受付を開始できません。' : await openingCondition(supabase, Number(id))
    return NextResponse.json({ id: data.id, registration_open: data.registration_open, state_version: data.state_version, canOpen: reason === null, reason }, { headers })
  } catch {
    return fail('受付開始に必要な情報を確認できませんでした', 500)
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return fail(authorization.error, authorization.status)
    const { id } = await context.params
    if (!validId(id)) return fail('講習会グループIDが不正です', 400)
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return fail('許可されていないリクエストです', 403)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('JSON形式で送信してください', 415)
    let body: unknown
    try { body = await request.json() } catch { return fail('JSON形式が不正です', 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('入力内容が不正です', 400)
    const input = body as Record<string, unknown>
    if (Object.keys(input).some(key => key !== 'registration_open' && key !== 'expected_registration_open' && key !== 'expected_state_version') ||
        typeof input.registration_open !== 'boolean' || typeof input.expected_registration_open !== 'boolean' || !Number.isSafeInteger(input.expected_state_version) || (input.expected_state_version as number) < 0) return fail('受付状態の指定が不正です', 400)
    const supabase = await createClient()
    const { data: group, error: readError } = await supabase.from('event_groups').select('id, registration_open, is_cancelled, is_hidden, state_version').eq('id', Number(id)).maybeSingle()
    if (readError) return fail('講習会グループを確認できませんでした', 500)
    if (!group) return fail('講習会グループが見つかりません', 404)
    if (typeof group.registration_open !== 'boolean') return fail('受付状態を確認できませんでした', 500)
    if (group.state_version !== input.expected_state_version) return fail('開催状態が変更されています。最新情報を再取得してください。', 409)
    if (group.registration_open !== input.expected_registration_open) return fail('受付状態が別の操作で変更されています。一覧を再取得してください', 409)
    if (input.registration_open && (group.is_cancelled || group.is_hidden)) return fail('開催中止・非表示中は受付を開始できません。', 409)
    if (input.registration_open) {
      const reason = await openingCondition(supabase, Number(id))
      if (reason) return fail(reason, 409)
    }
    // Stopping is independent of classes and applicant history. Only this column
    // is changed; optimistic matching prevents overwriting another state change.
    const { data, error } = await supabase.from('event_groups')
      .update({ registration_open: input.registration_open })
      .eq('id', Number(id)).eq('registration_open', input.expected_registration_open).eq('state_version', input.expected_state_version)
      .select('id, registration_open, is_cancelled, is_hidden, state_version').maybeSingle()
    if (error) return fail('受付状態を更新できませんでした', ['23514', '40001', '40P01'].includes(error.code) ? 409 : 500)
    if (!data) return fail('受付状態が変更またはグループが削除されました。一覧を再取得してください', 409)
    if (data.id !== Number(id) || data.registration_open !== input.registration_open) return fail('受付状態の更新結果を確認できませんでした', 500)
    return NextResponse.json({ eventGroup: data }, { headers })
  } catch {
    return fail('受付状態を更新できませんでした。登録状況を確認してから再操作してください', 500)
  }
}
