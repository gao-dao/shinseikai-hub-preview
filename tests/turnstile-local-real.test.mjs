import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {createRequire} from 'node:module'
import {PassThrough} from 'node:stream'
import {readFile,readdir,rm} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import {createVerificationHandler} from '../scripts/turnstile-local-real/guard.mjs'
import {childEnvironment,validateKeys,prepareFixture,createCleanup,healthProbe,waitForHealth,observeChildExit} from '../scripts/turnstile-local-real/start.mjs'
import {hiddenInput} from '../scripts/turnstile-local-real/input.mjs'

const secret='SYNTHETIC_SECRET_ONLY',site='SYNTHETIC_PUBLIC_ONLY',token='SYNTHETIC_TOKEN_ONLY'
const req=(value={token},headers={},url='http://localhost:3200/api/turnstile-check',method='POST')=>new Request(url,{method,headers:{host:'localhost:3200',origin:'http://localhost:3200','Content-Type':'application/json',...headers},...(['GET','HEAD'].includes(method)?{}:{body:JSON.stringify(value)})})
function guard(verify=async()=>({ok:true}),extra={}){return createVerificationHandler({port:3200,allowSiteverify:true,verify,...extra})}
const source=await readFile('lib/security/turnstile.ts','utf8')
function realVerifier(data,{hang=false,error=false}={}){
  const exports={},calls=[],timers=[],logs=[]
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,process:{env:{TURNSTILE_SECRET_KEY:secret,TURNSTILE_ALLOWED_HOSTNAMES:'localhost',TURNSTILE_EXPECTED_ACTION:'registration'}},AbortController,
    require:name=>{assert.equal(name,'server-only');return {}},setTimeout:fn=>{timers.push(fn);return 1},clearTimeout:()=>{},
    console:Object.fromEntries(['log','error','warn','debug','info'].map(key=>[key,(...args)=>logs.push(args)])),
    fetch:async(url,options)=>{calls.push({url,options});if(error)throw new Error(secret+token);if(hang)return new Promise(()=>{});return {ok:true,json:async()=>data}},
  })
  return {verify:exports.verifyTurnstile,calls,timers,logs}
}
for(const file of ['start','guard','input'])test(`syntax check ${file}`,()=>assert.equal(spawnSync(process.execPath,['--check',`scripts/turnstile-local-real/${file}.mjs`]).status,0))
for(const [label,data,status,code] of [
  ['success',{success:true,hostname:'localhost',action:'registration'},200,'VERIFIED'],
  ['hostname mismatch',{success:true,hostname:'shinseikai-hub.vercel.app',action:'registration'},403,'TURNSTILE_REJECTED'],
  ['action mismatch',{success:true,hostname:'localhost',action:'other'},403,'TURNSTILE_REJECTED'],
  ['rejected',{success:false,'error-codes':[secret]},403,'TURNSTILE_REJECTED'],
])test(`existing unmodified verifier integration: ${label}`,async()=>{
  const context=realVerifier(data),response=await guard(context.verify).handle(req())
  assert.equal(response.status,status);assert.equal((await response.json()).code,code)
  assert.equal(context.calls.length,1);assert.equal(context.calls[0].url,'https://challenges.cloudflare.com/turnstile/v0/siteverify')
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(context.logs,[])
})
test('Siteverify network failure is safe and never retried',async()=>{
  const context=realVerifier(null,{error:true}),response=await guard(context.verify).handle(req())
  assert.equal(response.status,503);assert.equal(context.calls.length,1)
  assert.doesNotMatch(await response.text(),new RegExp(secret+'|'+token));assert.deepEqual(context.logs,[])
})
test('existing verifier timeout fails closed without real time or HTTP',async()=>{
  const context=realVerifier(null,{hang:true}),pending=guard(context.verify).handle(req())
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(context.timers.length,1);context.timers[0]()
  const response=await pending;assert.equal(response.status,503);assert.equal((await response.json()).code,'TURNSTILE_TIMEOUT')
  assert.equal(context.calls.length,1)
})
test('same token cannot be resent even after an uncertain failure',async()=>{
  let calls=0;const handler=guard(async()=>{calls++;throw new Error(secret)})
  assert.equal((await handler.handle(req())).status,503)
  assert.equal((await handler.handle(req())).status,409);assert.equal(calls,1)
})
test('in-flight requests are rejected before a second verification and total calls are capped',async()=>{
  let resolve,calls=0
  const handler=guard(()=>{calls++;return new Promise(done=>{resolve=done})})
  const first=handler.handle(req());await new Promise(done=>setImmediate(done))
  assert.equal((await handler.handle(req({token:'another'}))).status,409)
  resolve({ok:true});await first
  for(const next of ['two','three']){const pending=handler.handle(req({token:next}));await new Promise(done=>setImmediate(done));resolve({ok:true});await pending}
  assert.equal((await handler.handle(req({token:'four'}))).status,429);assert.equal(calls,3)
})
for(const headers of [{host:'127.0.0.1:3200'},{host:'localhost:3000'},{origin:'http://evil.test'},{origin:'null'},{origin:''}])test(`Host/Origin failure ${Object.keys(headers)[0]} never calls verifier`,async()=>{
  let calls=0;const response=await guard(async()=>{calls++;return {ok:true}}).handle(req({token},headers))
  assert.equal(response.status,403);assert.equal(calls,0)
})
test('forbidden API paths never reach verifier',async()=>{
  let calls=0;const handler=guard(async()=>{calls++;return {ok:true}})
  for(const path of ['/api/registrations','/api/admin/registrations','/api/unknown'])assert.equal((await handler.handle(req({token},{},'http://localhost:3200'+path))).status,404)
  assert.equal(calls,0)
})
test('explicit permission required and handler closes safely',async()=>{
  let calls=0;const verify=async()=>{calls++;return {ok:true}}
  assert.equal((await guard(verify,{allowSiteverify:false}).handle(req())).status,503)
  const handler=guard(verify);handler.close();assert.equal((await handler.handle(req())).status,503);assert.equal(calls,0)
})
test('invalid input, extra fields, oversized body and wrong method are denied',async()=>{
  let calls=0;const handler=guard(async()=>{calls++;return {ok:true}})
  for(const input of [null,[],{}, {token:''},{token:'あ'},{token,secret},{token:'x'.repeat(4096)}])assert.ok((await handler.handle(req(input))).status>=400)
  assert.equal((await handler.handle(req({token},{'Content-Type':'text/plain'}))).status,415)
  assert.equal((await handler.handle(req(undefined,{},undefined,'GET'))).status,405);assert.equal(calls,0)
})
test('unknown verifier errors and payloads cannot escape safe response',async()=>{
  for(const verify of [async()=>({ok:false,code:secret,message:token}),async()=>{throw new Error(secret+token)}]){
    const response=await guard(verify).handle(req());assert.equal(response.status,503);assert.doesNotMatch(await response.text(),new RegExp(secret+'|'+token))
  }
})
test('child environment only uses explicitly entered keys, fixed hostname/action and allowlisted OS fields',()=>{
  const env=childEnvironment({site,secret,port:3200,allow:true},{PATH:'/synthetic',SUPABASE_SECRET_KEY:'PRODUCTION',TURNSTILE_SECRET_KEY:'PRODUCTION',NEXT_PUBLIC_TURNSTILE_SITE_KEY:'PRODUCTION',NODE_OPTIONS:'PRODUCTION',UPSTASH_REDIS_REST_TOKEN:'PRODUCTION'})
  assert.equal(env.TURNSTILE_SECRET_KEY,secret);assert.equal(env.LOCAL_REAL_SITE_KEY,site)
  assert.equal(env.TURNSTILE_ALLOWED_HOSTNAMES,'localhost');assert.equal(env.TURNSTILE_EXPECTED_ACTION,'registration')
  assert.equal(Object.hasOwn(env,'NEXT_PUBLIC_TURNSTILE_SITE_KEY'),false)
  assert.doesNotMatch(JSON.stringify(env),/PRODUCTION|SUPABASE|UPSTASH/)
  assert.throws(()=>childEnvironment({site,secret,port:3200,allow:false}))
  for(const port of [3000,3100,0,70000])assert.throws(()=>childEnvironment({site,secret,port,allow:true}))
  assert.equal(validateKeys('1x00000000000000000000AA',secret),false)
})
test('temporary fixture contains no keys/env files, registration APIs or database code; copied verifier is unchanged and types check',async()=>{
  const directory=await prepareFixture()
  try{
    assert.deepEqual(await readFile(path.join(directory,'lib/security/turnstile.ts'),'utf8'),source)
    assert.equal((await readdir(directory)).some(name=>name.startsWith('.env')),false)
    assert.deepEqual(await readdir(path.join(directory,'app/api')),['turnstile-check'])
    const walk=async dir=>{let all='';for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const p=path.join(dir,entry.name);all+=entry.isDirectory()?await walk(p):await readFile(p,'utf8')}return all}
    const files=await walk(directory)
    assert.ok(!new RegExp(secret+'|'+site+'|'+token).test(files),'Fixture contains a synthetic credential')
    assert.ok(!/from ['"][^'"]*(supabase|redis|upstash)|require\(['"][^'"]*(supabase|redis|upstash)/i.test(files),'Fixture contains a forbidden dependency')
    const widget=await readFile(path.join(directory,'app/turnstile-check/turnstile-widget.tsx'),'utf8')
    assert.doesNotMatch(widget,/process\.env\.NEXT_PUBLIC/);assert.match(widget,/const sitekey = siteKey/)
    const result=spawnSync(process.execPath,[path.resolve('node_modules/typescript/bin/tsc'),'--noEmit','--project',path.join(directory,'tsconfig.json')],{cwd:directory,encoding:'utf8'})
    assert.equal(result.status,0,result.stdout+result.stderr)
  }finally{await rm(directory,{recursive:true,force:true})}
})
test('template API imports only guard and verifier; browser does not persist or log tokens',async()=>{
  const route=await readFile('scripts/turnstile-local-real/route.ts.template','utf8')
  assert.match(route,/verifyTurnstile/);assert.match(route,/localRealHandler\?\?=/)
  const page=await readFile('scripts/turnstile-local-real/page.tsx.template','utf8')
  assert.doesNotMatch(page,/localStorage|sessionStorage|console\.|api\/registrations/)
  assert.match(page,/inFlight.current\|\|!token/);assert.match(page,/setToken\(''\)/);assert.match(page,/setGeneration/)
  const proxy=await readFile('scripts/turnstile-local-real/proxy.ts.template','utf8')
  const compiled=ts.transpileModule(proxy,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const exports={};vm.runInNewContext(compiled,{exports,Response,process:{env:{LOCAL_REAL_PORT:'3200'}},require:()=>({NextResponse:{next:()=>new Response(null)}})})
  for(const path of ['/api/registrations','/api/admin','/api/unknown'])assert.equal(exports.proxy({headers:new Headers({host:'localhost:3200'}),nextUrl:{pathname:path},method:'POST'}).status,404)
})
test('hidden prompt emits only label and newline, restores terminal and refuses non-TTY',async()=>{
  const input=new EventEmitter();input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value};input.resume=()=>{};input.pause=()=>{}
  let output='';const pending=hiddenInput('専用キー',{input,output:{write:value=>{output+=value}}})
  input.emit('keypress',secret,{name:'s'});input.emit('keypress','\r',{name:'return'})
  assert.equal(await pending,secret);assert.equal(input.isRaw,false);assert.doesNotMatch(output,new RegExp(secret))
  await assert.rejects(hiddenInput('label',{input:{isTTY:false}}),/TTY_REQUIRED/)
})
test('hidden prompt cancellation restores terminal without logging entered text',async()=>{
  const input=new EventEmitter();input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value};input.resume=()=>{};input.pause=()=>{}
  let output='';const pending=hiddenInput('専用キー',{input,output:{write:value=>{output+=value}}})
  input.emit('keypress',secret,{});input.emit('keypress','',{ctrl:true,name:'c'})
  await assert.rejects(pending,/INPUT_CANCELLED/);assert.equal(input.isRaw,false);assert.doesNotMatch(output,new RegExp(secret))
})
test('cleanup stops only provided child, removes only its generated directory, and is idempotent',async()=>{
  const child={},calls=[]
  const cleanup=createCleanup({child,directory:'/synthetic-owned-fixture',stop:async value=>{assert.equal(value,child);calls.push('stop')},remove:async value=>{assert.equal(value,'/synthetic-owned-fixture');calls.push('remove')}})
  await Promise.all([cleanup(),cleanup()]);assert.deepEqual(calls,['stop','remove'])
  let removed=false;await assert.rejects(createCleanup({child,directory:'/synthetic-owned-fixture',stop:async()=>{throw new Error(secret)},remove:async()=>{removed=true}})(),/CLEANUP_FAILED/)
  assert.equal(removed,false)
})
test('startup health probe uses only bounded loopback GET and never verifies a token',async()=>{
  const calls=[]
  await healthProbe(3200,{request:(options,callback)=>{
    calls.push(options);const request=new EventEmitter();request.destroy=()=>{};request.end=()=>queueMicrotask(()=>{const response=new PassThrough();response.statusCode=200;callback(response);response.end(JSON.stringify({mode:'local-real-turnstile-only'}))});return request
  }})
  assert.equal(calls.length,1);assert.equal(calls[0].hostname,'127.0.0.1');assert.equal(calls[0].headers.Host,'localhost:3200');assert.equal(calls[0].method,'GET');assert.equal(calls[0].path,'/local-test/status')
})
test('without opt-in flags CLI exits before prompting, preparing or starting any server',()=>{
  const result=spawnSync(process.execPath,['scripts/turnstile-local-real/start.mjs'],{encoding:'utf8'})
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.doesNotMatch(result.stderr,/専用Site Key|SYNTHETIC/)
})

