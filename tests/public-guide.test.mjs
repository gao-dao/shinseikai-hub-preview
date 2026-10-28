import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
function compile(file, deps = {}) {
 const exports = {}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,Date,Intl,Map,Set,require(name){assert.ok(name in deps,`Unexpected dependency ${name}`);return deps[name]}})
 return exports
}
const presentation=compile('lib/event-groups/presentation.ts')
const guide=compile('lib/event-groups/public-guide.ts',{'./presentation':presentation})
const server=compile('lib/event-groups/public-guide-server.ts',{'server-only':{},'@/lib/supabase/anonymous':{createAnonymousClient(){assert.fail('No external clients in tests')}},'./public-guide':guide})
const group=(id=1,changes={})=>({id,title:`開催${id}`,description:null,city:'東京',start_date:'2030-01-01',end_date:'2030-01-01',registration_open:false,is_hidden:false,is_cancelled:false,...changes})
const row=(id=1,changes={})=>({id,event_group_id:1,title:`クラス${id}`,date:'2030-01-01',start_time:'13:40:00',end_time:'15:40:00',location:'テスト会場',...changes})
function db(groups,classes,{truncate=false,fail=false}={}) {
 const calls=[]
 return {calls,from(table){
  const q={table,filters:[],orders:[]};calls.push(q)
  const builder={
   select(columns,options){q.columns=columns;q.options=options;return builder},
   eq(k,v){q.filters.push(r=>r[k]===v);return builder},gte(k,v){q.filters.push(r=>r[k]>=v);return builder},
   not(k,op,v){assert.equal(op,'is');assert.equal(v,null);q.filters.push(r=>r[k]!==null);return builder},
   in(k,values){q.filters.push(r=>values.includes(r[k]));return builder},
   order(k){q.orders.push(k);return builder},range(a,b){q.range=[a,b];return builder},maybeSingle(){q.single=true;return builder},
   then(resolve,reject){try {
    let data=(table==='event_groups'?groups:classes).filter(r=>q.filters.every(f=>f(r)))
    data=[...data].sort((a,b)=>{for(const k of q.orders){if(a[k]<b[k])return -1;if(a[k]>b[k])return 1}return 0})
    const count=data.length
    if(q.range)data=data.slice(q.range[0],q.range[1]+1)
    if(truncate && table==='schedules')data=data.slice(0,-1)
    resolve({data:q.single?(data[0]??null):data,count,error:fail?{}:null})
   }catch(e){reject(e)}}
  };return builder
 }}
}
for(const [name,g,dates,want] of [
 ['reception stopped',group(),['2030-01-01'],true],['reception open',group(1,{registration_open:true}),['2030-01-01'],true],
 ['cancelled',group(1,{is_cancelled:true}),['2030-01-01'],false],['hidden',group(1,{is_hidden:true}),['2030-01-01'],false],
 ['ended',group(1,{end_date:'2029-12-31'}),[],false],['missing date',group(1,{start_date:null}),[],false],
 ['invalid calendar',group(1,{start_date:'2030-02-30',end_date:'2030-02-30'}),[],false],
 ['class outside period',group(),['2030-01-02'],false],['stale last day',group(1,{end_date:'2030-01-03'}),['2030-01-01'],false],
 ['multiple days last day',group(1,{start_date:'2029-12-31'}),['2029-12-31','2030-01-01'],true],
])test(`publication policy: ${name}`,()=>assert.equal(guide.publishable(g,dates,'2030-01-01'),want))
test('Tokyo day changes at local midnight, not UTC midnight',()=>{
 assert.equal(guide.guideToday(new Date('2029-12-31T14:59:59Z')),'2029-12-31')
 assert.equal(guide.guideToday(new Date('2029-12-31T15:00:00Z')),'2030-01-01')
})
test('time precision and optional end never mutate stored values',()=>{
 const saved=row(); assert.equal(guide.timeRange(saved),'13:40〜15:40');assert.equal(saved.end_time,'15:40:00')
 assert.equal(guide.timeRange(row(1,{end_time:null})),'13:40')
 assert.equal(guide.timeRange(row(1,{end_time:'15:40:39'})),'13:40〜15:40')
})
test('common venue is schedule location, never city; date/time sort preserves input identity',()=>{
 const rows=[row(3,{start_time:'16:00'}),row(2),row(1)]
 assert.equal(guide.commonVenue(rows),'テスト会場');assert.equal(guide.commonVenue([row(),row(2,{location:'別会場'})]),null)
 assert.deepEqual(Array.from(guide.sortClasses(rows),r=>r.id),[1,2,3]);assert.equal(rows[0].id,3)
})
test('filtering precedes pagination and batch reads avoid N+1 and availability queries',async()=>{
 const groups=Array.from({length:51},(_,i)=>group(i+1))
 const classes=groups.map(g=>row(g.id,{event_group_id:g.id,date:g.id<25?'2030-01-02':'2030-01-01'}))
 const client=db(groups,classes)
 const first=await server.loadGuidePage(1,client,'2030-01-01')
 assert.equal(first.items.length,20);assert.equal(first.items[0].id,25);assert.equal(first.hasNext,true)
 assert.equal(client.calls.length,2)
 assert.equal(client.calls[1].columns,'id,event_group_id,date')
 assert.ok(client.calls.every(q=>!/(capacity|registration_items|registrations)/.test(q.columns)))
 const last=await server.loadGuidePage(2,db(groups,classes),'2030-01-01')
 assert.deepEqual(Array.from(last.items,r=>r.id),[45,46,47,48,49,50,51]);assert.equal(last.hasNext,false)
})
test('date reads paginate completely rather than interpreting truncated embeds as complete',async()=>{
 const rows=Array.from({length:501},(_,i)=>row(i+1))
 const client=db([group()],rows)
 const result=await server.loadGuidePage(1,client,'2030-01-01')
 assert.equal(result.items[0].classCount,501);assert.equal(client.calls.length,3)
 await assert.rejects(server.loadGuidePage(1,db([group()],rows,{truncate:true}),'2030-01-01'))
})
test('direct lookup does not leak hidden/cancelled/ended/inconsistent groups',async()=>{
 for(const changes of [{is_hidden:true},{is_cancelled:true},{end_date:'2029-12-31'},{start_date:null}])
  assert.equal(await server.loadGuideDetail(1,db([group(1,changes)],[row()]),'2030-01-01'),null)
 assert.equal(await server.loadGuideDetail(1,db([group()],[row(1,{date:'2030-01-02'})]),'2030-01-01'),null)
 const result=await server.loadGuideDetail(1,db([group()],[row()]),'2030-01-01')
 assert.equal(result.group.registration_open,false);assert.equal(result.classes.length,1)
 await assert.rejects(server.loadGuideDetail(1,db([group()],[row()],{fail:true}),'2030-01-01'))
})
for(const value of ['0','-1','1.5','1001',[], '1x'])test(`invalid page rejected: ${JSON.stringify(value)}`,()=>assert.throws(()=>guide.guidePage(value)))
const Link=props=>jsxRuntime.jsx('a',props)
async function detail(g,classes) {
 const page=compile('app/(public)/events/[id]/page.tsx',{'react/jsx-runtime':jsxRuntime,'next/link':{default:Link},'next/navigation':{notFound(){throw new Error('NOT_FOUND')}},'@/lib/event-groups/public-guide-server':{loadGuideDetail:async()=>({group:g,classes})},'@/lib/event-groups/public-guide':guide,'../guide.module.css':{default:{}}})
 return renderToStaticMarkup(await page.default({params:Promise.resolve({id:'1'})}))
}
test('single detail displays time and venue once, no redundant class name or fabricated email',async()=>{
 const html=await detail(group(),[row()])
 assert.equal((html.match(/<header/g)||[]).length,1);assert.ok(html.includes('aria-current="page"'));
 assert.equal((html.match(/13:40/g)||[]).length,1);assert.equal((html.match(/テスト会場/g)||[]).length,1)
 assert.ok(!html.includes('クラス1'));assert.ok(!html.includes('mailto:'));assert.ok(html.includes('受付は停止'))
 assert.ok(!html.includes(':00'));assert.ok(!html.includes('定員'))
})
test('multiple detail groups shared venue, preserves distinct venues and registration path',async()=>{
 const shared=await detail(group(1,{registration_open:true}),[row(),row(2,{start_time:'16:00',end_time:null})])
 assert.equal((shared.match(/テスト会場/g)||[]).length,1);assert.ok(shared.includes('/events?view=registration'));assert.ok(shared.includes('13:40〜15:40'))
 const mixed=await detail(group(),[row(),row(2,{location:'別会場'})]);assert.ok(mixed.includes('別会場'));assert.ok(mixed.includes('テスト会場'))
})
test('public list renders only parent metadata, links, and server pagination',async()=>{
 let calls=0
 const page=compile('app/(public)/events/page.tsx',{'react/jsx-runtime':jsxRuntime,'next/link':{default:Link},'./events-list':{default:()=>null},'@/lib/event-groups/public-guide-server':{loadGuidePage:async p=>{calls++;assert.equal(p,2);return {page:2,hasNext:true,items:[{...group(),classCount:3}]}}},'@/lib/event-groups/public-guide':guide,'./guide.module.css':{default:{}}})
 const html=renderToStaticMarkup(await page.default({searchParams:Promise.resolve({page:'2'})}))
 assert.equal((html.match(/<header/g)||[]).length,1);assert.ok(html.includes('href="/login"'));assert.ok(html.includes('aria-current="page"'));
 assert.equal((html.match(/<h1/g)||[]).length,1);assert.equal((html.match(/<h2/g)||[]).length,1);assert.ok(html.includes('<h2>開催1 →</h2>'));
 assert.equal(calls,1);assert.ok(html.includes('/events/1'));assert.ok(html.includes('/events?page=1'));assert.ok(html.includes('/events?page=3'));assert.ok(html.includes('3クラス'))
 assert.ok(!html.includes('残席'));assert.ok(!html.includes('13:40'));assert.ok(!html.includes('テスト会場'))
 assert.ok(!html.includes('既存のWeb申込'));assert.ok(!html.includes('view=registration'));assert.ok(!html.includes('従来のスケジュール'));assert.ok(html.includes('href="/schedule"'))
})
test('failed list and invalid input cannot display partial or invented data',async()=>{
 let calls=0
 const page=compile('app/(public)/events/page.tsx',{'react/jsx-runtime':jsxRuntime,'next/link':{default:Link},'./events-list':{default:()=>null},'@/lib/event-groups/public-guide-server':{loadGuidePage:async()=>{calls++;throw new Error('private diagnostics')}},'@/lib/event-groups/public-guide':guide,'./guide.module.css':{default:{}}})
 for(const params of [{},{page:'0'}]){
  const html=renderToStaticMarkup(await page.default({searchParams:Promise.resolve(params)}));assert.ok(html.includes('role="alert"'));assert.ok(!html.includes('private diagnostics'));assert.ok(!html.includes('掲載中の開催案内はありません'))
 }
 assert.equal(calls,1)
})
test('direct invalid or unavailable detail returns not found, not an application form',async()=>{
 let calls=0
 const page=compile('app/(public)/events/[id]/page.tsx',{'react/jsx-runtime':jsxRuntime,'next/link':{default:Link},'next/navigation':{notFound(){throw new Error('NOT_FOUND')}},'@/lib/event-groups/public-guide-server':{loadGuideDetail:async()=>{calls++;return null}},'@/lib/event-groups/public-guide':guide,'../guide.module.css':{default:{}}})
 await assert.rejects(page.default({params:Promise.resolve({id:'1x'})}),/NOT_FOUND/);assert.equal(calls,0)
 await assert.rejects(page.default({params:Promise.resolve({id:'1'})}),/NOT_FOUND/);assert.equal(calls,1)
})

