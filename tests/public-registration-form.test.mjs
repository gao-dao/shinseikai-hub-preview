import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'

function compile(path,dependencies={},globals={}) {
  const exports={}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,AbortController,setTimeout,clearTimeout,...globals,require:name=>{assert.ok(Object.hasOwn(dependencies,name),`Unexpected dependency ${name}`);return dependencies[name]}})
  return exports
}
const details=compile('lib/registrations/details.ts')
const proxy=compile('lib/registrations/proxy-registration.ts',{'./details':details})
const validation=compile('lib/registrations/public-registration.ts',{'./proxy-registration':proxy})
const model=compile('lib/registrations/public-form.ts',{'./proxy-registration':proxy,'./public-registration':validation})
const input={event_group_id:5,name:' Synthetic attendee ',contact:' synthetic.contact.invalid ',notes:' Synthetic notes ',schedule_ids:[12,11]}
const key1='12345678-1234-4234-8234-123456789001',key2='12345678-1234-4234-8234-123456789002'
const plain=value=>JSON.parse(JSON.stringify(value))
function storage(initial) {
  const data=new Map(initial===undefined?[]:[[model.publicAttemptStorageKey,initial]])
  return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key),data}
}
function response(code='REGISTERED',status=201,extra={}) {return {ok:status>=200&&status<300,status,headers:new Headers(),json:async()=>({success:code==='REGISTERED',code,message:'UNTRUSTED_SECRET_TOKEN_MESSAGE',...extra})}}
function attempt(store=storage()) {let generated=0;const instance=new model.PublicRegistrationAttempt(store,()=>++generated===1?key1:key2);return {instance,store,generated:()=>generated}}
function row(id=11,changes={}) {return {id,title:`Class ${id}`,date:'2030-01-01',start_time:'10:00',end_time:'11:00',capacity:10,remainingCapacity:8,canRegister:true,status:'受付可能',...changes}}

test('attempt normalizes, freezes and persists only a marker before sending',async()=>{
  const {instance,store,generated}=attempt(),calls=[]
  assert.equal(instance.prepare(input),true)
  assert.deepEqual(plain(instance.payload),{...input,name:'Synthetic attendee',contact:'synthetic.contact.invalid',notes:'Synthetic notes',schedule_ids:[11,12]})
  assert.throws(()=>instance.payload.schedule_ids.push(13))
  const result=await instance.submit('fresh-token',async(...args)=>{calls.push(args);assert.equal(JSON.parse(store.getItem(model.publicAttemptStorageKey)).phase,'pending');return response()})
  assert.equal(result.kind,'success')
  assert.equal(generated(),1)
  assert.equal(calls.length,1)
  assert.equal(calls[0][0],'/api/registrations')
  assert.equal(calls[0][1].credentials,'omit');assert.equal(calls[0][1].cache,'no-store')
  assert.equal(calls[0][1].headers['Idempotency-Key'],key1)
  assert.doesNotMatch(JSON.stringify([...store.data]),/Synthetic|synthetic\.contact|fresh-token|schedule_ids|event_group_id/)
})

test('uncertain transport and fresh challenges preserve exactly the same key and frozen registration',async()=>{
  const {instance,generated}=attempt(),calls=[]
  instance.prepare(input)
  const first=await instance.submit('token-one',async(...args)=>{calls.push(args);throw new Error('SECRET')})
  assert.equal(first.kind,'unknown');assert.equal(instance.phase,'pending')
  assert.equal(instance.prepare({...input,name:'Changed'}),true)
  const second=await instance.submit('token-two',async(...args)=>{calls.push(args);return response()})
  assert.equal(second.kind,'success')
  const bodies=calls.map(call=>JSON.parse(call[1].body))
  assert.equal(bodies[0].turnstile_token,'token-one');assert.equal(bodies[1].turnstile_token,'token-two')
  delete bodies[0].turnstile_token;delete bodies[1].turnstile_token
  assert.deepEqual(bodies[0],bodies[1]);assert.equal(calls[0][1].headers['Idempotency-Key'],calls[1][1].headers['Idempotency-Key']);assert.equal(generated(),1)
})

