import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsx from 'react/jsx-runtime'
function compile(file,deps,globals={}) {
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,URLSearchParams,...globals,require(name){assert.ok(name in deps,`Unexpected ${name}`);return deps[name]}});return exports
}
const presentation=compile('lib/event-groups/presentation.ts',{})
const index=compile('lib/event-groups/admin-index.ts',{'./presentation':presentation})
const model=compile('lib/registrations/admin-browser.ts',{'@/lib/event-groups/presentation':presentation})
const {loadBrowser}=compile('lib/registrations/admin-browser-server.ts',{'server-only':{},'@/lib/supabase/server':{},'@/lib/event-groups/presentation':presentation,'@/lib/event-groups/admin-index':index,'./admin-browser':model})
const options=query=>model.readOptions(new URLSearchParams(query))
const plain=value=>JSON.parse(JSON.stringify(value))
const group=(id,changes={})=>({id,title:'同名開催',city:'東京',start_date:'2030-01-01',end_date:'2030-01-01',is_cancelled:false,is_hidden:false,...changes})
const schedule=(id,event_group_id=1,changes={})=>({id,event_group_id,title:'同名クラス',date:'2030-01-01',start_time:'10:00',...changes})
const parent=(id,changes={})=>({id,event_group_id:1,name:'同名申込者',contact:'synthetic@example.invalid',notes:null,created_at:'2026-10-26T00:00:00.123456+00:00',event_groups:{id:1,title:'同名開催'},...changes})
const item=(id,changes={})=>({id,registration_id:1,event_group_id:1,schedule_id:10,status:'active',created_at:'2026-10-26T00:00:00.123456+00:00',cancelled_at:null,...changes})
// In-memory read-only PostgREST double: no credentials, network, SQL or mutation methods.
function database(tables,alter) {
 const calls=[]
 return {calls,from(table){let data=[...(tables[table]??[])],fields='',opts={},start=0,end=Infinity,single=false,orders=[],filters=[]
  const q={select(value,options={}){fields=value;opts=options;return q},eq(key,value){filters.push([key,value]);data=data.filter(row=>key==='registration.name'?true:row[key]===value);return q},in(key,values){data=data.filter(row=>values.includes(row[key]));return q},ilike(key,value){filters.push([key,value]);data=data.filter(row=>{const name=(tables.registrations??[]).find(p=>p.id===row.registration_id)?.name;const literal=value.slice(1,-1).replace(/\\([\\%_])/g,'$1');return name?.toLowerCase().includes(literal.toLowerCase())});return q},or(value){filters.push(['or',value]);const match=/^created_at.lt.(.+),and\(created_at.eq.(.+),id.lt.(\d+)\)$/.exec(value);assert.ok(match);assert.equal(match[1],match[2]);data=data.filter(row=>row.created_at<match[1]||(row.created_at===match[1]&&row.id<Number(match[3])));return q},order(key,options={}){orders.push([key,options.ascending!==false]);return q},range(a,b){start=a;end=b;return q},maybeSingle(){single=true;return q},then(resolve,reject){
   const call={table,fields,opts,start,end,orders,filters};calls.push(call)
   data.sort((a,b)=>{for(const [key,asc] of orders){const n=String(a[key]??'').localeCompare(String(b[key]??''),undefined,{numeric:true});if(n)return asc?n:-n}return 0})
   let rows=data.slice(start,end+1).map(row=>({...row}))
   if(table==='registration_items')rows=rows.map(row=>({...row,registration:tables.registrations?.find(p=>p.id===row.registration_id)??null,schedules:tables.schedules?.find(s=>s.id===row.schedule_id)??null}))
   let result={data:opts.head?null:single?(rows[0]??null):rows,count:opts.count?data.length:null,error:null};if(alter)result=alter(call,result)
   return Promise.resolve(result).then(resolve,reject)
  }};return q
 }}
}
test('strict resources, IDs, duplicate params, cursor and search validation',()=>{
 assert.equal(options('').resource,'groups');assert.equal(options('resource=items&group=1&schedule=2').state,'all')
 for(const query of ['resource=write','resource=groups&scope=bad','page=0','page=10001','page=1&page=2','resource=items&group=0&schedule=1','resource=classes&group=1.2','resource=items&group=1&schedule=2&state=bad','resource=items&group=1&schedule=2&q='+encodeURIComponent('\n'),'resource=history&cursor='+encodeURIComponent('2026-02-30T00:00:00Z|1'),'resource=history&cursor='+encodeURIComponent('2026-01-01T00:00:00Z|1),id.gt.0')]) assert.throws(()=>options(query),query)
 assert.equal(model.makeCursor(parent(9)),'2026-10-26T00:00:00.123456+00:00|9')
 assert.equal(model.escapedName('a%_\\'),'%'+'a\\%\\_\\\\'+'%')
})
test('occurrences are complete before classification/pagination; duplicate names stay separate',async()=>{
 const groups=[group(1),group(2,{start_date:'2029-12-31',end_date:'2029-12-31'}),group(3,{is_hidden:true}),group(4,{is_cancelled:true}),group(5,{end_date:'2030-01-02'}),group(6,{start_date:'2020-01-01',end_date:'2020-01-01'})]
 const db=database({event_groups:groups,schedules:groups.map(g=>schedule(g.id,g.id,{date:g.start_date}))})
 const upcoming=await loadBrowser(options(''),db,'2029-12-30');assert.deepEqual(plain(upcoming.items.map(g=>g.id)),[2,1])
 const all=await loadBrowser(options('scope=all'),db,'2029-12-30');assert.equal(all.total,6);assert.equal(all.items.at(-1).id,5)
 for(const [scope,id] of [['ended',6],['cancelled',4],['hidden',3],['review',5]])assert.ok((await loadBrowser(options('scope='+scope),db,'2029-12-30')).items.some(g=>g.id===id))
 assert.ok(db.calls.every(c=>['event_groups','schedules'].includes(c.table)))
})
test('group scans exceed the usual 1000 row cap, with explicit 20-row pages',async()=>{
 const db=database({event_groups:Array.from({length:1001},(_,i)=>group(i+1))})
 const result=await loadBrowser(options('page=51'),db,'2029-01-01');assert.equal(result.total,1001);assert.equal(result.items.length,1);assert.equal(result.items[0].id,1001)
})
test('class counts are exact HEAD counts, scoped by both IDs; cancellation and reapplication count separately',async()=>{
 const data={event_groups:[group(1),group(2)],schedules:[schedule(10),schedule(11),schedule(12,2)],registration_items:[item(1),item(2,{status:'cancelled'}),item(3),item(4,{schedule_id:11}),item(5,{event_group_id:2,schedule_id:12})]}
 const db=database(data);const result=await loadBrowser(options('resource=classes&group=1'),db)
 assert.deepEqual(plain(result.items.map(c=>[c.id,c.active_items[0].count,c.cancelled_items[0].count])),[[10,2,1],[11,1,0]])
 assert.equal(db.calls.filter(c=>c.opts.head).length,4);assert.ok(db.calls.filter(c=>c.opts.head).every(c=>c.opts.count==='exact'))
})
test('class list paginates independently and cannot read a class from another occurrence',async()=>{
 const db=database({event_groups:[group(1)],schedules:Array.from({length:21},(_,i)=>schedule(i+1))})
 const result=await loadBrowser(options('resource=classes&group=1&page=2'),db);assert.equal(result.total,21);assert.equal(result.items.length,1)
 await assert.rejects(loadBrowser(options('resource=items&group=1&schedule=999'),db),/class unavailable/)
})
test('item filters, exact count, names and parent/item identity are server-side; missing parent retained',async()=>{
 const db=database({event_groups:[group(1)],schedules:[schedule(10)],registrations:[parent(1),parent(2)],registration_items:[item(1),item(2,{registration_id:2,status:'cancelled'}),item(3,{registration_id:999})]})
 const all=await loadBrowser(options('resource=items&group=1&schedule=10'),db);assert.equal(all.total,3);assert.equal(all.items.find(i=>i.id===3).registration,null)
 const found=await loadBrowser(options('resource=items&group=1&schedule=10&q=同名&state=cancelled'),db);assert.equal(found.total,1);assert.equal(found.items[0].id,2);assert.equal(found.items[0].registration.id,2)
 assert.ok(db.calls.some(c=>c.fields.includes('!inner')&&c.filters.some(f=>f[0]==='registration.name')))
})
test('keyset pagination preserves microseconds and ties, and new applications do not displace the next page',async()=>{
 const tables={event_groups:[group(1)],schedules:[schedule(10)],registrations:[parent(1)],registration_items:Array.from({length:1250},(_,i)=>item(i+1))}
 const db=database(tables),first=await loadBrowser(options('resource=items&group=1&schedule=10'),db)
 assert.equal(first.total,1250);assert.equal(first.items.length,50);assert.equal(first.items.at(-1).id,1201)
 tables.registration_items.push(item(2000))
 const second=await loadBrowser(options('resource=items&group=1&schedule=10&cursor='+encodeURIComponent(first.nextCursor)),db)
 assert.equal(second.total,1251);assert.equal(second.items[0].id,1200);assert.equal(second.items.at(-1).id,1151)
 assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,100)
})
test('all history reads every child beyond 1000; unresolved class/group, cancelled rows and zero-item parents remain',async()=>{
 const tables={registrations:[parent(1,{event_groups:null}),parent(2)],registration_items:Array.from({length:1201},(_,i)=>item(i+1,{status:i%2?'cancelled':'active',schedule_id:999}))}
 const db=database(tables),result=await loadBrowser(options('resource=history'),db)
 assert.equal(result.total,2);assert.equal(result.registrations.find(p=>p.id===1).registration_items.length,1201);assert.equal(result.registrations.find(p=>p.id===2).registration_items.length,0)
 assert.equal(result.registrations.find(p=>p.id===1).event_groups,null);assert.equal(result.registrations.find(p=>p.id===1).registration_items[0].schedules,null)
 assert.equal(db.calls.filter(c=>c.table==='registration_items').length,3)
})
test('parent history cursor is stable when a new parent is inserted between pages',async()=>{
 const tables={registrations:Array.from({length:60},(_,i)=>parent(i+1))};const db=database(tables)
 const first=await loadBrowser(options('resource=history'),db);tables.registrations.push(parent(100))
 const second=await loadBrowser(options('resource=history&page=2&cursor='+encodeURIComponent(first.nextCursor)),db)
 assert.equal(second.total,61);assert.equal(second.registrations.length,10);assert.equal(second.registrations[0].id,10)
})
for(const resource of ['groups','classes','items','history'])test(`incomplete ${resource} fails rather than hiding data`,async()=>{
 const tables={event_groups:[group(1)],schedules:[schedule(10)],registrations:[parent(1)],registration_items:[item(1)]}
 const target=resource==='groups'?'event_groups':resource==='classes'?'schedules':'registration_items'
 const db=database(tables,(call,result)=>call.table===target&&!call.opts.head&&!call.fields.endsWith('id')?{...result,data:Array.isArray(result.data)?[]:result.data}:result)
 const query=resource==='groups'?'':resource==='history'?'resource=history':`resource=${resource}&group=1${resource==='items'?'&schedule=10':''}`
 await assert.rejects(loadBrowser(options(query),db))
})
test('count failures and changing child totals fail closed',async()=>{
 const tables={event_groups:[group(1)],schedules:[schedule(10)],registrations:[parent(1)],registration_items:Array.from({length:501},(_,i)=>item(i+1))}
 await assert.rejects(loadBrowser(options('resource=classes&group=1'),database(tables,(c,r)=>c.opts.head?{...r,count:null}:r)))
 await assert.rejects(loadBrowser(options('resource=history'),database(tables,(c,r)=>c.table==='registration_items'&&c.start>0?{...r,count:502}:r)))
})
test('Tokyo midnight and invalid dates classify histories without guessing',()=>{
 assert.equal(presentation.tokyoDay(new Date('2026-10-26T14:59:59Z')),'2026-10-26');assert.equal(presentation.tokyoDay(new Date('2026-10-26T15:00:00Z')),'2026-10-27')
 assert.equal(index.classifyIndex(group(1,{start_date:'2026-10-26',end_date:'2026-10-26'}),['2026-10-26'],'2026-10-26').phase,'upcoming')
 assert.equal(index.classifyIndex(group(1,{start_date:'2026-10-26',end_date:'2026-10-26'}),['2026-10-26'],'2026-10-27').phase,'ended')
 assert.equal(index.classifyIndex(group(1,{end_date:'2030-02-30'}),[],'2030-01-01').phase,'unknown')
})
for(const status of [401,403,200])test(`read route authorization before query and private/no-store: ${status}`,async()=>{
 const calls=[];const api=compile('app/api/admin/registration-browser/route.ts',{'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status??200,headers:init.headers})}},'@/lib/supabase/require-admin':{requireAdmin:async()=>{calls.push('auth');return status===200?{ok:true}:{ok:false,status}}},'@/lib/supabase/server':{createClient:async()=>{calls.push('client');return {}}},'@/lib/registrations/admin-browser':model,'@/lib/registrations/admin-browser-server':{loadBrowser:async()=>{calls.push('read');return {items:[],total:0}}}})
 const response=await api.GET({nextUrl:{searchParams:new URLSearchParams()}});assert.equal(response.status,status);assert.equal(response.headers['Cache-Control'],'private, no-store, max-age=0');assert.equal(response.headers.Vary,'Cookie');assert.deepEqual(calls,status===200?['auth','client','read']:['auth'])
 assert.deepEqual(Object.keys(api).sort(),['GET','dynamic'])
})
test('read route validates before DB and redacts internal errors',async()=>{
 let reads=0;const api=compile('app/api/admin/registration-browser/route.ts',{'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status??200})}},'@/lib/supabase/require-admin':{requireAdmin:async()=>({ok:true})},'@/lib/supabase/server':{createClient:async()=>{reads++;return {}}},'@/lib/registrations/admin-browser':model,'@/lib/registrations/admin-browser-server':{loadBrowser:async()=>{throw new Error('SECRET INTERNAL')}}})
 assert.equal((await api.GET({nextUrl:{searchParams:new URLSearchParams('resource=items&group=bad')}})).status,400);assert.equal(reads,0)
 const response=await api.GET({nextUrl:{searchParams:new URLSearchParams()}});assert.equal(response.status,503);assert.doesNotMatch(JSON.stringify(response.body),/SECRET/)
})

function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);if(!tree||typeof tree!=='object')return [];return [tree,...nodes(tree.props?.children)]}
function hooks(){const state=[],effects=[];let s=0,e=0
 return {state,react:{useState(value){const i=s++;if(!(i in state))state[i]=typeof value==='function'?value():value;return [state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value}]},useEffect(fn,deps){const i=e++,old=effects[i];if(!old||deps.some((v,j)=>v!==old.deps[j]))effects[i]={fn,deps,pending:true,cleanup:old?.cleanup}}},render(Component,props={}){s=0;e=0;return nodes(Component(props))},flush(){for(const effect of effects)if(effect.pending){effect.cleanup?.();effect.cleanup=effect.fn();effect.pending=false}},unmount(){for(const effect of effects)effect.cleanup?.()}}
}
function browser(fetcher){const h=hooks(),Details=()=>null,Add=()=>null,Cancel=()=>null
 const Browser=compile('app/(app)/admin/registrations/registration-browser.tsx',{'next/link':{default:'Link'},react:h.react,'react/jsx-runtime':jsx,'@/lib/event-groups/admin-index':index,'./registration-details-form':{default:Details},'./add-registration-items':{default:Add},'./cancel-registration-item':{default:Cancel},'./registrations.module.css':{default:{}}},{fetch:fetcher,AbortController}).default
 return {h,Details,Add,Cancel,render:()=>h.render(Browser)}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function groupedFetch(calls,fail=false){return async(url,init)=>{
 calls.push([url,init]);const p=new URL(url,'http://synthetic.invalid').searchParams,resource=p.get('resource')
 if(fail)return {ok:false,status:503}
 const data=resource==='groups'?{items:[index.classifyIndex(group(1),['2030-01-01'],'2026-10-26'),index.classifyIndex(group(2),['2030-01-01'],'2026-10-26')],total:2,page:1,pageSize:20}:resource==='classes'?{group:{id:1,title:'同名開催'},items:[{...schedule(10),active_items:[{count:2}],cancelled_items:[{count:1}]}],total:1,page:1,pageSize:20}:{items:[item(1,{registration:parent(1)}),item(2,{registration:parent(2),registration_id:2,status:'cancelled'}),item(3,{registration:parent(1),status:'cancelled'}),item(4,{registration_id:999,registration:null})],total:4,pageSize:50,nextCursor:'2026-10-26T00:00:00.123456+00:00|1'}
 return {ok:true,json:async()=>data}
}}
async function selectClass(context){context.render();context.h.flush();await tick();let tree=context.render();tree.find(n=>n.props?.['aria-pressed']===false).props.onClick();context.render();context.h.flush();await tick();tree=context.render();tree.find(n=>n.props?.['aria-pressed']===false&&String(n.props.children?.[1]?.props?.children).includes('クラスID')).props.onClick();context.render();context.h.flush();await tick();return context.render()}
test('grouped browser retains IDs, prevents stale selection, reuses existing writers, and refreshes after success only',async()=>{
 const calls=[],context=browser(groupedFetch(calls));let tree=await selectClass(context)
 const cancellations=tree.filter(n=>n.type===context.Cancel);assert.equal(cancellations.length,4);assert.equal(cancellations[0].props.itemId,1);assert.equal(cancellations[3].props.disabled,true)
 const edits=tree.filter(n=>n.type==='button'&&n.props.children==='情報を編集');assert.equal(edits.length,2) // duplicate name parents distinct; same parent history has one edit control
 edits[1].props.onClick();tree=context.render();assert.equal(tree.find(n=>n.type===context.Details).props.registration.id,2)
 const before=calls.length;tree.find(n=>n.type===context.Details).props.onCancel();context.render();context.h.flush();await tick();assert.equal(calls.length,before)
 context.render().find(n=>n.type==='button'&&n.props.children==='情報を編集').props.onClick();context.render().find(n=>n.type===context.Details).props.onSaved();context.render();context.h.flush();await tick();tree=context.render()
 assert.ok(calls.length>before);assert.ok(tree.some(n=>n.props?.id==='class-applicants-title'))
 tree.find(n=>n.type==='button'&&n.props.children==='クラスを追加').props.onClick();tree=context.render();assert.equal(tree.find(n=>n.type===context.Add).props.registrationId,1);tree.find(n=>n.type===context.Add).props.onSaved();context.render();context.h.flush();await tick()
 context.render().find(n=>n.type===context.Cancel).props.onCancelled();context.render();context.h.flush();await tick()
 assert.ok(calls.every(([,init])=>init.cache==='no-store'&&!init.method))
 context.h.unmount()
})
test('search/status and cursor navigation generate server filters, reset correctly, and preserve class selection',async()=>{
 const calls=[],context=browser(groupedFetch(calls));let tree=await selectClass(context)
 tree.find(n=>n.props?.id==='participant-search').props.onChange({target:{value:'同名'}});context.render().find(n=>n.type==='form').props.onSubmit({preventDefault(){}});context.render();context.h.flush();await tick()
 assert.ok(calls.at(-1)[0].includes('q='+encodeURIComponent('同名')))
 tree=context.render();tree.find(n=>n.props?.id==='item-state').props.onChange({target:{value:'cancelled'}});context.render();context.h.flush();await tick();assert.ok(calls.at(-1)[0].includes('state=cancelled'))
 tree=context.render();tree.find(n=>n.type==='button'&&n.props.children==='次のページ').props.onClick();context.render();context.h.flush();await tick();assert.ok(new URL(calls.at(-1)[0],'http://synthetic.invalid').searchParams.get('cursor'))
 tree=context.render();tree.find(n=>n.type==='button'&&n.props.children==='前のページ').props.onClick();context.render();context.h.flush();await tick();assert.equal(new URL(calls.at(-1)[0],'http://synthetic.invalid').searchParams.get('cursor'),'')
 context.h.unmount()
})
test('zero results and read errors are distinct and old rows are hidden while reloading',async()=>{
 const calls=[],context=browser(groupedFetch(calls));await selectClass(context)
 let tree=context.render();tree.find(n=>n.props?.id==='item-state').props.onChange({target:{value:'active'}});tree=context.render();assert.equal(tree.some(n=>n.type===context.Cancel),false)
 context.h.unmount()
 const failure=browser(groupedFetch([],true));failure.render();failure.h.flush();await tick();const failed=failure.render();const Notice=failed.find(n=>typeof n.type==='function'&&n.props?.error);assert.ok(Notice);assert.match(Notice.props.error,/取得できません/);assert.equal(failed.some(n=>String(n.props?.children).includes('該当する開催回はありません')),false);failure.h.unmount()
 const empty=browser(async()=>({ok:true,json:async()=>({items:[],total:0,page:1,pageSize:20})}));empty.render();empty.h.flush();await tick();assert.ok(empty.render().some(n=>n.props?.children==='該当する開催回はありません。'));empty.h.unmount()
})
test('default grouped view and history navigation remain admin guarded',async()=>{
 const Grouped=()=>null,History=()=>null
 const page=compile('app/(app)/admin/registrations/page.tsx',{'next/navigation':{redirect(){assert.fail()}},'@/lib/supabase/require-admin':{requireAdmin:async()=>({ok:true})},'./registration-list':{default:History},'./registration-browser':{default:Grouped},'next/link':{default:'Link'},'./registrations.module.css':{default:{}},'react/jsx-runtime':jsx})
 const current=nodes(await page.default());assert.ok(current.some(n=>n.type===Grouped));assert.equal(current.find(n=>n.props?.['aria-current']==='page').props.href,'/admin/registrations')
 const history=nodes(await page.default({searchParams:Promise.resolve({view:'history'})}));assert.ok(history.some(n=>n.type===History));assert.equal(history.find(n=>n.props?.['aria-current']==='page').props.href,'/admin/registrations?view=history')
})
test('history view reads the complete read endpoint and uses returned keyset cursor for page two',async()=>{
 const h=hooks(),calls=[];const List=compile('app/(app)/admin/registrations/registration-list.tsx',{react:h.react,'react/jsx-runtime':jsx,'next/link':{default:'Link'},'./registration-details-form':{default:()=>null},'./cancel-registration-item':{default:()=>null},'./add-registration-items':{default:()=>null},'./proxy-registration-form':{default:()=>null}},{AbortController,fetch:async(url)=>{calls.push(url);return {ok:true,json:async()=>({registrations:[],total:100,page:1,pageSize:50,nextCursor:'2026-10-26T00:00:00.123456+00:00|50'})}}}).default
 h.render(List);h.flush();await tick();let tree=h.render(List);tree.find(n=>n.type==='button'&&n.props.children==='次のページ').props.onClick();h.render(List);h.flush();await tick();assert.equal(new URL(calls.at(-1),'http://synthetic.invalid').searchParams.get('cursor'),'2026-10-26T00:00:00.123456+00:00|50');assert.match(calls[0],/resource=history/);h.unmount()
})
