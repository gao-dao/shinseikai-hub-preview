import 'server-only'

export type TurnstileResult =
  | { ok: true }
  | { ok: false; code: 'TURNSTILE_CONFIG_ERROR' | 'TURNSTILE_INVALID_TOKEN' | 'TURNSTILE_REJECTED' | 'TURNSTILE_UNAVAILABLE' | 'TURNSTILE_TIMEOUT'; message: string }

const endpoint = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const timeoutMs = 5_000

function failure(code: Extract<TurnstileResult, { ok: false }>['code']): TurnstileResult {
  const unavailable = ['TURNSTILE_CONFIG_ERROR', 'TURNSTILE_UNAVAILABLE', 'TURNSTILE_TIMEOUT'].includes(code)
  return { ok: false, code, message: unavailable
    ? '現在、確認処理を利用できません。時間をおいて再度お試しください'
    : '本人操作の確認に失敗しました。確認をやり直してください' }
}

// Comma-separated exact DNS names (or localhost for official test-key use).
// No schemes, ports, paths, wildcard suffix matching or implicit case folding.
function validHostname(hostname: string) {
  return hostname.length <= 253 && hostname.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

/** Validate only a Bot challenge. No applicant data, IP headers, registration
 * key, cookies or Supabase client are accepted. No development bypass exists.
 * Official specification: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
export async function verifyTurnstile(token: unknown): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  const hostnamesValue = process.env.TURNSTILE_ALLOWED_HOSTNAMES
  const action = process.env.TURNSTILE_EXPECTED_ACTION
  const hostnames = hostnamesValue?.split(',').map(value => value.trim())
  if (!secret || !/^[!-~]{1,512}$/.test(secret) || !hostnames?.length ||
      hostnames.some(hostname => !validHostname(hostname)) ||
      !action || !/^[A-Za-z0-9_-]{1,32}$/.test(action)) return failure('TURNSTILE_CONFIG_ERROR')
  // Tokens are opaque: do not trim, decode or normalize their contents.
  if (typeof token !== 'string' || !/^[!-~]{1,2048}$/.test(token)) return failure('TURNSTILE_INVALID_TOKEN')

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Bound the entire operation, including response-body parsing. Race also
    // prevents a non-cooperative transport from holding verification open.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('TURNSTILE_TIMEOUT')) }, timeoutMs)
    })
    const verification = (async (): Promise<TurnstileResult> => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: token }),
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      })
      if (!response.ok) return failure('TURNSTILE_UNAVAILABLE')
      const data: unknown = await response.json()
      if (!data || typeof data !== 'object' || Array.isArray(data)) return failure('TURNSTILE_UNAVAILABLE')
      const result = data as Record<string, unknown>
      if (typeof result.success !== 'boolean' ||
          (result['error-codes'] !== undefined && (!Array.isArray(result['error-codes']) || result['error-codes'].some(code => typeof code !== 'string')))) return failure('TURNSTILE_UNAVAILABLE')
      if (!result.success) return failure('TURNSTILE_REJECTED')
      if (typeof result.hostname !== 'string' || typeof result.action !== 'string' ||
          (Array.isArray(result['error-codes']) && result['error-codes'].length > 0)) return failure('TURNSTILE_UNAVAILABLE')
      if (!hostnames.includes(result.hostname) || result.action !== action) return failure('TURNSTILE_REJECTED')
      return { ok: true }
    })()
    return await Promise.race([verification, deadline])
  } catch {
    // No upstream exception, token, key, response body or error-codes are logged
    // or returned. Never automatically retry a single-use challenge token.
    return failure(controller.signal.aborted ? 'TURNSTILE_TIMEOUT' : 'TURNSTILE_UNAVAILABLE')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
