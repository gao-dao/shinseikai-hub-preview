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

// Mock-only: no environment files, real clients, network or database operations.
function setup({ authorization = { ok: true }, item = { id: 7, status: 'active' }, readError = null, rpcError = null, throws = false } = {}) {
  const calls = []
  const route = compile('app/api/admin/registration-items/[id]/cancel/route.ts', {
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/supabase/require-admin': { requireAdmin: async () => { calls.push(['authorize']); return authorization } },
    '@/lib/supabase/server': { createClient: async () => {
      calls.push(['client'])
      const query = {
        select: value => { calls.push(['select', value]); return query },
        eq: (...args) => { calls.push(['eq', ...args]); return query },
        maybeSingle: async () => ({ data: item, error: readError }),
      }
      return {
        from: table => { calls.push(['from', table]); return query },
        rpc: async (...args) => { calls.push(['rpc', ...args]); if (throws) throw new Error('sensitive detail'); return { data: null, error: rpcError } },
      }
    } },
  })
  return { calls, post: ({ id = '7', origin = 'http://localhost' } = {}) => route.POST(
    new Request('http://localhost/api/admin/registration-items/7/cancel', { method: 'POST', headers: { Origin: origin } }),
    { params: Promise.resolve({ id }) },
  ) }
}
function noCache(response) {
  assert.match(response.headers['Cache-Control'], /private.*no-store/)
  assert.equal(response.headers.Vary, 'Cookie')
}
function noRpc(context) { assert.equal(context.calls.some(call => call[0] === 'rpc'), false) }

for (const status of [401, 403]) test(`cancellation denies ${status} before data access`, async () => {
  const context = setup({ authorization: { ok: false, status, error: 'denied' } })
  const response = await context.post()
  assert.equal(response.status, status)
  assert.deepEqual(context.calls, [['authorize']])
  noCache(response)
})

test('active item is checked and only its cancellation RPC is invoked', async () => {
  const context = setup()
  const response = await context.post()
  assert.equal(response.status, 200)
  assert.deepEqual(context.calls.find(call => call[0] === 'from'), ['from', 'registration_items'])
  assert.deepEqual(context.calls.find(call => call[0] === 'select'), ['select', 'id, status'])
  assert.deepEqual(context.calls.find(call => call[0] === 'eq'), ['eq', 'id', 7])
  const rpc = context.calls.find(call => call[0] === 'rpc')
  assert.equal(rpc[1], 'admin_cancel_registration_item')
  assert.deepEqual(JSON.parse(JSON.stringify(rpc[2])), { p_registration_item_id: 7 })
  assert.equal(context.calls.filter(call => call[0] === 'rpc').length, 1)
  assert.deepEqual(Object.keys(response.body), ['success'])
  assert.equal(response.body.success, true)
  noCache(response)
})

test('cancelled and nonexistent items are rejected before RPC', async () => {
  for (const [item, status] of [[{ id: 7, status: 'cancelled' }, 409], [null, 404]]) {
    const context = setup({ item })
    const response = await context.post()
    assert.equal(response.status, status)
    noRpc(context)
    noCache(response)
  }
})

