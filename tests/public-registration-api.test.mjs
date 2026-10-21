import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function compile(path, dependencies = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, URL, TextDecoder, Uint8Array, ...globals, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}
const details = compile('lib/registrations/details.ts')
const proxy = compile('lib/registrations/proxy-registration.ts', { './details': details })
const validation = compile('lib/registrations/public-registration.ts', { './proxy-registration': proxy })
const origin = 'https://shinseikai-hub.vercel.app'
const key = '12345678-ABCD-4ABC-8ABC-123456789ABC'
const secret = 'SYNTHETIC_SECRET_NO_REAL_CREDENTIALS'
const valid = { event_group_id: 5, name: ' Synthetic attendee ', contact: ' synthetic.contact.invalid ', notes: ' Synthetic memo ', schedule_ids: [12,11], turnstile_token: 'synthetic-token' }
const registered = { success: true, code: 'REGISTERED', http_status: 201 }
const plain = value => JSON.parse(JSON.stringify(value))
function setup({ configuration = { REGISTRATION_ALLOWED_ORIGINS: origin }, turnstileResult = { ok: true }, rpcData = registered, rpcError = null, rpcThrows = false, stageThrows, realTurnstile = false } = {}) {
  const calls = [], rpcCalls = [], clients = [], logs = [], outbound = []
  const globals = {
    process: { env: { ...configuration } }, URL, AbortController, setTimeout, clearTimeout,
    console: Object.fromEntries(['log','error','warn','info','debug'].map(name => [name,(...args)=>logs.push(args)])),
    fetch: async (...args) => { outbound.push(args); throw new Error('Unexpected external access') },
  }
  const service = compile('lib/supabase/registration-service.ts', {
    'server-only': {}, '@/lib/registrations/public-registration': validation,
    '@supabase/supabase-js': { createClient: (...args) => {
      clients.push(args)
      return { rpc: async (...args) => { calls.push('rpc'); rpcCalls.push(args); if (rpcThrows) throw new Error(secret); return { data: rpcData, error: rpcError } } }
    } },
  }, { ...globals, process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'http://mock.invalid', SUPABASE_SECRET_KEY: secret } } })
  const turnstileModule = realTurnstile ? compile('lib/security/turnstile.ts', { 'server-only':{} }, globals) : null
  const route = compile('app/api/registrations/route.ts', {
    'next/server': { NextResponse: { json: (body,options) => Response.json(body,options) } },
    '@/lib/registrations/public-registration': { ...validation, validatePublicRegistration: (...args) => { calls.push('validate'); return validation.validatePublicRegistration(...args) } },
    '@/lib/security/turnstile': { verifyTurnstile: async token => { calls.push('turnstile'); assert.equal(typeof token,'string'); if(stageThrows==='turnstile') throw new Error(secret); return turnstileModule ? turnstileModule.verifyTurnstile(token) : turnstileResult } },
    '@/lib/supabase/registration-service': { submitPublicRegistration: async (...args) => { calls.push(['service',...args]); return service.submitPublicRegistration(...args) } },
  }, globals)
  return { calls, rpcCalls, clients, logs, outbound, route,
    async post(body=valid,{ headers={}, raw=false, stream }={}) {
      const requestHeaders = new Headers({ Origin:origin,'Content-Type':'application/json','Idempotency-Key':key,'x-real-ip':'192.0.2.25',...headers })
      for(const [name,value] of Object.entries(headers)) if(value===null) requestHeaders.delete(name)
      const request = new Request(origin+'/api/registrations',{method:'POST',headers:requestHeaders,body:stream ?? (raw ? body : JSON.stringify(body)),...(stream ? {duplex:'half'} : {})})
      const response=await route.POST(request)
      assert.equal(response.headers.get('Cache-Control'),'no-store')
      const result=await response.json()
      assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_SECRET|Synthetic attendee|synthetic\.contact|Synthetic memo|synthetic-token|192\.0\.2\.25/)
      assert.deepEqual(logs,[])
      return {status:response.status,body:result,headers:response.headers}
    },
  }
}
function noRpc(context) { assert.equal(context.rpcCalls.length,0); assert.equal(context.clients.length,0) }

