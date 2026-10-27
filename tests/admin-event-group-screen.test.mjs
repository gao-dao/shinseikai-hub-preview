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
  }).outputText, { exports, AbortController, ...globals, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency'); return dependencies[name]
  } })
  return exports
}
const validation = compile('lib/event-groups/validation.ts')
const overview = compile('lib/event-groups/admin-overview.ts')
const original = { id: 7, title: '講習会', description: '説明', registration_open: true, city: '福岡', start_date: '2026-11-01', end_date: '2026-11-03' }
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.props?.children)]
}
function setup({ group = original, postStatus = 201, patchStatus = 200, patchThrows = false, patchInvalid = false, listFails = false, groupId } = {}) {
  const slots = [], effects = [], calls = []
  let cursor = 0, groups = [{ ...group }], getFails = listFails
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value }] },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
    useEffect(fn, deps) {
      const i = cursor++, old = slots[i]
      if (!old || deps.some((value, j) => value !== old.deps[j])) {
        const entry = { fn, deps, cleanup: old?.cleanup }; slots[i] = entry; effects.push(entry)
      }
    },
  }
  const Control = () => null
  const ScheduleForm = () => null
  const Classes = () => null
  const Detail = () => null
  const confirmations = []; let confirmResult = true
  const { default: Component } = compile('app/(app)/admin/event-groups/event-groups.tsx', {
    '@/lib/event-groups/admin-overview': { ...overview, findOccurrence: async id => { const group = groups.find(item => item.id === id); if (!group) throw new Error('開催回が見つかりません'); return { ...group } } }, react, 'react/jsx-runtime': jsxRuntime, 'next/link': { default: () => null }, './registration-control': { default: Control }, './group-classes': { default: Classes }, './occurrence-detail': { default: Detail }, './occurrence-state': { default: () => null }, '../new-schedule-form': { default: ScheduleForm }, '@/lib/event-groups/validation': validation,
  }, { window: { confirm: message => { confirmations.push(message); return confirmResult } }, fetch: async (url, options = {}) => {
    calls.push({ url, options })
    const body = options.body ? JSON.parse(options.body) : null
    if (options.method === 'POST') return { ok: postStatus === 201, status: postStatus, json: async () => ({ error: '保存できませんでした' }) }
    if (options.method === 'PATCH') {
      if (patchThrows) throw new Error('PRIVATE_INTERNAL_DETAIL')
      return { ok: patchStatus === 200, status: patchStatus, json: async () => patchInvalid ? {} : { eventGroup: { id: group.id, city: body.city, start_date: body.start_date, end_date: body.end_date } } }
    }
    return { ok: !getFails, status: getFails ? 500 : 200, json: async () => ({ eventGroups: groups.map(item => ({ ...item })), page: 1, pageSize: 50, total: groups.length }) }
  } })
  const render = () => { cursor = 0; return elements(Component({ groupId })) }
  const text = node => elements(node).filter(item => item.type === 'p').map(item => JSON.stringify(item.props.children)).join(' ')
  const find = id => render().find(item => item.props?.id === id)
  const button = label => render().find(item => item.type === 'button' && item.props.children === label)
  return {
    calls, Control, ScheduleForm, Classes, Detail, confirmations, confirm: value => { confirmResult = value }, render, find, button, text: () => text(render()),
    setGroups: value => { groups = value }, failLists: () => { getFails = true },
    async flush() { render(); for (const effect of effects.splice(0)) { effect.cleanup?.(); effect.cleanup = effect.fn() } await new Promise(resolve => setImmediate(resolve)); render() },
    async mount() { render(); await this.flush() },
    change(id, value) { find(id).props.onChange({ target: { value } }) },
    async create() { await render().find(item => item.type === 'form' && !item.props['aria-label']).props.onSubmit({ preventDefault() {} }) },
    edit() { button('開催情報を編集').props.onClick() },
    async save() { await render().find(item => item.type === 'form' && item.props['aria-label'] === '開催情報の編集').props.onSubmit({ preventDefault() {} }) },
  }
}
const posts = c => c.calls.filter(call => call.options.method === 'POST')
const patches = c => c.calls.filter(call => call.options.method === 'PATCH')

