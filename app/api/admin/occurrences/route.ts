import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { validateOccurrenceInput } from '@/lib/event-groups/occurrence-editor'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
export async function POST(request: Request) {
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers })
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return fail(auth.error, auth.status)
    if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') return fail('許可されていないリクエストです。', 403)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('JSON形式で送信してください。', 415)
    const key = request.headers.get('idempotency-key')
    if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return fail('保存キーが不正です。', 400)
    // Read with a hard byte limit, including chunked requests.
    const reader = request.body?.getReader()
    if (!reader) return fail('入力内容が必要です。', 400)
    const chunks: Uint8Array[] = []; let length = 0
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 131072) { await reader.cancel(); return fail('入力内容が大きすぎます。', 413) } chunks.push(chunk.value) }
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    let body: unknown
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return fail('JSON形式が不正です。', 400) }
    const validation = validateOccurrenceInput(body)
    if (!validation.data) return fail(validation.error, 400)
    const supabase = await createClient()
    const { data, error } = await supabase.rpc('admin_save_occurrence', { p_key: key, p_input: validation.data })
    if (error) {
      if (['PT409', '40001', '40P01', '23505'].includes(error.code)) return fail('編集が競合しました。最新情報を読み込み、確認して編集し直してください。', 409)
      if (error.code === 'PT404') return fail('開催回が見つかりません。', 404)
      if (error.code === '42501') return fail('管理者権限がありません。', 403)
      if (['22023', '23514', '22007', '22008'].includes(error.code)) return fail('入力内容・定員・開催期間を確認してください。', 400)
      return fail('保存結果を確認できません。同じ保存キー・内容で再確認してください。', 503)
    }
    if (!data || !Number.isSafeInteger(data.group_id) || data.group_id <= 0 || !Array.isArray(data.class_ids)) return fail('保存結果を確認できません。同じ保存キー・内容で再確認してください。', 503)
    return NextResponse.json({ saved: true, group_id: data.group_id }, { headers })
  } catch { return fail('保存結果を確認できません。同じ保存キー・内容で再確認してください。', 503) }
}
