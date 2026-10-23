import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'

function compile(file, deps = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, ...globals, require(name) { assert.ok(Object.hasOwn(deps, name), `Unexpected dependency: ${name}`); return deps[name] } })
  return exports
}
const group = { id: 7, title: '東京講座', city: '東京', start_date: '2026-10-23', end_date: '2026-10-23', registration_open: true, description: null }
const signal = new AbortController().signal
function loaders(responses) {
  const calls = []
  const api = compile('lib/event-groups/admin-overview.ts', {}, { fetch: async (url, options) => {
    calls.push({ url, options }); const response = responses.shift(); assert.ok(response, 'No unexpected read or mutation')
    if (response.throw) throw new Error('PRIVATE')
    return { ok: response.ok ?? true, json: async () => response }
  } })
  return { api, calls }
}
const classes = (page, rows, total = 3) => ({ page, pageSize: 2, total, schedules: rows })
test('class summary reads every page before reporting totals and counts class bookings, not people', async () => {
  const c = loaders([classes(1, [{ id: 1, registeredCount: 2 }, { id: 2, registeredCount: 3 }]), classes(2, [{ id: 3, registeredCount: 1 }])])
  const result = await c.api.loadClassSummary(7, signal)
  assert.equal(result.classCount, 3); assert.equal(result.activeClassBookings, 6)
  assert.equal(c.calls.length, 2)
  assert.ok(c.calls.every(call => call.url.startsWith('/api/admin/event-groups/7/classes?') && call.options.cache === 'no-store' && call.options.signal === signal && call.options.method === undefined))
})
test('zero is only displayed when complete validated API data confirms it', async () => {
  const c = loaders([classes(1, [], 0)])
  const result = await c.api.loadClassSummary(7, signal)
  assert.equal(result.classCount, 0); assert.equal(result.activeClassBookings, 0)
})
for (const bad of [{ ok: false }, classes(1, [{ id: 1, registeredCount: null }, { id: 2, registeredCount: 0 }]), classes(1, [{ id: 1, registeredCount: 0 }]), classes(1, [{ id: 1, registeredCount: 0 }, { id: 1, registeredCount: 0 }])]) test(`unknown or incomplete class metadata cannot become a total: ${JSON.stringify(bad)}`, async () => {
  await assert.rejects(loaders([bad]).api.loadClassSummary(7, signal))
})
test('failure on later page never returns a partial total', async () => {
  const c = loaders([classes(1, [{ id: 1, registeredCount: 2 }, { id: 2, registeredCount: 0 }]), { ok: false }]); await assert.rejects(c.api.loadClassSummary(7, signal))
})
test('changing totals during pagination are rejected', async () => {
  const c = loaders([classes(1, [{ id: 1, registeredCount: 2 }, { id: 2, registeredCount: 0 }]), classes(2, [{ id: 3, registeredCount: 1 }], 4)]); await assert.rejects(c.api.loadClassSummary(7, signal))
})
test('detail lookup finds an occurrence beyond page one without another API or guessing', async () => {
  const c = loaders([{ page: 1, pageSize: 1, total: 2, eventGroups: [{ ...group, id: 6 }] }, { page: 2, pageSize: 1, total: 2, eventGroups: [group] }])
  assert.equal((await c.api.findOccurrence(7, signal)).id, 7); assert.equal(c.calls.length, 2)
})
test('missing occurrence and invalid group metadata fail closed', async () => {
  await assert.rejects(loaders([{ page: 1, pageSize: 50, total: 0, eventGroups: [] }]).api.findOccurrence(7, signal))
  await assert.rejects(loaders([{ page: 1, pageSize: 50, total: 1, eventGroups: [{ ...group, city: undefined }] }]).api.loadOccurrencePage(1, signal))
})
function elements(node) { if (Array.isArray(node)) return node.flatMap(elements); if (!node || typeof node !== 'object') return []; return [node, ...elements(node.props?.children)] }
for (const summary of [undefined, 'error', { classCount: 3, activeClassBookings: 6 }]) test(`overview presents known, unknown and failed aggregates honestly: ${JSON.stringify(summary)}`, () => {
  const values = [1, 0, { eventGroups: [group], total: 1, pageSize: 50 }, summary ? { 7: summary } : {}, false, '']; let index = 0
  const Component = compile('app/(app)/admin/event-groups/occurrence-list.tsx', {
    react: { useState: () => [values[index++], () => {}], useEffect() {} },
    'react/jsx-runtime': jsxRuntime, 'next/link': { default: () => null }, '@/lib/event-groups/admin-overview': {},
  }).default
  const tree = elements(Component()), dd = tree.filter(x => x.type === 'dd').map(x => x.props.children)
  assert.ok(dd.includes('東京')); assert.ok(dd.includes('2026-10-23'))
  assert.ok(tree.some(x => x.props?.href === '/admin/event-groups/7'))
  assert.equal(dd[2], summary === 'error' ? '取得できません' : summary ? '3クラス' : '確認中')
  assert.equal(dd[3], summary === 'error' ? '取得できません' : summary ? '有効クラス申込 6件（延べ）' : '確認中')
})
for (const tab of ['schedules', 'videos', 'passwords']) for (const status of [401, 403, 200]) test(`separate ${tab} menu retains server authorization: ${status}`, async () => {
  const Page = compile(`app/(app)/admin/${tab}/page.tsx`, {
    'next/navigation': { redirect: path => { assert.equal(path, status === 401 ? '/login' : '/videos'); throw new Error('REDIRECT') } },
    '@/lib/supabase/require-admin': { requireAdmin: async () => status === 200 ? { ok: true } : { ok: false, status } },
    '../management-tools': { default: () => null }, 'react/jsx-runtime': jsxRuntime,
  }).default
  if (status === 200) assert.equal((await Page()).props.initialTab, tab)
  else await assert.rejects(Page(), /REDIRECT/)
})
test('admin entry redirects to the occurrence list', () => {
  let path
  const Page = compile('app/(app)/admin/page.tsx', { 'next/navigation': { redirect: value => { path = value } } }).default
  Page(); assert.equal(path, '/admin/event-groups')
})