test('creation sends normalized optional occurrence fields and resets only on success', async () => {
  const c = setup(); await c.mount()
  c.change('eg-title', '会'); c.change('eg-description', '説明'); c.change('eg-city', ' 東京 ')
  c.change('eg-start', '2026-12-01'); c.change('eg-end', '2026-12-02')
  await c.create()
  assert.deepEqual(JSON.parse(posts(c)[0].options.body), { title: '会', description: '説明', city: '東京', start_date: '2026-12-01', end_date: '2026-12-02' })
  assert.equal(c.find('eg-city').props.value, '')
})
test('omitted occurrence fields are sent as null and existing fields remain available', async () => {
  const c = setup(); await c.mount(); c.change('eg-title', '会'); await c.create()
  assert.deepEqual(JSON.parse(posts(c)[0].options.body), { title: '会', description: '', city: null, start_date: null, end_date: null })
  assert.ok(c.find('eg-description'))
})
test('creation validates dates and city before any POST; failed saving preserves inputs', async () => {
  const c = setup({ postStatus: 500 }); await c.mount(); c.change('eg-title', '会')
  for (const [city, start, end] of [['東'.repeat(101), '', ''], ['東京', '2026-01-01', ''], ['東京', '2026-02-29', '2026-03-01'], ['東京', '2026-11-03', '2026-11-01']]) {
    c.change('eg-city', city); c.change('eg-start', start); c.change('eg-end', end); await c.create()
    assert.equal(posts(c).length, 0); assert.ok(c.render().some(item => item.props?.role === 'alert'))
  }
  c.change('eg-city', '東京'); c.change('eg-start', ''); c.change('eg-end', ''); await c.create()
  assert.equal(posts(c).length, 1); assert.equal(c.find('eg-city').props.value, '東京'); assert.equal(c.find('eg-title').props.value, '会')
})
test('editing sends changes and the original raw expected snapshot then refreshes the list', async () => {
  const c = setup(); await c.mount(); c.edit()
  c.change('eg-edit-city', ' 東京 '); await c.save(); await c.flush()
  assert.deepEqual(JSON.parse(patches(c)[0].options.body), { city: '東京', start_date: original.start_date, end_date: original.end_date, expected: { city: original.city, start_date: original.start_date, end_date: original.end_date } })
  assert.equal(c.find('eg-edit-city'), undefined)
  assert.ok(c.calls.filter(call => !call.options.method).length >= 2)
})
test('null metadata displays unset, uses empty inputs and preserves null expected values', async () => {
  const c = setup({ group: { ...original, city: null, start_date: null, end_date: null } }); await c.mount()
  assert.match(c.text(), /未設定/); c.edit()
  assert.equal(c.find('eg-edit-city').props.value, ''); assert.equal(c.find('eg-edit-start').props.value, '')
  await c.save()
  assert.deepEqual(JSON.parse(patches(c)[0].options.body), { city: null, start_date: null, end_date: null, expected: { city: null, start_date: null, end_date: null } })
})
test('all occurrence fields can be cleared without sending title or reception fields', async () => {
  const c = setup(); await c.mount(); c.edit()
  for (const id of ['eg-edit-city', 'eg-edit-start', 'eg-edit-end']) c.change(id, '')
  await c.save(); const body = JSON.parse(patches(c)[0].options.body)
  assert.equal(body.city, null); assert.equal(body.start_date, null); assert.equal(body.end_date, null)
  assert.deepEqual(Object.keys(body).sort(), ['city', 'end_date', 'expected', 'start_date'])
})
test('cancel closes editing without PATCH and edit errors retain inputs', async () => {
  const c = setup(); await c.mount(); c.edit(); c.change('eg-edit-start', '')
  await c.save(); assert.equal(patches(c).length, 0); assert.equal(c.find('eg-edit-start').props.value, '')
  c.button('編集をキャンセル').props.onClick(); assert.equal(c.find('eg-edit-city'), undefined); assert.equal(patches(c).length, 0)
})
for (const options of [{ patchStatus: 500 }, { patchThrows: true }, { patchInvalid: true }, { patchStatus: 401 }, { patchStatus: 403 }]) test(`failed edit preserves inputs ${JSON.stringify(options)}`, async () => {
  const c = setup(options); await c.mount(); c.edit(); c.change('eg-edit-city', '東京'); await c.save()
  assert.equal(c.find('eg-edit-city').props.value, '東京'); assert.equal(patches(c).length, 1)
  assert.doesNotMatch(c.text(), /PRIVATE_INTERNAL_DETAIL/)
})
test('ordinary list refresh never replaces the edit-start expected snapshot', async () => {
  const c = setup(); await c.mount(); c.edit(); c.change('eg-edit-city', '東京')
  c.setGroups([{ ...original, city: '大阪' }]); c.button('一覧を再取得').props.onClick(); await c.flush()
  assert.equal(c.find('eg-edit-city').props.value, '東京'); await c.save()
  assert.equal(JSON.parse(patches(c)[0].options.body).expected.city, '福岡')
})
test('409 retains inputs, never retries, and requires explicit restart after fetching latest values', async () => {
  const c = setup({ patchStatus: 409 }); await c.mount(); c.edit(); c.change('eg-edit-city', '東京'); await c.save()
  assert.match(c.text(), /他の管理者によって開催情報が変更されました。最新情報を読み込み、内容を確認してから編集し直してください。/)
  assert.equal(c.find('eg-edit-city').props.value, '東京'); assert.equal(c.button('開催情報を保存').props.disabled, true)
  await c.save(); assert.equal(patches(c).length, 1)
  c.setGroups([{ ...original, city: '大阪' }]); await c.button('最新情報を再取得').props.onClick(); await c.flush()
  assert.match(c.text(), /大阪/); assert.equal(c.find('eg-edit-city').props.value, '東京'); assert.equal(patches(c).length, 1)
  c.button('最新情報で編集を再開').props.onClick(); assert.equal(c.find('eg-edit-city').props.value, '大阪')
  await c.save(); assert.equal(patches(c).length, 2); assert.equal(JSON.parse(patches(c)[1].options.body).expected.city, '大阪')
})
test('failed conflict reload preserves edits and cannot restart from missing data', async () => {
  const c = setup({ patchStatus: 409 }); await c.mount(); c.edit(); c.change('eg-edit-city', '東京'); await c.save()
  c.failLists(); await c.button('最新情報を再取得').props.onClick()
  assert.equal(c.find('eg-edit-city').props.value, '東京'); assert.equal(c.button('最新情報で編集を再開'), undefined)
  assert.equal(patches(c).length, 1)
})
test('existing registration control props and refresh callback are maintained', async () => {
  const c = setup(); await c.mount()
  const control = c.render().find(item => item.type === c.Control)
  assert.equal(control.props.id, original.id); assert.equal(control.props.registrationOpen, true); assert.equal(control.props.title, original.title)
  control.props.onUpdated(); await c.flush()
  assert.equal(c.calls.filter(call => !call.options.method).length, 2)
  assert.equal(patches(c).length, 0)
})


