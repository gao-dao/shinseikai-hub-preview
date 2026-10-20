import 'server-only'
import { isIP } from 'node:net'

export type RegistrationClientIpResult =
  | { ok: true; ip: string }
  | { ok: false; status: 503; code: 'REGISTRATION_IP_UNAVAILABLE'; message: string }

/** Server-internal result: pass the successful IP only to the rate limiter,
 * never serialize it into an HTTP response or log it.
 *
 * REGISTRATION_IP_TRUST_MODE=vercel-direct is an operator assertion about the
 * ingress topology, not proof supplied by a request. VERCEL=1 is an additional
 * deployment guard, not cryptographic proof of all access paths. Review this
 * mode whenever a custom domain, proxy or header rewrite is introduced.
 * https://vercel.com/docs/headers/request-headers
 */
export function getRegistrationClientIp(headers: Pick<Headers, 'get'>): RegistrationClientIpResult {
  const unavailable = (): RegistrationClientIpResult => ({
    ok: false, status: 503, code: 'REGISTRATION_IP_UNAVAILABLE',
    message: '現在、申込受付の確認処理を利用できません。時間をおいて再度お試しください',
  })
  // The mode is set only by server environment configuration. Never infer it
  // from Host, request URLs, x-vercel-id, forwarded headers or request body.
  if (process.env.REGISTRATION_IP_TRUST_MODE !== 'vercel-direct' ||
      process.env.VERCEL !== '1' || process.env.NODE_ENV !== 'production' ||
      !['production', 'preview'].includes(process.env.VERCEL_ENV ?? '')) return unavailable()

  try {
    const ip = headers.get('x-real-ip')
    // isIP rejects ports, brackets, comma-separated chains and non-IP text.
    // Reject whitespace and scoped IPv6 explicitly; never repair or split input.
    if (typeof ip !== 'string' || ip !== ip.trim() || ip.includes('%') || !isIP(ip)) return unavailable()
    // Preserve the address here; the existing rate limiter canonicalizes IPv6
    // and IPv4-mapped IPv6 before HMAC generation.
    return { ok: true, ip }
  } catch {
    return unavailable()
  }
}
