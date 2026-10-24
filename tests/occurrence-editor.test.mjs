import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
function compile(file, dependencies = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, TextDecoder, Uint8Array, URL, AbortController, setTimeout, clearTimeout, require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name] }, ...globals })
  return exports
}
const occurrence = compile('lib/event-groups/validation.ts'), schedule = compile('lib/schedules/new-schedule.ts')
const validation = compile('lib/event-groups/occurrence-editor.ts', { './validation': occurrence, '../schedules/new-schedule': schedule })
const saving = compile('lib/event-groups/occurrence-save.ts', { './occurrence-editor': validation })
const plain = v => JSON.parse(JSON.stringify(v))
const key = '00000000-0000-4000-8000-000000000001'
const fixture = () => ({ group_id: null, group: { title: '東京講座', city: '東京', description: null, start_date: '2030-10-23', end_date: '2030-10-23' }, classes: [{ id: null, title: '東京講座', date: '2030-10-23', start_time: '12:00', location: '合成会場', type: '一般参加', capacity: 10, registration_enabled: false }], expected: null })
const snapshot = () => ({ group: { ...fixture().group, registration_open: false }, classes: [{ ...fixture().classes[0], id: 7, end_time: '15:00' }] })
const editing = () => ({ ...fixture(), group_id: 1, classes: [{ ...fixture().classes[0], id: 7 }], expected: snapshot() })

