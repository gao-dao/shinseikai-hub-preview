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
const presentation = compile('lib/event-groups/presentation.ts', {})
const plain = v => JSON.parse(JSON.stringify(v))
function all(tree) { if (Array.isArray(tree)) return tree.flatMap(all); return tree && typeof tree === 'object' ? [tree, ...all(tree.props?.children)] : [] }
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(''); if (tree && typeof tree === 'object') return text(tree.props?.children); return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '' }
const snapshot = () => ({ group: { title: '既存開催回', description: null, city: null, start_date: null, end_date: null, registration_open: false }, classes: [{ id: 7, title: '既存クラス', date: '2030-10-23', start_time: '12:00:30', end_time: '17:00', location: '既存会場', type: '稽古会', capacity: 25, registration_enabled: false }] })
function setup({ groupId, data = snapshot(), status = 200, result = { state: 'saved', groupId: 9 }, pending = null, deferred = false } = {}) {
  const slots = [], effects = [], calls = []; let cursor = 0, release, confirmResult = true, confirmations = 0
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => slots[i] = typeof v === 'function' ? v(slots[i]) : v] },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) { slots[i] = { deps }; effects.push(fn) } },
  }
  const jsx = (type, props) => ({ type, props })
  const { default: Component } = compile('app/(app)/admin/event-groups/occurrence-editor.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'next/link': { default: 'Link' }, '@/lib/event-groups/occurrence-editor': validation, '@/lib/event-groups/presentation': presentation,
    '@/lib/event-groups/occurrence-save': { createOccurrenceSaver: () => ({ restore: () => pending, save: async input => { calls.push(['save', plain(input)]); if (deferred) return new Promise(r => release = r); return result } }) },
  }, { AbortController, fetch: async (url, options) => { calls.push(['fetch', url, options]); return { ok: status === 200, json: async () => ({ snapshot: data }) } }, window: { addEventListener() {}, removeEventListener() {}, confirm: () => { confirmations++; return confirmResult } }, sessionStorage: {}, crypto: {} })
  const render = () => { cursor = 0; return all(Component({ groupId })) }
  const button = label => render().find(v => v.type === 'button' && text(v) === label)
  const fields = label => render().filter(v => v.type === 'label' && typeof v.props.children?.[0] === 'string' && v.props.children[0] === label).map(v => all(v).find(n => ['input', 'select', 'textarea'].includes(n.type)))
  return { calls, render, button, fields, confirmations: () => confirmations, cancel: () => render().find(v => v.type === 'Link' && text(v) === 'キャンセル'), text: () => render().map(v => typeof v.type === 'string' && ['p','h1','h2'].includes(v.type) ? text(v) : '').join(' '), change: (label, value, i = 0) => fields(label)[i].props.onChange({ target: { value } }),
    async mount() { render(); for (const effect of effects.splice(0)) effect(); await new Promise(r => setImmediate(r)); render() },
    async submit() { render().find(v => v.type === 'form').props.onSubmit({ preventDefault() {} }); render() },
    async save() { await button('まとめて保存').props.onClick(); await new Promise(r => setImmediate(r)); render() },
    resolve: value => release(value), confirm: value => confirmResult = value,
  }
}
function fill(c) { c.change('開催名', '東京講座'); c.change('開催日', '2030-10-23'); c.change('会場', '合成会場'); c.change('開始時刻', '12:00') }
test('new editor starts with one class, 10 seats in details, optional minute-only end-time input', async () => {
  const c = setup(); await c.mount(); assert.equal(c.fields('開始時刻').length, 1); assert.equal(c.fields('定員')[0].props.value, '10'); assert.equal(c.fields('終了時刻（任意）').length, 1); assert.equal(c.fields('終了時刻（任意）')[0].props.value, ''); assert.equal(c.fields('開始時刻')[0].props.step, '60')
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
  const c = setup({ result: { state: 'rejected', error: '競合しました' } }); await c.mount(); fill(c); await c.submit(); await c.save(); assert.match(c.text(), /競合しました/); c.button('入力へ戻る').props.onClick(); assert.equal(c.fields('開催名')[0].props.value, '東京講座'); assert.equal(c.fields('会場')[0].props.value, '合成会場')
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
  assert.match(text(c.render()), /12:00〜17:00/); assert.doesNotMatch(text(c.render()), /12:00:30/)
})
test('failed loading never shows an editable partial group', async () => { const c = setup({ groupId: 1, status: 503 }); await c.mount(); assert.equal(c.render().some(v => v.type === 'form'), false); assert.match(c.text(), /取得できません/); assert.ok(c.button('最新情報を再取得')) })
test('discarding input to reload requires confirmation', async () => { const c = setup({ groupId: 1 }); await c.mount(); c.change('開始時刻', '13:00'); c.confirm(false); c.button('最新情報を再取得').props.onClick(); assert.equal(c.fields('開始時刻')[0].props.value, '13:00') })

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

