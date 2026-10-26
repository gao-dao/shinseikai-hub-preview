import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
function compile(file,deps={}) {
 const exports={}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,Date,Intl,URLSearchParams,Map,Set,require(name){assert.ok(name in deps,`Unexpected dependency ${name}`);return deps[name]}})
 return exports
}
const presentation=compile('lib/event-groups/presentation.ts')
const index=compile('lib/event-groups/admin-index.ts',{'./presentation':presentation})
const server=compile('lib/event-groups/admin-index-server.ts',{'server-only':{},'@/lib/supabase/server':{createClient(){assert.fail('No real DB client')}},'./presentation':presentation,'./admin-index':index})
const group=(id=1,changes={})=>({id,title:`開催${id}`,city:'東京',start_date:'2030-01-01',end_date:'2030-01-01',is_cancelled:false,is_hidden:false,...changes})
const row=(id=1,changes={})=>({id,event_group_id:id,date:'2030-01-01',...changes})
function db(groups,rows,{truncate=false,fail=false}={}) {
 const calls=[]
 return {calls,from(table){
  assert.ok(['event_groups','schedules'].includes(table));const q={table,filters:[],orders:[]};calls.push(q)
  const builder={
   select(columns,opts){q.columns=columns;q.opts=opts;return builder},eq(k,v){q.filters.push(r=>r[k]===v);return builder},lt(k,v){q.filters.push(r=>r[k]!==null&&r[k]<v);return builder},
   ilike(k,v){q.search=v;const literal=v.slice(1,-1).replace(/\\([\\%_])/g,'$1').toLocaleLowerCase();q.filters.push(r=>r[k].toLocaleLowerCase().includes(literal));return builder},
   or(v){q.or=v;const today=v.split('.lt.')[1];q.filters.push(r=>r.is_cancelled||r.is_hidden||(r.end_date!==null&&r.end_date<today));return builder},
   in(k,v){q.filters.push(r=>v.includes(r[k]));return builder},order(k){q.orders.push(k);return builder},range(a,b){q.range=[a,b];return builder},
   then(resolve,reject){try{
    let data=(table==='event_groups'?groups:rows).filter(r=>q.filters.every(f=>f(r)))
    data=[...data].sort((a,b)=>a.id-b.id);const count=data.length;data=data.slice(q.range[0],q.range[1]+1)
    if(truncate&&table==='schedules')data=data.slice(0,-1)
    resolve({data,count,error:fail?{}:null})
   }catch(e){reject(e)}}
  };return builder
 }}
}
const normal=index.indexOptions(false), history=index.indexOptions(true)
for(const [label,changes,dates,phase,normalMatch,historyMatch] of [
 ['last day',{},['2030-01-01'],'upcoming',true,false],
 ['next day',{start_date:'2029-12-31',end_date:'2029-12-31'},['2029-12-31'],'ended',false,true],
 ['multiple days',{start_date:'2029-12-30'},['2029-12-30','2030-01-01'],'upcoming',true,false],
 ['cancelled',{is_cancelled:true},['2030-01-01'],'upcoming',false,true],
 ['hidden',{is_hidden:true},['2030-01-01'],'upcoming',false,true],
 ['cancelled and hidden',{is_hidden:true,is_cancelled:true},['2030-01-01'],'upcoming',false,true],
 ['shown again',{is_hidden:false},['2030-01-01'],'upcoming',true,false],
 ['missing date',{start_date:null,end_date:null},[],'unknown',true,false],
 ['outside period',{},['2030-01-02'],'unknown',true,false],
 ['stale final day',{end_date:'2030-01-03'},['2030-01-01'],'unknown',true,false],
 ['invalid calendar',{start_date:'2030-02-30',end_date:'2030-02-30'},[],'unknown',true,false],
]) test(`classification and destination: ${label}`,()=>{
 const item=index.classifyIndex(group(1,changes),dates,'2030-01-01')
 assert.equal(item.phase,phase);assert.equal(index.indexMatches(item,normal),normalMatch);assert.equal(index.indexMatches(item,history),historyMatch)
})
test('Tokyo midnight moves completed event to history without mutating it',()=>{
 const saved=group(), dates=['2030-01-01']
 const first=index.classifyIndex(saved,dates,presentation.tokyoDay(new Date('2030-01-01T14:59:59Z')))
 const second=index.classifyIndex(saved,dates,presentation.tokyoDay(new Date('2030-01-01T15:00:00Z')))
 assert.equal(first.phase,'upcoming');assert.equal(second.phase,'ended');assert.deepEqual(saved,group())
})
test('server filters before exact counts, sorting and pagination, with no N+1 or applicant reads',async()=>{
 const groups=Array.from({length:125},(_,i)=>group(i+1,{start_date:i<25?'2029-12-31':'2030-01-01',end_date:i<25?'2029-12-31':'2030-01-01'}))
 const classes=groups.map(g=>row(g.id,{date:g.end_date}))
 const client=db(groups,classes)
 const result=await server.loadAdminIndex(index.indexOptions(false,{page:'2'}),client,'2030-01-01')
 assert.equal(result.total,100);assert.equal(result.pageSize,20);assert.deepEqual(Array.from(result.items,r=>r.id),Array.from({length:20},(_,i)=>46+i))
 assert.equal(client.calls.length,4)
 assert.ok(client.calls.filter(q=>q.table==='schedules').every(q=>q.columns==='id,event_group_id,date'))
 assert.ok(client.calls.every(q=>!/(capacity|registered|contact|notes|registration_open)/.test(q.columns)))
})
test('history DB search, literal wildcard escaping and state filters preserve exact totals and unique rows',async()=>{
 const groups=[group(1,{title:'東京_講習会',is_hidden:true,is_cancelled:true}),group(2,{title:'東京X講習会',is_cancelled:true}),group(3,{title:'東京_過去',start_date:'2029-12-31',end_date:'2029-12-31'}),group(4)]
 const classes=groups.map(g=>row(g.id,{date:g.end_date}))
 const client=db(groups,classes)
 const all=await server.loadAdminIndex(index.indexOptions(true,{q:'東京_'}),client,'2030-01-01')
 assert.equal(all.total,2);assert.equal(new Set(all.items.map(g=>g.id)).size,2);assert.equal(client.calls[0].search,'%東京\\_%');assert.ok(client.calls[0].or)
 for(const [state,want] of [['hidden',1],['cancelled',2],['ended',1]]){
  const result=await server.loadAdminIndex(index.indexOptions(true,{state}),db(groups,classes),'2030-01-01');assert.equal(result.total,want)
 }
 assert.ok(index.indexLabels(all.items[0]).includes('非表示'));assert.ok(index.indexLabels(all.items[0]).includes('開催中止'))
})
test('past inconsistent group stays in review rather than disappearing into history',async()=>{
 const groups=[group(1,{start_date:'2029-12-30',end_date:'2029-12-31'})],rows=[row(1,{date:'2029-12-30'})]
 const active=await server.loadAdminIndex(normal,db(groups,rows),'2030-01-01');assert.equal(active.review,1);assert.equal(active.total,1)
 const archived=await server.loadAdminIndex(history,db(groups,rows),'2030-01-01');assert.equal(archived.total,0)
})
test('incomplete dates or errors fail closed rather than showing zero or partial totals',async()=>{
 await assert.rejects(server.loadAdminIndex(normal,db([group()],[row()],{truncate:true}),'2030-01-01'))
 await assert.rejects(server.loadAdminIndex(normal,db([group()],[row()],{fail:true}),'2030-01-01'))
 const empty=await server.loadAdminIndex(normal,db([],[]),'2030-01-01');assert.equal(empty.total,0)
})
test('class date batches read all 501 rows while keeping class details out of the list',async()=>{
 const client=db([group()],Array.from({length:501},(_,i)=>row(i+1,{event_group_id:1})))
 const result=await server.loadAdminIndex(normal,client,'2030-01-01');assert.equal(result.total,1);assert.equal(client.calls.length,3)
})
test('upcoming order is chronological with stable ID ties and review separately last',()=>{
 const rows=[index.classifyIndex(group(9,{start_date:null}),[],'2030-01-01'),index.classifyIndex(group(3),['2030-01-01'],'2030-01-01'),index.classifyIndex(group(1),['2030-01-01'],'2030-01-01')]
 assert.deepEqual(Array.from(index.sortIndex(rows,false),r=>r.id),[1,3,9]);assert.equal(rows[0].id,9)
})
for(const params of [{page:'0'},{page:'1.5'},{page:['1']},{q:'x'.repeat(101)},{state:'unknown'}])test(`invalid filters ${JSON.stringify(params).slice(0,60)}`,()=>assert.throws(()=>index.indexOptions(true,params)))
test('pagination retains search and filter; search submissions reset the page',()=>{
 const options=index.indexOptions(true,{q:'東京',state:'hidden',page:'2'}),url=new URL(index.indexHref(options,3),'https://local.invalid')
 assert.equal(url.searchParams.get('q'),'東京');assert.equal(url.searchParams.get('state'),'hidden');assert.equal(url.searchParams.get('page'),'3')
})
const Link=props=>jsxRuntime.jsx('a',props)
const View=compile('app/(app)/admin/event-groups/admin-index-view.tsx',{'react/jsx-runtime':jsxRuntime,'next/link':{default:Link},'@/lib/event-groups/admin-index':index,'./admin-index.module.css':{default:{}}}).default
for(const isHistory of [false,true])test(`minimal ${isHistory?'history':'normal'} view, no duplicate edit controls`,()=>{
 const options=index.indexOptions(isHistory),item=index.classifyIndex(group(1,{is_hidden:isHistory}),['2030-01-01'],'2030-01-01')
 const html=renderToStaticMarkup(jsxRuntime.jsx(View,{options,result:{items:[item],total:1,upcoming:1,review:0,page:1,pageSize:20},error:''}))
 assert.ok(html.includes(isHistory?'開催記録・履歴':'開催回管理'));assert.equal((html.match(/href="\/admin\/event-groups\/1(?:\?returnTo=[^"]*)?"/g)||[]).length,1)
 assert.ok(!html.includes('/1/edit'));assert.ok(!html.includes('申込数'));assert.ok(!html.includes('クラス数'))
 if(isHistory){assert.ok(html.includes('method="get"'));assert.ok(!html.includes('name="page"'));assert.ok(html.includes('非表示'))}else assert.ok(html.includes('/admin/event-groups/new'))
})
for(const path of ['app/(app)/admin/event-groups/page.tsx','app/(app)/admin/event-groups/history/page.tsx'])for(const status of [401,403,200])test(`admin gate before reads: ${path}, ${status}`,async()=>{
 let reads=0
 const page=compile(path,{'react/jsx-runtime':jsxRuntime,'next/navigation':{redirect(p){assert.equal(p,status===401?'/login':'/videos');throw new Error('REDIRECT')}},'@/lib/supabase/require-admin':{requireAdmin:async()=>status===200?{ok:true}:{ok:false,status}},'@/lib/event-groups/admin-index':index,'@/lib/event-groups/admin-index-server':{loadAdminIndex:async()=>{reads++;return {items:[],total:0,page:1,pageSize:20,upcoming:0,review:0}}},[path.includes('/history/')?'../admin-index-view':'./admin-index-view']:{default:View}})
 if(status!==200){await assert.rejects(page.default(),/REDIRECT/);assert.equal(reads,0)}else{await page.default();assert.equal(reads,1)}
})
test('history is newest first and page count matches filtered multi-state records',async()=>{
 const groups=Array.from({length:45},(_,i)=>group(i+1,{is_cancelled:true,is_hidden:i%2===0,start_date:i<25?'2030-01-01':'2030-01-02',end_date:i<25?'2030-01-01':'2030-01-02'}))
 const rows=groups.map(g=>row(g.id,{date:g.end_date}))
 const result=await server.loadAdminIndex(index.indexOptions(true,{page:'2',state:'cancelled'}),db(groups,rows),'2030-01-01')
 assert.equal(result.total,45);assert.equal(result.items.length,20);assert.deepEqual(Array.from(result.items,g=>g.id),Array.from({length:20},(_,i)=>i+1))
 const last=await server.loadAdminIndex(index.indexOptions(true,{page:'3',state:'cancelled'}),db(groups,rows),'2030-01-01');assert.equal(last.items.length,5);assert.equal(last.total,45)
})
test('read failures never show invented totals or application data in either view',()=>{
 for(const history of [false,true]){
  const html=renderToStaticMarkup(jsxRuntime.jsx(View,{options:index.indexOptions(history),result:null,error:'取得できませんでした'}))
  assert.ok(html.includes('role="alert"'));assert.ok(!html.includes('全0件'));assert.ok(!html.includes('開催予定はありません'))
 }
})
