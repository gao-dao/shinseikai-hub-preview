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
const validation = compile('lib/registrations/proxy-registration.ts', { './details': compile('lib/registrations/details.ts') })
const availability = compile('lib/registrations/class-availability.ts')
const valid = { event_group_id: 5, name: ' 参加者 ', contact: ' 電話連絡先 ', notes: ' 備考 ', schedule_ids: [11, 12] }
function row(id = 11, changes = {}) { return { id, title: `クラス${id}`, date: '2026-10-20', start_time: '10:00', end_time: '11:00', location: '合成会場', event_group_id: 5, capacity: 10, registration_enabled: true, active_items: [{ count: 2 }], ...changes } }

// Isolated mock clients: real Supabase modules and env files are never loaded.
function setup({ authorization = { ok: true }, group = { id: 5, registration_open: false }, groupError = null, rows = [row(), row(12)], classError = null, total, rpcError = null, throws = false } = {}) {
  const calls = []
  const dependencies = {
    '@/lib/registrations/proxy-registration': validation, '@/lib/registrations/class-availability': availability,
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
            if (method === 'maybeSingle') return Promise.resolve({ data: group, error: groupError })
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
  }
  const registration = compile('app/api/admin/registrations/route.ts', dependencies)
  const classes = compile('app/api/admin/event-groups/[id]/classes/route.ts', dependencies)
  return { calls,
    get: (page = '1', id = '5') => classes.GET(new Request(`http://localhost/api/admin/event-groups/${id}/classes?page=${page}`), { params: Promise.resolve({ id }) }),
    post: (body = valid, { headers = { 'Content-Type': 'application/json', Origin: 'http://localhost' }, raw = false } = {}) => registration.POST(new Request('http://localhost/api/admin/registrations', { method: 'POST', headers, body: raw ? body : JSON.stringify(body) })),
  }
}
function noRpc(context) { assert.equal(context.calls.some(call => call[0] === 'rpc'), false) }
function noCache(response) { assert.match(response.headers['Cache-Control'], /private.*no-store/); assert.equal(response.headers.Vary, 'Cookie') }

for (const status of [401, 403]) for (const method of ['get', 'post']) test(`proxy ${method} denies ${status} before data access`, async () => {
  const context = setup({ authorization: { ok: false, status, error: 'denied' } })
  const response = await context[method]()
  assert.equal(response.status, status)
  assert.deepEqual(context.calls, [['authorize']])
  noCache(response)
})

test('group classes are paginated and scoped; full, disabled and unset-capacity classes are unselectable', async () => {
  const context = setup({ rows: [row(11, { capacity: 2000, active_items: [{ count: 1500 }] }), row(12, { capacity: 2 }), row(13, { registration_enabled: false }), row(14, { capacity: null })] })
  const response = await context.get('2')
  assert.equal(response.status, 200)
  assert.equal(response.body.schedules[0].remainingCapacity, 500)
  assert.equal(response.body.schedules[0].selectable, true)
  for (const candidate of response.body.schedules.slice(1)) assert.equal(candidate.selectable, false)
  assert.deepEqual(context.calls.find(call => call[0] === 'range'), ['range', 50, 99])
  assert.ok(context.calls.some(call => call[0] === 'eq' && call[1] === 'event_group_id' && call[2] === 5))
  assert.ok(context.calls.some(call => call[0] === 'eq' && call[1] === 'active_items.status' && call[2] === 'active'))
  noRpc(context)
  noCache(response)
})

test('proxy creation succeeds while public registration is stopped and calls one RPC for every class', async () => {
  for (const registration_open of [false, true]) {
    const context = setup({ group: { id: 5, registration_open } })
    const response = await context.post()
    assert.equal(response.status, 201)
    const rpc = context.calls.filter(call => call[0] === 'rpc')
    assert.equal(rpc.length, 1)
    assert.equal(rpc[0][1], 'admin_create_registration')
    assert.deepEqual(JSON.parse(JSON.stringify(rpc[0][2])), { p_event_group_id: 5, p_name: '参加者', p_contact: '電話連絡先', p_notes: '備考', p_schedule_ids: [11, 12] })
    assert.deepEqual(Object.keys(response.body), ['success'])
    assert.equal(response.body.success, true)
    assert.ok(context.calls.filter(call => call[0] === 'from').every(call => ['schedules', 'event_groups'].includes(call[1])))
    assert.ok(context.calls.filter(call => call[0] === 'select').every(call => !call[1].includes('registration_open')))
    noCache(response)
  }
})

