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
const validation = compile('lib/registrations/details.ts')
const valid = { name: ' テスト参加者 ', contact: ' test@example.invalid ', notes: ' 備考 ' }

// The actual route is executed with a mock RPC client. No env or DB is loaded.
function setup({ authorization = { ok: true }, rpcError = null, throws = false } = {}) {
  const calls = []
  const route = compile('app/api/admin/registrations/[id]/route.ts', {
    '@/lib/registrations/details': validation,
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/supabase/require-admin': { requireAdmin: async () => { calls.push(['authorize']); return authorization } },
    '@/lib/supabase/server': { createClient: async () => {
      calls.push(['client'])
      return { rpc: async (...args) => {
        calls.push(['rpc', ...args])
        if (throws) throw new Error('sensitive detail')
        return { data: null, error: rpcError }
      } }
    } },
  })
  return { calls, patch: (body = valid, { id = '7', headers = { 'Content-Type': 'application/json', Origin: 'http://localhost' }, raw = false } = {}) =>
    route.PATCH(new Request('http://localhost/api/admin/registrations/7', { method: 'PATCH', headers, body: raw ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) }) }
}
function noCache(response) {
  assert.match(response.headers['Cache-Control'], /private.*no-store/)
  assert.equal(response.headers.Vary, 'Cookie')
}

for (const status of [401, 403]) test(`details PATCH denies ${status} before client or RPC access`, async () => {
  const context = setup({ authorization: { ok: false, status, error: 'denied' } })
  const response = await context.patch()
  assert.equal(response.status, status)
  assert.deepEqual(context.calls, [['authorize']])
  noCache(response)
})

test('valid details invoke only the designated RPC with normalized arguments', async () => {
  const context = setup()
  const response = await context.patch()
  assert.equal(response.status, 200)
  const rpc = context.calls.find(call => call[0] === 'rpc')
  assert.equal(rpc[1], 'admin_update_registration_details')
  assert.deepEqual(JSON.parse(JSON.stringify(rpc[2])), { p_registration_id: 7, p_name: 'テスト参加者', p_contact: 'test@example.invalid', p_notes: '備考' })
  assert.equal(context.calls.filter(call => call[0] === 'rpc').length, 1)
  assert.equal(response.body.success, true)
  assert.deepEqual(Object.keys(response.body), ['success'])
  noCache(response)
})

test('Unicode length boundaries and empty or null notes are accepted', async () => {
  for (const notes of [null, '', ' ', 'あ'.repeat(2000)]) {
    const context = setup()
    const response = await context.patch({ name: '😀'.repeat(100), contact: 'あ'.repeat(254), notes })
    assert.equal(response.status, 200)
    const payload = context.calls.find(call => call[0] === 'rpc')[2]
    assert.equal(payload.p_notes, notes?.trim() || null)
  }
})

