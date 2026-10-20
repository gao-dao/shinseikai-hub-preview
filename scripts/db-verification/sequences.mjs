import { canonical, normalizeRows } from './compare.mjs'
import { quoteIdentifier } from './queries.mjs'

// TOC IDs avoid pg_restore -t's literal-name matching, identifier quoting, and
// collisions between equal sequence names in different schemas.
export function selectSequenceTocEntries(list, expectedIds) {
  if (typeof list !== 'string' || !Array.isArray(expectedIds) || !expectedIds.length ||
      !expectedIds.every(id => Array.isArray(id) && id.length === 2 && id.every(v => typeof v === 'string' && v.length && !/[\n\r\0]/.test(v)))) throw new Error('INVALID_SEQUENCE_INVENTORY')
  const expected = new Set(expectedIds.map(canonical))
  if (expected.size !== expectedIds.length) throw new Error('DUPLICATE_EXPECTED_SEQUENCE')
  const selected = [], found = new Set(), dumpIds = new Set()
  for (const line of list.split(/\r?\n/)) {
    if (line.startsWith(';') || !line.trim()) continue
    const match = /^(\d+);\s+\d+\s+\d+\s+SEQUENCE SET\s+(.+)$/.exec(line)
    if (!match) {
      if (/^\d+;.*\bSEQUENCE SET\b/.test(line)) throw new Error('ARCHIVE_TOC_INVALID')
      continue
    }
    const matching = expectedIds.filter(([schema, name]) => match[2].startsWith(`${schema} ${name} `))
    if (matching.length !== 1) throw new Error('ARCHIVE_TOC_MISMATCH')
    const key = canonical(matching[0])
    if (found.has(key) || dumpIds.has(match[1])) throw new Error('ARCHIVE_TOC_MISMATCH')
    found.add(key); dumpIds.add(match[1]); selected.push(line)
  }
  if (found.size !== expected.size) throw new Error('ARCHIVE_TOC_MISMATCH')
  return { list: selected.join('\n') + '\n', entry_count: selected.length }
}

// $1 is list DATA passed as a separate argv entry, never interpolated into code.
// Both input streams use file descriptors. No file is written inside a container.
// --file=- emits SQL text; there is no database argument and no SQL execution.
export const SEQUENCE_EXTRACT_COMMAND = 'pg_restore --data-only --use-list=<(printf "%s" "$1") --file=-'

export async function readArchiveSequenceBaseline(io, expectedIds) {
  let phase = 'toc_read'
  try {
    const list = await io.list()
    phase = 'toc_selection'
    const selection = selectSequenceTocEntries(list, expectedIds)
    phase = 'sequence_extract'
    const sql = await io.extract(selection.list)
    phase = 'sequence_parse'
    const result = parseArchiveSequenceStates(sql, expectedIds)
    return { ...result, evidence: { method: 'sequence_set_toc_ids', toc_entries: selection.entry_count, parsed_states: result.rows.length } }
  } catch (error) {
    const codes = ['INVALID_SEQUENCE_INVENTORY', 'DUPLICATE_EXPECTED_SEQUENCE', 'ARCHIVE_TOC_INVALID', 'ARCHIVE_TOC_MISMATCH', 'UNEXPECTED_ARCHIVE_CONTENT', 'INVALID_ARCHIVE_SEQUENCE_NAME', 'UNEXPECTED_ARCHIVE_SEQUENCE', 'ARCHIVE_SEQUENCE_MISSING']
    const fallback = { toc_read: 'ARCHIVE_TOC_READ_FAILED', toc_selection: 'ARCHIVE_TOC_INVALID', sequence_extract: 'ARCHIVE_SEQUENCE_EXTRACT_FAILED', sequence_parse: 'ARCHIVE_SEQUENCE_PARSE_FAILED' }
    return { status: 'error', code: codes.includes(error?.message) ? error.message : fallback[phase], phase }
  }
}

