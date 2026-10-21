import 'server-only'
import { isIP } from 'node:net'

// Temporary, read-only diagnostics. No service clients or registration imports.
const previewHost = 'shinseikai-hub-preview.vercel.app'
const previewOrigin = `https://${previewHost}`
type Environment = Record<string, string | undefined>

// Missing IDs never compare equal; values are neither normalized nor logged.
export function diagnosticsProjectMatches(env: Environment): boolean {
  const actual = env.VERCEL_PROJECT_ID
  const expected = env.REGISTRATION_DIAGNOSTICS_EXPECTED_PROJECT_ID
  return typeof actual === 'string' && actual.trim().length > 0 &&
    typeof expected === 'string' && expected.trim().length > 0 && actual === expected
}

export function collectPreviewDiagnosticGuards(env: Environment) {
  return {
    diagnostics_flag_present: !!env.REGISTRATION_DIAGNOSTICS_ENABLED,
    diagnostics_flag_matches: env.REGISTRATION_DIAGNOSTICS_ENABLED === 'true',
    vercel_present: !!env.VERCEL,
    vercel_matches: env.VERCEL === '1',
    node_env_present: !!env.NODE_ENV,
    node_env_matches: env.NODE_ENV === 'production',
    vercel_env_present: !!env.VERCEL_ENV,
    vercel_env_matches: ['production', 'preview'].includes(env.VERCEL_ENV ?? ''),
    repo_owner_present: !!env.VERCEL_GIT_REPO_OWNER,
    repo_owner_matches: env.VERCEL_GIT_REPO_OWNER === 'gao-dao',
    repo_slug_present: !!env.VERCEL_GIT_REPO_SLUG,
    repo_slug_matches: env.VERCEL_GIT_REPO_SLUG === 'shinseikai-hub-preview',
    production_url_present: !!env.VERCEL_PROJECT_PRODUCTION_URL,
    production_url_matches: env.VERCEL_PROJECT_PRODUCTION_URL === previewHost,
  }
}

export function previewDiagnosticsEnabled(env: Environment): boolean {
  return env.REGISTRATION_DIAGNOSTICS_ENABLED === 'true' &&
    env.VERCEL === '1' && env.NODE_ENV === 'production' &&
    ['production', 'preview'].includes(env.VERCEL_ENV ?? '') &&
    env.VERCEL_GIT_REPO_OWNER === 'gao-dao' &&
    env.VERCEL_GIT_REPO_SLUG === 'shinseikai-hub-preview' &&
    env.VERCEL_PROJECT_PRODUCTION_URL === previewHost
}

function validOrigins(raw: string | undefined): string[] | null {
  const values = raw?.split(',').map(value => value.trim())
  if (!values?.length) return null
  try {
    if (values.some(value => {
      const url = new URL(value)
      return url.origin !== value || !['http:', 'https:'].includes(url.protocol)
    })) return null
    return values
  } catch { return null }
}
function validLimit(value: string | undefined): boolean {
  return value === undefined || (/^[1-9][0-9]{0,6}$/.test(value) && Number(value) <= 1_000_000)
}

// Booleans only; never include even hashes or lengths of sensitive values.
export function collectPreviewRegistrationDiagnostics(env: Environment, headers: Pick<Headers, 'get'>) {
  const origins = validOrigins(env.REGISTRATION_ALLOWED_ORIGINS)
  let present = false, valid = false, readable = true
  try {
    const ip = headers.get('x-real-ip')
    present = ip !== null
    valid = typeof ip === 'string' && ip === ip.trim() && !ip.includes('%') && isIP(ip) !== 0
  } catch { readable = false }
  return {
    event: 'REGISTRATION_PREVIEW_DIAGNOSTICS',
    origin_config_present: !!env.REGISTRATION_ALLOWED_ORIGINS,
    origin_config_valid: origins !== null,
    preview_origin_allowed: origins?.includes(previewOrigin) ?? false,
    ip_mode_matches: env.REGISTRATION_IP_TRUST_MODE === 'vercel-direct',
    vercel_guard_matches: env.VERCEL === '1',
    node_env_matches: env.NODE_ENV === 'production',
    vercel_env_allowed: ['production', 'preview'].includes(env.VERCEL_ENV ?? ''),
    real_ip_readable: readable,
    real_ip_present: present,
    real_ip_valid: valid,
    redis_url_valid: typeof env.UPSTASH_REDIS_REST_URL === 'string' && /^https:\/\/[a-z0-9-]+\.upstash\.io\/?$/.test(env.UPSTASH_REDIS_REST_URL),
    redis_token_valid: typeof env.UPSTASH_REDIS_REST_TOKEN === 'string' && /^[!-~]{1,4096}$/.test(env.UPSTASH_REDIS_REST_TOKEN),
    hmac_secret_valid: typeof env.REGISTRATION_RATE_LIMIT_HMAC_SECRET === 'string' && /^[!-~]{32,512}$/.test(env.REGISTRATION_RATE_LIMIT_HMAC_SECRET),
    namespace_valid: typeof env.REGISTRATION_RATE_LIMIT_NAMESPACE === 'string' && /^[a-z0-9_-]{1,40}$/.test(env.REGISTRATION_RATE_LIMIT_NAMESPACE),
    limits_valid: [env.REGISTRATION_RATE_LIMIT_IP_PER_MINUTE, env.REGISTRATION_RATE_LIMIT_IP_PER_HOUR, env.REGISTRATION_RATE_LIMIT_GLOBAL_PER_MINUTE].every(validLimit),
  }
}

export function logPreviewRegistrationDiagnostics(headers: Pick<Headers, 'get'>): void {
  if (!diagnosticsProjectMatches(process.env)) return
  const guards = collectPreviewDiagnosticGuards(process.env)
  const enabled = previewDiagnosticsEnabled(process.env)
  console.info(JSON.stringify({
    event: 'REGISTRATION_PREVIEW_DIAGNOSTIC_GUARDS',
    classification: enabled ? 'GUARDS_PASSED' : 'GUARD_REJECTED',
    ...guards,
  }))
  if (!enabled) return
  console.info(JSON.stringify(collectPreviewRegistrationDiagnostics(process.env, headers)))
}
