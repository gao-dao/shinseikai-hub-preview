import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function compile(file, dependencies = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, URL, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency')
    return dependencies[name]
  } })
  return exports
}
const validation = compile('lib/event-groups/validation.ts')
const initial = { id: 7, city: '福岡', start_date: '2026-11-01', end_date: '2026-11-03' }
const plain = value => JSON.parse(JSON.stringify(value))
function setup({ original = initial, authorization = { ok: true }, concurrent, readError = null, updateError = null, throws = false } = {}) {
  let row = original ? { ...original, title: 'Existing title', description: 'Existing description', registration_open: true } : null
  const calls = [], predicates = []
  let patch
  const route = compile('app/api/admin/event-groups/[id]/route.ts', {
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/event-groups/validation': validation,
    '@/lib/supabase/require-admin': { requireAdmin: async () => { calls.push(['authorize']); return authorization } },
    '@/lib/supabase/server': { createClient: async () => {
      calls.push(['client'])
      if (throws) throw new Error('PRIVATE_INTERNAL_DETAIL')
      return { from(table) {
        assert.equal(table, 'event_groups')
        const filters = []
        let updating = false
        const query = {
          select(columns) { calls.push(['select', columns]); return query },
          update(value) { updating = true; patch = plain(value); calls.push(['update', patch]); return query },
          eq(key, value) { filters.push([key, value]); if (updating) predicates.push(['eq', key, value]); return query },
          is(key, value) { filters.push([key, value]); if (updating) predicates.push(['is', key, value]); return query },
          async maybeSingle() {
            if (!updating) {
              const snapshot = row && { id: row.id, city: row.city, start_date: row.start_date, end_date: row.end_date }
              if (concurrent) row = concurrent === 'deleted' ? null : { ...row, ...concurrent }
              return { data: snapshot, error: readError }
            }
            if (updateError) return { data: null, error: updateError }
            if (!row || !filters.every(([key, value]) => row[key] === value)) return { data: null, error: null }
            row = { ...row, ...patch }
            return { data: { id: row.id, city: row.city, start_date: row.start_date, end_date: row.end_date }, error: null }
          },
        }
        return query
      } }
    } },
  })
  return { calls, predicates, row: () => row, patch: () => patch,
    send(body = { city: '東京' }, { id = '7', headers = { Origin: 'http://localhost', 'Content-Type': 'application/json' }, raw = false, withExpected = true } = {}) {
      if (withExpected && !raw && body && typeof body === 'object' && !Array.isArray(body)) {
        const source = original ?? initial
        body = { expected: { city: source.city, start_date: source.start_date, end_date: source.end_date }, ...body }
      }
      return route.PATCH(new Request('http://localhost/api/admin/event-groups/' + id, { method: 'PATCH', headers, body: raw ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) })
    },
  }
}
function safe(result) {
  assert.match(result.headers['Cache-Control'], /private.*no-store/)
  assert.equal(result.headers.Vary, 'Cookie')
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_INTERNAL_DETAIL/)
}