test('20-second timeout preserves the attempt for manual retry with a fresh token', async () => {
  let now = 0
  let nextTimerId = 0
  const timers = new Map()
  const scheduledDelays = []
  const clearedTimers = []

  const timeoutModel = compile(
    'lib/registrations/public-form.ts',
    {
      './proxy-registration': proxy,
      './public-registration': validation,
    },
    {
      setTimeout(callback, delay) {
        const id = ++nextTimerId
        scheduledDelays.push(delay)
        timers.set(id, { at: now + delay, callback })
        return id
      },
      clearTimeout(id) {
        clearedTimers.push(id)
        timers.delete(id)
      },
    },
  )

  function advance(milliseconds) {
    now += milliseconds
    const ordered = [...timers.entries()]
      .sort((a, b) => a[1].at - b[1].at)
    for (const [id, timer] of ordered) {
      if (timers.has(id) && timer.at <= now) {
        timers.delete(id)
        timer.callback()
      }
    }
  }

  const store = storage()
  let generatedKeys = 0
  const instance = new timeoutModel.PublicRegistrationAttempt(
    store,
    () => {
      generatedKeys += 1
      return key1
    },
  )
  const calls = []
  const fetcher = async (url, options) => {
    calls.push({ url, options })
    if (calls.length === 1) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Synthetic request aborted'))
        if (options.signal.aborted) {
          abort()
          return
        }
        options.signal.addEventListener('abort', abort, { once: true })
      })
    }
    return response()
  }

  assert.equal(instance.prepare(input), true)
  const originalPayload = plain(instance.payload)
  const originalMarker = store.getItem(model.publicAttemptStorageKey)
  const firstRequest = instance.submit('token-before-timeout', fetcher)

  assert.deepEqual(scheduledDelays, [20_000])
  assert.equal(calls.length, 1)
  advance(19_999)
  assert.equal(calls[0].options.signal.aborted, false)

  advance(1)
  assert.equal(calls[0].options.signal.aborted, true)
  const firstResult = await firstRequest

  assert.equal(firstResult.kind, 'unknown')
  assert.equal(instance.phase, 'pending')
  assert.deepEqual(plain(instance.payload), originalPayload)
  assert.equal(store.getItem(model.publicAttemptStorageKey), originalMarker)
  assert.equal(generatedKeys, 1)
  assert.equal(timers.size, 0)
  assert.deepEqual(clearedTimers, [1])

  // 時間を進めても自動再送されない。
  advance(60_000)
  await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.equal(generatedKeys, 1)

  // 結果不明の間は、別の入力で申込内容を置き換えない。
  assert.equal(instance.prepare({ ...input, notes: 'Changed notes' }), true)
  assert.deepEqual(plain(instance.payload), originalPayload)

  // 新しいトークンを渡して、明示的に手動再送する。
  const retryResult = await instance.submit('token-after-timeout', fetcher)
  assert.equal(retryResult.kind, 'success')
  assert.equal(calls.length, 2)
  assert.equal(generatedKeys, 1)

  const firstBody = JSON.parse(calls[0].options.body)
  const retryBody = JSON.parse(calls[1].options.body)
  assert.equal(firstBody.turnstile_token, 'token-before-timeout')
  assert.equal(retryBody.turnstile_token, 'token-after-timeout')
  delete firstBody.turnstile_token
  delete retryBody.turnstile_token
  assert.deepEqual(retryBody, firstBody)
  for (const call of calls) {
    assert.equal(call.url, '/api/registrations')
    assert.equal(call.options.headers['Idempotency-Key'], key1)
  }

  assert.deepEqual(scheduledDelays, [20_000, 20_000])
  assert.deepEqual(clearedTimers, [1, 2])
  assert.equal(timers.size, 0)

  // 成功後に解除済みタイマーが発火しないことも確認する。
  advance(60_000)
  assert.equal(calls[1].options.signal.aborted, false)
  assert.equal(calls.length, 2)
})

test('same-tick double submissions send once and never auto-retry',async()=>{
  const {instance}=attempt();instance.prepare(input)
  let release,calls=0
  const pending=instance.submit('token-one',()=>{calls++;return new Promise(resolve=>{release=resolve})})
  assert.equal((await instance.submit('token-two',async()=>{calls++;return response()})).kind,'busy')
  assert.equal(calls,1);release(response());await pending
})

