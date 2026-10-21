import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as net from 'node:net'

const helperPath = 'lib/security/registration-diagnostics.ts'
const routePath = 'app/api/registrations/route.ts'
const host = 'shinseikai-hub-preview.vercel.app'
const configuration = {
  VERCEL_PROJECT_ID: 'prj_synthetic_preview', REGISTRATION_DIAGNOSTICS_EXPECTED_PROJECT_ID: 'prj_synthetic_preview',
  REGISTRATION_DIAGNOSTICS_ENABLED: 'true', VERCEL: '1', NODE_ENV: 'production', VERCEL_ENV: 'production',
  VERCEL_GIT_REPO_OWNER: 'gao-dao', VERCEL_GIT_REPO_SLUG: 'shinseikai-hub-preview', VERCEL_PROJECT_PRODUCTION_URL: host,
  REGISTRATION_ALLOWED_ORIGINS: `https://${host}`, REGISTRATION_IP_TRUST_MODE: 'vercel-direct',
  UPSTASH_REDIS_REST_URL: 'https://synthetic.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'synthetic-token',
  REGISTRATION_RATE_LIMIT_HMAC_SECRET: 'synthetic-secret-'.repeat(3), REGISTRATION_RATE_LIMIT_NAMESPACE: 'preview_test',
}
const ip = '192.0.2.39'
function setup(env = configuration, options = {}) {
  const logs = [], calls = []
  const forbidden = () => { calls.push('FORBIDDEN'); throw new Error('synthetic-sensitive-error') }
  const compile = (path, dependencies) => {
    const exports = {}
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      exports, URL, Response, process: { env }, fetch: forbidden, console: { info: value => logs.push(JSON.parse(value)), error: forbidden, log: forbidden },
      require: name => { if (options.importFails && name === '@/lib/security/registration-diagnostics') throw new Error('synthetic-sensitive-error'); assert.ok(Object.hasOwn(dependencies, name), 'unapproved dependency'); return dependencies[name] },
    })
    return exports
  }
  const helper = compile(helperPath, { 'server-only': {}, 'node:net': net })
  const ipModule = compile('lib/security/registration-client-ip.ts', { 'server-only': {}, 'node:net': net })
  const route = compile(routePath, {
    'next/server': { NextResponse: { json: forbidden } },
    '@/lib/registrations/public-registration': { validatePublicRegistration: forbidden },
    '@/lib/security/registration-client-ip': { getRegistrationClientIp: forbidden },
    '@/lib/security/registration-rate-limit': { checkRegistrationRateLimit: forbidden },
    '@/lib/security/turnstile': { verifyTurnstile: forbidden },
    '@/lib/supabase/registration-service': { submitPublicRegistration: forbidden },
    '@/lib/security/registration-diagnostics': options.collectionFails ? { logPreviewRegistrationDiagnostics: () => { throw new Error('synthetic-sensitive-error') } } : helper,
  })
  return { helper, ipModule, route, logs, calls }
}
const headers = value => new Headers(value === null ? {} : { 'x-real-ip': value })

test('enabled GET emits guard and fixed-schema records, no services, always 405/no-store', async () => {
  const s = setup(); const response = await s.route.GET(new Request(`https://${host}/api/registrations`, { headers: headers(ip) }))
  assert.equal(response.status, 405); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('Allow'), 'POST'); assert.equal(await response.text(), '')
  assert.equal(response.headers.get('X-Registration-Diagnostic-Stage'), 'completed');
  assert.equal(s.logs.length, 2); assert.equal(s.logs[0].classification, 'GUARDS_PASSED'); assert.deepEqual(s.calls, [])
  assert.equal(s.logs[1].event, 'REGISTRATION_PREVIEW_DIAGNOSTICS')
  for (const [key, value] of Object.entries(s.logs[1])) if (key !== 'event') assert.equal(typeof value, 'boolean')
  assert.ok(Object.entries(s.logs[1]).every(([key, value]) => key === 'event' || value === true))
  const serialized = JSON.stringify(s.logs)
  for (const value of [ip, configuration.UPSTASH_REDIS_REST_TOKEN, configuration.REGISTRATION_RATE_LIMIT_HMAC_SECRET, configuration.UPSTASH_REDIS_REST_URL, host, configuration.VERCEL_PROJECT_ID]) assert.ok(!serialized.includes(value))
})

