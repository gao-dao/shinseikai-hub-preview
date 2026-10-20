import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import ts from 'typescript'

const modulePath = fileURLToPath(new URL('../../lib/security/turnstile.ts', import.meta.url))
const endpoint = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
// Public official dummy values, never read from .env.local or process.env.
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const dummyToken = 'XXXX.DUMMY.TOKEN.XXXX'
const passKey = '1x0000000000000000000000000000000AA'
const failKey = '2x0000000000000000000000000000000AA'
const spentKey = '3x0000000000000000000000000000000AA'
// These metadata values are a documentation EXAMPLE, not a guaranteed contract.
// Fix them before testing. Never learn/accept a profile from an actual response.
const profile = Object.freeze({ hostname: 'localhost', action: 'test' })
const cases = Object.freeze([
  { name: 'success', secret: passKey, hostname: profile.hostname, action: profile.action, expected: true },
  { name: 'rejected', secret: failKey, hostname: profile.hostname, action: profile.action, expected: false, upstreamError: 'invalid-input-response' },
  { name: 'spent', secret: spentKey, hostname: profile.hostname, action: profile.action, expected: false, upstreamError: 'timeout-or-duplicate' },
  { name: 'hostname_mismatch', secret: passKey, hostname: 'not-allowed.example.test', action: profile.action, expected: false },
  { name: 'action_mismatch', secret: passKey, hostname: profile.hostname, action: 'different_action', expected: false },
])
const safeCodes = new Set(['HTTP_ERROR', 'UNSAFE_REQUEST', 'REQUEST_BUDGET_EXCEEDED', 'TEST_RESPONSE_CONTRACT_MISMATCH', 'NETWORK_OR_PARSE_ERROR', 'MODULE_RESULT_MISMATCH', 'MODULE_TIMEOUT', 'SOURCE_CHANGED', 'UNEXPECTED_LOG'])
function ensure(condition, code) { if (!condition) throw new Error(code) }
const safeCode = error => safeCodes.has(error?.message) ? error.message : 'NETWORK_OR_PARSE_ERROR'

// Only fixed field names, presence/type metadata and comparison booleans leave
// this function. Never retain upstream field values, unknown keys or error codes.
export function diagnoseTurnstileResponse(data, { httpStatus = null, jsonParsed = null, expectedError } = {}) {
  const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const fieldNames = ['success', 'hostname', 'action', 'error-codes']
  const diagnostic = {
    http_status: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
    json_parsed: jsonParsed,
    success: 'invalid', hostname_matches: null, action_matches: null,
    fields: Object.fromEntries(['body', ...fieldNames].map(name => [name, { present: null, type: 'not_checked' }])),
    mismatched_fields: [],
  }
  if (httpStatus !== null && httpStatus !== 200) diagnostic.mismatched_fields.push('http_status')
  if (jsonParsed !== true) {
    if (jsonParsed === false) diagnostic.mismatched_fields.push('json')
    return diagnostic
  }
  diagnostic.fields.body = { present: true, type: type(data) }
  const object = data !== null && typeof data === 'object' && !Array.isArray(data)
  for (const field of fieldNames) {
    const present = object && Object.hasOwn(data, field)
    diagnostic.fields[field] = { present, type: present ? type(data[field]) : 'missing' }
  }
  if (!object) {
    diagnostic.mismatched_fields.push('body')
    return diagnostic
  }
  diagnostic.success = data.success === true ? 'true' : data.success === false ? 'false' : 'invalid'
  diagnostic.hostname_matches = typeof data.hostname === 'string' && data.hostname === profile.hostname
  diagnostic.action_matches = typeof data.action === 'string' && data.action === profile.action
  if (data.success !== !expectedError) diagnostic.mismatched_fields.push('success')
  if (!expectedError) {
    if (!diagnostic.hostname_matches) diagnostic.mismatched_fields.push('hostname')
    if (!diagnostic.action_matches) diagnostic.mismatched_fields.push('action')
  }
  const errors = data['error-codes']
  if (!Array.isArray(errors) || (expectedError
    ? errors.length !== 1 || errors[0] !== expectedError
    : errors.length !== 0)) diagnostic.mismatched_fields.push('error-codes')
  return diagnostic
}

