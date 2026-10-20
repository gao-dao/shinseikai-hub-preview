import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { runRateLimitVerification, createMockRedisTransport } from '../scripts/redis-verification/verify-rate-limit.mjs'

const script = 'scripts/redis-verification/verify-rate-limit.mjs'
const env = {
  UPSTASH_REDIS_REST_URL: 'https://synthetic.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'SYNTHETIC_TOKEN_PRIVATE',
  REGISTRATION_RATE_LIMIT_HMAC_SECRET: 'SYNTHETIC_HMAC_PRIVATE_12345678901234567890', REGISTRATION_RATE_LIMIT_NAMESPACE: 'existing-development',
}
const runId = '1234567890abcdef'
const safe = report => {
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_TOKEN|SYNTHETIC_HMAC|SYNTHETIC_SECRET|https:\/\/|192\.0\.2|2001:|request_fingerprint|redis\.call/)
}

test('Redis verification script passes node --check without executing any code', () => {
  const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('all ten checks run using only a mock and cleanup leaves zero synthetic keys', async () => {
  const mock = createMockRedisTransport()
  const report = await runRateLimitVerification({ env, transport: mock.transport, runId })
  assert.equal(report.status, 'SUCCESS')
  assert.equal(report.checks.length, 10)
  assert.ok(report.checks.every(check => check.passed))
  assert.equal(report.commands.limiter_evals, 21)
  assert.equal(report.commands.admitted, 11)
  assert.equal(report.commands.rejected, 10)
  assert.equal(report.cleanup.deleted_test_keys, 16)
  assert.equal(report.cleanup.verified_no_remaining_keys, true)
  assert.equal(mock.remainingCount(), 0)
  assert.equal(report.ttl.present_keys_checked, 16)
  assert.equal(report.ttl.temporary_max_ms, 30000)
  safe(report)
})

test('command budget is finite and counts HTTP, EVAL and Lua internal operations separately', async () => {
  const mock = createMockRedisTransport()
  const report = await runRateLimitVerification({ env, transport: mock.transport, runId })
  assert.deepEqual(report.commands.top_level, { EVAL: 21, PEXPIRE: 18, PTTL: 18, DEL: 1, EXISTS: 1 })
  assert.equal(report.commands.top_level_total, 59)
  assert.equal(report.commands.http_requests, 31)
  assert.equal(mock.requests.length, 31)
  assert.equal(report.commands.lua_internal_estimate, 175)
})

test('only generated exact HMAC keys may be maintained or deleted; no scan or existing namespace access', async () => {
  const mock = createMockRedisTransport()
  await runRateLimitVerification({ env, transport: mock.transport, runId })
  const keys = new Set()
  for (const request of mock.requests) {
    const payload = JSON.parse(request.options.body)
    const commands = request.url.endsWith('/pipeline') ? payload : [payload]
    for (const [name, ...args] of commands) {
      assert.ok(['EVAL', 'PEXPIRE', 'PTTL', 'DEL', 'EXISTS'].includes(name))
      const affected = name === 'EVAL' ? args.slice(2,5) : name === 'DEL' || name === 'EXISTS' ? args : [args[0]]
      for (const key of affected) {
        assert.match(key, /^registration-limit:\{rlcheck-1234567890abcdef-(?:minute|hour|global|concurrent)\}:v1:(?:ip:[a-f0-9]{64}:(?:minute|hour)|global:minute)$/)
        assert.equal(key.includes(env.REGISTRATION_RATE_LIMIT_NAMESPACE), false)
        keys.add(key)
      }
      if (name === 'PEXPIRE') assert.equal(args[1], 30000)
    }
  }
  assert.equal(keys.size,18)
})

test('two runs allocate different test namespaces without reusing existing state', async () => {
  const mock = createMockRedisTransport()
  for (let i=0;i<2;i++) assert.equal((await runRateLimitVerification({env,transport:mock.transport})).status,'SUCCESS')
  const used = mock.requests.flatMap(request => {
    const body=JSON.parse(request.options.body)
    return body[0]==='EVAL' ? [body[3].split(':v1:')[0]] : []
  })
  assert.equal(new Set(used).size,8)
  assert.equal(mock.remainingCount(),0)
})

for (const fault of ['eval','network','maintenance']) test(`failure ${fault} stops without retry, redacts details, and still cleans known test keys`, async () => {
  const mock=createMockRedisTransport({fault})
  const report=await runRateLimitVerification({env,transport:mock.transport,runId})
  assert.equal(report.status,'FAILED')
  assert.equal(report.commands.limiter_evals,1)
  assert.equal(report.checks.some(check=>check.passed),false)
  assert.equal(report.cleanup.verified_no_remaining_keys,true)
  assert.equal(mock.remainingCount(),0)
  assert.ok(['REDIS_COMMAND_ERROR','NETWORK_OR_TIMEOUT'].includes(report.error))
  safe(report)
})

test('configuration and run-id validation fail before any mock command', async () => {
  for (const options of [{env:{}},{env:{...env,UPSTASH_REDIS_REST_URL:'https://attacker.test'}},{env:{...env,REGISTRATION_RATE_LIMIT_HMAC_SECRET:'short'}},{env,runId:'unsafe*'},{env:{...env,REGISTRATION_RATE_LIMIT_NAMESPACE:'rlcheck-'+runId}}]) {
    const mock=createMockRedisTransport()
    const report=await runRateLimitVerification({env,runId,...options,transport:mock.transport})
    assert.equal(report.status,'FAILED')
    assert.equal(report.commands.http_requests,0)
    assert.equal(mock.requests.length,0)
    safe(report)
  }
})

test('runner executes the original limiter EVAL without replacing script or native window arguments', async () => {
  const source=await readFile('lib/security/registration-rate-limit.ts','utf8')
  const expected=/const script = `([\s\S]*?)`/.exec(source)[1]
  const mock=createMockRedisTransport()
  await runRateLimitVerification({env,transport:mock.transport,runId})
  for(const request of mock.requests) {
    const body=JSON.parse(request.options.body)
    if(body[0]==='EVAL') {
      assert.equal(body[1],expected)
      assert.deepEqual(body.slice(-3),[60000,3600000,60000])
    }
  }
  assert.equal(createHash('sha256').update(await readFile('lib/security/registration-rate-limit.ts')).digest('hex'),createHash('sha256').update(source).digest('hex'))
})

test('live CLI requires explicit execute and project-target confirmation before reading credentials', () => {
  for(const args of [[],['--execute'],['--execute','--confirm-project-target','other-project'],['--mock','--execute']]) {
    const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8'})
    assert.equal(result.status,1)
    const report=JSON.parse(result.stdout)
    assert.equal(report.error,'LOCAL_SETUP_ERROR')
    assert.equal(result.stderr,'')
    safe(report)
  }
})

test('mock CLI runs all checks without selecting live mode or reading .env.local', () => {
  const result=spawnSync(process.execPath,[script,'--mock'],{encoding:'utf8'})
  assert.equal(result.status,0)
  const report=JSON.parse(result.stdout)
  assert.equal(report.mode,'mock')
  assert.equal(report.external_network_used,false)
  assert.equal(report.status,'SUCCESS')
  safe(report)
})
