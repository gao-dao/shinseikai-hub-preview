import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as crypto from 'node:crypto'
import * as net from 'node:net'

const secret = 'SYNTHETIC_INDEPENDENT_HMAC_SECRET_123456789'
const token = 'SYNTHETIC_REDIS_TOKEN'
const ip = '192.0.2.25'
const env = { UPSTASH_REDIS_REST_URL: 'https://synthetic.upstash.io', UPSTASH_REDIS_REST_TOKEN: token, REGISTRATION_RATE_LIMIT_HMAC_SECRET: secret, REGISTRATION_RATE_LIMIT_NAMESPACE: 'synthetic-test' }
const source = fs.readFileSync('lib/security/registration-rate-limit.ts', 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

// Shared mock Redis state is outside module instances. EVAL admission is processed
// synchronously as one operation; tests do not contact a database or execute Lua.
function sharedStore() {
  let now = 0
  const state = new Map()
  return { advance: ms => { now += ms }, execute(command) {
    const [name, script, keyCount, ...args] = command
    assert.equal(name, 'EVAL')
    assert.equal(keyCount, 3)
    assert.match(script, /redis.call\('GET', KEYS\[i\]\)/)
    assert.match(script, /redis.call\('PTTL', KEYS\[i\]\)/)
    assert.match(script, /redis.call\('INCR', KEYS\[i\]\)/)
    assert.match(script, /redis.call\('PEXPIRE', KEYS\[i\], ARGV\[i \+ 3\]\)/)
    assert.ok(script.indexOf('if retry > 0 then return') < script.indexOf("redis.call('INCR'"))
    const keys = args.slice(0, 3), limits = args.slice(3, 6), windows = args.slice(6, 9)
    for (const key of keys) if (state.has(key) && state.get(key).expires <= now) state.delete(key)
    const blocked = keys.flatMap((key, i) => state.has(key) && state.get(key).count >= limits[i] ? [state.get(key).expires - now] : [])
    if (blocked.length) return { result: [0, Math.max(...blocked)] }
    keys.forEach((key, i) => {
      const row = state.get(key) ?? { count: 0, expires: now + windows[i] }
      row.count++; state.set(key, row)
    })
    return { result: [1, 0] }
  } }
}

function setup({ configuration = env, store = sharedStore(), response, httpOk = true, throws = false, jsonThrows = false, hang = false, hangJson = false } = {}) {
  const exports = {}, calls = [], logs = [], timers = [], cleared = []
  vm.runInNewContext(compiled, {
    exports, URL, AbortController, process: { env: { ...configuration } },
    require: name => { assert.ok(['server-only', 'node:crypto', 'node:net'].includes(name)); return name === 'node:crypto' ? crypto : name === 'node:net' ? net : {} },
    console: Object.fromEntries(['log','warn','error','info','debug'].map(name => [name, (...args) => logs.push(args)])),
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer }, clearTimeout: timer => cleared.push(timer),
    fetch: async (...args) => {
      calls.push(args)
      if (throws) throw new Error(secret + token + ip)
      if (hang) return new Promise(() => {})
      return { ok: httpOk, json: async () => {
        if (jsonThrows) throw new Error(secret + token + ip)
        if (hangJson) return new Promise(() => {})
        return response === undefined ? store.execute(JSON.parse(args[1].body)) : response
      } }
    },
  })
  return { check: exports.checkRegistrationRateLimit, calls, logs, timers, cleared, store }
}

test('rate limit admits five requests then blocks with positive Retry-After and window expiry', async () => {
  const context = setup()
  for (let i = 0; i < 5; i++) assert.equal((await context.check(ip)).ok, true)
  let result = await context.check(ip)
  assert.equal(result.code, 'RATE_LIMIT_EXCEEDED')
  assert.equal(result.retryAfterSeconds, 60)
  context.store.advance(59_999)
  assert.equal((await context.check(ip)).retryAfterSeconds, 1)
  context.store.advance(1)
  result = await context.check(ip)
  assert.equal(result.ok, true)
  assert.deepEqual(context.logs, [])
})

test('rate limit module instances share Redis quotas and concurrent admissions cannot exceed five', async () => {
  const store = sharedStore(), a = setup({ store }), b = setup({ store })
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).check(ip)))
  assert.equal(results.filter(r => r.ok).length, 5)
  assert.equal(results.filter(r => r.code === 'RATE_LIMIT_EXCEEDED').length, 7)
  assert.equal(a.calls.length + b.calls.length, 12)
})

