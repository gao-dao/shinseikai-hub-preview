import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { validateEventGroupOccurrenceUpdate } from '@/lib/event-groups/validation'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
const fields = ['city', 'start_date', 'end_date'] as const
const columns = 'id, city, start_date, end_date'
type Context = { params: Promise<{ id: string }> }

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers })
}

export async function PATCH(request: Request, context: Context) {
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return fail(authorization.error, authorization.status)
    const { id } = await context.params
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) return fail('講習会グループIDが不正です', 400)
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return fail('許可されていないリクエストです', 403)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('JSON形式で送信してください', 415)
    let body: unknown
    try { body = await request.json() } catch { return fail('JSON形式が不正です', 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('入力内容が不正です', 400)
    const { expected, ...input } = body as Record<string, unknown>
    if (Object.keys(input).length === 0 || Object.keys(input).some(key => !fields.some(field => field === key))) return fail('更新項目が不正です', 400)
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return fail('編集開始時の開催情報が不正です', 400)
    const snapshot = expected as Record<string, unknown>
    if (Object.keys(snapshot).length !== fields.length ||
        Object.keys(snapshot).some(key => !fields.some(field => field === key)) ||
        fields.some(field => !Object.hasOwn(snapshot, field) || (snapshot[field] !== null && typeof snapshot[field] !== 'string'))) return fail('編集開始時の開催情報が不正です', 400)

    const supabase = await createClient()
    const { data: original, error: readError } = await supabase.from('event_groups')
      .select(columns).eq('id', Number(id)).maybeSingle()
    if (readError) return fail('開催情報を確認できませんでした', 500)
    if (!original) return fail('講習会グループが見つかりません', 404)
    if (original.id !== Number(id) || fields.some(field => original[field] !== null && typeof original[field] !== 'string')) return fail('現在の開催情報を確認できません', 500)
    // Compare raw values: expected is never trimmed or normalized.
    if (fields.some(field => original[field] !== snapshot[field])) return fail('他の管理者によって開催情報が変更されました。一覧を再読み込みして編集し直してください', 409)
    const validation = validateEventGroupOccurrenceUpdate(input, { city: original.city, start_date: original.start_date, end_date: original.end_date })
    if (!validation.data) return fail(validation.error, 400)

    // Compare all occurrence fields in the atomic UPDATE, including omitted ones.
    // Keep the DB-side comparison even after checking the edit-start snapshot.
    let update = supabase.from('event_groups').update(validation.data).eq('id', Number(id))
    for (const field of fields) {
      update = original[field] === null ? update.is(field, null) : update.eq(field, original[field])
    }
    const { data, error } = await update.select(columns).maybeSingle()
    if (error) {
      if (error.code === '40001' || error.code === '40P01') return fail('開催情報が競合しました。一覧を再読み込みして編集し直してください', 409)
      if (error.code === '23514' || error.code === '22007' || error.code === '22008') return fail('開催情報を確認してください', 400)
      return fail('開催情報を更新できませんでした', 500)
    }
    if (!data) return fail('開催情報が変更されたかグループが削除されました。一覧を再読み込みして編集し直してください', 409)
    return NextResponse.json({ eventGroup: data }, { headers })
  } catch {
    return fail('開催情報を更新できませんでした。登録状況を確認してから再操作してください', 500)
  }
}