for(const [code,status] of [['CAPACITY_EXCEEDED',409],['REGISTRATION_CLOSED',409],['CLASS_CLOSED',409],['CLASS_NOT_FOUND',400],['GROUP_NOT_FOUND',404],['IDEMPOTENCY_CONFLICT',409],['IDEMPOTENCY_EXPIRED',410],['TURNSTILE_REJECTED',403],['RATE_LIMIT_EXCEEDED',429]])test(`form controller handles ${code} safely and keeps the original attempt`,async()=>{
  const {instance}=attempt();instance.prepare(input)
  const result=await instance.submit('token',async()=>response(code,status))
  assert.equal(result.kind,'rejected');assert.equal(instance.phase,'pending');assert.equal(instance.startNew(),false)
  assert.doesNotMatch(JSON.stringify(result),/UNTRUSTED|SECRET|TOKEN|Synthetic/)
})

test('bad JSON, inconsistent response and unknown errors never complete or replace an attempt',async()=>{
  for(const result of [{...response(),json:async()=>{throw new Error('SECRET')}},response('REGISTERED',200),response('REGISTERED',201,{success:false}),response('UNKNOWN',500),{...response(),json:async()=>null}]) {
    const {instance}=attempt();instance.prepare(input)
    assert.equal((await instance.submit('token',async()=>result)).kind,'unknown')
    assert.equal(instance.phase,'pending');assert.equal(instance.startNew(),false)
  }
})

test('retry-after is displayed as a bounded numeric hint only',async()=>{
  const {instance}=attempt();instance.prepare(input)
  const result=response('RATE_LIMIT_EXCEEDED',429);result.headers.set('Retry-After','60')
  assert.equal((await instance.submit('token',async()=>result)).retryAfterSeconds,60)
})

test('reload never recreates an unresolved applicant payload or silently generates a new key',()=>{
  const {instance,store}=attempt();instance.prepare(input)
  const recovered=new model.PublicRegistrationAttempt(store,()=>{throw new Error('must not generate')})
  assert.equal(recovered.phase,'blocked');assert.equal(recovered.payload,null);assert.equal(recovered.prepare(input),false);assert.equal(recovered.startNew(),false)
  for(const marker of ['bad JSON','{}','null','{"version":99,"phase":"success"}'])assert.equal(attempt(storage(marker)).instance.phase,'blocked')
})

test('new keys and reset are permitted only after confirmed success, including completed reload',async()=>{
  const {instance,store,generated}=attempt()
  assert.equal(instance.startNew(),false);instance.prepare(input)
  await instance.submit('token',async()=>response())
  assert.equal(new model.PublicRegistrationAttempt(store,()=>key2).phase,'success')
  assert.equal(instance.startNew(),true);assert.equal(instance.payload,null)
  assert.equal(store.getItem(model.publicAttemptStorageKey),null)
  instance.prepare(input);assert.equal(generated(),2)
  let sent;await instance.submit('new-token',async(_,options)=>{sent=options;return response()})
  assert.equal(sent.headers['Idempotency-Key'],key2)
})

test('storage or UUID failure prevents POST; invalid inputs do not allocate keys',async()=>{
  const broken={getItem:()=>{throw new Error('SECRET')},setItem:()=>{throw new Error('SECRET')},removeItem:()=>{throw new Error('SECRET')}}
  assert.equal(attempt(broken).instance.phase,'blocked')
  const store=storage();store.setItem=()=>{throw new Error('SECRET')}
  const {instance,generated}=attempt(store)
  assert.equal(instance.prepare({...input,name:''}),false);assert.equal(generated(),0)
  assert.equal(instance.prepare(input),false)
  let calls=0;await instance.submit('token',async()=>{calls++;return response()});assert.equal(calls,0)
  assert.equal(new model.PublicRegistrationAttempt(storage(),()=>{throw new Error('SECRET')}).prepare(input),false)
})

test('public class loader retrieves all pages beyond fifty and omits credentials',async()=>{
  const calls=[],items=Array.from({length:51},(_,i)=>row(i+1))
  const classes=await model.loadPublicRegistrationClasses(5,async(url,options)=>{calls.push([url,options]);const page=calls.length;return {ok:true,json:async()=>({schedules:page===1?items.slice(0,50):items.slice(50),page,pageSize:50,total:51})}},new AbortController().signal)
  assert.equal(classes.length,51);assert.equal(calls.length,2)
  assert.match(calls[1][0],/page=2$/);assert.equal(calls[0][1].credentials,'omit');assert.equal(calls[0][1].cache,'no-store')
})

