import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { runTurnstileVerification, createMockTurnstileTransport, diagnoseTurnstileResponse } from '../scripts/turnstile-verification/verify-turnstile.mjs'

const script = 'scripts/turnstile-verification/verify-turnstile.mjs'
function safe(report) {
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TOKEN_SECRET|XXXX\.DUMMY|1x0{10}|2x0{10}|3x0{10}|"secret"|"response"|"error-codes":\s*\[|challenge_ts/)
}

test('Turnstile verification script passes syntax check without execution', () => {
  const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('all five cases exercise the existing verifier with exactly five mocked POSTs', async () => {
  const mock = createMockTurnstileTransport()
  const report = await runTurnstileVerification({ transport: mock.transport })
  assert.equal(report.status, 'SUCCESS')
  assert.equal(report.http_requests, 5)
  assert.equal(report.checks.length, 5)
  assert.ok(report.checks.every(check => check.status === 'PASS' && check.upstream_contract_checked && check.module_outcome_matched))
  assert.equal(mock.calls.length, 5)
  assert.equal(report.safety.environment_files_read, false)
  assert.equal(report.safety.module_source_unchanged, true)
  assert.equal(report.profile.specification_guaranteed, false)
  safe(report)
})

test('only official test credentials and dummy token are sent to the fixed endpoint', async () => {
  const mock = createMockTurnstileTransport()
  await runTurnstileVerification({ transport: mock.transport })
  const allowed = new Set(['1x0000000000000000000000000000000AA','2x0000000000000000000000000000000AA','3x0000000000000000000000000000000AA'])
  for (const { url, options } of mock.calls) {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.credentials, 'omit')
    assert.ok(options.signal instanceof AbortSignal)
    const body = JSON.parse(options.body)
    assert.deepEqual(Object.keys(body).sort(), ['response','secret'])
    assert.ok(allowed.has(body.secret))
    assert.equal(body.response,'XXXX.DUMMY.TOKEN.XXXX')
  }
})

for (const fault of ['hostname','action','false_success','shape','http','network','json']) test(`unexpected ${fault} stops without retries or exposing response details`, async () => {
  const mock = createMockTurnstileTransport({ fault })
  const report = await runTurnstileVerification({ transport: mock.transport })
  assert.equal(report.status, 'FAILED')
  assert.equal(mock.calls.length, 1)
  assert.equal(report.http_requests, 1)
  assert.equal(report.checks[0].status, 'FAIL')
  assert.ok(report.checks.slice(1).every(check=>check.status==='NOT_RUN'))
  assert.ok(['TEST_RESPONSE_CONTRACT_MISMATCH','HTTP_ERROR','NETWORK_OR_PARSE_ERROR'].includes(report.error))
  assert.deepEqual(report.profile,{hostname:'localhost',action:'test',specification_guaranteed:false,basis:'official_documentation_example'})
  safe(report)
})

for(const index of [3,4]) test(`case ${index+1} cannot pass just because the upstream itself failed or changed metadata`,async()=>{
  const mock=createMockTurnstileTransport()
  let calls=0
  const report=await runTurnstileVerification({transport:async(...args)=>{
    const response=await mock.transport(...args)
    const current=calls++
    if(current===index) return {ok:true,status:200,json:async()=>({success:false,'error-codes':['PRIVATE_TOKEN_SECRET_NEVER_LOG']})}
    return response
  }})
  assert.equal(report.status,'FAILED')
  assert.equal(report.http_requests,index+1)
  assert.equal(report.checks[index].status,'FAIL')
  assert.equal(report.error,'TEST_RESPONSE_CONTRACT_MISMATCH')
  safe(report)
})

test('spent-key failure must carry the predeclared spent-token error, not another rejection',async()=>{
  const mock=createMockTurnstileTransport()
  let calls=0
  const report=await runTurnstileVerification({transport:async(...args)=>{
    const response=await mock.transport(...args)
    if(calls++===2) return {ok:true,status:200,json:async()=>({success:false,'error-codes':['invalid-input-response']})}
    return response
  }})
  assert.equal(report.status,'FAILED')
  assert.equal(report.http_requests,3)
  assert.equal(report.checks[2].status,'FAIL')
})

test('source is unchanged and credentials never come from ambient environment files',async()=>{
  const original=await readFile('lib/security/turnstile.ts')
  const mock=createMockTurnstileTransport()
  await runTurnstileVerification({transport:mock.transport})
  assert.deepEqual(await readFile('lib/security/turnstile.ts'),original)
  const source=await readFile(script,'utf8')
  const executable=ts.transpileModule(source,{compilerOptions:{removeComments:true}}).outputText
  assert.doesNotMatch(executable,/process\.env|parseEnv|dotenv|supabase|redis/i)
})

test('no transport means no implicit network fallback',async()=>{
  const report=await runTurnstileVerification({})
  assert.equal(report.status,'FAILED')
  assert.equal(report.error,'UNSAFE_REQUEST')
  assert.equal(report.http_requests,0)
})

test('live CLI is disabled without explicit official-test-key confirmation',()=>{
  for(const args of [[],['--execute'],['--official-test-keys'],['--mock','--execute'],['--mock','--official-test-keys']]) {
    const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8'})
    assert.equal(result.status,1)
    assert.equal(result.stderr,'')
    const report=JSON.parse(result.stdout)
    assert.equal(report.error,'LOCAL_SETUP_ERROR')
    assert.equal(report.external_http_requests,0)
    safe(report)
  }
})

test('mock CLI completes five scenarios with zero external HTTP requests',()=>{
  const result=spawnSync(process.execPath,[script,'--mock'],{encoding:'utf8'})
  assert.equal(result.status,0)
  assert.equal(result.stderr,'')
  const report=JSON.parse(result.stdout)
  assert.equal(report.status,'SUCCESS')
  assert.equal(report.mode,'mock')
  assert.equal(report.external_http_requests,0)
  safe(report)
})

const accepted = { success: true, hostname: 'localhost', action: 'test', 'error-codes': [] }
const diagnostic = data => diagnoseTurnstileResponse(data, { httpStatus: 200, jsonParsed: true })
for (const field of ['success','hostname','action','error-codes']) test(`diagnostics isolate missing, wrong-type and wrong-value ${field} without raw values`, () => {
  const missing = { ...accepted }
  delete missing[field]
  const variants = [missing, { ...accepted, [field]: 'PRIVATE_TOKEN_SECRET_NEVER_LOG' }, { ...accepted, [field]: { secret: 'PRIVATE_TOKEN_SECRET_NEVER_LOG' } }]
  if (field === 'success') variants.push({ ...accepted, success: false })
  if (field === 'error-codes') variants.push({ ...accepted, 'error-codes': ['PRIVATE_TOKEN_SECRET_NEVER_LOG'] })
  for (const data of variants) {
    const result = diagnostic(data)
    assert.deepEqual(result.mismatched_fields, [field])
    assert.equal(result.http_status,200)
    assert.equal(result.json_parsed,true)
    assert.equal(result.fields[field].present,Object.hasOwn(data,field))
    safe(result)
  }
})

test('diagnostics retain all simultaneous mismatches and success is true, false or invalid', () => {
  const result = diagnostic({ success: 'PRIVATE_TOKEN_SECRET_NEVER_LOG', hostname: 1, action: null, 'error-codes': {} })
  assert.deepEqual(result.mismatched_fields,['success','hostname','action','error-codes'])
  assert.equal(result.success,'invalid')
  assert.equal(result.hostname_matches,false)
  assert.equal(result.action_matches,false)
  assert.equal(result.fields.success.type,'string')
  assert.equal(result.fields.hostname.type,'number')
  assert.equal(result.fields.action.type,'null')
  assert.equal(result.fields['error-codes'].type,'object')
  assert.equal(diagnostic(accepted).success,'true')
  assert.equal(diagnostic({...accepted,success:false}).success,'false')
  safe(result)
})

test('diagnostics distinguish object, array, null and primitive root responses', () => {
  for(const [data,type] of [[[], 'array'], [null,'null'], ['PRIVATE_TOKEN_SECRET_NEVER_LOG','string'],[true,'boolean'],[123,'number']]) {
    const result=diagnostic(data)
    assert.deepEqual(result.mismatched_fields,['body'])
    assert.equal(result.fields.body.type,type)
    assert.equal(result.success,'invalid')
    safe(result)
  }
})

test('normal success and expected business rejections are not diagnosed as mismatches', () => {
  const success=diagnostic(accepted)
  assert.deepEqual(success.mismatched_fields,[])
  assert.equal(success.hostname_matches,true)
  assert.equal(success.action_matches,true)
  for(const expectedError of ['invalid-input-response','timeout-or-duplicate']) {
    const result=diagnoseTurnstileResponse({success:false,'error-codes':[expectedError]}, {httpStatus:200,jsonParsed:true,expectedError})
    assert.deepEqual(result.mismatched_fields,[])
    assert.equal(result.success,'false')
    assert.deepEqual(result.fields.hostname,{present:false,type:'missing'})
    safe(result)
  }
})

test('live runner attaches exact HTTP, parse and field diagnostics while keeping strict validation',async()=>{
  for(const [fault,expected] of [['hostname',['hostname']],['action',['action']],['false_success',['success']],['shape',['body']]]) {
    const mock=createMockTurnstileTransport({fault})
    const report=await runTurnstileVerification({transport:mock.transport})
    assert.equal(report.status,'FAILED')
    assert.equal(report.http_requests,1)
    assert.deepEqual(report.checks[0].diagnostics.mismatched_fields,expected)
    assert.equal(report.checks[0].diagnostics.http_status,200)
    assert.equal(report.checks[0].diagnostics.json_parsed,true)
    safe(report)
  }
})

test('HTTP failures, parse failures and network failures have distinct safe observations',async()=>{
  for(const [fault,http,json,mismatches] of [['http',503,null,['http_status']],['json',200,false,['json']],['network',null,null,[]]]) {
    const mock=createMockTurnstileTransport({fault})
    const report=await runTurnstileVerification({transport:mock.transport})
    const result=report.checks[0].diagnostics
    assert.equal(result.http_status,http)
    assert.equal(result.json_parsed,json)
    assert.deepEqual(result.mismatched_fields,mismatches)
    assert.deepEqual(result.fields.body,{present:null,type:'not_checked'})
    safe(report)
  }
})

test('diagnostic output is a fixed metadata allowlist and never includes unknown response fields',()=>{
  const data={...accepted,hostname:'PRIVATE_TOKEN_SECRET_NEVER_LOG',action:'PRIVATE_TOKEN_SECRET_NEVER_LOG',secret:'PRIVATE_TOKEN_SECRET_NEVER_LOG',token:'PRIVATE_TOKEN_SECRET_NEVER_LOG',details:'PRIVATE_TOKEN_SECRET_NEVER_LOG'}
  const result=diagnostic(data)
  assert.deepEqual(Object.keys(result),['http_status','json_parsed','success','hostname_matches','action_matches','fields','mismatched_fields'])
  assert.deepEqual(Object.keys(result.fields),['body','success','hostname','action','error-codes'])
  safe(result)
  assert.doesNotMatch(JSON.stringify(result),/"token"|"secret"|"details"/)
})
