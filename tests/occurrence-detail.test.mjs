import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
function compile(file, dependencies = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name] }, ...globals })
  return exports
}
const row = (id = 1, extra = {}) => ({ id, title: `Class ${id}`, date: '2030-10-23', start_time: '12:00', end_time: '21:00', location: 'Synthetic venue', capacity: 10, registeredCount: 3, registration_enabled: true, ...extra })
const page = (schedules, current = 1, total = schedules.length, size = 50) => ({ schedules, page: current, total, pageSize: size })
const signal = new AbortController().signal
const plain = value => JSON.parse(JSON.stringify(value))
function loader(responses) {
  const calls = []
  const code = compile('lib/event-groups/detail.ts', {}, { fetch: async (url, options) => { calls.push([url, options]); const item = responses.shift(); if (item instanceof Error) throw item; return { ok: item?.ok !== false, json: async () => item } } })
  return { calls, read: () => code.loadDetailClasses(7, signal) }
}
test('all class pages are read before sorting and returning complete details', async () => {
  const c = loader([page([row(2, { start_time: '14:00' })], 1, 2, 1), page([row(1)], 2, 2, 1)])
  assert.deepEqual(plain((await c.read()).map(v => v.id)), [1, 2]); assert.equal(c.calls.length, 2); assert.match(c.calls[1][0], /page=2$/); assert.equal(c.calls[0][1].cache, 'no-store')
})
test('an empty group is a verified empty array', async () => { assert.deepEqual(plain(await loader([page([])]).read()), []) })
for (const [name, responses] of [
  ['late page failure', [page([row()], 1, 2, 1), new Error('private')]],
  ['changed total', [page([row()], 1, 2, 1), page([row(2)], 2, 3, 1)]],
  ['duplicate class', [page([row()], 1, 2, 1), page([row()], 2, 2, 1)]],
  ['partial page', [page([row()], 1, 2, 50)]],
  ['wrong page', [page([row()], 2)]],
  ['missing application count', [page([{ ...row(), registeredCount: undefined }])]],
  ['invalid capacity', [page([row(1, { capacity: -1 })])]],
  ['missing reception', [page([row(1, { registration_enabled: undefined })])]],
]) test(`detail reader fails closed: ${name}`, async () => { await assert.rejects(loader(responses).read()) })
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  if (typeof tree.type === 'function') return elements(tree.type(tree.props))
  return [tree, ...elements(tree.props?.children)]
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (tree && typeof tree === 'object') return typeof tree.type === 'function' ? text(tree.type(tree.props)) : tree.type === 'style' ? '' : text(tree.props?.children)
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : ''
}
const group = { id: 7, title: 'Occurrence title', description: null, city: 'City is not venue', start_date: '2030-10-23', end_date: '2030-10-24', registration_open: false }
function screen({ rows = [row()], fail = false } = {}) {
  let cursor = 0, refreshToken = 0, current = group; const slots = [], effects = [], calls = []
  const react = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], value => slots[i] = typeof value === 'function' ? value(slots[i]) : value] },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { slots[i] = { deps }; effects.push(fn) } },
  }
  const jsx = (type, props) => ({ type, props })
  const Component = compile('app/(app)/admin/event-groups/occurrence-detail.tsx', { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@/lib/event-groups/detail': { loadDetailClasses: async (id, signal) => { calls.push([id, signal]); if (fail) throw Error('PRIVATE_ERROR'); return rows } } }, { AbortController }).default
  const render = () => { cursor = 0; return Component({ group: current, refreshToken }) }
  return { calls, render, text: () => text(render()), nodes: () => elements(render()), async flush() { render(); for (const fn of effects.splice(0)) fn(); await new Promise(r => setImmediate(r)); render() }, refresh: () => refreshToken++, changeGroup: () => current = { ...group, id: 8 } }
}
test('single occurrence shows datetime and venue once, no internal class title or end time', async () => {
  const c = screen(); await c.flush(); const t = c.text()
  assert.doesNotMatch(t, /Class 1|21:00|City is not venue/); assert.equal(t.split('Synthetic venue').length - 1, 1); assert.equal(t.split('2030-10-23').length - 1, 1)
  assert.equal(c.nodes().filter(n => n.props?.['aria-label'] === 'クラス情報').length, 0)
  assert.match(t, /停止中/); assert.match(t, /10名/); assert.match(t, /3件/); assert.ok(t.indexOf('開催日時') < t.indexOf('会場')); assert.ok(t.indexOf('会場') < t.indexOf('申込状況'))
})
test('multiple classes group each class date, venue and counts in context without collapsing', async () => {
  const c = screen({ rows: [row(), row(2, { date: '2030-10-24', location: 'Other venue', registeredCount: 4 })] }); await c.flush()
  assert.match(c.text(), /クラスごとに異なります/); assert.match(c.text(), /7件（延べ）/); assert.equal(c.nodes().filter(n => n.type === 'li').length, 2)
  const cards = c.nodes().filter(n => n.type === 'li'); assert.match(text(cards[0]), /Class 1/); assert.match(text(cards[0]), /3件/); assert.match(text(cards[1]), /Other venue/); assert.match(text(cards[1]), /4件/)
})
test('failure shows unknown counts instead of fabricated zero or a city-as-venue fallback', async () => {
  const c = screen({ fail: true }); await c.flush(); assert.match(c.text(), /取得できません/); assert.match(c.text(), /確認できません/); assert.doesNotMatch(c.text(), /0件|0名|City is not venue|PRIVATE_ERROR/)
})
test('verified zero classes and unknown capacity have explicit explanations', async () => {
  const empty = screen({ rows: [] }); await empty.flush(); assert.match(empty.text(), /クラス未登録/)
  const unknown = screen({ rows: [row(1, { capacity: null, registration_enabled: false })] }); await unknown.flush(); assert.match(unknown.text(), /未設定/); assert.match(unknown.text(), /確認できません/)
})
test('only this group is refetched after creation; stale rows are hidden on group change', async () => {
  const c = screen(); await c.flush(); assert.equal(c.calls.length, 1); c.refresh(); await c.flush(); assert.equal(c.calls.length, 2); assert.equal(c.calls[1][0], 7)
  c.changeGroup(); assert.doesNotMatch(c.text(), /Synthetic venue/); await c.flush(); assert.equal(c.calls[2][0], 8)
})
