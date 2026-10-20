import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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
const availability = compile('lib/registrations/public-availability.ts')
function schedule(id = 1, changes = {}) { return { id, title: `クラス${id}`, date: '2026-10-20', start_time: '10:00', end_time: '11:00', capacity: 10, registration_enabled: true, event_group_id: 1, ...changes } }
function seats(schedule_id = 1, changes = {}) { return { schedule_id, capacity: 10, registered_count: 2, remaining_capacity: 8, is_full: false, ...changes } }

// Only a mock anonymous client is exposed. No env files, real network or DB.
function setup({ groups = [{ id: 1, title: '講習会', description: '説明', registration_open: true }], schedules = [schedule()], counts = [seats()], groupError = null, classError = null, rpcError = null, rpcThrows = false, missingCount = false } = {}) {
  const calls = []
  const dependencies = {
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/registrations/public-availability': availability,
    '@/lib/supabase/anonymous': { createAnonymousClient: () => {
      calls.push(['anonymous'])
      return {
        from: table => {
          assert.ok(['event_groups', 'schedules'].includes(table), 'Applicant tables must never be queried')
          calls.push(['from', table])
          const filters = []
          let range
          const query = {}
          const result = () => {
            const rows = (table === 'event_groups' ? groups : schedules).filter(row => filters.every(([key, value]) => row[key] === value))
            return { data: range ? rows.slice(range[0], range[1] + 1) : rows, error: table === 'event_groups' ? groupError : classError, count: missingCount ? null : rows.length }
          }
          for (const method of ['select', 'eq', 'order', 'range', 'maybeSingle']) query[method] = (...args) => {
            calls.push([method, ...args])
            if (method === 'eq') filters.push(args)
            if (method === 'range') range = args
            if (method === 'maybeSingle') { const response = result(); return Promise.resolve({ ...response, data: response.data[0] ?? null }) }
            return query
          }
          query.then = (resolve, reject) => Promise.resolve(result()).then(resolve, reject)
          return query
        },
        rpc: (name, params) => {
          assert.equal(name, 'get_event_group_availability')
          calls.push(['rpc', name, params])
          return { in: async (key, ids) => {
            calls.push(['rpc-filter', key, ids])
            if (rpcThrows) throw new Error('sensitive detail')
            return { data: counts.filter(item => ids.includes(item.schedule_id)), error: rpcError }
          } }
        },
      }
    } },
  }
  const list = compile('app/api/event-groups/route.ts', dependencies)
  const classes = compile('app/api/event-groups/[id]/classes/route.ts', dependencies)
  return { calls,
    list: (page = '1') => list.GET(new Request(`http://localhost/api/event-groups?page=${page}`)),
    classes: (page = '1', id = '1') => classes.GET(new Request(`http://localhost/api/event-groups/${id}/classes?page=${page}`), { params: Promise.resolve({ id }) }),
  }
}
function noCache(response) { assert.match(response.headers['Cache-Control'], /no-store/) }