test('PATCH updates full occurrence metadata only and returns normalized fields', async () => {
  const s = setup(), result = await s.send({ city: ' 東京 ', start_date: '2026-12-01', end_date: '2026-12-02' })
  assert.equal(result.status, 200)
  assert.deepEqual(plain(result.body), { eventGroup: { id: 7, city: '東京', start_date: '2026-12-01', end_date: '2026-12-02' } })
  assert.equal(s.row().registration_open, true)
  assert.equal(s.row().title, 'Existing title'); assert.equal(s.row().description, 'Existing description')
  assert.deepEqual(Object.keys(s.patch()).sort(), ['city', 'end_date', 'start_date'])
  safe(result)
})
test('partial updates preserve omitted fields and compare the complete read snapshot', async () => {
  const s = setup(), result = await s.send({ end_date: '2026-11-04' })
  assert.equal(result.status, 200)
  assert.deepEqual(s.patch(), { end_date: '2026-11-04' })
  assert.equal(s.row().city, initial.city); assert.equal(s.row().start_date, initial.start_date)
  assert.deepEqual(s.predicates, [['eq', 'id', 7], ['eq', 'city', initial.city], ['eq', 'start_date', initial.start_date], ['eq', 'end_date', initial.end_date]])
})
test('null and empty input clear fields; nullable snapshots use IS NULL predicates', async () => {
  for (const body of [{ city: null, start_date: null, end_date: null }, { city: '　 ', start_date: '', end_date: '' }]) {
    const s = setup(), result = await s.send(body)
    assert.equal(result.status, 200)
    assert.deepEqual(s.patch(), { city: null, start_date: null, end_date: null })
  }
  const s = setup({ original: { id: 7, city: null, start_date: null, end_date: null } })
  assert.equal((await s.send({ city: '大阪' })).status, 200)
  assert.deepEqual(s.predicates, [['eq', 'id', 7], ['is', 'city', null], ['is', 'start_date', null], ['is', 'end_date', null]])
})
for (const status of [401, 403]) test(`PATCH denies ${status} before database access`, async () => {
  const s = setup({ authorization: { ok: false, status, error: 'denied' } }), result = await s.send()
  assert.equal(result.status, status); assert.deepEqual(s.calls, [['authorize']]); safe(result)
})
test('bad IDs and HTTP input are rejected before database access', async () => {
  for (const id of ['0', '-1', '01', '1.5', 'abc', '9007199254740992']) {
    const s = setup(); assert.equal((await s.send({}, { id })).status, 400); assert.deepEqual(s.calls, [['authorize']])
  }
  for (const [body, options, status] of [
    ['{', { raw: true }, 400],
    [{ city: '東京' }, { headers: { 'Content-Type': 'text/plain' } }, 415],
    [{ city: '東京' }, { headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.invalid' } }, 403],
  ]) {
    const s = setup(), result = await s.send(body, options)
    assert.equal(result.status, status); assert.deepEqual(s.calls, [['authorize']]); safe(result)
  }
})
test('invalid metadata, one-sided clearing and protected fields never update', async () => {
  for (const body of [null, [], 1, {}, { title: 'changed' }, { description: '' }, { registration_open: false }, { id: 8 }, { unknown: true }, { city: '東'.repeat(101) }, { city: 1 }, { start_date: null }, { end_date: '' }, { start_date: '2026-02-29' }, { start_date: '2026-11-04' }, { end_date: '2026-10-31' }]) {
    const s = setup(), result = await s.send(body)
    assert.equal(result.status, 400); assert.equal(s.patch(), undefined); safe(result)
  }
})
test('missing groups return 404 without an update', async () => {
  const s = setup({ original: null }), result = await s.send()
  assert.equal(result.status, 404); assert.equal(s.patch(), undefined); safe(result)
})
for (const concurrent of [{ city: '大阪' }, { start_date: '2026-11-02' }, { end_date: '2026-11-04' }, 'deleted']) test(`atomic update detects concurrent ${JSON.stringify(concurrent)}`, async () => {
  const s = setup({ concurrent }), result = await s.send()
  assert.equal(result.status, 409); assert.match(result.body.error, /再読み込み/); safe(result)
  if (concurrent !== 'deleted') assert.equal(s.row().registration_open, true)
})
test('null-to-value concurrent edits are also rejected', async () => {
  const s = setup({ original: { id: 7, city: null, start_date: null, end_date: null }, concurrent: { city: '大阪' } })
  assert.equal((await s.send()).status, 409)
  assert.equal(s.row().city, '大阪')
})
test('a concurrent reception change is preserved and does not conflict with metadata', async () => {
  const s = setup({ concurrent: { registration_open: false } })
  assert.equal((await s.send()).status, 200)
  assert.equal(s.row().registration_open, false)
})
test('database failures and exceptions are safely mapped', async () => {
  for (const [options, status] of [
    [{ readError: { message: 'PRIVATE_INTERNAL_DETAIL' } }, 500],
    [{ updateError: { code: '40001', message: 'PRIVATE_INTERNAL_DETAIL' } }, 409],
    [{ updateError: { code: '40P01' } }, 409],
    [{ updateError: { code: '23514' } }, 400],
    [{ updateError: { code: '22007' } }, 400],
    [{ updateError: { code: 'XX000', message: 'PRIVATE_INTERNAL_DETAIL' } }, 500],
    [{ throws: true }, 500],
  ]) {
    const result = await setup(options).send(); assert.equal(result.status, status); safe(result)
  }
})


for (const expected of [undefined, null, [], 1, 'invalid', {},
  { city: initial.city, start_date: initial.start_date },
  { ...initial },
  { city: initial.city, start_date: initial.start_date, end_date: initial.end_date, extra: true },
]) test(`expected structure is required and exact: ${JSON.stringify(expected)}`, async () => {
  const s = setup(), result = await s.send({ city: '東京', expected }, { withExpected: false })
  assert.equal(result.status, 400)
  assert.deepEqual(s.calls, [['authorize']])
  assert.equal(s.patch(), undefined)
  safe(result)
})

test('each expected value must be a string or explicit null', async () => {
  for (const field of ['city', 'start_date', 'end_date']) {
    for (const value of [undefined, 1, true, [], {}]) {
      const expected = { city: initial.city, start_date: initial.start_date, end_date: initial.end_date, [field]: value }
      const s = setup(), result = await s.send({ city: '東京', expected })
      assert.equal(result.status, 400)
      assert.deepEqual(s.calls, [['authorize']])
      assert.equal(s.patch(), undefined)
      safe(result)
    }
  }
})

test('expected alone does not constitute an update', async () => {
  const s = setup(), result = await s.send({ expected: { city: initial.city, start_date: initial.start_date, end_date: initial.end_date } })
  assert.equal(result.status, 400)
  assert.deepEqual(s.calls, [['authorize']])
})

for (const change of [{ city: '大阪' }, { start_date: '2026-11-02' }, { end_date: '2026-11-04' }, { city: null }]) test(`edit-start snapshot detects earlier change ${JSON.stringify(change)}`, async () => {
  const s = setup({ original: { ...initial, ...change } })
  const expected = { city: initial.city, start_date: initial.start_date, end_date: initial.end_date }
  const result = await s.send({ city: '東京', expected })
  assert.equal(result.status, 409)
  assert.match(result.body.error, /再読み込み/)
  assert.equal(s.patch(), undefined)
  assert.deepEqual(s.predicates, [])
  assert.equal(s.row().registration_open, true)
  safe(result)
})

test('expected is compared literally without trimming or replacing empty strings', async () => {
  for (const change of [{ city: ' 福岡 ' }, { city: '' }, { city: null }, { start_date: '2026-11-01 ' }, { end_date: '' }]) {
    const s = setup(), result = await s.send({ city: '東京', expected: { city: initial.city, start_date: initial.start_date, end_date: initial.end_date, ...change } })
    assert.equal(result.status, 409)
    assert.equal(s.patch(), undefined)
    safe(result)
  }
  for (const city of ['', '福岡']) {
    const s = setup({ original: { id: 7, city: null, start_date: null, end_date: null } })
    const result = await s.send({ city: '東京', expected: { city, start_date: null, end_date: null } })
    assert.equal(result.status, 409)
    assert.equal(s.patch(), undefined)
  }
})