test('single class and multi-day occurrence validate with default capacity and reception stopped', () => {
  const input = fixture(); assert.ok(validation.validateOccurrenceInput(input).data)
  input.group.end_date = '2030-10-24'; input.classes.push({ ...input.classes[0], title: '第2部', date: '2030-10-24', start_time: '14:00' })
  assert.ok(validation.validateOccurrenceInput(input).data)
})
for (const [name, mutate] of [
  ['zero classes', v => v.classes = []], ['too many', v => v.classes = Array(101).fill(v.classes[0])], ['bad leap day', v => v.classes[0].date = '2030-02-29'], ['outside period', v => v.classes[0].date = '2030-10-24'], ['missing start', v => v.classes[0].start_time = null], ['bad capacity', v => v.classes[0].capacity = 0], ['new null capacity', v => v.classes[0].capacity = null], ['invalid end time', v => v.classes[0].end_time = '25:00'], ['reception injection', v => v.group.registration_open = true], ['foreign id on create', v => v.classes[0].id = 9], ['noninteger id', v => v.group_id = 1.1], ['empty venue', v => v.classes[0].location = ' '], ['empty title', v => v.group.title = ' '], ['invalid type', v => v.classes[0].type = 'other'], ['unknown field', v => v.password = 'synthetic'], ['long title', v => v.group.title = 'a'.repeat(201)], ['invalid date pair', v => v.group.end_date = null],
]) test(`validation rejects ${name}`, () => { const v = fixture(); mutate(v); assert.ok(validation.validateOccurrenceInput(v).error) })
test('edit snapshot remains raw, including NULL, end time and whitespace', () => {
  const v = editing(); v.expected.group.city = ' 東京 '; v.expected.group.description = null
  assert.equal(validation.validateOccurrenceInput(v).data.expected.group.city, ' 東京 ')
  assert.equal(validation.validateOccurrenceInput(v).data.expected.classes[0].end_time, '15:00')
})
for (const name of ['omitted', 'foreign', 'duplicate', 'no expected', 'extra expected']) test(`editing refuses ${name}`, () => {
  const v = editing()
  if (name === 'omitted') v.classes = [{ ...v.classes[0], id: null }]
  if (name === 'foreign') v.classes[0].id = 8
  if (name === 'duplicate') v.classes.push({ ...v.classes[0] })
  if (name === 'no expected') v.expected = null
  if (name === 'extra expected') v.expected.group.extra = true
  assert.ok(validation.validateOccurrenceInput(v).error)
})
function context({ auth = { ok: true }, result = { data: { group_id: 1, class_ids: [7] }, error: null } } = {}) {
  const calls = []
  const dependencies = {
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/supabase/require-admin': { requireAdmin: async () => auth },
    '@/lib/supabase/server': { createClient: async () => ({ rpc: async (name, args) => { calls.push([name, args]); return result } }) },
    '@/lib/event-groups/occurrence-editor': validation,
  }
  const post = compile('app/api/admin/occurrences/route.ts', dependencies).POST, get = compile('app/api/admin/occurrences/[id]/route.ts', dependencies).GET
  return { calls, post: (input = fixture(), headers = {}, raw = false) => post(new Request('http://localhost/api/admin/occurrences', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers }, body: raw ? input : JSON.stringify(input) })), get: (id = '1') => get(new Request('http://localhost/api/admin/occurrences/'+id), { params: Promise.resolve({ id }) }) }
}
for (const status of [401, 403]) test(`API authorization ${status} runs before RPC`, async () => {
  const c = context({ auth: { ok: false, status, error: 'denied' } }); assert.equal((await c.post()).status, status); assert.equal((await c.get()).status, status); assert.equal(c.calls.length, 0)
})
test('POST invokes only atomic RPC and returns no-store minimal success', async () => {
  const c = context(), r = await c.post(); assert.equal(r.status, 200); assert.deepEqual(plain(r.body), { saved: true, group_id: 1 }); assert.match(r.headers['Cache-Control'], /no-store/)
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0][0], 'admin_save_occurrence'); assert.equal(c.calls[0][1].p_key, key)
})
for (const [name, body, headers, raw, status] of [
  ['foreign origin', fixture(), { Origin: 'http://foreign.invalid' }, false, 403], ['missing origin', fixture(), { Origin: '' }, false, 403], ['cross-site', fixture(), { 'Sec-Fetch-Site': 'cross-site' }, false, 403], ['bad key', fixture(), { 'Idempotency-Key': 'invalid' }, false, 400], ['bad JSON', '{', {}, true, 400], ['oversized chunked body', 'a'.repeat(131073), {}, true, 413], ['content type', fixture(), { 'Content-Type': 'text/plain' }, false, 415], ['injected group state', { ...fixture(), registration_open: true }, {}, false, 400],
]) test(`POST rejects ${name} before RPC`, async () => { const c = context(); assert.equal((await c.post(body, headers, raw)).status, status); assert.equal(c.calls.length, 0) })
for (const [code, status] of [['PT409', 409], ['40001', 409], ['40P01', 409], ['PT404', 404], ['42501', 403], ['23514', 400], ['XX000', 503]]) test(`RPC ${code} maps to safe HTTP ${status}`, async () => {
  const c = context({ result: { data: null, error: { code, message: 'PRIVATE_DETAIL' } } }), r = await c.post(); assert.equal(r.status, status); assert.doesNotMatch(JSON.stringify(r), /PRIVATE_DETAIL/)
})
test('GET returns complete raw snapshot using only admin RPC', async () => { const c = context({ result: { data: snapshot(), error: null } }); const r = await c.get(); assert.equal(r.status, 200); assert.deepEqual(plain(r.body.snapshot), snapshot()); assert.equal(c.calls[0][0], 'admin_get_occurrence_editor') })
test('GET rejects invalid IDs and incomplete snapshots', async () => { const c = context(); assert.equal((await c.get('-1')).status, 400); assert.equal(c.calls.length, 0); assert.equal((await c.get()).status, 503) })
function memory() { let raw = null; return { read: () => raw, write: v => { raw = v }, clear: () => { raw = null } } }
test('lost response preserves frozen key and payload; manual retry only, even after refresh', async () => {
  const store = memory(), calls = []; let fail = true
  const fetch = async (_url, options) => { calls.push(options); if (fail) throw Error('lost'); return { status: 200, ok: true, json: async () => ({ saved: true, group_id: 12 }) } }
  const first = saving.createOccurrenceSaver(fetch, () => key, store), input = fixture()
  assert.equal((await first.save(input)).state, 'unknown'); assert.equal(calls.length, 1)
  input.group.title = 'not sent'; fail = false
  const second = saving.createOccurrenceSaver(fetch, () => { throw Error('must not create key') }, store); assert.ok(second.restore(null))
  assert.equal((await second.save()).groupId, 12); assert.equal(calls.length, 2); assert.equal(calls[1].body, calls[0].body); assert.equal(calls[1].headers['Idempotency-Key'], key); assert.equal(store.read(), null)
  await second.save(); assert.equal(calls.length, 2)
})
test('429 HTML preserves same key/body without parsing or automatic retry', async () => {
  const calls = [], store = memory(), c = saving.createOccurrenceSaver(async (_url, options) => { calls.push(options); return { status: 429, json: () => { throw Error('must not parse') } } }, () => key, store)
  assert.equal((await c.save(fixture())).state, 'unknown'); assert.equal(calls.length, 1); assert.ok(store.read()); await c.save(); assert.equal(calls[1].body, calls[0].body)
})
test('double save is blocked while request is pending', async () => {
  let release, calls = 0
  const c = saving.createOccurrenceSaver(() => { calls++; return new Promise(r => release = r) }, () => key, memory())
  const pending = c.save(fixture()); await c.save(fixture()); assert.equal(calls, 1); release({ status: 200, ok: true, json: async () => ({ saved: true, group_id: 1 }) }); await pending
})
test('definite rejection keeps form payload available and permits correction with a fresh key', async () => {
  let n = 0; const store = memory(), calls = []
  const c = saving.createOccurrenceSaver(async (_u, o) => { calls.push(o); return { status: 400, ok: false, json: async () => ({}) } }, () => `${key.slice(0,-1)}${++n}`, store)
  assert.equal((await c.save(fixture())).state, 'rejected'); assert.equal(store.read(), null); await c.save(fixture()); assert.notEqual(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key'])
})
test('unavailable storage blocks transmission; corrupt recovery blocks reuse', async () => {
  let calls = 0
  const c = saving.createOccurrenceSaver(async () => { calls++ }, () => key, { read: () => '{}', write: () => { throw Error('denied') }, clear() {} })
  assert.equal((await c.save(fixture())).state, 'rejected'); assert.equal(calls, 0); assert.throws(() => c.restore(null))
})
test('20-second timeout aborts, clears timer, retains attempt, and never retries automatically', async () => {
  const timers = [], cleared = [], calls = []
  const fake = compile('lib/event-groups/occurrence-save.ts', { './occurrence-editor': validation }, { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 99 }, clearTimeout: id => cleared.push(id) })
  const c = fake.createOccurrenceSaver((_u, o) => { calls.push(o); return new Promise((_r, reject) => o.signal.addEventListener('abort', () => reject(Error('abort')))) }, () => key, memory())
  const pending = c.save(fixture()); assert.equal(timers[0].ms, 20000); timers[0].fn(); assert.equal((await pending).state, 'unknown'); assert.equal(calls.length, 1); assert.deepEqual(cleared, [99])
})

