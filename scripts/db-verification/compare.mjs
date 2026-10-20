import { createHmac, randomBytes } from 'node:crypto'

// Every field is explicit: neither unexpected payload fields nor error messages
// may become part of a report. SQL text stays in memory and is never rendered.
const spec = (fields, sets = [], configs = [], definitions = []) => ({ fields, sets, configs, definitions })
export const CATEGORY_SPECS = Object.freeze({
  rpc: spec(['owner', 'language', 'definition', 'security_definer', 'config', 'acl_is_null', 'acl', 'execute'], ['acl', 'execute'], ['config'], ['definition']),
  tables: spec(['kind', 'owner', 'rls', 'force_rls', 'acl_is_null', 'acl', 'acl_default'], ['acl', 'acl_default']),
  columns: spec(['position', 'type', 'not_null', 'default_expression', 'identity', 'generated', 'collation'], [], [], ['default_expression']),
  policies: spec(['permissive', 'roles', 'command', 'using_expression', 'check_expression'], ['roles'], [], ['using_expression', 'check_expression']),
  constraints: spec(['type', 'validated', 'deferrable', 'initially_deferred', 'definition'], [], [], ['definition']),
  triggers: spec(['enabled', 'definition'], [], [], ['definition']),
  event_triggers: spec(['event', 'owner', 'function', 'enabled', 'tags'], ['tags']),
  indexes: spec(['definition', 'valid', 'ready', 'unique', 'primary'], [], [], ['definition']),
  extensions: spec(['version', 'schema', 'owner']),
  roles: spec(['superuser', 'inherit', 'create_role', 'create_db', 'login', 'replication', 'bypass_rls', 'connection_limit', 'config'], [], ['config']),
  memberships: spec(['admin', 'inherit', 'set']),
  default_acl: spec(['acl'], ['acl']),
  schemas: spec(['owner', 'acl_is_null', 'acl', 'acl_default'], ['acl', 'acl_default']),
  sequence_associations: spec(['sequence']),
  sequences: spec(['owner', 'type', 'start', 'increment', 'min', 'max', 'cycle', 'cache']),
  sequence_states: spec(['last_value', 'is_called']),
})
export const CATEGORIES = Object.freeze(Object.keys(CATEGORY_SPECS))

export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  throw new Error('INVALID_VALUE')
}

const sorted = values => [...values].sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'))
const equal = (a, b) => canonical(a) === canonical(b)
const isString = value => typeof value === 'string'
const isBool = value => typeof value === 'boolean'
const integerString = value => isString(value) && /^-?(0|[1-9][0-9]*)$/.test(value)
const nullable = (value, check) => value === null || check(value)

function exactKeys(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || !equal(Object.keys(value).sort(), [...keys].sort())) throw new Error('INVALID_SHAPE')
}

function normalizeAcl(value) {
  if (!Array.isArray(value)) throw new Error('INVALID_ACL')
  for (const grant of value) {
    exactKeys(grant, ['grantee', 'grantor', 'privilege', 'grantable'])
    if (![grant.grantee, grant.grantor, grant.privilege].every(isString) || !isBool(grant.grantable)) throw new Error('INVALID_ACL')
  }
  const normalized = sorted(value)
  if (new Set(normalized.map(canonical)).size !== normalized.length) throw new Error('DUPLICATE_ACL')
  return normalized
}

function normalizeConfig(value) {
  if (value === null) return null
  if (!Array.isArray(value) || !value.every(isString)) throw new Error('INVALID_CONFIG')
  const entries = value.map(setting => {
    const separator = setting.indexOf('=')
    if (separator < 1) throw new Error('INVALID_CONFIG')
    // Only the order of setting KEYS is ignored. Preserve the complete value,
    // including search_path ordering, quotes, whitespace and embedded '='.
    return [setting.slice(0, separator), setting.slice(separator + 1)]
  })
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('DUPLICATE_CONFIG')
  return sorted(entries)
}

