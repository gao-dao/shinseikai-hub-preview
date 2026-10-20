import { readFile } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import * as crypto from 'node:crypto'
import * as net from 'node:net'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const modulePath = path.join(root, 'lib/security/registration-rate-limit.ts')
const ips = ['192.0.2.25', '192.0.2.26', '192.0.2.27', '2001:db8::1']
const ttlMs = 30_000
const checkNames = ['within_limit', 'ip_minute_limit', 'ip_hour_limit', 'global_minute_limit', 'different_ips', 'ipv4_ipv6_identity', 'concurrent_limit', 'retry_after', 'private_keys', 'lua_result_interpretation']
const safeCodes = new Set(['INVALID_CONFIGURATION', 'INVALID_RUN_ID', 'UNSAFE_COMMAND', 'COMMAND_BUDGET_EXCEEDED', 'HTTP_ERROR', 'AUTH_ERROR', 'NETWORK_OR_TIMEOUT', 'INVALID_REDIS_RESPONSE', 'REDIS_COMMAND_ERROR', 'VERIFICATION_FAILED', 'MODULE_FAILURE', 'UNEXPECTED_LOG', 'SOURCE_CHANGED'])
function ensure(condition, code = 'VERIFICATION_FAILED') { if (!condition) throw new Error(code) }
function safeCode(error) { return safeCodes.has(error?.message) ? error.message : 'VERIFICATION_FAILED' }

