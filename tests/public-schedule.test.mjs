import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
function compile(file, deps = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, Date, Intl, Map, Set, require(name) { assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name] } })
  return exports
}
const presentation = compile('lib/event-groups/presentation.ts')
const guide = compile('lib/event-groups/public-guide.ts', { './presentation': presentation })
const server = compile('lib/schedule/public-schedule.ts', { 'server-only': {}, '@/lib/supabase/anonymous': { createAnonymousClient() { assert.fail('No real DB') } }, '@/lib/event-groups/presentation': presentation, '@/lib/event-groups/public-guide': guide })
const group = (id = 1, changes = {}) => ({ id, title: `開催${id}`, city: '東京', start_date: '2030-01-01', end_date: '2030-01-01', is_cancelled: false, is_hidden: false, ...changes })
const row = (id = 1, changes = {}) => ({ id, event_group_id: 1, title: `内部クラス${id}`, date: '2030-01-01', start_time: '13:40:00', end_time: '15:40:00', location: '会場', type: '稽古会', ...changes })
function db(groups = [group()], schedules = [row()], options = {}) {
  const calls = []
  return { calls, from(table) {
    assert.ok(['event_groups', 'schedules'].includes(table))
    const call = { table, filters: [] }; calls.push(call)
    const q = {
      select(columns, settings) { call.columns = columns; assert.equal(settings.count, 'exact'); return q },
      eq(k, v) { call.filters.push(r => r[k] === v); return q },
      is(k, v) { call.independent = true; call.filters.push(r => r[k] === v); return q },
      not(k, op, v) { assert.equal(op, 'is'); assert.equal(v, null); call.filters.push(r => r[k] != null); return q },
      in(k, ids) { call.ids = ids; call.filters.push(r => ids.includes(r[k])); return q },
      order(k) { assert.equal(k, 'id'); return q },
      range(a, b) { call.range = [a, b]; return q },
      then(resolve, reject) { try {
        let data = (table === 'event_groups' ? groups : schedules).filter(r => call.filters.every(f => f(r))).sort((a,b) => a.id-b.id)
        let count = data.length
        data = data.slice(call.range[0], call.range[1]+1)
        if (options.truncate && table === 'schedules' && !call.independent) data = data.slice(0, -1)
        if (options.duplicate && table === 'schedules' && !call.independent && data.length > 1) data[1] = data[0]
        if (options.noCount) count = null
        if (options.inconsistentCount && call.range[0] > 0) count++
        resolve({ data, count, error: options.fail ? {} : null })
      } catch(e) { reject(e) } }
    }; return q
  } }
}
const load = (c, today = '2030-01-01') => server.loadScheduleIndex(c, today)
test('single occurrence appears once and links to existing detail; no internal class fields', async () => {
  const c = db(); const items = await load(c)
  assert.equal(items.length, 1); assert.equal(items[0].title, '開催1'); assert.equal(items[0].href, '/events/1')
  assert.equal(items[0].place, '東京'); assert.equal(items[0].type, '稽古会')
  for (const call of c.calls) assert.doesNotMatch(call.columns, /\*|capacity|registration|contact|description/)
  assert.doesNotMatch(JSON.stringify(items), /内部クラス|13:40|会場/)
})
for (const [types, expected] of [[['稽古会','稽古会'],'稽古会'],[['一般参加','一般参加'],'一般参加'],[['一般参加','稽古会'],'稽古会・一般参加']]) test(`class type aggregation ${types}`, async () => {
  const c = db([group()], types.map((type, i) => row(i+1, { type })))
  const items = await load(c); assert.equal(items.length, 1); assert.equal(items[0].type, expected)
})
test('multiple days aggregate into one period; independent dates, venue, type and time stay distinct', async () => {
  const c = db([group(1,{start_date:'2029-12-31'})], [row(1,{date:'2029-12-31'}), row(2), row(3,{event_group_id:null,title:'独立予定',date:'2029-01-01',type:'一般参加'})])
  const items = await load(c); assert.equal(items.length,2)
  assert.equal(items[0].title,'独立予定'); assert.equal(items[0].period,'2029-01-01 13:40〜15:40'); assert.equal(items[0].place,'会場'); assert.equal(items[0].type,'一般参加')
  assert.equal(items[1].period,'2029-12-31〜2030-01-01')
})
for (const change of [{is_cancelled:true},{is_hidden:true},{is_hidden:true,is_cancelled:true},{start_date:null},{end_date:null},{start_date:'2030-02-30'},{end_date:'2029-01-01'}]) test(`exclude unsafe occurrence ${JSON.stringify(change)}`, async () => {
  const c=db([group(1,change)],[row(),row(2,{event_group_id:null})]);const items=await load(c)
  assert.equal(items.length,1);assert.equal(items[0].key,'schedule-2')
})
for (const dates of [['2030-01-02'],[null],['2029-12-31']]) test(`exclude inconsistent class dates ${dates}`,async()=>{
  assert.equal((await load(db([group()],dates.map((date,i)=>row(i+1,{date}))))).length,0)
})
test('stale final day and empty group are not guessed publishable',async()=>{
  assert.equal((await load(db([group(1,{end_date:'2030-01-02'})],[row()]))).length,0)
  assert.equal((await load(db([group()],[]))).length,0)
})
test('history remains visible; link ends only after final Tokyo day, independent history retained',async()=>{
  const c=()=>db([group()],[row(),row(2,{event_group_id:null,date:'2020-01-01'})])
  const last=await load(c(),presentation.tokyoDay(new Date('2030-01-01T14:59:59Z')))
  const ended=await load(c(),presentation.tokyoDay(new Date('2030-01-01T15:00:00Z')))
  assert.equal(last.length,2); assert.equal(last[1].href,'/events/1'); assert.equal(ended.length,2);assert.equal(ended[1].href,null)
})
test('group batches avoid N+1 and metadata ranges read all class types',async()=>{
  const groups=Array.from({length:51},(_,i)=>group(i+1))
  const c=db(groups,groups.map(g=>row(g.id,{event_group_id:g.id})))
  assert.equal((await load(c)).length,51)
  assert.equal(c.calls.filter(c=>c.ids).length,2)
  const many=db([group()],Array.from({length:501},(_,i)=>row(i+1,{type:i===500?'一般参加':'稽古会'})))
  assert.equal((await load(many))[0].type,'稽古会・一般参加');assert.equal(many.calls.filter(c=>c.ids).length,2)
})
test('independent rows beyond default DB response cap are retained',async()=>{
  const c=db([],Array.from({length:501},(_,i)=>row(i+1,{event_group_id:null})))
  assert.equal((await load(c)).length,501);assert.equal(c.calls.filter(c=>c.independent).length,2)
})
for (const options of [{truncate:true},{duplicate:true},{noCount:true},{fail:true}]) test(`incomplete or failed reads are explicit errors ${JSON.stringify(options)}`, async()=>{
  await assert.rejects(()=>load(db([group()],[row(),row(2)],options)))
})
test('changing counts during batching never present an incomplete list',async()=>{
  await assert.rejects(()=>load(db([group()],Array.from({length:501},(_,i)=>row(i+1)),{inconsistentCount:true})))
})
test('direct server page renders group links and independent rows without class duplication',async()=>{
  const c=db();const items=await load(c)
  const page=compile('app/(app)/schedule/page.tsx',{'react/jsx-runtime':jsxRuntime,'next/link':{default:({children,...props})=>jsxRuntime.jsx('a',{...props,children})},'@/lib/schedule/public-schedule':{loadScheduleIndex:async()=>items},'./schedule.module.css':{default:{}}})
  assert.equal(page.dynamic,'force-dynamic');assert.equal(page.revalidate,0)
  const html=renderToStaticMarkup(await page.default());assert.match(html,/href="\/events\/1"/);assert.match(html,/開催1/);assert.doesNotMatch(html,/内部クラス|残席|定員/)
})
test('empty and error page states are distinct and do not expose database errors',async()=>{
  for(const fail of [false,true]){
    const page=compile('app/(app)/schedule/page.tsx',{'react/jsx-runtime':jsxRuntime,'next/link':{default:()=>null},'@/lib/schedule/public-schedule':{loadScheduleIndex:async()=>{if(fail)throw Error('SECRET');return []}},'./schedule.module.css':{default:{}}})
    const html=renderToStaticMarkup(await page.default());assert.doesNotMatch(html,/SECRET/);assert.match(html,fail?/role="alert"/:/まだ登録されていません/)
  }
})

test('independent schedules retain missing-date and end-only-time information',async()=>{
 const items=await load(db([], [row(1,{event_group_id:null,date:null,start_time:null,end_time:'15:40:00'}),row(2,{event_group_id:null,start_time:'09:00:00',end_time:null})]))
 assert.equal(items.length,2);assert.equal(items[0].period,'2030-01-01 09:00');assert.equal(items[1].period,'日付未設定 終了 15:40')
})
