import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// Explicit opt-in: never connects to .env, Supabase, host ports or a remote DB.
// A private, throwaway PostgreSQL container is the ONLY database target.
const enabled = process.env.SHINSEIKAI_IDEMPOTENCY_DB_TEST === '1'

function command(args, input = '', onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk; onOutput?.(stdout) })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Isolated PostgreSQL test command failed (${code}): ${stderr}`)))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

test('registration idempotency in isolated PostgreSQL 17', { skip: !enabled, timeout: 120000 }, async t => {
  const container = `shinseikai-idempotency-test-${randomUUID().slice(0, 12)}`
  const image = 'ghcr.io/supabase/postgres:17.11.0.004'
  await command(['run', '--pull=never', '--rm', '-d', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=256m,mode=1777', '--memory', '512m', '--user', 'postgres', '--name', container,
    '--entrypoint', '/bin/bash', image, '-ec', 'initdb -D /tmp/test-pg -A trust --no-locale --encoding=UTF8 >/dev/null; exec postgres -D /tmp/test-pg -k /tmp -c listen_addresses='])
  t.after(async () => { await command(['stop', '--time', '1', container]) })
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await command(['exec', container, 'pg_isready', '-h', '/tmp', '-U', 'postgres']); ready = true; break } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  assert.ok(ready, 'temporary database must start')
  const sql = (text, onOutput) => command(['exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres', '-At'], text, onOutput)
  await sql(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
  `)
  for (const migration of ['20260918_initial_baseline.sql', '20261015_add_registration_management.sql', '20261019_add_registration_idempotency.sql']) {
    await sql(await readFile(`supabase/migrations/${migration}`, 'utf8'))
  }
  const definitionSummary = JSON.parse(await sql(`
    begin read only;
    set local search_path = pg_catalog;
    select json_build_object(
      'postgresql_version', current_setting('server_version'),
      'definition_length', char_length(pg_get_functiondef(
        'public.submit_registration_idempotent(uuid,bigint,text,text,text,bigint[])'::regprocedure
      )),
      'definition_md5', md5(pg_get_functiondef(
        'public.submit_registration_idempotent(uuid,bigint,text,text,text,bigint[])'::regprocedure
      ))
    );
    rollback;
  `))
  assert.ok(Number.isInteger(definitionSummary.definition_length) && definitionSummary.definition_length > 0, 'definition length must be a positive integer')
  assert.ok(typeof definitionSummary.definition_md5 === 'string' && /^[0-9a-fA-F]{32}$/.test(definitionSummary.definition_md5), 'definition MD5 must be 32 hexadecimal characters')
  assert.ok(typeof definitionSummary.postgresql_version === 'string' && definitionSummary.postgresql_version.trim().length > 0, 'PostgreSQL version must be a nonempty string')
  t.diagnostic(JSON.stringify({
    postgresql_version: definitionSummary.postgresql_version,
    definition_length: definitionSummary.definition_length,
    definition_md5: definitionSummary.definition_md5,
  }))

  const structureSummary = JSON.parse(await sql(`
    begin read only;
    set local search_path = pg_catalog;
    with targets(schema_name, table_name) as (
      values
        ('registration_private', 'fingerprint_secret'),
        ('registration_private', 'registration_requests'),
        ('public', 'event_groups'), ('public', 'schedules'),
        ('public', 'registrations'), ('public', 'registration_items')
    ), column_rows as (
      select t.schema_name, t.table_name, c.oid is not null as table_exists,
        pg_get_userbyid(c.relowner) as owner,
        c.relrowsecurity as rls_enabled, c.relforcerowsecurity as force_rls,
        a.attnum as position, a.attname as column_name,
        format_type(a.atttypid, a.atttypmod) as column_type,
        a.attnotnull as not_null, a.attidentity as identity_kind,
        pg_get_expr(d.adbin, d.adrelid) as default_expression
      from targets t
      left join pg_namespace n on n.nspname = t.schema_name
      left join pg_class c on c.relnamespace = n.oid and c.relname = t.table_name
        and c.relkind in ('r', 'p')
      left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    ), constraint_rows as (
      select n.nspname as schema_name, c.relname as table_name,
        k.conname, k.contype, k.convalidated, k.condeferrable, k.condeferred,
        pg_get_constraintdef(k.oid, false) as definition
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join targets t on t.schema_name = n.nspname and t.table_name = c.relname
    ), index_rows as (
      select n.nspname as schema_name, c.relname as table_name,
        x.relname as index_name, i.indisprimary, i.indisunique, i.indisvalid, i.indisready,
        pg_get_indexdef(i.indexrelid) as definition
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_class x on x.oid = i.indexrelid
      join targets t on t.schema_name = n.nspname and t.table_name = c.relname
    ), trigger_rows as (
      select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid, false) as definition
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'schedules' and not t.tgisinternal
    )
    select json_build_object(
      'columns', (select coalesce(json_agg(r order by schema_name, table_name, position), '[]'::json) from column_rows r),
      'constraints', (select coalesce(json_agg(r order by schema_name, table_name, conname), '[]'::json) from constraint_rows r),
      'indexes', (select coalesce(json_agg(r order by schema_name, table_name, index_name), '[]'::json) from index_rows r),
      'triggers', (select coalesce(json_agg(r order by tgname), '[]'::json) from trigger_rows r)
    );
    rollback;
  `))
  for (const category of ['columns', 'constraints', 'indexes', 'triggers']) {
    assert.ok(Array.isArray(structureSummary[category]), `${category} must be an array`)
  }
  const expectedTables = new Set([
    'registration_private.fingerprint_secret', 'registration_private.registration_requests',
    'public.event_groups', 'public.schedules', 'public.registrations', 'public.registration_items',
  ])
  const actualTables = new Set()
  for (const row of structureSummary.columns) {
    assert.ok(row && typeof row.schema_name === 'string' && typeof row.table_name === 'string', 'column table identifiers are required')
    const table = `${row.schema_name}.${row.table_name}`
    assert.ok(expectedTables.has(table), 'unexpected table in column metadata')
    assert.equal(row.table_exists, true, 'target table must exist')
    assert.ok(typeof row.column_name === 'string' && row.column_name.length > 0 && Number.isInteger(row.position) && row.position > 0, 'column identifier and position are required')
    assert.ok(typeof row.owner === 'string' && row.owner.length > 0 && typeof row.rls_enabled === 'boolean' && typeof row.force_rls === 'boolean', 'table owner and RLS metadata are required')
    assert.ok(typeof row.column_type === 'string' && row.column_type.length > 0 && typeof row.not_null === 'boolean' && typeof row.identity_kind === 'string', 'column type and attributes are required')
    actualTables.add(table)
  }
  assert.deepEqual([...actualTables].sort(), [...expectedTables].sort(), 'all six target tables must be present')
  for (const [category, identifier] of [['constraints', 'conname'], ['indexes', 'index_name']]) {
    for (const row of structureSummary[category]) {
      assert.ok(row && typeof row.schema_name === 'string' && typeof row.table_name === 'string' && expectedTables.has(`${row.schema_name}.${row.table_name}`), 'object table identifiers are required')
      assert.ok(typeof row[identifier] === 'string' && row[identifier].length > 0 && typeof row.definition === 'string' && row.definition.length > 0, 'object identifier and definition are required')
      const flags = category === 'constraints' ? ['convalidated', 'condeferrable', 'condeferred'] : ['indisprimary', 'indisunique', 'indisvalid', 'indisready']
      for (const flag of flags) assert.equal(typeof row[flag], 'boolean', 'object state must be boolean')
      if (category === 'constraints') assert.ok(typeof row.contype === 'string' && row.contype.length > 0, 'constraint type is required')
    }
  }
  for (const row of structureSummary.triggers) {
    assert.ok(row && typeof row.tgname === 'string' && row.tgname.length > 0 && typeof row.tgenabled === 'string' && typeof row.definition === 'string' && row.definition.length > 0, 'trigger identifier and definition are required')
  }
  const capacityTrigger = structureSummary.triggers.find(row => row.tgname === 'schedules_enforce_capacity_before_change')
  assert.ok(capacityTrigger, 'schedule capacity trigger must exist')
  assert.ok(['O', 'A'].includes(capacityTrigger.tgenabled), 'schedule capacity trigger must fire for ordinary sessions')
  t.diagnostic(JSON.stringify({ event: 'ISOLATED_DB_STRUCTURE', ...structureSummary }))

  const internalFunctions = JSON.parse(await sql(`
    begin read only;
    set local search_path = pg_catalog;
    with targets(signature) as (
      values
        ('public.submit_registration(bigint,text,text,text,bigint[])'),
        ('public.create_registration(bigint,text,text,text,bigint[],boolean)'),
        ('public.add_registration_items(bigint,bigint,bigint[])')
    ), summaries as (
      select
        t.signature,
        p.oid is not null as function_exists,
        char_length(pg_get_functiondef(p.oid)) as definition_length,
        md5(pg_get_functiondef(p.oid)) as definition_md5
      from targets t
      left join pg_proc p on p.oid = to_regprocedure(t.signature)
    )
    select json_agg(r order by signature)
    from summaries r;
    rollback;
  `))
  assert.ok(Array.isArray(internalFunctions), 'function summaries must be an array')
  assert.equal(internalFunctions.length, 3, 'three function summaries are required')
  for (const row of internalFunctions) {
    assert.ok(typeof row.signature === 'string', 'function signature is required')
    assert.equal(typeof row.function_exists, 'boolean', 'existence must be boolean')
    if (row.function_exists) {
      assert.ok(
        Number.isInteger(row.definition_length) && row.definition_length > 0,
        'definition length must be a positive integer'
      )
      assert.ok(
        typeof row.definition_md5 === 'string' &&
        /^[0-9a-fA-F]{32}$/.test(row.definition_md5),
        'definition MD5 must be 32 hexadecimal characters'
      )
    } else {
      assert.equal(row.definition_length, null)
      assert.equal(row.definition_md5, null)
    }
  }
  t.diagnostic(JSON.stringify({
    event: 'ISOLATED_DB_INTERNAL_FUNCTIONS',
    functions: internalFunctions,
  }))
  assert.ok(
    internalFunctions.every(row => row.function_exists),
    'all three internal functions must exist'
  )

  let nextId = 100
  async function fixture({ open = true, capacity = 20 } = {}) {
    const id = nextId++
    const classes = [id * 10, id * 10 + 1]
    await sql(`insert into public.event_groups(id,title,registration_open) values (${id},'Test group',${open});
      insert into public.schedules(id,title,date,location,type,event_group_id,capacity,registration_enabled)
      values (${classes[0]},'Test class A','2030-01-01','Test','一般参加',${id},${capacity},true),
             (${classes[1]},'Test class B','2030-01-01','Test','一般参加',${id},${capacity},true);`)
    return { id, classes }
  }
  function call(key, group, { name = 'Synthetic attendee', contact = 'test.invalid', notes = 'memo', classes = group.classes } = {}) {
    const quote = text => text === null ? 'null' : `'${text.replaceAll("'", "''")}'`
    return `select public.submit_registration_idempotent('${key}',${group.id},${quote(name)},${quote(contact)},${quote(notes)},array[${classes.join(',')}]::bigint[])`
  }
  const execute = async (key, group, options) => JSON.parse(await sql(`set role service_role; ${call(key, group, options)};`))
  const stats = async group => JSON.parse(await sql(`select json_build_object('registrations',(select count(*) from public.registrations where event_group_id=${group.id}), 'items',(select count(*) from public.registration_items where event_group_id=${group.id}));`))
  const requestCount = key => sql(`select count(*) from registration_private.registration_requests where idempotency_key='${key}';`)
  async function expectState(statement, state, role = 'service_role') {
    await sql(`set role ${role}; do $test$ begin
      begin ${statement.replace(/^select /, 'perform ')}; raise exception 'expected SQLSTATE ${state}';
      exception when sqlstate '${state}' then null; end;
    end $test$;`)
  }

  await t.test('existing RPC SQLSTATE/message contracts match all six wrapper business results', async t => {
    const contracts = [
      { code: 'GROUP_NOT_FOUND', state: '22023', message: 'event group does not exist', status: 404 },
      { code: 'REGISTRATION_CLOSED', state: '22023', message: 'registration is closed', status: 409 },
      { code: 'CLASS_NOT_FOUND', state: '22023', message: 'one or more selected classes do not exist', status: 400 },
      { code: 'CLASS_GROUP_MISMATCH', state: '22023', message: 'classes must belong to the same event group', status: 400 },
      { code: 'CLASS_CLOSED', state: '22023', message: 'class is not accepting registrations', status: 409 },
      { code: 'CAPACITY_EXCEEDED', state: 'P0001', message: 'one or more selected classes are full', status: 409 },
    ]
    for (const contract of contracts) {
      await t.test(contract.code, async () => {
        const group = await fixture({ open: contract.code !== 'REGISTRATION_CLOSED', capacity: 1 })
        let target = group, classes = group.classes
        if (contract.code === 'GROUP_NOT_FOUND') target = { ...group, id: 9999999 }
        if (contract.code === 'CLASS_NOT_FOUND') classes = [9999999]
        if (contract.code === 'CLASS_GROUP_MISMATCH') classes = (await fixture()).classes
        if (contract.code === 'CLASS_CLOSED') {
          await sql(`update public.schedules set registration_enabled=false where id=${classes[0]};`)
        }
        if (contract.code === 'CAPACITY_EXCEEDED') {
          await sql(`set role service_role; select public.submit_registration(${group.id},'Synthetic attendee','test.invalid',null,array[${classes[1]}]::bigint[]);`)
        }
        const before = await stats(group)
        // Invoke the unmodified RPC, not a source-text regex or a mocked error.
        // Catch inside a subtransaction so any parent/item inserts are rolled back.
        await sql(`set role service_role; do $contract$
          declare actual_state text; actual_message text;
          begin
            begin
              perform public.submit_registration(${target.id},'Synthetic attendee','test.invalid',null,array[${classes.join(',')}]::bigint[]);
            exception when others then
              get stacked diagnostics actual_state = returned_sqlstate, actual_message = message_text;
            end;
            if actual_state is distinct from '${contract.state}' or actual_message is distinct from '${contract.message}' then
              raise exception 'RPC error contract changed: expected % / %, got % / %',
                '${contract.state}', '${contract.message}', actual_state, actual_message;
            end if;
          end $contract$;`)
        const key = randomUUID()
        const expected = { success: false, code: contract.code, http_status: contract.status }
        assert.deepEqual(await execute(key, target, { classes }), expected)
        assert.deepEqual(await execute(key, target, { classes }), expected)
        assert.equal(await requestCount(key), '1')
        assert.deepEqual(await stats(group), before)
      })
    }
  })

  await t.test('success, semantic replay and a fresh key create the correct number of records', async () => {
    const group = await fixture(), key = randomUUID()
    const first = await execute(key, group)
    assert.deepEqual(first, { success: true, code: 'REGISTERED', http_status: 201 })
    assert.deepEqual(await execute(key, group, { name: ' Synthetic attendee ', contact: ' test.invalid ', classes: [...group.classes].reverse() }), first)
    assert.deepEqual(await stats(group), { registrations: 1, items: 2 })
    await execute(randomUUID(), group)
    assert.deepEqual(await stats(group), { registrations: 2, items: 4 })
    const ledger = await sql(`select row_to_json(r)::text from registration_private.registration_requests r where idempotency_key='${key}';`)
    assert.doesNotMatch(ledger, /Synthetic attendee|test\.invalid|memo/)
    assert.equal(await requestCount(key), '1')
  })

  await t.test('same key with changed name, contact, notes, classes or group returns conflict', async () => {
    const group = await fixture(), other = await fixture(), key = randomUUID()
    await execute(key, group)
    for (const options of [{ name: 'Changed' }, { contact: 'Changed' }, { notes: 'Changed' }, { classes: [group.classes[0]] }]) {
      await expectState(call(key, group, options), 'PT409')
    }
    await expectState(call(key, other), 'PT409')
    assert.deepEqual(await stats(group), { registrations: 1, items: 2 })
    assert.deepEqual(await stats(other), { registrations: 0, items: 0 })
  })

  await t.test('UTF-8 character limits and null/blank notes use consistent normalization', async () => {
    const group = await fixture(), key = randomUUID()
    const options = { name: '😀'.repeat(100), contact: 'あ'.repeat(254), notes: null }
    const first = await execute(key, group, options)
    assert.equal(first.success, true)
    assert.deepEqual(await execute(key, group, { ...options, notes: ' ' }), first)
    assert.deepEqual(await stats(group), { registrations: 1, items: 2 })
    const tooLongKey = randomUUID()
    await expectState(call(tooLongKey, group, { name: '😀'.repeat(101) }), '22023')
    assert.equal(await requestCount(tooLongKey), '0')
  })

  await t.test('same-key concurrent submissions wait on the unique key and register once', async () => {
    const group = await fixture(), key = randomUUID()
    let signal
    const locked = new Promise(resolve => { signal = resolve })
    const first = sql(`begin; set local role service_role; ${call(key, group)}; select 'KEY_LOCKED';
      select pg_sleep(1); commit;`, stdout => { if (stdout.includes('KEY_LOCKED')) signal() })
    // A startup failure must not leave the readiness promise waiting forever.
    await Promise.race([locked, first.then(() => { throw new Error('missing lock marker') })])
    const started = Date.now()
    const second = execute(key, group).then(result => {
      assert.ok(Date.now() - started >= 250, 'second connection must wait for the uncommitted key')
      return result
    })
    await first
    assert.equal((await second).success, true)
    assert.deepEqual(await stats(group), { registrations: 1, items: 2 })
    assert.equal(await requestCount(key), '1')
  })

  await t.test('concurrent same-key different inputs conflict after the winner commits', async () => {
    const group = await fixture(), key = randomUUID()
    let signal
    const locked = new Promise(resolve => { signal = resolve })
    const first = sql(`begin; set local role service_role; ${call(key, group)}; select 'KEY_LOCKED';
      select pg_sleep(0.5); commit;`, stdout => { if (stdout.includes('KEY_LOCKED')) signal() })
    await Promise.race([locked, first.then(() => { throw new Error('missing lock marker') })])
    const conflict = expectState(call(key, group, { name: 'Different' }), 'PT409')
    await Promise.all([first, conflict])
    assert.deepEqual(await stats(group), { registrations: 1, items: 2 })
  })

  await t.test('closed-group error is cached; changing the group later does not retry it', async () => {
    const group = await fixture({ open: false }), key = randomUUID()
    const result = await execute(key, group)
    assert.deepEqual(result, { success: false, code: 'REGISTRATION_CLOSED', http_status: 409 })
    await sql(`update public.event_groups set registration_open=true where id=${group.id};`)
    assert.deepEqual(await execute(key, group), result)
    await expectState(call(key, group, { name: 'Changed' }), 'PT409')
    assert.deepEqual(await stats(group), { registrations: 0, items: 0 })
    assert.equal((await execute(randomUUID(), group)).success, true)
  })

  await t.test('full second class rolls back the entire registration and caches failure', async () => {
    const group = await fixture({ capacity: 1 })
    await execute(randomUUID(), group, { classes: [group.classes[1]] })
    const key = randomUUID()
    const result = await execute(key, group)
    assert.equal(result.code, 'CAPACITY_EXCEEDED')
    assert.deepEqual(await stats(group), { registrations: 1, items: 1 })
    await sql(`update public.schedules set capacity=2 where event_group_id=${group.id};`)
    assert.deepEqual(await execute(key, group), result)
    assert.deepEqual(await stats(group), { registrations: 1, items: 1 })
  })

  await t.test('missing classes, foreign-group classes and disabled classes are cached business errors', async () => {
    const group = await fixture(), other = await fixture()
    assert.equal((await execute(randomUUID(), group, { classes: [9999999] })).code, 'CLASS_NOT_FOUND')
    assert.equal((await execute(randomUUID(), group, { classes: other.classes })).code, 'CLASS_GROUP_MISMATCH')
    await sql(`update public.schedules set registration_enabled=false where id=${group.classes[0]};`)
    assert.equal((await execute(randomUUID(), group)).code, 'CLASS_CLOSED')
    assert.deepEqual(await stats(group), { registrations: 0, items: 0 })
  })

  await t.test('unexpected DB errors roll back the key, parent and all previously inserted items', async () => {
    const group = await fixture(), key = randomUUID()
    await sql(`create function public.test_unexpected_item_failure() returns trigger language plpgsql as $$begin
      if new.schedule_id=${group.classes[1]} then raise exception using errcode='P0001', message='unexpected synthetic failure'; end if;
      return new; end$$;
      create trigger test_unexpected_item_failure before insert on public.registration_items for each row execute function public.test_unexpected_item_failure();`)
    await expectState(call(key, group), 'P0001')
    assert.equal(await requestCount(key), '0')
    assert.deepEqual(await stats(group), { registrations: 0, items: 0 })
    await sql('drop trigger test_unexpected_item_failure on public.registration_items; drop function public.test_unexpected_item_failure();')
    assert.equal((await execute(key, group)).success, true)
  })

  await t.test('successful replay after closure and cancellation does not re-register or restore items', async () => {
    const group = await fixture(), key = randomUUID()
    const result = await execute(key, group)
    await sql(`update public.event_groups set registration_open=false where id=${group.id};
      update public.registration_items set status='cancelled',cancelled_at=now() where event_group_id=${group.id};`)
    assert.deepEqual(await execute(key, group), result)
    assert.equal(await sql(`select count(*) from public.registration_items where event_group_id=${group.id} and status='active';`), '0')
    assert.deepEqual(await stats(group), { registrations: 1, items: 2 })
  })

  await t.test('30-day expiration refuses success and rejected keys without returning results or deleting tombstones', async () => {
    for (const open of [true, false]) {
      const group = await fixture({ open }), key = randomUUID()
      await execute(key, group)
      assert.equal(await sql(`select expires_at-completed_at=interval '720 hours' from registration_private.registration_requests where idempotency_key='${key}';`), 't')
      await sql(`update registration_private.registration_requests set completed_at=completed_at-interval '29 days',expires_at=expires_at-interval '29 days' where idempotency_key='${key}';`)
      assert.equal((await execute(key, group)).success, open)
      await sql(`update registration_private.registration_requests set completed_at=completed_at-interval '2 days',expires_at=expires_at-interval '2 days' where idempotency_key='${key}';`)
      await expectState(call(key, group), 'PT410')
      await expectState(call(key, group, { name: 'Different' }), 'PT410')
      assert.equal(await requestCount(key), '1')
      assert.deepEqual(await stats(group), { registrations: open ? 1 : 0, items: open ? 2 : 0 })
    }
  })

  await t.test('invalid inputs never reserve keys and ordinary roles cannot execute or read secrets/ledger', async () => {
    const group = await fixture(), key = randomUUID()
    await expectState(call(key, group, { classes: [group.classes[0], group.classes[0]] }), '22023')
    await expectState(call(key, group, { name: '' }), '22023')
    assert.equal(await requestCount(key), '0')
    for (const role of ['anon', 'authenticated']) await expectState(call(key, group), '42501', role)
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await expectState('perform 1 from registration_private.registration_requests', '42501', role)
      await expectState('perform 1 from registration_private.fingerprint_secret', '42501', role)
    }
    assert.equal((await execute(key, group)).success, true)
  })

  await t.test('existing administrator proxy registration remains usable while public group is closed', async () => {
    const group = await fixture({ open: false })
    const admin = randomUUID()
    await sql(`insert into auth.users(id) values ('${admin}'); insert into public.profiles(id,role) values ('${admin}','admin');
      set role authenticated; set request.jwt.claim.sub='${admin}';
      select public.admin_create_registration(${group.id},'Synthetic admin proxy','test.invalid',null,array[${group.classes.join(',')}]::bigint[]);`)
    assert.deepEqual(await stats(group), { registrations: 1, items: 2 })
  })
})
