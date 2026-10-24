-- Preview only. Additive state, no cancellation/deletion of existing applications.
begin;
alter table public.event_groups
  add column is_cancelled boolean not null default false,
  add column is_hidden boolean not null default false,
  add column state_version bigint not null default 0,
  add constraint event_groups_blocked_reception check (not (is_cancelled or is_hidden) or not registration_open);

create function public.enforce_event_group_state() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    new.state_version := 0;
    if new.is_cancelled or new.is_hidden then new.registration_open := false; end if;
  else
    if old.is_cancelled and not new.is_cancelled then
      raise exception using errcode = '23514', message = 'cancellation cannot be reversed';
    end if;
    if new.is_cancelled is distinct from old.is_cancelled or new.is_hidden is distinct from old.is_hidden then
      new.registration_open := false;
    end if;
    new.state_version := old.state_version + case when
      new.is_cancelled is distinct from old.is_cancelled or new.is_hidden is distinct from old.is_hidden or new.registration_open is distinct from old.registration_open then 1 else 0 end;
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_event_group_state() from public, anon, authenticated, service_role;
create trigger event_groups_enforce_state before insert or update on public.event_groups
for each row execute function public.enforce_event_group_state();

-- Restrictive policies AND with ALL existing permissive SELECT policies.
create policy event_groups_hide_anon on public.event_groups as restrictive for select to anon
using (not is_hidden);
create policy event_groups_hide_members on public.event_groups as restrictive for select to authenticated
using ((select public.is_admin()) or not is_hidden);
create policy schedules_hide_anon on public.schedules as restrictive for select to anon
using (event_group_id is null or exists (
  select 1 from public.event_groups eg where eg.id = schedules.event_group_id and not eg.is_hidden
));
create policy schedules_hide_members on public.schedules as restrictive for select to authenticated
using ((select public.is_admin()) or event_group_id is null or exists (
  select 1 from public.event_groups eg where eg.id = schedules.event_group_id and not eg.is_hidden
));

