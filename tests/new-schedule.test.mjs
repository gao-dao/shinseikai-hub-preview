import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
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
const validation = compile('lib/schedules/new-schedule.ts')
const valid = { title: ' 通常稽古 ', date: '2026-10-20', start_time: '18:00', end_time: null, location: '', type: '稽古会' }

function setup({ authorization = { ok: true }, group = { data: { id: 5 }, error: null }, insert = { data: { id: 7 }, error: null }, throws = false } = {}) {
  const calls = []
  const route = compile('app/api/admin/schedules/route.ts', {
    '@/lib/schedules/new-schedule': validation,
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/supabase/require-admin': { requireAdmin: async () => { calls.push(['authorize']); return authorization } },
    '@/lib/supabase/server': { createClient: async () => {
      calls.push(['client'])
      if (throws) throw new Error('sensitive detail')
      return { from: table => {
        calls.push(['from', table])
        const query = {}
        for (const method of ['select', 'eq', 'insert', 'single', 'maybeSingle']) {
          query[method] = (...args) => {
            calls.push([method, ...args])
            return method === 'maybeSingle' ? Promise.resolve(group) : method === 'single' ? Promise.resolve(insert) : query
          }
        }
        return query
      } }
    } },
  })
  return { calls, post: (body, headers = { 'Content-Type': 'application/json', Origin: 'http://localhost' }, raw = false) => route.POST(new Request('http://localhost/api/admin/schedules', { method: 'POST', headers, body: raw ? body : JSON.stringify(body) })) }
}
function noCache(response) {
  assert.match(response.headers['Cache-Control'], /private.*no-store/)
  assert.equal(response.headers.Vary, 'Cookie')
}

for (const status of [401, 403]) {
  test(`creation denies ${status} before validation or DB access`, async () => {
    const context = setup({ authorization: { ok: false, status, error: 'denied' } })
    const response = await context.post({})
    assert.equal(response.status, status)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  })
}

test('normal schedule defaults to no group, no capacity and reception disabled', async () => {
  const context = setup()
  const response = await context.post(valid)
  assert.equal(response.status, 201)
  const payload = context.calls.find(call => call[0] === 'insert')[1]
  assert.equal(payload.title, '通常稽古')
  assert.equal(payload.event_group_id, null)
  assert.equal(payload.capacity, null)
  assert.equal(payload.registration_enabled, false)
  assert.equal(context.calls.some(call => call[1] === 'event_groups'), false)
  noCache(response)
})

test('group is checked and only schedules are inserted, without changing group reception', async () => {
  for (const registration_enabled of [false, true]) {
    const context = setup()
    const response = await context.post({ ...valid, event_group_id: 5, capacity: 2147483647, registration_enabled })
    assert.equal(response.status, 201)
    assert.deepEqual(context.calls.filter(call => call[0] === 'from'), [['from', 'event_groups'], ['from', 'schedules']])
    assert.deepEqual(context.calls.find(call => call[0] === 'eq'), ['eq', 'id', 5])
    const payload = context.calls.find(call => call[0] === 'insert')[1]
    assert.equal(payload.registration_enabled, registration_enabled)
    assert.equal(payload.capacity, 2147483647)
    assert.equal('registration_open' in payload, false)
    assert.equal(context.calls.filter(call => call[0] === 'insert').length, 1)
    noCache(response)
  }
})

