import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'

function compile(file, dependencies = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, ...globals, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency'); return dependencies[name]
  } })
  return exports
}
const validation = compile('lib/schedules/new-schedule.ts')
const fixed = { id: 7, title: '対象開催回', registration_open: false }
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.props?.children)]
}
function hooks() {
  const slots = []; let cursor = 0
  return { reset() { cursor = 0 }, react: {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value }] },
    useRef(initial) { return slots[cursor++] ??= { current: initial } },
    useEffect() {},
  } }
}
function setup({ fixedGroup, status = 201, throws = false, pending = false, hideEndTime = false } = {}) {
  const harness = hooks(), calls = [], busy = [], created = [], dirty = [], Fields = () => null
  let release
  const { default: Form } = compile('app/(app)/admin/new-schedule-form.tsx', {
    react: harness.react, 'react/jsx-runtime': jsxRuntime,
    './new-schedule-fields': { default: Fields }, '@/lib/schedules/new-schedule': validation,
  }, {
    FormData: class { constructor(values) { this.values = values } get(key) { return this.values[key] ?? null } },
    fetch: async (url, options) => {
      calls.push({ url, options })
      if (throws) throw new Error('PRIVATE_INTERNAL_DETAIL')
      if (pending) return new Promise(resolve => { release = resolve })
      return { ok: status >= 200 && status < 300, status }
    },
  })
  const render = () => { harness.reset(); return elements(Form({ hideEndTime, fixedGroup, onCreated: () => created.push(true), onBusyChange: value => busy.push(value), onDirtyChange: value => dirty.push(value) })) }
  const field = name => render().find(item => item.props?.name === name)
  return { calls, busy, created, dirty, Fields, render, field,
    set(name, value) { field(name).props.onChange({ target: { value } }) },
    submit(values = {}) { return render().find(item => item.type === 'form').props.onSubmit({ preventDefault() {}, currentTarget: values }) },
    release() { release({ ok: true, status: 201 }) },
    fill() { this.set('title', ' 通常稽古 '); this.set('date', '2026-11-01'); this.set('start_time', '10:00'); this.set('end_time', '12:00'); this.set('location', '合成会場'); this.set('type', '一般参加') },
  }
}