test('invalid fields, lengths and out-of-scope changes never call RPC', async () => {
  for (const body of [null, [], {}, { ...valid, name: ' ' }, { ...valid, name: 'あ'.repeat(101) }, { ...valid, name: 1 }, { ...valid, contact: '' }, { ...valid, contact: 'あ'.repeat(255) }, { ...valid, contact: null }, { ...valid, notes: 'あ'.repeat(2001) }, { ...valid, notes: 1 }, { name: '人', contact: '連絡先' }, { ...valid, schedule_ids: [1] }, { ...valid, event_group_id: 1 }, { ...valid, status: 'cancelled' }]) {
    const context = setup()
    const response = await context.patch(body)
    assert.equal(response.status, 400)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
})

test('invalid IDs, malformed JSON, wrong content type and foreign origins are rejected', async () => {
  for (const [body, options, status] of [
    [valid, { id: '0' }, 400], [valid, { id: '9007199254740992' }, 400],
    ['{', { raw: true }, 400], [valid, { headers: { 'Content-Type': 'text/plain' } }, 415],
    [valid, { headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' } }, 403],
  ]) {
    const context = setup()
    const response = await context.patch(body, options)
    assert.equal(response.status, status)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
})

test('RPC failures map to safe errors without applicant or internal details', async () => {
  for (const [rpcError, status] of [
    [{ code: '42501', message: 'sensitive detail' }, 403],
    [{ code: '22023', message: 'registration does not exist' }, 404],
    [{ code: '22023', message: 'sensitive detail' }, 400],
    [{ code: '23514', message: 'sensitive detail' }, 400],
    [{ code: '40001', message: 'sensitive detail' }, 409],
    [{ code: '40P01', message: 'sensitive detail' }, 409],
    [{ code: 'unknown', message: 'sensitive detail' }, 500],
  ]) {
    const response = await setup({ rpcError }).patch()
    assert.equal(response.status, status)
    assert.equal('success' in response.body, false)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive|test@example/)
    noCache(response)
  }
  const thrown = await setup({ throws: true }).patch()
  assert.equal(thrown.status, 500)
  assert.doesNotMatch(JSON.stringify(thrown.body), /sensitive/)
  noCache(thrown)
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
    useRef(initial) { const slot = refIndex++; return refs[slot] ??= { current: initial } },
    useEffect() {},
  } }
}
function form({ ok = true, success = true, throws = false, notes = '保存済み備考' } = {}) {
  const harness = hooks(), calls = []
  const { default: Component } = compile('app/(app)/admin/registrations/registration-details-form.tsx', {
    react: harness.react, 'react/jsx-runtime': jsxRuntime, '@/lib/registrations/details': validation,
  }, { fetch: async (url, options) => {
    calls.push(['patch', url, options])
    if (throws) throw new Error('sensitive detail')
    return { ok, status: ok ? 200 : 500, json: async () => ({ success }) }
  } })
  const render = () => { harness.reset(); return elements(Component({ registration: { id: 7, name: '保存済み氏名', contact: '保存済み連絡先', notes }, onSaved: () => calls.push(['saved']), onCancel: () => calls.push(['cancel']) })) }
  return { calls, render, save: () => render().find(item => item.type === 'form').props.onSubmit({ preventDefault() {} }) }
}

test('form initializes stored details and sends only name, contact and notes', async () => {
  const context = form()
  let tree = context.render()
  assert.equal(tree.find(item => item.props?.id === 'registration-edit-notes').props.value, '保存済み備考')
  tree.find(item => item.props?.id === 'registration-edit-name').props.onChange({ target: { value: '変更氏名' } })
  await context.save()
  const patch = context.calls.find(call => call[0] === 'patch')
  assert.equal(patch[1], '/api/admin/registrations/7')
  assert.equal(patch[2].method, 'PATCH')
  assert.equal(patch[2].cache, 'no-store')
  assert.deepEqual(JSON.parse(patch[2].body), { name: '変更氏名', contact: '保存済み連絡先', notes: '保存済み備考' })
  assert.equal(context.calls.some(call => call[0] === 'saved'), true)
})

test('form failures keep entered values and never notify success', async () => {
  for (const options of [{ ok: false }, { success: false }, { throws: true }]) {
    const context = form(options)
    context.render().find(item => item.props?.id === 'registration-edit-name').props.onChange({ target: { value: '保持する氏名' } })
    await context.save()
    const tree = context.render()
    assert.equal(tree.find(item => item.props?.id === 'registration-edit-name').props.value, '保持する氏名')
    assert.ok(tree.some(item => item.props?.role === 'alert'))
    assert.equal(context.calls.some(call => call[0] === 'saved'), false)
  }
})

test('invalid form input and cancellation do not send requests; remount starts from saved values', async () => {
  const context = form({ notes: null })
  let tree = context.render()
  assert.equal(tree.find(item => item.props?.id === 'registration-edit-notes').props.value, '')
  tree.find(item => item.props?.id === 'registration-edit-name').props.onChange({ target: { value: ' ' } })
  await context.save()
  assert.equal(context.calls.some(call => call[0] === 'patch'), false)
  tree = context.render()
  tree.find(item => item.props?.type === 'button').props.onClick()
  assert.deepEqual(context.calls, [['cancel']])
  assert.equal(form().render().find(item => item.props?.id === 'registration-edit-name').props.value, '保存済み氏名')
})

test('duplicate submissions call PATCH only once', async () => {
  const context = form()
  await Promise.all([context.save(), context.save()])
  assert.equal(context.calls.filter(call => call[0] === 'patch').length, 1)
  assert.equal(context.calls.filter(call => call[0] === 'saved').length, 1)
})

test('list refresh is triggered only by saved callback, not cancel', () => {
  const harness = hooks()
  const Form = () => null
  const { default: List } = compile('app/(app)/admin/registrations/registration-list.tsx', {
    react: harness.react, 'react/jsx-runtime': jsxRuntime, 'next/link': { default: () => null }, './registration-details-form': { default: Form }, './cancel-registration-item': { default: () => null }, './add-registration-items': { default: () => null }, './proxy-registration-form': { default: () => null },
  })
  const registration = { id: 7, name: '人', contact: '連絡先', notes: '備考', created_at: '2026-10-17T00:00:00Z', event_groups: { title: '講習会' }, registration_items: [] }
  const render = () => { harness.reset(); return elements(List()) }
  render()
  harness.state[2] = { registrations: [registration], total: 1, page: 1, pageSize: 50 }
  harness.state[4] = false
  let tree = render()
  tree.find(item => item.type === 'button' && item.props.children === '情報を編集').props.onClick()
  tree = render()
  assert.equal(tree.find(item => item.type === Form).props.registration.notes, '備考')
  tree.find(item => item.type === Form).props.onCancel()
  assert.equal(harness.state[1], 0)
  assert.equal(render().some(item => item.type === Form), false)
  tree = render()
  tree.find(item => item.type === 'button' && item.props.children === '情報を編集').props.onClick()
  render().find(item => item.type === Form).props.onSaved()
  assert.equal(harness.state[1], 1)
  assert.equal(render().some(item => item.type === Form), false)
})
