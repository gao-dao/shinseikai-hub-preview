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
  return { calls, post: (input = fixture(), headers = {}, raw = false) => post(new Request('http://localhost/api/admin/occurrences', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers }, body: raw ? input : JSON.stringify(input) })), get: (id = '1', includeNotes = false) => get(new Request('http://localhost/api/admin/occurrences/'+id+(includeNotes?'?includeParticipationNotes=1':'')), { params: Promise.resolve({ id }) }) }
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

test('forward reception migration changes only new-group false to true and preserves the complete RPC',()=>{
 const before=fs.readFileSync('supabase/migrations/20261025_add_occurrence_end_time_editing.sql','utf8')
 const after=fs.readFileSync('supabase/migrations/20261027_open_new_occurrence_registration.sql','utf8')
 const marker='v_start, v_end, false)'
 assert.equal(before.split(marker).length-1,1)
 assert.equal(after,'-- Preview forward migration: only new group reception defaults to ON. Existing states and class input are preserved.\n'+before.replace(marker,'v_start, v_end, true)'))
})


for (const [notes, accepted] of [[null,true],['',true],['  \n\t　',true],['服装：道着\n支払：当日',true],['a'.repeat(3000),true],['😀'.repeat(3000),true],['a'.repeat(3001),false],[42,false],[{},false],[undefined,false]]) test(`participation notes validation: ${typeof notes}, length ${typeof notes==='string'?Array.from(notes).length:0}`, () => {
 const input=fixture();input.group.participation_notes=notes
 const result=validation.validateOccurrenceInput(input)
 assert.equal(!!result.data,accepted)
 if(accepted)assert.equal(result.data.group.participation_notes,typeof notes==='string'&&notes.trim()?notes:null)
})
test('legacy payload remains absent rather than gaining NULL; extended snapshot is raw and required for notes changes', () => {
 const legacy=editing(), validated=validation.validateOccurrenceInput(legacy).data
 assert.ok(validated)
 assert.equal(Object.hasOwn(validated.group,'participation_notes'),false)
 assert.equal(Object.hasOwn(validated.expected.group,'participation_notes'),false)
 legacy.group.participation_notes='新しい案内'
 assert.ok(validation.validateOccurrenceInput(legacy).error)
 legacy.expected.group.participation_notes='  既存の案内\n '
 const current=validation.validateOccurrenceInput(legacy).data
 assert.equal(current.expected.group.participation_notes,'  既存の案内\n ')
 assert.equal(current.group.participation_notes,'新しい案内')
 delete legacy.group.participation_notes
 assert.equal(Object.hasOwn(validation.validateOccurrenceInput(legacy).data.group,'participation_notes'),false)
 legacy.expected.group.participation_notes=42
 assert.equal(validation.validSnapshot(legacy.expected),false)
})
test('GET opts in to the new getter overload; default calls and legacy snapshots remain unchanged',async()=>{
 const extended=snapshot();extended.group.participation_notes='保険は各自確認'
 const c=context({result:{data:extended,error:null}})
 assert.equal((await c.get('1',true)).body.snapshot.group.participation_notes,'保険は各自確認')
 assert.deepEqual(plain(c.calls[0]),['admin_get_occurrence_editor',{p_group_id:1,p_include_participation_notes:true}])
 const old=context({result:{data:snapshot(),error:null}})
 assert.equal((await old.get()).status,200)
 assert.deepEqual(plain(old.calls[0]),['admin_get_occurrence_editor',{p_group_id:1}])
 assert.equal((await old.get('1',true)).status,503,'new editor must fail closed if the extended snapshot is unavailable')
})
for(const status of [401,403])test(`notes opt-in GET preserves server authorization ${status}`,async()=>{
 const c=context({auth:{ok:false,status,error:'Denied'}})
 assert.equal((await c.get('1',true)).status,status);assert.equal(c.calls.length,0)
})
test('POST forwards notes through the existing save RPC with unchanged public success response',async()=>{
 const input=fixture();input.group.description='説明は独立';input.group.participation_notes='持ち物\n支払方法'
 const c=context();const response=await c.post(input)
 assert.equal(response.status,200);assert.deepEqual(plain(response.body),{saved:true,group_id:1})
 assert.equal(c.calls[0][0],'admin_save_occurrence')
 assert.equal(c.calls[0][1].p_input.group.participation_notes,'持ち物\n支払方法')
 assert.equal(c.calls[0][1].p_input.group.description,'説明は独立')
 const legacy=context();await legacy.post()
 assert.equal(Object.hasOwn(legacy.calls[0][1].p_input.group,'participation_notes'),false)
})
test('notes remain frozen with the same save key/body across unknown result and reload',async()=>{
 const store=memory(), calls=[];let failed=true
 const send=async(_u,o)=>{calls.push(o);if(failed)throw Error('unknown');return{ok:true,status:200,json:async()=>({saved:true,group_id:12})}}
 const input=fixture();input.group.participation_notes='凍結した案内\n改行'
 const first=saving.createOccurrenceSaver(send,()=>key,store)
 assert.equal((await first.save(input)).state,'unknown')
 input.group.participation_notes='送信してはいけない変更';failed=false
 const second=saving.createOccurrenceSaver(send,()=>assert.fail('must reuse key'),store)
 second.restore(null);assert.equal((await second.save()).state,'saved')
 assert.equal(calls[0].body,calls[1].body)
 assert.equal(calls[1].headers['Idempotency-Key'],key)
 assert.match(calls[1].body,/凍結した案内/);assert.doesNotMatch(calls[1].body,/送信してはいけない/)
})