test('secure key generation failure blocks all transmission', async () => {
  let calls=0
  const c=saving.createOccurrenceSaver(async()=>{calls++},()=>{throw Error('unavailable')},memory())
  assert.equal((await c.save(fixture())).state,'rejected');assert.equal(calls,0)
})

for (const [name, end, ok] of [['nullable', null, true], ['valid', '14:00', true], ['equal', '12:00', true], ['earlier', '11:59', false], ['seconds', '14:00:30', false], ['bad type', 1400, false]]) test(`explicit end time: ${name}`, () => {
  const v = fixture(); v.classes[0].end_time = end
  const result = validation.validateOccurrenceInput(v)
  assert.equal(!!result.data, ok)
  if (ok) assert.equal(result.data.classes[0].end_time, end)
})
test('omitted end remains omitted; explicit NULL clears it and raw expected remains intact', () => {
  const v = editing(); assert.equal(Object.hasOwn(validation.validateOccurrenceInput(v).data.classes[0], 'end_time'), false)
  v.classes[0].end_time = null; const result = validation.validateOccurrenceInput(v).data
  assert.equal(result.classes[0].end_time, null); assert.equal(result.expected.classes[0].end_time, '15:00')
})
test('start change cannot move beyond preserved end; unchanged legacy reversed times remain intact', () => {
  const v = editing(); v.classes[0].start_time = '16:00'; assert.ok(validation.validateOccurrenceInput(v).error)
  v.expected.classes[0].start_time = '16:00'; assert.ok(validation.validateOccurrenceInput(v).data)
})

test('equal minute and zero-second values compare as the same time', () => {
 const v=fixture();v.classes[0].start_time='12:00:00';v.classes[0].end_time='12:00';assert.ok(validation.validateOccurrenceInput(v).data)
 v.classes[0].start_time='12:00:01';assert.ok(validation.validateOccurrenceInput(v).error)
})