test('class loading fails closed on errors, duplicate IDs, missing pages and unknown or inconsistent seats',async()=>{
  for(const data of [{schedules:[row(11),row(11)],page:1,pageSize:50,total:2},{schedules:[row(11,{remainingCapacity:null})],page:1,pageSize:50,total:1},{schedules:[],page:1,pageSize:50,total:1},{schedules:[row()],page:1,pageSize:50,total:2}]) {
    await assert.rejects(model.loadPublicRegistrationClasses(5,async()=>({ok:true,json:async()=>data}),new AbortController().signal))
  }
  await assert.rejects(model.loadPublicRegistrationClasses(5,async()=>({ok:false}),new AbortController().signal))
})

function elements(tree){if(Array.isArray(tree))return tree.flatMap(elements);if(!tree||typeof tree!=='object')return [];return [tree,...elements(tree.props?.children)]}
function hooks() {
  const slots=[];let cursor=0;const pending=[]
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>v===b[i])
  return {reset(){cursor=0},async flush(){for(const effect of pending.splice(0)){effect.cleanup?.();effect.cleanup=effect.fn()}await new Promise(resolve=>setImmediate(resolve))},react:{
    useState(initial){const i=cursor++;if(!slots[i])slots[i]={value:initial};return [slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value}]},
    useRef(initial){const i=cursor++;return slots[i]??= {current:initial}},
    useCallback(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))slots[i]={deps,value:fn};return slots[i].value},
    useEffect(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps)){const old=slots[i];const entry={deps,fn,cleanup:old?.cleanup};slots[i]=entry;pending.push(entry)}},
  }}
}
function form({store=storage(),postResponse=response(),postError=false,pendingPost=false,classes=[row(11),row(12),row(13,{canRegister:false,remainingCapacity:0,status:'満員'})],classesFail=false}={}) {
  const harness=hooks(),calls=[],logs=[],Widget=()=>null;let release
  const {default:Component}=compile('app/(public)/events/registration-form.tsx',{
    '@/lib/registrations/public-class-display':compile('lib/registrations/public-class-display.ts'),react:harness.react,'react/jsx-runtime':jsxRuntime,'@/lib/registrations/proxy-registration':proxy,'@/lib/registrations/public-form':model,'./turnstile-widget':{default:Widget},
  },{crypto:{randomUUID:()=>key1},window:{sessionStorage:store,addEventListener(){},removeEventListener(){}},console:{log:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},fetch:async(url,options)=>{
    calls.push([url,options]);if(options?.method==='POST'){if(postError)throw new Error('SECRET');if(pendingPost)return new Promise(resolve=>{release=resolve});return postResponse}
    if(classesFail)throw new Error('SECRET');return {ok:true,json:async()=>({schedules:classes,page:1,pageSize:50,total:classes.length})}
  }})
  const render=()=>{harness.reset();return elements(Component({group:{id:5,title:'Synthetic group'},onClose:()=>calls.push(['closed'])}))}
  return {render,calls,logs,Widget,release:()=>release(response()),async mount(){render();await harness.flush();return render()},find:id=>render().find(item=>item.props?.id===id),async completeInput(){await this.mount();for(const [id,value] of [['public-name','参加者'],['public-contact','電話'],['public-notes','備考']])this.find(id).props.onChange({target:{value}});render().find(item=>item.type==='input'&&item.props.type==='checkbox').props.onChange({target:{checked:true}})},confirm(){return render().find(item=>item.type==='form').props.onSubmit({preventDefault(){}})},token(value='fresh-token'){render().find(item=>item.type===Widget).props.onToken(value)},submit(){return render().find(item=>item.type==='button'&&['この内容で申し込む','同じ申込の結果を再確認する'].includes(item.props.children)).props.onClick()}}
}

test('public form displays fields, seats and unavailable classes, and rejects zero selected classes',async()=>{
  const context=form();await context.mount()
  assert.ok(context.find('public-name'));assert.ok(context.find('public-contact'));assert.ok(context.find('public-notes'))
  const boxes=context.render().filter(item=>item.type==='input'&&item.props.type==='checkbox')
  assert.equal(boxes.length,3);assert.equal(boxes[2].props.disabled,true)
  context.confirm();assert.ok(context.render().some(item=>item.props?.role==='alert'&&String(item.props.children).includes('1つ以上')))
  assert.equal(context.calls.some(call=>call[1]?.method==='POST'),false)
})