test('rejects malformed inputs and invalid integer ranges before database access', async () => {
  const bodies = [null, [], {}, { ...valid, title: ' ' }, { ...valid, date: '2026-02-30' }, { ...valid, start_time: '24:00' }, { ...valid, type: 'other' }, { ...valid, location: null }, { ...valid, registration_open: true }]
  for (const capacity of [0, -1, 1.5, '10', 2147483648, true]) bodies.push({ ...valid, capacity })
  for (const event_group_id of [0, -1, 1.5, '5', 9007199254740992]) bodies.push({ ...valid, event_group_id })
  for (const registration_enabled of ['true', 1, null]) bodies.push({ ...valid, registration_enabled })
  bodies.push({ ...valid, registration_enabled: true }, { ...valid, event_group_id: 5, registration_enabled: true }, { ...valid, capacity: 2, registration_enabled: true })
  for (const body of bodies) {
    const context = setup()
    const response = await context.post(body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
})

test('malformed JSON, content type and foreign origin are rejected', async () => {
  for (const [body, headers, raw, status] of [
    ['{', { 'Content-Type': 'application/json' }, true, 400],
    ['text', { 'Content-Type': 'text/plain' }, true, 415],
    [valid, { 'Content-Type': 'application/json', Origin: 'https://other.example' }, false, 403],
  ]) {
    const context = setup()
    const response = await context.post(body, headers, raw)
    assert.equal(response.status, status)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
})

test('missing group and group lookup failure prevent insertion', async () => {
  for (const [group, status] of [[{ data: null, error: null }, 400], [{ data: null, error: { message: 'sensitive detail' } }, 500]]) {
    const context = setup({ group })
    const response = await context.post({ ...valid, event_group_id: 5 })
    assert.equal(response.status, status)
    assert.equal(context.calls.some(call => call[0] === 'insert'), false)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    noCache(response)
  }
})

test('insertion errors, missing result and exceptions return safe failures', async () => {
  for (const [options, status] of [
    [{ insert: { data: null, error: { code: '23503', message: 'sensitive detail' } } }, 409],
    [{ insert: { data: null, error: { code: '23514', message: 'sensitive detail' } } }, 500],
    [{ insert: { data: null, error: null } }, 500], [{ throws: true }, 500],
  ]) {
    const response = await setup(options).post(valid)
    assert.equal(response.status, status)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    noCache(response)
  }
})

test('form parsing rejects exponent and decimal notation; full validation rejects overflow', () => {
  for (const capacity of ['1e2', '2.5', '-1', '0', 'abc', ' ']) assert.ok(validation.parseRegistrationFields('', capacity, false).error)
  const empty = validation.parseRegistrationFields('', '', false)
  assert.equal(empty.data.capacity, null)
  assert.equal(empty.data.event_group_id, null)
  assert.equal(validation.validateNewSchedule({ ...valid, ...validation.parseRegistrationFields('5', '2147483648', false).data }).data, undefined)
})

const fields = compile('app/(app)/admin/new-schedule-fields.tsx', { react: React, 'react/jsx-runtime': jsxRuntime })
test('group loader fetches every page and retains reception states', async () => {
  const calls = []
  const groups = await fields.loadAllEventGroups(async (url, options) => {
    calls.push(url)
    assert.equal(options.cache, 'no-store')
    const page = calls.length
    return { ok: true, json: async () => ({ page, pageSize: 1, total: 2, eventGroups: [{ id: page, title: `group${page}`, registration_open: page === 1 }] }) }
  }, new AbortController().signal)
  assert.deepEqual(calls, ['/api/admin/event-groups?page=1', '/api/admin/event-groups?page=2'])
  assert.equal(groups.length, 2)
  assert.equal(groups[0].registration_open, true)
  assert.equal(groups[1].registration_open, false)
})

test('group loader fails rather than publishing partial or malformed choices', async () => {
  for (const response of [
    { ok: false },
    { ok: true, json: async () => ({ page: 1, pageSize: 1, total: 2, eventGroups: [] }) },
    { ok: true, json: async () => ({ page: 1, pageSize: 1, total: 1, eventGroups: [{ id: 1, title: 'group', registration_open: 'true' }] }) },
  ]) await assert.rejects(fields.loadAllEventGroups(async () => response, new AbortController().signal))
})

// Render event handlers with isolated hook state, without a browser or real client.
function hooks() {
  const state = [], refs = []
  let index = 0, refIndex = 0
  return {
    state,
    reset: () => { index = 0; refIndex = 0 },
    react: {
      useState(initial) {
        const slot = index++
        if (!(slot in state)) state[slot] = initial
        return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
      },
      useRef(initial) { const slot = refIndex++; return refs[slot] ??= { current: initial } },
      useMemo: fn => fn(), useCallback: fn => fn,
      useEffect() {}, useLayoutEffect() {},
    },
  }
}
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.props?.children)]
}

