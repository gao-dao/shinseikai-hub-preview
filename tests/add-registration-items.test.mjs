import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'

function compile(path, dependencies = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, URL, ...globals, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}
function row(id = 11, changes = {}) {
  return { id, title: `クラス${id}`, date: '2026-10-20', start_time: '10:00', end_time: '11:00', event_group_id: 5, capacity: 10, registration_enabled: true, active_items: [{ count: 2 }], own_items: [{ count: 0 }], ...changes }
}

// Mock-only clients expose SELECT and one RPC, never direct writes.
function setup({ authorization = { ok: true }, registration = { id: 7, event_group_id: 5 }, readError = null, rows = [row(), row(12)], classError = null, total, rpcError = null, throws = false } = {}) {
  const calls = []
  const route = compile('app/api/admin/registrations/[id]/items/route.ts', {
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/supabase/require-admin': { requireAdmin: async () => { calls.push(['authorize']); return authorization } },
    '@/lib/supabase/server': { createClient: async () => {
      calls.push(['client'])
      return {
        from: table => {
          calls.push(['from', table])
          let ids
          const query = {}
          for (const method of ['select', 'eq', 'in', 'order', 'range', 'maybeSingle']) query[method] = (...args) => {
            calls.push([method, ...args])
            if (method === 'in') ids = args[1]
            if (method === 'maybeSingle') return Promise.resolve({ data: registration, error: readError })
            return query
          }
          query.then = (resolve, reject) => {
            const data = ids ? rows.filter(row => ids.includes(row.id)) : rows
            return Promise.resolve({ data, error: classError, count: total === undefined ? data.length : total }).then(resolve, reject)
          }
          return query
        },
        rpc: async (...args) => { calls.push(['rpc', ...args]); if (throws) throw new Error('sensitive detail'); return { error: rpcError } },
      }
    } },
  })
  return {
    calls,
    get: (page = '1', id = '7') => route.GET(new Request(`http://localhost/api/admin/registrations/${id}/items?page=${page}`), { params: Promise.resolve({ id }) }),
    post: (body = { schedule_ids: [11, 12] }, { id = '7', raw = false, headers = { 'Content-Type': 'application/json', Origin: 'http://localhost' } } = {}) =>
      route.POST(new Request('http://localhost/api/admin/registrations/7/items', { method: 'POST', headers, body: raw ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) }),
  }
}
function noRpc(context) { assert.equal(context.calls.some(call => call[0] === 'rpc'), false) }
function noCache(response) { assert.match(response.headers['Cache-Control'], /private.*no-store/); assert.equal(response.headers.Vary, 'Cookie') }

for (const status of [401, 403]) for (const method of ['get', 'post']) test(`class addition ${method} denies ${status} before data access`, async () => {
  const context = setup({ authorization: { ok: false, status, error: 'denied' } })
  const response = await context[method]()
  assert.equal(response.status, status)
  assert.deepEqual(context.calls, [['authorize']])
  noCache(response)
})

test('GET scopes candidates to registration group and reports counts without applicant details', async () => {
  const context = setup({ rows: [row(11, { capacity: 2000, active_items: [{ count: 1500 }] }), row(12, { own_items: [{ count: 1 }] }), row(13, { capacity: 2 }), row(14, { registration_enabled: false })] })
  const response = await context.get('2')
  assert.equal(response.status, 200)
  assert.equal(response.body.schedules[0].remainingCapacity, 500)
  assert.equal(response.body.schedules[1].alreadyRegistered, true)
  assert.equal(response.body.schedules[1].selectable, false)
  assert.equal(response.body.schedules[2].selectable, false)
  assert.equal(response.body.schedules[3].selectable, false)
  assert.ok(context.calls.some(call => call[0] === 'eq' && call[1] === 'event_group_id' && call[2] === 5))
  assert.ok(context.calls.some(call => call[0] === 'eq' && call[1] === 'own_items.registration_id' && call[2] === 7))
  assert.deepEqual(context.calls.find(call => call[0] === 'range'), ['range', 50, 99])
  assert.doesNotMatch(JSON.stringify(response.body), /contact|notes|name/)
  noRpc(context)
  noCache(response)
})

