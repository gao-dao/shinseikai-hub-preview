import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import ts from 'typescript'
import {createBrowserTestHandler,assertMockResponse,mockHeader} from '../scripts/turnstile-browser/mock-server.mjs'
import {browserTestEnvironment,prepareBrowserFixture,fixtureFiles,testSiteKey,verifyMockWiring} from '../scripts/turnstile-browser/start.mjs'

const origin='http://localhost:3100',key='12345678-1234-4234-8234-123456789abc'
const body={event_group_id:900001,name:'SYNTHETIC_PERSON',contact:'SYNTHETIC_CONTACT',notes:'SYNTHETIC_NOTES',schedule_ids:[900011,900012],turnstile_token:'SYNTHETIC_TOKEN_ONE'}
const request=(value=body,method='POST',pathname='/api/registrations',headers={})=>new Request(origin+pathname,{method,headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':key,...headers},...(['GET','HEAD'].includes(method)?{}:{body:JSON.stringify(value)})})
function handler(scenario='success',extra={}) {let forwarded=0;const result=createBrowserTestHandler({origin,scenario,forward:async()=>{forwarded++;throw new Error('NO_FORWARD')},...extra});return {...result,forwarded:()=>forwarded}}
async function receive(mock,req=request()) {const result=await mock.handle(req);assertMockResponse(result);assert.equal(result.headers.get('Cache-Control'),'no-store');return result}

for(const file of ['scripts/turnstile-browser/start.mjs','scripts/turnstile-browser/mock-server.mjs'])test(`browser fixture syntax check: ${file}`,()=>{
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(result.status,0);assert.equal(result.stderr,'')
})

test('test environment selects only official public sitekey and drops all production credentials and deployment flags',()=>{
  const env=browserTestEnvironment({PATH:'/test-bin',HOME:'/synthetic-home',SUPABASE_SECRET_KEY:'PRIVATE',TURNSTILE_SECRET_KEY:'PRIVATE',UPSTASH_REDIS_REST_TOKEN:'PRIVATE',VERCEL:'1',VERCEL_ENV:'production',NODE_ENV:'production',NEXT_PUBLIC_TURNSTILE_SITE_KEY:'REAL_KEY'})
  assert.equal(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,testSiteKey)
  assert.equal(env.NODE_ENV,'development');assert.equal(env.NEXT_TELEMETRY_DISABLED,'1')
  assert.deepEqual(Object.keys(env).sort(),['HOME','NEXT_PUBLIC_TURNSTILE_SITE_KEY','NEXT_TELEMETRY_DISABLED','NODE_ENV','PATH'])
  assert.doesNotMatch(JSON.stringify(env),/PRIVATE|REAL_KEY/)
})

test('temporary frontend fixture copies no environment files, real API modules, database clients or admin pages',async()=>{
  const directory=await prepareBrowserFixture()
  try {
    assert.equal((await readdir(directory)).some(name=>name.startsWith('.env')),false)
    assert.equal((await readdir(path.join(directory,'app'))).includes('(app)'),false)
    assert.deepEqual(await readdir(path.join(directory,'lib')),['registrations'])
    for(const file of fixtureFiles)assert.deepEqual(await readFile(path.join(directory,file)),await readFile(file))
    const fallback=await readFile(path.join(directory,'app/api/registrations/route.ts'),'utf8')
    assert.match(fallback,/TEST_PROXY_REQUIRED/);assert.match(fallback,/503/)
    assert.doesNotMatch(fallback,/submit|supabase|redis|turnstile/i)
  } finally {await rm(directory,{recursive:true,force:true})}
})

test('mock wiring self-check fails closed if registration is not intercepted',async()=>{
  await verifyMockWiring()
  assert.throws(()=>assertMockResponse(new Response('{}')),/MOCK_NOT_APPLIED/)
  assert.throws(()=>assertMockResponse(new Response('{}',{headers:{[mockHeader]:'blocked-fixture-only'}})),/MOCK_NOT_APPLIED/)
})

test('normal registration is handled exactly once without forwarding and metrics contain no personal data or tokens',async()=>{
  const mock=handler(),result=await receive(mock)
  assert.equal(result.status,201);assert.equal((await result.json()).code,'REGISTERED')
  assert.equal(mock.summary().registration_posts,1);assert.equal(mock.summary().successful_mock_responses,1);assert.equal(mock.forwarded(),0)
  assert.doesNotMatch(JSON.stringify(mock.summary()),/SYNTHETIC_PERSON|SYNTHETIC_CONTACT|SYNTHETIC_NOTES|SYNTHETIC_TOKEN|12345678/)
})

test('full scenario returns only a mocked capacity error',async()=>{
  const mock=handler('full'),result=await receive(mock)
  assert.equal(result.status,409);assert.equal((await result.json()).code,'CAPACITY_EXCEEDED')
  assert.equal(mock.summary().business_errors,1);assert.equal(mock.forwarded(),0)
})

test('uncertain scenario preserves the same key and payload, refreshes token and succeeds on the one manual replay',async()=>{
  const mock=handler('unknown-retry')
  assert.equal((await receive(mock)).status,503)
  assert.equal((await receive(mock,request({...body,turnstile_token:'SYNTHETIC_TOKEN_TWO'}))).status,201)
  assert.equal(mock.summary().registration_posts,2);assert.equal(mock.summary().distinct_attempts,1)
  assert.equal(mock.summary().replay_matches,1);assert.equal(mock.summary().token_changes,1)
  assert.equal(mock.forwarded(),0)
})

test('official fixed dummy token can repeat: replay is still counted, without falsely asserting a fresh token string',async()=>{
  const mock=handler('unknown-retry')
  await receive(mock,request({...body,turnstile_token:'XXXX.DUMMY.TOKEN.XXXX'}))
  await receive(mock,request({...body,turnstile_token:'XXXX.DUMMY.TOKEN.XXXX'}))
  assert.equal(mock.summary().token_changes,0);assert.equal(mock.summary().replay_matches,1)
})

test('same-key changed registration is rejected, and mock scenarios cannot be changed by the request',async()=>{
  const mock=handler('unknown-retry')
  await receive(mock)
  const result=await receive(mock,request({...body,name:'CHANGED_PERSON'},'POST','/api/registrations?scenario=success',{'x-test-scenario':'success'}))
  assert.equal(result.status,409);assert.equal((await result.json()).code,'IDEMPOTENCY_CONFLICT')
  assert.equal(mock.summary().scenario,'unknown-retry');assert.equal(mock.forwarded(),0)
})

test('slow success remains pending until the injected delay completes',async()=>{
  let release
  const mock=handler('slow-success',{delay:()=>new Promise(resolve=>{release=resolve})})
  const pending=receive(mock)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(mock.summary().registration_posts,1);assert.equal(mock.summary().successful_mock_responses,0)
  release();assert.equal((await pending).status,201)
})

test('all unmatched API routes, unsafe paths, unsupported methods and foreign origins fail without fallback',async()=>{
  const mock=handler()
  for(const req of [request(body,'GET','/api/admin/registrations'),request(body,'POST','/api/unknown'),request(body,'GET','/%61pi/registrations'),request(body,'POST','/_next/static/unexpected'),new Request('http://attacker.test/api/registrations',{method:'POST',body:'{}'}),request(body,'GET','/_next/static/%2e%2e%2f%2e%2e%2fapi/registrations')]) {
    const result=await receive(mock,req);assert.ok(result.status>=400)
  }
  assert.equal(mock.forwarded(),0)
})

test('malformed submissions are never forwarded or counted as mock success',async()=>{
  const mock=handler()
  for(const req of [request({...body,extra:'SECRET'}),request({...body,turnstile_token:''}),request({...body,schedule_ids:[900013]}),request(body,'POST','/api/registrations',{Origin:'http://attacker.test'}),new Request(origin+'/api/registrations',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':key},body:'x'.repeat(32769)})]) {
    assert.equal((await receive(mock,req)).status,400)
  }
  assert.equal(mock.summary().successful_mock_responses,0);assert.equal(mock.forwarded(),0)
})

test('public groups/classes are synthesized locally with a full class and no external lookup',async()=>{
  const mock=handler()
  const groups=await (await receive(mock,request(undefined,'GET','/api/event-groups?page=1'))).json()
  const classes=await (await receive(mock,request(undefined,'GET','/api/event-groups/900001/classes?page=1'))).json()
  assert.equal(groups.eventGroups[0].id,900001);assert.equal(classes.schedules.length,3)
  assert.equal(classes.schedules[2].canRegister,false);assert.equal(mock.forwarded(),0)
})

test('actual form controller double-submit and manual retry work against the mandatory mock boundary',async()=>{
  function compile(file,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(requireSource(file),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,AbortController,setTimeout,clearTimeout,require:name=>{assert.ok(Object.hasOwn(deps,name));return deps[name]}});return exports}
  const sources=new Map()
  for(const file of ['lib/registrations/details.ts','lib/registrations/proxy-registration.ts','lib/registrations/public-registration.ts','lib/registrations/public-form.ts'])sources.set(file,await readFile(file,'utf8'))
  function requireSource(file){return sources.get(file)}
  const details=compile('lib/registrations/details.ts')
  const proxy=compile('lib/registrations/proxy-registration.ts',{'./details':details})
  const validation=compile('lib/registrations/public-registration.ts',{'./proxy-registration':proxy})
  const model=compile('lib/registrations/public-form.ts',{'./proxy-registration':proxy,'./public-registration':validation})
  const saved=new Map(),store={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)}
  const attempt=new model.PublicRegistrationAttempt(store,()=>key)
  const {turnstile_token,...registration}=body
  assert.equal(attempt.prepare(registration),true)
  const mock=handler('unknown-retry')
  const fetcher=async(url,options)=>receive(mock,new Request(origin+url,{...options,headers:{...options.headers,Origin:origin}}))
  const first=attempt.submit(turnstile_token,fetcher)
  assert.equal((await attempt.submit('SECOND_CLICK',fetcher)).kind,'busy')
  assert.equal((await first).kind,'unknown')
  assert.equal((await attempt.submit('SYNTHETIC_TOKEN_TWO',fetcher)).kind,'success')
  assert.equal(mock.summary().registration_posts,2);assert.equal(mock.summary().distinct_attempts,1)
  assert.doesNotMatch(JSON.stringify([...saved]),/SYNTHETIC_PERSON|SYNTHETIC_CONTACT|SYNTHETIC_NOTES|SYNTHETIC_TOKEN/)
})

test('startup is opt-in and cannot select official test sitekey for production builds',()=>{
  const result=spawnSync(process.execPath,['scripts/turnstile-browser/start.mjs'],{encoding:'utf8'})
  assert.equal(result.status,1);assert.equal(result.stdout,'')
  assert.match(result.stderr,/no real API fallback/)
})