test('shared form sends all existing fields through the existing validator and POST endpoint', async () => {
  const c = setup(); c.fill(); const before = c.render().find(item => item.type === c.Fields).key
  await c.submit({ new_event_group_id: '5', new_capacity: '10', new_registration_enabled: 'on' })
  assert.equal(c.calls.length, 1)
  assert.equal(c.calls[0].url, '/api/admin/schedules'); assert.equal(c.calls[0].options.method, 'POST'); assert.equal(c.calls[0].options.cache, 'no-store')
  assert.deepEqual(JSON.parse(c.calls[0].options.body), { title: '通常稽古', date: '2026-11-01', start_time: '10:00', end_time: '12:00', location: '合成会場', type: '一般参加', event_group_id: 5, capacity: 10, registration_enabled: true })
  assert.equal(c.field('title').props.value, ''); assert.equal(c.created.length, 1)
  assert.notEqual(c.render().find(item => item.type === c.Fields).key, before)
  assert.deepEqual(c.busy, [true, false])
})
test('standalone schedules still allow no group, no capacity and disabled reception', async () => {
  const c = setup(); c.set('title', '予定'); c.set('date', '2026-11-01'); await c.submit()
  const body = JSON.parse(c.calls[0].options.body)
  assert.equal(body.event_group_id, null); assert.equal(body.capacity, null); assert.equal(body.registration_enabled, false); assert.equal(body.start_time, null)
})
test('fixed group ID overrides tampered form values and is passed to the settings component', async () => {
  const c = setup({ fixedGroup: fixed }); c.fill()
  assert.equal(c.render().find(item => item.type === c.Fields).props.fixedGroup, fixed)
  await c.submit({ new_event_group_id: '999', new_capacity: '5', new_registration_enabled: 'on' })
  assert.equal(JSON.parse(c.calls[0].options.body).event_group_id, 7)
})
test('invalid fixed group and invalid schedule fields never POST', async () => {
  const invalid = setup({ fixedGroup: { ...fixed, id: 0 } }); invalid.fill(); await invalid.submit(); assert.equal(invalid.calls.length, 0)
  const c = setup(); c.set('title', '予定'); c.set('date', '2026-02-29'); await c.submit(); assert.equal(c.calls.length, 0)
  c.set('date', '2026-11-01'); await c.submit({ new_capacity: '1e2' }); assert.equal(c.calls.length, 0)
  await c.submit({ new_registration_enabled: 'on' }); assert.equal(c.calls.length, 0)
})
for (const status of [400, 401, 403, 500]) test(`HTTP ${status} retains inputs and settings without refresh`, async () => {
  const c = setup({ status }); c.fill(); const before = c.render().find(item => item.type === c.Fields).key
  await c.submit({ new_event_group_id: '5', new_capacity: '10' })
  assert.equal(c.field('title').props.value, ' 通常稽古 '); assert.equal(c.field('date').props.value, '2026-11-01')
  assert.equal(c.render().find(item => item.type === c.Fields).key, before)
  assert.equal(c.created.length, 0); assert.ok(c.render().some(item => item.props?.role === 'alert'))
})
test('uncertain network result retains all inputs and never automatically retries', async () => {
  const c = setup({ throws: true }); c.fill(); await c.submit()
  await Promise.resolve(); c.render()
  assert.equal(c.calls.length, 1); assert.equal(c.created.length, 0)
  assert.equal(c.field('location').props.value, '合成会場')
  const alert = c.render().find(item => item.props?.role === 'alert')
  assert.match(alert.props.children, /作成結果を確認できません/); assert.doesNotMatch(alert.props.children, /PRIVATE_INTERNAL_DETAIL/)
})
test('same-tick double submission sends once and disables inputs until completion', async () => {
  const c = setup({ pending: true }); c.fill()
  const send = c.render().find(item => item.type === 'form').props.onSubmit
  const event = { preventDefault() {}, currentTarget: {} }
  const first = send(event); await send(event)
  assert.equal(c.calls.length, 1); assert.equal(c.render().find(item => item.type === 'fieldset').props.disabled, true)
  c.release(); await first
  assert.equal(c.created.length, 1); assert.equal(c.render().find(item => item.type === 'fieldset').props.disabled, false)
})
test('fixed settings show target instead of a group selector and never auto-enable reception', () => {
  const harness = hooks()
  const { default: Fields } = compile('app/(app)/admin/new-schedule-fields.tsx', { react: harness.react, 'react/jsx-runtime': jsxRuntime })
  const render = () => { harness.reset(); return elements(Fields({ fixedGroup: fixed })) }
  let tree = render()
  assert.equal(tree.some(item => item.type === 'select'), false)
  assert.ok(tree.some(item => item.type === 'p' && JSON.stringify(item.props.children).includes('対象開催回')))
  tree.find(item => item.props?.name === 'new_capacity').props.onChange({ target: { value: '5' } })
  tree = render(); const checkbox = tree.find(item => item.props?.type === 'checkbox')
  assert.equal(checkbox.props.disabled, false); assert.equal(checkbox.props.checked, false)
})


test('dirty notification covers bubbled input changes and clears only on successful creation', async () => {
  const c = setup(); c.fill(); c.render().find(item => item.type === 'form').props.onChange()
  assert.deepEqual(c.dirty, [true]); await c.submit(); assert.deepEqual(c.dirty, [true, false])
  const failed = setup({ status: 500 }); failed.fill(); failed.render().find(item => item.type === 'form').props.onChange()
  await failed.submit(); assert.deepEqual(failed.dirty, [true]); assert.equal(failed.field('title').props.value, ' 通常稽古 ')
})


test('fixed group title never becomes the initial or submitted venue', async () => {
  const c = setup({ fixedGroup: { ...fixed, title: '登録済みの講習会グループ' } })
  assert.equal(c.field('location').props.value, '')
  c.fill()
  c.set('location', '【検証用】テスト会場')
  await c.submit({ new_capacity: '5', new_registration_enabled: 'on' })
  assert.equal(c.calls.length, 1)
  const payload = JSON.parse(c.calls[0].options.body)
  assert.equal(payload.location, '【検証用】テスト会場')
  assert.equal(payload.event_group_id, fixed.id)
  assert.equal(JSON.stringify(payload).includes('登録済みの講習会グループ'), false)
})

test('empty venue has no group-title fallback; explicitly typed text is preserved', async () => {
  for (const venue of ['', '登録済みの講習会グループ']) {
    const c = setup({ fixedGroup: fixed }); c.fill(); c.set('location', venue)
    await c.submit({ new_capacity: '5' })
    assert.equal(JSON.parse(c.calls[0].options.body).location, venue)
  }
})


test('occurrence creation hides the end-time input and never invents a value', async () => {
  const c = setup({ fixedGroup: fixed, hideEndTime: true }); c.set('title', '合成クラス'); c.set('date', '2026-11-01'); c.set('start_time', '10:00'); c.set('location', '合成会場')
  assert.equal(c.render().some(item => item.props?.name === 'end_time'), false)
  await c.submit({ new_capacity: '5', new_registration_enabled: 'on' })
  assert.equal(JSON.parse(c.calls[0].options.body).end_time, null)
})
