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
test('atomic occurrence editor in isolated local PostgreSQL', { skip: process.env.SHINSEIKAI_OCCURRENCE_DB_TEST !== '1', timeout: 120000 }, async t => {
  // No remote Engine, downloaded image, TCP, mounted repository or cloud credentials.
  const endpoint = await docker(['context','inspect','--format','{{.Endpoints.docker.Host}}'])
  assert.match(endpoint, /^unix:\/\//)
  if (process.env.DOCKER_HOST) assert.match(process.env.DOCKER_HOST, /^unix:\/\//)
  assert.equal(await docker(['context','show']), 'desktop-linux')
  assert.match(await docker(['info','--format','{{.OperatingSystem}}']), /Docker Desktop/)
  await docker(['image','inspect','--format','{{.Id}}','ghcr.io/supabase/postgres:17.11.0.004'])
  const container = `shinseikai-occurrence-${randomUUID().slice(0,12)}`; let started = false
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
  for (const name of ['20260918_initial_baseline.sql','20261015_add_registration_management.sql','20261022_add_event_group_occurrence_details.sql','20261024_add_atomic_occurrence_editor.sql']) await sql(await readFile(`supabase/migrations/${name}`,'utf8'))
  const admin='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002'
  await sql(`insert into auth.users values ('${admin}'),('${other}'); insert into public.profiles values ('${admin}','admin'),('${other}','admin');`)
  const asAdmin = text => `set role authenticated; set request.jwt.claim.sub = '${admin}'; ${text}`
  const quote = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
  const statement = (value, key) => `select public.admin_save_occurrence('${key}',${quote(value)});`
  const save = async (v,key=randomUUID()) => JSON.parse(await sql(asAdmin(statement(v,key))))
  const read = async id => JSON.parse(await sql(asAdmin(`select public.admin_get_occurrence_editor(${id});`)))
  const payload = () => ({ group_id:null, group:{title:'Synthetic occurrence',description:null,city:'Synthetic city',start_date:'2030-01-01',end_date:'2030-01-02'},classes:[{id:null,title:'A',date:'2030-01-01',start_time:'12:00',location:'Synthetic venue',type:'一般参加',capacity:10,registration_enabled:false},{id:null,title:'B',date:'2030-01-02',start_time:'14:00',location:'Synthetic venue',type:'稽古会',capacity:10,registration_enabled:false}],expected:null })
  const edit = async id => { const expected=await read(id);return {group_id:id,group:Object.fromEntries(Object.entries(expected.group).filter(([k])=>k!=='registration_open')),classes:expected.classes.map(row=>Object.fromEntries(Object.entries(row).filter(([k])=>k!=='end_time'))),expected} }
  const counts = () => sql('select json_build_array((select count(*) from public.event_groups),(select count(*) from public.schedules),(select count(*) from occurrence_private.save_requests));')
  await t.test('migration grants only authenticated RPC execute, not table access', async()=>{
    assert.equal(await sql("select has_function_privilege('anon','public.admin_save_occurrence(uuid,jsonb)','execute') or has_function_privilege('service_role','public.admin_save_occurrence(uuid,jsonb)','execute');"),'f')
    assert.equal(await sql("select has_table_privilege('authenticated','occurrence_private.save_requests','select');"),'f')
  })
  await t.test('non-read-committed transactions fail closed before writing',async()=>{
    const before=await counts();await assert.rejects(sql(`begin isolation level repeatable read;${asAdmin(statement(payload(),randomUUID()))}commit;`),/read committed transaction required/);assert.equal(await counts(),before)
  })
  await t.test('create all classes, NULL end times, capacity and stopped reception atomically',async()=>{
    const r=await save(payload()), s=await read(r.group_id);assert.equal(s.classes.length,2);assert.equal(s.group.registration_open,false);assert.ok(s.classes.every(row=>row.end_time===null&&row.capacity===10&&!row.registration_enabled))
  })
  await t.test('same-key same-body replay makes no duplicate rows; changed payload and actor conflict',async()=>{
    const key=randomUUID(), p=payload(), r=await save(p,key), before=await counts();assert.deepEqual(await save(p,key),r);assert.equal(await counts(),before)
    const changed=structuredClone(p);changed.group.title='Changed';await assert.rejects(save(changed,key),/save key conflicts/)
    await assert.rejects(sql(`set role authenticated; set request.jwt.claim.sub='${other}';${statement(p,key)}`),/save key conflicts/)
  })
  await t.test('parallel same-key creation returns one occurrence',async()=>{
    const key=randomUUID(), p=payload(), before=JSON.parse(await counts()), results=await Promise.all([save(p,key),save(p,key)])
    assert.deepEqual(results[0],results[1]);const after=JSON.parse(await counts());assert.equal(after[0],before[0]+1);assert.equal(after[1],before[1]+2)
  })
  await t.test('edit preserves end time, capacity, history, reception and unrelated/unassigned schedules',async()=>{
    const r=await save(payload()), unrelated=await save(payload());await sql(`update public.schedules set end_time='18:30',registration_enabled=true where id=${r.class_ids[0]}; update public.event_groups set registration_open=true where id=${r.group_id}; insert into public.schedules(title,date,location,type) values ('Unassigned','2030-01-01','Synthetic','稽古会');`)
    await sql(asAdmin(`select public.admin_create_registration(${r.group_id},'Synthetic','synthetic.invalid',null,array[${r.class_ids[0]}]::bigint[]); select public.admin_cancel_registration_item((select id from public.registration_items where event_group_id=${r.group_id} limit 1));`))
    const otherBefore=await read(unrelated.group_id), input=await edit(r.group_id);input.group.title='Edited';input.classes[0].title='Edited class';await save(input)
    const result=await read(r.group_id);assert.equal(result.group.registration_open,true);assert.equal(result.classes[0].end_time,'18:30');assert.equal(result.classes[0].capacity,10);assert.deepEqual(await read(unrelated.group_id),otherBefore)
    assert.equal(await sql(`select count(*) from public.registration_items where event_group_id=${r.group_id} and status='cancelled';`),'1')
    assert.equal(await sql("select count(*) from public.schedules where title='Unassigned' and event_group_id is null;"),'1')
  })
  for(const field of ['title','city','start_date','class','end_time','capacity','registration_open'])await t.test(`stale ${field} snapshot refuses all updates`,async()=>{
    const r=await save(payload()), input=await edit(r.group_id)
    const change={title:`update public.event_groups set title='Other' where id=${r.group_id}`,city:`update public.event_groups set city=null where id=${r.group_id}`,start_date:`update public.event_groups set start_date='2029-12-31' where id=${r.group_id}`,class:`update public.schedules set title='Other' where id=${r.class_ids[0]}`,end_time:`update public.schedules set end_time='20:00' where id=${r.class_ids[0]}`,capacity:`update public.schedules set capacity=11 where id=${r.class_ids[0]}`,registration_open:`update public.event_groups set registration_open=true where id=${r.group_id}`}[field]
    await sql(change+';');const before=await read(r.group_id);await assert.rejects(save(input),/occurrence changed/);assert.deepEqual(await read(r.group_id),before)
  })
  await t.test('omitting or substituting an existing class never deletes/reassigns it',async()=>{
    const r=await save(payload()), other=await save(payload()), input=await edit(r.group_id);input.classes.pop();await assert.rejects(save(input),/class membership/)
    input.classes[0].id=other.class_ids[0];await assert.rejects(save(input),/class membership/);assert.equal((await read(r.group_id)).classes.length,2)
  })
  await t.test('failure on second class rolls back parent, first class and request; same key can retry',async()=>{
    const p=payload(),key=randomUUID(),before=await counts();p.classes[1].title='Synthetic failure'
    await sql("create function public.synthetic_save_failure() returns trigger language plpgsql as $$begin if new.title='Synthetic failure' then raise exception 'synthetic failure'; end if; return new; end$$; create trigger synthetic_save_failure before insert on public.schedules for each row execute function public.synthetic_save_failure();")
    await assert.rejects(save(p,key),/synthetic failure/);assert.equal(await counts(),before);await sql('drop trigger synthetic_save_failure on public.schedules; drop function public.synthetic_save_failure();');await save(p,key)
  })
  await t.test('capacity below two active bookings refuses entire group edit',async()=>{
    const r=await save(payload());await sql(`update public.schedules set registration_enabled=true where id=${r.class_ids[0]};`)
    for(let i=0;i<2;i++)await sql(asAdmin(`select public.admin_create_registration(${r.group_id},'Synthetic','synthetic.invalid',null,array[${r.class_ids[0]}]::bigint[]);`))
    const input=await edit(r.group_id),before=await read(r.group_id);input.group.title='Must roll back';input.classes[0].capacity=1
    await assert.rejects(save(input),/capacity below/);assert.deepEqual(await read(r.group_id),before)
  })
  await t.test('concurrent public application is counted before capacity reduction',async()=>{
    const r=await save(payload());await sql(`update public.event_groups set registration_open=true where id=${r.group_id};update public.schedules set registration_enabled=true where id=${r.class_ids[0]};`)
    await sql(asAdmin(`select public.admin_create_registration(${r.group_id},'Synthetic','synthetic.invalid',null,array[${r.class_ids[0]}]::bigint[]);`))
    const input=await edit(r.group_id);input.group.title='Must roll back';input.classes[0].capacity=1
    let locked;const signal=new Promise(resolve=>locked=resolve)
    const writer=sql(`begin;select id from public.event_groups where id=${r.group_id} for update;select 'LOCKED';select pg_sleep(0.5);select public.submit_registration(${r.group_id},'Synthetic','synthetic.invalid',null,array[${r.class_ids[0]}]::bigint[]);commit;`,out=>{if(out.includes('LOCKED'))locked()})
    await signal;await assert.rejects(save(input),/capacity below/);await writer;assert.equal((await read(r.group_id)).classes[0].capacity,10)
    assert.equal(await sql(`select count(*) from public.registration_items where schedule_id=${r.class_ids[0]} and status='active';`),'2')
  })
  for(const role of ['anon','service_role','authenticated'])await t.test(`non-admin ${role} cannot read or save`,async()=>{
    await assert.rejects(sql(`set role ${role};${statement(payload(),randomUUID())}`),/permission denied|administrator access/)
    await assert.rejects(sql(`set role ${role};select public.admin_get_occurrence_editor(1);`),/permission denied|administrator access/)
  })
  await t.test('concurrent class edit is detected after waiting for row lock',async()=>{
    const r=await save(payload()),input=await edit(r.group_id);let locked;const signal=new Promise(resolve=>locked=resolve)
    const writer=sql(`begin;select id from public.schedules where id=${r.class_ids[0]} for update;select 'LOCKED';select pg_sleep(0.5);update public.schedules set title='Concurrent' where id=${r.class_ids[0]};commit;`,out=>{if(out.includes('LOCKED'))locked()})
    await signal;await assert.rejects(save(input),/occurrence changed/);await writer;assert.equal((await read(r.group_id)).classes[0].title,'Concurrent')
  })
  t.diagnostic('Only this isolated container was used; t.after stops it and --rm removes it.')
})