test('confirmation permits editing before first submission and requires a Turnstile token',async()=>{
  const context=form();await context.completeInput();context.confirm()
  assert.ok(context.render().some(item=>item.type===context.Widget))
  assert.equal(context.render().find(item=>item.type==='button'&&item.props.children==='この内容で申し込む').props.disabled,true)
  context.render().find(item=>item.type==='button'&&item.props.children==='入力を修正する').props.onClick()
  assert.equal(context.find('public-name').props.value,'参加者')
  assert.equal(context.calls.some(call=>call[1]?.method==='POST'),false)
})

test('successful form sends once and renders completion; fresh form fields reset after explicit new application',async()=>{
  const context=form();await context.completeInput();context.confirm();context.token()
  context.submit();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(context.calls.filter(call=>call[1]?.method==='POST').length,1)
  assert.ok(context.render().some(item=>item.props?.role==='status'&&String(item.props.children).includes('受け付けました')))
  context.render().find(item=>item.type==='button'&&item.props.children==='新しい申込を始める').props.onClick()
  assert.equal(context.find('public-name').props.value,'');assert.equal(context.find('public-contact').props.value,'');assert.equal(context.find('public-notes').props.value,'')
})

test('form double-click is blocked; pending network outcome locks fields and requires refreshed challenge',async()=>{
  const context=form({pendingPost:true});await context.completeInput();context.confirm();context.token()
  const click=context.render().find(item=>item.type==='button'&&item.props.children==='この内容で申し込む').props.onClick
  click();click()
  assert.equal(context.calls.filter(call=>call[1]?.method==='POST').length,1)
  assert.equal(context.render().some(item=>item.type==='input'),false)
  context.release();await new Promise(resolve=>setImmediate(resolve))
})

test('uncertain form keeps the same key/payload and only changes the token on manual retry',async()=>{
  const context=form({postError:true});await context.completeInput();context.confirm();context.token('token-one')
  context.submit();await new Promise(resolve=>setImmediate(resolve))
  assert.ok(context.render().some(item=>item.props?.role==='alert'))
  const retry=context.render().find(item=>item.type==='button'&&item.props.children==='同じ申込の結果を再確認する')
  assert.equal(retry.props.disabled,true)
  context.token('token-two');context.submit();await new Promise(resolve=>setImmediate(resolve))
  const calls=context.calls.filter(call=>call[1]?.method==='POST')
  assert.equal(calls.length,2);assert.equal(calls[0][1].headers['Idempotency-Key'],calls[1][1].headers['Idempotency-Key'])
  const first=JSON.parse(calls[0][1].body),second=JSON.parse(calls[1][1].body)
  assert.equal(first.turnstile_token,'token-one');assert.equal(second.turnstile_token,'token-two')
  delete first.turnstile_token;delete second.turnstile_token;assert.deepEqual(first,second)
  assert.deepEqual(context.logs,[])
})

test('reloaded pending marker blocks new form submission and class retrieval errors prevent confirmation',async()=>{
  const blocked=form({store:storage(JSON.stringify({version:1,phase:'pending',key:key1}))});await blocked.mount()
  assert.equal(blocked.render().some(item=>item.type==='form'),false)
  assert.ok(blocked.render().some(item=>item.props?.role==='alert'))
  const context=form({classesFail:true});await context.mount()
  assert.equal(context.render().find(item=>item.type==='button'&&item.props.children==='入力内容を確認する').props.disabled,true)
  assert.equal(context.calls.some(call=>call[1]?.method==='POST'),false)
})