// No environment files or network are accessed on import or in mock mode.
// The live CLI requires two explicit switches and a subsequent user approval.
export async function runRateLimitVerification({ env, transport, runId = randomBytes(8).toString('hex') }) {
  const report = {
    status: 'FAILED', checks: checkNames.map(name => ({ name, passed: false })),
    commands: { http_requests: 0, top_level: {}, limiter_evals: 0, admitted: 0, rejected: 0 },
    cleanup: { attempted: false, verified_no_remaining_keys: false },
    safety: { unique_test_namespaces: true, existing_keys_searched: false, source_files_changed: false, source_module_unmodified: true, redis_dashboard_ownership_verified: false },
  }
  const namespaces = new Set(), keys = new Set(), inFlight = new Set()
  let code, sourceBefore, compiled, firstTransportFailure
  let interpreted = 0, retryChecks = 0, storedKeyCount = 0
  const pass = name => { report.checks.find(check => check.name === name).passed = true }
  const prefix = `rlcheck-${runId}`
  const validKey = key => typeof key === 'string' && [...namespaces].some(ns =>
    new RegExp(`^registration-limit:\\{${ns}\\}:v1:(?:ip:[0-9a-f]{64}:(?:minute|hour)|global:minute)$`).test(key))
  const endpoint = env?.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '')
  const token = env?.UPSTASH_REDIS_REST_TOKEN

  async function command(payload, pipeline = false) {
    const list = pipeline ? payload : [payload]
    for (const item of list) {
      ensure(Array.isArray(item), 'UNSAFE_COMMAND')
      const [name, ...args] = item
      if (name === 'EVAL') {
        ensure(args[1] === 3 && args.slice(2, 5).every(validKey), 'UNSAFE_COMMAND')
        ensure(item.length === 12 && compiled && item[1] === luaSource, 'UNSAFE_COMMAND')
      } else if (name === 'PEXPIRE') ensure(args.length === 2 && keys.has(args[0]) && validKey(args[0]) && args[1] === ttlMs, 'UNSAFE_COMMAND')
      else if (name === 'PTTL') ensure(args.length === 1 && keys.has(args[0]) && validKey(args[0]), 'UNSAFE_COMMAND')
      else if (name === 'DEL' || name === 'EXISTS') ensure(args.length > 0 && args.every(key => keys.has(key) && validKey(key)), 'UNSAFE_COMMAND')
      else ensure(false, 'UNSAFE_COMMAND')
    }
    const count = Object.values(report.commands.top_level).reduce((sum, n) => sum + n, 0)
    ensure(report.commands.http_requests < 40 && count + list.length <= 80, 'COMMAND_BUDGET_EXCEEDED')
    for (const [name] of list) report.commands.top_level[name] = (report.commands.top_level[name] ?? 0) + 1
    report.commands.http_requests++
    const controller = new AbortController()
    let timer
    try {
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('NETWORK_OR_TIMEOUT')) }, 5_000) })
      const operation = (async () => {
        const response = await transport(endpoint + (pipeline ? '/pipeline' : ''), {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), redirect: 'error', cache: 'no-store', signal: controller.signal,
        })
        ensure(response.ok, response.status === 401 || response.status === 403 ? 'AUTH_ERROR' : 'HTTP_ERROR')
        const data = await response.json()
        const rows = pipeline ? data : [data]
        ensure(Array.isArray(rows) && rows.length === list.length, 'INVALID_REDIS_RESPONSE')
        for (const row of rows) {
          ensure(row && typeof row === 'object' && !Array.isArray(row), 'INVALID_REDIS_RESPONSE')
          ensure(!Object.hasOwn(row, 'error'), 'REDIS_COMMAND_ERROR')
          ensure(Object.keys(row).length === 1 && Object.hasOwn(row, 'result'), 'INVALID_REDIS_RESPONSE')
        }
        return data
      })()
      return await Promise.race([operation, deadline])
    } catch (error) {
      throw new Error(safeCodes.has(error?.message) ? error.message : 'NETWORK_OR_TIMEOUT')
    } finally { clearTimeout(timer) }
  }

  let luaSource
  try {
    ensure(/^[0-9a-f]{16}$/.test(runId), 'INVALID_RUN_ID')
    ensure(endpoint && /^https:\/\/[a-z0-9-]+\.upstash\.io$/.test(endpoint) && token && /^[!-~]{1,4096}$/.test(token), 'INVALID_CONFIGURATION')
    ensure(env.REGISTRATION_RATE_LIMIT_HMAC_SECRET && /^[!-~]{32,512}$/.test(env.REGISTRATION_RATE_LIMIT_HMAC_SECRET), 'INVALID_CONFIGURATION')
    ensure(env.REGISTRATION_RATE_LIMIT_NAMESPACE && !env.REGISTRATION_RATE_LIMIT_NAMESPACE.startsWith(prefix), 'INVALID_CONFIGURATION')
    const source = await readFile(modulePath, 'utf8')
    sourceBefore = createHash('sha256').update(source).digest('hex')
    compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    // One fixed script from the unmodified module; reject unexpected commands.
    const match = /const script = `([\s\S]*?)`/.exec(source)
    ensure(match, 'SOURCE_CHANGED'); luaSource = match[1]

    async function scenario(tag, limits, test) {
      const namespace = `${prefix}-${tag}`
      namespaces.add(namespace)
      const exports = {}, rawReplies = new Map()
      const config = {
        UPSTASH_REDIS_REST_URL: endpoint, UPSTASH_REDIS_REST_TOKEN: token,
        REGISTRATION_RATE_LIMIT_HMAC_SECRET: env.REGISTRATION_RATE_LIMIT_HMAC_SECRET,
        REGISTRATION_RATE_LIMIT_NAMESPACE: namespace,
        REGISTRATION_RATE_LIMIT_IP_PER_MINUTE: String(limits[0]),
        REGISTRATION_RATE_LIMIT_IP_PER_HOUR: String(limits[1]),
        REGISTRATION_RATE_LIMIT_GLOBAL_PER_MINUTE: String(limits[2]),
      }
      let sequence = 0
      // The original fetch/EVAL bytes are preserved. Only exact generated test
      // keys are subsequently given a 30s TTL; original 60s/3600s values are checked.
      const moduleFetch = (...args) => {
        const requestId = ++sequence
        const task = (async () => {
          try {
            ensure(args[0] === endpoint && args[1].method === 'POST', 'UNSAFE_COMMAND')
            const payload = JSON.parse(args[1].body)
            ensure(JSON.stringify(payload.slice(-3)) === '[60000,3600000,60000]', 'SOURCE_CHANGED')
            const ownKeys = payload.slice(3, 6)
            const newKeys = ownKeys.filter(key => !keys.has(key))
            ownKeys.forEach(key => { ensure(validKey(key), 'UNSAFE_COMMAND'); keys.add(key) })
            ensure(!args[1].body.includes(env.REGISTRATION_RATE_LIMIT_HMAC_SECRET), 'UNSAFE_COMMAND')
            for (const ip of ips) ensure(!args[1].body.includes(ip), 'UNSAFE_COMMAND')
            report.commands.limiter_evals++
            const result = await command(payload)
            const raw = result.result
            ensure(Array.isArray(raw) && raw.length === 2 && raw.every(Number.isSafeInteger), 'INVALID_REDIS_RESPONSE')
            ensure((raw[0] === 1 && raw[1] === 0) || (raw[0] === 0 && raw[1] > 0 && raw[1] <= 3_600_000), 'INVALID_REDIS_RESPONSE')
            rawReplies.set(requestId, raw)
            if (raw[0] === 1) report.commands.admitted++; else report.commands.rejected++
            if (newKeys.length) {
              const shortened = await command(newKeys.map(key => ['PEXPIRE', key, ttlMs]), true)
              ensure(shortened.every(row => row.result === 0 || row.result === 1), 'INVALID_REDIS_RESPONSE')
            }
            return { ok: true, json: async () => result }
          } catch (error) { firstTransportFailure ??= safeCode(error); throw error }
        })()
        inFlight.add(task)
        task.then(() => inFlight.delete(task), () => inFlight.delete(task))
        return task
      }
      vm.runInNewContext(compiled, {
        exports, URL, AbortController, setTimeout, clearTimeout, process: { env: config }, fetch: moduleFetch,
        require: name => { if (name === 'server-only') return {}; if (name === 'node:crypto') return crypto; if (name === 'node:net') return net; throw new Error('SOURCE_CHANGED') },
        console: Object.fromEntries(['log', 'error', 'warn', 'info', 'debug'].map(name => [name, () => { throw new Error('UNEXPECTED_LOG') }])),
      })
      const invoke = async ip => {
        const id = sequence + 1
        const result = await exports.checkRegistrationRateLimit(ip)
        if (firstTransportFailure) throw new Error(firstTransportFailure)
        ensure(result.ok || result.code === 'RATE_LIMIT_EXCEEDED', 'MODULE_FAILURE')
        const raw = rawReplies.get(id)
        ensure(raw && result.ok === (raw[0] === 1))
        if (!result.ok) { ensure(result.retryAfterSeconds === Math.ceil(raw[1] / 1000)); retryChecks++ }
        interpreted++
        return result
      }
      await test(invoke, rawReplies)
    }

    await scenario('minute', [2, 10, 20], async invoke => {
      ensure((await invoke(ips[0])).ok); ensure((await invoke(ips[0])).ok); pass('within_limit')
      ensure(!(await invoke(ips[0])).ok); pass('ip_minute_limit')
      ensure((await invoke(ips[3])).ok); pass('different_ips')
      ensure((await invoke('2001:0db8:0:0:0:0:0:1')).ok)
      ensure(!(await invoke('2001:DB8::1')).ok)
      ensure(!(await invoke('::ffff:192.0.2.25')).ok); pass('ipv4_ipv6_identity')
    })
    await scenario('hour', [10, 2, 20], async invoke => {
      ensure((await invoke(ips[0])).ok); ensure((await invoke(ips[0])).ok)
      ensure(!(await invoke(ips[0])).ok); pass('ip_hour_limit')
    })
    await scenario('global', [10, 20, 2], async invoke => {
      ensure((await invoke(ips[0])).ok); ensure((await invoke(ips[1])).ok)
      ensure(!(await invoke(ips[2])).ok); pass('global_minute_limit')
    })
    await scenario('concurrent', [3, 20, 20], async invoke => {
      // Settle all already-launched requests before cleanup, even on failure.
      const settled = await Promise.allSettled(Array.from({ length: 8 }, () => invoke(ips[0])))
      ensure(settled.every(result => result.status === 'fulfilled'), firstTransportFailure ?? 'VERIFICATION_FAILED')
      const results = settled.map(result => result.value)
      ensure(results.filter(result => result.ok).length === 3)
      ensure(results.filter(result => !result.ok).length === 5); pass('concurrent_limit')
    })
    ensure(retryChecks === 10); pass('retry_after')
    ensure(interpreted === 21 && report.commands.limiter_evals === 21); pass('lua_result_interpretation')
    ensure(keys.size === 18 && [...keys].every(validKey)); pass('private_keys')
    const ttls = await command([...keys].map(key => ['PTTL', key]), true)
    ensure(ttls.every(row => row.result === -2 || (Number.isInteger(row.result) && row.result > 0 && row.result <= ttlMs)))
    storedKeyCount = ttls.filter(row => row.result > 0).length
    ensure(storedKeyCount === 16)
    report.ttl = { temporary_max_ms: ttlMs, present_keys_checked: storedKeyCount, nonexistent_keys: keys.size - storedKeyCount, original_limiter_windows_ms: [60_000, 3_600_000, 60_000] }
  } catch (error) { code = safeCode(error) }
  finally {
    await Promise.allSettled([...inFlight])
    if (keys.size) {
      report.cleanup.attempted = true
      try {
        const removed = await command(['DEL', ...keys])
        ensure(Number.isSafeInteger(removed.result) && removed.result >= 0 && removed.result <= keys.size)
        report.cleanup.deleted_test_keys = removed.result
        const remaining = await command(['EXISTS', ...keys])
        ensure(remaining.result === 0)
        report.cleanup.verified_no_remaining_keys = true
      } catch (error) { report.cleanup.error = safeCode(error); code ??= report.cleanup.error }
    }
    try {
      if (sourceBefore) ensure(createHash('sha256').update(await readFile(modulePath)).digest('hex') === sourceBefore, 'SOURCE_CHANGED')
    } catch { code ??= 'SOURCE_CHANGED'; report.safety.source_module_unmodified = false }
  }
  report.commands.top_level_total = Object.values(report.commands.top_level).reduce((sum, value) => sum + value, 0)
  // Successful Lua: six GET/PTTL per EVAL, three INCR per admission, one
  // PEXPIRE per newly created key. Provider billing semantics are not assumed.
  if (!code && storedKeyCount) report.commands.lua_internal_estimate = 6 * report.commands.limiter_evals + 3 * report.commands.admitted + storedKeyCount
  report.status = !code && report.checks.every(check => check.passed) && report.cleanup.verified_no_remaining_keys ? 'SUCCESS' : 'FAILED'
  if (code) report.error = code
  return report
}