test('group card opens one form with fixed identity and refreshes only the saved group', async () => {
  const c = setup(); await c.mount()
  c.setGroups([original, { ...original, id: 8, title: '別開催回' }]); c.button('一覧を再取得').props.onClick(); await c.flush()
  const add = () => c.render().filter(item => item.type === 'button' && item.props.children === 'このグループに予定を追加')
  add()[0].props.onClick()
  let forms = c.render().filter(item => item.type === c.ScheduleForm)
  assert.equal(forms.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(forms[0].props.fixedGroup)), { id: 7, title: original.title, registration_open: true })
  const beforeClasses = c.render().filter(item => item.type === c.Classes)
  forms[0].props.onDirtyChange(true)
  forms[0].props.onCreated()
  assert.equal(c.render().some(item => item.type === c.ScheduleForm), false)
  assert.equal(c.confirmations.length, 0)
  assert.match(c.text(), /予定を保存しました/ )
  const classes = c.render().filter(item => item.type === c.Classes)
  assert.deepEqual(classes.map(item => [item.props.groupId, item.props.initiallyExpanded]), [[7, true], [8, false]])
  assert.notEqual(classes[0].key, beforeClasses[0].key)
  assert.equal(classes[1].key, beforeClasses[1].key)
  assert.equal(posts(c).length, 0); assert.equal(patches(c).length, 0)
  assert.equal(c.render().find(item => item.type === c.Control).props.registrationOpen, true)
  add()[1].props.onClick()
  forms = c.render().filter(item => item.type === c.ScheduleForm)
  assert.equal(forms.length, 1); assert.equal(forms[0].props.fixedGroup.id, 8)
})
test('unsaved close and group switching require confirmation and cancellation retains form', async () => {
  const c = setup(); await c.mount()
  c.setGroups([original, { ...original, id: 8 }]); c.button('一覧を再取得').props.onClick(); await c.flush()
  const add = () => c.render().filter(item => item.type === 'button' && item.props.children === 'このグループに予定を追加')
  add()[0].props.onClick()
  c.render().find(item => item.type === c.ScheduleForm).props.onDirtyChange(true)
  c.confirm(false); c.button('予定追加を閉じる').props.onClick()
  assert.equal(c.render().find(item => item.type === c.ScheduleForm).props.fixedGroup.id, 7)
  add()[1].props.onClick()
  assert.equal(c.render().find(item => item.type === c.ScheduleForm).props.fixedGroup.id, 7)
  assert.equal(c.confirmations.length, 2)
  c.confirm(true); add()[1].props.onClick()
  assert.equal(c.render().find(item => item.type === c.ScheduleForm).props.fixedGroup.id, 8)
  c.button('予定追加を閉じる').props.onClick()
  assert.equal(c.render().some(item => item.type === c.ScheduleForm), false)
})
test('busy form prevents closing, switching, editing and losing input through pagination', async () => {
  const c = setup(); await c.mount()
  const add = () => c.button('このグループに予定を追加')
  add().props.onClick()
  const form = c.render().find(item => item.type === c.ScheduleForm)
  form.props.onBusyChange(true)
  assert.equal(c.button('予定追加を閉じる').props.disabled, true)
  assert.equal(add().props.disabled, true)
  assert.equal(c.button('開催情報を編集').props.disabled, true)
  assert.equal(c.button('一覧を再取得').props.disabled, true)
  assert.equal(c.button('次のページ').props.disabled, true)
  c.button('予定追加を閉じる').props.onClick(); add().props.onClick(); c.edit()
  assert.equal(c.render().filter(item => item.type === c.ScheduleForm).length, 1)
  assert.equal(c.find('eg-edit-city'), undefined)
  form.props.onBusyChange(false)
  c.button('予定追加を閉じる').props.onClick()
  c.edit(); assert.ok(c.find('eg-edit-city')); assert.equal(add().props.disabled, true)
  add().props.onClick(); assert.equal(c.render().some(item => item.type === c.ScheduleForm), false)
})
test('unrelated reception refresh preserves the open create form and its refresh token', async () => {
  const c = setup(); await c.mount(); c.button('このグループに予定を追加').props.onClick()
  const before = c.render().find(item => item.type === c.ScheduleForm)
  before.props.onDirtyChange(true)
  c.render().find(item => item.type === c.Control).props.onUpdated(); await c.flush()
  const after = c.render().find(item => item.type === c.ScheduleForm)
  assert.equal(after.key, before.key); assert.equal(after.props.fixedGroup.id, 7)
  assert.equal(c.render().find(item => item.type === c.Classes).key, '7-0')
})