test('Turnstile widget uses public key and registration action, clears expired tokens and ignores stale callbacks',async()=>{
  const harness=hooks(),tokens=[],rendered=[],removed=[],Script=()=>null
  const win={turnstile:{render:(_,options)=>{rendered.push(options);return String(rendered.length)},remove:id=>removed.push(id)}}
  const {default:Widget}=compile('app/(public)/events/turnstile-widget.tsx',{'@/lib/registrations/public-class-display':compile('lib/registrations/public-class-display.ts'),react:harness.react,'react/jsx-runtime':jsxRuntime,'next/script':{default:Script}},{window:win,process:{env:{NEXT_PUBLIC_TURNSTILE_SITE_KEY:'SYNTHETIC_PUBLIC_SITEKEY'}}})
  const onToken=value=>tokens.push(value)
  const render=generation=>{harness.reset();return elements(Widget({onToken,generation}))}
  let tree=render(0);tree.find(item=>item.type==='div'&&item.props.ref).props.ref.current={}
  tree.find(item=>item.type===Script).props.onReady();render(0);await harness.flush()
  assert.equal(rendered[0].action,'registration');assert.equal(rendered[0].sitekey,'SYNTHETIC_PUBLIC_SITEKEY')
  assert.equal(rendered[0].retry,'never');assert.equal(rendered[0]['response-field'],false)
  rendered[0].callback('token-one');assert.equal(tokens.at(-1),'token-one')
  rendered[0]['expired-callback']();assert.equal(tokens.at(-1),'')
  rendered[0]['error-callback']();assert.equal(tokens.at(-1),'')
  render(1);await harness.flush();assert.equal(rendered.length,2);assert.equal(removed.length,1)
  rendered[0].callback('stale-token');assert.notEqual(tokens.at(-1),'stale-token')
  rendered[1].callback('token-two');assert.equal(tokens.at(-1),'token-two')
})

test('Turnstile missing public configuration renders an error and no script, without bypass',()=>{
  const harness=hooks(),Script=()=>null
  const {default:Widget}=compile('app/(public)/events/turnstile-widget.tsx',{'@/lib/registrations/public-class-display':compile('lib/registrations/public-class-display.ts'),react:harness.react,'react/jsx-runtime':jsxRuntime,'next/script':{default:Script}},{process:{env:{NODE_ENV:'development'}}})
  harness.reset();const tree=elements(Widget({onToken(){},generation:0}))
  assert.ok(tree.some(item=>item.props?.role==='alert'));assert.equal(tree.some(item=>item.type===Script),false)
})

test('form validation rejects oversized participant details without confirmation or POST',async()=>{
  const context=form();await context.completeInput()
  context.find('public-name').props.onChange({target:{value:'あ'.repeat(101)}})
  context.confirm()
  assert.equal(context.render().some(item=>item.type===context.Widget),false)
  assert.ok(context.render().some(item=>item.props?.role==='alert'))
  assert.equal(context.calls.some(call=>call[1]?.method==='POST'),false)
})


for (const body of ['html', 'empty', 'json']) test(`Firewall 429 ${body} bypasses JSON parsing and keeps the original attempt`, async()=>{
  const {instance,generated}=attempt();instance.prepare(input)
  const calls=[]
  const contents={html:'<html>UNTRUSTED_SECRET</html>',empty:'',json:JSON.stringify({success:false,code:'RATE_LIMIT_EXCEEDED'})}
  const blocked=new Response(contents[body],{status:429,headers:{'Retry-After':'60','Content-Type':body==='json'?'application/json':'text/html'}})
  blocked.json=async()=>{throw new Error('must-not-parse-firewall-body')}
  const first=await instance.submit('token-one',async(...args)=>{calls.push(args);return blocked})
  assert.equal(first.kind,'rejected');assert.equal(first.retryAfterSeconds,60)
  assert.match(first.message,/同じ申込内容・同じ申込キー/)
  assert.doesNotMatch(first.message,/未登録|登録されていません/)
  assert.equal(calls.length,1);assert.equal(instance.phase,'pending');assert.equal(instance.startNew(),false)
  instance.prepare({...input,name:'Changed'})
  await instance.submit('token-two',async(...args)=>{calls.push(args);return response()})
  assert.equal(generated(),1);assert.equal(calls.length,2)
  assert.equal(calls[0][1].headers['Idempotency-Key'],calls[1][1].headers['Idempotency-Key'])
  const bodies=calls.map(c=>JSON.parse(c[1].body))
  assert.equal(bodies[0].turnstile_token,'token-one');assert.equal(bodies[1].turnstile_token,'token-two')
  for(const item of bodies)delete item.turnstile_token
  assert.deepEqual(bodies[0],bodies[1])
})

for(const value of [null,'','0','-1','1.5','NaN','100000',' 60','60 ','Wed, 21 Oct 2030 00:00:00 GMT','<script>secret</script>'])test('Firewall invalid or missing Retry-After is ignored safely',async()=>{
  const {instance}=attempt();instance.prepare(input)
  // Header implementations may normalize whitespace: override get to test raw input.
  const result=await instance.submit('token',async()=>({status:429,headers:{get:()=>value},json:()=>{throw new Error('must-not-parse')}}))
  assert.equal(result.kind,'rejected');assert.equal(result.retryAfterSeconds,undefined)
  assert.doesNotMatch(JSON.stringify(result),/script|Wed|secret/)
})

