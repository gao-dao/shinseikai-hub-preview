import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { startBrowserTest, safeDiagnostic, safeCommunicationCode, classifyNextOutput, observeNextOutput } from '../scripts/turnstile-browser/startup.mjs'

const privateText='SECRET_TOKEN_PERSON_SOURCE_CODE_ENV_VALUE'
function fixture(overrides={}) {
  const logs=[],calls=[]
  const child=new EventEmitter()
  child.stdout=new PassThrough();child.stderr=new PassThrough()
  child.exitCode=null;child.signalCode=null
  const proxy={
    checkMock:async()=>{calls.push('checkMock')},
    listen:async()=>{calls.push('listen')},
    probeMock:async()=>{calls.push('probeMock')},
    close:async()=>{calls.push('close')},
    summary:()=>({registration_posts:0}),
  }
  const deps={
    report:entry=>logs.push(entry),
    verifyMock:async()=>{calls.push('verifyMock')},
    prepare:async()=>{calls.push('prepare');return '/synthetic-fixture-only'},
    reservePort:async()=>{calls.push('reservePort');return 45001},
    spawn:()=>{calls.push('spawn');queueMicrotask(()=>child.emit('spawn'));return child},
    createProxy:()=>{calls.push('createProxy');return proxy},
    fetchEvents:async()=>{calls.push('fetchEvents');return new Response('synthetic source',{status:200})},
    pause:async()=>{},
    stopChild:async received=>{assert.equal(received,child);calls.push('stopChild')},
    removeFixture:async directory=>{assert.equal(directory,'/synthetic-fixture-only');calls.push('removeFixture')},
    onUnexpectedExit:()=>{calls.push('unexpectedExit')},
    ...overrides,
  }
  return {deps,logs,calls,child,proxy}
}
const failure=f=>f.logs.find(entry=>entry.outcome==='failed')