function validateField(field, value, category) {
  const booleans = ['security_definer', 'acl_is_null', 'rls', 'force_rls', 'not_null', 'validated', 'deferrable', 'initially_deferred', 'valid', 'ready', 'unique', 'primary', 'superuser', 'inherit', 'create_role', 'create_db', 'login', 'replication', 'bypass_rls', 'admin', 'set', 'cycle', 'is_called']
  if (booleans.includes(field) && !isBool(value)) throw new Error('INVALID_BOOLEAN')
  if (['start', 'increment', 'min', 'max', 'cache', 'last_value'].includes(field) && !integerString(value)) throw new Error('INVALID_BIGINT')
  if (['position', 'connection_limit'].includes(field) && !Number.isSafeInteger(value)) throw new Error('INVALID_INTEGER')
  if (['roles', 'tags'].includes(field) && !nullable(value, v => Array.isArray(v) && v.every(isString))) throw new Error('INVALID_SET')
  if (field === 'execute' && (!Array.isArray(value) || !value.every(v => Array.isArray(v) && v.length === 2 && isString(v[0]) && isBool(v[1])))) throw new Error('INVALID_EXECUTE')
  if (field === 'sequence' && (!Array.isArray(value) || value.length !== 2 || !value.every(isString))) throw new Error('INVALID_ASSOCIATION')
  if (['definition', 'default_expression', 'using_expression', 'check_expression', 'collation'].includes(field) && !nullable(value, isString)) throw new Error('INVALID_DEFINITION')
  const special = [...booleans, 'start', 'increment', 'min', 'max', 'cache', 'last_value', 'position', 'connection_limit', 'roles', 'tags', 'execute', 'sequence', 'definition', 'default_expression', 'using_expression', 'check_expression', 'collation', 'acl', 'acl_default', 'config']
  if (!special.includes(field) && !isString(value)) throw new Error('INVALID_TEXT')
  if (category === 'default_acl' && field === 'acl') normalizeAcl(value)
}

export function normalizeRows(category, input) {
  if (!input || input.status !== 'ok' || !Array.isArray(input.rows)) throw new Error('COLLECTION_FAILED')
  const spec = CATEGORY_SPECS[category]
  const map = new Map()
  for (const row of input.rows) {
    exactKeys(row, ['id', ...spec.fields])
    if (!Array.isArray(row.id) || row.id.length === 0 || !row.id.every(v => v === null || isString(v))) throw new Error('INVALID_ID')
    const key = canonical(row.id)
    if (map.has(key)) throw new Error('DUPLICATE_OBJECT')
    const normalized = { id: row.id }
    for (const field of spec.fields) {
      const value = row[field]
      validateField(field, value, category)
      if (field === 'acl' || field === 'acl_default') normalized[field] = normalizeAcl(value)
      else if (spec.configs.includes(field)) normalized[field] = normalizeConfig(value)
      else if (spec.sets.includes(field)) normalized[field] = value === null ? null : sorted(value)
      else normalized[field] = value
    }
    map.set(key, normalized)
  }
  return map
}

function delta(left, right) {
  const a = new Set(left.map(canonical)), b = new Set(right.map(canonical))
  return { missing_count: [...a].filter(v => !b.has(v)).length, added_count: [...b].filter(v => !a.has(v)).length }
}

// Reports use per-run HMAC identifiers and definition digests. No identifier,
// definition, setting value, exception text, or unrecognized field is echoed.
export function createReporter(key = randomBytes(32)) {
  const digest = (purpose, value) => createHmac('sha256', key).update(purpose).update('\0').update(canonical(value)).digest('hex')
  return {
    objectId: (category, id) => digest(`id:${category}`, id),
    definitionHash: value => digest('definition', value),
    objectLabel: (category, id) => {
      // Only fixed project-owned names may be printed. Unknown identifiers can
      // themselves contain personal information and remain opaque.
      const tables = new Set(['public.profiles', 'public.schedules', 'public.videos', 'public.event_groups', 'public.registrations', 'public.registration_items', 'registration_private.fingerprint_secret', 'registration_private.registration_requests'])
      const functions = new Set(['public.is_admin', 'public.enforce_schedule_capacity', 'public.add_registration_items', 'public.create_registration', 'public.submit_registration', 'public.get_event_group_availability', 'public.admin_create_registration', 'public.admin_add_registration_items', 'public.admin_cancel_registration_item', 'public.admin_update_registration_details', 'public.submit_registration_idempotent', 'auth.uid'])
      const context = id.slice(0, 2).join('.')
      if (category === 'rpc' && functions.has(context)) return context
      if (['tables', 'columns', 'policies', 'constraints', 'triggers', 'indexes', 'sequence_associations'].includes(category) && tables.has(context)) return context
      if (category === 'schemas' && id.length === 1 && ['public', 'registration_private'].includes(id[0])) return id[0]
      return undefined
    },
  }
}