for(const [name,changes,label,disabled] of [
 ['open',{canRegister:true,remainingCapacity:8,status:'受付可能'},'受付可能',false],
 ['stopped with seats',{canRegister:false,remainingCapacity:8,status:'クラス受付停止中'},'満席',true],
 ['stopped with no seats',{canRegister:false,remainingCapacity:0,status:'クラス受付停止中'},'満席',true],
 ['zero seats',{canRegister:false,remainingCapacity:0,status:'満員'},'申込不可',true],
 ['unknown seats',{canRegister:false,remainingCapacity:null,status:'残席確認不可'},'申込状況を確認できません',true],
])test(`public form hides numeric capacity and preserves selection: ${name}`,async()=>{
 const saved=row(11,changes),before=JSON.stringify(saved),context=form({classes:[saved]});await context.mount()
 const nodes=context.render()
 assert.ok(nodes.some(item=>item.type==='span'&&item.props.children===label))
 assert.equal(nodes.find(item=>item.type==='input'&&item.props.type==='checkbox').props.disabled,disabled)
 const labels=nodes.filter(item=>item.type==='span').map(item=>item.props.children).join(' ')
 assert.doesNotMatch(labels,/定員|残席|残り[0-9]/)
 if(label!=='満席')assert.ok(!nodes.some(item=>item.props?.children==='満席'))
 assert.equal(JSON.stringify(saved),before);assert.equal(context.calls.some(call=>call[1]?.method==='POST'),false)
})
test('unavailable group/classes never become full labels and prevent confirmation',async()=>{
 const context=form({classesFail:true});await context.mount()
 assert.ok(context.render().some(item=>item.props?.role==='alert'))
 assert.ok(!context.render().some(item=>item.props?.children==='満席'))
 assert.equal(context.render().find(item=>item.type==='button'&&item.props.children==='入力内容を確認する').props.disabled,true)
 assert.equal(context.calls.some(call=>call[1]?.method==='POST'),false)
})

test('editing exposes a single primary review action before auxiliary refresh and close; auxiliary actions never submit',async()=>{
 const c=form();await c.mount();let tree=c.render()
 const controls=tree.filter(n=>n.type==='button'),primary=controls.filter(n=>n.props.className==='events-primary')
 assert.equal(primary.length,1);assert.equal(primary[0].props.children,'入力内容を確認する');assert.equal(primary[0].props.type,'submit')
 const refresh=controls.find(n=>n.props.children==='申込状況を再取得'),close=controls.find(n=>n.props.children==='閉じる')
 assert.equal(refresh.props.className,'events-secondary');assert.equal(close.props.className,'events-secondary');assert.equal(refresh.props.type,'button');assert.equal(close.props.type,'button')
 assert.ok(controls.indexOf(primary[0])<controls.indexOf(refresh))
 const gets=c.calls.filter(([url,init])=>!init?.method&&url.startsWith('/api/')).length
 refresh.props.onClick();await c.mount();assert.ok(c.calls.filter(([url,init])=>!init?.method&&url.startsWith('/api/')).length>gets)
 close.props.onClick();assert.equal(c.calls.filter(([url])=>url==='closed').length,1);assert.equal(c.calls.filter(([,init])=>init?.method==='POST').length,0)
})
test('review retains the protected submit action and editing path; pending still prevents close and input changes',async()=>{
 const c=form({postError:true});await c.completeInput();c.confirm()
 let tree=c.render();assert.equal(tree.filter(n=>n.type==='button'&&n.props.className==='events-primary').length,1)
 assert.equal(tree.find(n=>n.type==='button'&&n.props.children==='この内容で申し込む').props.disabled,true)
 assert.equal(tree.find(n=>n.type==='button'&&n.props.children==='入力を修正する').props.className,'events-secondary')
 c.token();c.submit();await new Promise(resolve=>setImmediate(resolve));tree=c.render()
 assert.ok(tree.some(n=>n.type==='button'&&n.props.children==='同じ申込の結果を再確認する'))
 assert.equal(tree.some(n=>n.type==='button'&&['閉じる','入力を修正する'].includes(n.props.children)),false)
})
