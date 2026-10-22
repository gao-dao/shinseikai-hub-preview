import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const occurrenceValidation = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/event-groups/validation.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: occurrenceValidation })

// No environment files or real Supabase client are loaded by these tests.
const source = ts.transpileModule(fs.readFileSync('app/api/admin/event-groups/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

function setup({ authorization = { ok: true }, queryResult = { data: [], count: 0, error: null }, throws = false } = {}) {
  const calls = []
  const query = {}
  for (const method of ['select', 'order', 'range', 'insert', 'single']) {
    query[method] = (...args) => {
      calls.push([method, ...args])
      return ['range', 'single'].includes(method) ? Promise.resolve(queryResult) : query
    }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports, URL,
    require(name) {
      if (name === '@/lib/event-groups/validation') return occurrenceValidation
      if (name === 'next/server') return { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } }
      if (name === '@/lib/supabase/require-admin') return { requireAdmin: async () => {
        calls.push(['authorize'])
        if (throws) throw new Error('sensitive internal detail')
        return authorization
      } }
      if (name === '@/lib/supabase/server') return { createClient: async () => {
        calls.push(['client'])
        return { from: table => { calls.push(['from', table]); return query } }
      } }
      throw new Error(`Unexpected dependency: ${name}`)
    },
  })
  return {
    calls,
    get: (page = '1') => exports.GET(new Request(`http://localhost/api/admin/event-groups?page=${page}`)),
    post: (body, headers = { 'Content-Type': 'application/json', Origin: 'http://localhost' }, raw = false) =>
      exports.POST(new Request('http://localhost/api/admin/event-groups', { method: 'POST', headers, body: raw ? body : JSON.stringify(body) })),
  }
}

function noCache(response) {
  assert.match(response.headers['Cache-Control'], /private.*no-store/)
  assert.equal(response.headers.Vary, 'Cookie')
}

for (const status of [401, 403]) {
  for (const method of ['get', 'post']) {
    test(`${method} denies ${status} before database access`, async () => {
      const context = setup({ authorization: { ok: false, status, error: 'denied' } })
      const response = await context[method]({ title: '講習会' })
      assert.equal(response.status, status)
      assert.deepEqual(context.calls, [['authorize']])
      noCache(response)
    })
  }
}

test('GET selects only group metadata with bounded pagination', async () => {
  const data = [{ id: 1, title: '講習会', description: null, registration_open: false, city: '福岡', start_date: '2026-11-01', end_date: '2026-11-03' }]
  const context = setup({ queryResult: { data, count: 51, error: null } })
  const response = await context.get('2')
  assert.equal(response.status, 200)
  assert.equal(response.body.eventGroups, data)
  assert.equal(response.body.total, 51)
  assert.deepEqual(context.calls.find(call => call[0] === 'range'), ['range', 50, 99])
  assert.equal(context.calls.find(call => call[0] === 'select')[1], 'id, title, description, registration_open, city, start_date, end_date')
  assert.equal(context.calls[0][0], 'authorize')
  noCache(response)
})

test('GET handles empty results and rejects invalid pages', async () => {
  const response = await setup().get()
  assert.equal(response.body.total, 0)
  assert.equal(response.body.eventGroups.length, 0)
  for (const page of ['0', '-1', '1.2', 'abc', '', '1000001']) {
    const context = setup()
    const invalid = await context.get(page)
    assert.equal(invalid.status, 400)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(invalid)
  }
})

test('POST normalizes input and explicitly creates with registration_open false', async () => {
  for (const description of [' 説明 ', '', null, undefined]) {
    const context = setup({ queryResult: { data: { id: 1, registration_open: false }, error: null } })
    const response = await context.post({ title: ' 講習会 ', description })
    assert.equal(response.status, 201)
    const payload = context.calls.find(call => call[0] === 'insert')[1]
    assert.equal(payload.title, '講習会')
    assert.equal(payload.description, description === ' 説明 ' ? '説明' : null)
    assert.equal(payload.registration_open, false)
    for (const field of ['city', 'start_date', 'end_date']) assert.equal(payload[field], null)
    assert.equal(context.calls[0][0], 'authorize')
    noCache(response)
  }
})

