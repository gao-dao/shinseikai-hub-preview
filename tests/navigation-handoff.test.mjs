import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsx from 'react/jsx-runtime'
function compile(file,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,URLSearchParams,require(name){assert.ok(name in deps,`Unexpected ${name}`);return deps[name]}});return exports}
function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);return tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[]}
const presentation=compile('lib/event-groups/presentation.ts'),index=compile('lib/event-groups/admin-index.ts',{'./presentation':presentation}),guide=compile('lib/event-groups/public-guide.ts',{'./presentation':presentation})
const history='/admin/event-groups/history', normal='/admin/event-groups'
for(const value of [undefined,null,[],['/admin/event-groups/history'],1,'https://evil.invalid/x','//evil.invalid','/admin/event-groups/history/../new','/admin/event-groups/history#x','/admin/event-groups/history\\evil','/%2f%2fevil.invalid','/admin/event-groups/history?next=https://evil.invalid','/admin/event-groups/history?page=0','/admin/event-groups/history?page=1001','/admin/event-groups/history?page=2&page=3','/admin/event-groups/history?state=bad','/admin/event-groups/history?q=%0a','/admin/event-groups/history?returnTo=x','/admin/event-groups/history?q='+ 'a'.repeat(101)])test(`invalid return target falls back: ${JSON.stringify(value)}`,()=>assert.equal(index.adminReturnHref(value),normal))
test('history target preserves validated search, state and page while canonicalizing encoding',()=>{
 const value=history+'?q='+encodeURIComponent('東京 & 大阪')+'&state=hidden&page=3'
 assert.equal(index.adminReturnHref(value),history+'?q='+encodeURIComponent('東京 & 大阪').replace(/%20/g,'+')+'&state=hidden&page=3')
 assert.equal(index.adminReturnHref(history),history);assert.equal(index.adminReturnHref(normal),normal)
})
const group=(changes={})=>({id:501,title:'対象開催回',description:'説明',city:'東京',start_date:'2030-01-01',end_date:'2030-01-01',registration_open:true,is_hidden:false,is_cancelled:false,...changes})
function db(g,dates=['2030-01-01'],fail=false){return {from(table){let data=table==='event_groups'?[g]:dates.map((date,i)=>({id:i+1,event_group_id:501,date,title:'クラス',start_time:'10:00',end_time:null,location:'会場'})),single=false,start=0,end=Infinity;const q={select(){return q},eq(k,v){data=data.filter(r=>r[k]===v);return q},gte(k,v){data=data.filter(r=>r[k]>=v);return q},not(k){data=data.filter(r=>r[k]!==null);return q},order(){return q},range(a,b){start=a;end=b;return q},maybeSingle(){single=true;return q},then(resolve,reject){return Promise.resolve({data:single?(data[0]??null):data.slice(start,end+1),count:data.length,error:fail?{}:null}).then(resolve,reject)}};return q}}}
function publicPage(loader){return compile('app/(public)/events/page.tsx',{'react/jsx-runtime':jsx,'next/link':{default:'Link'},'./events-list':{default:'EventsList'},'@/lib/event-groups/public-guide-server':{loadGuideDetail:loader,loadGuidePage(){assert.fail('No guide list scanning')}},'@/lib/event-groups/public-guide':guide,'./guide.module.css':{default:{}}}).default}
test('detail registration link carries the numeric occurrence ID',async()=>{
 const page=compile('app/(public)/events/[id]/page.tsx',{'react/jsx-runtime':jsx,'next/link':{default:'Link'},'next/navigation':{notFound(){assert.fail()}},'@/lib/event-groups/public-guide-server':{loadGuideDetail:async()=>({group:group(),classes:[]})},'@/lib/event-groups/public-guide':guide,'../guide.module.css':{default:{}}}).default
 const tree=nodes(await page({params:Promise.resolve({id:'501'})}));assert.ok(tree.some(n=>n.props?.href==='/events?view=registration&groupId=501'))
})
test('valid target is re-read on the server and only public form metadata crosses the client boundary',async()=>{
 const reads=[];const page=publicPage(async id=>{reads.push(id);return {group:group({privateExtra:'NEVER PASS'}),classes:[]}})
 const tree=await page({searchParams:Promise.resolve({view:'registration',groupId:'501'})});assert.equal(tree.type,'EventsList');assert.equal(tree.key,'501');assert.deepEqual(JSON.parse(JSON.stringify(tree.props.initialGroup)),{id:501,title:'対象開催回',description:'説明'});assert.deepEqual(reads,[501])
})
for(const value of ['0','-1','1.2','x','9007199254740992','','001',['501','502']])test(`invalid public ID does not read or open any form: ${JSON.stringify(value)}`,async()=>{
 const page=publicPage(()=>assert.fail('invalid ID must not read'))
 const tree=nodes(await page({searchParams:Promise.resolve({view:'registration',groupId:value})}));assert.ok(tree.some(n=>n.props?.role==='alert'));assert.equal(tree.some(n=>n.type==='EventsList'),false)
})
for(const [label,changes,dates] of [['hidden',{is_hidden:true}],['cancelled',{is_cancelled:true}],['ended',{start_date:'2029-01-01',end_date:'2029-01-01'},['2029-01-01']],['closed',{registration_open:false}],['invalid period',{end_date:'2030-01-03'}],['out of period',{},['2030-01-02']],['missing dates',{start_date:null}]])test(`server public eligibility prevents auto-form for ${label}`,async()=>{
 const server=compile('lib/event-groups/public-guide-server.ts',{'server-only':{},'@/lib/supabase/anonymous':{createAnonymousClient(){assert.fail('No external DB')}},'./public-guide':guide})
 const page=publicPage(id=>server.loadGuideDetail(id,db(group(changes),dates),'2030-01-01'))
 const tree=nodes(await page({searchParams:Promise.resolve({view:'registration',groupId:'501'})}));assert.equal(tree.some(n=>n.type==='EventsList'),false);assert.ok(tree.some(n=>n.props?.role==='alert'));assert.ok(!JSON.stringify(tree).includes('対象開催回'))
})
test('unknown target/read failure fail closed; ordinary registration keeps the existing list without server target reads',async()=>{
 for(const loader of [async()=>null,async()=>{throw new Error('PRIVATE')}]){const page=publicPage(loader),tree=nodes(await page({searchParams:Promise.resolve({view:'registration',groupId:'501'})}));assert.equal(tree.some(n=>n.type==='EventsList'),false);assert.doesNotMatch(JSON.stringify(tree),/PRIVATE/)}
 const tree=await publicPage(()=>assert.fail())({searchParams:Promise.resolve({view:'registration'})});assert.equal(tree.type,'EventsList');assert.equal(tree.props.initialGroup,undefined);assert.equal(tree.key,'list')
})
test('history detail links carry complete filters; normal list links stay unchanged',()=>{
 const View=compile('app/(app)/admin/event-groups/admin-index-view.tsx',{'react/jsx-runtime':jsx,'next/link':{default:'Link'},'@/lib/event-groups/admin-index':index,'./admin-index.module.css':{default:{}}}).default
 for(const historyMode of [true,false]){const options=index.indexOptions(historyMode,{q:'東京',state:'hidden',page:'3'}),result={items:[{...group(),phase:historyMode?'ended':'upcoming'}],total:60,page:3,pageSize:20,upcoming:0,review:0},tree=nodes(View({options,result,error:''}));const href=tree.find(n=>n.props?.className===undefined&&n.props?.href?.startsWith('/admin/event-groups/501'))?.props.href;assert.ok(href);const [path,query='']=href.split('?');assert.equal(path,'/admin/event-groups/501');assert.equal(new URLSearchParams(query).get('returnTo'),historyMode?index.indexHref(options,3):null)}
})
for(const file of ['app/(app)/admin/event-groups/[id]/page.tsx','app/(app)/admin/event-groups/[id]/edit/page.tsx'])for(const status of [401,403,200])test(`detail/edit server guard and safe return context: ${file} ${status}`,async()=>{
 const Component=compile(file,{'react/jsx-runtime':jsx,'next/navigation':{redirect(path){assert.equal(path,status===401?'/login':'/videos');throw new Error('REDIRECT')},notFound(){throw new Error('NOT_FOUND')}},'@/lib/supabase/require-admin':{requireAdmin:async()=>status===200?{ok:true}:{ok:false,status}},'@/lib/event-groups/admin-index':index,'../event-groups':{default:'EventGroups'},'../../occurrence-editor':{default:'Editor'}}).default
 const input={params:Promise.resolve({id:'501'}),searchParams:Promise.resolve({returnTo:history+'?state=ended&page=3'})}
 if(status!==200)await assert.rejects(Component(input),/REDIRECT/)
 else {assert.equal((await Component(input)).props.returnTo,history+'?state=ended&page=3');assert.equal((await Component({...input,searchParams:Promise.resolve({returnTo:'https://evil.invalid'})})).props.returnTo,normal);assert.equal((await Component({params:input.params})).props.returnTo,normal);await assert.rejects(Component({...input,params:Promise.resolve({id:'x'})}),/NOT_FOUND/)}
})

test('detail back link and edit link retain the validated history URL; ordinary entry keeps normal links',()=>{
 const states=[];let cursor=0;const react={useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],()=>{}]},useEffect(){},useRef:initial=>({current:initial})}
 const noop={default:()=>null}
 const Component=compile('app/(app)/admin/event-groups/event-groups.tsx',{react,'react/jsx-runtime':jsx,'next/link':{default:'Link'},'./registration-control':noop,'./group-classes':noop,'./occurrence-state':noop,'./occurrence-detail':noop,'./delete-group':noop,'../new-schedule-form':noop,'@/lib/event-groups/admin-overview':{},'@/lib/event-groups/validation':{}}).default
 for(const returnTo of [history+'?q='+encodeURIComponent('東京')+'&state=ended&page=3',undefined]){
  cursor=0;Component({groupId:501,returnTo});states[2]={eventGroups:[group()],total:1,page:1,pageSize:50}
  cursor=0;const tree=nodes(Component({groupId:501,returnTo}));assert.ok(tree.some(n=>n.props?.href===(returnTo??normal)))
  assert.ok(tree.some(n=>n.props?.href==='/admin/event-groups/501/edit'+(returnTo?'?returnTo='+encodeURIComponent(returnTo):'')))
 }
})