function compareCategory(category, left, right, reporter) {
  const count = input => input?.status === 'ok' && Array.isArray(input.rows) ? input.rows.length : null
  const summary = { category, source_count: count(left), restored_count: count(right), matched: false, added_count: 0, missing_count: 0, changed_count: 0, representation_count: 0, representation_differences: [], differences: [], errors: [] }
  let source, restored
  for (const [side, input] of [['source', left], ['restored', right]]) {
    try {
      const normalized = normalizeRows(category, input)
      if (side === 'source') source = normalized
      else restored = normalized
    } catch {
      const safeCodes = ['QUERY_FAILED', 'ARCHIVE_SEQUENCE_READ_FAILED', 'INVALID_SEQUENCE_INVENTORY', 'DUPLICATE_EXPECTED_SEQUENCE', 'ARCHIVE_TOC_READ_FAILED', 'ARCHIVE_TOC_INVALID', 'ARCHIVE_TOC_MISMATCH', 'ARCHIVE_SEQUENCE_EXTRACT_FAILED', 'ARCHIVE_SEQUENCE_PARSE_FAILED', 'UNEXPECTED_ARCHIVE_CONTENT', 'INVALID_ARCHIVE_SEQUENCE_NAME', 'UNEXPECTED_ARCHIVE_SEQUENCE', 'ARCHIVE_SEQUENCE_MISSING']
      summary.errors.push({ side, code: input?.status === 'ok' ? 'NORMALIZATION_FAILED' : 'COLLECTION_FAILED',
        ...(safeCodes.includes(input?.code) ? { detail_code: input.code } : {}) })
    }
  }
  if (summary.errors.length) return summary
  const spec = CATEGORY_SPECS[category]
  for (const key of [...new Set([...source.keys(), ...restored.keys()])].sort()) {
    const a = source.get(key), b = restored.get(key)
    const object_id = reporter.objectId(category, (a ?? b).id)
    const object_label = reporter.objectLabel?.(category, (a ?? b).id)
    if (!a || !b) {
      const change = a ? 'missing' : 'added'
      summary[`${change}_count`]++
      summary.differences.push({ object_id, ...(object_label ? { object_label } : {}), change, fields: [] })
      continue
    }
    const fields = []
    for (const field of spec.fields) {
      if (equal(a[field], b[field])) continue
      // pg_dump emits ACL changes relative to the built-in default. An explicit
      // default ACL can therefore restore as NULL. Accept only this explained
      // case; retain an audit record and never waive effective privilege changes.
      if (field === 'acl_is_null' && ['tables', 'schemas'].includes(category) &&
          a.owner === b.owner && (category !== 'tables' || a.kind === b.kind) &&
          equal(a.acl, b.acl) && equal(a.acl, a.acl_default) && equal(b.acl, b.acl_default)) {
        summary.representation_count++
        summary.representation_differences.push({ object_id, ...(object_label ? { object_label } : {}), field,
          kind: 'explicit_builtin_default_vs_null', source_is_null: a.acl_is_null, restored_is_null: b.acl_is_null,
          owner_matches: true, effective_acl_matches: true, builtin_default_matches: true })
        continue
      }
      const detail = { field, kind: 'value_changed' }
      if (spec.definitions.includes(field)) {
        detail.kind = 'definition_changed_unresolved'
        detail.source_hash = reporter.definitionHash(a[field])
        detail.restored_hash = reporter.definitionHash(b[field])
      } else if (field === 'acl' || field === 'acl_default') {
        detail.kind = 'acl_changed'
        Object.assign(detail, delta(a[field], b[field]))
        detail.dimensions = ['grantee', 'grantor', 'privilege', 'grantable'].filter(k => !equal(sorted(a[field].map(g => g[k])), sorted(b[field].map(g => g[k]))))
        if (!detail.dimensions.length) detail.dimensions = ['grant_relationship']
      } else if (field === 'acl_is_null') {
        detail.kind = 'acl_representation_changed'
      } else if (spec.configs.includes(field)) detail.kind = 'settings_changed'
      fields.push(detail)
    }
    if (fields.length) {
      summary.changed_count++
      summary.differences.push({ object_id, ...(object_label ? { object_label } : {}), change: 'changed', fields })
    }
  }
  summary.matched = summary.differences.length === 0
  return summary
}

export function emptySnapshot() {
  return Object.fromEntries(CATEGORIES.map(category => [category, { status: 'ok', rows: [] }]))
}

export function compareSnapshots(source, restored, { sequenceBaseline, reporter = createReporter() } = {}) {
  const categories = []
  for (const category of CATEGORIES) {
    // Persisted sequence state is judged against the BACKUP, never live counters.
    const expected = category === 'sequence_states' ? sequenceBaseline : source?.[category]
    const result = compareCategory(category, expected, restored?.[category], reporter)
    if (category === 'sequence_states') result.reference = 'backup'
    categories.push(result)
  }
  const live = compareCategory('sequence_states', sequenceBaseline, source?.sequence_states, reporter)
  const matched = categories.every(c => c.matched) && live.errors.length === 0
  return {
    format_version: 2,
    matched,
    can_run_rpc_tests: matched,
    categories,
    current_sequence_changes_since_backup: { informational: true, ...live },
  }
}
