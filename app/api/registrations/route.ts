import { NextResponse } from 'next/server'
import { validatePublicRegistration, type PublicRegistrationResponse } from '@/lib/registrations/public-registration'
import { getRegistrationClientIp } from '@/lib/security/registration-client-ip'
import { checkRegistrationRateLimit } from '@/lib/security/registration-rate-limit'
import { verifyTurnstile } from '@/lib/security/turnstile'
import { submitPublicRegistration } from '@/lib/supabase/registration-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const maxBodyBytes = 32 * 1024
const headers = { 'Cache-Control': 'no-store' }

function reply(result: PublicRegistrationResponse, retryAfterSeconds?: number) {
  return NextResponse.json(result.body, { status: result.status, headers: {
    ...headers, ...(retryAfterSeconds !== undefined ? { 'Retry-After': String(retryAfterSeconds) } : {}),
  } })
}
function fail(code: string, status: number, message: string, retryAfterSeconds?: number) {
  return reply({ status, body: { success: false, code, message } }, retryAfterSeconds)
}

function allowedOrigins(): string[] | null {
  const origins = process.env.REGISTRATION_ALLOWED_ORIGINS?.split(',').map(value => value.trim())
  if (!origins?.length) return null
  try {
    if (origins.some(origin => {
      const url = new URL(origin)
      return url.origin !== origin || !['http:', 'https:'].includes(url.protocol)
    })) return null
    return origins
  } catch { return null }
}

async function readBody(request: Request): Promise<{ text: string } | { status: 400 | 413 }> {
  const length = request.headers.get('content-length')
  if (length !== null) {
    if (!/^[0-9]+$/.test(length)) return { status: 400 }
    if (BigInt(length) > BigInt(maxBodyBytes)) return { status: 413 }
  }
  if (!request.body) return { text: '' }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBodyBytes) {
        // Cancel without waiting for a potentially stalled peer.
        void reader.cancel().catch(() => {})
        return { status: 413 }
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch { return { status: 400 } }
  finally { reader.releaseLock() }
}

export async function POST(request: Request) {
  try {
    const origins = allowedOrigins()
    if (!origins) return fail('SERVICE_UNAVAILABLE', 503, '現在、申込を受け付けられません')
    const origin = request.headers.get('origin')
    if (!origin || origin === 'null' || !origins.includes(origin)) return fail('ORIGIN_REJECTED', 403, '許可されていないリクエストです')
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('UNSUPPORTED_MEDIA_TYPE', 415, 'JSON形式で送信してください')
    const raw = await readBody(request)
    if ('status' in raw) return fail(raw.status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST', raw.status, raw.status === 413 ? '送信内容が大きすぎます' : '送信内容を確認してください')

    const ip = getRegistrationClientIp(request.headers)
    if (!ip.ok) return fail(ip.code, 503, ip.message)
    const limit = await checkRegistrationRateLimit(ip.ip)
    if (!limit.ok) {
      if (limit.code === 'RATE_LIMIT_EXCEEDED') return fail(limit.code, 429, limit.message, limit.retryAfterSeconds)
      return fail(limit.code, 503, limit.message)
    }

    let body: unknown
    try { body = JSON.parse(raw.text) } catch { return fail('INVALID_JSON', 400, 'JSON形式が不正です') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('INVALID_INPUT', 400, '入力内容が不正です')
    // Remove only this security field. Unknown fields remain subject to the
    // existing strict registration validator. Tokens never reach the RPC.
    const { turnstile_token, ...registration } = body as Record<string, unknown>
    const key = request.headers.get('idempotency-key')
    const validation = validatePublicRegistration(registration, key)
    if (!validation.data) return fail('INVALID_INPUT', 400, validation.error)
    if (typeof turnstile_token !== 'string' || !/^[!-~]{1,2048}$/.test(turnstile_token)) return fail('INVALID_INPUT', 400, '操作確認のトークンが不正です')
    const turnstile = await verifyTurnstile(turnstile_token)
    if (!turnstile.ok) {
      const status = ['TURNSTILE_CONFIG_ERROR', 'TURNSTILE_UNAVAILABLE', 'TURNSTILE_TIMEOUT'].includes(turnstile.code) ? 503 : 403
      return fail(turnstile.code, status, turnstile.message)
    }

    // No availability reads, no per-class writes and no automatic retries.
    // Cookie/Authorization headers are not passed to the service boundary.
    return reply(await submitPublicRegistration(registration, validation.data.idempotency_key))
  } catch {
    return fail('REGISTRATION_RESULT_UNKNOWN', 503, '申込結果を確認できませんでした。新しい申込キーで再送せず、同じ申込内容で結果を確認してください')
  }
}

// TEMPORARY preview-only diagnostics. Remove this GET and its helper together.
export async function GET(request: Request) {
  const response = (stage?: 'guard-rejected' | 'completed' | 'import-failed' | 'collection-failed') => new Response(null, { status: 405, headers: {
    'Cache-Control': 'no-store', Allow: 'POST', ...(stage ? { 'X-Registration-Diagnostic-Stage': stage } : {}),
  } })
  // Check before dynamic import so import failures can be classified safely.
  // Keep this predicate aligned with diagnosticsProjectMatches in the helper.
  const actual = process.env.VERCEL_PROJECT_ID
  const expected = process.env.REGISTRATION_DIAGNOSTICS_EXPECTED_PROJECT_ID
  if (typeof actual !== 'string' || actual.trim().length === 0 ||
      typeof expected !== 'string' || expected.trim().length === 0 || actual !== expected) return response()
  let classification = 'IMPORT_FAILED'
  try {
    const { logPreviewRegistrationDiagnostics } = await import('@/lib/security/registration-diagnostics')
    classification = 'COLLECTION_FAILED'
    const stage = logPreviewRegistrationDiagnostics(request.headers)
    return response(stage)
  } catch {
    // Fixed classifications only; no exceptions, configuration or request values.
    try { console.info(JSON.stringify({ event: 'REGISTRATION_PREVIEW_DIAGNOSTIC_FAILURE', classification })) } catch { /* logging must not alter the response */ }
    return response(classification === 'IMPORT_FAILED' ? 'import-failed' : 'collection-failed')
  }
}
