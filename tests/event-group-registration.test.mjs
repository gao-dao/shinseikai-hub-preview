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

// No real Supabase modules, environment files or network are available here.
function setup({ authorization = { ok: true }, current = false, counts = [2, 1, 0], countError = null,
  readError = null, missing = false, updateError = null, zeroUpdated = false, throws = false, stateVersion = 0, cancelled = false, hidden = false } = {}) {
  const calls = []
  const route = compile('app/api/admin/event-groups/[id]/registration/route.ts', {
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/supabase/require-admin': { requireAdmin: async () => { calls.push(['authorize']); return authorization } },
    '@/lib/supabase/server': { createClient: async () => {
      calls.push(['client'])
      if (throws) throw new Error('sensitive detail')
      return { from: table => {
        calls.push(['from', table])
        let enabled = false, invalid = false, payload
        const query = {}
        for (const method of ['select', 'eq', 'or', 'update', 'maybeSingle']) query[method] = (...args) => {
          calls.push([method, ...args])
          if (method === 'eq' && args[0] === 'registration_enabled') enabled = true
          if (method === 'or') invalid = true
          if (method === 'update') payload = args[0]
          if (method === 'maybeSingle') return Promise.resolve(payload ? {
            data: zeroUpdated ? null : { id: 5, registration_open: payload.registration_open }, error: updateError,
          } : { data: missing ? null : { id: 5, registration_open: current, state_version: stateVersion, is_cancelled: cancelled, is_hidden: hidden }, error: readError })
          return query
        }
        query.then = (resolve, reject) => Promise.resolve({ count: counts[invalid ? 2 : enabled ? 1 : 0], error: countError }).then(resolve, reject)
        return query
      } }
    } },
  })
  return {
    calls,
    get: (id = '5') => route.GET(new Request('http://localhost/api/admin/event-groups/5/registration'), { params: Promise.resolve({ id }) }),
    patch: (body = { registration_open: !current, expected_registration_open: current, expected_state_version: 0 }, { id = '5', raw = false, headers = { 'Content-Type': 'application/json', Origin: 'http://localhost' } } = {}) =>
      route.PATCH(new Request('http://localhost/api/admin/event-groups/5/registration', { method: 'PATCH', headers, body: raw ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) }),
  }
}
function noCache(response) {
  assert.match(response.headers['Cache-Control'], /private.*no-store/)
  assert.equal(response.headers.Vary, 'Cookie')
}
function noUpdate(context) { assert.equal(context.calls.some(call => call[0] === 'update'), false) }

for (const status of [401, 403]) for (const method of ['get', 'patch']) test(`${method} denies ${status} before data access`, async () => {
  const context = setup({ authorization: { ok: false, status, error: 'denied' } })
  const response = await context[method]()
  assert.equal(response.status, status)
  assert.deepEqual(context.calls, [['authorize']])
  noCache(response)
})

test('eligibility GET checks exact counts and does not mutate anything', async () => {
  const context = setup({ counts: [2001, 1500, 0] })
  const response = await context.get()
  assert.equal(response.status, 200)
  assert.equal(response.body.canOpen, true)
  assert.equal(response.body.registration_open, false)
  const headSelects = context.calls.filter(call => call[0] === 'select' && call[2]?.head)
  assert.equal(headSelects.length, 3)
  assert.ok(headSelects.every(call => call[2].count === 'exact'))
  assert.ok(context.calls.some(call => call[0] === 'or' && call[1] === 'capacity.is.null,capacity.lte.0'))
  noUpdate(context)
  noCache(response)
})

test('start succeeds and updates only group reception', async () => {
  const context = setup()
  const response = await context.patch()
  assert.equal(response.status, 200)
  assert.equal(response.body.eventGroup.registration_open, true)
  const updates = context.calls.filter(call => call[0] === 'update')
  assert.equal(updates.length, 1)
  assert.deepEqual(Object.keys(updates[0][1]), ['registration_open'])
  assert.ok(context.calls.some(call => call[0] === 'eq' && call[1] === 'registration_open' && call[2] === false))
  assert.ok(context.calls.filter(call => call[0] === 'from').every(call => ['event_groups', 'schedules'].includes(call[1])))
  noCache(response)
})