// Synthetic Redis protocol mock. It deliberately does not claim to execute Lua.
export function createMockRedisTransport({ fault } = {}) {
  const values = new Map(), requests = []
  let injected = false
  function execute(command) {
    const [name, ...args] = command
    if (name === 'EVAL') {
      if (fault === 'eval' && !injected) { injected = true; return { error: 'SYNTHETIC_SECRET' } }
      const keys = args.slice(2, 5), limits = args.slice(5, 8), windows = args.slice(8, 11)
      let retry = 0
      for (let i = 0; i < 3; i++) {
        const value = values.get(keys[i])
        if (value && value.count >= limits[i]) retry = Math.max(retry, value.ttl)
      }
      if (retry) return { result: [0, retry] }
      keys.forEach((key, i) => { const row = values.get(key) ?? { count: 0, ttl: windows[i] }; row.count++; values.set(key, row) })
      return { result: [1, 0] }
    }
    if (name === 'PEXPIRE') {
      if (fault === 'maintenance' && !injected) { injected = true; return { error: 'SYNTHETIC_SECRET_TOKEN' } }
      const row = values.get(args[0]); if (row) row.ttl = args[1]; return { result: row ? 1 : 0 } }
    if (name === 'PTTL') return { result: values.get(args[0])?.ttl ?? -2 }
    if (name === 'DEL') { let count = 0; for (const key of args) if (values.delete(key)) count++; return { result: count } }
    if (name === 'EXISTS') return { result: args.filter(key => values.has(key)).length }
    throw new Error('UNSAFE_COMMAND')
  }
  const transport = async (url, options) => {
    requests.push({ url, options })
    if (fault === 'network' && !injected) { injected = true; throw new Error('SYNTHETIC_SECRET_TOKEN') }
    const payload = JSON.parse(options.body)
    const data = url.endsWith('/pipeline') ? payload.map(execute) : execute(payload)
    return { ok: true, status: 200, json: async () => data }
  }
  return { transport, requests, remainingCount: () => values.size }
}

