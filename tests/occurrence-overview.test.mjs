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
const presentation = compile('lib/event-groups/presentation.ts')
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
test('detail lookup uses exact ID endpoint so hidden groups remain reachable', async () => {
  const c = loaders([{ eventGroup: { ...group, is_hidden: true } }])
  assert.equal((await c.api.findOccurrence(7, signal)).is_hidden, true); assert.equal(c.calls.length, 1); assert.equal(c.calls[0].url, '/api/admin/event-groups/7')
})
test('missing occurrence and invalid group metadata fail closed', async () => {
  await assert.rejects(loaders([{ page: 1, pageSize: 50, total: 0, eventGroups: [] }]).api.findOccurrence(7, signal))
  await assert.rejects(loaders([{ page: 1, pageSize: 50, total: 1, eventGroups: [{ ...group, city: undefined }] }]).api.loadOccurrencePage(1, signal))
})
function elements(node) { if (Array.isArray(node)) return node.flatMap(elements); if (!node || typeof node !== 'object') return []; return [node, ...elements(node.props?.children)] }
for (const summary of [undefined, 'error', { classCount: 3, activeClassBookings: 6 }]) test(`overview presents known, unknown and failed aggregates honestly: ${JSON.stringify(summary)}`, () => {
  const values = [1, 0, { eventGroups: [group], total: 1, pageSize: 50 }, summary ? { 7: summary } : {}, false, '', 'visible', '2026-10-23']; let index = 0
  const Component = compile('app/(app)/admin/event-groups/occurrence-list.tsx', {
    react: { useState: () => [values[index++], () => {}], useEffect() {} },
    'react/jsx-runtime': jsxRuntime, 'next/link': { default: () => null }, '@/lib/event-groups/admin-overview': {}, '@/lib/event-groups/presentation': presentation,
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

test('summary collects all class dates without inventing dates for missing values',async()=>{
 const c=loaders([classes(1,[{id:1,registeredCount:1,date:'2030-01-01'},{id:2,registeredCount:0,date:'2030-01-03'}],2)])
 assert.deepEqual(Array.from((await c.api.loadClassSummary(7,signal)).classDates),['2030-01-01','2030-01-03'])
})
for(const [name,start,end,dates,today,want] of [
 ['last day remains upcoming','2026-10-23','2026-10-23',['2026-10-23'],'2026-10-23','upcoming'],
 ['following day ended','2026-10-23','2026-10-23',['2026-10-23'],'2026-10-24','ended'],
 ['multi-day not ended early','2026-10-23','2026-10-25',['2026-10-23','2026-10-25'],'2026-10-24','upcoming'],
 ['multi-day ended next day','2026-10-23','2026-10-25',['2026-10-23','2026-10-25'],'2026-10-26','ended'],
 ['class beyond group end','2026-10-23','2026-10-23',['2026-10-24'],'2026-10-25','unknown'],
 ['declared end later than classes','2026-10-23','2026-10-25',['2026-10-23'],'2026-10-26','unknown'],
 ['unset period',null,null,['2026-10-23'],'2026-10-26','unknown'],
 ['partial period','2026-10-23',null,[],'2026-10-26','unknown'],
 ['impossible date','2026-02-29','2026-02-29',[],'2026-10-26','unknown'],
 ['invalid class date','2026-10-23','2026-10-23',[undefined],'2026-10-26','unknown'],
 ['failed class read','2026-10-23','2026-10-23',undefined,'2026-10-26','unknown'],
 ['zero-class valid period','2026-10-23','2026-10-23',[],'2026-10-24','ended'],
])test(`calendar classification: ${name}`,()=>assert.equal(presentation.occurrencePhase({start_date:start,end_date:end},dates,today),want))
test('Japan calendar switches at UTC 15:00 regardless of execution timezone',()=>{
 assert.equal(presentation.tokyoDay(new Date('2026-10-23T14:59:59Z')),'2026-10-23')
 assert.equal(presentation.tokyoDay(new Date('2026-10-23T15:00:00Z')),'2026-10-24')
 assert.equal(presentation.tokyoDay(new Date('2026-12-31T15:00:00Z')),'2027-01-01')
 assert.equal(presentation.calendarDay('2028-02-29'),true)
})
test('chronological display is stable for ties and leaves original array unchanged',()=>{
 const rows=[{id:1,d:'2030-01-02',t:'10:00'},{id:2,d:'2030-01-01',t:'12:00'},{id:3,d:'2030-01-01',t:'12:00'},{id:4,d:'',t:''}]
 assert.deepEqual(Array.from(presentation.chronologicalRows(rows,v=>v.d,v=>v.t)).map(v=>v.id),[2,3,1,4]);assert.deepEqual(rows.map(v=>v.id),[1,2,3,4])
})

function overviewScreen({groups, summary, now='2026-10-23T14:59:59Z'}) {
 const slots=[],effects=[],timers=[];let cursor=0,instant=new Date(now)
 const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v]},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){slots[i]={deps};effects.push(fn)}}}
 const Component=compile('app/(app)/admin/event-groups/occurrence-list.tsx',{
  react,'react/jsx-runtime':jsxRuntime,'next/link':{default:'Link'},'@/lib/event-groups/presentation':{...presentation,tokyoDay:()=>presentation.tokyoDay(instant)},
  '@/lib/event-groups/admin-overview':{loadOccurrencePage:async(_page,_signal,visibility='visible')=>{const rows=groups.filter(g=>!!g.is_hidden===(visibility==='hidden'));return{eventGroups:rows,total:rows.length,pageSize:50}},loadClassSummary:async id=>{if(summary[id]=== 'error')throw Error('mock');return summary[id]}}
 },{AbortController,setInterval:fn=>{timers.push(fn);return 1},clearInterval(){}}).default
 const render=()=>{cursor=0;return elements(Component())}
 return{render,async mount(){render();for(const fn of effects.splice(0))fn();await new Promise(r=>setImmediate(r));render()},tick(iso){instant=new Date(iso);timers.forEach(fn=>fn())}}
}
test('overview keeps every group accessible in upcoming, unknown and ended sections without changing reception',async()=>{
 const groups=[{...group,id:1},{...group,id:2,start_date:'2026-10-22',end_date:'2026-10-22'},{...group,id:3,start_date:null,end_date:null},{...group,id:4}]
 const summary={1:{classCount:1,activeClassBookings:2,classDates:['2026-10-23']},2:{classCount:1,activeClassBookings:3,classDates:['2026-10-22']},3:{classCount:0,activeClassBookings:0,classDates:[]},4:'error'}
 const c=overviewScreen({groups,summary});await c.mount()
 const section=label=>c.render().find(n=>n.type==='section'&&n.props['aria-label']===label)
 const ids=label=>elements(section(label)).filter(n=>n.type==='Link'&&n.props.className==='detail').map(n=>n.props.href)
 assert.deepEqual(ids('開催予定'),['/admin/event-groups/1']);assert.deepEqual(ids('開催終了'),['/admin/event-groups/2']);assert.deepEqual(ids('日付未設定・要確認'),['/admin/event-groups/3','/admin/event-groups/4'])
 assert.ok(groups.every(g=>g.registration_open));assert.equal(c.render().filter(n=>n.type==='article').length,4)
 c.tick('2026-10-23T15:00:00Z');assert.deepEqual(ids('開催予定'),[]);assert.deepEqual(ids('開催終了'),['/admin/event-groups/1','/admin/event-groups/2'])
 assert.ok(groups.every(g=>g.registration_open))
})

test('hidden groups have a separate recoverable list; switching visibility resets page',async()=>{
 const groups=[{...group,id:1},{...group,id:2,is_hidden:true,is_cancelled:true}]
 const summary=Object.fromEntries(groups.map(g=>[g.id,{classCount:1,activeClassBookings:1,classDates:['2026-10-23']}]))
 const c=overviewScreen({groups,summary});await c.mount()
 const links=()=>c.render().filter(n=>n.type==='Link'&&n.props.className==='detail').map(n=>n.props.href)
 assert.deepEqual(links(),['/admin/event-groups/1'])
 c.render().find(n=>n.type==='button'&&n.props.children==='非表示の開催回').props.onClick();await c.mount()
 assert.deepEqual(links(),['/admin/event-groups/2']);assert.ok(c.render().some(n=>n.type==='strong'&&n.props.children==='開催中止'))
 c.render().find(n=>n.type==='button'&&n.props.children==='通常の開催回').props.onClick();await c.mount();assert.deepEqual(links(),['/admin/event-groups/1'])
})