test('no schedules, disabled-only classes, null or invalid enabled capacities reject start', async () => {
  for (const [counts, pattern] of [[[0, 0, 0], /所属する予定がない/], [[2, 0, 0], /受付対象のクラスがありません/], [[2, 1, 1], /正の定員/], [[3, 2, 1], /正の定員/]]) {
    const context = setup({ counts })
    const check = await context.get()
    assert.equal(check.body.canOpen, false)
    assert.match(check.body.reason, pattern)
    const response = await context.patch()
    assert.equal(response.status, 409)
    assert.match(response.body.error, pattern)
    noUpdate(context)
    noCache(response)
  }
})

test('missing counts, query failures and inconsistent counts reject start', async () => {
  for (const options of [{ counts: [null, 1, 0] }, { counts: [2, null, 0] }, { counts: [2, 1, null] }, { counts: [0, 1, 0] }, { counts: [2, 1, 2] }, { countError: { message: 'sensitive detail' } }]) {
    const context = setup(options)
    for (const method of ['get', 'patch']) {
      const response = await context[method]()
      assert.equal(response.status, 500)
      assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
      noCache(response)
    }
    noUpdate(context)
  }
})

test('stop succeeds even if class info is unavailable and never reads or updates history', async () => {
  const context = setup({ current: true, countError: { message: 'class query must not happen' } })
  const response = await context.patch()
  assert.equal(response.status, 200)
  assert.equal(response.body.eventGroup.registration_open, false)
  assert.deepEqual(context.calls.filter(call => call[0] === 'from'), [['from', 'event_groups'], ['from', 'event_groups']])
  const payload = context.calls.find(call => call[0] === 'update')[1]
  assert.equal(payload.registration_open, false)
  assert.deepEqual(Object.keys(payload), ['registration_open'])
  noCache(response)
})