// Parse dump output as DATA; never execute these setval statements. The restore
// process, outside this verifier, is responsible for restoring sequence state.
export function parseArchiveSequenceStates(sql, expectedIds) {
  if (typeof sql !== 'string' || /^(?:COPY|INSERT|UPDATE|DELETE|CREATE)\s/mi.test(sql)) throw new Error('UNEXPECTED_ARCHIVE_CONTENT')
  const expected = new Set(expectedIds.map(canonical))
  if (expected.size !== expectedIds.length) throw new Error('DUPLICATE_EXPECTED_SEQUENCE')
  const states = []
  const seen = new Set()
  const identifier = '("(?:[^"\n]|"")+"|[a-z_][a-z0-9_$]*)'
  const qualified = new RegExp(`^${identifier}\\.${identifier}$`)
  for (const match of sql.matchAll(/^SELECT pg_catalog\.setval\('((?:[^'\n]|'')+)',\s*(-?\d+),\s*(true|false)\);\s*$/gm)) {
    const name = match[1].replaceAll("''", "'")
    const parts = qualified.exec(name)
    if (!parts) throw new Error('INVALID_ARCHIVE_SEQUENCE_NAME')
    const unquote = s => s.startsWith('"') ? s.slice(1, -1).replaceAll('""', '"') : s
    const id = [unquote(parts[1]), unquote(parts[2])]
    const key = canonical(id)
    if (!expected.has(key) || seen.has(key)) throw new Error('UNEXPECTED_ARCHIVE_SEQUENCE')
    seen.add(key)
    states.push({ id, last_value: BigInt(match[2]).toString(), is_called: match[3] === 'true' })
  }
  if (seen.size !== expected.size) throw new Error('ARCHIVE_SEQUENCE_MISSING')
  return { status: 'ok', rows: states }
}

export function nextCandidate(definition, state) {
  const increment = BigInt(definition.increment), min = BigInt(definition.min), max = BigInt(definition.max)
  if (increment === 0n || min > max || BigInt(definition.cache) < 1n) throw new Error('INVALID_SEQUENCE_DEFINITION')
  let value = BigInt(state.last_value)
  if (value < min || value > max) throw new Error('INVALID_SEQUENCE_STATE')
  if (state.is_called) value += increment
  if (value < min || value > max) {
    if (!definition.cycle) throw new Error('SEQUENCE_EXHAUSTED')
    value = increment > 0n ? min : max
  }
  return value.toString()
}

export async function verifySequenceCandidates(snapshot, readQuery, reporter) {
  const checks = []
  let definitions, states, associations
  try {
    definitions = normalizeRows('sequences', snapshot.sequences)
    states = normalizeRows('sequence_states', snapshot.sequence_states)
    associations = normalizeRows('sequence_associations', snapshot.sequence_associations)
  } catch {
    return { matched: false, checks: [], errors: [{ code: 'SEQUENCE_INPUT_INVALID' }] }
  }
  for (const [key, definition] of definitions) {
    const object_id = reporter.objectId('sequences', definition.id)
    try {
      const state = states.get(key)
      if (!state) throw new Error('SEQUENCE_STATE_MISSING')
      const related = [...associations.values()].filter(a => canonical(a.sequence) === key)
      if (!related.length) throw new Error('ASSOCIATION_MISSING')
      const candidate = nextCandidate(definition, state)
      for (const association of related) {
        if (association.id.length !== 3) throw new Error('INVALID_ASSOCIATION')
        const [schema, table, column] = association.id.map(quoteIdentifier)
        // candidate is a BigInt-generated decimal literal, not arbitrary SQL.
        const result = await readQuery(`SELECT min(${column})::text min_id,max(${column})::text max_id,
          coalesce(bool_or(${column}=${candidate}),false) collision FROM ${schema}.${table}`)
        if (!Array.isArray(result) || result.length !== 1 || typeof result[0].collision !== 'boolean') throw new Error('BOUNDS_QUERY_FAILED')
        const { min_id, max_id, collision } = result[0]
        if (collision) throw new Error('CANDIDATE_COLLISION')
        const extreme = BigInt(definition.increment) > 0n ? max_id : min_id
        if (extreme !== null) {
          const safe = BigInt(definition.increment) > 0n ? BigInt(candidate) > BigInt(extreme) : BigInt(candidate) < BigInt(extreme)
          if (!safe) throw new Error('FUTURE_RANGE_OVERLAP')
        }
      }
      checks.push({ object_id, matched: true, associations_checked: related.length })
    } catch (error) {
      const allowed = ['SEQUENCE_STATE_MISSING', 'ASSOCIATION_MISSING', 'INVALID_ASSOCIATION', 'INVALID_SEQUENCE_DEFINITION', 'INVALID_SEQUENCE_STATE', 'SEQUENCE_EXHAUSTED', 'BOUNDS_QUERY_FAILED', 'CANDIDATE_COLLISION', 'FUTURE_RANGE_OVERLAP']
      checks.push({ object_id, matched: false, code: allowed.includes(error?.message) ? error.message : 'SEQUENCE_CHECK_FAILED' })
    }
  }
  return { matched: checks.every(c => c.matched), checks, errors: [] }
}
