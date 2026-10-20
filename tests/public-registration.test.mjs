import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function compile(path, dependencies = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, ...globals, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}
const details = compile('lib/registrations/details.ts')
const proxy = compile('lib/registrations/proxy-registration.ts', { './details': details })
const validation = compile('lib/registrations/public-registration.ts', { './proxy-registration': proxy })
const { validatePublicRegistration: validate, mapPublicRegistrationResult: map } = validation
const key = '12345678-ABCD-4ABC-8ABC-123456789ABC'
const valid = { event_group_id: 5, name: ' 参加者😀 ', contact: ' 電話連絡先 ', notes: ' 備考 ', schedule_ids: [12, 11] }
const registered = { success: true, code: 'REGISTERED', http_status: 201 }
const plain = value => JSON.parse(JSON.stringify(value))
const sensitive = 'PRIVATE_APPLICANT_SECRET_TOKEN_SQL'
function setup({ data = registered, error = null, throws = false, env = { NEXT_PUBLIC_SUPABASE_URL: 'http://local.invalid', SUPABASE_SECRET_KEY: sensitive } } = {}) {
  const clients = [], calls = [], logs = [], fetches = []
  const service = compile('lib/supabase/registration-service.ts', {
    'server-only': {}, '@/lib/registrations/public-registration': validation,
    '@supabase/supabase-js': { createClient: (...args) => {
      clients.push(args)
      return { rpc: async (...args) => { calls.push(args); if (throws) throw new Error(sensitive); return { data, error } } }
    } },
  }, { process: { env }, console: Object.fromEntries(['log', 'error', 'warn', 'info', 'debug'].map(name => [name, (...args) => logs.push(args)])),
    fetch: async (...args) => { fetches.push(args); return {} } })
  return { clients, calls, logs, fetches, submit: (body = valid, id = key) => service.submitPublicRegistration(body, id) }
}

test('public registration normalizes existing detail rules, UUID case and class order without mutating input', () => {
  const before = JSON.stringify(valid)
  assert.deepEqual(plain(validate(valid, key).data), { event_group_id: 5, name: '参加者😀', contact: '電話連絡先', notes: '備考', schedule_ids: [11, 12], idempotency_key: key.toLowerCase() })
  assert.equal(JSON.stringify(valid), before)
  assert.notEqual(validate(valid, key).data.schedule_ids, valid.schedule_ids)
  for (const notes of [undefined, null, '', ' \t ']) assert.equal(validate({ ...valid, notes }, key).data.notes, null)
})

test('public registration Unicode boundaries and optional notes follow administrator validation', () => {
  for (const name of ['a', '😀'.repeat(100)]) for (const contact of ['x', 'あ'.repeat(254)]) {
    const body = { ...valid, name, contact, notes: '😀'.repeat(2000) }
    assert.ok(validate(body, key).data)
    assert.ok(proxy.validateProxyRegistration(body).data)
  }
  for (const fields of [{ name: '' }, { name: ' \n ' }, { name: '😀'.repeat(101) }, { contact: '' }, { contact: 'x'.repeat(255) }, { notes: 'あ'.repeat(2001) }, { notes: ' ' + 'x'.repeat(2000) }]) assert.ok(validate({ ...valid, ...fields }, key).error)
})

test('public registration rejects invalid shapes, unknown fields and nonstring details', () => {
  for (const body of [null, undefined, false, 5, 'input', [], { ...valid, extra: true }, { ...valid, turnstile_token: 'token' }, { ...valid, idempotency_key: key }]) assert.ok(validate(body, key).error)
  for (const field of ['name', 'contact', 'notes']) for (const value of [true, 123, {}, []]) assert.ok(validate({ ...valid, [field]: value }, key).error)
  assert.ok(validate({ ...valid, name: null }, key).error)
  assert.ok(validate({ ...valid, contact: null }, key).error)
})

test('public registration validates safe positive integer IDs and one to fifty distinct classes', () => {
  for (const bad of [0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, true]) {
    assert.ok(validate({ ...valid, event_group_id: bad }, key).error)
    assert.ok(validate({ ...valid, schedule_ids: [bad] }, key).error)
  }
  for (const ids of [undefined, null, {}, '1', [], [1, 1], Array.from({ length: 51 }, (_, i) => i + 1)]) assert.ok(validate({ ...valid, schedule_ids: ids }, key).error)
  assert.ok(validate({ ...valid, event_group_id: Number.MAX_SAFE_INTEGER, schedule_ids: [Number.MAX_SAFE_INTEGER] }, key).data)
  assert.ok(validate({ ...valid, schedule_ids: Array.from({ length: 50 }, (_, i) => i + 1) }, key).data)
})

test('public registration UUID requires the entire canonical hyphenated hexadecimal format', () => {
  for (const bad of [undefined, null, 1, [], {}, '', ' '+key, key+' ', key+'\n', key.replaceAll('-', ''), key.replace('ABCD', 'XYZW'), '{'+key+'}', key.slice(1)]) assert.ok(validate(valid, bad).error)
  assert.ok(validate(valid, key.toLowerCase()).data)
  // PostgreSQL UUID is not limited to one UUID generation version.
  assert.ok(validate(valid, '00000000-0000-0000-0000-000000000000').data)
})