test('malformed state and forbidden title/description edits are rejected', async () => {
  for (const body of [null, [], {}, { registration_open: 'true', expected_registration_open: false, expected_state_version: 0 }, { registration_open: true }, { registration_open: true, expected_registration_open: false, title: 'changed' }, { registration_open: false, expected_registration_open: true, description: 'changed' }]) {
    const context = setup()
    const response = await context.patch(body)
    assert.equal(response.status, 400)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
})

test('invalid IDs, JSON, content type and origin are rejected', async () => {
  for (const [body, options, status] of [
    [{}, { id: '0' }, 400], [{}, { id: '9007199254740992' }, 400], ['{', { raw: true }, 400],
    [{}, { headers: { 'Content-Type': 'text/plain' } }, 415],
    [{}, { headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' } }, 403],
  ]) {
    const context = setup()
    const response = await context.patch(body, options)
    assert.equal(response.status, status)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
})

test('read failures, missing groups and invalid current state never update', async () => {
  for (const [options, status] of [[{ readError: { message: 'sensitive detail' } }, 500], [{ missing: true }, 404], [{ current: null }, 500], [{ throws: true }, 500]]) {
    for (const method of ['get', 'patch']) {
      const context = setup(options)
      const response = await (method === 'get' ? context.get() : context.patch({ registration_open: true, expected_registration_open: false, expected_state_version: 0 }))
      assert.equal(response.status, status)
      assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
      noUpdate(context)
      noCache(response)
    }
  }
})

test('stale state, zero affected rows and update errors do not report success', async () => {
  const stale = setup({ current: true })
  assert.equal((await stale.patch({ registration_open: true, expected_registration_open: false, expected_state_version: 0 })).status, 409)
  noUpdate(stale)
  for (const [options, status] of [[{ zeroUpdated: true }, 409], [{ updateError: { code: '42501', message: 'sensitive detail' } }, 500], [{ updateError: { code: '40001', message: 'sensitive detail' } }, 409]]) {
    const response = await setup(options).patch()
    assert.equal(response.status, status)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    noCache(response)
  }
})

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.props?.children)]
}
function control({ registrationOpen = false, canOpen = true, checkOk = true, patchOk = true, confirmed = true, wrongResult = false } = {}) {
  const state = [], refs = [], calls = []
  let index = 0, refIndex = 0
  const react = {
    useState(initial) { const slot = index++; if (!(slot in state)) state[slot] = initial; return [state[slot], value => { state[slot] = value }] },
    useRef(initial) { const slot = refIndex++; return refs[slot] ??= { current: initial } },
  }
  const { default: Component } = compile('app/(app)/admin/event-groups/registration-control.tsx', { react, 'react/jsx-runtime': jsxRuntime }, {
    window: { confirm: message => { calls.push(['confirm', message]); return confirmed } },
    fetch: async (url, options) => {
      const patch = options.method === 'PATCH'
      calls.push([patch ? 'patch' : 'check', url, options])
      return { ok: patch ? patchOk : checkOk, status: patch ? patchOk ? 200 : 409 : checkOk ? 200 : 500,
        json: async () => patch ? patchOk ? { eventGroup: { id: 5, registration_open: wrongResult ? registrationOpen : !registrationOpen } } : { error: '予定の設定を確認してください。' }
          : { id: 5, registration_open: registrationOpen, state_version: 0, canOpen, reason: canOpen ? null : '受付対象のクラスがありません。' } }
    },
  })
  const render = () => { index = 0; refIndex = 0; return elements(Component({ id: 5, title: '講習会', registrationOpen, stateVersion: 0, onUpdated: () => calls.push(['updated']) })) }
  return { calls, render, change: () => render().find(item => item.type === 'button').props.onClick() }
}

test('screen checks start conditions before confirmation and refreshes only after success', async () => {
  const context = control()
  await context.change()
  assert.deepEqual(context.calls.map(call => call[0]), ['check', 'confirm', 'patch', 'updated'])
  const patch = context.calls.find(call => call[0] === 'patch')
  assert.deepEqual(JSON.parse(patch[2].body), { registration_open: true, expected_registration_open: false, expected_state_version: 0 })
  assert.equal(patch[2].cache, 'no-store')
})

test('screen refuses start on no targets or missing information', async () => {
  for (const options of [{ canOpen: false }, { checkOk: false }]) {
    const context = control(options)
    await context.change()
    assert.deepEqual(context.calls.map(call => call[0]), ['check'])
    assert.ok(context.render().some(item => item.props?.role === 'alert'))
  }
})

test('cancelled confirmation never updates; stop bypasses opening conditions', async () => {
  const cancel = control({ confirmed: false })
  await cancel.change()
  assert.deepEqual(cancel.calls.map(call => call[0]), ['check', 'confirm'])
  const stop = control({ registrationOpen: true })
  await stop.change()
  assert.deepEqual(stop.calls.map(call => call[0]), ['confirm', 'patch', 'updated'])
  assert.match(stop.calls[0][1], /既存の申込・取消履歴は変更されません/)
})

test('update errors and unverifiable responses show errors without refreshing', async () => {
  for (const options of [{ patchOk: false }, { wrongResult: true }]) {
    const context = control(options)
    await context.change()
    assert.equal(context.calls.some(call => call[0] === 'updated'), false)
    assert.ok(context.render().some(item => item.props?.role === 'alert'))
  }
})

test('duplicate clicks during eligibility checks issue only one update', async () => {
  const context = control()
  await Promise.all([context.change(), context.change()])
  assert.equal(context.calls.filter(call => call[0] === 'check').length, 1)
  assert.equal(context.calls.filter(call => call[0] === 'patch').length, 1)
})


for (const registrationOpen of [true, false]) test(`group reception label explicitly identifies its scope: ${registrationOpen}`, () => {
  const c = control({ registrationOpen })
  const button = c.render().find(item => item.type === 'button')
  const action = registrationOpen ? '停止' : '開始'
  assert.equal(button.props.children, `グループ全体の受付を${action}`)
  assert.equal(button.props['aria-label'], `講習会：グループ全体の受付を${action}`)
  assert.equal(c.calls.length, 0)
})

test('reception PATCH refuses stale lifecycle versions and checks version in atomic UPDATE',async()=>{
 const stale=setup({stateVersion:2});assert.equal((await stale.patch()).status,409);noUpdate(stale)
 const fresh=setup();assert.equal((await fresh.patch()).status,200);assert.ok(fresh.calls.some(v=>v[0]==='eq'&&v[1]==='state_version'&&v[2]===0))
})
for(const flags of [{hidden:true},{cancelled:true}])test(`blocked lifecycle prevents reopening ${JSON.stringify(flags)}`,async()=>{const c=setup(flags);assert.equal((await c.get()).body.canOpen,false);assert.equal((await c.patch()).status,409);noUpdate(c)})
