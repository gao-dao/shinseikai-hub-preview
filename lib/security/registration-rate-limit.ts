import 'server-only'
import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'

export type RegistrationRateLimitResult =
  | { ok: true }
  | { ok: false; code: 'RATE_LIMIT_EXCEEDED'; retryAfterSeconds: number; message: string }
  | { ok: false; code: 'RATE_LIMIT_CONFIG_ERROR' | 'RATE_LIMIT_IP_UNAVAILABLE' | 'RATE_LIMIT_UNAVAILABLE' | 'RATE_LIMIT_TIMEOUT'; message: string }

// Fixed windows start at the first admitted request. All reads, admission and
// increments run in ONE EVAL, on one shared database, never a REST pipeline.
// A blocked request consumes no quota; an admitted request consumes all three.
// Redis errors may conservatively consume quota but never permit registration.
const script = `
local counts = {}
local retry = 0
for i = 1, 3 do
  local raw = redis.call('GET', KEYS[i])
  local count = tonumber(raw or '0')
  if not count or count < 0 or count % 1 ~= 0 then return redis.error_reply('INVALID_COUNTER') end
  local ttl = redis.call('PTTL', KEYS[i])
  if raw and ttl < 0 then return redis.error_reply('INVALID_COUNTER_TTL') end
  counts[i] = count
  if count >= tonumber(ARGV[i]) then retry = math.max(retry, math.max(ttl, 1)) end
end
if retry > 0 then return {0, retry} end
for i = 1, 3 do
  redis.call('INCR', KEYS[i])
  if counts[i] == 0 then redis.call('PEXPIRE', KEYS[i], ARGV[i + 3]) end
end
return {1, 0}
`

function failure(code: 'RATE_LIMIT_CONFIG_ERROR' | 'RATE_LIMIT_IP_UNAVAILABLE' | 'RATE_LIMIT_UNAVAILABLE' | 'RATE_LIMIT_TIMEOUT'): RegistrationRateLimitResult {
  return { ok: false, code, message: '現在、申込受付の確認処理を利用できません。時間をおいて再度お試しください' }
}

function limit(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  return /^[1-9][0-9]{0,6}$/.test(value) && Number(value) <= 1_000_000 ? Number(value) : null
}

function canonicalIp(value: unknown): string | null {
  if (typeof value !== 'string' || !isIP(value) || value.includes('%')) return null
  if (isIP(value) === 4) return value
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  // A mapped IPv4 address must share the native IPv4 quota.
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized)
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16)
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  return normalized
}

/** Only for an IP obtained through a separately audited, trusted ingress adapter.
 * This is NOT an IP trust validator. It accepts NO Request or forwarded headers.
 * No production IP adapter is implemented: Vercel/proxy topology is unconfirmed.
 * Missing/untrusted IP must be passed as null and is ALWAYS rejected.
 * https://upstash.com/docs/redis/features/restapi
 */
export async function checkRegistrationRateLimit(trustedIp: unknown): Promise<RegistrationRateLimitResult> {
  const ip = canonicalIp(trustedIp)
  if (!ip) return failure('RATE_LIMIT_IP_UNAVAILABLE')
  const secret = process.env.REGISTRATION_RATE_LIMIT_HMAC_SECRET
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  const rawUrl = process.env.UPSTASH_REDIS_REST_URL
  const namespace = process.env.REGISTRATION_RATE_LIMIT_NAMESPACE
  const limits = [limit(process.env.REGISTRATION_RATE_LIMIT_IP_PER_MINUTE, 5), limit(process.env.REGISTRATION_RATE_LIMIT_IP_PER_HOUR, 30), limit(process.env.REGISTRATION_RATE_LIMIT_GLOBAL_PER_MINUTE, 100)]
  // Namespace is mandatory to keep preview/test counters separate from production.
  if (!secret || !/^[!-~]{32,512}$/.test(secret) || !token || !/^[!-~]{1,4096}$/.test(token) ||
      !rawUrl || !/^https:\/\/[a-z0-9-]+\.upstash\.io\/?$/.test(rawUrl) ||
      !namespace || !/^[a-z0-9_-]{1,40}$/.test(namespace) || limits.some(value => value === null)) return failure('RATE_LIMIT_CONFIG_ERROR')

  const digest = createHmac('sha256', secret).update(`registration-ip:v1:${ip}`).digest('hex')
  const prefix = `registration-limit:{${namespace}}:v1`
  const keys = [`${prefix}:ip:${digest}:minute`, `${prefix}:ip:${digest}:hour`, `${prefix}:global:minute`]
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('RATE_LIMIT_TIMEOUT')) }, 5_000)
    })
    const operation = (async (): Promise<RegistrationRateLimitResult> => {
      // Direct REST avoids SDK retry and timeout/fail-open defaults. No retries.
      const response = await fetch(rawUrl, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['EVAL', script, 3, ...keys, ...limits, 60_000, 3_600_000, 60_000]),
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      })
      if (!response.ok) return failure('RATE_LIMIT_UNAVAILABLE')
      const data: unknown = await response.json()
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'result')) return failure('RATE_LIMIT_UNAVAILABLE')
      const result = (data as { result: unknown }).result
      if (!Array.isArray(result) || result.length !== 2 || !result.every(Number.isSafeInteger)) return failure('RATE_LIMIT_UNAVAILABLE')
      if (result[0] === 1 && result[1] === 0) return { ok: true }
      if (result[0] === 0 && result[1] > 0 && result[1] <= 3_600_000) return {
        ok: false, code: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: Math.ceil(result[1] / 1000), message: '申込操作が集中しています。時間をおいて再度お試しください',
      }
      return failure('RATE_LIMIT_UNAVAILABLE')
    })()
    return await Promise.race([operation, deadline])
  } catch {
    return failure(controller.signal.aborted ? 'RATE_LIMIT_TIMEOUT' : 'RATE_LIMIT_UNAVAILABLE')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