for (const [key, value] of [
  ['REGISTRATION_DIAGNOSTICS_ENABLED', undefined], ['REGISTRATION_DIAGNOSTICS_ENABLED', 'TRUE'],
  ['VERCEL', undefined], ['NODE_ENV', 'development'], ['VERCEL_ENV', 'development'],
  ['VERCEL_GIT_REPO_OWNER', 'other-owner'], ['VERCEL_GIT_REPO_SLUG', 'shinseikai-hub'],
  ['VERCEL_PROJECT_PRODUCTION_URL', 'shinseikai-hub.vercel.app'], ['VERCEL_PROJECT_PRODUCTION_URL', undefined],
]) test(`fails closed without preview guard: ${key}/${value ?? 'missing'}`, async () => {
  const s = setup({ ...configuration, [key]: value })
  const request = new Request(`https://${host}/api/registrations`, { headers: { 'x-real-ip': ip, 'REGISTRATION_DIAGNOSTICS_ENABLED': 'true', 'x-vercel-project-production-url': host } })
  const response = await s.route.GET(request)
  assert.equal(response.status, 405); assert.equal(await response.text(), ''); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('X-Registration-Diagnostic-Stage'), 'guard-rejected'); assert.equal(s.logs.length, 1); assert.equal(s.logs[0].classification, 'GUARD_REJECTED'); assert.deepEqual(s.calls, [])
})

test('preview deployment environment is permitted only with all other guards', () => {
  assert.equal(setup().helper.previewDiagnosticsEnabled({ ...configuration, VERCEL_ENV: 'preview' }), true)
})

for (const value of [ip, '2001:db8::1', null, '', '192.0.2.39,192.0.2.40', ' 192.0.2.39', '127.0.0.1:80', 'fe80::1%en0']) test(`IP predicates agree with existing adapter: ${value ?? 'missing'}`, () => {
  const s = setup(); const h = headers(value); const result = s.helper.collectPreviewRegistrationDiagnostics(configuration, h)
  assert.equal(result.real_ip_valid, s.ipModule.getRegistrationClientIp(h).ok)
  assert.deepEqual(s.calls, [])
})

test('header exception is classified without logging exception content', () => {
  const s = setup(); s.helper.logPreviewRegistrationDiagnostics({ get: () => { throw new Error('synthetic-sensitive-error') } })
  assert.equal(s.logs[1].real_ip_readable, false); assert.equal(s.logs[1].real_ip_present, false); assert.equal(s.logs[1].real_ip_valid, false)
  assert.ok(!JSON.stringify(s.logs).includes('synthetic-sensitive-error'))
})

for (const [key, value, field] of [
  ['REGISTRATION_ALLOWED_ORIGINS', undefined, 'origin_config_valid'],
  ['REGISTRATION_ALLOWED_ORIGINS', `https://${host}/`, 'origin_config_valid'],
  ['REGISTRATION_ALLOWED_ORIGINS', 'https://other.invalid', 'preview_origin_allowed'],
  ['REGISTRATION_IP_TRUST_MODE', 'vercel-direct ', 'ip_mode_matches'],
  ['UPSTASH_REDIS_REST_URL', 'http://synthetic.upstash.io', 'redis_url_valid'],
  ['UPSTASH_REDIS_REST_TOKEN', '', 'redis_token_valid'],
  ['REGISTRATION_RATE_LIMIT_HMAC_SECRET', 'short', 'hmac_secret_valid'],
  ['REGISTRATION_RATE_LIMIT_NAMESPACE', 'INVALID', 'namespace_valid'],
  ['REGISTRATION_RATE_LIMIT_IP_PER_MINUTE', '0', 'limits_valid'],
]) test(`invalid configuration identified without values: ${field}`, () => {
  const env = { ...configuration, [key]: value }; const s = setup(env)
  s.helper.logPreviewRegistrationDiagnostics(headers(ip)); assert.equal(s.logs[1][field], false); assert.deepEqual(s.calls, [])
})

test('payload, token, key, cookies, arbitrary headers never enter diagnostic record', async () => {
  const s = setup(); await s.route.GET(new Request(`https://${host}/api/registrations?token=synthetic-sensitive-error`, { headers: { 'x-real-ip': ip, Cookie: 'synthetic-sensitive-error', Authorization: 'synthetic-sensitive-error', 'Idempotency-Key': 'synthetic-sensitive-error' } }))
  assert.ok(!JSON.stringify(s.logs).includes('synthetic-sensitive-error')); assert.deepEqual(s.calls, [])
})

test('diagnostic dependencies are server-only and contain no service imports', () => {
  const source = fs.readFileSync(helperPath, 'utf8')
  assert.match(source, /^import 'server-only'/)
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1])
  assert.deepEqual(imports, ['node:net'])
  assert.doesNotMatch(source, /\bfetch\s*\(|createClient|submitPublicRegistration|verifyTurnstile|checkRegistrationRateLimit/)
})

for (const [actual, expected] of [
  [undefined, undefined], ['', ''], [' ', ' '], [undefined, 'prj_synthetic_preview'],
  ['prj_synthetic_preview', undefined], ['prj_other', 'prj_synthetic_preview'],
]) test('missing/empty/mismatching project IDs produce no logs or imports', async () => {
  const env = { ...configuration, VERCEL_PROJECT_ID: actual, REGISTRATION_DIAGNOSTICS_EXPECTED_PROJECT_ID: expected }
  const s = setup(env, { importFails: true })
  assert.equal(s.helper.diagnosticsProjectMatches(env), false)
  s.helper.logPreviewRegistrationDiagnostics({ get: () => { throw new Error('must-not-read') } })
  const r = await s.route.GET(new Request(`https://${host}/api/registrations`, { headers: { VERCEL_PROJECT_ID: 'prj_synthetic_preview', REGISTRATION_DIAGNOSTICS_EXPECTED_PROJECT_ID: 'prj_synthetic_preview' } }))
  assert.equal(r.status, 405); assert.equal(await r.text(), ''); assert.equal(r.headers.get('Cache-Control'), 'no-store')
  assert.equal(r.headers.get('X-Registration-Diagnostic-Stage'), null); assert.deepEqual(s.logs, []); assert.deepEqual(s.calls, [])
})

