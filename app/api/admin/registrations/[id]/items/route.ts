import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
const pageSize = 50
const columns = `id, title, date, start_time, end_time, event_group_id, capacity, registration_enabled,
  active_items:registration_items!registration_items_schedule_group_fkey(count),
  own_items:registration_items!registration_items_schedule_group_fkey(count)`
type Context = { params: Promise<{ id: string }> }
type Client = Awaited<ReturnType<typeof createClient>>
function fail(error: string, status: number) { return NextResponse.json({ error }, { status, headers }) }
function validId(id: number) { return Number.isSafeInteger(id) && id > 0 }
function validPath(id: string) { return /^[1-9][0-9]*$/.test(id) && validId(Number(id)) }
function classes(supabase: Client, registrationId: number) {
  return supabase.from('schedules').select(columns, { count: 'exact' })
    .eq('active_items.status', 'active').eq('own_items.status', 'active').eq('own_items.registration_id', registrationId)
}
type ClassRow = { id: number; title: string; date: string; start_time: string | null; end_time: string | null; event_group_id: number | null; capacity: number | null; registration_enabled: boolean; active_items: { count: number }[]; own_items: { count: number }[] }
function candidate(row: ClassRow) {
  const registeredCount = row.active_items?.[0]?.count
  const ownCount = row.own_items?.[0]?.count
  if (!Number.isSafeInteger(registeredCount) || !Number.isSafeInteger(ownCount) || registeredCount < 0 || ownCount < 0 || ownCount > registeredCount) throw new Error('Invalid class counts')
  const capacityValid = row.capacity !== null && Number.isInteger(row.capacity) && row.capacity > 0
  const remainingCapacity = capacityValid ? Math.max(row.capacity! - registeredCount, 0) : null
  const unavailableReason = ownCount > 0 ? '有効な申込があります' : !row.registration_enabled ? 'クラス受付が無効です' : !capacityValid ? '定員が未設定または不正です' : remainingCapacity === 0 ? '満員です' : null
  return { id: row.id, title: row.title, date: row.date, start_time: row.start_time, end_time: row.end_time, capacity: row.capacity,
    registeredCount, remainingCapacity, alreadyRegistered: ownCount > 0, selectable: unavailableReason === null, unavailableReason }
}

export async function GET(request: Request, context: Context) {
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return fail(authorization.error, authorization.status)
    const { id } = await context.params
    const value = new URL(request.url).searchParams.get('page') ?? '1'
    const page = Number(value)
    if (!validPath(id) || !/^[1-9][0-9]*$/.test(value) || !validId(page) || page > 1_000_000) return fail('申込IDまたはページ番号が不正です', 400)
    const supabase = await createClient()
    const { data: registration, error: readError } = await supabase.from('registrations').select('id, event_group_id').eq('id', Number(id)).maybeSingle()
    if (readError) return fail('申込を確認できませんでした', 500)
    if (!registration) return fail('申込が見つかりません', 404)
    if (!validId(registration.event_group_id)) return fail('講習会グループを確認できませんでした', 500)
    const { data, error, count } = await classes(supabase, Number(id)).eq('event_group_id', registration.event_group_id)
      .order('date', { ascending: true }).order('start_time', { ascending: true }).order('id', { ascending: true })
      .range((page - 1) * pageSize, page * pageSize - 1)
    if (error || !data || count === null) return fail('追加候補のクラスを取得できませんでした', 500)
    return NextResponse.json({ schedules: data.map(candidate), page, pageSize, total: count }, { headers })
  } catch {
    return fail('追加候補のクラスを確認できませんでした', 500)
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return fail(authorization.error, authorization.status)
    const { id } = await context.params
    if (!validPath(id)) return fail('申込IDが不正です', 400)
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return fail('許可されていないリクエストです', 403)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('JSON形式で送信してください', 415)
    let body: unknown
    try { body = await request.json() } catch { return fail('JSON形式が不正です', 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('入力内容が不正です', 400)
    const input = body as Record<string, unknown>
    const ids = input.schedule_ids
    if (Object.keys(input).some(key => key !== 'schedule_ids') || !Array.isArray(ids) || ids.length === 0 || ids.length > 50 ||
      ids.some(id => typeof id !== 'number' || !validId(id)) || new Set(ids).size !== ids.length) return fail('クラスIDは重複のない正の整数で1〜50件指定してください', 400)
    const supabase = await createClient()
    const { data: registration, error: readError } = await supabase.from('registrations').select('id, event_group_id').eq('id', Number(id)).maybeSingle()
    if (readError) return fail('申込を確認できませんでした', 500)
    if (!registration) return fail('申込が見つかりません', 404)
    if (!validId(registration.event_group_id)) return fail('講習会グループを確認できませんでした', 500)
    const { data, error, count } = await classes(supabase, Number(id)).in('id', ids)
    if (error || !data || count === null) return fail('追加対象クラスを確認できませんでした', 500)
    if (count !== ids.length || data.length !== ids.length || new Set(data.map(row => row.id)).size !== ids.length || data.some(row => !ids.includes(row.id))) return fail('存在しないクラスが含まれています', 400)
    if (data.some(row => row.event_group_id !== registration.event_group_id)) return fail('同じ講習会グループのクラスだけ追加できます', 400)
    if (data.some(row => !candidate(row).selectable)) return fail('重複・満員・受付無効などで追加できないクラスが含まれています。候補を確認してください', 409)
    // One RPC for the entire array: its row locks, partial unique index and
    // transaction provide the final concurrency and all-or-nothing guarantees.
    const { error: rpcError } = await supabase.rpc('admin_add_registration_items', { p_registration_id: Number(id), p_schedule_ids: ids })
    if (rpcError) {
      if (rpcError.code === '42501') return fail('管理者権限がありません', 403)
      if (rpcError.code === '22023' && rpcError.message === 'registration does not exist') return fail('申込が見つかりません', 404)
      if (['22023', '23505', '23503', '23514', 'P0001', '40001', '40P01'].includes(rpcError.code)) return fail('クラスの状態が変わったか、重複・満員のため追加できませんでした。候補を確認してください', 409)
      return fail('クラスを追加できませんでした', 500)
    }
    return NextResponse.json({ success: true }, { headers })
  } catch {
    return fail('クラス追加の結果を確認できませんでした。申込一覧を確認してから再操作してください', 500)
  }
}
