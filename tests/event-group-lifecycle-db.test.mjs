import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
function docker(args, input = '', onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe','pipe','pipe'] }); let out = '', err = ''
    child.stdout.on('data', x => { out += x; onOutput?.(out) }); child.stderr.on('data', x => { err += x })
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(out.trim()) : reject(Error(`Isolated Docker command failed (${code}): ${err}`)))
    child.stdin.on('error', () => {}); child.stdin.end(input)
  })
}
test('event group lifecycle in isolated local PostgreSQL', { skip: process.env.SHINSEIKAI_LIFECYCLE_DB_TEST !== '1', timeout: 120000 }, async t => {
  // No remote Engine, downloaded image, TCP, mounted repository or cloud credentials.
  const endpoint = await docker(['context','inspect','--format','{{.Endpoints.docker.Host}}'])
  assert.match(endpoint, /^unix:\/\//)
  if (process.env.DOCKER_HOST) assert.match(process.env.DOCKER_HOST, /^unix:\/\//)
  assert.equal(await docker(['context','show']), 'desktop-linux')
  assert.match(await docker(['info','--format','{{.OperatingSystem}}']), /Docker Desktop/)
  await docker(['image','inspect','--format','{{.Id}}','ghcr.io/supabase/postgres:17.11.0.004'])
  const container = `shinseikai-lifecycle-${randomUUID().slice(0,12)}`; let started = false
  t.after(async () => { if (started) await docker(['stop','--time','1',container]) })
  await docker(['run','--pull=never','--rm','-d','--network','none','--read-only','--tmpfs','/tmp:rw,size=256m,mode=1777','--memory','512m','--user','postgres','--name',container,'--entrypoint','/bin/bash','ghcr.io/supabase/postgres:17.11.0.004','-ec','initdb -D /tmp/test-pg -A trust --no-locale --encoding=UTF8 >/dev/null; exec postgres -D /tmp/test-pg -k /tmp -c listen_addresses='])
  started = true
  let ready = false
  for (let i=0;i<40;i++) { try { await docker(['exec',container,'pg_isready','-h','/tmp','-U','postgres']); ready = true; break } catch { await new Promise(r => setTimeout(r,100)) } }
  assert.ok(ready)
  const sql = (text, output) => docker(['exec','-i',container,'psql','-X','-q','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres','-At'], text, output)
  await sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`)
  for (const name of ['20260918_initial_baseline.sql','20261015_add_registration_management.sql','20261019_add_registration_idempotency.sql','20261022_add_event_group_occurrence_details.sql','20261024_add_atomic_occurrence_editor.sql','20261025_add_occurrence_end_time_editing.sql']) await sql(await readFile(`supabase/migrations/${name}`,'utf8'))
  const admin='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002'
  await sql(`insert into auth.users values ('${admin}'),('${other}'); insert into public.profiles values ('${admin}','admin'),('${other}','admin');`)
  const asAdmin = text => `set role authenticated; set request.jwt.claim.sub = '${admin}'; ${text}`
  const quote = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
  const statement = (value, key) => `select public.admin_save_occurrence('${key}',${quote(value)});`
  const save = async (v,key=randomUUID()) => JSON.parse(await sql(asAdmin(statement(v,key))))
  const read = async id => JSON.parse(await sql(asAdmin(`select public.admin_get_occurrence_editor(${id});`)))
  const payload = () => ({ group_id:null, group:{title:'Synthetic occurrence',description:null,city:'Synthetic city',start_date:'2030-01-01',end_date:'2030-01-02'},classes:[{id:null,title:'A',date:'2030-01-01',start_time:'12:00',location:'Synthetic venue',type:'一般参加',capacity:10,registration_enabled:false},{id:null,title:'B',date:'2030-01-02',start_time:'14:00',location:'Synthetic venue',type:'稽古会',capacity:10,registration_enabled:false}],expected:null })

  const legacy=await save(payload()), beforeLegacy=await read(legacy.group_id)
  await sql(await readFile('supabase/migrations/20261026_add_event_group_lifecycle.sql','utf8'))
  const state = id => sql(`select json_build_object('is_cancelled',is_cancelled,'is_hidden',is_hidden,'registration_open',registration_open,'state_version',state_version) from public.event_groups where id=${id};`).then(JSON.parse)
  const setState = async(id, action, version) => { version ??= (await state(id)).state_version;return JSON.parse(await sql(asAdmin(`select public.admin_set_event_group_state(${id},'${action}',${version});`))) }
  const open = async() => {const p=payload();p.classes.forEach(c=>c.registration_enabled=true);const result=await save(p);await sql(`update public.event_groups set registration_open=true where id=${result.group_id};`);return result}
  const submit = (g,key=randomUUID())=>sql(`set role service_role; select public.submit_registration_idempotent('${key}',${g.group_id},'Synthetic','synthetic.invalid',null,array[${g.class_ids[0]}]::bigint[]);`).then(JSON.parse)
  const proxy = g => sql(asAdmin(`select public.admin_create_registration(${g.group_id},'Synthetic','synthetic.invalid',null,array[${g.class_ids[0]}]::bigint[]);`))
  await t.test('migration preserves preexisting business rows and defaults both flags to false',async()=>{
    assert.deepEqual(await read(legacy.group_id),beforeLegacy);assert.deepEqual(await state(legacy.group_id),{is_cancelled:false,is_hidden:false,registration_open:false,state_version:0})
  })
  await t.test('only admin can change state; EXECUTE and private table permissions remain restricted',async()=>{
    for(const role of ['anon','service_role','authenticated'])await assert.rejects(sql(`set role ${role};select public.admin_set_event_group_state(${legacy.group_id},'hide',0);`),/permission denied|administrator/)
    assert.equal(await sql("select has_function_privilege('anon','public.admin_set_event_group_state(bigint,text,bigint)','execute') or has_function_privilege('service_role','public.admin_set_event_group_state(bigint,text,bigint)','execute');"),'f')
    assert.equal(await sql(`select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.admin_set_event_group_state(bigint,text,bigint)'::regprocedure;`),'t')
  })
  for(const action of ['hide','cancel'])await t.test(`${action} atomically closes reception and blocks all new registrations and additions`,async()=>{
    const g=await open(),first=await submit(g),key=randomUUID();assert.equal(first.success,true)
    const reg=await sql(`select id from public.registrations where event_group_id=${g.group_id};`)
    const before=await sql(`select json_build_object('classes',(select json_agg(s order by id) from public.schedules s where event_group_id=${g.group_id}),'items',(select json_agg(i order by id) from public.registration_items i where event_group_id=${g.group_id}));`)
    const changed=await setState(g.group_id,action);assert.equal(changed.registration_open,false)
    assert.equal((await submit(g,key)).http_status,409);await assert.rejects(proxy(g),/registration is closed/)
    await assert.rejects(sql(asAdmin(`select public.admin_add_registration_items(${reg},array[${g.class_ids[1]}]::bigint[]);`)),/registration is closed/)
    assert.equal(await sql(`select json_build_object('classes',(select json_agg(s order by id) from public.schedules s where event_group_id=${g.group_id}),'items',(select json_agg(i order by id) from public.registration_items i where event_group_id=${g.group_id}));`),before)
    await assert.rejects(sql(`update public.event_groups set registration_open=true where id=${g.group_id};`),/event_groups_blocked_reception/)
  })
  await t.test('hide/show preserves cancellation and never reopens reception; cancellation cannot be reversed even by direct UPDATE',async()=>{
    const g=await open();await setState(g.group_id,'cancel');await setState(g.group_id,'hide');await setState(g.group_id,'show')
    const s=await state(g.group_id);assert.equal(s.is_cancelled,true);assert.equal(s.is_hidden,false);assert.equal(s.registration_open,false)
    await assert.rejects(sql(`update public.event_groups set is_cancelled=false where id=${g.group_id};`),/cancellation cannot be reversed/)
    const h=await open();await setState(h.group_id,'hide');await setState(h.group_id,'show');assert.equal((await state(h.group_id)).registration_open,false)
  })
  await t.test('stale state version and invalid actions refuse mutation',async()=>{
    const g=await open(),before=await state(g.group_id);await setState(g.group_id,'hide')
    await assert.rejects(setState(g.group_id,'show',before.state_version),/state changed/)
    await assert.rejects(setState(g.group_id,'uncancel'),/invalid state/);assert.equal((await state(g.group_id)).is_hidden,true)
  })
  await t.test('restrictive RLS hides groups/classes despite existing allow-all policies; unassigned and cancelled schedules stay visible',async()=>{
    const hidden=await open(),cancelled=await open();await setState(hidden.group_id,'hide');await setState(cancelled.group_id,'cancel')
    await sql("insert into public.schedules(title,date,location,type) values('Unassigned','2030-01-01','Synthetic','稽古会');")
    for(const role of ['anon','authenticated']){
      assert.equal(await sql(`set role ${role};select count(*) from public.event_groups where id=${hidden.group_id};`),'0')
      assert.equal(await sql(`set role ${role};select count(*) from public.schedules where event_group_id=${hidden.group_id};`),'0')
      assert.equal(await sql(`set role ${role};select count(*) from public.schedules where event_group_id=${cancelled.group_id};`),'2')
      assert.equal(await sql(`set role ${role};select count(*) from public.schedules where event_group_id is null and title='Unassigned';`),'1')
      assert.equal(await sql(`set role ${role};select count(*) from public.get_event_group_availability(${hidden.group_id});`),'0')
      assert.equal(await sql(`set role ${role};select count(*) from public.get_event_group_availability(${cancelled.group_id});`),'0')
    }
    assert.equal(await sql(asAdmin(`select count(*) from public.schedules where event_group_id=${hidden.group_id};`)),'2')
    assert.equal((await read(hidden.group_id)).classes.length,2)
  })
  await t.test('successful idempotent replay after hiding and cancellation preserves result and never revives cancelled items',async()=>{
    const g=await open(),key=randomUUID();const first=await submit(g,key);const item=await sql(`select id from public.registration_items where event_group_id=${g.group_id};`)
    await sql(asAdmin(`select public.admin_cancel_registration_item(${item});`));await setState(g.group_id,'cancel');await setState(g.group_id,'hide')
    assert.deepEqual(await submit(g,key),first);assert.equal(await sql(`select count(*) from public.registration_items where event_group_id=${g.group_id} and status='active';`),'0')
    assert.equal(await sql(`select count(*) from public.registration_items where event_group_id=${g.group_id} and status='cancelled' and cancelled_at is not null;`),'1')
  })
  await t.test('concurrent state change wins: waiting application is rejected without parent or item writes',async()=>{
    const g=await open();let ready;const gate=new Promise(r=>ready=r)
    const writer=sql(`begin;${asAdmin(`select public.admin_set_event_group_state(${g.group_id},'hide',${(await state(g.group_id)).state_version});`)}select 'LOCKED';select pg_sleep(0.4);commit;`,out=>{if(out.includes('LOCKED'))ready()})
    await gate;const pending=submit(g);await writer;assert.equal((await pending).http_status,409)
    assert.equal(await sql(`select count(*) from public.registrations where event_group_id=${g.group_id};`),'0')
  })
  await t.test('concurrent application wins: state change waits, keeps committed history, stops future applications only',async()=>{
    const g=await open(),otherGroup=await open();const otherBefore=await read(otherGroup.group_id);let ready;const gate=new Promise(r=>ready=r)
    const writer=sql(`begin;select public.submit_registration(${g.group_id},'Synthetic','synthetic.invalid',null,array[${g.class_ids[0]}]::bigint[]);select 'LOCKED';select pg_sleep(0.4);commit;`,out=>{if(out.includes('LOCKED'))ready()})
    await gate;const changed=setState(g.group_id,'cancel');await writer;await changed
    assert.equal(await sql(`select count(*) from public.registration_items where event_group_id=${g.group_id} and status='active';`),'1');assert.equal((await submit(g)).http_status,409);assert.deepEqual(await read(otherGroup.group_id),otherBefore)
  })
  await t.test('authenticated member cannot change state or read hidden groups, classes or applicants',async()=>{
    const member='00000000-0000-4000-8000-000000000003';await sql(`insert into auth.users values('${member}');insert into public.profiles values('${member}','member');`)
    const g=await open();await submit(g);await setState(g.group_id,'hide')
    const prefix=`set role authenticated;set request.jwt.claim.sub='${member}';`
    await assert.rejects(sql(`${prefix}select public.admin_set_event_group_state(${g.group_id},'show',${(await state(g.group_id)).state_version});`),/administrator/)
    for(const table of ['event_groups','schedules','registrations','registration_items'])assert.equal(await sql(`${prefix}select count(*) from public.${table} where ${table==='event_groups'?'id':'event_group_id'}=${g.group_id};`),'0')
  })
  await t.test('simultaneous administrator state operations with same version cannot overwrite one another',async()=>{
    const g=await open(),version=(await state(g.group_id)).state_version
    const results=await Promise.allSettled([setState(g.group_id,'hide',version),setState(g.group_id,'cancel',version)])
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1)
    assert.match(results.find(r=>r.status==='rejected').reason.message,/state changed/)
    assert.equal((await state(g.group_id)).registration_open,false)
  })
  t.diagnostic('Only isolated lifecycle container used; automatically stopped and removed.')
})
