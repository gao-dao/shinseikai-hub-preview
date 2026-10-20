import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'

function compile(path, dependencies = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, URL, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}
const validation = compile('lib/schedules/new-schedule.ts')
const restrictions = compile('lib/schedules/edit-schedule.ts')
const original = { title: '予定', date: '2026-10-20', start_time: '18:00', end_time: null, location: '道場', type: '稽古会', event_group_id: 5, capacity: 10, registration_enabled: true }

// All database operations are mocked; this test cannot connect to Supabase.
function setup({ authorization = { ok: true }, saved = original, active = 0, history = 0, readError = null, group = { data: { id: 6 }, error: null }, update = { data: { id: 12 }, error: null }, throws = false } = {}) {
  const calls = []
  const route = compile('app/api/admin/schedules/[id]/route.ts', {
    '@/lib/schedules/new-schedule': validation, '@/lib/schedules/edit-schedule': restrictions,
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/supabase/require-admin': { requireAdmin: async () => { calls.push(['authorize']); return authorization } },
    '@/lib/supabase/server': { createClient: async () => {
      calls.push(['client'])
      if (throws) throw new Error('sensitive detail')
      return { from: table => {
        calls.push(['from', table])
        let updating = false
        const query = {}
        for (const method of ['select', 'eq', 'is', 'update', 'maybeSingle']) query[method] = (...args) => {
          calls.push([method, ...args])
          if (method === 'update') updating = true
          if (method === 'maybeSingle') return Promise.resolve(updating ? update : table === 'event_groups' ? group : {
            data: saved === null ? null : { ...saved, history_items: history === null ? [] : [{ count: history }], active_items: active === null ? [] : [{ count: active }] }, error: readError,
          })
          return query
        }
        return query
      } }
    } },
  })
  return { calls, patch: (body, { id = '12', headers = { 'Content-Type': 'application/json', Origin: 'http://localhost' }, raw = false } = {}) =>
    route.PATCH(new Request(`http://localhost/api/admin/schedules/${id}`, { method: 'PATCH', headers, body: raw ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) }) }
}
function noCache(response) {
  assert.match(response.headers['Cache-Control'], /private.*no-store/)
  assert.equal(response.headers.Vary, 'Cookie')
}
function noUpdate(context) { assert.equal(context.calls.some(call => call[0] === 'update'), false) }

for (const status of [401, 403]) test(`PATCH rejects ${status} before data access`, async () => {
  const context = setup({ authorization: { ok: false, status, error: 'denied' } })
  const response = await context.patch({})
  assert.equal(response.status, status)
  assert.deepEqual(context.calls, [['authorize']])
  noCache(response)
})

test('no history permits changing and clearing group; partial PATCH preserves omitted fields', async () => {
  for (const event_group_id of [6, null]) {
    const context = setup()
    const response = await context.patch({ event_group_id, registration_enabled: false, expected: original })
    assert.equal(response.status, 200)
    const payload = context.calls.find(call => call[0] === 'update')[1]
    assert.equal(payload.event_group_id, event_group_id)
    assert.equal(payload.title, original.title)
    assert.equal(payload.capacity, original.capacity)
    assert.equal('registration_open' in payload, false)
    assert.equal(context.calls.filter(call => call[0] === 'update').length, 1)
    assert.equal(context.calls.filter(call => call[0] === 'from').every(call => ['event_groups', 'schedules'].includes(call[1])), true)
    assert.ok(context.calls.some(call => call[0] === 'eq' && call[1] === 'capacity' && call[2] === 10))
    assert.ok(context.calls.some(call => call[0] === 'is' && call[1] === 'end_time'))
    noCache(response)
  }
})

test('active and cancelled-only history forbid group changes and unlinking', async () => {
  for (const active of [0, 3]) for (const event_group_id of [6, null]) {
    const context = setup({ history: 4, active })
    const response = await context.patch({ event_group_id, registration_enabled: false })
    assert.equal(response.status, 409)
    assert.match(response.body.error, /取消済みを含む申込履歴/)
    noUpdate(context)
    noCache(response)
  }
})

test('capacity increase and reduction to active count succeed; below active count or null fail', async () => {
  for (const capacity of [3, 4, 20, 2147483647, 2, null]) {
    const context = setup({ active: 3, history: 5 })
    const response = await context.patch({ capacity, registration_enabled: false })
    assert.equal(response.status, capacity === null || capacity < 3 ? 409 : 200)
    if (response.status !== 200) noUpdate(context)
  }
  const response = await setup({ active: 0, history: 3 }).patch({ capacity: null, registration_enabled: false })
  assert.equal(response.status, 200)
})

test('reception can be enabled or disabled without touching items or group reception', async () => {
  for (const registration_enabled of [true, false]) {
    const context = setup({ history: 3, active: 2 })
    const response = await context.patch({ registration_enabled })
    assert.equal(response.status, 200)
    const payload = context.calls.find(call => call[0] === 'update')[1]
    assert.equal(payload.registration_enabled, registration_enabled)
    assert.equal('registration_open' in payload, false)
    assert.equal(context.calls.some(call => call[0] === 'from' && call[1] === 'registration_items'), false)
  }
  assert.equal((await setup().patch({ capacity: null, registration_enabled: true })).status, 400)
  assert.equal((await setup().patch({ event_group_id: null, registration_enabled: true })).status, 400)
})

