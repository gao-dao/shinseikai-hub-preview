import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
function compile(file,deps){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require(name){assert.ok(name in deps,`Unexpected dependency ${name}`);return deps[name]}});return exports}
for(const [status,target] of [[401,'/login'],[403,'/videos'],[200,'/admin']])test(`retired schedule route redirects without mounting any form: ${status}`,async()=>{
 let checked=0
 const Page=compile('app/(app)/admin/schedules/page.tsx',{'next/navigation':{redirect(url){assert.equal(url,target);throw Error('REDIRECT')}},'@/lib/supabase/require-admin':{requireAdmin:async()=>{checked++;return status===200?{ok:true}:{ok:false,status}}}})
 assert.equal(Page.dynamic,'force-dynamic');await assert.rejects(Page.default(),/REDIRECT/);assert.equal(checked,1)
})
test('no application navigation points to the retired schedule management route',()=>{
 function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(file.endsWith('.tsx'))assert.doesNotMatch(fs.readFileSync(file,'utf8'),/(?:href\s*=\s*["']|href:\s*["'])\/admin\/schedules(?:["'?#/])/u,file)}}
 walk('app')
})
for(const tab of ['videos','passwords'])test(`${tab} management no longer loads independent schedule data`,async()=>{
 const slots=[],refs=[],effects=[],calls=[];let i=0,r=0
 const react={useState(value){const n=i++;if(!(n in slots))slots[n]=value;return[slots[n],next=>slots[n]=typeof next==='function'?next(slots[n]):next]},useRef(value){return refs[r++]??={current:value}},useLayoutEffect(fn){fn()},useEffect(fn){effects.push(fn)},useMemo:fn=>fn(),useCallback:fn=>fn}
 const client={from(table){calls.push(table);const q={select(){return q},is(){return q},order:async()=>({data:[]})};return q}}
 const Component=compile('app/(app)/admin/management-tools.tsx',{react,'react/jsx-runtime':jsxRuntime,'next/navigation':{useRouter:()=>({})},'next/link':{default:()=>null},'@/lib/supabase/client':{createClient:()=>client},'./schedule-registration-status':{useScheduleRegistrationStatuses:()=>({statuses:{},loading:false,error:'',refresh(){}}),ScheduleRegistrationStatus:()=>null},'./schedule-deletion':{},'./new-schedule-form':{default:()=>null},'./edit-schedule-fields':{default:()=>null},'@/lib/schedules/new-schedule':{},'@/lib/schedules/edit-schedule':{}}).default
 Component({initialTab:tab});slots[1]=true;slots[2]=false;i=0;r=0;effects.length=0
 Component({initialTab:tab});effects[2]();await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(calls,tab==='videos'?['videos']:[])
})
