import { NextResponse } from 'next/server'
import { createAnonymousClient } from '@/lib/supabase/anonymous'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store, max-age=0' }
const pageSize = 50

export async function GET(request: Request) {
  try {
    const value = new URL(request.url).searchParams.get('page') ?? '1'
    const page = Number(value)
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(page) || page > 1_000_000) return NextResponse.json({ error: 'ページ番号が不正です' }, { status: 400, headers })
    const supabase = createAnonymousClient()
    const { data, error, count } = await supabase.from('event_groups')
      .select('id, title, description', { count: 'exact' }).eq('registration_open', true).eq('is_cancelled', false).eq('is_hidden', false)
      .order('id', { ascending: true }).range((page - 1) * pageSize, page * pageSize - 1)
    if (error || !data || count === null || !Number.isSafeInteger(count) || count < 0) throw new Error('Public groups unavailable')
    return NextResponse.json({ eventGroups: data.map(group => ({ id: group.id, title: group.title, description: group.description })), page, pageSize, total: count }, { headers })
  } catch {
    return NextResponse.json({ error: '公開講習会を取得できませんでした' }, { status: 500, headers })
  }
}