test('invalid fields and integer boundaries are rejected without updates', async () => {
  for (const body of [null, [], {}, { id: 2 }, { registration_open: true }, { title: '' }, { date: '2026-02-30' }, { start_time: '25:00' }, { type: 'invalid' }, { capacity: 0 }, { capacity: -1 }, { capacity: 1.5 }, { capacity: 2147483648 }, { capacity: '3' }, { event_group_id: '6' }, { registration_enabled: 'true' }]) {
    const context = setup()
    const response = await context.patch(body)
    assert.equal(response.status, 400, JSON.stringify(body))
    noUpdate(context)
    noCache(response)
  }
  assert.equal((await setup().patch({ capacity: 1 })).status, 200)
})

test('invalid ID, JSON, content type and Origin are rejected', async () => {
  for (const [body, options, status] of [
    [{ title: '会' }, { id: '0' }, 400], [{ title: '会' }, { id: '9007199254740992' }, 400],
    ['{', { raw: true }, 400], [{ title: '会' }, { headers: { 'Content-Type': 'text/plain' } }, 415],
    [{ title: '会' }, { headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' } }, 403],
  ]) {
    const context = setup()
    const response = await context.patch(body, options)
    assert.equal(response.status, status)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
})

test('missing history, read errors and missing schedule fail closed', async () => {
  for (const [options, status] of [[{ history: null }, 500], [{ active: null }, 500], [{ active: 3, history: 2 }, 500], [{ readError: { message: 'sensitive detail' } }, 500], [{ saved: null }, 404]]) {
    const context = setup(options)
    const response = await context.patch({ title: '変更' })
    assert.equal(response.status, status)
    noUpdate(context)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    noCache(response)
  }
})

test('group lookup failure or missing target group prevents updates', async () => {
  for (const [group, status] of [[{ data: null, error: null }, 400], [{ data: null, error: { message: 'sensitive detail' } }, 500]]) {
    const context = setup({ group })
    const response = await context.patch({ event_group_id: 6 })
    assert.equal(response.status, status)
    noUpdate(context)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
  }
})

test('stale editor snapshot and malformed expected information never update', async () => {
  for (const [expected, status] of [[{ ...original, capacity: 11 }, 409], [{}, 400], [null, 400]]) {
    const context = setup()
    const response = await context.patch({ title: '変更', expected })
    assert.equal(response.status, status)
    noUpdate(context)
    noCache(response)
  }
})

test('concurrent changes, FK/trigger rejection and DB errors return safe errors', async () => {
  for (const code of ['23503', '23514', '40001', '40P01', '42501']) {
    const context = setup({ update: { data: null, error: { code, message: 'sensitive detail' } } })
    const response = await context.patch({ title: '変更' })
    assert.equal(response.status, code === '42501' ? 500 : 409)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    noCache(response)
  }
  assert.equal((await setup({ update: { data: null, error: null } }).patch({ title: '変更' })).status, 409)
  const unexpected = await setup({ throws: true }).patch({ title: '変更' })
  assert.equal(unexpected.status, 500)
  assert.doesNotMatch(JSON.stringify(unexpected.body), /sensitive/)
})

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.props?.children)]
}
function editor(props) {
  const state = []
  let index = 0
  const react = { useState(initial) {
    const slot = index++
    if (!(slot in state)) state[slot] = initial
    return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
  }, useEffect() {} }
  const { default: Component } = compile('app/(app)/admin/edit-schedule-fields.tsx', {
    react, 'react/jsx-runtime': jsxRuntime, './new-schedule-fields': { loadAllEventGroups() {} },
  })
  return { state, render: (nextProps = props) => { index = 0; return elements(Component(nextProps)) } }
}

test('editor initializes saved settings, locks history and unknown groups, and preserves hidden values', () => {
  for (const [history, historyLoading, historyError] of [[{ hasRegistrationHistory: true, activeRegistrationCount: 0 }, false, ''], [undefined, false, 'failed'], [undefined, true, '']]) {
    const context = editor({ schedule: original, history, historyLoading, historyError })
    const tree = context.render()
    assert.equal(tree.find(item => item.props?.id === 'edit-schedule-group').props.value, '5')
    assert.equal(tree.find(item => item.props?.id === 'edit-schedule-group').props.disabled, true)
    assert.equal(tree.find(item => item.props?.id === 'edit-schedule-capacity').props.value, '10')
    assert.equal(tree.find(item => item.props?.type === 'checkbox').props.checked, true)
    assert.equal(tree.find(item => item.props?.name === 'edit_event_group_id').props.value, '5')
  }
})

test('no-history editor permits group changes after choices load and remount starts from another schedule', () => {
  const context = editor({ schedule: original, history: { hasRegistrationHistory: false, activeRegistrationCount: 0 }, historyLoading: false, historyError: '' })
  context.render()
  context.state[4] = false
  let tree = context.render()
  const select = tree.find(item => item.type === 'select')
  assert.equal(select.props.disabled, false)
  select.props.onChange({ target: { value: '6' } })
  tree = context.render()
  assert.equal(tree.find(item => item.props?.name === 'edit_event_group_id').props.value, '6')
  assert.equal(tree.find(item => item.props?.type === 'checkbox').props.checked, false)
  const other = editor({ schedule: { event_group_id: null, capacity: null, registration_enabled: false }, history: { hasRegistrationHistory: false, activeRegistrationCount: 0 }, historyLoading: false, historyError: '' }).render()
  assert.equal(other.find(item => item.props?.name === 'edit_event_group_id').props.value, '')
  assert.equal(other.find(item => item.props?.name === 'edit_capacity').props.value, '')
  assert.equal(other.find(item => item.props?.type === 'checkbox').props.checked, false)
})
