import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CATEGORY_SPECS, CATEGORIES, canonical, compareSnapshots, createReporter, emptySnapshot } from '../scripts/db-verification/compare.mjs'
import { collectMetadata, METADATA_QUERIES, READ_CONTEXT, sequenceStateQuery } from '../scripts/db-verification/queries.mjs'
import { nextCandidate, parseArchiveSequenceStates, verifySequenceCandidates, selectSequenceTocEntries, readArchiveSequenceBaseline, SEQUENCE_EXTRACT_COMMAND } from '../scripts/db-verification/sequences.mjs'

const reporter = createReporter(Buffer.alloc(32, 7))
const copy = value => structuredClone(value)
const grant = (overrides = {}) => ({ grantee: 'anon', grantor: 'postgres', privilege: 'SELECT', grantable: false, ...overrides })
const defaultAcl = privileges => privileges.map(privilege => grant({ grantee: 'postgres', privilege }))
const tableDefaults = () => defaultAcl(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'])
const schemaDefaults = () => defaultAcl(['CREATE', 'USAGE'])
const table = (overrides = {}) => ({ id: ['public', 'schedules'], kind: 'r', owner: 'postgres', rls: true, force_rls: false, acl_is_null: false, acl: [grant()], acl_default: tableDefaults(), ...overrides })
const rpc = (overrides = {}) => ({ id: ['public', 'example', 'bigint'], owner: 'postgres', language: 'plpgsql', definition: 'CREATE FUNCTION example() RETURNS void AS $$ BEGIN NULL; END $$ LANGUAGE plpgsql', security_definer: true, config: ['search_path=public,extensions', 'statement_timeout=5s'], acl_is_null: false, acl: [grant({ privilege: 'EXECUTE' })], execute: [['anon', false], ['authenticated', false], ['service_role', true]], ...overrides })
const state = (overrides = {}) => ({ id: ['public', 'schedules_id_seq'], last_value: '5', is_called: true, ...overrides })
const sequence = (overrides = {}) => ({ id: ['public', 'schedules_id_seq'], owner: 'postgres', type: 'bigint', start: '1', increment: '1', min: '1', max: '9223372036854775807', cycle: false, cache: '1', ...overrides })
const put = (snapshot, category, rows) => { snapshot[category] = { status: 'ok', rows }; return snapshot }
function pair(category, a, b = copy(a)) {
  return [put(emptySnapshot(), category, a), put(emptySnapshot(), category, b)]
}
const compare = (a, b, options = {}) => compareSnapshots(a, b, { sequenceBaseline: { status: 'ok', rows: [] }, reporter, ...options })
const category = (report, name) => report.categories.find(c => c.category === name)

test('ACL internal ordering is ignored in tables, schemas, RPCs and default ACL', () => {
  const a = grant(), b = grant({ grantee: 'authenticated', privilege: 'INSERT' })
  for (const [name, row] of [
    ['tables', table({ acl: [a, b] })],
    ['schemas', { id: ['registration_private'], owner: 'postgres', acl_is_null: false, acl: [a, b], acl_default: schemaDefaults() }],
    ['rpc', rpc({ acl: [a, b] })],
    ['default_acl', { id: ['postgres', 'public', 'r'], acl: [a, b] }],
  ]) {
    const [left, right] = pair(name, [row], [{ ...row, acl: [b, a] }])
    assert.equal(compare(left, right).matched, true, name)
  }
})

for (const [field, value] of [['grantee', 'authenticated'], ['grantor', 'supabase_admin'], ['grantable', true], ['privilege', 'UPDATE']]) {
  test(`ACL ${field} changes are reported without exposing values`, () => {
    const [left, right] = pair('tables', [table()], [table({ acl: [grant({ [field]: value })] })])
    const report = compare(left, right), result = category(report, 'tables')
    assert.equal(report.can_run_rpc_tests, false)
    assert.equal(result.changed_count, 1)
    const difference = result.differences[0].fields[0]
    assert.equal(difference.kind, 'acl_changed')
    assert.deepEqual(difference.dimensions, [field])
    assert.equal(difference.missing_count, 1)
    assert.equal(difference.added_count, 1)
  })
}

test('grant associations change even when individual dimension multisets match', () => {
  const [left, right] = pair('tables', [table({ acl: [grant(), grant({ grantee: 'authenticated', privilege: 'UPDATE' })] })], [table({ acl: [grant({ privilege: 'UPDATE' }), grant({ grantee: 'authenticated' })] })])
  assert.deepEqual(category(compare(left, right), 'tables').differences[0].fields[0].dimensions, ['grant_relationship'])
})

test('object, role-array, tag, config-key and membership ordering do not affect comparison', () => {
  const left = emptySnapshot()
  put(left, 'rpc', [rpc()])
  put(left, 'policies', [{ id: ['public', 'schedules', 'read'], permissive: 'PERMISSIVE', roles: ['anon', 'authenticated'], command: 'SELECT', using_expression: 'true', check_expression: null }])
  put(left, 'event_triggers', [{ id: ['watch'], event: 'ddl_command_end', owner: 'postgres', function: 'public.watch()', enabled: 'O', tags: ['CREATE TABLE', 'ALTER TABLE'] }])
  put(left, 'memberships', [{ id: ['anon', 'authenticator', 'supabase_admin'], admin: false, inherit: false, set: true }, { id: ['anon', 'authenticator', 'postgres'], admin: false, inherit: true, set: true }])
  put(left, 'tables', [table(), table({ id: ['registration_private', 'fingerprint_secret'] })])
  const right = copy(left)
  right.rpc.rows[0].config.reverse()
  right.rpc.rows[0].execute.reverse()
  right.policies.rows[0].roles.reverse()
  right.event_triggers.rows[0].tags.reverse()
  right.memberships.rows.reverse()
  right.tables.rows.reverse()
  assert.equal(compare(left, right).matched, true)
})

test('search_path ordering remains significant, including quoted values', () => {
  const [left, right] = pair('rpc', [rpc()], [rpc({ config: ['statement_timeout=5s', 'search_path=extensions,public'] })])
  assert.equal(compare(left, right).matched, false)
  assert.equal(category(compare(left, right), 'rpc').differences[0].fields[0].kind, 'settings_changed')
})

test('added and missing objects are identified by stable per-run opaque IDs', () => {
  const original = table(), added = table({ id: ['public', 'new_table'] })
  const [left, right] = pair('tables', [original], [added])
  const result = category(compare(left, right), 'tables')
  assert.equal(result.source_count, 1)
  assert.equal(result.restored_count, 1)
  assert.equal(result.added_count, 1)
  assert.equal(result.missing_count, 1)
  assert.equal(result.differences.find(d => d.change === 'missing').object_id, reporter.objectId('tables', original.id))
  assert.equal(result.differences.find(d => d.change === 'added').object_id, reporter.objectId('tables', added.id))
})

test('NULL and empty arrays are distinct; explicit/default ACL representation is recorded', () => {
  const [left, right] = pair('rpc', [rpc({ config: null })], [rpc({ config: [] })])
  assert.equal(compare(left, right).matched, false)
  const [a, b] = pair('tables', [table({ acl_is_null: true })], [table({ acl_is_null: false })])
  const result = category(compare(a, b), 'tables')
  assert.equal(result.matched, false)
  assert.equal(result.differences[0].fields[0].kind, 'acl_representation_changed')
  b.tables.rows[0].acl = []
  assert.ok(category(compare(a, b), 'tables').differences[0].fields.some(f => f.kind === 'acl_changed'))
})

test('NULL and empty event tags are not conflated', () => {
  const row = { id: ['watch'], event: 'ddl_command_end', owner: 'postgres', function: 'public.watch()', enabled: 'O', tags: null }
  const [a, b] = pair('event_triggers', [row], [{ ...row, tags: [] }])
  assert.equal(compare(a, b).matched, false)
})

test('collection and normalization errors are not successful empty results; other categories continue', () => {
  const a = emptySnapshot(), b = emptySnapshot()
  a.rpc = { status: 'error', code: 'SECRET ERROR AND SQL' }
  put(a, 'tables', [table()])
  put(b, 'tables', [table({ owner: 'other' })])
  put(a, 'policies', [{ invalid: 'SECRET' }])
  const report = compare(a, b)
  assert.equal(report.matched, false)
  assert.equal(report.categories.length, CATEGORIES.length)
  assert.deepEqual(category(report, 'rpc').errors, [{ side: 'source', code: 'COLLECTION_FAILED' }])
  assert.equal(category(report, 'tables').changed_count, 1)
  assert.equal(category(report, 'policies').errors[0].code, 'NORMALIZATION_FAILED')
  assert.equal(category(report, 'extensions').matched, true)
  assert.doesNotMatch(JSON.stringify(report), /SECRET/)
})

test('duplicate objects, duplicate config keys and malformed ACLs are errors', () => {
  for (const [name, rows] of [
    ['tables', [table(), table()]],
    ['tables', [table({ acl: [grant(), grant()] })]],
    ['tables', [table({ acl: [grant({ grantable: 'false' })] })]],
    ['rpc', [rpc({ config: ['search_path=public', 'search_path=auth'] })]],
  ]) {
    const [a, b] = pair(name, rows)
    assert.equal(category(compare(a, b), name).errors[0].code, 'NORMALIZATION_FAILED')
  }
})

test('logs never contain identifiers, SQL, settings, PII, key values or exception messages', () => {
  const secret = "SECRET_TOKEN person's name email@example.invalid key=abcdef"
  const row = rpc({ id: [secret], definition: `SELECT '${secret}'`, config: [`custom.setting=${secret}`] })
  const [a, b] = pair('rpc', [row], [{ ...row, definition: 'SELECT 2', config: ['custom.setting=changed'] }])
  put(a, 'tables', [table({ id: [secret] })])
  const report = compare(a, b)
  const output = JSON.stringify(report)
  for (const fragment of [secret, 'SECRET_TOKEN', 'email@example.invalid', 'SELECT 2', 'custom.setting', 'abcdef']) assert.equal(output.includes(fragment), false)
  const detail = category(report, 'rpc').differences[0].fields.find(f => f.field === 'definition')
  assert.equal(detail.kind, 'definition_changed_unresolved')
  assert.match(detail.source_hash, /^[a-f0-9]{64}$/)
  assert.notEqual(detail.source_hash, detail.restored_hash)
})

test('definition whitespace changes are not automatically declared equivalent', () => {
  const [a, b] = pair('rpc', [rpc()], [rpc({ definition: rpc().definition.replace('NULL;', 'NULL; ') })])
  assert.equal(compare(a, b).can_run_rpc_tests, false)
})

test('all 12 original categories and private schema/column coverage are present', () => {
  for (const name of ['rpc', 'tables', 'policies', 'constraints', 'triggers', 'event_triggers', 'indexes', 'extensions', 'roles', 'memberships', 'default_acl', 'sequence_associations', 'columns', 'schemas', 'sequences', 'sequence_states']) assert.ok(CATEGORY_SPECS[name])
  for (const name of ['tables', 'columns', 'constraints', 'indexes', 'policies', 'schemas', 'rpc']) assert.match(METADATA_QUERIES[name], /registration_private/)
  for (const name of ['rpc', 'tables', 'schemas']) {
    assert.match(METADATA_QUERIES[name], /aclexplode\(coalesce/)
    assert.match(METADATA_QUERIES[name], /acl_is_null/)
  }
  assert.match(METADATA_QUERIES.default_acl, /aclexplode\(d\.defaclacl\)/)
})

test('private column type, nullability, default, identity and generated differences are all detected', () => {
  const row = { id: ['registration_private', 'registration_requests', 'idempotency_key'], position: 1, type: 'uuid', not_null: true, default_expression: null, identity: '', generated: '', collation: null }
  for (const [field, value] of [['type', 'text'], ['not_null', false], ['default_expression', 'gen_random_uuid()'], ['identity', 'd'], ['generated', 's']]) {
    const [a, b] = pair('columns', [row], [{ ...row, [field]: value }])
    assert.deepEqual(category(compare(a, b), 'columns').differences[0].fields.map(f => f.field), [field])
  }
})

test('global and per-schema default ACL entries, empty entries and grantors remain distinct', () => {
  const row = { id: ['postgres', null, 'f'], acl: [] }
  const [a, b] = pair('default_acl', [row], [{ ...row, id: ['postgres', 'public', 'f'] }])
  const result = category(compare(a, b), 'default_acl')
  assert.equal(result.added_count, 1)
  assert.equal(result.missing_count, 1)
})

test('collector failures do not echo errors or suppress remaining categories', async () => {
  const calls = []
  const snapshot = await collectMetadata(async query => {
    calls.push(query)
    if (query === METADATA_QUERIES.rpc) throw new Error('SECRET SQL token')
    return []
  })
  assert.equal(snapshot.rpc.status, 'error')
  assert.equal(snapshot.schemas.status, 'ok')
  assert.equal(calls.length, Object.keys(METADATA_QUERIES).length)
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/)
})

test('collector rejects null/malformed results instead of treating them as empty', async () => {
  const snapshot = await collectMetadata(async () => null)
  assert.ok(Object.values(snapshot).every(value => value.status === 'error'))
  assert.equal(compare(snapshot, emptySnapshot()).can_run_rpc_tests, false)
})

test('definition reads have a fixed read-only context; no key/user-data query is present', () => {
  assert.match(READ_CONTEXT, /REPEATABLE READ READ ONLY/)
  assert.match(READ_CONTEXT, /search_path=pg_catalog/)
  assert.match(READ_CONTEXT, /timezone='UTC'/)
  const all = Object.values(METADATA_QUERIES).join('\n')
  assert.doesNotMatch(all, /FROM\s+(?:public\.registrations|auth\.users|registration_private\.fingerprint_secret)/i)
  assert.doesNotMatch(all, /rolpassword|nextval\(|setval\(/i)
  assert.match(all, /seqmax::text/)
  assert.match(all, /pg_get_constraintdef\(k\.oid,false\)/)
})

test('sequence identifiers are quoted and null collection values fail closed', async () => {
  assert.equal(sequenceStateQuery(['strange"schema', 'seq.name']), 'SELECT last_value::text last_value,is_called FROM "strange""schema"."seq.name"')
  const snapshot = await collectMetadata(async query => query === METADATA_QUERIES.sequences ? [sequence()] : query.includes('last_value::text') ? [] : [])
  assert.equal(snapshot.sequence_states.status, 'error')
})

test('backup is the sequence-state reference; live counter advancement is informational', () => {
  const [a, b] = pair('sequence_states', [state({ last_value: '19' })], [state({ last_value: '18' })])
  const baseline = { status: 'ok', rows: [state({ last_value: '18' })] }
  const report = compare(a, b, { sequenceBaseline: baseline })
  assert.equal(report.matched, true)
  assert.equal(category(report, 'sequence_states').reference, 'backup')
  assert.equal(report.current_sequence_changes_since_backup.changed_count, 1)
  b.sequence_states.rows[0].last_value = '17'
  assert.equal(compare(a, b, { sequenceBaseline: baseline }).can_run_rpc_tests, false)
})

test('missing backup or failed current-state collection cannot pass the gate', () => {
  const a = emptySnapshot(), b = emptySnapshot()
  assert.equal(compareSnapshots(a, b).can_run_rpc_tests, false)
  a.sequence_states = { status: 'error' }
  assert.equal(compare(a, b).can_run_rpc_tests, false)
})

test('archive sequence parser handles quoting, large bigint values and rejects missing/duplicate/unexpected data', () => {
  const id = ['public', "odd.name'seq"]
  const sql = `SELECT pg_catalog.setval('public."odd.name''seq"', 9223372036854775806, true);\n`
  assert.deepEqual(parseArchiveSequenceStates(sql, [id]), { status: 'ok', rows: [{ id, last_value: '9223372036854775806', is_called: true }] })
  for (const invalid of ['', sql + sql, sql + 'COPY public.registrations FROM stdin;\n', sql.replace('public.', 'other.')]) assert.throws(() => parseArchiveSequenceStates(invalid, [id]))
})

test('next candidate is exact above Number.MAX_SAFE_INTEGER and handles is_called/descending/cycle/exhaustion', () => {
  assert.equal(nextCandidate(sequence(), state({ last_value: '9007199254740993' })), '9007199254740994')
  assert.equal(nextCandidate(sequence(), state({ last_value: '1', is_called: false })), '1')
  assert.equal(nextCandidate(sequence({ min: '-100', max: '-1', increment: '-1' }), state({ last_value: '-5' })), '-6')
  assert.equal(nextCandidate(sequence({ max: '5', cycle: true }), state()), '1')
  assert.throws(() => nextCandidate(sequence({ max: '5' }), state()), /EXHAUSTED/)
})

test('sequence candidate checks are read-only, report collisions and continue other sequences', async () => {
  const snapshot = emptySnapshot()
  put(snapshot, 'sequences', [sequence(), sequence({ id: ['public', 'other_seq'] })])
  put(snapshot, 'sequence_states', [state(), state({ id: ['public', 'other_seq'] })])
  put(snapshot, 'sequence_associations', [{ id: ['public', 'schedules', 'id'], sequence: sequence().id }, { id: ['public', 'other_table', 'id'], sequence: ['public', 'other_seq'] }])
  const calls = []
  const result = await verifySequenceCandidates(snapshot, async query => {
    calls.push(query)
    return [{ min_id: '1', max_id: '5', collision: query.includes('"schedules"') }]
  }, reporter)
  assert.equal(result.matched, false)
  assert.equal(result.checks.length, 2)
  assert.ok(result.checks.some(c => c.code === 'CANDIDATE_COLLISION'))
  assert.ok(result.checks.some(c => c.matched))
  assert.ok(calls.every(q => q.startsWith('SELECT ') && !/nextval|setval/i.test(q)))
})

test('unowned sequences, missing bounds and unexpected read errors never pass', async () => {
  const snapshot = emptySnapshot()
  put(snapshot, 'sequences', [sequence()]); put(snapshot, 'sequence_states', [state()])
  assert.equal((await verifySequenceCandidates(snapshot, async () => [], reporter)).matched, false)
  put(snapshot, 'sequence_associations', [{ id: ['public', 'schedules', 'id'], sequence: sequence().id }])
  const result = await verifySequenceCandidates(snapshot, async () => { throw new Error('SECRET query and applicant') }, reporter)
  assert.equal(result.matched, false)
  assert.doesNotMatch(JSON.stringify(result), /SECRET|applicant/)
})

test('runner cannot create, restore, remove containers, apply migrations or execute registration RPCs', async () => {
  const code = await readFile('scripts/db-verification/verify-restored-db.mjs', 'utf8')
  assert.doesNotMatch(code, /'run'|'stop'|'rm'|'createdb'|\.rpc\(|submit_registration\(/)
  assert.match(code, /flag: 'wx'/)
  assert.match(code, /mode: 0o600/)
  assert.match(code, /SOURCE = 'supabase_db_shinseikai-hub'/)
})

test('canonical preserves SQL strings and rejects unsafe numeric coercion', () => {
  assert.notEqual(canonical(null), canonical([]))
  assert.notEqual(canonical('a b'), canonical('ab'))
  assert.throws(() => canonical(Number.MAX_SAFE_INTEGER + 1))
})

test('NULL versus explicit built-in ACL is audited separately only with matching effective ACL and owner', () => {
  for (const [name, row] of [
    ['tables', table({ id: ['registration_private', 'fingerprint_secret'], acl: tableDefaults() })],
    ['schemas', { id: ['registration_private'], owner: 'postgres', acl_is_null: false, acl: schemaDefaults(), acl_default: schemaDefaults() }],
  ]) {
    const [a, b] = pair(name, [row], [{ ...row, acl_is_null: true, acl: [...row.acl].reverse() }])
    const result = category(compare(a, b), name)
    assert.equal(result.matched, true)
    assert.equal(result.changed_count, 0)
    assert.equal(result.representation_count, 1)
    assert.equal(result.representation_differences[0].kind, 'explicit_builtin_default_vs_null')
    assert.equal(result.representation_differences[0].effective_acl_matches, true)
    assert.equal(result.representation_differences[0].source_is_null, false)
    assert.equal(result.representation_differences[0].restored_is_null, true)
    assert.equal(compare(b, a).matched, true)
  }
})

test('ACL representation handling cannot conceal PUBLIC, grantor, grantability or owner changes', () => {
  const original = table({ acl_is_null: true, acl: tableDefaults() })
  for (const replacement of [
    { ...original, acl_is_null: false, acl: [...tableDefaults(), grant({ grantee: 'PUBLIC' })] },
    { ...original, acl_is_null: false, acl: tableDefaults().map(g => ({ ...g, grantor: 'supabase_admin' })) },
    { ...original, acl_is_null: false, acl: tableDefaults().map(g => ({ ...g, grantable: true })) },
    { ...original, acl_is_null: false, owner: 'other' },
  ]) {
    const [a, b] = pair('tables', [original], [replacement])
    const result = category(compare(a, b), 'tables')
    assert.equal(result.matched, false)
    assert.equal(result.representation_count, 0)
    assert.equal(result.changed_count, 1)
  }
})

test('nondefault ACLs and empty explicit ACLs are never accepted as explained NULL representation', () => {
  for (const acl of [[grant()], []]) {
    const [a, b] = pair('tables', [table({ acl })], [table({ acl, acl_is_null: true })])
    assert.equal(compare(a, b).matched, false)
    assert.equal(category(compare(a, b), 'tables').representation_count, 0)
  }
})

const sequenceIds = [
  ['auth', 'refresh_tokens_id_seq'], ['public', 'event_groups_id_seq'],
  ['public', 'registration_items_id_seq'], ['public', 'registrations_id_seq'],
  ['public', 'schedules_id_seq'], ['public', 'videos_id_seq'],
  ['realtime', 'subscription_id_seq'], ['supabase_functions', 'hooks_id_seq'],
]
const sequenceToc = sequenceIds.map(([schema, name], i) => `${4830 + i}; 0 0 SEQUENCE SET ${schema} ${name} postgres`).join('\n')
const sequenceSql = sequenceIds.map(([schema, name], i) => `SELECT pg_catalog.setval('${schema}.${name}', ${i + 1}, ${i < 5 ? 'true' : 'false'});`).join('\n')

test('TOC selection retains exactly eight SEQUENCE SET entries and excludes table/key data', () => {
  const toc = '; Archive metadata\n4000; 0 1 TABLE DATA public registrations postgres\n' + sequenceToc + '\n4001; 0 2 TABLE DATA registration_private fingerprint_secret postgres\n'
  const result = selectSequenceTocEntries(toc, sequenceIds)
  assert.equal(result.entry_count, 8)
  assert.equal(result.list, sequenceToc + '\n')
  assert.doesNotMatch(result.list, /TABLE DATA|fingerprint_secret/)
})

test('missing, duplicate, unexpected and ambiguous TOC entries fail closed', () => {
  for (const toc of [sequenceToc.split('\n').slice(1).join('\n'), sequenceToc + '\n' + sequenceToc.split('\n')[0], sequenceToc.replace('auth refresh_tokens_id_seq', 'other unknown_seq')]) {
    assert.throws(() => selectSequenceTocEntries(toc, sequenceIds))
  }
  assert.throws(() => selectSequenceTocEntries(sequenceToc, [...sequenceIds, sequenceIds[0]]))
  assert.throws(() => selectSequenceTocEntries('1; 0 0 SEQUENCE SET public a b owner', [['public', 'a'], ['public', 'a b']]))
})

test('baseline reader extracts all eight states through TOC IDs without executing SQL', async () => {
  let selection
  const result = await readArchiveSequenceBaseline({
    list: async () => sequenceToc,
    extract: async value => { selection = value; return sequenceSql },
  }, sequenceIds)
  assert.equal(result.status, 'ok')
  assert.equal(result.rows.length, 8)
  assert.equal(result.evidence.toc_entries, 8)
  assert.equal(result.evidence.parsed_states, 8)
  assert.equal(selection, sequenceToc + '\n')
  assert.equal(result.rows[0].is_called, true)
  assert.equal(result.rows[7].is_called, false)
})

test('archive baseline errors expose phase and safe code, never raw error text', async () => {
  for (const [list, extract, phase, code] of [
    [async () => { throw new Error('SECRET credential') }, async () => '', 'toc_read', 'ARCHIVE_TOC_READ_FAILED'],
    [async () => '', async () => '', 'toc_selection', 'ARCHIVE_TOC_MISMATCH'],
    [async () => sequenceToc, async () => { throw new Error('SECRET SQL') }, 'sequence_extract', 'ARCHIVE_SEQUENCE_EXTRACT_FAILED'],
    [async () => sequenceToc, async () => '', 'sequence_parse', 'ARCHIVE_SEQUENCE_MISSING'],
  ]) {
    const result = await readArchiveSequenceBaseline({ list, extract }, sequenceIds)
    assert.deepEqual(result, { status: 'error', code, phase })
    assert.doesNotMatch(JSON.stringify(result), /SECRET|credential/)
    const a = emptySnapshot(), b = emptySnapshot()
    const report = compare(a, b, { sequenceBaseline: result })
    assert.equal(report.can_run_rpc_tests, false)
    assert.equal(category(report, 'sequence_states').errors[0].detail_code, code)
  }
})

test('selection list is passed to bash as inert argv data, with no temporary file or DB client', async () => {
  const list = sequenceToc + '\n; literal $(printf NOT_EXECUTED)\n'
  const stub = 'pg_restore() { for arg in "$@"; do case "$arg" in --use-list=*) cat "${arg#--use-list=}";; esac; done; }; '
  const { stdout } = await promisify(execFile)('/bin/bash', ['-c', stub + SEQUENCE_EXTRACT_COMMAND, 'unit-test', list])
  assert.equal(stdout, list)
  assert.doesNotMatch(SEQUENCE_EXTRACT_COMMAND, /psql|--dbname|--host|--port|nextval|setval|--table=/)
})