test('invalid input, duplicate classes and forbidden fields are rejected before any client access', async () => {
  for (const body of [null, [], {}, { ...valid, event_group_id: '5' }, { ...valid, event_group_id: 0 }, { ...valid, name: ' ' }, { ...valid, name: 'あ'.repeat(101) }, { ...valid, contact: '' }, { ...valid, contact: 'あ'.repeat(255) }, { ...valid, notes: 'あ'.repeat(2001) }, { ...valid, notes: 1 }, { ...valid, schedule_ids: [] }, { ...valid, schedule_ids: [11, 11] }, { ...valid, schedule_ids: [null] }, { ...valid, schedule_ids: [1.5] }, { ...valid, schedule_ids: ['11'] }, { ...valid, schedule_ids: [9007199254740992] }, { ...valid, schedule_ids: Array.from({ length: 51 }, (_, i) => i + 1) }, { ...valid, registration_open: true }]) {
    const context = setup()
    const response = await context.post(body)
    assert.equal(response.status, 400)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
  const boundary = validation.validateProxyRegistration({ ...valid, name: '😀'.repeat(100), contact: 'あ'.repeat(254), notes: 'あ'.repeat(2000) })
  assert.ok(boundary.data)
  assert.equal(validation.validateProxyRegistration({ ...valid, notes: '' }).data.notes, null)
})

test('Origin, content type, malformed JSON, group IDs and page parameters are checked', async () => {
  for (const [body, options, status] of [['{', { raw: true }, 400], [valid, { headers: { 'Content-Type': 'text/plain' } }, 415], [valid, { headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' } }, 403]]) {
    const context = setup()
    const response = await context.post(body, options)
    assert.equal(response.status, status)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  }
  assert.equal((await setup().get('0')).status, 400)
  assert.equal((await setup().get('1', '0')).status, 400)
})

test('other groups and nonexistent classes are rejected without calling RPC', async () => {
  for (const rows of [[row(11, { event_group_id: 6 }), row(12)], [row(11)]]) {
    const context = setup({ rows })
    assert.equal((await context.post()).status, 400)
    noRpc(context)
  }
})

test('full, disabled and unset-capacity classes are rejected before RPC', async () => {
  for (const changes of [{ capacity: 2 }, { registration_enabled: false }, { capacity: null }]) {
    const context = setup({ rows: [row(11, changes), row(12)] })
    assert.equal((await context.post()).status, 409)
    noRpc(context)
  }
})

test('missing groups, DB read errors and missing counts fail closed', async () => {
  for (const [options, status] of [[{ group: null }, 404], [{ groupError: { message: 'sensitive detail' } }, 500], [{ classError: { message: 'sensitive detail' } }, 500], [{ total: null }, 500], [{ rows: [row(11, { active_items: [] }), row(12)] }, 500]]) {
    for (const method of ['get', 'post']) {
      const context = setup(options)
      const response = await context[method]()
      assert.equal(response.status, status)
      noRpc(context)
      assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
      noCache(response)
    }
  }
})

test('RPC failures never fall back to individual writes or disclose internal/participant information', async () => {
  for (const [code, status] of [['42501', 403], ['P0001', 409], ['22023', 409], ['23505', 409], ['40001', 409], ['unknown', 500]]) {
    const context = setup({ rpcError: { code, message: 'sensitive detail' } })
    const response = await context.post()
    assert.equal(response.status, status)
    assert.equal('success' in response.body, false)
    assert.equal(context.calls.filter(call => call[0] === 'rpc').length, 1)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive|電話連絡先|参加者/)
    noCache(response)
  }
  const context = setup({ throws: true })
  const response = await context.post()
  assert.equal(response.status, 500)
  assert.match(response.body.error, /一覧を確認/)
  assert.equal(context.calls.filter(call => call[0] === 'rpc').length, 1)
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
const candidate = availability.registrationClassAvailability(row())
function form({ status = 201, success = true, throws = false, confirmed = true } = {}) {
  const harness = hooks(), calls = []
  const exports = compile('app/(app)/admin/registrations/proxy-registration-form.tsx', {
    react: harness.react, 'react/jsx-runtime': jsxRuntime, '@/lib/registrations/proxy-registration': validation, '../new-schedule-fields': { loadAllEventGroups() {} },
  }, {
    fetch: async (url, options) => { calls.push(['post', url, options]); if (throws) throw new Error('sensitive detail'); return { ok: status < 400, status, json: async () => ({ success }) } },
    window: { confirm: message => { calls.push(['confirm', message]); return confirmed } },
  })
  const render = () => { harness.reset(); return elements(exports.default({ onSaved: () => calls.push(['saved']), onCancel: () => calls.push(['cancel']) })) }
  render()
  Object.assign(harness.state, { 0: '参加者A', 1: '連絡先A', 2: '備考A', 3: '5', 4: [candidate, { ...candidate, id: 12, title: '午後' }, { ...candidate, id: 13, selectable: false, remainingCapacity: 0 }], 5: [11, 12], 6: [{ id: 5, title: '講習会A', registration_open: false }], 7: false, 15: '5' })
  return { harness, calls, render, exports, submit: () => render().find(item => item.type === 'form').props.onSubmit({ preventDefault() {} }) }
}

test('form confirms participant, group and multiple classes and posts once', async () => {
  const context = form()
  assert.equal(context.render().filter(item => item.props?.type === 'checkbox')[2].props.disabled, true)
  await Promise.all([context.submit(), context.submit()])
  await context.submit()
  assert.deepEqual(context.calls.map(call => call[0]), ['confirm', 'post', 'saved'])
  for (const label of ['参加者A', '連絡先A', '備考A', '講習会A', 'クラス11', '午後', '再判定']) assert.ok(context.calls[0][1].includes(label))
  const request = context.calls[1]
  assert.equal(request[1], '/api/admin/registrations')
  assert.equal(request[2].cache, 'no-store')
  assert.deepEqual(JSON.parse(request[2].body).schedule_ids, [11, 12])
})

test('empty class selection allows submit but displays a message without confirmation or API; selecting a class then succeeds', async () => {
  const context = form()
  context.harness.state[5] = []
  assert.equal(context.render().find(item => item.props?.type === 'submit').props.disabled, false)
  await context.submit()
  assert.ok(context.render().some(item => item.props?.role === 'alert' && item.props.children === '参加するクラスを1つ以上選択してください'))
  assert.equal(context.calls.length, 0)
  context.render().find(item => item.props?.type === 'checkbox').props.onChange({ target: { checked: true } })
  await context.submit()
  assert.deepEqual(context.calls.map(call => call[0]), ['confirm', 'post', 'saved'])
  assert.deepEqual(JSON.parse(context.calls[1][2].body).schedule_ids, [11])
})

test('empty selection does not bypass loading, fetch-error, saving or uncertain-state guards', async () => {
  for (const [slot, value] of [[7, true], [8, 'groups error'], [9, true], [10, 'classes error'], [16, true]]) {
    const context = form()
    context.harness.state[5] = []
    context.harness.state[slot] = value
    assert.equal(context.render().find(item => item.props?.type === 'submit').props.disabled, true)
    await context.submit()
    assert.equal(context.calls.length, 0)
  }
  const saving = form()
  saving.harness.state[12] = true
  assert.equal(saving.render().find(item => item.type === 'fieldset').props.disabled, true)
})

test('group change clears candidates/selection and cannot submit stale classes', async () => {
  const context = form()
  context.render().find(item => item.props?.id === 'proxy-group').props.onChange({ target: { value: '6' } })
  assert.equal(context.harness.state[5].length, 0)
  assert.equal(context.harness.state[4].length, 0)
  assert.equal(context.harness.state[0], '参加者A')
  await context.submit()
  assert.equal(context.calls.length, 0)
})

test('deterministic registration failures retain all inputs and selection without closing', async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    const context = form({ status })
    await context.submit()
    assert.equal(context.calls.some(call => call[0] === 'saved'), false)
    assert.equal(context.harness.state[0], '参加者A')
    assert.equal(context.harness.state[1], '連絡先A')
    assert.equal(context.harness.state[2], '備考A')
    assert.deepEqual(context.harness.state[5], [11, 12])
    assert.ok(context.render().some(item => item.props?.role === 'alert'))
  }
})

test('uncertain network/server results never auto-retry and require list confirmation', async () => {
  for (const options of [{ throws: true }, { status: 500 }, { success: false }]) {
    const context = form(options)
    await context.submit()
    await context.submit()
    assert.equal(context.calls.filter(call => call[0] === 'post').length, 1)
    assert.equal(context.calls.some(call => call[0] === 'saved'), false)
    const tree = context.render()
    assert.equal(tree.find(item => item.props?.type === 'submit').props.disabled, true)
    assert.ok(tree.some(item => item.props?.role === 'alert' && String(item.props.children).includes('一覧')))
    assert.equal(context.harness.state[0], '参加者A')
  }
})

test('cancelled confirmation and invalid form data send nothing', async () => {
  const context = form({ confirmed: false })
  await context.submit()
  assert.deepEqual(context.calls.map(call => call[0]), ['confirm'])
  const invalid = form()
  invalid.harness.state[0] = ' '
  await invalid.submit()
  assert.equal(invalid.calls.length, 0)
  const failed = form()
  failed.harness.state[10] = 'read error'
  await failed.submit()
  assert.equal(failed.calls.length, 0)
})

test('class loader reads all pages and refuses missing counts or partial choices', async () => {
  const { exports } = form()
  const calls = []
  const classes = await exports.loadProxyClasses(5, async (url, options) => {
    calls.push(url)
    assert.equal(options.cache, 'no-store')
    return { ok: true, json: async () => ({ schedules: [{ ...candidate, id: calls.length }], page: calls.length, pageSize: 1, total: 2 }) }
  }, new AbortController().signal)
  assert.equal(classes.length, 2)
  assert.deepEqual(calls, ['/api/admin/event-groups/5/classes?page=1', '/api/admin/event-groups/5/classes?page=2'])
  for (const response of [{ ok: false }, { ok: true, json: async () => ({ schedules: [{ ...candidate, registeredCount: null }], page: 1, pageSize: 1, total: 1 }) }, { ok: true, json: async () => ({ schedules: [], page: 1, pageSize: 1, total: 2 }) }]) {
    await assert.rejects(exports.loadProxyClasses(5, async () => response, new AbortController().signal))
  }
})

test('proxy success closes the form and reloads page one; cancel does not refresh', () => {
  const harness = hooks(), Form = () => null
  const { default: List } = compile('app/(app)/admin/registrations/registration-list.tsx', {
    react: harness.react, 'react/jsx-runtime': jsxRuntime, 'next/link': { default: () => null }, './proxy-registration-form': { default: Form },
    './registration-details-form': { default: () => null }, './cancel-registration-item': { default: () => null }, './add-registration-items': { default: () => null },
  })
  const render = () => { harness.reset(); return elements(List()) }
  render()
  harness.state[0] = 2
  let tree = render()
  tree.find(item => item.type === 'button' && item.props.children === '代理申込を登録').props.onClick()
  render().find(item => item.type === Form).props.onCancel()
  assert.equal(harness.state[0], 2)
  assert.equal(harness.state[1], 0)
  tree = render()
  tree.find(item => item.type === 'button' && item.props.children === '代理申込を登録').props.onClick()
  render().find(item => item.type === Form).props.onSaved()
  assert.equal(harness.state[0], 1)
  assert.equal(harness.state[1], 1)
  assert.equal(render().some(item => item.type === Form), false)
})


test('class GET includes venue and explicit reception state, preserving active counts', async () => {
  const context = setup({ rows: [row(11, { registration_enabled: false })] })
  const response = await context.get()
  assert.equal(response.status, 200)
  assert.equal(response.body.schedules[0].location, '合成会場')
  assert.equal(response.body.schedules[0].registration_enabled, false)
  assert.equal(response.body.schedules[0].registeredCount, 2)
  assert.ok(context.calls.some(call => call[0] === 'select' && call[1].includes('location')))
  noRpc(context); noCache(response)
})
test('missing class venue fails safely rather than guessing metadata', async () => {
  const context = setup({ rows: [row(11, { location: undefined })] })
  assert.equal((await context.get()).status, 500)
  noRpc(context)
})