function leaveByCancel(c) { let prevented = false; c.cancel().props.onClick({ preventDefault: () => prevented = true }); return prevented }
for (const groupId of [undefined, 1]) test(`cancel without changes leaves directly and performs no save: ${groupId}`, async () => {
  const c = setup({ groupId }); await c.mount(); assert.equal(c.cancel().props.href, groupId ? '/admin/event-groups/1' : '/admin/event-groups'); assert.equal(leaveByCancel(c), false); assert.equal(c.confirmations(), 0); assert.equal(c.calls.filter(v => v[0] === 'save').length, 0)
})
test('cancel confirms only actual unsaved changes; restoring the initial input removes the warning', async () => {
  const c = setup(); await c.mount(); c.change('開催名', '変更'); c.confirm(false); assert.equal(leaveByCancel(c), true); assert.equal(c.fields('開催名')[0].props.value, '変更'); assert.equal(c.confirmations(), 1)
  c.confirm(true); assert.equal(leaveByCancel(c), false); assert.equal(c.calls.filter(v => v[0] === 'save').length, 0)
  c.change('開催名', ''); assert.equal(leaveByCancel(c), false); assert.equal(c.confirmations(), 2)
})
test('existing single class has no name input, preserves its internal name, and cancelled changes do not save', async () => {
  const c = setup({ groupId: 1 }); await c.mount(); assert.equal(c.fields('クラス名').length, 0); assert.equal(c.fields('開始時刻').length, 1); assert.equal(c.fields('会場')[0].props.value, '既存会場')
  c.change('開催名', '変更'); c.change('開催名', '既存開催回'); assert.equal(leaveByCancel(c), false); assert.equal(c.confirmations(), 0)
  await c.submit(); await c.save(); assert.equal(c.calls.find(v => v[0] === 'save')[1].classes[0].title, '既存クラス')
})
test('multiple classes have one start field per class and no common start field', async () => {
  const c = setup(); await c.mount(); fill(c); c.button('＋クラスを追加').props.onClick(); assert.equal(c.fields('開始時刻').length, 2); assert.equal(c.fields('クラス名').length, 2); assert.equal(c.fields('開催日（共通）').length, 1); assert.equal(c.fields('会場（共通）').length, 1)
})
test('cancel is blocked during a save or an unknown outcome, keeping the original retry path', async () => {
  const c = setup({ deferred: true }); await c.mount(); fill(c); await c.submit(); c.button('まとめて保存').props.onClick(); assert.equal(c.cancel().props['aria-disabled'], true); assert.equal(leaveByCancel(c), true)
  c.resolve({ state: 'unknown', error: '結果不明' }); await new Promise(r => setImmediate(r)); assert.equal(c.cancel().props['aria-disabled'], true); assert.equal(leaveByCancel(c), true); assert.ok(c.button('同じ保存キー・内容で再確認'))
})

test('minute-only editing retains raw seconds until explicit change and can clear end', async () => {
  const data = snapshot(); data.classes[0].end_time = '17:00:45'
  const c = setup({ groupId: 1, data }); await c.mount()
  assert.equal(c.fields('開始時刻')[0].props.value, '12:00'); assert.equal(c.fields('終了時刻（任意）')[0].props.value, '17:00')
  c.change('開催名', '変更'); await c.submit(); await c.save()
  const input = c.calls.find(v => v[0] === 'save')[1]; assert.equal(input.classes[0].start_time, '12:00:30'); assert.equal(Object.hasOwn(input.classes[0], 'end_time'), false); assert.equal(input.expected.classes[0].end_time, '17:00:45')
  const clear = setup({ groupId: 1 }); await clear.mount(); clear.change('終了時刻（任意）', ''); await clear.submit(); await clear.save(); assert.equal(clear.calls.find(v => v[0] === 'save')[1].classes[0].end_time, null)
})
test('single and multiple classes send explicit end times, reverse ranges reject before save', async () => {
  const c = setup(); await c.mount(); fill(c); c.change('終了時刻（任意）', '11:00'); await c.submit(); assert.equal(c.button('まとめて保存'), undefined)
  c.change('終了時刻（任意）', '13:40'); c.button('＋クラスを追加').props.onClick(); c.change('クラス名', 'B', 1); c.change('開始時刻', '14:00', 1); c.change('終了時刻（任意）', '15:40', 1)
  await c.submit(); await c.save(); assert.deepEqual(c.calls.find(v => v[0] === 'save')[1].classes.map(v => v.end_time), ['13:40', '15:40'])
})