test('Next App Router actually registers generated health and Site Key routes (no server)',async()=>{
  const directory=await prepareFixture()
  try{
    const require=createRequire(import.meta.url)
    const {DevAppRouteRouteMatcherProvider}=require('next/dist/server/route-matcher-providers/dev/dev-app-route-route-matcher-provider')
    const provider=new DevAppRouteRouteMatcherProvider(path.join(directory,'app'),['ts'],{read:async()=>[]},false)
    const filenames=['status','site-key'].map(name=>path.join(directory,'app/local-test',name,'route.ts'))
    for(const filename of filenames)assert.ok((await readFile(filename,'utf8')).length>0)
    const matchers=await provider.transform(filenames)
    assert.deepEqual(matchers.map(m=>m.definition.pathname).sort(),['/local-test/site-key','/local-test/status'])
    assert.equal((await readdir(path.join(directory,'app'))).includes('__test'),false)
    assert.match(await readFile(path.join(directory,'app/turnstile-check/page.tsx'),'utf8'),/fetch\('\/local-test\/site-key'/)
    // Both routes must also pass the real fixture Proxy allowlist.
    const exports={}
    const code=ts.transpileModule(await readFile(path.join(directory,'proxy.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText
    vm.runInNewContext(code,{exports,Response,process:{env:{LOCAL_REAL_PORT:'3200'}},require:()=>({NextResponse:{next:()=>new Response(null,{status:200})}})})
    for(const pathname of ['/local-test/status','/local-test/site-key'])assert.equal(exports.proxy({method:'GET',nextUrl:{pathname},headers:new Headers({host:'localhost:3200'})}).status,200)
    for(const pathname of ['/__test/status','/__test/site-key','/api/registrations'])assert.equal(exports.proxy({method:'GET',nextUrl:{pathname},headers:new Headers({host:'localhost:3200'})}).status,404)
  }finally{await rm(directory,{recursive:true,force:true})}
})
function fakeHealth({status=200,body=JSON.stringify({mode:'local-real-turnstile-only'}),error,hang=false}={}){
  let calls=0
  return {count:()=>calls,request:(options,callback)=>{
    calls++;assert.equal(options.path,'/local-test/status');assert.equal(options.headers.Host,'localhost:3200')
    const request=new EventEmitter();request.destroy=()=>{}
    request.end=()=>queueMicrotask(()=>{
      if(error){request.emit('error',error);return}
      if(hang)return
      const response=new PassThrough();response.statusCode=status;response.complete=true;callback(response);if(!response.destroyed)response.end(body)
    })
    return request
  }}
}
test('HTTP 404 and 500 retain status and stop polling immediately without response text',async()=>{
  for(const status of [404,500]){
    const mock=fakeHealth({status,body:secret+token})
    await assert.rejects(waitForHealth(3200,{probe:()=>healthProbe(3200,{request:mock.request}),pause:async()=>{}}),error=>{
      assert.equal(error.startupClassification,'HTTP_ERROR');assert.equal(error.startupHttpStatus,status)
      assert.doesNotMatch(JSON.stringify(error)+error.message,new RegExp(secret+'|'+token))
      return true
    })
    assert.equal(mock.count(),1)
  }
})
test('malformed/wrong health JSON and size overflow are safe failures, not healthy HTTP 200',async()=>{
  for(const body of [secret,JSON.stringify({mode:'wrong'}),'x'.repeat(1025)]){
    const mock=fakeHealth({body})
    await assert.rejects(healthProbe(3200,{request:mock.request}),error=>error.startupHttpStatus===200&&error.startupClassification==='HTTP_ERROR'&&!JSON.stringify(error).includes(secret))
  }
})
test('health timeout is classified and bounded (mock transport, no network)',async()=>{
  const mock=fakeHealth({hang:true})
  await assert.rejects(healthProbe(3200,{request:mock.request,timeoutMs:5}),error=>error.startupClassification==='STARTUP_TIMEOUT'&&error.code==='ETIMEDOUT')
  assert.equal(mock.count(),1)
})
test('readiness exhaustion preserves only an allowlisted communication code',async()=>{
  for(const code of ['ECONNREFUSED',secret]){
    const mock=fakeHealth({error:Object.assign(new Error(secret+token),{code})})
    await assert.rejects(waitForHealth(3200,{probe:()=>healthProbe(3200,{request:mock.request}),attempts:2,pause:async()=>{}}),error=>{
      assert.equal(error.startupClassification,'STARTUP_TIMEOUT');assert.equal(error.code,code==='ECONNREFUSED'?code:undefined)
      assert.doesNotMatch(JSON.stringify(error)+error.message,new RegExp(secret+'|'+token));return true
    })
    assert.equal(mock.count(),2)
  }
})
test('startup failure followed by intentional SIGTERM/code-0 cleanup is not CHILD_EARLY_EXIT',async()=>{
  const child=new EventEmitter(),events=[]
  const observer=observeChildExit(child,()=>events.push('CHILD_EARLY_EXIT'))
  const cleanup=createCleanup({child,directory:'/synthetic-owned-fixture',stop:async()=>{events.push('SIGTERM');child.emit('exit',0,null)},remove:async()=>events.push('removed')})
  const mock=fakeHealth({status:404})
  try{await waitForHealth(3200,{probe:()=>healthProbe(3200,{request:mock.request}),pause:async()=>{}})}catch(error){events.push(error.startupClassification);observer.expectStop();await cleanup()}
  observer.dispose()
  assert.deepEqual(events,['HTTP_ERROR','SIGTERM','removed'])
})
test('unexpected code-0 exit remains detectable, while subsequent cleanup does not duplicate it',()=>{
  const child=new EventEmitter(),events=[]
  const observer=observeChildExit(child,(code,signal)=>events.push({code,signal}))
  child.emit('exit',0,null);observer.expectStop();child.emit('exit',0,null);observer.dispose()
  assert.deepEqual(events,[{code:0,signal:null}])
})