test('startup diagnostics syntax',()=>{
  assert.equal(spawnSync(process.execPath,['--check','scripts/turnstile-browser/startup.mjs']).status,0)
})
test('normal startup records all stages, verifies mock before listening and remains running until cleanup',async()=>{
  const f=fixture(),result=await startBrowserTest(f.deps)
  assert.equal(result.ok,true)
  assert.deepEqual([...new Set(f.logs.map(row=>row.stage))],['MOCK_CHECK','FIXTURE_CREATE','NEXT_START','PROXY_LISTEN','EVENTS_HTTP'])
  assert.ok(f.calls.indexOf('verifyMock')<f.calls.indexOf('spawn'))
  assert.ok(f.calls.indexOf('checkMock')<f.calls.indexOf('listen'))
  assert.ok(f.calls.indexOf('probeMock')>f.calls.indexOf('fetchEvents'))
  assert.equal(f.calls.includes('stopChild'),false)
  await Promise.all([result.cleanup(),result.cleanup()])
  for(const key of ['close','stopChild','removeFixture'])assert.equal(f.calls.filter(value=>value===key).length,1)
})
test('fixture failure is classified safely without launching Next or touching a proxy',async()=>{
  const f=fixture({prepare:async()=>{throw new Error(privateText)}})
  assert.equal((await startBrowserTest(f.deps)).ok,false)
  assert.equal(failure(f).stage,'FIXTURE_CREATE');assert.equal(failure(f).classification,'UNKNOWN_STARTUP_FAILURE')
  assert.equal(f.calls.includes('spawn'),false)
  assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(privateText))
})
test('spawn error records only an allowed error code and cleans only its fixture',async()=>{
  const f=fixture()
  f.deps.spawn=()=>{queueMicrotask(()=>f.child.emit('error',Object.assign(new Error(privateText),{code:'ENOENT'})));return f.child}
  assert.equal((await startBrowserTest(f.deps)).ok,false)
  assert.equal(failure(f).stage,'NEXT_START');assert.equal(failure(f).communication_code,'ENOENT')
  assert.equal(failure(f).classification,'NEXT_STARTUP_ERROR')
  assert.equal(f.calls.includes('createProxy'),false);assert.equal(f.calls.includes('removeFixture'),true)
})
for(const [text,classification] of [
  ['Failed to start server','NEXT_STARTUP_ERROR'],
  ["Module not found: Can't resolve private module",'DEPENDENCY_ERROR'],
  ['Failed to compile','COMPILE_ERROR'],
])test(`Next output is safely classified as ${classification}`,async()=>{
  const f=fixture()
  f.deps.fetchEvents=async()=>{f.child.stderr.write(text+' '+privateText+'\n');return new Response(privateText,{status:500})}
  assert.equal((await startBrowserTest(f.deps)).ok,false)
  assert.equal(failure(f).classification,classification)
  assert.equal(failure(f).next_error,classification)
  assert.equal(failure(f).http_status,500)
  assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(privateText+'|private module'))
})
test('public port conflict stops the isolated child and reports EADDRINUSE',async()=>{
  const f=fixture()
  f.proxy.listen=async()=>{throw Object.assign(new Error(privateText),{code:'EADDRINUSE'})}
  assert.equal((await startBrowserTest(f.deps)).ok,false)
  assert.equal(failure(f).stage,'PROXY_LISTEN');assert.equal(failure(f).classification,'PORT_IN_USE')
  assert.equal(failure(f).communication_code,'EADDRINUSE')
  assert.equal(f.calls.includes('fetchEvents'),false);assert.equal(f.calls.includes('stopChild'),true)
})
test('HTTP 500 stops without retry and does not read the response body',async()=>{
  let requests=0,cancelled=0
  const f=fixture({fetchEvents:async()=>{requests++;return {ok:false,status:500,body:{cancel:async()=>{cancelled++}},text:()=>{throw new Error('MUST_NOT_READ')}}}})
  assert.equal((await startBrowserTest(f.deps)).ok,false)
  assert.equal(requests,1);assert.equal(cancelled,1)
  assert.equal(failure(f).classification,'HTTP_ERROR');assert.equal(failure(f).http_status,500)
})
test('readiness timeout preserves allowed communication code and never probes a registration API',async()=>{
  let requests=0
  const f=fixture({fetchEvents:async()=>{requests++;throw Object.assign(new Error(privateText),{cause:{code:'ECONNREFUSED'}})}})
  assert.equal((await startBrowserTest(f.deps,{attempts:3})).ok,false)
  assert.equal(requests,3);assert.equal(failure(f).classification,'STARTUP_TIMEOUT')
  assert.equal(failure(f).communication_code,'ECONNREFUSED');assert.equal(f.calls.includes('probeMock'),false)
})
test('unknown communication errors are not serialized or guessed',async()=>{
  const f=fixture({fetchEvents:async()=>{throw Object.assign(new Error(privateText),{code:privateText})}})
  await startBrowserTest(f.deps,{attempts:1})
  assert.equal(failure(f).communication_code,null)
  assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(privateText))
})
test('early child exit reports original exit code and signal, not cleanup termination',async()=>{
  const f=fixture()
  f.deps.fetchEvents=async()=>{f.child.emit('exit',7,'SIGABRT');throw new Error(privateText)}
  assert.equal((await startBrowserTest(f.deps,{attempts:2})).ok,false)
  assert.equal(failure(f).classification,'CHILD_EARLY_EXIT')
  assert.equal(failure(f).child_exit_code,7);assert.equal(failure(f).child_exit_signal,'SIGABRT')
})
for(const point of ['verifyMock','checkMock','probeMock'])test(`missing mock at ${point} always stops safely`,async()=>{
  const f=fixture()
  const fail=async()=>{throw new Error(privateText)}
  if(point==='verifyMock')f.deps.verifyMock=fail;else f.proxy[point]=fail
  assert.equal((await startBrowserTest(f.deps)).ok,false)
  assert.equal(failure(f).stage,'MOCK_CHECK');assert.equal(failure(f).classification,'MOCK_NOT_APPLIED')
  if(point==='verifyMock')assert.equal(f.calls.includes('prepare'),false)
  if(point!=='probeMock')assert.equal(f.calls.includes('listen'),false)
  assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(privateText))
})
test('projection excludes arbitrary values, fields, raw messages, headers and signal strings',()=>{
  const result=safeDiagnostic({stage:privateText,outcome:privateText,classification:privateText,child_exit_code:privateText,child_exit_signal:privateText,http_status:privateText,communication_code:privateText,next_error:privateText,message:privateText,stack:privateText,headers:{authorization:privateText}})
  assert.doesNotMatch(JSON.stringify(result),new RegExp(privateText+'|authorization|message|stack'))
  assert.equal(safeCommunicationCode({code:privateText}),null)
  assert.equal(safeCommunicationCode({name:'TimeoutError'}),'ETIMEDOUT')
  assert.equal(classifyNextOutput(privateText),null)
})
test('stream observer handles split lines, ANSI colors and final incomplete line without logging raw output',()=>{
  const stream=new PassThrough(),seen=[]
  const stop=observeNextOutput(stream,classification=>seen.push(classification))
  stream.write('\x1b[31mModule not ');stream.write('found\x1b[0m '+privateText+'\n')
  stream.write(privateText.repeat(1000)+'\nFailed to compile')
  stop()
  assert.deepEqual(seen,['DEPENDENCY_ERROR','COMPILE_ERROR'])
  assert.doesNotMatch(JSON.stringify(seen),new RegExp(privateText))
})
test('unexpected exit after startup is diagnosed and cleaned up once',async()=>{
  const f=fixture(),result=await startBrowserTest(f.deps)
  f.child.emit('exit',1,null)
  await result.cleanup()
  assert.equal(failure(f).classification,'CHILD_EARLY_EXIT')
  assert.equal(failure(f).child_exit_code,1)
  assert.equal(f.calls.filter(value=>value==='unexpectedExit').length,1)
  assert.equal(f.calls.filter(value=>value==='removeFixture').length,1)
})
test('cleanup errors are sanitized and do not prevent child termination and fixture cleanup',async()=>{
  const f=fixture()
  f.proxy.close=async()=>{throw new Error(privateText)}
  const result=await startBrowserTest(f.deps)
  assert.equal(await result.cleanup(),false)
  assert.equal(f.calls.includes('stopChild'),true);assert.equal(f.calls.includes('removeFixture'),true)
  assert.equal(failure(f).classification,'CLEANUP_FAILED')
  assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(privateText))
})
test('unterminated Next error output is classified before failure reporting',async()=>{
  const f=fixture()
  f.deps.fetchEvents=async()=>{f.child.stderr.write('Failed to compile '+privateText);return new Response(privateText,{status:500})}
  assert.equal((await startBrowserTest(f.deps)).ok,false)
  assert.equal(failure(f).classification,'COMPILE_ERROR')
  assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(privateText))
})
test('mock probe failure retains its safe HTTP status and still cleans up',async()=>{
  const f=fixture()
  f.proxy.probeMock=async()=>{throw Object.assign(new Error(privateText),{startupHttpStatus:403})}
  assert.equal((await startBrowserTest(f.deps)).ok,false)
  assert.equal(failure(f).stage,'MOCK_CHECK');assert.equal(failure(f).classification,'MOCK_NOT_APPLIED')
  assert.equal(failure(f).http_status,403)
  assert.equal(f.calls.includes('stopChild'),true)
})
