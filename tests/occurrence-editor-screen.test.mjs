import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
function compile(file, dependencies, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name] }, ...globals })
  return exports
}
const occurrence = compile('lib/event-groups/validation.ts', {}), schedule = compile('lib/schedules/new-schedule.ts', {})
const validation = compile('lib/event-groups/occurrence-editor.ts', { './validation': occurrence, '../schedules/new-schedule': schedule })
const plain = v => JSON.parse(JSON.stringify(v))
function all(tree) { if (Array.isArray(tree)) return tree.flatMap(all); return tree && typeof tree === 'object' ? [tree, ...all(tree.props?.children)] : [] }
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(''); if (tree && typeof tree === 'object') return text(tree.props?.children); return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '' }
const snapshot = () => ({ group: { title: '既存開催回', description: null, city: null, start_date: null, end_date: null, registration_open: false }, classes: [{ id: 7, title: '既存クラス', date: '2030-10-23', start_time: '12:00:30', end_time: '17:00', location: '既存会場', type: '稽古会', capacity: 25, registration_enabled: false }] })
function setup({ groupId, data = snapshot(), status = 200, result = { state: 'saved', groupId: 9 }, pending = null, deferred = false } = {}) {
  const slots = [], effects = [], calls = []; let cursor = 0, release, confirmResult = true
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => slots[i] = typeof v === 'function' ? v(slots[i]) : v] },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) { slots[i] = { deps }; effects.push(fn) } },
  }
  const jsx = (type, props) => ({ type, props })
  const { default: Component } = compile('app/(app)/admin/event-groups/occurrence-editor.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'next/link': { default: 'Link' }, '@/lib/event-groups/occurrence-editor': validation,
    '@/lib/event-groups/occurrence-save': { createOccurrenceSaver: () => ({ restore: () => pending, save: async input => { calls.push(['save', plain(input)]); if (deferred) return new Promise(r => release = r); return result } }) },
  }, { AbortController, fetch: async (url, options) => { calls.push(['fetch', url, options]); return { ok: status === 200, json: async () => ({ snapshot: data }) } }, window: { addEventListener() {}, removeEventListener() {}, confirm: () => confirmResult }, sessionStorage: {}, crypto: {} })
  const render = () => { cursor = 0; return all(Component({ groupId })) }
  const button = label => render().find(v => v.type === 'button' && text(v) === label)
  const fields = label => render().filter(v => v.type === 'label' && typeof v.props.children?.[0] === 'string' && v.props.children[0] === label).map(v => all(v).find(n => ['input', 'select', 'textarea'].includes(n.type)))
  return { calls, render, button, fields, text: () => render().map(v => typeof v.type === 'string' && ['p','h1','h2'].includes(v.type) ? text(v) : '').join(' '), change: (label, value, i = 0) => fields(label)[i].props.onChange({ target: { value } }),
    async mount() { render(); for (const effect of effects.splice(0)) effect(); await new Promise(r => setImmediate(r)); render() },
    async submit() { render().find(v => v.type === 'form').props.onSubmit({ preventDefault() {} }); render() },
    async save() { await button('まとめて保存').props.onClick(); await new Promise(r => setImmediate(r)); render() },
    resolve: value => release(value), confirm: value => confirmResult = value,
  }
}
function fill(c) { c.change('開催名', '東京講座'); c.change('開催日（共通）', '2030-10-23'); c.change('会場（共通）', '合成会場'); c.change('開始時刻', '12:00') }
test('new editor starts with one class, 10 seats in details, no end-time input', async () => {
  const c = setup(); await c.mount(); assert.equal(c.fields('開始時刻').length, 1); assert.equal(c.fields('定員')[0].props.value, '10'); assert.equal(c.render().filter(v => v.type === 'input' && /end_time/.test(JSON.stringify(v.props))).length, 0)
  assert.equal(c.calls.length, 0)
})
test('single-class review and atomic save use event title, common date/venue and stopped reception', async () => {
  const c = setup(); await c.mount(); fill(c); await c.submit(); assert.ok(c.button('まとめて保存')); await c.save()
  const input = c.calls.find(v => v[0] === 'save')[1]; assert.equal(input.classes.length, 1); assert.equal(input.classes[0].title, '東京講座'); assert.equal(input.classes[0].capacity, 10); assert.equal(input.classes[0].registration_enabled, false); assert.equal(input.classes[0].date, '2030-10-23'); assert.equal(input.classes[0].location, '合成会場'); assert.equal(input.group_id, null); assert.equal(input.expected, null)
  assert.match(c.text(), /保存しました/); assert.match(c.text(), /受付状態は変更していません/)
})
test('multiple classes inherit date and venue; individual overrides define multi-day range', async () => {
  const c = setup(); await c.mount(); fill(c); c.button('＋クラスを追加').props.onClick(); c.change('クラス名', '第2部', 1); c.change('開始時刻', '14:00', 1)
  const checkbox = c.render().filter(v => v.type === 'label' && text(v).includes('このクラスだけ日付を変更'))[1]; all(checkbox).find(v => v.type === 'input').props.onChange({ target: { checked: true } }); c.change('個別の開催日', '2030-10-24')
  const venueCheck = c.render().filter(v => v.type === 'label' && text(v).includes('このクラスだけ会場を変更'))[1]; all(venueCheck).find(v => v.type === 'input').props.onChange({ target: { checked: true } }); c.change('個別の会場', '別会場')
  await c.submit(); await c.save(); const input = c.calls.find(v => v[0] === 'save')[1]
  assert.equal(input.classes.length, 2); assert.equal(input.classes[0].location, '合成会場'); assert.equal(input.classes[1].location, '別会場'); assert.equal(input.group.end_date, '2030-10-24')
})
test('existing values, capacity and raw expected end-time are retained; row cannot delete DB class', async () => {
  const c = setup({ groupId: 1 }); await c.mount(); assert.equal(c.fields('定員')[0].props.value, '25'); assert.equal(c.button('この入力行を取り除く'), undefined)
  c.change('開催名', '編集後'); await c.submit(); await c.save(); const input = c.calls.find(v => v[0] === 'save')[1]
  assert.equal(input.expected.classes[0].end_time, '17:00'); assert.equal(input.expected.group.start_date, null); assert.equal(input.expected.group.city, null); assert.equal(input.classes[0].capacity, 25); assert.equal(input.classes[0].start_time, '12:00:30'); assert.equal('end_time' in input.classes[0], false)
})
test('new unsaved rows can be removed without sending a deletion operation', async () => { const c = setup(); await c.mount(); fill(c); c.button('＋クラスを追加').props.onClick(); c.button('この入力行を取り除く').props.onClick(); assert.equal(c.fields('開始時刻').length, 1); assert.equal(c.calls.length, 0) })
test('invalid input is shown before confirmation and before any save', async () => { const c = setup(); await c.mount(); await c.submit(); assert.match(c.text(), /開催名/); assert.equal(c.calls.length, 0); assert.equal(c.button('まとめて保存'), undefined) })
test('save rejection preserves input and allows review correction', async () => {
  const c = setup({ result: { state: 'rejected', error: '競合しました' } }); await c.mount(); fill(c); await c.submit(); await c.save(); assert.match(c.text(), /競合しました/); c.button('入力へ戻る').props.onClick(); assert.equal(c.fields('開催名')[0].props.value, '東京講座'); assert.equal(c.fields('会場（共通）')[0].props.value, '合成会場')
})
test('unknown result permits same-save manual retry but no edit or automatic resend', async () => {
  const c = setup({ result: { state: 'unknown', error: '結果不明' } }); await c.mount(); fill(c); await c.submit(); await c.save(); assert.equal(c.calls.filter(v => v[0] === 'save').length, 1); assert.equal(c.button('入力へ戻る'), undefined); assert.ok(c.button('同じ保存キー・内容で再確認')); assert.match(c.text(), /自動再送は行いません/)
})
test('in-flight save disables navigation and repeat submission', async () => {
  const c = setup({ deferred: true }); await c.mount(); fill(c); await c.submit(); c.button('まとめて保存').props.onClick(); assert.equal(c.button('保存結果を確認中...').props.disabled, true); assert.equal(c.button('入力へ戻る').props.disabled, true)
  let prevented = false; c.render().find(v => v.type === 'Link').props.onClick({ preventDefault: () => prevented = true }); assert.equal(prevented, true)
  c.resolve({ state: 'saved', groupId: 9 }); await new Promise(r => setImmediate(r)); assert.match(c.text(), /保存しました/)
})
test('saved draft recovery displays frozen confirmation and does not fetch or auto-save', async () => {
  const input = { group_id: 1, group: { ...snapshot().group, start_date: '2030-10-23', end_date: '2030-10-23' }, classes: snapshot().classes, expected: snapshot() }
  const c = setup({ groupId: 1, pending: { key: 'synthetic', input } }); await c.mount(); assert.equal(c.calls.length, 0); assert.ok(c.button('同じ保存キー・内容で再確認')); assert.equal(c.button('最新情報を再取得'), undefined)
})
test('failed loading never shows an editable partial group', async () => { const c = setup({ groupId: 1, status: 503 }); await c.mount(); assert.equal(c.render().some(v => v.type === 'form'), false); assert.match(c.text(), /取得できません/); assert.ok(c.button('最新情報を再取得')) })
test('discarding input to reload requires confirmation', async () => { const c = setup({ groupId: 1 }); await c.mount(); c.change('クラス名', '変更'); c.confirm(false); c.button('最新情報を再取得').props.onClick(); assert.equal(c.fields('クラス名')[0].props.value, '変更') })