test('hour limit remains after minute windows reset', async () => {
  const context = setup()
  for (let minute = 0; minute < 6; minute++) {
    for (let i = 0; i < 5; i++) assert.equal((await context.check(ip)).ok, true)
    context.store.advance(60_000)
  }
  const result = await context.check(ip)
  assert.equal(result.code, 'RATE_LIMIT_EXCEEDED')
  assert.equal(result.retryAfterSeconds, 3240)
})

test('API global limit blocks different IPs across module instances independently of per-IP limit', async () => {
  const store = sharedStore(), configuration = { ...env, REGISTRATION_RATE_LIMIT_GLOBAL_PER_MINUTE: '2' }
  const a = setup({ configuration, store }), b = setup({ configuration, store })
  assert.equal((await a.check('192.0.2.1')).ok, true)
  assert.equal((await b.check('192.0.2.2')).ok, true)
  assert.equal((await a.check('192.0.2.3')).code, 'RATE_LIMIT_EXCEEDED')
  const keys = context => JSON.parse(context.calls[0][1].body).slice(3,6)
  assert.equal(keys(a)[2], keys(b)[2])
  assert.notEqual(keys(a)[0], keys(b)[0])
})

test('Redis sees only namespaced HMAC identifiers, fixed script and numeric limits; secret is independent', async () => {
  const context = setup({ configuration: { ...env, SUPABASE_SECRET_KEY: 'SUPABASE_SECRET_NOT_USED' } })
  const result = await context.check(ip)
  assert.equal(result.ok, true)
  const [url, options] = context.calls[0]
  assert.equal(url, env.UPSTASH_REDIS_REST_URL)
  assert.equal(options.headers.Authorization, `Bearer ${token}`)
  const command = JSON.parse(options.body)
  const digest = crypto.createHmac('sha256', secret).update(`registration-ip:v1:${ip}`).digest('hex')
  assert.match(command[3], new RegExp(digest))
  assert.deepEqual(command.slice(6), [5,30,100,60_000,3_600_000,60_000])
  assert.doesNotMatch(options.body, new RegExp(ip.replaceAll('.', '\\.') + '|' + secret + '|SUPABASE_SECRET_NOT_USED'))
  assert.equal(options.credentials, 'omit')
  assert.equal(options.redirect, 'error')
  assert.equal(options.cache, 'no-store')
  assert.equal(context.timers[0].delay, 5000)
  assert.equal(context.cleared.length, 1)
  assert.deepEqual(context.logs, [])
})

test('IPv6 equivalent forms and IPv4 mapped addresses share normalized quotas', async () => {
  const context = setup()
  await context.check('2001:0db8:0:0:0:0:0:1')
  await context.check('2001:db8::1')
  await context.check('2001:DB8::1')
  await context.check('::ffff:192.0.2.25')
  await context.check(ip)
  const keys = context.calls.map(call => JSON.parse(call[1].body)[3])
  assert.equal(keys[0],keys[1]); assert.equal(keys[1],keys[2]); assert.equal(keys[3],keys[4])
})

test('missing, malformed or forwarded IP inputs cannot be treated as verified IPs', async () => {
  for (const value of [undefined,null,'',false,{}, { headers: { 'x-forwarded-for':ip } },'unknown','192.0.2.1, 192.0.2.2',' '+ip,'[2001:db8::1]','fe80::1%eth0','999.1.1.1']) {
    const context = setup()
    assert.equal((await context.check(value)).code,'RATE_LIMIT_IP_UNAVAILABLE')
    assert.equal(context.calls.length,0)
    assert.deepEqual(context.logs,[])
  }
})