test('new-only fields start disabled, require group and capacity, and never auto-enable reception', () => {
  const harness = hooks()
  const { default: Component } = compile('app/(app)/admin/new-schedule-fields.tsx', { react: harness.react, 'react/jsx-runtime': jsxRuntime })
  const render = () => { harness.reset(); return elements(Component()) }
  let tree = render()
  assert.equal(tree.find(item => item.props?.type === 'checkbox').props.checked, false)
  assert.equal(tree.find(item => item.props?.type === 'checkbox').props.disabled, true)
  harness.state[0] = [{ id: 5, title: '講習会', registration_open: false }]
  harness.state[1] = false
  tree = render()
  tree.find(item => item.type === 'select').props.onChange({ target: { value: '5' } })
  tree.find(item => item.props?.name === 'new_capacity').props.onChange({ target: { value: '10' } })
  tree = render()
  let checkbox = tree.find(item => item.props?.type === 'checkbox')
  assert.equal(checkbox.props.disabled, false)
  assert.equal(checkbox.props.checked, false)
  checkbox.props.onChange({ target: { checked: true } })
  tree = render()
  assert.equal(tree.find(item => item.props?.type === 'checkbox').props.checked, true)
  tree.find(item => item.type === 'select').props.onChange({ target: { value: '' } })
  tree = render()
  checkbox = tree.find(item => item.props?.type === 'checkbox')
  assert.equal(checkbox.props.disabled, true)
  assert.equal(checkbox.props.checked, false)
})

function adminForm({ ok = true, historyKnown = true } = {}) {
  const harness = hooks(), calls = []
  const ExtraFields = () => null
  const EditFields = () => null
  const NewForm = () => null
  let createHarness, CreateForm, createMounted = false
  function mountCreate() {
    createHarness = hooks()
    CreateForm = compile('app/(app)/admin/new-schedule-form.tsx', {
      react: createHarness.react, 'react/jsx-runtime': jsxRuntime,
      './new-schedule-fields': { default: ExtraFields }, '@/lib/schedules/new-schedule': validation,
    }, {
      fetch: async (url, options) => { calls.push(['post', url, JSON.parse(options.body)]); return { ok, status: ok ? 201 : 500 } },
      FormData: class { constructor(values) { this.values = values } get(key) { return this.values[key] ?? null } },
    }).default
  }
  const query = {
    select: () => query,
    order: async () => { calls.push(['refresh']); return { data: [] } },
    update: payload => { calls.push(['update', payload]); return { eq: async () => ({ error: null }) } },
  }
  const { default: Admin } = compile('app/(app)/admin/page.tsx', {
    react: harness.react, 'react/jsx-runtime': jsxRuntime,
    '@/lib/supabase/client': { createClient: () => ({ from: table => { assert.equal(table, 'schedules'); return query } }) },
    'next/navigation': { useRouter: () => ({}) }, 'next/link': { default: () => null },
    './schedule-registration-status': { useScheduleRegistrationStatuses: () => ({ statuses: historyKnown ? { '12': { hasRegistrationHistory: false, activeRegistrationCount: 0 } } : {}, loading: false, error: '', refresh() { calls.push(['refresh-status']) } }), ScheduleRegistrationStatus: () => null },
    './schedule-deletion': { scheduleDeletionBlockReason: () => 'unknown' },
    './new-schedule-form': { default: NewForm }, '@/lib/schedules/new-schedule': validation,
    './edit-schedule-fields': { default: EditFields }, '@/lib/schedules/edit-schedule': compile('lib/schedules/edit-schedule.ts'),
  }, {
    fetch: async (url, options) => { calls.push([options.method === 'PATCH' ? 'patch' : 'post', url, JSON.parse(options.body)]); return { ok, status: ok ? 201 : 500 } },
    FormData: class { constructor(values) { this.values = values } get(key) { return this.values[key] ?? null } },
    setTimeout() {}, window: { scrollTo() {} },
  })
  const render = () => {
    harness.reset()
    const tree = elements(Admin()), child = tree.find(item => item.type === NewForm)
    if (!child) { createMounted = false; return tree }
    if (!createMounted) { mountCreate(); createMounted = true }
    createHarness.reset()
    return [...tree, ...elements(CreateForm(child.props))]
  }
  render()
  harness.state[0] = 'schedules'; harness.state[1] = true; harness.state[2] = false
  let tree = render()
  tree.find(item => item.props?.placeholder === '通常稽古').props.onChange({ target: { value: '予定' } })
  tree.find(item => item.props?.type === 'date').props.onChange({ target: { value: '2026-10-20' } })
  // Editing retains the parent-controlled field state; creation owns separate state.
  harness.state[15] = '予定'; harness.state[16] = '2026-10-20'
  return { render, calls, harness, ExtraFields, EditFields }
}