test('POST validates types, lengths and rejects attempts to set protected fields', async () => {
  for (const body of [null, [], 'title', {}, { title: 1 }, { title: ' ' }, { title: 'あ'.repeat(201) }, { title: '会', description: 1 }, { title: '会', description: 'あ'.repeat(3001) }, { title: '会', registration_open: true }, { title: '会', id: 1 }]) {
    const context = setup()
    const response = await context.post(body)
    assert.equal(response.status, 400)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
  const valid = await setup().post({ title: '😀'.repeat(200), description: 'あ'.repeat(3000) })
  assert.equal(valid.status, 201)
})

test('POST rejects malformed JSON, wrong content type and foreign origins', async () => {
  const cases = [
    ['{', { 'Content-Type': 'application/json' }, true, 400],
    ['title', { 'Content-Type': 'text/plain' }, true, 415],
    [{ title: '会' }, { 'Content-Type': 'application/json', Origin: 'https://other.example' }, false, 403],
  ]
  for (const [body, headers, raw, status] of cases) {
    const context = setup()
    const response = await context.post(body, headers, raw)
    assert.equal(response.status, status)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
})

test('both endpoints hide database errors and unexpected exceptions', async () => {
  for (const options of [{ queryResult: { data: null, count: null, error: { message: 'sensitive internal detail' } } }, { throws: true }]) {
    for (const method of ['get', 'post']) {
      const response = await setup(options)[method](method === 'post' ? { title: '会' } : '1')
      assert.equal(response.status, 500)
      assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
      noCache(response)
    }
  }
})


test('POST saves normalized occurrence fields and returns them without changing reception', async () => {
  for (const [start_date, end_date] of [['2026-11-01', '2026-11-01'], ['2026-11-01', '2026-11-03'], ['2024-02-29', '2024-03-01']]) {
    const data = { id: 2, title: '会', description: null, registration_open: false, city: '福岡', start_date, end_date }
    const context = setup({ queryResult: { data, error: null } })
    const result = await context.post({ title: '会', city: ' 福岡　', start_date, end_date })
    assert.equal(result.status, 201)
    assert.equal(result.body.eventGroup, data)
    const payload = context.calls.find(call => call[0] === 'insert')[1]
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), { title: '会', description: null, city: '福岡', start_date, end_date, registration_open: false })
    assert.equal(context.calls.find(call => call[0] === 'select')[1], 'id, title, description, registration_open, city, start_date, end_date')
    noCache(result)
  }
})

test('GET preserves null occurrence metadata for existing groups', async () => {
  const data = [{ id: 1, title: '会', description: '説明', registration_open: true, city: null, start_date: null, end_date: null }]
  const result = await setup({ queryResult: { data, count: 1, error: null } }).get()
  assert.equal(result.status, 200)
  assert.equal(result.body.eventGroups, data)
  noCache(result)
})

test('POST accepts empty or null optional occurrence fields and the city length boundary', async () => {
  for (const body of [{ city: null, start_date: null, end_date: null }, { city: '　 ', start_date: '', end_date: '' }]) {
    const context = setup()
    assert.equal((await context.post({ title: '会', ...body })).status, 201)
    const payload = context.calls.find(call => call[0] === 'insert')[1]
    for (const field of ['city', 'start_date', 'end_date']) assert.equal(payload[field], null)
  }
  const context = setup()
  assert.equal((await context.post({ title: '会', city: '😀'.repeat(100) })).status, 201)
  assert.equal(context.calls.find(call => call[0] === 'insert')[1].city, '😀'.repeat(100))
})

test('POST rejects invalid occurrence fields before creating a Supabase client', async () => {
  const bodies = [
    { city: '東'.repeat(101) }, { city: 1 }, { city: [] }, { city: {} },
    { start_date: '2026-02-29', end_date: '2026-03-01' },
    { start_date: '1900-02-29', end_date: '1900-03-01' },
    { start_date: '2026-11-03', end_date: '2026-11-01' },
    { start_date: '2026-11-01' }, { end_date: '2026-11-01' },
    { start_date: '', end_date: '2026-11-01' },
    { start_date: '2026-11-01', end_date: null },
    { start_date: '2026/11/01', end_date: '2026-11-02' },
    { start_date: 1, end_date: 2 }, { start_date: [], end_date: {} },
    { city: '東京', unexpected: true }, { city: '東京', registration_open: true },
  ]
  for (const body of bodies) {
    const context = setup()
    const result = await context.post({ title: '会', ...body })
    assert.equal(result.status, 400)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(result)
  }
})
