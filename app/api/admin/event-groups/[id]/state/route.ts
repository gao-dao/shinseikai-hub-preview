import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { validLifecycle, validStateCommand } from '@/lib/event-groups/lifecycle'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers })
type Context = { params: Promise<{ id: string }> }
const validId = (s: string) => /^[1-9][0-9]*$/.test(s) && Number.isSafeInteger(Number(s))
export async function GET(_request: Request, context: Context) {
  try {
    const auth = await requireAdmin(); if (!auth.ok) return fail(auth.error, auth.status)
    const { id } = await context.params; if (!validId(id)) return fail('開催回IDが不正です', 400)
    const client = await createClient()
    const { data, error } = await client.from('event_groups').select('id, title, is_cancelled, is_hidden, registration_open, state_version').eq('id', Number(id)).maybeSingle()
    if (error) return fail('状態を確認できませんでした', 503)
    if (!data) return fail('開催回が見つかりません', 404)
    if (!validLifecycle(data) || data.id !== Number(id) || typeof data.title !== 'string') return fail('状態を確認できませんでした', 503)
    const history = await client.from('registrations').select('id', { count: 'exact', head: true }).eq('event_group_id', Number(id))
    if (history.error || !Number.isSafeInteger(history.count) || history.count === null || history.count < 0) return fail('申込履歴件数を確認できないため操作できません', 503)
    return NextResponse.json({ eventGroup: data, registrationCount: history.count }, { headers })
  } catch { return fail('状態を確認できませんでした', 503) }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const auth = await requireAdmin(); if (!auth.ok) return fail(auth.error, auth.status)
    const { id } = await context.params; if (!validId(id)) return fail('開催回IDが不正です', 400)
    if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') return fail('許可されていないリクエストです', 403)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('JSON形式で送信してください', 415)
    let body: unknown; try { body = await request.json() } catch { return fail('入力内容が不正です', 400) }
    if (!validStateCommand(body)) return fail('状態変更の指定が不正です', 400)
    const client = await createClient()
    const { data, error } = await client.rpc('admin_set_event_group_state', { p_group_id: Number(id), p_action: body.action, p_expected_version: body.expected_state_version })
    if (error) return fail(error.code === 'PT409' || ['40001','40P01'].includes(error.code) ? '他の操作で状態が変わりました。最新情報を再取得してください。' : '状態を変更できませんでした。最新情報を確認してください。', error.code === 'PT404' ? 404 : error.code === '42501' ? 403 : error.code === 'PT409' || ['40001','40P01'].includes(error.code) ? 409 : error.code === '22023' ? 400 : 503)
    if (!validLifecycle(data) || data.id !== Number(id) || data.registration_open || (body.action === 'cancel' && !data.is_cancelled) || (body.action === 'hide' && !data.is_hidden) || (body.action === 'show' && data.is_hidden)) return fail('変更結果を確認できません。最新情報を再取得してください。', 503)
    return NextResponse.json({ eventGroup: data }, { headers })
  } catch { return fail('変更結果が不明です。再送せず最新情報を再取得してください。', 503) }
}