test('POST adds multiple classes with exactly one RPC; no public reception check is imposed', async () => {
  const context = setup()
  const response = await context.post()
  assert.equal(response.status, 200)
  const rpc = context.calls.filter(call => call[0] === 'rpc')
  assert.equal(rpc.length, 1)
  assert.equal(rpc[0][1], 'admin_add_registration_items')
  assert.deepEqual(JSON.parse(JSON.stringify(rpc[0][2])), { p_registration_id: 7, p_schedule_ids: [11, 12] })
  assert.equal(context.calls.some(call => call[0] === 'from' && call[1] === 'event_groups'), false)
  assert.deepEqual(Object.keys(response.body), ['success'])
  noCache(response)
})

test('only active items block reapplication; cancelled history is retained by inserting via RPC', async () => {
  const context = setup({ rows: [row()] })
  const response = await context.post({ schedule_ids: [11] })
  assert.equal(response.status, 200)
  assert.ok(context.calls.some(call => call[0] === 'eq' && call[1] === 'own_items.status' && call[2] === 'active'))
  assert.equal(context.calls.filter(call => call[0] === 'rpc').length, 1)
})

test('duplicates, full, disabled or unset-capacity classes are rejected before RPC', async () => {
  for (const changes of [{ own_items: [{ count: 1 }] }, { capacity: 2 }, { registration_enabled: false }, { capacity: null }]) {
    const context = setup({ rows: [row(11, changes), row(12)] })
    const response = await context.post()
    assert.equal(response.status, 409)
    noRpc(context)
    noCache(response)
  }
})

test('another group and nonexistent classes are rejected without partial additions', async () => {
  for (const rows of [[row(11, { event_group_id: 6 }), row(12)], [row(11)]]) {
    const context = setup({ rows })
    assert.equal((await context.post()).status, 400)
    noRpc(context)
  }
})

test('invalid ID arrays, duplicates and out-of-scope fields are rejected', async () => {
  for (const body of [null, [], {}, { schedule_ids: [] }, { schedule_ids: [11, 11] }, { schedule_ids: [0] }, { schedule_ids: ['11'] }, { schedule_ids: [null] }, { schedule_ids: [1.5] }, { schedule_ids: [9007199254740992] }, { schedule_ids: Array.from({ length: 51 }, (_, i) => i + 1) }, { schedule_ids: [11], event_group_id: 6 }]) {
    const context = setup()
    const response = await context.post(body)
    assert.equal(response.status, 400)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
})

test('invalid path, page, JSON, content type and origin are rejected', async () => {
  for (const [body, options, status] of [[{}, { id: '0' }, 400], ['{', { raw: true }, 400], [{}, { headers: { 'Content-Type': 'text/plain' } }, 415], [{}, { headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' } }, 403]]) {
    const context = setup()
    const response = await context.post(body, options)
    assert.equal(response.status, status)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
  assert.equal((await setup().get('0')).status, 400)
})

test('unknown registration, read errors and missing aggregates never proceed', async () => {
  for (const [options, status] of [[{ registration: null }, 404], [{ readError: { message: 'sensitive detail' } }, 500], [{ classError: { message: 'sensitive detail' } }, 500], [{ rows: [row(11, { active_items: [] }), row(12)] }, 500], [{ total: null }, 500]]) {
    for (const method of ['get', 'post']) {
      const context = setup(options)
      const response = await context[method]()
      assert.equal(response.status, status)
      assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
      noRpc(context)
      noCache(response)
    }
  }
})

test('multi-class RPC failure never falls back to per-class writes or reports success', async () => {
  for (const [code, status] of [['P0001', 409], ['23505', 409], ['22023', 409], ['40001', 409], ['42501', 403], ['unknown', 500]]) {
    const context = setup({ rpcError: { code, message: 'sensitive detail' } })
    const response = await context.post()
    assert.equal(response.status, status)
    assert.equal('success' in response.body, false)
    assert.equal(context.calls.filter(call => call[0] === 'rpc').length, 1)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    noCache(response)
  }
  assert.equal((await setup({ throws: true }).post()).status, 500)
})

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.props?.children)]
}
function hooks() {
  const state = [], refs = []
  let index = 0, refIndex = 0
  return { state, reset: () => { index = 0; refIndex = 0 }, react: {
    useState(initial) { const slot = index++; if (!(slot in state)) state[slot] = initial; return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }] },
    useRef(initial) { const slot = refIndex++; return refs[slot] ??= { current: initial } }, useEffect() {},
  } }
}
const example = { id: 11, title: '午前クラス', date: '2026-10-20', start_time: '10:00', end_time: '11:00', capacity: 10, registeredCount: 2, remainingCapacity: 8, alreadyRegistered: false, selectable: true, unavailableReason: null }
function form({ status = 200, success = true, confirmed = true } = {}) {
  const harness = hooks(), calls = []
  const exports = compile('app/(app)/admin/registrations/add-registration-items.tsx', { react: harness.react, 'react/jsx-runtime': jsxRuntime }, {
    fetch: async (url, options) => { calls.push(['post', url, options]); return { ok: status === 200, status, json: async () => ({ success }) } },
    window: { confirm: message => { calls.push(['confirm', message]); return confirmed } },
  })
  const render = () => { harness.reset(); return elements(exports.default({ registrationId: 7, participantName: '参加者A', eventGroupTitle: '講習会B', onSaved: () => calls.push(['saved']), onCancel: () => calls.push(['cancel']) })) }
  render()
  harness.state[0] = [example, { ...example, id: 12, title: '午後クラス' }, { ...example, id: 13, selectable: false, alreadyRegistered: true }]
  harness.state[2] = false
  return { harness, calls, render, exports, submit: () => render().find(item => item.type === 'form').props.onSubmit({ preventDefault() {} }) }
}