for (const kind of ['importFails', 'collectionFails']) test(`exception fixed classification only: ${kind}`, async () => {
  const s = setup(configuration, { [kind]: true })
  const r = await s.route.GET(new Request(`https://${host}/api/registrations`))
  assert.equal(r.status, 405); assert.equal(await r.text(), ''); assert.equal(r.headers.get('Cache-Control'), 'no-store')
  assert.equal(r.headers.get('X-Registration-Diagnostic-Stage'), kind === 'importFails' ? 'import-failed' : 'collection-failed')
  assert.deepEqual(s.logs, [{ event: 'REGISTRATION_PREVIEW_DIAGNOSTIC_FAILURE', classification: kind === 'importFails' ? 'IMPORT_FAILED' : 'COLLECTION_FAILED' }])
  assert.ok(!JSON.stringify(s.logs).includes('synthetic-sensitive-error')); assert.deepEqual(s.calls, [])
})

test('guard rejection does not read IP or detailed configuration', () => {
  const env = { ...configuration, VERCEL_GIT_REPO_OWNER: undefined }
  Object.defineProperty(env, 'UPSTASH_REDIS_REST_TOKEN', { get: () => { throw new Error('must-not-read') } })
  const s = setup(env)
  s.helper.logPreviewRegistrationDiagnostics({ get: () => { throw new Error('must-not-read') } })
  assert.equal(s.logs.length, 1); assert.equal(s.logs[0].repo_owner_present, false); assert.equal(s.logs[0].repo_owner_matches, false)
  assert.equal(s.logs[0].classification, 'GUARD_REJECTED')
  for (const [key, value] of Object.entries(s.logs[0])) if (!['event', 'classification'].includes(key)) assert.equal(typeof value, 'boolean')
})

test('unexpected detailed collection failure is reported safely after guard record', async () => {
  const env = { ...configuration }
  Object.defineProperty(env, 'UPSTASH_REDIS_REST_TOKEN', { get: () => { throw new Error('synthetic-sensitive-error') } })
  const s = setup(env); const r = await s.route.GET(new Request(`https://${host}/api/registrations`))
  assert.equal(r.status, 405); assert.equal(r.headers.get('X-Registration-Diagnostic-Stage'), 'collection-failed'); assert.equal(s.logs.length, 2)
  assert.equal(s.logs[0].classification, 'GUARDS_PASSED'); assert.equal(s.logs[1].classification, 'COLLECTION_FAILED')
  assert.ok(!JSON.stringify(s.logs).includes('synthetic-sensitive-error')); assert.deepEqual(s.calls, [])
})


test('headers and body contain only fixed classifications and no sensitive values', async () => {
  for (const options of [{}, { importFails: true }, { collectionFails: true }]) {
    const s = setup(configuration, options)
    const r = await s.route.GET(new Request(`https://${host}/api/registrations?secret=synthetic-sensitive-error`, {
      headers: { 'x-real-ip': ip, Authorization: 'synthetic-sensitive-error', 'X-Registration-Diagnostic-Stage': 'attacker-value' },
    }))
    assert.equal(r.status, 405); assert.equal(await r.text(), '')
    assert.deepEqual([...r.headers.keys()].sort(), ['allow', 'cache-control', 'x-registration-diagnostic-stage'])
    const serialized = JSON.stringify({ headers: [...r.headers], logs: s.logs })
    for (const value of [ip, host, configuration.VERCEL_PROJECT_ID, configuration.UPSTASH_REDIS_REST_TOKEN,
      configuration.REGISTRATION_RATE_LIMIT_HMAC_SECRET, configuration.UPSTASH_REDIS_REST_URL, 'synthetic-sensitive-error', 'attacker-value']) {
      assert.ok(!serialized.includes(value))
    }
    assert.deepEqual(s.calls, [])
  }
})

test('completed means collection finished even if configuration or IP checks fail', async () => {
  const s = setup({ ...configuration, REGISTRATION_ALLOWED_ORIGINS: undefined })
  const r = await s.route.GET(new Request(`https://${host}/api/registrations`))
  assert.equal(r.headers.get('X-Registration-Diagnostic-Stage'), 'completed')
  assert.equal(s.logs[1].origin_config_valid, false); assert.equal(s.logs[1].real_ip_valid, false)
  assert.deepEqual(s.calls, [])
})