test('creating a new group cannot navigate away from an open class form', async () => {
  const c = setup(); await c.mount(); c.button('このグループに予定を追加').props.onClick()
  c.change('eg-title', '新しいグループ'); await c.create()
  assert.equal(posts(c).length, 0)
  assert.equal(c.button('作成する').props.disabled, true)
  assert.equal(c.render().filter(item => item.type === c.ScheduleForm).length, 1)
})


test('saved message remains in parent independently of class reload and subsequent form interactions', async () => {
  const c = setup(); await c.mount(); c.button('このグループに予定を追加').props.onClick()
  const form = c.render().find(item => item.type === c.ScheduleForm)
  form.props.onCreated()
  assert.equal(c.render().some(item => item.type === c.ScheduleForm), false)
  assert.match(c.text(), /予定を保存しました/)
  c.button('このグループに予定を追加').props.onClick()
  c.button('予定追加を閉じる').props.onClick()
  assert.match(c.text(), /予定を保存しました/)
  assert.equal(c.render().find(item => item.type === c.Classes).props.initiallyExpanded, true)
})




test('detail mode shows only its exact occurrence, existing reception, and honest application navigation', async () => {
  const c = setup({ groupId: original.id }); await c.mount()
  assert.equal(c.render().filter(item => item.type === c.Control).length, 0)
  const detail = c.render().find(item => item.type === c.Detail)
  assert.equal(detail.props.group.id, original.id)
  assert.equal(typeof detail.props.onUpdated, 'function')
  assert.equal(c.render().some(item => item.type === c.Classes), false)
  const nodes = c.render()
  assert.ok(nodes.indexOf(detail) < nodes.indexOf(nodes.find(item => item.props?.['aria-label'] === '管理操作')))
  assert.equal(nodes.find(item => item.type === 'h1').props.children, original.title)
  assert.doesNotMatch(c.text(), /未対応/); assert.match(c.text(), /申込者管理/)
  assert.equal(c.render().some(item => item.type === 'form' && !item.props['aria-label']), false)
  assert.equal(c.button('＋ クラスを追加'), undefined)
  assert.equal(c.button('開催情報を編集'), undefined)
  assert.equal(c.render().some(item => item.type === c.ScheduleForm), false)
  assert.equal(c.render().filter(item => item.props?.href === `/admin/event-groups/${original.id}/edit`).length, 1)
})
