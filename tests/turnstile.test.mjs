import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const secret = 'SYNTHETIC_SECRET_NOT_A_REAL_KEY'
const token = 'SYNTHETIC_TOKEN_NOT_A_REAL_TOKEN'
const env = { TURNSTILE_SECRET_KEY: secret, TURNSTILE_ALLOWED_HOSTNAMES: 'events.example.test, localhost', TURNSTILE_EXPECTED_ACTION: 'public_registration' }
const accepted = { success: true, hostname: 'events.example.test', action: 'public_registration', 'error-codes': [] }
const source = fs.readFileSync('lib/security/turnstile.ts', 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function setup({ configuration = env, data = accepted, ok = true, fetchError, jsonError, hangFetch = false, hangJson = false } = {}) {
  const calls = [], logs = [], timers = [], cleared = []
  const exports = {}
  vm.runInNewContext(compiled, {
    exports, process: { env: { ...configuration } }, AbortController,
    require: name => { assert.equal(name, 'server-only'); return {} },
    console: Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(name => [name, (...args) => logs.push(args)])),
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer },
    clearTimeout: timer => cleared.push(timer),
    fetch: async (...args) => {
      calls.push(args)
      if (fetchError) throw new Error(secret + token)
      if (hangFetch) return new Promise(() => {})
      return { ok, json: async () => {
        if (jsonError) throw new Error(secret + token)
        if (hangJson) return new Promise(() => {})
        return data
      } }
    },
  })
  return { calls, logs, timers, cleared, verify: exports.verifyTurnstile }
}

test('Turnstile exact hostname/action succeeds with one fixed Siteverify POST', async () => {
  const context = setup()
  const result = await context.verify(token)
  assert.equal(result.ok, true)
  assert.equal(context.calls.length, 1)
  const [url, options] = context.calls[0]
  assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
  assert.equal(options.method, 'POST')
  assert.equal(options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(options.body), { secret, response: token })
  assert.equal(options.cache, 'no-store')
  assert.equal(options.credentials, 'omit')
  assert.equal(options.redirect, 'error')
  assert.equal(options.signal.aborted, false)
  assert.equal(context.timers[0].delay, 5000)
  assert.equal(context.cleared[0], context.timers[0])
  assert.deepEqual(Object.keys(result), ['ok'])
  assert.deepEqual(context.logs, [])
})

test('Turnstile false success is rejected without forwarding upstream errors', async () => {
  const context = setup({ data: { success: false, 'error-codes': [secret, token] } })
  const result = await context.verify(token)
  assert.equal(result.code, 'TURNSTILE_REJECTED')
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret + '|' + token))
  assert.equal(context.calls.length, 1)
  assert.deepEqual(context.logs, [])
})

for (const hostname of ['other.test', 'events.example.test.attacker.test', 'EVENTS.EXAMPLE.TEST', 'https://events.example.test', 'events.example.test.', ' events.example.test']) test(`Turnstile rejects nonexact hostname ${hostname}`, async () => {
  const context = setup({ data: { ...accepted, hostname } })
  assert.equal((await context.verify(token)).code, 'TURNSTILE_REJECTED')
})

test('Turnstile checks server-configured action exactly, never request-controlled action', async () => {
  for (const action of ['other', 'PUBLIC_REGISTRATION', ' public_registration', 'public_registration ']) {
    assert.equal((await setup({ data: { ...accepted, action } }).verify(token)).ok, false)
  }
})

test('Turnstile invalid token formats fail before HTTP without normalization', async () => {
  for (const invalid of [undefined, null, 1, true, {}, [], '', ' ', token + '\n', '\t' + token, token + ' ', 'x'.repeat(2049), 'あ', '\0']) {
    const context = setup()
    assert.equal((await context.verify(invalid)).code, 'TURNSTILE_INVALID_TOKEN')
    assert.equal(context.calls.length, 0)
    assert.equal(context.timers.length, 0)
  }
  assert.equal((await setup().verify('x'.repeat(2048))).ok, true)
})

