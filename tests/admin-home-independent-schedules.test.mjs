import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
const plain = v => JSON.parse(JSON.stringify(v))
function compile(file, deps = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, ...globals, require(name) { assert.ok(name in deps, `Unexpected dependency: ${name}`); return deps[name] } })
  return exports
}
function nodes(tree) { if (Array.isArray(tree)) return tree.flatMap(nodes); return tree && typeof tree === 'object' ? [tree,...nodes(tree.props?.children)] : [] }
function hooks() {
  const state=[],refs=[],effects=[];let s=0,r=0,e=0
  const react={useState(initial){const i=s++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],v=>state[i]=typeof v==='function'?v(state[i]):v]},useRef(v){return refs[r++]??={current:v}},useEffect(fn,deps){const i=e++,old=effects[i];if(!old||deps.some((v,j)=>v!==old.deps[j]))effects[i]={fn,deps}},useLayoutEffect(fn){fn()},useMemo:fn=>fn(),useCallback:fn=>fn}
  return {react,state,render(Component,props={}){s=0;r=0;e=0;return nodes(Component(props))},flush(i){return effects[i].fn()}}
}
const Link='Link'
const managementLinks=[['/admin/event-groups','開催回管理'],['/admin/registrations','申込者管理'],['/admin/schedules','予定管理'],['/admin/videos','動画管理'],['/admin/event-groups/history','開催記録・履歴'],['/admin/passwords','パスワード管理']]
for(const status of [401,403,200])test(`admin home boundary and six exact links: ${status}`,async()=>{
 let authorized=0
 const Page=compile('app/(app)/admin/page.tsx',{'next/link':{default:Link},'next/navigation':{redirect(path){throw Error(`REDIRECT:${path}`)}},'@/lib/supabase/require-admin':{requireAdmin:async()=>{authorized++;return status===200?{ok:true}:{ok:false,status}}},'./event-groups/admin-index.module.css':{default:{}},'react/jsx-runtime':jsxRuntime})
 assert.equal(Page.dynamic,'force-dynamic');assert.equal(Page.revalidate,0)
 if(status!==200)await assert.rejects(Page.default(),new RegExp(`REDIRECT:${status===401?'/login':'/videos'}`))
 else{
  const tree=nodes(await Page.default())
  assert.deepEqual(tree.filter(n=>n.type===Link).map(n=>[n.props.href,n.props.children]),managementLinks)
  assert.ok(tree.filter(n=>n.type===Link).every(n=>n.props.prefetch===false))
 }
 assert.equal(authorized,1)
})
test('admin header has one home link, only current on the actual admin home',()=>{
 let pathname='/admin';const h=hooks()
 const Layout=compile('app/(app)/layout.tsx',{react:h.react,'react/jsx-runtime':jsxRuntime,'next/link':{default:Link},'next/navigation':{useRouter:()=>({}),usePathname:()=>pathname},'@/lib/supabase/client':{createClient:()=>({})}}).default
 h.render(Layout);h.state[0]={checked:true,logged:true,admin:true}
 for(const path of ['/admin','/admin/schedules','/admin/event-groups']){
  pathname=path;const home=h.render(Layout).filter(n=>n.type===Link&&n.props.href==='/admin')
  assert.equal(home.length,1);assert.equal(home[0].props.children,'管理ホーム');assert.equal(home[0].props['aria-current'],path==='/admin'?'page':undefined)
 }
 h.state[0]={checked:true,logged:true,admin:false};assert.equal(h.render(Layout).some(n=>n.props?.href==='/admin'),false)
})
const independent={id:1,title:'独立予定',date:'2030-01-01',start_time:'10:00',end_time:'11:00',location:'独立会場',type:'稽古会',event_group_id:null,capacity:20,registration_enabled:false}
const linked={...independent,id:2,title:'所属クラス',event_group_id:8,event_groups:null}
const validation=compile('lib/schedules/new-schedule.ts')
const restrictions=compile('lib/schedules/edit-schedule.ts')
const deletion=compile('app/(app)/admin/schedule-deletion.ts')
function tools({rows=[independent,linked],status={event_group_id:null,hasRegistrationHistory:false,activeRegistrationCount:0},movedBeforeDelete=false}={}){
 const h=hooks(),calls=[];let latest=status
 const client={from(table){calls.push(['from',table]);let removing=false;const filters=[];const q={
  select(columns){calls.push(['select',columns]);return q},is(k,v){calls.push(['is',k,v]);filters.push(row=>row[k]===v);return q},eq(k,v){calls.push(['eq',k,v]);filters.push(row=>row[k]===v);return q},delete(){calls.push(['delete']);removing=true;return q},
  order:async()=>({data:table==='schedules'?rows.filter(row=>filters.every(f=>f(row))):[]}),
  then(resolve,reject){const current=movedBeforeDelete?rows.map(row=>({...row,event_group_id:8})):rows;return Promise.resolve({data:removing?current.filter(row=>filters.every(f=>f(row))).map(row=>({id:row.id})):[],error:null}).then(resolve,reject)}
 };return q}}
 const NewForm=()=>null,EditFields=()=>null
 const Component=compile('app/(app)/admin/management-tools.tsx',{react:h.react,'react/jsx-runtime':jsxRuntime,'next/link':{default:Link},'next/navigation':{useRouter:()=>({})},'@/lib/supabase/client':{createClient:()=>client},'./schedule-registration-status':{useScheduleRegistrationStatuses:()=>({statuses:latest?{'1':latest}:{},loading:false,error:'',refresh(){calls.push(['refresh'])}}),ScheduleRegistrationStatus:()=>null},'./schedule-deletion':deletion,'./new-schedule-form':{default:NewForm},'./edit-schedule-fields':{default:EditFields},'@/lib/schedules/new-schedule':validation,'@/lib/schedules/edit-schedule':restrictions},{FormData:class{constructor(values){this.values=values}get(k){return this.values[k]??null}},fetch:async(url,options)=>{calls.push(['fetch',url,plain(JSON.parse(options.body))]);return{ok:true}},confirm:()=>true,setTimeout(){}}).default
 const render=()=>h.render(Component,{initialTab:'schedules'});render();h.state[1]=true;h.state[2]=false
 return{h,calls,render,NewForm,EditFields,setStatus(value){latest=value}}
}
test('schedule query scopes independent rows on server and UI excludes linked/orphan/missing-scope records',async()=>{
 const c=tools();c.render();c.h.flush(2);await new Promise(resolve=>setImmediate(resolve))
 assert.ok(c.calls.some(call=>call[0]==='is'&&call[1]==='event_group_id'&&call[2]===null))
 assert.equal(c.h.state[4].length,1)
 c.h.state[4]=[independent,linked,{...linked,id:3,event_group_id:undefined}]
 const tree=c.render();assert.equal(tree.filter(n=>n.props?.className==='list-title').length,1)
 assert.equal(tree.find(n=>n.type===c.NewForm).props.independentOnly,true)
})
test('independent edit preserves capacity and scope despite injected group/enable form values',async()=>{
 const c=tools();c.h.state[4]=[independent]
 c.render().find(n=>n.type==='button'&&n.props.children==='編集').props.onClick()
 const tree=c.render();assert.equal(tree.find(n=>n.type===c.EditFields).props.independentOnly,true)
 await tree.find(n=>n.type==='form').props.onSubmit({preventDefault(){},currentTarget:{edit_event_group_id:'8',edit_capacity:'20',edit_registration_enabled:'true'}})
 const call=c.calls.find(call=>call[0]==='fetch');assert.equal(call[1],'/api/admin/schedules/1')
 assert.equal(call[2].event_group_id,null);assert.equal(call[2].registration_enabled,false);assert.equal(call[2].capacity,20);assert.equal(call[2].expected.event_group_id,null)
})
for(const value of [8,undefined])test(`a changed or unknown latest scope blocks editing: ${value}`,async()=>{
 const c=tools();c.h.state[4]=[independent];c.render().find(n=>n.type==='button'&&n.props.children==='編集').props.onClick()
 c.setStatus({event_group_id:value,hasRegistrationHistory:false,activeRegistrationCount:0})
 const tree=c.render();await tree.find(n=>n.type==='form').props.onSubmit({preventDefault(){},currentTarget:{edit_capacity:'20'}})
 assert.equal(c.calls.some(call=>call[0]==='fetch'),false)
})
for(const row of [linked,{...independent,registration_enabled:true}])test(`invalid stale editor cannot update ${row.title}/${row.registration_enabled}`,async()=>{
 const c=tools();c.h.state[8]=row
 const tree=c.render();await tree.find(n=>n.type==='form').props.onSubmit({preventDefault(){},currentTarget:{edit_capacity:'20'}})
 assert.equal(c.calls.some(call=>call[0]==='fetch'),false)
})
test('existing safe independent delete remains scoped even if group membership changes before deletion',async()=>{
 for(const movedBeforeDelete of [false,true]){
  const c=tools({movedBeforeDelete});c.h.state[4]=[independent]
  await c.render().find(n=>n.type==='button'&&n.props.children==='削除').props.onClick()
  assert.ok(c.calls.some(call=>call[0]==='delete'))
  assert.ok(c.calls.some(call=>call[0]==='is'&&call[1]==='event_group_id'&&call[2]===null))
  if(movedBeforeDelete)assert.ok(c.render().some(n=>n.props?.role==='alert'&&typeof n.props.children==='string'&&n.props.children.includes('削除を確認できません')))
 }
})
for(const status of [undefined,{event_group_id:null,hasRegistrationHistory:true,activeRegistrationCount:0},{event_group_id:8,hasRegistrationHistory:false,activeRegistrationCount:0}])test(`unknown/history/linked state blocks deletion ${JSON.stringify(status)}`,async()=>{
 const c=tools({status:status??null});c.h.state[4]=[independent]
 const tree=c.render();assert.equal(tree.find(n=>n.type==='button'&&n.props.children==='削除').props.disabled,true)
})
test('independent editor keeps stored capacity, omits group/registration controls, and skips group fetch',()=>{
 const h=hooks();const Fields=compile('app/(app)/admin/edit-schedule-fields.tsx',{react:h.react,'react/jsx-runtime':jsxRuntime,'./new-schedule-fields':{loadAllEventGroups(){assert.fail('Unneeded group read')}}}).default
 const tree=h.render(Fields,{independentOnly:true,schedule:independent,history:{hasRegistrationHistory:false,activeRegistrationCount:0},historyLoading:false,historyError:''})
 h.flush(0);assert.equal(tree.some(n=>n.type==='select'||n.props?.type==='checkbox'),false)
 assert.equal(tree.find(n=>n.props?.id==='edit-schedule-capacity').props.value,'20')
 assert.equal(tree.find(n=>n.props?.name==='edit_event_group_id').props.value,'')
 assert.equal(tree.find(n=>n.props?.name==='edit_registration_enabled').props.value,'false')
})
