import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const sql=fs.readFileSync('supabase/migrations/20261106_add_occurrence_participation_notes.sql','utf8')
const old=fs.readFileSync('supabase/migrations/20261027_open_new_occurrence_registration.sql','utf8')
const marker='create or replace function public.admin_save_occurrence('
const oldSave=old.slice(old.indexOf(marker),old.indexOf('revoke all on function public.admin_save_occurrence'))
const save=sql.slice(sql.indexOf(marker),sql.indexOf('-- CREATE OR REPLACE preserves'))

test('migration adds only nullable bounded notes without rewriting existing business data or RLS',()=>{
 assert.match(sql,/alter table public\.event_groups add column participation_notes text null/)
 assert.match(sql,/participation_notes is null or char_length\(participation_notes\) <= 3000/)
 assert.ok(sql.trimEnd().endsWith('commit;'))
 assert.match(sql,/^begin;/m)
 assert.doesNotMatch(sql,/\b(?:drop|truncate|create policy|alter policy|alter role)\b/i)
 assert.doesNotMatch(sql,/alter table[^;]*(?:enable|disable|force) row level security/i)
 assert.doesNotMatch(sql.slice(0,sql.indexOf('create function')),/\b(?:update|insert|delete)\s+(?:public\.|from)/i)
})
test('original getter signature is retained; explicit notes overload uses the same admin guard and a single snapshot SELECT',()=>{
 assert.match(sql,/create function public\.admin_get_occurrence_editor\(p_group_id bigint, p_include_participation_notes boolean\)/)
 assert.doesNotMatch(sql,/create(?: or replace)? function public\.admin_get_occurrence_editor\(p_group_id bigint\)/)
 assert.doesNotMatch(sql,/p_include_participation_notes boolean default/i)
 const getter=sql.slice(sql.indexOf('create function'),sql.indexOf(marker))
 assert.match(getter,/security definer set search_path = ''/)
 assert.match(getter,/if not coalesce\(public\.is_admin\(\), false\)/)
 assert.match(getter,/return public\.admin_get_occurrence_editor\(p_group_id\)/)
 assert.match(getter,/'participation_notes', g\.participation_notes/)
 assert.equal((getter.match(/\binto v_snapshot\b/g)||[]).length,1)
 assert.match(getter,/revoke all on function public\.admin_get_occurrence_editor\(bigint, boolean\) from public, anon, authenticated, service_role/)
 assert.match(getter,/grant execute on function public\.admin_get_occurrence_editor\(bigint, boolean\) to authenticated/)
 assert.match(sql,/notify pgrst, 'reload schema'/)
})
test('save arguments/result/privileges and raw idempotency reservation/replay are unchanged',()=>{
 const reservationEnd="  v_group := p_input->'group';"
 assert.equal(save.slice(0,save.indexOf(reservationEnd)),oldSave.slice(0,oldSave.indexOf(reservationEnd)))
 assert.match(save,/v_request\.input is distinct from p_input/)
 assert.ok(save.indexOf('return v_request.result;')<save.indexOf("v_group := p_input->'group'"))
 assert.doesNotMatch(sql,/\b(?:grant|revoke)\b[^;]*admin_save_occurrence/i)
 assert.match(save,/v_result := jsonb_build_object\('group_id', v_id, 'class_ids', v_saved_ids\)/)
})
test('class validation, membership, capacity, reception behavior and locking order are retained',()=>{
 const validationStart="  for v_row in select value from jsonb_array_elements(p_input->'classes') loop"
 const validationEnd="  if p_input->'group_id' = 'null'::jsonb then"
 assert.equal(save.slice(save.indexOf(validationStart),save.indexOf(validationEnd)),oldSave.slice(oldSave.indexOf(validationStart),oldSave.indexOf(validationEnd)))
 const updateStart="  for v_row in select value from jsonb_array_elements(p_input->'classes') loop", last=save.lastIndexOf(updateStart),oldLast=oldSave.lastIndexOf(updateStart)
 assert.equal(save.slice(last),oldSave.slice(oldLast))
 assert.match(save,/perform 1 from public\.event_groups where id = v_id for update/)
 assert.match(save,/perform id from public\.schedules where event_group_id = v_id order by id for update/)
 assert.match(save,/v_start, v_end, v_group->>'participation_notes', true\)/)
})
test('omitted notes preserve existing values and explicit updates require and compare an extended snapshot',()=>{
 assert.match(save,/participation_notes = case when v_group \? 'participation_notes' then v_group->>'participation_notes' else participation_notes end/)
 assert.match(save,/if \(v_group \? 'participation_notes'\) and not coalesce\(\(v_expected->'group'\) \? 'participation_notes', false\)/)
 assert.match(save,/v_current := public\.admin_get_occurrence_editor\(v_id, true\)/)
 assert.match(save,/v_current := public\.admin_get_occurrence_editor\(v_id\)/)
 assert.match(save,/if v_current is distinct from v_expected then raise exception using errcode = 'PT409'/)
 assert.ok(save.indexOf("message = 'participation notes snapshot required'")<save.indexOf('update public.event_groups'))
 assert.match(save,/jsonb_typeof\(v_group->'participation_notes'\) not in \('null','string'\)/)
 assert.match(save,/char_length\(v_group->>'participation_notes'\) > 3000/)
})


test('migration preflight refuses missing or incompatible existing RPC contracts before DDL',()=>{
 assert.ok(sql.indexOf('do $preflight$')<sql.indexOf('alter table public.event_groups'))
 assert.match(sql,/to_regprocedure\('public\.admin_get_occurrence_editor\(bigint\)'\)/)
 assert.match(sql,/to_regprocedure\('public\.admin_save_occurrence\(uuid,jsonb\)'\)/)
 assert.match(sql,/p\.prorettype <> 'pg_catalog\.jsonb'::pg_catalog\.regtype or not p\.prosecdef/)
})