test('anonymous client uses only publishable configuration, no persisted session, and uncached fetch', async () => {
  let argumentsUsed, fetchOptions
  const { createAnonymousClient } = compile('lib/supabase/anonymous.ts', {
    'server-only': {}, '@supabase/supabase-js': { createClient: (...args) => { argumentsUsed = args; return {} } },
  }, {
    process: { env: new Proxy({}, { get: (_, key) => {
      assert.ok(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'].includes(key))
      return key === 'NEXT_PUBLIC_SUPABASE_URL' ? 'http://localhost:54321' : 'test-publishable'
    } }) },
    fetch: async (_input, options) => { fetchOptions = options; return {} },
  })
  createAnonymousClient()
  assert.equal(argumentsUsed[1], 'test-publishable')
  assert.equal(argumentsUsed[2].auth.persistSession, false)
  assert.equal(argumentsUsed[2].auth.autoRefreshToken, false)
  assert.equal(argumentsUsed[2].auth.detectSessionInUrl, false)
  assert.equal(argumentsUsed[2].global.headers, undefined)
  await argumentsUsed[2].global.fetch('http://localhost', { cache: 'force-cache' })
  assert.equal(fetchOptions.cache, 'no-store')
})

test('public list excludes stopped groups and whitelists metadata only', async () => {
  const context = setup({ groups: [
    { id: 1, title: '公開', description: '説明', registration_open: true, name: 'private', contact: 'private', notes: 'private' },
    { id: 2, title: '停止', description: null, registration_open: false },
  ] })
  const response = await context.list()
  assert.equal(response.status, 200)
  assert.equal(response.body.total, 1)
  assert.equal(response.body.eventGroups[0].title, '公開')
  assert.equal(response.body.eventGroups.length, 1)
  assert.doesNotMatch(JSON.stringify(response.body), /private|contact|notes|registration_items/)
  assert.deepEqual(context.calls.find(call => call[0] === 'select').slice(0, 2), ['select', 'id, title, description'])
  noCache(response)
})

test('group pagination includes records beyond fifty and supports empty results', async () => {
  const groups = Array.from({ length: 53 }, (_, i) => ({ id: i + 1, title: `講習会${i + 1}`, description: null, registration_open: true }))
  const context = setup({ groups })
  const first = await context.list('1'), second = await context.list('2')
  assert.equal(first.body.eventGroups.length, 50)
  assert.equal(second.body.eventGroups.length, 3)
  assert.equal(second.body.eventGroups[0].id, 51)
  assert.equal(second.body.total, 53)
  assert.equal((await setup({ groups: [] }).list()).body.total, 0)
})

test('stopped and nonexistent groups cannot expose classes or invoke availability RPC', async () => {
  for (const groups of [[], [{ id: 1, registration_open: false }]]) {
    const context = setup({ groups })
    const response = await context.classes()
    assert.equal(response.status, 404)
    assert.equal(context.calls.some(call => call[0] === 'rpc'), false)
    assert.equal(context.calls.some(call => call[0] === 'from' && call[1] === 'schedules'), false)
    noCache(response)
  }
})

test('class metadata and safe RPC provide seats without applicant reads or extra row fields', async () => {
  const context = setup({ schedules: [schedule(1, { name: 'private', notes: 'private', contact: 'private' }), schedule(2, { event_group_id: 2 })] })
  const response = await context.classes()
  assert.equal(response.status, 200)
  assert.equal(response.body.schedules.length, 1)
  const item = response.body.schedules[0]
  assert.equal(item.remainingCapacity, 8)
  assert.equal(item.capacity, 10)
  assert.equal(item.canRegister, true)
  assert.equal(item.status, '受付可能')
  assert.doesNotMatch(JSON.stringify(response.body), /private|contact|notes|registration_items/)
  assert.equal(context.calls.filter(call => call[0] === 'rpc').length, 1)
  assert.equal(context.calls.find(call => call[0] === 'rpc')[2].p_event_group_id, 1)
  assert.deepEqual(context.calls.find(call => call[0] === 'rpc-filter').slice(0, 2), ['rpc-filter', 'schedule_id'])
  noCache(response)
})

test('class pages and RPC filters handle groups exceeding fifty and default RPC row limits', async () => {
  const context = setup({ schedules: Array.from({ length: 1005 }, (_, i) => schedule(i + 1)), counts: Array.from({ length: 1005 }, (_, i) => seats(i + 1)) })
  const response = await context.classes('21')
  assert.equal(response.body.total, 1005)
  assert.equal(response.body.schedules.length, 5)
  assert.equal(response.body.schedules[0].id, 1001)
  assert.ok(response.body.schedules.every(item => item.remainingCapacity === 8))
  assert.equal(context.calls.find(call => call[0] === 'rpc-filter')[2].length, 5)
  const empty = setup({ schedules: [] })
  assert.equal((await empty.classes()).body.schedules.length, 0)
  assert.equal(empty.calls.some(call => call[0] === 'rpc'), false)
})

test('disabled classes, no capacity and full classes never indicate acceptance', async () => {
  const context = setup({ schedules: [schedule(1, { registration_enabled: false }), schedule(2, { capacity: null }), schedule(3)], counts: [seats(1), seats(3, { registered_count: 10, remaining_capacity: 0, is_full: true })] })
  const response = await context.classes()
  assert.deepEqual(Array.from(response.body.schedules, item => item.status), ['クラス受付停止中', '定員未設定', '満員'])
  assert.ok(response.body.schedules.every(item => !item.canRegister))
})

test('availability errors, exceptions, missing or inconsistent counts fail closed', async () => {
  for (const options of [{ rpcError: { message: 'sensitive detail' } }, { rpcThrows: true }, { counts: [] }, { counts: [seats(1, { remaining_capacity: 9 })] }, { counts: [seats(1, { registered_count: null })] }, { counts: [seats(1, { capacity: 20 })] }, { counts: [seats(), seats()] }]) {
    const response = await setup(options).classes()
    assert.equal(response.status, 200)
    assert.equal(response.body.schedules[0].canRegister, false)
    assert.equal(response.body.schedules[0].remainingCapacity, null)
    assert.equal(response.body.schedules[0].status, '残席確認不可')
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    noCache(response)
  }
})

test('invalid query parameters are rejected before creating any client', async () => {
  for (const value of ['0', '-1', 'abc', '1.2', '', '1000001']) {
    const context = setup()
    assert.equal((await context.list(value)).status, 400)
    assert.equal((await context.classes(value)).status, 400)
    assert.equal(context.calls.length, 0)
  }
  const context = setup()
  assert.equal((await context.classes('1', '9007199254740992')).status, 400)
  assert.equal(context.calls.length, 0)
})

test('database errors and missing totals return safe uncached failures', async () => {
  for (const options of [{ groupError: { message: 'sensitive detail' } }, { missingCount: true }]) {
    for (const method of ['list', 'classes']) {
      const response = await setup(options)[method]()
      assert.equal(response.status, 500)
      assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
      noCache(response)
    }
  }
  const response = await setup({ classError: { message: 'sensitive detail' } }).classes()
  assert.equal(response.status, 500)
  assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
})

test('no date deadline or class type restrictions are introduced', async () => {
  const context = setup({ schedules: [schedule(1, { date: '2000-01-01', type: '稽古会' })] })
  const response = await context.classes()
  assert.equal(response.body.schedules[0].canRegister, true)
  assert.equal(response.body.schedules[0].date, '2000-01-01')
  assert.ok(context.calls.filter(call => call[0] === 'eq').every(call => !['date', 'type'].includes(call[1])))
})

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.props?.children)]
}
function ui() {
  const state = [], effects = [], calls = []
  let index = 0
  const react = { useState(initial) {
    const slot = index++
    if (!(slot in state)) state[slot] = initial
    return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
  }, useEffect(fn) { effects.push(fn) } }
  let response = { ok: true, json: async () => ({ eventGroups: [], page: 1, pageSize: 50, total: 0 }) }
  const exports = compile('app/(public)/events/events-list.tsx', { react, 'react/jsx-runtime': jsxRuntime, 'next/link': { default: () => null }, './registration-form': { default: () => null } }, {
    AbortController, fetch: async (...args) => { calls.push(args); return response },
  })
  const render = (Component = exports.default, props = {}) => { index = 0; effects.length = 0; return elements(Component(props)) }
  return { state, effects, calls, exports, render, setResponse(value) { response = value } }
}