test('configuration is mandatory, bounded and cannot redirect the Redis bearer token', async () => {
  const configurations = [{}, ...Object.keys(env).flatMap(key => [{...env,[key]:undefined},{...env,[key]:''}]),
    ...['http://synthetic.upstash.io','https://attacker.test','https://synthetic.upstash.io.attacker.test','https://synthetic.upstash.io/path','https://user@synthetic.upstash.io','https://synthetic.upstash.io?token=x','https://synthetic.upstash.io/#x'].map(url => ({...env,UPSTASH_REDIS_REST_URL:url})),
    {...env,REGISTRATION_RATE_LIMIT_HMAC_SECRET:'short'}, {...env,REGISTRATION_RATE_LIMIT_NAMESPACE:'invalid namespace'}, {...env,UPSTASH_REDIS_REST_TOKEN:'bad\ntoken'}]
  for(const field of ['REGISTRATION_RATE_LIMIT_IP_PER_MINUTE','REGISTRATION_RATE_LIMIT_IP_PER_HOUR','REGISTRATION_RATE_LIMIT_GLOBAL_PER_MINUTE']) for(const value of ['','0','-1','1.5','1000001','Infinity',' 5','05']) configurations.push({...env,[field]:value})
  for(const configuration of configurations) {
    const context=setup({configuration})
    assert.equal((await context.check(ip)).code,'RATE_LIMIT_CONFIG_ERROR')
    assert.equal(context.calls.length,0)
    assert.deepEqual(context.logs,[])
  }
})

test('configured quotas override defaults and namespaces/HMAC secrets isolate deployments', async () => {
  const context=setup({configuration:{...env,REGISTRATION_RATE_LIMIT_IP_PER_MINUTE:'1',REGISTRATION_RATE_LIMIT_IP_PER_HOUR:'2',REGISTRATION_RATE_LIMIT_GLOBAL_PER_MINUTE:'3'}})
  assert.equal((await context.check(ip)).ok,true)
  assert.equal((await context.check(ip)).code,'RATE_LIMIT_EXCEEDED')
  const other=setup({configuration:{...env,REGISTRATION_RATE_LIMIT_NAMESPACE:'preview',REGISTRATION_RATE_LIMIT_HMAC_SECRET:secret+'different'}})
  await other.check(ip)
  assert.notEqual(JSON.parse(context.calls[0][1].body)[3],JSON.parse(other.calls[0][1].body)[3])
})

for(const phase of ['fetch','json']) test(`Redis timeout during ${phase} aborts and never fails open or retries`, async()=>{
  const context=setup({hang:phase==='fetch',hangJson:phase==='json'})
  const pending=context.check(ip)
  await Promise.resolve()
  context.timers[0].callback()
  const result=await pending
  assert.equal(result.code,'RATE_LIMIT_TIMEOUT')
  assert.equal(context.calls[0][1].signal.aborted,true)
  assert.equal(context.calls.length,1)
  assert.equal(context.cleared.length,1)
  assert.deepEqual(context.logs,[])
})

test('HTTP, network and JSON failures never fail open, retry or leak errors', async()=>{
  for(const scenario of [{httpOk:false},{throws:true},{jsonThrows:true}]) {
    const context=setup(scenario), result=await context.check(ip)
    assert.equal(result.code,'RATE_LIMIT_UNAVAILABLE')
    assert.equal(context.calls.length,1)
    assert.doesNotMatch(JSON.stringify(result),new RegExp(secret+'|'+token+'|192\\.0\\.2\\.25'))
    assert.deepEqual(context.logs,[])
  }
})

test('Redis script errors and malformed replies never become admissions', async()=>{
  for(const response of [null,[],{}, {error:secret+token+ip},{result:[1,0],error:'error'},{result:'OK'},{result:[true,0]},{result:[1,'0']},{result:[1,1]},{result:[0,0]},{result:[0,-1]},{result:[0,3_600_001]},{result:[2,0]},{result:[1,0,0]}]) {
    const context=setup({response}),result=await context.check(ip)
    assert.equal(result.code,'RATE_LIMIT_UNAVAILABLE')
    assert.equal(context.calls.length,1)
    assert.deepEqual(context.logs,[])
    assert.doesNotMatch(JSON.stringify(result),new RegExp(secret+'|'+token+'|192\\.0\\.2\\.25'))
  }
})

test('Retry-After rounds upward and may cover the full hour limit', async()=>{
  for(const [ms,seconds] of [[1,1],[1001,2],[3_600_000,3600]]) {
    const result=await setup({response:{result:[0,ms]}}).check(ip)
    assert.equal(result.retryAfterSeconds,seconds)
  }
})

test('rate limiting is server-only with no header trust heuristic or Supabase dependency',()=>{
  assert.match(source,/^import 'server-only'/)
  assert.doesNotMatch(source,/from ['"].*(?:supabase|registrations)|headers\.get|x-forwarded-for|cf-connecting-ip/)
})