test('editor displays chronological rows with stable identities, but preserves raw API save order', async () => {
  const data=snapshot(); data.classes=[{...data.classes[0],id:7,title:'Late',start_time:'15:00'}, {...data.classes[0],id:8,title:'Early',start_time:'10:00'}, {...data.classes[0],id:9,title:'Tie',start_time:'10:00'}]
  const c=setup({groupId:1,data});await c.mount()
  assert.deepEqual(c.fields('クラス名').map(v=>v.props.value),['Early','Tie','Late'])
  const keys=()=>c.render().filter(v=>v.props?.['data-class-key']!==undefined).map(v=>v.props['data-class-key'])
  assert.deepEqual(keys(),[1,2,0]);c.change('開始時刻','16:00',0)
  assert.deepEqual(keys(),[1,2,0]);assert.equal(c.fields('クラス名')[0].props.value,'Early')
  const section=c.render().find(v=>v.props?.['data-class-key']===1)
  assert.equal(section.props.onBlur,undefined);assert.deepEqual(keys(),[1,2,0])
  await c.submit();c.button('入力へ戻る').props.onClick();assert.deepEqual(keys(),[2,0,1])
  await c.submit();await c.save();const sent=c.calls.find(v=>v[0]==='save')[1]
  assert.deepEqual(sent.classes.map(v=>v.id),[7,8,9]);assert.equal(sent.classes[1].start_time,'16:00');assert.equal(sent.classes[0].start_time,'15:00')
})
test('editor orders across days and explicit sorting changes no identity or dirty state',async()=>{
 const data=snapshot();data.classes=[{...data.classes[0],id:7,date:'2030-10-24'}, {...data.classes[0],id:8,date:'2030-10-23'}]
 const c=setup({groupId:1,data});await c.mount();assert.deepEqual(c.render().filter(v=>v.props?.['data-class-key']!==undefined).map(v=>v.props['data-class-key']),[1,0])
 assert.equal(c.button('日時順に整列'),undefined);assert.equal(leaveByCancel(c),false);assert.equal(c.confirmations(),0)
})

test('single review shows event name, date and venue once without the internal class title',async()=>{
 const c=setup();await c.mount();fill(c);await c.submit()
 const review=c.render().find(v=>v.props?.['aria-label']==='保存前の確認'), content=text(review)
 for(const value of ['東京講座','2030-10-23','合成会場'])assert.equal(content.split(value).length-1,1)
 assert.match(content,/12:00/);assert.match(content,/定員：10名/);assert.match(content,/クラス受付：無効/)
})
test('renaming a single existing event retains its hidden saved class name and ID',async()=>{
 const c=setup({groupId:1});await c.mount();c.change('開催名','変更後の開催名');await c.submit()
 const content=text(c.render().find(v=>v.props?.['aria-label']==='保存前の確認'))
 assert.match(content,/変更後の開催名/);assert.equal(content.includes('既存クラス'),false)
 await c.save();const sent=c.calls.find(v=>v[0]==='save')[1]
 assert.equal(sent.group.title,'変更後の開催名');assert.equal(sent.classes[0].title,'既存クラス');assert.equal(sent.classes[0].id,7);assert.equal(sent.expected.classes[0].title,'既存クラス')
})
test('multiple review lists shared date and venue once while preserving class times and settings',async()=>{
 const c=setup();await c.mount();fill(c);c.button('＋クラスを追加').props.onClick();c.change('クラス名','午後の部',1);c.change('開始時刻','14:00',1);await c.submit()
 const content=text(c.render().find(v=>v.props?.['aria-label']==='保存前の確認'))
 assert.equal(content.split('2030-10-23').length-1,1);assert.equal(content.split('合成会場').length-1,1)
 assert.match(content,/午後の部/);assert.match(content,/12:00/);assert.match(content,/14:00/)
 assert.equal(content.split('定員：10名').length-1,2)
})
test('individual date and venue remain visible outside collapsed settings and appear accurately in review',async()=>{
 const c=setup();await c.mount();fill(c);c.button('＋クラスを追加').props.onClick();c.change('クラス名','別日クラス',1);c.change('開始時刻','14:00',1)
 for(const label of ['このクラスだけ日付を変更','このクラスだけ会場を変更']){
  const checkbox=c.render().filter(v=>v.type==='label'&&text(v).includes(label))[1];all(checkbox).find(v=>v.type==='input').props.onChange({target:{checked:true}})
 }
 c.change('個別の開催日','2030-10-24');c.change('個別の会場','別の会場')
 const section=c.render().find(v=>v.props?.['data-class-key']===1)
 const hint=all(section).find(v=>v.props?.className==='individual-setting')
 assert.match(text(hint),/2030-10-24/);assert.match(text(hint),/別の会場/)
 assert.equal(all(section).find(v=>v.type==='details').props.open,undefined)
 await c.submit();const content=text(c.render().find(v=>v.props?.['aria-label']==='保存前の確認'))
 assert.match(content,/2030-10-24/);assert.match(content,/別の会場/);assert.match(content,/合成会場/)
})
test('cancel is the only exit to the original page and no focus-driven sorting handlers remain',async()=>{
 const c=setup({groupId:1});await c.mount()
 const exits=c.render().filter(v=>v.type==='Link'&&v.props.href==='/admin/event-groups/1')
 assert.equal(exits.length,1);assert.equal(text(exits[0]),'キャンセル')
 assert.equal(c.render().some(v=>v.props?.onBlur),false);assert.equal(c.button('日時順に整列'),undefined)
})
