import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
function compile(path, dependencies, globals) {
 const exports = {}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
 { exports, require: n => { assert.ok(Object.hasOwn(dependencies,n),n); return dependencies[n] }, ...globals })
 return exports
}
const globals = { URLSearchParams, AbortController, setTimeout: (fn) => setTimeout(fn, 30), clearTimeout, process: { env: {} } }
const data = compile('lib/registrations/confirmation-email-data.ts', { 'server-only': {} }, globals)
const mail = compile('lib/registrations/confirmation-email.ts', { 'server-only': {}, './confirmation-email-data': data }, globals)
const env = { REGISTRATION_EMAIL_ENABLED: 'true', REGISTRATION_EMAIL_PROJECT_REF: 'ofyxyiumpjsfmycchbki', NEXT_PUBLIC_SUPABASE_URL: 'https://ofyxyiumpjsfmycchbki.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', RESEND_API_KEY: 'synthetic-not-real', RESEND_FROM_EMAIL: 'sender@example.invalid' }
const input = { event_group_id: 5, schedule_ids: [11], contact: 'attendee@example.invalid', idempotency_key: '12345678-abcd-4abc-8abc-123456789abc', notes: 'DO_NOT_INCLUDE_NOTES' }
const row = { id:11,event_group_id:5,title:'図解用クラス',date:'2030-01-02',start_time:'10:00:00',end_time:'11:00:00',location:'例示会場' }
function mock({ failMail=false, hang=false, rows=[row] }={}) {
 const calls=[]
 const fetcher=async (url,init) => {
  calls.push({url,init})
  if (hang) return new Promise(()=>{})
  if(url==='https://api.resend.com/emails') return new Response('',{status:failMail?503:200})
  return Response.json(url.includes('/event_groups?')?[{id:5,title:'図解用開催回'}]:rows)
 }
 return {calls,fetcher}
}
test('single mailbox validation excludes phone, lists, display names and control characters',()=>{
 for(const s of ['a@example.invalid','a+b@example.invalid']) assert.equal(mail.isSingleEmail(s),true)
 for(const s of ['090-0000-0000','a@b.invalid,c@d.invalid','A <a@b.invalid>','a@b.invalid\r\nBcc:x@y.invalid','.a@b.invalid','a..b@c.invalid','a@-b.invalid','a@b','a@b.invalid ']) assert.equal(mail.isSingleEmail(s),false)
})
test('disabled, missing settings, foreign project and non-email make no requests',async()=>{
 for(const config of [{}, {...env,REGISTRATION_EMAIL_ENABLED:'false'}, {...env,REGISTRATION_EMAIL_PROJECT_REF:'other'}, {...env,NEXT_PUBLIC_SUPABASE_URL:'https://other.supabase.co'}, {...env,RESEND_API_KEY:''}]) {
  const m=mock();await mail.sendRegistrationConfirmation(input,m.fetcher,config);assert.equal(m.calls.length,0)
 }
 const m=mock();await mail.sendRegistrationConfirmation({...input,contact:'phone'},m.fetcher,env);assert.equal(m.calls.length,0)
})
test('new mail is Japanese plaintext with metadata, safe key and no notes/IDs',async()=>{
 const m=mock();await mail.sendRegistrationConfirmation(input,m.fetcher,env);assert.equal(m.calls.length,3)
 const c=m.calls[2];assert.equal(c.url,'https://api.resend.com/emails');assert.equal(c.init.headers['Idempotency-Key'],`preview/registration-confirmation/${input.idempotency_key}`)
 const body=JSON.parse(c.init.body);assert.match(body.text,/図解用開催回/);assert.match(body.text,/図解用クラス/);assert.match(body.text,/2030-01-02 10:00～11:00（日本時間）/);assert.match(body.text,/例示会場/)
 assert.equal(body.html,undefined);assert.doesNotMatch(body.text,/DO_NOT_INCLUDE|12345678|event_group_id|schedule_ids/)
 assert.deepEqual(body.to,[input.contact]);assert.ok(m.calls.slice(0,2).every(c=>!Object.hasOwn(c.init.headers,'Authorization') && c.init.cache==='no-store'))
})
test('provider failure and bounded timeout are swallowed without retries',async()=>{
 const m=mock({failMail:true});await mail.sendRegistrationConfirmation(input,m.fetcher,env);assert.equal(m.calls.length,3)
 const h=mock({hang:true});const start=Date.now();await mail.sendRegistrationConfirmation(input,h.fetcher,env);assert.ok(Date.now()-start<500);assert.ok(h.calls.every(c=>c.init.signal.aborted))
})
test('missing, duplicate or wrong-group metadata prevents sending',async()=>{
 for(const rows of [[],[row,row],[{...row,event_group_id:6}],[{...row,id:12}]]) {
  const m=mock({rows});await mail.sendRegistrationConfirmation(input,m.fetcher,env);assert.equal(m.calls.length,2)
 }
})
test('migration only adds per-call metadata and preserves signature/body',()=>{
 const old=fs.readFileSync('supabase/migrations/20261019_add_registration_idempotency.sql','utf8')
 const next=fs.readFileSync('supabase/migrations/20261102_add_registration_created_new.sql','utf8')
 const body=s=>s.slice(s.indexOf('create'),s.lastIndexOf('$$;')+3)
 const original=old.slice(old.indexOf('create function public.submit_registration_idempotent('),old.indexOf('\nrevoke all on function public.submit_registration_idempotent'))
 assert.equal(body(next).replace('create or replace function','create function').replace(", 'created_new', false",'').replace(", 'created_new', v_code = 'REGISTERED'",'').trim(),original.trim())
})
