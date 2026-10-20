import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the actual route with isolated dependencies; never load env or contact Supabase.
const source = ts.transpileModule(fs.readFileSync('app/api/admin/registrations/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

function setup({ authorization = { ok: true }, queryResult = { data: [], count: 0, error: null }, throws = false } = {}) {
  const calls = []
  const query = {}
  for (const method of ['select', 'order', 'range']) {
    query[method] = (...args) => {
      calls.push([method, ...args])
      return method === 'range' ? Promise.resolve(queryResult) : query
    }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports, URL,
    require(name) {
      if (name === '@/lib/registrations/proxy-registration' || name === '@/lib/registrations/class-availability') return {}
      if (name === 'next/server') return { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } }
      if (name === '@/lib/supabase/require-admin') return { requireAdmin: async () => {
        calls.push(['authorize'])
        if (throws) throw new Error('internal sensitive detail')
        return authorization
      } }
      if (name === '@/lib/supabase/server') return { createClient: async () => {
        calls.push(['client'])
        return { from: table => { calls.push(['from', table]); return query } }
      } }
      throw new Error(`Unexpected dependency: ${name}`)
    },
  })
  return { get: page => exports.GET({ url: `http://localhost/api/admin/registrations${page === undefined ? '' : `?page=${page}`}` }), calls }
}

function assertNoCache(response) {
  assert.match(response.headers['Cache-Control'], /private.*no-store/)
  assert.equal(response.headers.Vary, 'Cookie')
}

for (const status of [401, 403]) {
  test(`denies ${status} before creating a data client`, async () => {
    const { get, calls } = setup({ authorization: { ok: false, status, error: status === 401 ? 'Unauthorized' : 'Forbidden' } })
    const response = await get()
    assert.equal(response.status, status)
    assert.deepEqual(calls, [['authorize']])
    assertNoCache(response)
  })
}

test('returns active and cancelled history, with bounded pagination and explicit columns', async () => {
  const data = [{ id: 1, name: 'テスト', registration_items: [{ status: 'active' }, { status: 'cancelled' }] }]
  const { get, calls } = setup({ queryResult: { data, count: 51, error: null } })
  const response = await get('2')
  assert.equal(response.status, 200)
  assert.equal(response.body.registrations, data)
  assert.equal(response.body.total, 51)
  assert.equal(response.body.pageSize, 50)
  assert.deepEqual(calls[0], ['authorize'])
  assert.deepEqual(calls.find(call => call[0] === 'range'), ['range', 50, 99])
  const select = calls.find(call => call[0] === 'select')[1]
  assert.match(select, /contact/)
  assert.match(select, /cancelled_at/)
  assert.match(select, /notes/)
  assert.doesNotMatch(select, /\*/)
  assertNoCache(response)
})

test('empty result uses the first page by default', async () => {
  const response = await setup().get()
  assert.equal(response.body.page, 1)
  assert.equal(response.body.total, 0)
  assert.equal(response.body.registrations.length, 0)
  assertNoCache(response)
})

test('rejects invalid page parameters without querying data', async () => {
  for (const page of ['0', '-1', '1.5', 'abc', '1000001', '9007199254740993', '']) {
    const { get, calls } = setup()
    const response = await get(page)
    assert.equal(response.status, 400)
    assert.deepEqual(calls, [['authorize']])
    assertNoCache(response)
  }
})

test('database failures and thrown errors do not disclose internal details', async () => {
  for (const options of [{ queryResult: { data: null, count: null, error: { message: 'internal sensitive detail' } } }, { throws: true }]) {
    const response = await setup(options).get()
    assert.equal(response.status, 500)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    assertNoCache(response)
  }
})