create function public.admin_set_event_group_state(p_group_id bigint, p_action text, p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.event_groups%rowtype;
begin
  if not coalesce(public.is_admin(), false) or auth.uid() is null then
    raise exception using errcode = '42501', message = 'administrator access is required';
  end if;
  if p_group_id is null or p_group_id <= 0 or p_expected_version is null or p_expected_version < 0 or p_action is null or p_action not in ('cancel','hide','show') then
    raise exception using errcode = '22023', message = 'invalid state operation';
  end if;
  select * into g from public.event_groups where id = p_group_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'group not found'; end if;
  if g.state_version <> p_expected_version then raise exception using errcode = 'PT409', message = 'state changed'; end if;
  update public.event_groups set
    is_cancelled = case when p_action = 'cancel' then true else is_cancelled end,
    is_hidden = case when p_action = 'hide' then true when p_action = 'show' then false else is_hidden end,
    registration_open = false
    where id = p_group_id and state_version = p_expected_version returning * into g;
  if not found then raise exception using errcode = 'PT409', message = 'state changed'; end if;
  return jsonb_build_object('id',g.id,'is_cancelled',g.is_cancelled,'is_hidden',g.is_hidden,'registration_open',g.registration_open,'state_version',g.state_version);
end;
$$;
revoke all on function public.admin_set_event_group_state(bigint,text,bigint) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_event_group_state(bigint,text,bigint) to authenticated;
create or replace function public.create_registration(
  p_event_group_id bigint,
  p_name text,
  p_contact text,
  p_notes text,
  p_schedule_ids bigint[],
  p_require_open boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_registration_id bigint;
  v_registration_open boolean; v_blocked boolean;
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'a valid name is required';
  end if;

  if p_contact is null or char_length(btrim(p_contact)) not between 1 and 254 then
    raise exception using errcode = '22023', message = 'a valid contact is required';
  end if;

  if p_notes is not null and char_length(p_notes) > 2000 then
    raise exception using errcode = '22023', message = 'notes are too long';
  end if;

  select eg.registration_open, (eg.is_cancelled or eg.is_hidden) into v_registration_open, v_blocked
  from public.event_groups as eg
  where eg.id = p_event_group_id
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'event group does not exist';
  end if;

  if v_blocked or (p_require_open and not v_registration_open) then
    raise exception using errcode = '22023', message = 'registration is closed';
  end if;

  insert into public.registrations (event_group_id, name, contact, notes)
  values (p_event_group_id, btrim(p_name), btrim(p_contact), nullif(btrim(p_notes), ''))
  returning id into v_registration_id;

  perform public.add_registration_items(v_registration_id, p_event_group_id, p_schedule_ids);
end;
$$;

-- Called only by Next.js POST /api/registrations with a server-side Secret Key.
-- It returns no applicant information and cannot be executed by anon/authenticated.
create or replace function public.add_registration_items(
  p_registration_id bigint,
  p_event_group_id bigint,
  p_schedule_ids bigint[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule record; v_blocked boolean;
  v_schedule_id bigint;
  v_locked_count integer := 0;
  v_active_count integer;
begin
  select is_cancelled or is_hidden into v_blocked from public.event_groups where id = p_event_group_id for update;
  if not found or v_blocked then
    raise exception using errcode = '22023', message = 'registration is closed';
  end if;
  if p_schedule_ids is null or cardinality(p_schedule_ids) = 0 then
    raise exception using errcode = '22023', message = 'at least one class must be selected';
  end if;

  if array_position(p_schedule_ids, null) is not null then
    raise exception using errcode = '22023', message = 'class ids cannot contain null';
  end if;

  if (
    select count(*) <> count(distinct requested.schedule_id)
    from unnest(p_schedule_ids) as requested(schedule_id)
  ) then
    raise exception using errcode = '22023', message = 'duplicate class ids are not allowed';
  end if;

  for v_schedule_id in
    select requested.schedule_id
    from unnest(p_schedule_ids) as requested(schedule_id)
    order by requested.schedule_id
  loop
    select s.id, s.event_group_id, s.capacity, s.registration_enabled
      into v_schedule
      from public.schedules as s
      where s.id = v_schedule_id
      for update;

    if not found then
      raise exception using errcode = '22023', message = 'one or more selected classes do not exist';
    end if;

    v_locked_count := v_locked_count + 1;

    if v_schedule.event_group_id is distinct from p_event_group_id then
      raise exception using errcode = '22023', message = 'classes must belong to the same event group';
    end if;

    if not v_schedule.registration_enabled or v_schedule.capacity is null then
      raise exception using errcode = '22023', message = 'class is not accepting registrations';
    end if;

    select count(*) into v_active_count
    from public.registration_items as ri
    where ri.schedule_id = v_schedule.id
      and ri.status = 'active';

    if v_active_count >= v_schedule.capacity then
      raise exception using errcode = 'P0001', message = 'one or more selected classes are full';
    end if;
  end loop;

  if v_locked_count <> cardinality(p_schedule_ids) then
    raise exception using errcode = '22023', message = 'one or more selected classes do not exist';
  end if;

  insert into public.registration_items (registration_id, event_group_id, schedule_id)
  select p_registration_id, p_event_group_id, requested.schedule_id
  from unnest(p_schedule_ids) as requested(schedule_id);
end;
$$;

-- Internal creation helper. p_require_open is true for a public application
-- and false for a verified administrator's proxy registration.
create or replace function public.get_event_group_availability(p_event_group_id bigint)
returns table (
  schedule_id bigint,
  capacity integer,
  registered_count bigint,
  remaining_capacity integer,
  is_full boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id as schedule_id,
    s.capacity,
    count(ri.id)::bigint as registered_count,
    greatest(s.capacity - count(ri.id)::integer, 0) as remaining_capacity,
    count(ri.id) >= s.capacity as is_full
  from public.schedules as s
  left join public.registration_items as ri
    on ri.schedule_id = s.id
    and ri.status = 'active'
  where s.event_group_id = p_event_group_id
    and exists (select 1 from public.event_groups eg where eg.id = p_event_group_id and not eg.is_hidden and not eg.is_cancelled)
    and s.capacity is not null
  group by s.id, s.capacity, s.date, s.start_time
  order by s.date, s.start_time, s.id;
$$;

-- A proxy registration may be accepted after public registration has closed,
-- but it always uses the same capacity-locking helper and never overbooks.

commit;
