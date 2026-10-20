import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
const columns = 'id, title, description, registration_open'
const pageSize = 50

function failure(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers })
}

export async function GET(request: Request) {
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return failure(authorization.error, authorization.status)
    const value = new URL(request.url).searchParams.get('page') ?? '1'
    const page = Number(value)
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(page) || page > 1_000_000) {
      return failure('ページ番号が不正です', 400)
    }
    const supabase = await createClient()
    const { data, error, count } = await supabase.from('event_groups')
      .select(columns, { count: 'exact' })
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1)
    if (error) return failure('講習会グループを取得できませんでした', 500)
    return NextResponse.json({ eventGroups: data ?? [], page, pageSize, total: count ?? 0 }, { headers })
  } catch {
    return failure('講習会グループを取得できませんでした', 500)
  }
}

export async function POST(request: Request) {
  try {
    const authorization = await requireAdmin()
    if (!authorization.ok) return failure(authorization.error, authorization.status)
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return failure('許可されていないリクエストです', 403)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return failure('JSON形式で送信してください', 415)
    }
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return failure('JSON形式が不正です', 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return failure('入力内容が不正です', 400)
    const input = body as Record<string, unknown>
    if (Object.keys(input).some(key => key !== 'title' && key !== 'description')) {
      return failure('指定できない項目が含まれています', 400)
    }
    if (typeof input.title !== 'string' || (input.description != null && typeof input.description !== 'string')) {
      return failure('タイトルと説明の形式が不正です', 400)
    }
    const title = input.title.trim()
    const description = typeof input.description === 'string' ? input.description : null
    if (Array.from(title).length < 1 || Array.from(title).length > 200) {
      return failure('タイトルは1〜200文字で入力してください', 400)
    }
    if (description !== null && Array.from(description).length > 3000) {
      return failure('説明は3000文字以内で入力してください', 400)
    }
    const supabase = await createClient()
    const { data, error } = await supabase.from('event_groups')
      .insert({ title, description: description?.trim() || null, registration_open: false })
      .select(columns).single()
    if (error) return failure('講習会グループを作成できませんでした', 500)
    return NextResponse.json({ eventGroup: data }, { status: 201, headers })
  } catch {
    return failure('講習会グループを作成できませんでした', 500)
  }
}