test('form shows counts, disables active duplicates and confirms all selected classes', async () => {
  const context = form()
  const checks = context.render().filter(item => item.props?.type === 'checkbox')
  assert.equal(checks[2].props.disabled, true)
  checks[0].props.onChange({ target: { checked: true } })
  checks[1].props.onChange({ target: { checked: true } })
  await context.submit()
  assert.deepEqual(context.calls.map(call => call[0]), ['confirm', 'post', 'saved'])
  for (const label of ['参加者A', '講習会B', '午前クラス', '午後クラス', '2026-10-20']) assert.ok(context.calls[0][1].includes(label))
  assert.deepEqual(JSON.parse(context.calls[1][2].body), { schedule_ids: [11, 12] })
  assert.equal(context.calls[1][2].cache, 'no-store')
})

test('failure retains selection, cancellation does not submit and duplicates are guarded', async () => {
  for (const options of [{ status: 409 }, { status: 500 }, { success: false }, { confirmed: false }]) {
    const context = form(options)
    context.harness.state[1] = [11]
    await context.submit()
    assert.deepEqual(context.harness.state[1], [11])
    assert.equal(context.calls.some(call => call[0] === 'saved'), false)
    if (options.confirmed === false) assert.equal(context.calls.some(call => call[0] === 'post'), false)
    else assert.ok(context.render().some(item => item.props?.role === 'alert'))
  }
  const context = form()
  context.harness.state[1] = [11]
  await Promise.all([context.submit(), context.submit()])
  await context.submit()
  assert.equal(context.calls.filter(call => call[0] === 'post').length, 1)
})

test('candidate loader fetches every page and rejects failed or incomplete responses', async () => {
  const { exports } = form()
  const calls = []
  const candidates = await exports.loadRegistrationCandidates(7, async (url, options) => {
    calls.push(url)
    assert.equal(options.cache, 'no-store')
    return { ok: true, json: async () => ({ schedules: [{ ...example, id: calls.length }], page: calls.length, pageSize: 1, total: 2 }) }
  }, new AbortController().signal)
  assert.equal(candidates.length, 2)
  assert.equal(calls.length, 2)
  await assert.rejects(exports.loadRegistrationCandidates(7, async () => ({ ok: false }), new AbortController().signal))
  await assert.rejects(exports.loadRegistrationCandidates(7, async () => ({ ok: true, json: async () => ({ schedules: [], page: 1, pageSize: 1, total: 2 }) }), new AbortController().signal))
})