test('events page has no authentication dependency and opts out of static caching', () => {
  const Client = () => null
  const page = compile('app/(public)/events/page.tsx', { 'react/jsx-runtime': jsxRuntime, './events-list': { default: Client } })
  assert.equal(page.dynamic, 'force-dynamic')
  assert.equal(page.revalidate, 0)
  assert.equal(page.default().type, Client)
})

test('public UI renders metadata, seats, unknown states and no registration form', () => {
  const { exports } = ui()
  const item = availability.publicClassAvailability(schedule(), seats())
  const html = renderToStaticMarkup(React.createElement(exports.PublicClassCard, { item }))
  assert.match(html, /クラス1/)
  assert.match(html, /2026-10-20/)
  assert.match(html, /定員：10名/)
  assert.match(html, /残席：8名/)
  assert.match(html, /受付可能/)
  assert.doesNotMatch(html, /<form|type="submit"/)
  const unknown = renderToStaticMarkup(React.createElement(exports.PublicClassCard, { item: availability.publicClassAvailability(schedule()) }))
  assert.match(unknown, /残席確認不可/)
  assert.doesNotMatch(unknown, /受付可能/)
})

test('group and class pagination controls advance to records beyond fifty', () => {
  const groups = ui()
  groups.render()
  groups.state[2] = { eventGroups: [{ id: 1, title: '講習会', description: null }], page: 1, pageSize: 50, total: 51 }
  groups.state[3] = false
  const next = groups.render().find(item => item.type === 'button' && item.props.children === '次の講習会')
  assert.equal(next.props.disabled, false)
  next.props.onClick()
  assert.equal(groups.state[0], 2)
  const classes = ui()
  classes.render(classes.exports.EventClasses, { groupId: 1 })
  classes.state[2] = { schedules: [], page: 1, pageSize: 50, total: 51 }
  classes.state[3] = false
  classes.render(classes.exports.EventClasses, { groupId: 1 }).find(item => item.type === 'button' && item.props.children === '次のクラス').props.onClick()
  assert.equal(classes.state[0], 2)
})

test('browser reads omit credentials, disable caching and expose safe read-error states', async () => {
  for (const component of ['groups', 'classes']) {
    const context = ui()
    context.setResponse({ ok: false, status: 500 })
    const render = () => context.render(component === 'groups' ? context.exports.default : context.exports.EventClasses, { groupId: 1 })
    render()
    const cleanup = context.effects[0]()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(context.calls.length, 1)
    assert.equal(context.calls[0][1].credentials, 'omit')
    assert.equal(context.calls[0][1].cache, 'no-store')
    assert.equal(context.calls[0][1].method, undefined)
    assert.ok(render().some(item => item.props?.role === 'alert'))
    assert.equal(context.state[2], null)
    cleanup()
  }
})

test('events opens the chosen public group form and prevents switching groups while it is open',()=>{
  const context=ui()
  context.render()
  context.state[2]={eventGroups:[{id:5,title:'講習会5',description:null},{id:6,title:'講習会6',description:null}],page:1,pageSize:50,total:2}
  context.state[3]=false
  context.render().find(item=>item.type==='button'&&item.props.children==='この講習会に申し込む').props.onClick()
  const tree=context.render()
  const form=tree.find(item=>item.props?.group?.id===5)
  assert.ok(form)
  assert.equal(form.props.group.title,'講習会5')
  assert.ok(tree.filter(item=>item.type==='button'&&item.props.children==='この講習会に申し込む').every(item=>item.props.disabled))
  form.props.onClose()
  assert.equal(context.render().some(item=>item.props?.group),false)
})