test('public POST orders security stages and invokes one server-only RPC with normalized six arguments', async()=>{
  const context=setup(),result=await context.post(valid,{headers:{Cookie:'secret-cookie',Authorization:'Bearer user-token'}})
  assert.equal(result.status,201)
  assert.equal(result.body.code,'REGISTERED')
  assert.deepEqual(context.calls.map(c=>Array.isArray(c)?c[0]:c),['validate','turnstile','service','rpc'])
  assert.deepEqual(plain(context.rpcCalls),[['submit_registration_idempotent',{p_idempotency_key:key.toLowerCase(),p_event_group_id:5,p_name:'Synthetic attendee',p_contact:'synthetic.contact.invalid',p_notes:'Synthetic memo',p_schedule_ids:[11,12]}]])
  const serviceCall=context.calls.find(c=>Array.isArray(c))
  assert.equal(serviceCall.length,3)
  assert.equal(Object.hasOwn(serviceCall[1],'turnstile_token'),false)
  assert.equal(JSON.stringify(context.clients).includes('user-token'),false)
  assert.equal(JSON.stringify(context.clients).includes('secret-cookie'),false)
  assert.equal(context.route.runtime,'nodejs')
})

test('saved success and replay after closure use the same key, new challenge and no availability queries',async()=>{
  const context=setup()
  const first=await context.post()
  const second=await context.post({...valid,turnstile_token:'fresh-token'})
  assert.deepEqual(first.body,second.body)
  assert.equal(first.status,201);assert.equal(second.status,201)
  assert.equal(context.rpcCalls.length,2)
  assert.deepEqual(plain(context.rpcCalls[0]),plain(context.rpcCalls[1]))
  assert.equal(context.calls.filter(c=>c==='turnstile').length,2)
  // Mock exposes no table/select API: any availability precheck would fail.
})

for(const [code,status] of [['GROUP_NOT_FOUND',404],['REGISTRATION_CLOSED',409],['CLASS_NOT_FOUND',400],['CLASS_GROUP_MISMATCH',400],['CLASS_CLOSED',409],['CAPACITY_EXCEEDED',409]]) test(`public POST maps ${code}`,async()=>{
  const context=setup({rpcData:{success:false,code,http_status:status}})
  const result=await context.post()
  assert.equal(result.status,status);assert.equal(result.body.code,code);assert.equal(context.rpcCalls.length,1)
})
for(const [code,status] of [['PT409',409],['PT410',410],['22023',400],['42501',500],['UNKNOWN',500]]) test(`public POST safely maps RPC error ${code}`,async()=>{
  const context=setup({rpcError:{code,message:secret,details:secret,hint:secret}})
  assert.equal((await context.post()).status,status)
  assert.equal(context.rpcCalls.length,1)
})

test('Origin missing, null, foreign, prefix and suffix matches are rejected before body and dependencies',async()=>{
  for(const value of [null,'null','https://attacker.test',origin+'.attacker.test',origin+'/', 'http://shinseikai-hub.vercel.app']) {
    const context=setup()
    assert.equal((await context.post(valid,{headers:{Origin:value}})).status,403)
    assert.deepEqual(context.calls,[]);noRpc(context)
  }
})

test('Origin configuration is mandatory and must consist of exact origins',async()=>{
  for(const configuration of [{},{REGISTRATION_ALLOWED_ORIGINS:''},{REGISTRATION_ALLOWED_ORIGINS:origin+'/'},{REGISTRATION_ALLOWED_ORIGINS:origin+'/path'},{REGISTRATION_ALLOWED_ORIGINS:'*'},{REGISTRATION_ALLOWED_ORIGINS:origin+','}]) {
    const context=setup({configuration})
    assert.equal((await context.post()).status,503)
    assert.deepEqual(context.calls,[]);noRpc(context)
  }
  assert.equal((await setup({configuration:{REGISTRATION_ALLOWED_ORIGINS:'https://other.test, '+origin}}).post()).status,201)
})

test('non-JSON media types are rejected before dependencies; JSON charset is accepted',async()=>{
  for(const type of [null,'text/plain','application/x-www-form-urlencoded','application/jsonp']) {
    const context=setup()
    assert.equal((await context.post(valid,{headers:{'Content-Type':type}})).status,415)
    assert.deepEqual(context.calls,[]);noRpc(context)
  }
  assert.equal((await setup().post(valid,{headers:{'Content-Type':'application/json; charset=utf-8'}})).status,201)
})

test('body declared too large or bad Content-Length fails before dependencies',async()=>{
  for(const [length,status] of [['32769',413],['999999999999999999999999',413],['bad',400],['-1',400]]) {
    const context=setup()
    assert.equal((await context.post(valid,{headers:{'Content-Length':length}})).status,status)
    assert.deepEqual(context.calls,[]);noRpc(context)
  }
})

test('stream byte limit is enforced without trusting Content-Length and cancels oversized bodies',async()=>{
  let cancelled=false
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(20_000));controller.enqueue(new Uint8Array(20_000))},cancel(){cancelled=true}})
  const context=setup()
  assert.equal((await context.post(undefined,{stream,headers:{'Content-Length':'1'}})).status,413)
  assert.equal(cancelled,true)
  assert.deepEqual(context.calls,[]);noRpc(context)
  const multibyte=JSON.stringify({...valid,notes:'あ'.repeat(12_000)})
  assert.equal((await setup().post(multibyte,{raw:true})).status,413)
})

