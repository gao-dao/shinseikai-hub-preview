import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { registrationClassColumns, registrationClassAvailability } from '@/lib/registrations/class-availability'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
const pageSize = 50

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers })
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return fail(authorization.error, authorization.status)
    const { id } = await context.params
    const value = new URL(request.url).searchParams.get('page') ?? '1'
    const page = Number(value)
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)) || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(page) || page > 1_000_000) return fail('講習会グループIDまたはページ番号が不正です', 400)
    const supabase = await createClient()
    const { data: group, error: groupError } = await supabase.from('event_groups').select('id').eq('id', Number(id)).maybeSingle()
    if (groupError) return fail('講習会グループを確認できませんでした', 500)
    if (!group) return fail('講習会グループが見つかりません', 404)
    const { data, error, count } = await supabase.from('schedules').select(registrationClassColumns, { count: 'exact' })
      .eq('event_group_id', Number(id)).eq('active_items.status', 'active')
      .order('date', { ascending: true }).order('start_time', { ascending: true }).order('id', { ascending: true })
      .range((page - 1) * pageSize, page * pageSize - 1)
    if (error || !data || count === null || !Number.isSafeInteger(count) || count < 0) return fail('クラス候補を取得できませんでした', 500)
    return NextResponse.json({ schedules: data.map(registrationClassAvailability), page, pageSize, total: count }, { headers })
  } catch {
    return fail('クラス候補・空き枠を確認できませんでした', 500)
  }
}