test('new form uses POST and only refreshes/resets after success; failures retain inputs', async () => {
  for (const ok of [true, false]) {
    const context = adminForm({ ok })
    const before = context.render().find(item => item.type === context.ExtraFields)
    const form = context.render().find(item => item.type === 'form')
    await form.props.onSubmit({ preventDefault() {}, currentTarget: { new_event_group_id: '5', new_capacity: '10', new_registration_enabled: 'on' } })
    const post = context.calls.find(call => call[0] === 'post')
    assert.equal(post[1], '/api/admin/schedules')
    assert.equal(post[2].event_group_id, 5)
    assert.equal(post[2].registration_enabled, true)
    assert.equal(context.calls.some(call => call[0] === 'refresh'), ok)
    const afterTree = context.render()
    const after = afterTree.find(item => item.type === context.ExtraFields)
    assert.equal(after.key !== before.key, ok)
    assert.equal(afterTree.find(item => item.props?.placeholder === '通常稽古').props.value, ok ? '' : '予定')
  }
})

test('editing uses PATCH with all fields and snapshot; only success refreshes and resets', async () => {
  for (const ok of [true, false]) {
    const context = adminForm({ ok })
    context.harness.state[8] = { ...valid, id: 12, event_group_id: null, capacity: null, registration_enabled: false }
    const tree = context.render()
    assert.equal(tree.some(item => item.type === context.ExtraFields), false)
    assert.equal(tree.some(item => item.type === context.EditFields), true)
    await tree.find(item => item.type === 'form').props.onSubmit({ preventDefault() {}, currentTarget: { edit_event_group_id: '5', edit_capacity: '20', edit_registration_enabled: 'true' } })
    const patch = context.calls.find(call => call[0] === 'patch')
    assert.equal(patch[1], '/api/admin/schedules/12')
    assert.equal(patch[2].title, '予定')
    assert.equal(patch[2].capacity, 20)
    assert.equal(patch[2].event_group_id, 5)
    assert.equal(patch[2].registration_enabled, true)
    assert.equal(patch[2].expected.event_group_id, null)
    assert.equal(context.calls.some(call => call[0] === 'update'), false)
    assert.equal(context.calls.some(call => call[0] === 'refresh'), ok)
    assert.equal(context.calls.some(call => call[0] === 'refresh-status'), ok)
    assert.equal(context.render().some(item => item.type === context.EditFields), !ok)
  }
})

test('unknown history blocks edit submission; cancel clears fields and switches remount the editor', async () => {
  const context = adminForm({ historyKnown: false })
  context.harness.state[8] = { ...valid, id: 12, event_group_id: 5, capacity: 10, registration_enabled: true }
  let tree = context.render()
  const firstKey = tree.find(item => item.type === context.EditFields).key
  await tree.find(item => item.type === 'form').props.onSubmit({ preventDefault() {}, currentTarget: { edit_event_group_id: '5', edit_capacity: '10', edit_registration_enabled: 'true' } })
  assert.equal(context.calls.some(call => call[0] === 'patch'), false)
  context.harness.state[4] = [{ ...valid, id: 13, event_group_id: null, capacity: null, registration_enabled: false }]
  tree = context.render()
  tree.find(item => item.type === 'button' && item.props.children === '編集').props.onClick()
  tree = context.render()
  assert.notEqual(tree.find(item => item.type === context.EditFields).key, firstKey)
  assert.equal(tree.find(item => item.type === context.EditFields).props.schedule.id, 13)
  tree.find(item => item.props?.className === 'cancel-btn').props.onClick()
  tree = context.render()
  assert.equal(tree.some(item => item.type === context.ExtraFields), true)
  assert.equal(tree.find(item => item.props?.placeholder === '通常稽古').props.value, '')
  assert.equal(tree.some(item => item.type === context.EditFields), false)
})
