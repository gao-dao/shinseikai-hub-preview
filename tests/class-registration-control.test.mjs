import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
function compile(file, deps, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, URL, ...globals, require(name) { assert.ok(name in deps, name); return deps[name] } })
  return exports
}
const routeFile = 'app/api/admin/event-groups/[id]/classes/[classId]/registration/route.ts'
function api({ auth = { ok: true }, row = { id: 2, event_group_id: 7, registration_enabled: true }, changed, readError, updateError, throws = false } = {}) {
  const calls = []; let state = row && { ...row }, payload
  const code = compile(routeFile, {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/supabase/require-admin': { requireAdmin: async () => { calls.push('auth'); return auth } },
    '@/lib/supabase/server': { createClient: async () => { calls.push('client'); if (throws) throw Error('PRIVATE'); return { from(table) {
      assert.equal(table, 'schedules'); const filters = []; let updating = false
      const q = { select() { return q }, eq(k, v) { filters.push([k, v]); return q }, update(p) { payload = p; updating = true; calls.push(['update', p]); return q }, async maybeSingle() {
        if (updating) {
          calls.push(['filters', filters]); if (updateError) return { error: updateError }
          if (!state || !filters.every(([k, v]) => state[k] === v)) return { data: null }
          state = { ...state, ...payload }; return { data: state }
        }
        const snapshot = state && filters.every(([k, v]) => state[k] === v) ? { ...state } : null
        if (changed) state = changed === 'deleted' ? null : { ...state, ...changed }
        return { data: snapshot, error: readError }
      } }; return q
    } } } },
  })
  return { calls, state: () => state, send: (body = { registration_enabled: false, expected_registration_enabled: true }, { id = '7', classId = '2', origin = 'http://localhost', type = 'application/json', raw } = {}) => code.PATCH(new Request('http://localhost/api/test', { method: 'PATCH', headers: { Origin: origin, 'Content-Type': type }, body: raw ?? JSON.stringify(body) }), { params: Promise.resolve({ id, classId }) }) }
}
for (const status of [401, 403]) test(`class PATCH refuses ${status} before data access`, async () => {
  const c = api({ auth: { ok: false, status, error: 'denied' } }), r = await c.send()
  assert.equal(r.status, status); assert.deepEqual(c.calls, ['auth']); assert.match(r.headers['Cache-Control'], /private.*no-store/)
})
for (const enabled of [true, false]) test(`class PATCH changes only reception from ${enabled}`, async () => {
  const c = api({ row: { id: 2, event_group_id: 7, registration_enabled: enabled, capacity: 10, title: 'Keep' } })
  const r = await c.send({ registration_enabled: !enabled, expected_registration_enabled: enabled })
  assert.equal(r.status, 200); assert.equal(c.state().capacity, 10); assert.equal(c.state().title, 'Keep')
  assert.deepEqual(Object.keys(c.calls.find(x => x[0] === 'update')[1]), ['registration_enabled'])
  assert.deepEqual(c.calls.find(x => x[0] === 'filters')[1], [['id', 2], ['event_group_id', 7], ['registration_enabled', enabled]])
  assert.equal(r.headers.Vary, 'Cookie')
})
for (const [name, options, status] of [
  ['mismatched membership', { row: { id: 2, event_group_id: 8, registration_enabled: true } }, 404],
  ['already changed', { row: { id: 2, event_group_id: 7, registration_enabled: false } }, 409],
  ['concurrent membership change', { changed: { event_group_id: 8 } }, 409],
  ['concurrent flag change', { changed: { registration_enabled: false } }, 409],
  ['concurrent deletion', { changed: 'deleted' }, 409],
  ['read error', { readError: { code: 'PRIVATE' } }, 500],
  ['constraint error', { updateError: { code: '23514' } }, 409],
  ['deadlock', { updateError: { code: '40P01' } }, 409],
  ['unexpected network failure', { throws: true }, 500],
]) test(name, async () => { const r = await api(options).send(); assert.equal(r.status, status); assert.doesNotMatch(JSON.stringify(r.body), /PRIVATE/) })
for (const body of [{}, null, [], { registration_enabled: false }, { registration_enabled: false, expected_registration_enabled: 'true' }, { registration_enabled: true, expected_registration_enabled: true }, { registration_enabled: false, expected_registration_enabled: true, capacity: 100 }]) test(`invalid mutation body ${JSON.stringify(body)}`, async () => {
  const c = api(); assert.equal((await c.send(body)).status, 400); assert.ok(!c.calls.includes('client'))
})
for (const options of [{ id: '0' }, { classId: '1e3' }, { id: '9007199254740992' }, { origin: 'https://evil.invalid' }, { type: 'text/plain' }, { raw: '{' }]) test(`invalid request ${JSON.stringify(options)}`, async () => {
  const c = api(); assert.ok((await c.send(undefined, options)).status >= 400); assert.ok(!c.calls.includes('client'))
})
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [] }
function text(tree) { return Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null ? '' : String(tree) }
function screen({ showControls = true, parentOpen = true, enabled = true, mutate = 'ok', readFails = false, capacity = 5, registeredCount = 5 } = {}) {
  let slot = 0, current = { id: 2, title: 'クラスA', date: '2030-01-01', capacity, registeredCount, registration_enabled: enabled }, readsFail = readFails, pending, deferred
  const slots = [], calls = [], effects = []
  const react = { useState(v) { const i = slot++; if (!(i in slots)) slots[i] = v; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] }, useRef(v) { const i = slot++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] }, useEffect(fn) { slot++; if (!effects.length) effects.push(fn) } }
  const jsx = (type, props) => ({ type, props })
  const Component = compile('app/(app)/admin/event-groups/class-registration-control.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@/lib/event-groups/detail': { loadDetailClasses: async () => { calls.push('read'); if (readsFail) throw Error('read'); return [{ ...current, registration_enabled: enabled ? false : true, registeredCount: 4 }] } },
  }, { AbortController, fetch: async (_url, options) => {
    calls.push(['patch', JSON.parse(options.body)]); if (mutate === 'wait') await new Promise(resolve => { deferred = resolve })
    if (mutate === 'throw') throw Error('lost response')
    return { ok: mutate !== 'conflict', json: async () => mutate === 'conflict' ? { error: '競合' } : { schedule: { id: 2, event_group_id: 7, registration_enabled: !enabled } } }
  } }).default
  const render = () => { slot = 0; return Component({ groupId: 7, row: current, parentOpen, showControls, onRefreshed: row => { current = row } }) }
  const buttons = () => nodes(render()).filter(n => n.type === 'button')
  return { calls, render, buttons, text: () => text(render()), click(i = 0) { buttons()[i].props.onClick(); pending = new Promise(r => setImmediate(r)); return pending }, unblock() { deferred?.() }, allowRead() { readsFail = false } }
}
test('parent OFF, full class retains numbers and explicit parent warning', () => {
  const c = screen({ parentOpen: false }); assert.match(c.text(), /開催回全体が受付停止中/); assert.match(c.text(), /5件/); assert.match(c.text(), /残席0名/); assert.match(c.text(), /受付を停止/)
})
for (const enabled of [true, false]) test(`control refreshes after switching ${enabled}`, async () => {
  const c = screen({ enabled }); await c.click(); assert.equal(c.calls.filter(x => Array.isArray(x)).length, 1); assert.equal(c.calls[1], 'read'); assert.match(c.text(), /4件/); assert.match(c.text(), /残席1名/); assert.equal(c.buttons()[0].props.disabled, false)
})
test('lost PATCH response triggers read, not repeated mutation', async () => {
  const c = screen({ mutate: 'throw' }); await c.click(); assert.deepEqual(c.calls.map(x => Array.isArray(x) ? x[0] : x), ['patch', 'read']); assert.match(c.text(), /最新状態を再取得しました/)
})
test('conflict refetches and preserves notice', async () => { const c = screen({ mutate: 'conflict' }); await c.click(); assert.match(c.text(), /競合/); assert.match(c.text(), /4件/) })
test('failed refresh blocks mutation until successful read-only recheck', async () => {
  const c = screen({ readFails: true }); await c.click(); assert.equal(c.buttons()[0].props.disabled, true); assert.match(c.text(), /古い可能性/)
  await c.click(); assert.equal(c.calls.filter(Array.isArray).length, 1)
  c.allowRead(); await c.click(1); assert.equal(c.calls.filter(Array.isArray).length, 1); assert.equal(c.buttons()[0].props.disabled, false)
})
test('in-flight control blocks repeated clicks without disabling another instance', async () => {
  const a = screen({ mutate: 'wait' }), b = screen(); const first = a.click(); a.buttons()[0].props.onClick()
  assert.equal(a.buttons()[0].props.disabled, true); assert.equal(b.buttons()[0].props.disabled, false); assert.equal(a.calls.length, 1)
  a.unblock(); await first; assert.equal(a.buttons()[0].props.disabled, false)
})
test('existing API counts active items only and existing layout supports small screens', () => {
  const route = fs.readFileSync('app/api/admin/event-groups/[id]/classes/route.ts', 'utf8')
  assert.match(route, /eq\('active_items.status', 'active'\)/)
  const css = fs.readFileSync('app/(app)/admin/event-groups/occurrence-detail.tsx', 'utf8')
  assert.match(css, /minmax\(min\(100%,280px\)/); assert.match(css, /min-height:44px/); assert.match(css, /:focus-visible/)
})

test('single class display-only mode retains all statistics without mutation controls', () => {
  const c = screen({ showControls: false }); assert.equal(c.buttons().length, 0); assert.match(c.text(), /5件/); assert.match(c.text(), /定員5名/); assert.match(c.text(), /残席0名/); assert.match(c.text(), /受付中/); assert.equal(c.calls.length, 0)
})
