import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const plain = v => JSON.parse(JSON.stringify(v))
function compile(file,deps={},globals={}) {
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,URL,...globals,require(name){assert.ok(Object.hasOwn(deps,name),`Unexpected dependency ${name}`);return deps[name]}});return exports
}
const lifecycle=compile('lib/event-groups/lifecycle.ts')
const group={id:7,title:'Synthetic occurrence',is_cancelled:false,is_hidden:false,registration_open:true,state_version:2}
function api({auth={ok:true},row=group,count=3,countError=null,rpcError=null,rpcData={...group,is_hidden:true,registration_open:false,state_version:3}}={}) {
 const calls=[];const client={from(table){calls.push(['from',table]);const q={};for(const name of ['select','eq'])q[name]=(...args)=>{calls.push([name,...args]);return q};q.maybeSingle=async()=>({data:row,error:null});q.then=(resolve,reject)=>Promise.resolve({count,error:countError}).then(resolve,reject);return q},async rpc(name,args){calls.push(['rpc',name,plain(args)]);return{data:rpcData,error:rpcError}}}
 const code=compile('app/api/admin/event-groups/[id]/state/route.ts',{'next/server':{NextResponse:{json:(body,options={})=>({body,status:options.status??200,headers:options.headers})}},'@/lib/supabase/require-admin':{requireAdmin:async()=>auth},'@/lib/supabase/server':{createClient:async()=>client},'@/lib/event-groups/lifecycle':lifecycle})
 const context={params:Promise.resolve({id:'7'})}
 return{calls,get:()=>code.GET({},context),patch:(body={action:'hide',expected_state_version:2},origin='https://preview.invalid',extra={})=>code.PATCH(new Request('https://preview.invalid/api/admin/event-groups/7/state',{method:'PATCH',headers:{origin,'Content-Type':'application/json',...extra},body:JSON.stringify(body)}),context)}
}
for(const status of [401,403])test(`state GET/PATCH reject authorization ${status} before DB access`,async()=>{const c=api({auth:{ok:false,status,error:'Denied'}});assert.equal((await c.get()).status,status);assert.equal((await c.patch()).status,status);assert.equal(c.calls.length,0)})
test('state GET returns exact history count using HEAD, never applicant data',async()=>{const c=api(),r=await c.get();assert.equal(r.status,200);assert.equal(r.body.registrationCount,3);assert.ok(c.calls.some(v=>v[0]==='select'&&v[1]==='id'&&v[2].head===true&&v[2].count==='exact'));assert.doesNotMatch(JSON.stringify(r.body),/contact|password|token/)})
for(const count of [null,-1,1.5])test(`unknown history count ${count} fails closed`,async()=>assert.equal((await api({count}).get()).status,503))
test('state missing group and count failure are safe',async()=>{assert.equal((await api({row:null}).get()).status,404);assert.equal((await api({countError:{message:'PRIVATE'}}).get()).status,503)})
test('PATCH uses one RPC scoped by ID and expected version',async()=>{const c=api();assert.equal((await c.patch()).status,200);assert.deepEqual(c.calls,[['rpc','admin_set_event_group_state',{p_group_id:7,p_action:'hide',p_expected_version:2}]])})
for(const body of [{action:'uncancel',expected_state_version:2},{action:'hide'},{action:'hide',expected_state_version:-1},{action:'hide',expected_state_version:'2'},{action:'hide',expected_state_version:2,registration_open:true},null])test(`invalid state command ${JSON.stringify(body)}`,async()=>{const c=api();assert.equal((await c.patch(body)).status,400);assert.equal(c.calls.length,0)})
test('invalid Origin and cross-site requests cannot mutate',async()=>{const c=api();assert.equal((await c.patch(undefined,'https://other.invalid')).status,403);assert.equal((await c.patch(undefined,'https://preview.invalid',{'sec-fetch-site':'cross-site'})).status,403);assert.equal(c.calls.length,0)})
for(const [code,status] of [['PT409',409],['40001',409],['PT404',404],['42501',403],['XX000',503]])test(`state RPC failure ${code} maps safely`,async()=>{const r=await api({rpcError:{code,message:'PRIVATE_SECRET'}}).patch();assert.equal(r.status,status);assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE_SECRET/)})
test('malformed or unsafe success cannot appear as successful',async()=>{assert.equal((await api({rpcData:group}).patch()).status,503);assert.equal((await api({rpcData:null}).patch()).status,503)})
function screen({count=3,status=200,confirm=true,patchStatus=200}={}) {
 const slots=[],calls=[],confirmations=[];let cursor=0,updated=0
 const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],v=>slots[i]=v]},useRef(initial){const i=cursor++;return slots[i]??={current:initial}}}
 const jsx=(type,props)=>({type,props});const Component=compile('app/(app)/admin/event-groups/occurrence-state.tsx',{react,'react/jsx-runtime':{jsx,jsxs:jsx},'@/lib/event-groups/lifecycle':lifecycle},{window:{confirm:text=>{confirmations.push(text);return confirm}},fetch:async(url,options={})=>{calls.push({url,options});return{ok:(options.method?patchStatus:status)===200,status:options.method?patchStatus:status,json:async()=>options.method?{eventGroup:{...group,is_hidden:true,registration_open:false,state_version:3}}:{eventGroup:group,registrationCount:count}}}}).default
 const nodes=n=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==='object'?[n,...nodes(n.props?.children)]:[]
 const render=()=>{cursor=0;return nodes(Component({group,onUpdated:()=>updated++}))}
 return{calls,confirmations,render,updated:()=>updated,click:label=>render().find(n=>n.type==='button'&&n.props.children===label).props.onClick()}
}
test('confirmation includes title, all history count and cancellation warning; success reloads',async()=>{const c=screen();await c.click('一覧から非表示にする');await new Promise(r=>setImmediate(r));assert.equal(c.confirmations.length,1);assert.match(c.confirmations[0],/Synthetic occurrence/);assert.match(c.confirmations[0],/3件/);assert.match(c.confirmations[0],/自動取消されません/);assert.match(c.confirmations[0],/連絡は別途必要/);assert.equal(c.updated(),1);assert.equal(c.calls.length,2);assert.equal(JSON.parse(c.calls[1].options.body).expected_state_version,2)})
test('declined confirmation and unknown counts send no PATCH',async()=>{for(const options of [{confirm:false},{count:null},{status:503}]){const c=screen(options);await c.click('一覧から非表示にする');await new Promise(r=>setImmediate(r));assert.equal(c.calls.length,1);assert.equal(c.updated(),0)}})
test('409 does not auto retry or claim success',async()=>{const c=screen({patchStatus:409});await c.click('一覧から非表示にする');await new Promise(r=>setImmediate(r));assert.equal(c.calls.length,2);assert.equal(c.updated(),0);assert.ok(c.render().some(n=>n.props?.role==='alert'))})
test('schedule delegates public visibility to the anonymous server loader', async()=>{
 const jsx=(type,props)=>({type,props})
 let loaded=0
 const Component=compile('app/(app)/schedule/page.tsx',{'react/jsx-runtime':{jsx,jsxs:jsx},'next/link':{default:()=>null},'./schedule.module.css':{default:{}},'@/lib/schedule/public-schedule':{loadScheduleIndex:async()=>{loaded++;return[{key:'schedule-3',title:'Unassigned',period:'2030-01-02',place:'Other venue',type:'稽古会',href:null}]}}}).default
 const text=n=>Array.isArray(n)?n.map(text).join(''):n&&typeof n==='object'?text(n.props?.children):typeof n==='string'?n:''
 const output=text(await Component())
 assert.equal(loaded,1);assert.match(output,/Unassigned/);assert.match(output,/Other venue/)
})
