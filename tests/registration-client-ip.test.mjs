import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as net from 'node:net'
import * as crypto from 'node:crypto'

const env = { REGISTRATION_IP_TRUST_MODE: 'vercel-direct', VERCEL: '1', NODE_ENV: 'production', VERCEL_ENV: 'production' }
const source = fs.readFileSync('lib/security/registration-client-ip.ts', 'utf8')
function compile(path, dependencies, globals) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, ...globals, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}
function setup(configuration = env) {
  const reads = [], logs = []
  const ipModule = compile('lib/security/registration-client-ip.ts', { 'server-only': {}, 'node:net': net }, {
    process: { env: { ...configuration } },
    console: Object.fromEntries(['log','warn','error','info','debug'].map(name => [name, (...args) => logs.push(args)])),
  })
  return { reads, logs, get: values => ipModule.getRegistrationClientIp({ get: name => { reads.push(name); return values[name] ?? null } }), raw: ipModule.getRegistrationClientIp }
}
function unavailable(result) {
  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
  assert.equal(result.code, 'REGISTRATION_IP_UNAVAILABLE')
  assert.equal(Object.hasOwn(result, 'ip'), false)
}

for (const ip of ['192.0.2.25','2001:db8::1','2001:0DB8:0000:0000:0000:0000:0000:0001','::ffff:192.0.2.25']) test(`Vercel direct IP accepts single valid ${net.isIP(ip) === 4 ? 'IPv4' : 'IPv6'} address`, () => {
  const context = setup(), result = context.get({ 'x-real-ip': ip })
  assert.equal(result.ok, true)
  assert.equal(result.ip, ip)
  assert.deepEqual(context.reads, ['x-real-ip'])
  assert.deepEqual(context.logs, [])
})

test('missing, empty, malformed and multiple IPs are unavailable without exposing values', () => {
  for (const ip of [undefined,null,'',' ','192.0.2.1, 192.0.2.2','192.0.2.1,192.0.2.1','192.0.2.1:443','[2001:db8::1]','[2001:db8::1]:443','unknown','999.1.1.1','192.000.2.1','fe80::1%eth0',' 192.0.2.1','192.0.2.1\n',true,{},['192.0.2.1']]) {
    const context = setup(), result = context.get({ 'x-real-ip': ip })
    unavailable(result)
    assert.equal(JSON.stringify(result).includes('192.0.2.1'), false)
    assert.deepEqual(context.logs, [])
  }
})

test('alternate forwarded headers never act as a fallback or override', () => {
  const alternate = { 'x-forwarded-for':'192.0.2.40', 'x-vercel-forwarded-for':'192.0.2.41', 'cf-connecting-ip':'192.0.2.42', forwarded:'for=192.0.2.43' }
  for (const ip of [undefined,'invalid','192.0.2.1,192.0.2.2']) {
    const context=setup()
    unavailable(context.get({...alternate,'x-real-ip':ip}))
    assert.deepEqual(context.reads,['x-real-ip'])
  }
  assert.equal(setup().get({...alternate,'x-real-ip':'192.0.2.25'}).ip,'192.0.2.25')
})

test('local development, test and vercel dev contexts are rejected before header access', () => {
  for (const changes of [{VERCEL:undefined},{VERCEL:'0'},{NODE_ENV:'development'},{NODE_ENV:'test'},{NODE_ENV:undefined},{VERCEL_ENV:'development'}]) {
    const context=setup({...env,...changes})
    unavailable(context.get({'x-real-ip':'127.0.0.1'}))
    assert.deepEqual(context.reads,[])
  }
})

test('missing or invalid trust mode or Vercel deployment context fails closed', () => {
  for (const configuration of [{}, ...[undefined,'','auto','cloudflare','VERCEL-DIRECT','vercel-direct '].map(mode=>({...env,REGISTRATION_IP_TRUST_MODE:mode})), {...env,VERCEL:'true'}, {...env,VERCEL_ENV:undefined}, {...env,VERCEL_ENV:'unknown'}]) {
    const context=setup(configuration)
    unavailable(context.get({'x-real-ip':'192.0.2.25'}))
    assert.deepEqual(context.reads,[])
  }
  // Preview needs the same explicit server-side assertion; it is not auto-enabled.
  assert.equal(setup({...env,VERCEL_ENV:'preview'}).get({'x-real-ip':'192.0.2.25'}).ok,true)
})

test('requests cannot forge server environment or select a trust mode', () => {
  const spoof = { 'x-real-ip':'192.0.2.25', 'registration-ip-trust-mode':'vercel-direct', REGISTRATION_IP_TRUST_MODE:'vercel-direct', VERCEL:'1', NODE_ENV:'production', VERCEL_ENV:'production', 'x-vercel-id':'fake', host:'shinseikai-hub.vercel.app' }
  for(const configuration of [{},{...env,REGISTRATION_IP_TRUST_MODE:undefined},{...env,VERCEL:undefined}]) {
    const context=setup(configuration)
    unavailable(context.get(spoof))
    assert.deepEqual(context.reads,[])
  }
  const context=setup()
  assert.equal(context.get({...spoof,'registration-ip-trust-mode':'cloudflare'}).ok,true)
  assert.deepEqual(context.reads,['x-real-ip'])
})

test('header-reader exceptions and invalid arguments return safe failures with no IP or exception logs', () => {
  const context=setup(), sensitive='PRIVATE_IP_SECRET_192.0.2.25'
  for(const value of [null,undefined,{}, {get:()=>{throw new Error(sensitive)}}]) {
    const result=context.raw(value)
    unavailable(result)
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_IP_SECRET|192\.0\.2\.25/)
  }
  assert.deepEqual(context.logs,[])
})

test('successful IP connects to the existing rate limiter through mocked Redis only', async () => {
  const calls=[], logs=[], secret='INDEPENDENT_SYNTHETIC_HMAC_SECRET_123456'
  const rate=compile('lib/security/registration-rate-limit.ts', {'server-only':{},'node:net':net,'node:crypto':crypto}, {
    URL, AbortController, setTimeout, clearTimeout,
    process:{env:{UPSTASH_REDIS_REST_URL:'https://synthetic.upstash.io',UPSTASH_REDIS_REST_TOKEN:'SYNTHETIC_TOKEN',REGISTRATION_RATE_LIMIT_HMAC_SECRET:secret,REGISTRATION_RATE_LIMIT_NAMESPACE:'synthetic-test'}},
    console:{log:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},
    fetch:async(...args)=>{calls.push(args);return {ok:true,json:async()=>({result:[1,0]})}},
  })
  for(const ip of ['192.0.2.25','2001:db8::1','::ffff:192.0.2.25']) {
    const result=setup().get({'x-real-ip':ip})
    assert.equal(result.ok,true)
    assert.equal((await rate.checkRegistrationRateLimit(result.ip)).ok,true)
  }
  assert.equal(calls.length,3)
  assert.equal(JSON.parse(calls[0][1].body)[3],JSON.parse(calls[2][1].body)[3])
  for(const call of calls) assert.doesNotMatch(call[1].body,/192\.0\.2\.25|2001:db8|INDEPENDENT_SYNTHETIC/)
  assert.deepEqual(logs,[])
})

test('unavailable IP never reaches the rate limiter and module remains server-only', async () => {
  let called=false
  const result=setup({}).get({'x-real-ip':'192.0.2.25'})
  if(result.ok) {called=true}
  assert.equal(called,false)
  assert.match(source,/^import 'server-only'/)
})