test('invalid IDs and foreign origins never access the database', async () => {
  for (const options of [{ id: '0' }, { id: '-1' }, { id: '1.5' }, { id: 'abc' }, { id: '9007199254740992' }, { origin: 'https://other.example' }]) {
    const context = setup()
    const response = await context.post(options)
    assert.equal(response.status, options.origin ? 403 : 400)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
})

test('read errors and unknown item states fail closed', async () => {
  for (const options of [{ readError: { message: 'sensitive detail' } }, { item: { id: 7, status: 'unknown' } }]) {
    const context = setup(options)
    const response = await context.post()
    assert.equal(response.status, 500)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    noRpc(context)
    noCache(response)
  }
})

test('RPC final-state rejection and concurrency errors take precedence over precheck', async () => {
  for (const code of ['22023', '23503', '23514', '40001', '40P01']) {
    const context = setup({ rpcError: { code, message: 'active registration item does not exist' } })
    const response = await context.post()
    assert.equal(response.status, 409)
    assert.equal('success' in response.body, false)
    assert.equal(context.calls.filter(call => call[0] === 'rpc').length, 1)
    assert.doesNotMatch(JSON.stringify(response.body), /active registration/)
    noCache(response)
  }
})

test('permission errors, DB failures and exceptions are safe failures', async () => {
  for (const [options, status] of [[{ rpcError: { code: '42501', message: 'sensitive detail' } }, 403], [{ rpcError: { code: 'unknown', message: 'sensitive detail' } }, 500], [{ throws: true }, 500]]) {
    const response = await setup(options).post()
    assert.equal(response.status, status)
    assert.equal('success' in response.body, false)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    noCache(response)
  }
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
function control({ status = 'active', confirmed = true, responseStatus = 200, success = true, throws = false, disabled = false, classTitle = '午前クラス' } = {}) {
  const harness = hooks(), calls = []
  const { default: Component } = compile('app/(app)/admin/registrations/cancel-registration-item.tsx', { react: harness.react, 'react/jsx-runtime': jsxRuntime }, {
    window: { confirm: text => { calls.push(['confirm', text]); return confirmed } },
    fetch: async (url, options) => { calls.push(['post', url, options]); if (throws) throw new Error('sensitive detail'); return { ok: responseStatus === 200, status: responseStatus, json: async () => ({ success }) } },
  })
  const render = () => { harness.reset(); return elements(Component({ itemId: 7, status, participantName: '参加者A', eventGroupTitle: '講習会B', classTitle, date: '2026-10-20', startTime: '10:00', disabled, onCancelled: () => calls.push(['cancelled']) })) }
  return { calls, render, cancel: () => render().find(item => item.type === 'button')?.props.onClick() }
}

test('confirmation identifies participant, group, class, date and item before sending POST', async () => {
  const context = control()
  await context.cancel()
  assert.deepEqual(context.calls.map(call => call[0]), ['confirm', 'post', 'cancelled'])
  for (const text of ['参加者A', '講習会B', '午前クラス', '2026-10-20', '10:00', '申込明細ID：7', '他のクラスの申込は変更されません']) assert.ok(context.calls[0][1].includes(text))
  assert.equal(context.calls[1][1], '/api/admin/registration-items/7/cancel')
  assert.equal(context.calls[1][2].method, 'POST')
  assert.equal(context.calls[1][2].cache, 'no-store')
  assert.equal(context.render().find(item => item.type === 'button').props.disabled, true)
})

test('cancelled items have no button; cancelled confirmation sends nothing', async () => {
  assert.equal(control({ status: 'cancelled' }).render().some(item => item.type === 'button'), false)
  const context = control({ confirmed: false })
  await context.cancel()
  assert.deepEqual(context.calls.map(call => call[0]), ['confirm'])
})

test('missing target details or editing lock prevents cancellation even if handler is invoked', async () => {
  for (const options of [{ classTitle: '' }, { disabled: true }]) {
    const context = control(options)
    assert.equal(context.render().find(item => item.type === 'button').props.disabled, true)
    await context.cancel()
    assert.equal(context.calls.length, 0)
  }
})

test('errors and unverifiable results show safe errors and never refresh', async () => {
  for (const options of [{ responseStatus: 401 }, { responseStatus: 403 }, { responseStatus: 404 }, { responseStatus: 409 }, { responseStatus: 500 }, { success: false }, { throws: true }]) {
    const context = control(options)
    await context.cancel()
    assert.equal(context.calls.some(call => call[0] === 'cancelled'), false)
    assert.ok(context.render().some(item => item.props?.role === 'alert'))
    assert.doesNotMatch(JSON.stringify(context.render().filter(item => item.props?.role === 'alert')), /sensitive/)
  }
})

test('in-flight and completed operations cannot issue duplicate POSTs, including stale handlers', async () => {
  const context = control()
  const handler = context.render().find(item => item.type === 'button').props.onClick
  await Promise.all([handler(), handler()])
  await handler()
  await context.cancel()
  assert.equal(context.calls.filter(call => call[0] === 'post').length, 1)
  assert.equal(context.calls.filter(call => call[0] === 'cancelled').length, 1)
})

test('list cancellation callback refreshes without removing other class history', () => {
  const harness = hooks(), Cancel = () => null
  const { default: List } = compile('app/(app)/admin/registrations/registration-list.tsx', {
    react: harness.react, 'react/jsx-runtime': jsxRuntime, 'next/link': { default: () => null }, './registration-details-form': { default: () => null }, './cancel-registration-item': { default: Cancel }, './add-registration-items': { default: () => null }, './proxy-registration-form': { default: () => null },
  })
  const registration = { id: 1, name: '参加者', contact: '連絡先', notes: null, created_at: '2026-10-20T00:00:00Z', event_groups: { title: '講習会' }, registration_items: [
    { id: 7, status: 'active', cancelled_at: null, schedules: { title: '午前', date: '2026-10-20', start_time: '10:00' } },
    { id: 8, status: 'cancelled', cancelled_at: '2026-10-20T01:00:00Z', schedules: { title: '午後', date: '2026-10-20', start_time: '13:00' } },
  ] }
  const render = () => { harness.reset(); return elements(List()) }
  render()
  harness.state[2] = { registrations: [registration], page: 1, pageSize: 50, total: 1 }
  harness.state[4] = false
  const controls = render().filter(item => item.type === Cancel)
  assert.equal(controls.length, 2)
  assert.equal(controls[0].props.participantName, '参加者')
  assert.equal(controls[0].props.eventGroupTitle, '講習会')
  controls[0].props.onCancelled()
  assert.equal(harness.state[1], 1)
  assert.equal(registration.registration_items.length, 2)
  assert.equal(registration.registration_items[1].status, 'cancelled')
})
