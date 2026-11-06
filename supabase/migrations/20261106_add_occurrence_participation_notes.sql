-- Preview ONLY: ofyxyiumpjsfmycchbki. Review cloud function definitions/ACLs before manual application.
-- Preparation does not authorize applying this migration. Existing description/data are not rewritten.
-- The original one-argument getter remains unchanged for legacy strict-snapshot clients.
-- The new overload has NO default argument: old PostgREST calls remain unambiguous.
-- admin_save_occurrence arguments/result, raw idempotency input, reception/capacity logic and ACLs are preserved.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Fail rather than accidentally creating/replacing a different function contract.
do $preflight$
begin
  if pg_catalog.to_regprocedure('public.admin_get_occurrence_editor(bigint)') is null
    or pg_catalog.to_regprocedure('public.admin_save_occurrence(uuid,jsonb)') is null then
    raise exception 'STOP: expected occurrence RPCs are missing';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
    where p.oid in (pg_catalog.to_regprocedure('public.admin_get_occurrence_editor(bigint)'),
      pg_catalog.to_regprocedure('public.admin_save_occurrence(uuid,jsonb)'))
    and (p.prorettype <> 'pg_catalog.jsonb'::pg_catalog.regtype or not p.prosecdef)) then
    raise exception 'STOP: occurrence RPC attributes require review';
  end if;
end;
$preflight$;

alter table public.event_groups add column participation_notes text null
  constraint event_groups_participation_notes_length check (participation_notes is null or char_length(participation_notes) <= 3000);

create function public.admin_get_occurrence_editor(p_group_id bigint, p_include_participation_notes boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_snapshot jsonb;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception using errcode = '42501', message = 'administrator access is required';
  end if;
  if p_include_participation_notes is not true then
    return public.admin_get_occurrence_editor(p_group_id);
  end if;
  -- One statement captures parent metadata and all classes from the same snapshot.
  select jsonb_build_object(
    'group', jsonb_build_object('title', g.title, 'description', g.description,
      'participation_notes', g.participation_notes, 'city', g.city,
      'start_date', g.start_date, 'end_date', g.end_date, 'registration_open', g.registration_open),
    'classes', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'date', s.date,
      'start_time', s.start_time, 'end_time', s.end_time, 'location', s.location, 'type', s.type,
      'capacity', s.capacity, 'registration_enabled', s.registration_enabled) order by s.id), '[]'::jsonb)
      from public.schedules s where s.event_group_id = g.id))
    into v_snapshot from public.event_groups g where g.id = p_group_id;
  if not found then raise exception using errcode = 'PT404', message = 'group not found'; end if;
  return v_snapshot;
end;
$$;
revoke all on function public.admin_get_occurrence_editor(bigint, boolean) from public, anon, authenticated, service_role;
grant execute on function public.admin_get_occurrence_editor(bigint, boolean) to authenticated;

