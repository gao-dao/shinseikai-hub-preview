import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { validateRegistrationDetails } from '@/lib/registrations/details'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers })
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return fail(authorization.error, authorization.status)
    const { id } = await context.params
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) return fail('申込IDが不正です', 400)
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return fail('許可されていないリクエストです', 403)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('JSON形式で送信してください', 415)
    let body: unknown
    try { body = await request.json() } catch { return fail('JSON形式が不正です', 400) }
    const validation = validateRegistrationDetails(body)
    if (!validation.data) return fail(validation.error, 400)
    const supabase = await createClient()
    const { error } = await supabase.rpc('admin_update_registration_details', {
      p_registration_id: Number(id), p_name: validation.data.name,
      p_contact: validation.data.contact, p_notes: validation.data.notes,
    })
    if (error) {
      if (error.code === '42501') return fail('管理者権限がありません', 403)
      if (error.code === '22023' && error.message === 'registration does not exist') return fail('申込が見つかりません', 404)
      if (error.code === '22023' || error.code === '23514') return fail('入力内容を確認してください', 400)
      if (error.code === '40001' || error.code === '40P01') return fail('別の操作と競合しました。一覧を再取得してから再操作してください', 409)
      return fail('申込者情報を更新できませんでした', 500)
    }
    return NextResponse.json({ success: true }, { headers })
  } catch {
    return fail('申込者情報の更新結果を確認できませんでした。一覧を再取得してから再操作してください', 500)
  }
}
