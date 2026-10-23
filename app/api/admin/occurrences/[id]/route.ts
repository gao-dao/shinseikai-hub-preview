import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { validId, validSnapshot } from '@/lib/event-groups/occurrence-editor'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers })
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return fail(auth.error, auth.status)
    const { id } = await context.params
    if (!/^[1-9][0-9]*$/.test(id) || !validId(Number(id))) return fail('開催回IDが不正です。', 400)
    const supabase = await createClient()
    const { data, error } = await supabase.rpc('admin_get_occurrence_editor', { p_group_id: Number(id) })
    if (error) return fail(error.code === 'PT404' ? '開催回が見つかりません。' : '開催回を取得できませんでした。', error.code === 'PT404' ? 404 : error.code === '42501' ? 403 : 503)
    if (!validSnapshot(data)) return fail('開催回を確認できませんでした。', 503)
    return NextResponse.json({ snapshot: data }, { headers })
  } catch { return fail('開催回を取得できませんでした。', 503) }
}
