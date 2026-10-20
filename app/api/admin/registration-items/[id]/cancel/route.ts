import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers })
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return fail(authorization.error, authorization.status)
    const { id } = await context.params
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) return fail('申込明細IDが不正です', 400)
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return fail('許可されていないリクエストです', 403)
    const supabase = await createClient()
    const { data: item, error: readError } = await supabase.from('registration_items')
      .select('id, status').eq('id', Number(id)).maybeSingle()
    if (readError) return fail('申込明細を確認できませんでした', 500)
    if (!item) return fail('申込明細が見つかりません', 404)
    if (item.status === 'cancelled') return fail('この申込クラスはすでに取消済みです。一覧を再取得してください', 409)
    if (item.status !== 'active') return fail('申込明細の状態を確認できませんでした', 500)

    // The RPC rechecks active status under the schedule row lock. Do not update
    // or delete rows here: history and capacity are managed atomically by DB.
    const { error } = await supabase.rpc('admin_cancel_registration_item', { p_registration_item_id: Number(id) })
    if (error) {
      if (error.code === '42501') return fail('管理者権限がありません', 403)
      if (['22023', '23503', '23514', '40001', '40P01'].includes(error.code)) return fail('申込状態が変わったか、別の操作と競合したため取り消せませんでした。一覧を再取得してください', 409)
      return fail('申込クラスを取り消せませんでした', 500)
    }
    return NextResponse.json({ success: true }, { headers })
  } catch {
    return fail('取消結果を確認できませんでした。一覧を再取得してから再操作してください', 500)
  }
}