test('Turnstile missing or invalid configuration fails closed without HTTP', async () => {
  const invalid = [{}, ...Object.keys(env).flatMap(key => [{ ...env, [key]: undefined }, { ...env, [key]: '' }]),
    ...[' ', 'bad secret', 'x'.repeat(513)].map(value => ({ ...env, TURNSTILE_SECRET_KEY: value })),
    ...['https://example.test', '*.example.test', 'example.test:3000', 'EXAMPLE.TEST', 'a..test', '-bad.test', 'bad-.test', 'a'.repeat(64) + '.test', 'example.test,', ',example.test', ' '].map(value => ({ ...env, TURNSTILE_ALLOWED_HOSTNAMES: value })),
    ...['bad action', 'x'.repeat(33), '*', ' public_registration'].map(value => ({ ...env, TURNSTILE_EXPECTED_ACTION: value }))]
  for (const configuration of invalid) {
    const context = setup({ configuration })
    assert.equal((await context.verify(token)).code, 'TURNSTILE_CONFIG_ERROR')
    assert.equal(context.calls.length, 0)
    assert.deepEqual(context.logs, [])
  }
})

for (const phase of ['fetch', 'json']) test(`Turnstile five-second deadline aborts stalled ${phase}, fails and clears timer`, async () => {
  const context = setup({ hangFetch: phase === 'fetch', hangJson: phase === 'json' })
  const pending = context.verify(token)
  await Promise.resolve()
  context.timers[0].callback()
  const result = await pending
  assert.equal(result.code, 'TURNSTILE_TIMEOUT')
  assert.equal(context.calls[0][1].signal.aborted, true)
  assert.equal(context.calls.length, 1)
  assert.equal(context.cleared.length, 1)
  assert.deepEqual(context.logs, [])
})

test('Turnstile HTTP errors, network failures and malformed JSON fail without retries or sensitive logs', async () => {
  for (const scenario of [{ ok: false }, { fetchError: true }, { jsonError: true }]) {
    const context = setup(scenario)
    const result = await context.verify(token)
    assert.equal(result.code, 'TURNSTILE_UNAVAILABLE')
    assert.equal(context.calls.length, 1)
    assert.equal(context.cleared.length, 1)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret + '|' + token))
    assert.deepEqual(context.logs, [])
  }
})

test('Turnstile malformed response structures never pass', async () => {
  for (const data of [null, [], 'ok', true, {}, { success: 'true' }, { ...accepted, success: 1 }, { success: true },
    { ...accepted, hostname: null }, { ...accepted, action: [] }, { ...accepted, 'error-codes': 'bad' },
    { ...accepted, 'error-codes': [123] }, { ...accepted, 'error-codes': ['internal-error'] }]) {
    const context = setup({ data })
    assert.equal((await context.verify(token)).code, 'TURNSTILE_UNAVAILABLE')
    assert.equal(context.calls.length, 1)
  }
})

test('Turnstile has no development bypass; localhost still requires verified hostname and action', async () => {
  const context = setup({ configuration: { ...env, NODE_ENV: 'development' }, data: { ...accepted, hostname: 'localhost' } })
  assert.equal((await context.verify(token)).ok, true)
  assert.equal(context.calls.length, 1)
  assert.equal((await setup({ configuration: { NODE_ENV: 'development' } }).verify(token)).ok, false)
  assert.equal((await setup({ data: { success: false, hostname: 'localhost', action: env.TURNSTILE_EXPECTED_ACTION } }).verify(token)).ok, false)
})

test('Turnstile never forwards registration idempotency keys, applicant data or upstream payloads', async () => {
  const context = setup({ data: { ...accepted, message: secret, cdata: token, metadata: { secret } } })
  const applicant = { name: 'Synthetic applicant' }
  const result = await context.verify(token, { idempotency_key: 'registration-key', ...applicant })
  assert.deepEqual(JSON.parse(context.calls[0][1].body), { secret, response: token })
  assert.deepEqual(Object.keys(result), ['ok'])
  assert.deepEqual(applicant, { name: 'Synthetic applicant' })
  assert.deepEqual(context.logs, [])
  assert.match(source, /^import 'server-only'/)
  assert.doesNotMatch(source, /from ['"].*(?:supabase|registrations)/)
})