test('exactly 32KiB is accepted and multibyte UTF-8 may span stream chunks',async()=>{
  const json=JSON.stringify(valid),bytes=new TextEncoder().encode(json)
  const padded=json+' '.repeat(32768-bytes.length)
  assert.equal((await setup().post(padded,{raw:true})).status,201)
  const body={...valid,name:'参加者'},encoded=new TextEncoder().encode(JSON.stringify(body))
  const stream=new ReadableStream({start(c){for(const byte of encoded)c.enqueue(Uint8Array.of(byte));c.close()}})
  assert.equal((await setup().post(undefined,{stream})).status,201)
})

test('malformed JSON, invalid UTF-8 and read failure are safe failures with no RPC',async()=>{
  for(const raw of ['', '{', '{"name":']) {
    const context=setup()
    assert.equal((await context.post(raw,{raw:true})).status,400)
    noRpc(context);assert.equal(context.calls.includes('turnstile'),false)
  }
  for(const stream of [new ReadableStream({start(c){c.enqueue(Uint8Array.of(255));c.close()}}),new ReadableStream({start(c){c.error(new Error(secret))}})]) {
    const context=setup()
    assert.equal((await context.post(undefined,{stream})).status,400)
    noRpc(context)
  }
})

test('invalid registration, unknown fields, challenge and key stop before Turnstile and RPC',async()=>{
  for(const body of [null,[],true,{...valid,name:''},{...valid,event_group_id:'5'},{...valid,schedule_ids:[11,11]},{...valid,extra:secret},{...valid,turnstile_token:null},{...valid,turnstile_token:''},{...valid,turnstile_token:'x'.repeat(2049)}]) {
    const context=setup()
    assert.equal((await context.post(body)).status,400)
    assert.equal(context.calls.includes('turnstile'),false);noRpc(context)
  }
  for(const value of [null,'bad-key']) {
    const context=setup()
    assert.equal((await context.post(valid,{headers:{'Idempotency-Key':value}})).status,400)
    noRpc(context)
  }
})

test('POST does not depend on IP headers, Vercel IP guards or Redis configuration',async()=>{
  const context=setup({configuration:{REGISTRATION_ALLOWED_ORIGINS:origin,NODE_ENV:'development',REGISTRATION_IP_TRUST_MODE:'invalid',UPSTASH_REDIS_REST_URL:'invalid'}})
  assert.equal((await context.post(valid,{headers:{'x-real-ip':null}})).status,201)
  assert.deepEqual(context.outbound,[])
  assert.equal(context.rpcCalls.length,1)
  assert.equal(context.calls.filter(c=>c==='turnstile').length,1)
})

test('Turnstile rejection and configuration/network/timeout failures never call RPC',async()=>{
  for(const code of ['TURNSTILE_REJECTED','TURNSTILE_INVALID_TOKEN','TURNSTILE_CONFIG_ERROR','TURNSTILE_UNAVAILABLE','TURNSTILE_TIMEOUT']) {
    const context=setup({turnstileResult:{ok:false,code,message:'確認できません'}})
    assert.equal((await context.post()).status,['TURNSTILE_REJECTED','TURNSTILE_INVALID_TOKEN'].includes(code)?403:503)
    noRpc(context)
  }
})

test('invalid RPC responses and transport failures stay safe with exactly one attempt',async()=>{
  for(const scenario of [{rpcData:null},{rpcData:{...registered,success:false}},{rpcData:{...registered,details:secret}},{rpcThrows:true}]) {
    const context=setup(scenario),result=await context.post()
    assert.equal(result.status,scenario.rpcThrows?503:500)
    assert.equal(result.body.success,false)
    assert.equal(context.rpcCalls.length,1)
    assert.match(result.body.message,/新しい申込キーで再送せず/)
  }
})

test('unexpected security dependency exceptions fail safely without calling RPC',async()=>{
  for(const stageThrows of ['turnstile']) {
    const context=setup({stageThrows})
    assert.equal((await context.post()).status,503)
    noRpc(context)
  }
})

test('Origin and real Turnstile reject missing configuration without any external access',async()=>{
  const scenarios=[
    {configuration:{},realTurnstile:true},
    {configuration:{REGISTRATION_ALLOWED_ORIGINS:origin},realTurnstile:true},
  ]
  for(const scenario of scenarios) {
    const context=setup(scenario)
    assert.equal((await context.post()).status,503)
    assert.deepEqual(context.outbound,[]);noRpc(context)
  }
})