// Requires an explicit transport: imports and tests cannot accidentally use fetch.
// No environment loader, application API, browser widget, Redis or Supabase.
export async function runTurnstileVerification({ transport }) {
  const report = {
    status: 'FAILED', http_requests: 0,
    profile: { hostname: profile.hostname, action: profile.action, specification_guaranteed: false, basis: 'official_documentation_example' },
    checks: cases.map(({ name }) => ({ name, status: 'NOT_RUN' })),
    safety: { official_dummy_keys_only: true, environment_files_read: false, module_source_unchanged: true, automatic_retry: false },
  }
  let original
  try {
    ensure(typeof transport === 'function', 'UNSAFE_REQUEST')
    original = await readFile(modulePath)
    const compiled = ts.transpileModule(original.toString('utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    for (const [index, scenario] of cases.entries()) {
      const resultRecord = report.checks[index]
      resultRecord.status = 'RUNNING'
      resultRecord.diagnostics = diagnoseTurnstileResponse(undefined)
      const exports = {}
      let calls = 0, transportFailure, upstreamChecked = false
      vm.runInNewContext(compiled, {
        exports, AbortController, setTimeout, clearTimeout,
        process: { env: { TURNSTILE_SECRET_KEY: scenario.secret, TURNSTILE_ALLOWED_HOSTNAMES: scenario.hostname, TURNSTILE_EXPECTED_ACTION: scenario.action } },
        require: name => { ensure(name === 'server-only', 'SOURCE_CHANGED'); return {} },
        console: Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(name => [name, () => { transportFailure = 'UNEXPECTED_LOG'; throw new Error(transportFailure) }])),
        fetch: async (url, options) => {
          try {
            ensure(url === endpoint && options.method === 'POST' && options.redirect === 'error' && options.cache === 'no-store', 'UNSAFE_REQUEST')
            const body = JSON.parse(options.body)
            ensure(Object.keys(body).length === 2 && body.secret === scenario.secret && body.response === dummyToken, 'UNSAFE_REQUEST')
            ensure(calls === 0 && report.http_requests < 5, 'REQUEST_BUDGET_EXCEEDED')
            calls++; report.http_requests++
            const response = await transport(url, options)
            resultRecord.diagnostics = diagnoseTurnstileResponse(undefined, { httpStatus: response.status })
            ensure(response.ok && response.status === 200, 'HTTP_ERROR')
            let data
            try { data = await response.json() }
            catch {
              resultRecord.diagnostics = diagnoseTurnstileResponse(undefined, { httpStatus: response.status, jsonParsed: false })
              throw new Error('NETWORK_OR_PARSE_ERROR')
            }
            // Keep the original strict contract, including success metadata
            // before a deliberate mismatch case. Return the same parsed object.
            resultRecord.diagnostics = diagnoseTurnstileResponse(data, { httpStatus: response.status, jsonParsed: true, expectedError: scenario.upstreamError })
            ensure(resultRecord.diagnostics.mismatched_fields.length === 0, 'TEST_RESPONSE_CONTRACT_MISMATCH')
            upstreamChecked = true
            return { ok: response.ok, json: async () => data }
          } catch (error) { transportFailure = safeCode(error); throw error }
        },
      })
      const result = await exports.verifyTurnstile(dummyToken)
      if (transportFailure) throw new Error(transportFailure)
      ensure(result.code !== 'TURNSTILE_TIMEOUT', 'MODULE_TIMEOUT')
      ensure(calls === 1 && upstreamChecked && result.ok === scenario.expected && (result.ok || result.code === 'TURNSTILE_REJECTED'), 'MODULE_RESULT_MISMATCH')
      resultRecord.status = 'PASS'
      resultRecord.upstream_contract_checked = true
      resultRecord.module_outcome_matched = true
    }
    report.status = 'SUCCESS'
  } catch (error) {
    report.error = safeCode(error)
    const active = report.checks.find(check => check.status === 'RUNNING')
    if (active) { active.status = 'FAIL'; active.error = report.error }
  } finally {
    try {
      if (original) ensure(createHash('sha256').update(await readFile(modulePath)).digest('hex') === createHash('sha256').update(original).digest('hex'), 'SOURCE_CHANGED')
    } catch { report.status = 'FAILED'; report.error = 'SOURCE_CHANGED'; report.safety.module_source_unchanged = false }
  }
  return report
}

export function createMockTurnstileTransport({ fault } = {}) {
  const calls = []
  const transport = async (url, options) => {
    calls.push({ url, options })
    if (fault === 'network') throw new Error('PRIVATE_TOKEN_SECRET_NEVER_LOG')
    const { secret } = JSON.parse(options.body)
    const data = secret === failKey ? { success: false, 'error-codes': ['invalid-input-response'] }
      : secret === spentKey ? { success: false, 'error-codes': ['timeout-or-duplicate'] }
        : { success: true, hostname: profile.hostname, action: profile.action, 'error-codes': [] }
    if (fault === 'hostname') data.hostname = 'PRIVATE_TOKEN_SECRET_NEVER_LOG'
    if (fault === 'action') data.action = 'PRIVATE_TOKEN_SECRET_NEVER_LOG'
    if (fault === 'false_success') data.success = false
    return { ok: fault !== 'http', status: fault === 'http' ? 503 : 200, json: async () => {
      if (fault === 'json') throw new Error('PRIVATE_TOKEN_SECRET_NEVER_LOG')
      return fault === 'shape' ? [] : data
    } }
  }
  return { transport, calls }
}

async function main() {
  let report
  try {
    const { values } = parseArgs({ options: { mock: { type: 'boolean' }, execute: { type: 'boolean' }, 'official-test-keys': { type: 'boolean' } } })
    if ((values.mock && values.execute) || (!values.mock && !values.execute) || (values.execute && !values['official-test-keys']) || (values.mock && values['official-test-keys'])) throw new Error('CLI_ARGUMENTS')
    const transport = values.mock ? createMockTurnstileTransport().transport : globalThis.fetch
    report = await runTurnstileVerification({ transport })
    report.mode = values.mock ? 'mock' : 'live_official_test_keys'
    report.external_http_requests = values.mock ? 0 : report.http_requests
  } catch { report = { status: 'FAILED', error: 'LOCAL_SETUP_ERROR', external_http_requests: 0 } }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = report.status === 'SUCCESS' ? 0 : 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
