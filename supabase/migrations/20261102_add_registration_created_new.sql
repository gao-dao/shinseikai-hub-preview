-- Forward migration: only add per-call creation metadata. Preserve existing owner/ACL.
-- Before applying, compare the deployed function and owner/ACL; stop on unexpected drift.
begin;
create or replace function public.submit_registration_idempotent(
  p_idempotency_key uuid,
  p_event_group_id bigint,
  p_name text,
  p_contact text,
  p_notes text,
  p_schedule_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request registration_private.registration_requests%rowtype;
  v_secret bytea;
  v_fingerprint bytea;
  v_schedule_ids bigint[];
  v_inserted_key uuid;
  v_code text := 'REGISTERED';
  v_http_status integer := 201;
  v_completed_at timestamptz;
begin
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'idempotency key is required';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'a valid name is required';
  end if;
  if p_contact is null or char_length(btrim(p_contact)) not between 1 and 254 then
    raise exception using errcode = '22023', message = 'a valid contact is required';
  end if;
  if p_notes is not null and char_length(p_notes) > 2000 then
    raise exception using errcode = '22023', message = 'notes are too long';
  end if;
  if p_schedule_ids is null or cardinality(p_schedule_ids) = 0
     or array_position(p_schedule_ids, null) is not null then
    raise exception using errcode = '22023', message = 'valid class ids are required';
  end if;
  if (select count(*) <> count(distinct id) from unnest(p_schedule_ids) as requested(id)) then
    raise exception using errcode = '22023', message = 'duplicate class ids are not allowed';
  end if;
  select array_agg(id order by id) into v_schedule_ids from unnest(p_schedule_ids) as requested(id);

  select secret into strict v_secret from registration_private.fingerprint_secret where singleton;
  -- Normalize exactly as the delegated registration function does. Sorting is
  -- semantic normalization, not deduplication. Key inclusion prevents correlation
  -- of equal applicant data across unrelated requests. Never persist the JSON.
  v_fingerprint := extensions.hmac(
    convert_to(jsonb_build_array(
      'public_registration:v1', p_idempotency_key, p_event_group_id,
      btrim(p_name), btrim(p_contact), nullif(btrim(p_notes), ''), v_schedule_ids
    )::text, 'UTF8'), v_secret, 'sha256'
  );

  insert into registration_private.registration_requests (idempotency_key, request_fingerprint, state)
  values (p_idempotency_key, v_fingerprint, 'processing')
  on conflict (idempotency_key) do nothing
  returning idempotency_key into v_inserted_key;

  if v_inserted_key is null then
    -- Separate statement: READ COMMITTED must take a new snapshot after waiting
    -- for a competing unique-index insertion to commit. Never use a CTE fallback.
    select * into strict v_request from registration_private.registration_requests
      where idempotency_key = p_idempotency_key for update;
    if v_request.expires_at is not null and clock_timestamp() >= v_request.expires_at then
      -- Keep the used-key row indefinitely. No expiry-to-new-request conversion.
      raise exception using errcode = 'PT410', message = 'idempotency key has expired';
    end if;
    if v_request.fingerprint_version <> 1 or v_request.request_fingerprint <> v_fingerprint then
      raise exception using errcode = 'PT409', message = 'idempotency key conflicts with request';
    end if;
    if v_request.state = 'processing' then
      raise exception using errcode = '55000', message = 'idempotency record is incomplete';
    end if;
    return jsonb_build_object('success', v_request.state = 'succeeded', 'code', v_request.result_code, 'http_status', v_request.http_status, 'created_new', false);
  end if;

  begin
    -- One call, one transaction. Replays never recheck mutable availability or
    -- undo administrator cancellations. Do not change these existing functions.
    perform public.submit_registration(p_event_group_id, btrim(p_name), btrim(p_contact), nullif(btrim(p_notes), ''), v_schedule_ids);
  exception when sqlstate '22023' or sqlstate 'P0001' then
    -- This exception block rolls back ALL parent/item changes on business errors,
    -- while the outer reservation survives. Cache only explicitly known errors.
    case
      when sqlstate = '22023' and sqlerrm = 'event group does not exist' then v_code := 'GROUP_NOT_FOUND'; v_http_status := 404;
      when sqlstate = '22023' and sqlerrm = 'registration is closed' then v_code := 'REGISTRATION_CLOSED'; v_http_status := 409;
      when sqlstate = '22023' and sqlerrm = 'one or more selected classes do not exist' then v_code := 'CLASS_NOT_FOUND'; v_http_status := 400;
      when sqlstate = '22023' and sqlerrm = 'classes must belong to the same event group' then v_code := 'CLASS_GROUP_MISMATCH'; v_http_status := 400;
      when sqlstate = '22023' and sqlerrm = 'class is not accepting registrations' then v_code := 'CLASS_CLOSED'; v_http_status := 409;
      when sqlstate = 'P0001' and sqlerrm = 'one or more selected classes are full' then v_code := 'CAPACITY_EXCEEDED'; v_http_status := 409;
      else raise;
    end case;
  end;

  v_completed_at := clock_timestamp();
  update registration_private.registration_requests
    set state = case when v_code = 'REGISTERED' then 'succeeded' else 'rejected' end,
        result_code = v_code, http_status = v_http_status,
        completed_at = v_completed_at, expires_at = v_completed_at + interval '720 hours'
    where idempotency_key = p_idempotency_key;
  return jsonb_build_object('success', v_code = 'REGISTERED', 'code', v_code, 'http_status', v_http_status, 'created_new', v_code = 'REGISTERED');
end;
$$;

commit;
