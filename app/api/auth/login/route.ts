import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
const rejected = (status: number) => NextResponse.json({ error: status === 429 ? 'しばらく待ってからログインしてください' : 'ログインできませんでした。入力内容を確認するか、時間をおいてお試しください。' }, { status, headers })

async function input(request: Request): Promise<{ role: 'admin' | 'member'; password: string } | null> {
  const length = request.headers.get('content-length')
  if (length !== null && (!/^[0-9]+$/.test(length) || BigInt(length) > BigInt(8192))) return null
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) { void reader.cancel().catch(() => {}); return null }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== 2 || Object.keys(value).some(key => key !== 'role' && key !== 'password') ||
        (value.role !== 'admin' && value.role !== 'member') ||
        typeof value.password !== 'string' || value.password.length < 1 || value.password.length > 4096) return null
    return value
  } catch { return null } finally { reader.releaseLock() }
}

export async function POST(request: Request) {
  try {
    const origin = new URL(request.url).origin
    if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') return rejected(403)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return rejected(415)
    const body = await input(request)
    if (!body) return rejected(400)
    const email = body.role === 'admin' ? process.env.ADMIN_LOGIN_EMAIL : process.env.MEMBER_SHARED_EMAIL
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    if (!email || email !== email.trim() || !email.includes('@') || !url || !key) return rejected(503)
    // Separate identities are required; no privileged key or admin lookup is used.
    if (process.env.ADMIN_LOGIN_EMAIL && process.env.ADMIN_LOGIN_EMAIL === process.env.MEMBER_SHARED_EMAIL) return rejected(503)
    const store = await cookies()
    const pending = new Map<string, { name: string; value: string; options: CookieOptions }>()
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll: () => store.getAll(),
        setAll: values => { for (const cookie of values) pending.set(cookie.name, cookie) },
      },
    })
    const result = await supabase.auth.signInWithPassword({ email, password: body.password })
    if (result.error) return rejected(result.error.status === 429 ? 429 : (result.error.status ?? 0) >= 500 ? 503 : 401)
    if (!result.data.user || !result.data.session) return rejected(401)
    const verified = await supabase.auth.getUser()
    const user = verified.data.user
    if (verified.error || !user || user.id !== result.data.user.id || user.email?.toLowerCase() !== email.toLowerCase()) return rejected(401)
    const profile = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
    if (profile.error || (body.role === 'admin' ? profile.data?.role !== 'admin' : profile.data !== null && profile.data?.role !== 'member')) return rejected(401)
    if (pending.size === 0) return rejected(503)
    // Assemble cookies only on a private response after all checks. A failed
    // cookie write discards this response; the catch returns a clean response.
    const response = NextResponse.json({ success: true }, { headers })
    for (const cookie of pending.values()) {
      response.cookies.set(cookie.name, cookie.value, { ...cookie.options, path: '/', domain: undefined, sameSite: 'lax', secure: origin.startsWith('https:') })
    }
    return response
  } catch { return rejected(503) }
}