for (const file of ['app/(app)/admin/event-groups/new/page.tsx','app/(app)/admin/event-groups/[id]/edit/page.tsx']) {
  for (const status of [401,403]) test(`${file} retains server-side authorization ${status}`,async()=>{
    const Component = compile(file, {
      'next/navigation': { redirect: path => { assert.equal(path,status===401?'/login':'/videos');throw Error('REDIRECT') }, notFound: () => { throw Error('NOT_FOUND') } },
      '@/lib/supabase/require-admin': { requireAdmin: async()=>({ok:false,status}) },
      '../occurrence-editor': { default:()=>null }, '../../occurrence-editor': { default:()=>null },
      'react/jsx-runtime': { jsx:()=>null },
    }).default
    await assert.rejects(Component({params:Promise.resolve({id:'1'})}),/REDIRECT/)
  })
}

test('returning to a single new row always uses the visible current event name',async()=>{
  const c=setup();await c.mount();fill(c);c.button('＋クラスを追加').props.onClick();c.render().filter(v=>v.type==='button'&&text(v)==='この入力行を取り除く').at(-1).props.onClick();assert.equal(c.fields('開始時刻')[0].props.value,'12:00');c.change('開催名','新しい開催名');await c.submit();await c.save();assert.equal(c.calls.find(v=>v[0]==='save')[1].classes[0].title,'新しい開催名')
})