const business = [
  ['GROUP_NOT_FOUND', 404], ['REGISTRATION_CLOSED', 409], ['CLASS_NOT_FOUND', 400],
  ['CLASS_GROUP_MISMATCH', 400], ['CLASS_CLOSED', 409], ['CAPACITY_EXCEEDED', 409],
]
for (const [code, status] of business) test(`public registration maps RPC business result ${code}`, () => {
  const result = map({ success: false, code, http_status: status }, null)
  assert.equal(result.status, status)
  assert.equal(result.body.code, code)
  assert.equal(result.body.success, false)
  assert.ok(result.body.message)
})

test('public registration initial and replay successes have identical safe responses', () => {
  assert.deepEqual(plain(map(registered, null)), { status: 201, body: { success: true, code: 'REGISTERED', message: '申込を受け付けました' } })
  assert.deepEqual(plain(map({ ...registered }, null)), plain(map(registered, null)))
})

for (const [dbCode, status, code] of [['PT409',409,'IDEMPOTENCY_CONFLICT'],['PT410',410,'IDEMPOTENCY_EXPIRED'],['22023',400,'INVALID_INPUT']]) test(`public registration safely handles ${dbCode}`, () => {
  const result = map(registered, { code: dbCode, message: sensitive, details: sensitive, hint: sensitive })
  assert.equal(result.status, status)
  assert.equal(result.body.code, code)
  assert.equal(result.body.success, false)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sensitive))
})

test('public registration rejects unknown errors and inconsistent or extra RPC fields', () => {
  for (const error of [{ code: '42501' }, { code: 'P0001' }, { code: '55000' }, {}, false, sensitive]) {
    const result = map(registered, error)
    assert.equal(result.status, 500)
    assert.equal(result.body.success, false)
  }
  for (const data of [null, undefined, [], {}, sensitive, { ...registered, success: false }, { ...registered, http_status: '201' }, { ...registered, http_status: 200 }, { ...registered, code: 'UNKNOWN' }, { ...registered, name: sensitive }, { ...registered, details: sensitive }, ...business.map(([code,status])=>({success:true,code,http_status:status})), ...business.map(([code])=>({success:false,code,http_status:201}))]) {
    const result = map(data, null)
    assert.equal(result.status, 500)
    assert.equal(result.body.success, false)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sensitive))
  }
})

test('server boundary sends exactly six normalized arguments to only one designated RPC', async () => {
  const context = setup()
  const response = await context.submit()
  assert.equal(response.status, 201)
  assert.equal(context.calls.length, 1)
  assert.deepEqual(plain(context.calls[0]), ['submit_registration_idempotent', {
    p_idempotency_key: key.toLowerCase(), p_event_group_id: 5, p_name: '参加者😀', p_contact: '電話連絡先', p_notes: '備考', p_schedule_ids: [11, 12],
  }])
  assert.equal(context.clients.length, 1)
  const [url, secret, options] = context.clients[0]
  assert.equal(url, 'http://local.invalid')
  assert.equal(secret, sensitive)
  assert.deepEqual(plain(options.auth), { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false })
  assert.deepEqual(Object.keys(options).sort(), ['auth', 'global'])
  assert.deepEqual(Object.keys(options.global), ['fetch'])
  await options.global.fetch('http://mock.invalid', { cache: 'force-cache', method: 'POST' })
  assert.equal(context.fetches[0][1].cache, 'no-store')
  assert.doesNotMatch(JSON.stringify(response), new RegExp(sensitive))
  assert.deepEqual(context.logs, [])
})

test('server boundary rejects invalid registration or separate security token before client creation', async () => {
  for (const [body,id] of [[{ ...valid, name: '' },key],[valid,'bad-key'],[{...valid,turnstile_token:sensitive},key]]) {
    const context = setup()
    assert.equal((await context.submit(body,id)).status,400)
    assert.deepEqual(context.clients,[])
    assert.deepEqual(context.calls,[])
    assert.deepEqual(context.logs,[])
  }
})

test('server boundary fails safely when configuration is missing without connecting', async () => {
  for(const env of [{},{NEXT_PUBLIC_SUPABASE_URL:'http://mock.invalid'},{SUPABASE_SECRET_KEY:sensitive}]) {
    const context=setup({env})
    assert.equal((await context.submit()).status,503)
    assert.equal(context.calls.length,0)
    assert.equal(context.clients.length,0)
  }
})

test('server boundary never retries RPC errors, malformed results or transport failures and never logs secrets', async () => {
  for(const scenario of [{error:{code:'PT409',message:sensitive}},{error:{code:'42501',details:sensitive}},{error:{code:'UNKNOWN',hint:sensitive}},{data:{...registered,secret:sensitive}},{throws:true}]) {
    const context=setup(scenario)
    const result=await context.submit()
    assert.equal(result.body.success,false)
    assert.equal(context.calls.length,1)
    assert.deepEqual(context.logs,[])
    assert.doesNotMatch(JSON.stringify(result),new RegExp(sensitive))
    assert.doesNotMatch(JSON.stringify(result),/参加者|電話連絡先|備考/)
  }
})

test('service remains server-only', () => {
  assert.match(fs.readFileSync('lib/supabase/registration-service.ts','utf8'),/^import 'server-only'/)
})
