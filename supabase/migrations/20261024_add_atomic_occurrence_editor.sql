-- Review and apply to preview separately. No existing data or registration RPC is changed.
begin;

create schema occurrence_private;
revoke all on schema occurrence_private from public, anon, authenticated, service_role;
create table occurrence_private.save_requests (
  request_key uuid primary key,
  actor_id uuid not null,
  input jsonb not null,
  result jsonb null,
  created_at timestamptz not null default clock_timestamp()
);
alter table occurrence_private.save_requests enable row level security;
revoke all on occurrence_private.save_requests from public, anon, authenticated, service_role;

-- Exact raw edit-start snapshot; contains event metadata only, never applicants.
create function public.admin_get_occurrence_editor(p_group_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_group jsonb; v_classes jsonb;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception using errcode = '42501', message = 'administrator access is required';
  end if;
  select jsonb_build_object('title', title, 'description', description, 'city', city,
    'start_date', start_date, 'end_date', end_date, 'registration_open', registration_open)
    into v_group from public.event_groups where id = p_group_id;
  if not found then raise exception using errcode = 'PT404', message = 'group not found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'date', date,
    'start_time', start_time, 'end_time', end_time, 'location', location, 'type', type,
    'capacity', capacity, 'registration_enabled', registration_enabled) order by id), '[]'::jsonb)
    into v_classes from public.schedules where event_group_id = p_group_id;
  return jsonb_build_object('group', v_group, 'classes', v_classes);
end;
$$;

create function public.admin_save_occurrence(p_key uuid, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reserved uuid; v_request occurrence_private.save_requests%rowtype;
  v_group jsonb; v_row jsonb; v_id bigint; v_class_id bigint;
  v_start date; v_end date; v_date date; v_capacity integer;
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
    or v_group - array['title','description','city','start_date','end_date'] <> '{}'::jsonb
    or jsonb_typeof(v_group->'title') <> 'string' or char_length(btrim(v_group->>'title')) not between 1 and 200
    or jsonb_typeof(v_group->'description') not in ('null','string') or char_length(v_group->>'description') > 3000
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

  -- Validate every row before applying changes. End times and group membership are never client writable here.
  for v_row in select value from jsonb_array_elements(p_input->'classes') loop
    if jsonb_typeof(v_row) <> 'object' or not (v_row ?& array['id','title','date','start_time','location','type','capacity','registration_enabled'])
      or v_row - array['id','title','date','start_time','location','type','capacity','registration_enabled'] <> '{}'::jsonb
      or jsonb_typeof(v_row->'id') not in ('number','null')
      or (v_row->'id' <> 'null'::jsonb and ((v_row->>'id') !~ '^[1-9][0-9]*$' or (v_row->>'id')::numeric > 9007199254740991))
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
    insert into public.event_groups(title, description, city, start_date, end_date, registration_open)
      values (btrim(v_group->>'title'), v_group->>'description', nullif(btrim(v_group->>'city'), ''), v_start, v_end, false)
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
    v_current := public.admin_get_occurrence_editor(v_id);
    if v_current is distinct from v_expected then raise exception using errcode = 'PT409', message = 'occurrence changed'; end if;
    select coalesce(array_agg(id order by id), '{}'::bigint[]) into v_current_ids from public.schedules where event_group_id = v_id;
    if (select coalesce(array_agg(x order by x), '{}'::bigint[]) from unnest(v_ids) x) is distinct from v_current_ids then
      raise exception using errcode = 'PT409', message = 'class membership changed or omitted';
    end if;
    update public.event_groups set title = btrim(v_group->>'title'), description = v_group->>'description',
      city = nullif(btrim(v_group->>'city'), ''), start_date = v_start, end_date = v_end where id = v_id;
    -- registration_open is deliberately absent: saving never opens/reopens reception.
  end if;

  for v_row in select value from jsonb_array_elements(p_input->'classes') loop
    v_class_id := (v_row->>'id')::bigint; v_capacity := (v_row->>'capacity')::integer;
    if v_class_id is null then
      insert into public.schedules(title, date, start_time, end_time, location, type, event_group_id, capacity, registration_enabled)
        values (btrim(v_row->>'title'), v_row->>'date', v_row->>'start_time', null, v_row->>'location', v_row->>'type', v_id, v_capacity, (v_row->>'registration_enabled')::boolean)
        returning id into v_class_id;
    else
      if (select count(*) from public.registration_items where schedule_id = v_class_id and status = 'active') > coalesce(v_capacity, 0) then
        raise exception using errcode = '23514', message = 'capacity below active registrations';
      end if;
      update public.schedules set title = btrim(v_row->>'title'), date = v_row->>'date', start_time = v_row->>'start_time',
        location = v_row->>'location', type = v_row->>'type', capacity = v_capacity, registration_enabled = (v_row->>'registration_enabled')::boolean
        where id = v_class_id and event_group_id = v_id;
      if not found then raise exception using errcode = 'PT409', message = 'class membership changed'; end if;
      -- Never UPDATE end_time, event_group_id, registrations or cancellation history.
    end if;
    v_saved_ids := array_append(v_saved_ids, v_class_id);
  end loop;
  v_result := jsonb_build_object('group_id', v_id, 'class_ids', v_saved_ids);
  update occurrence_private.save_requests set result = v_result where request_key = p_key;
  return v_result;
end;
$$;
revoke all on function public.admin_get_occurrence_editor(bigint) from public, anon, authenticated, service_role;
revoke all on function public.admin_save_occurrence(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.admin_get_occurrence_editor(bigint) to authenticated;
grant execute on function public.admin_save_occurrence(uuid, jsonb) to authenticated;
commit;