async function main() {
  let report
  try {
    const { values } = parseArgs({ options: { mock: { type: 'boolean' }, execute: { type: 'boolean' }, 'confirm-project-target': { type: 'string' } } })
    ensure(Boolean(values.mock) !== Boolean(values.execute), 'INVALID_CONFIGURATION')
    if (values.mock) {
      const mock = createMockRedisTransport()
      report = await runRateLimitVerification({ env: {
        UPSTASH_REDIS_REST_URL: 'https://synthetic.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'SYNTHETIC_TOKEN',
        REGISTRATION_RATE_LIMIT_HMAC_SECRET: 'SYNTHETIC_INDEPENDENT_SECRET_123456789', REGISTRATION_RATE_LIMIT_NAMESPACE: 'synthetic-existing',
      }, transport: mock.transport })
      report.mode = 'mock'
      report.external_network_used = false
    } else {
      ensure(values['confirm-project-target'] === 'shinseikai-hub', 'INVALID_CONFIGURATION')
      const envPath = path.join(root, '.env.local')
      const original = await readFile(envPath)
      const env = parseEnv(original.toString('utf8'))
      report = await runRateLimitVerification({ env, transport: globalThis.fetch })
      report.mode = 'live'
      report.project_target_asserted_by_operator = true
      report.env_file_unchanged = original.equals(await readFile(envPath))
      if (!report.env_file_unchanged) report.status = 'FAILED'
    }
  } catch { report = { status: 'FAILED', error: 'LOCAL_SETUP_ERROR', raw_errors_saved: false } }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = report.status === 'SUCCESS' ? 0 : 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