create or replace function public.admin_save_occurrence(p_key uuid, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reserved uuid; v_request occurrence_private.save_requests%rowtype;
  v_group jsonb; v_row jsonb; v_id bigint; v_class_id bigint;
  v_start date; v_end date; v_date date; v_capacity integer;
  v_effective_end text; v_previous_start text;
  v_expected jsonb; v_current jsonb; v_ids bigint[] := '{}'::bigint[];
  v_current_ids bigint[]; v_saved_ids bigint[] := '{}'::bigint[]; v_result jsonb;
begin
  if not coalesce(public.is_admin(), false) or auth.uid() is null then
    raise exception using errcode = '42501', message = 'administrator access is required';
  end if;
  -- Fresh statement snapshots are required for same-key waits and capacity counts.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '22023', message = 'read committed transaction required';
  end if;
  if p_key is null or p_input is null or jsonb_typeof(p_input) <> 'object'
    or octet_length(p_input::text) > 131072
    or not (p_input ?& array['group_id','group','classes','expected'])
    or p_input - array['group_id','group','classes','expected'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'invalid save input';
  end if;

  -- Same-key concurrent insert waits for commit, then a NEW statement reads it.
  -- Reservation, all changes, and the result commit together. Failed attempts leave no row.
  insert into occurrence_private.save_requests(request_key, actor_id, input)
    values (p_key, auth.uid(), p_input) on conflict do nothing returning request_key into v_reserved;
  if v_reserved is null then
    select * into strict v_request from occurrence_private.save_requests where request_key = p_key for update;
    if v_request.actor_id is distinct from auth.uid() or v_request.input is distinct from p_input then
      raise exception using errcode = 'PT409', message = 'save key conflicts with request';
    end if;
    if v_request.result is null then raise exception using errcode = '55000', message = 'incomplete save'; end if;
    return v_request.result;
  end if;

  v_group := p_input->'group'; v_expected := p_input->'expected';
  if jsonb_typeof(v_group) <> 'object' or not (v_group ?& array['title','description','city','start_date','end_date'])
    or v_group - array['title','description','city','start_date','end_date','participation_notes'] <> '{}'::jsonb
    or jsonb_typeof(v_group->'title') <> 'string' or char_length(btrim(v_group->>'title')) not between 1 and 200
    or jsonb_typeof(v_group->'description') not in ('null','string') or char_length(v_group->>'description') > 3000
    or ((v_group ? 'participation_notes') and (jsonb_typeof(v_group->'participation_notes') not in ('null','string') or char_length(v_group->>'participation_notes') > 3000))
    or jsonb_typeof(v_group->'city') not in ('null','string') or char_length(btrim(v_group->>'city')) > 100
    or jsonb_typeof(v_group->'start_date') <> 'string' or jsonb_typeof(v_group->'end_date') <> 'string'
    or (v_group->>'start_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or (v_group->>'end_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception using errcode = '22023', message = 'invalid group fields';
  end if;
  v_start := (v_group->>'start_date')::date; v_end := (v_group->>'end_date')::date;
  if v_start > v_end then raise exception using errcode = '22023', message = 'invalid date range'; end if;
  if jsonb_typeof(p_input->'classes') <> 'array' then raise exception using errcode = '22023', message = 'invalid classes'; end if;
  if jsonb_array_length(p_input->'classes') not between 1 and 100 then raise exception using errcode = '22023', message = 'invalid class count'; end if;

  -- Validate every row before applying changes. End times are optional explicit changes; group membership is never client writable here.
  for v_row in select value from jsonb_array_elements(p_input->'classes') loop
    if jsonb_typeof(v_row) <> 'object' or not (v_row ?& array['id','title','date','start_time','location','type','capacity','registration_enabled'])
      or v_row - array['id','title','date','start_time','location','type','capacity','registration_enabled','end_time'] <> '{}'::jsonb
      or jsonb_typeof(v_row->'id') not in ('number','null')
      or (v_row->'id' <> 'null'::jsonb and ((v_row->>'id') !~ '^[1-9][0-9]*$' or (v_row->>'id')::numeric > 9007199254740991))
      or ((v_row ? 'end_time') and (jsonb_typeof(v_row->'end_time') not in ('null','string') or (v_row->'end_time' <> 'null'::jsonb and (v_row->>'end_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')))
      or jsonb_typeof(v_row->'title') <> 'string' or char_length(btrim(v_row->>'title')) not between 1 and 200
      or jsonb_typeof(v_row->'date') <> 'string' or (v_row->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or jsonb_typeof(v_row->'location') <> 'string' or char_length(btrim(v_row->>'location')) not between 1 and 500
      or jsonb_typeof(v_row->'start_time') <> 'string' or (v_row->>'start_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      or jsonb_typeof(v_row->'type') <> 'string' or (v_row->>'type') not in ('稽古会','一般参加')
      or jsonb_typeof(v_row->'registration_enabled') <> 'boolean'
      or jsonb_typeof(v_row->'capacity') not in ('number','null')
      or (v_row->'capacity' <> 'null'::jsonb and ((v_row->>'capacity') !~ '^[1-9][0-9]*$' or (v_row->>'capacity')::numeric > 2147483647)) then
      raise exception using errcode = '22023', message = 'invalid class fields';
    end if;
    v_date := (v_row->>'date')::date;
    if v_date < v_start or v_date > v_end then raise exception using errcode = '22023', message = 'class date outside occurrence'; end if;
    if v_row->'id' <> 'null'::jsonb then
      v_class_id := (v_row->>'id')::bigint;
      if v_class_id = any(v_ids) then raise exception using errcode = '22023', message = 'duplicate class'; end if;
      v_ids := array_append(v_ids, v_class_id);
    elsif v_row->'capacity' = 'null'::jsonb then
      raise exception using errcode = '22023', message = 'new class requires capacity';
    end if;
  end loop;

  if p_input->'group_id' = 'null'::jsonb then
    if v_expected <> 'null'::jsonb or cardinality(v_ids) <> 0 then raise exception using errcode = '22023', message = 'invalid creation snapshot'; end if;
    insert into public.event_groups(title, description, city, start_date, end_date, participation_notes, registration_open)
      values (btrim(v_group->>'title'), v_group->>'description', nullif(btrim(v_group->>'city'), ''), v_start, v_end, v_group->>'participation_notes', true)
      returning id into v_id;
  else
    if jsonb_typeof(p_input->'group_id') <> 'number' or (p_input->>'group_id') !~ '^[1-9][0-9]*$'
      or (p_input->>'group_id')::numeric > 9007199254740991 or jsonb_typeof(v_expected) <> 'object' then
      raise exception using errcode = '22023', message = 'invalid edit snapshot';
    end if;
    v_id := (p_input->>'group_id')::bigint;
    -- Parent first, then ALL existing classes in ID order, matching public creation lock order.
    -- FOR UPDATE on parent also blocks FK inserts/reassignment until this transaction ends.
    perform 1 from public.event_groups where id = v_id for update;
    if not found then raise exception using errcode = 'PT404', message = 'group not found'; end if;
    perform id from public.schedules where event_group_id = v_id order by id for update;
    -- A new field may only be written against a snapshot that includes it.
    -- Omission in a legacy request preserves the currently stored notes.
    if (v_group ? 'participation_notes') and not coalesce((v_expected->'group') ? 'participation_notes', false) then
      raise exception using errcode = 'PT409', message = 'participation notes snapshot required';
    end if;
    if coalesce((v_expected->'group') ? 'participation_notes', false) then
      v_current := public.admin_get_occurrence_editor(v_id, true);
    else
      v_current := public.admin_get_occurrence_editor(v_id);
    end if;
    if v_current is distinct from v_expected then raise exception using errcode = 'PT409', message = 'occurrence changed'; end if;
    select coalesce(array_agg(id order by id), '{}'::bigint[]) into v_current_ids from public.schedules where event_group_id = v_id;
    if (select coalesce(array_agg(x order by x), '{}'::bigint[]) from unnest(v_ids) x) is distinct from v_current_ids then
      raise exception using errcode = 'PT409', message = 'class membership changed or omitted';
    end if;
    update public.event_groups set title = btrim(v_group->>'title'), description = v_group->>'description',
      participation_notes = case when v_group ? 'participation_notes' then v_group->>'participation_notes' else participation_notes end,
      city = nullif(btrim(v_group->>'city'), ''), start_date = v_start, end_date = v_end where id = v_id;
    -- registration_open is deliberately absent: saving never opens/reopens reception.
  end if;

  for v_row in select value from jsonb_array_elements(p_input->'classes') loop
    v_class_id := (v_row->>'id')::bigint; v_capacity := (v_row->>'capacity')::integer;
    if v_class_id is null then
      v_effective_end := v_row->>'end_time'; v_previous_start := null;
    else
      select end_time, start_time into v_effective_end, v_previous_start from public.schedules where id = v_class_id and event_group_id = v_id;
      if v_row ? 'end_time' then v_effective_end := v_row->>'end_time'; end if;
    end if;
    if ((v_row ? 'end_time') or v_previous_start is distinct from v_row->>'start_time') and v_effective_end is not null and v_effective_end::time < (v_row->>'start_time')::time then
      raise exception using errcode = '22023', message = 'end time precedes start time';
    end if;
    if v_class_id is null then
      insert into public.schedules(title, date, start_time, end_time, location, type, event_group_id, capacity, registration_enabled)
        values (btrim(v_row->>'title'), v_row->>'date', v_row->>'start_time', v_effective_end, v_row->>'location', v_row->>'type', v_id, v_capacity, (v_row->>'registration_enabled')::boolean)
        returning id into v_class_id;
    else
      if (select count(*) from public.registration_items where schedule_id = v_class_id and status = 'active') > coalesce(v_capacity, 0) then
        raise exception using errcode = '23514', message = 'capacity below active registrations';
      end if;
      update public.schedules set title = btrim(v_row->>'title'), date = v_row->>'date', start_time = v_row->>'start_time',
        end_time = case when v_row ? 'end_time' then v_effective_end else end_time end,
        location = v_row->>'location', type = v_row->>'type', capacity = v_capacity, registration_enabled = (v_row->>'registration_enabled')::boolean
        where id = v_class_id and event_group_id = v_id;
      if not found then raise exception using errcode = 'PT409', message = 'class membership changed'; end if;
      -- End time is updated only on explicit input. Membership and registration history are unchanged.
    end if;
    v_saved_ids := array_append(v_saved_ids, v_class_id);
  end loop;
  v_result := jsonb_build_object('group_id', v_id, 'class_ids', v_saved_ids);
  update occurrence_private.save_requests set result = v_result where request_key = p_key;
  return v_result;
end;
$$;
-- CREATE OR REPLACE preserves existing owner and EXECUTE privileges of the save function.
-- No RLS policies, roles, existing request records, or one-argument getter are changed.
notify pgrst, 'reload schema';
commit;