test('public application link keeps group ID and does not promise class availability',async()=>{
 const open=await detail(group(7,{registration_open:true}),[row()]);assert.ok(open.includes('Web申込ページを確認'));assert.ok(open.includes('/events?view=registration&amp;groupId=7'));assert.equal((open.match(/href="\/admin"/g)||[]).length,1);
 const closed=await detail(group(7,{registration_open:false}),[row()]);assert.ok(!closed.includes('Web申込ページを確認'));assert.ok(closed.includes('Web申込の受付は停止しています'));
})

test('public headers expose one non-prefetched admin entry without any authorization query',async()=>{
 function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);return tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[]}
 const HeaderLink='Link';let lists=0,details=0;
 const deps={'react/jsx-runtime':jsxRuntime,'next/link':{default:HeaderLink},'./events-list':{default:()=>null},'next/navigation':{notFound(){throw Error('NOT_FOUND')}},'@/lib/event-groups/public-guide-server':{loadGuidePage:async()=>{lists++;return {page:1,hasNext:false,items:[]}},loadGuideDetail:async()=>{details++;return {group:group(),classes:[row()]}}},'@/lib/event-groups/public-guide':guide,'./guide.module.css':{default:{}},'../guide.module.css':{default:{}}};
 for(const [file,props] of [['app/(public)/events/page.tsx',{searchParams:Promise.resolve({})}],['app/(public)/events/[id]/page.tsx',{params:Promise.resolve({id:'1'})}]]){
  const tree=nodes(await compile(file,deps).default(props));assert.equal(tree.filter(n=>n.type==='header').length,1);
  const header=tree.find(n=>n.type==='header'),links=nodes(header).filter(n=>n.type===HeaderLink),admin=links.filter(n=>n.props.href==='/admin');assert.equal(admin.length,1);assert.equal(admin[0].props.prefetch,false);assert.equal(admin[0].props.children,'管理ホーム');assert.ok(links.some(n=>n.props.href==='/login'));
 }
 assert.equal(lists,1);assert.equal(details,1);
})
