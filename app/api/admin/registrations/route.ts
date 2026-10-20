import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { validateProxyRegistration } from '@/lib/registrations/proxy-registration'
import { registrationClassColumns, registrationClassAvailability } from '@/lib/registrations/class-availability'

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
    const validation = validateProxyRegistration(body)
    if (!validation.data) return fail(validation.error, 400)
    const input = validation.data
    const supabase = await createClient()
    // Do not require registration_open: administrator proxy registrations may
    // be accepted while public registration is closed.
    const { data: group, error: groupError } = await supabase.from('event_groups').select('id').eq('id', input.event_group_id).maybeSingle()
    if (groupError) return fail('講習会グループを確認できませんでした', 500)
    if (!group) return fail('講習会グループが見つかりません', 404)
    const { data, error, count } = await supabase.from('schedules').select(registrationClassColumns, { count: 'exact' })
      .eq('active_items.status', 'active').in('id', input.schedule_ids)
    if (error || !data || count === null) return fail('選択したクラスを確認できませんでした', 500)
    if (count !== input.schedule_ids.length || data.length !== input.schedule_ids.length || new Set(data.map(row => row.id)).size !== input.schedule_ids.length || data.some(row => !input.schedule_ids.includes(row.id))) return fail('存在しないクラスが含まれています', 400)
    if (data.some(row => row.event_group_id !== input.event_group_id)) return fail('同じ講習会のクラスだけ選択してください', 400)
    if (data.some(row => !registrationClassAvailability(row).selectable)) return fail('満員・受付無効・定員未設定のクラスは登録できません', 409)
    // Exactly one transaction for the parent registration and all selected items.
    // The RPC rechecks capacity under row locks; never fall back to individual writes.
    const { error: rpcError } = await supabase.rpc('admin_create_registration', {
      p_event_group_id: input.event_group_id, p_name: input.name, p_contact: input.contact,
      p_notes: input.notes, p_schedule_ids: input.schedule_ids,
    })
    if (rpcError) {
      if (rpcError.code === '42501') return fail('管理者権限がありません', 403)
      if (['22023', '23505', '23503', '23514', 'P0001', '40001', '40P01'].includes(rpcError.code)) return fail('クラスの状態が変わったか、満員などの理由で登録できませんでした。候補を再取得してください', 409)
      return fail('代理申込を登録できませんでした。登録済みの可能性もあるため一覧を確認してから再操作してください', 500)
    }
    return NextResponse.json({ success: true }, { status: 201, headers })
  } catch {
    return fail('登録結果を確認できませんでした。自動再送せず、申込一覧を確認してから再操作してください', 500)
  }
}

export async function GET(request: Request) {
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) {
      return NextResponse.json({ error: authorization.error }, { status: authorization.status, headers })
    }

    const pageValue = new URL(request.url).searchParams.get('page') ?? '1'
    const page = Number(pageValue)
    if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(page) || page > 1_000_000) {
      return NextResponse.json({ error: 'ページ番号が不正です' }, { status: 400, headers })
    }

    // Use the administrator's cookie session so RLS remains in effect.
    const supabase = await createClient()
    const { data, error, count } = await supabase
      .from('registrations')
      .select(`
        id, name, contact, notes, created_at,
        event_groups!registrations_event_group_id_fkey(title),
        registration_items(
          id, status, cancelled_at,
          schedules!registration_items_schedule_group_fkey(title, date, start_time)
        )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1)

    if (error) {
      return NextResponse.json({ error: '申込一覧を取得できませんでした' }, { status: 500, headers })
    }

    return NextResponse.json({ registrations: data ?? [], page, pageSize, total: count ?? 0 }, { headers })
  } catch {
    return NextResponse.json({ error: '申込一覧を取得できませんでした' }, { status: 500, headers })
  }
}
