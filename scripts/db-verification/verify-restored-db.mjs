import { spawn } from 'node:child_process'
import { readFile, realpath, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { compareSnapshots, createReporter } from './compare.mjs'
import { collectMetadata, READ_CONTEXT } from './queries.mjs'
import { readArchiveSequenceBaseline, SEQUENCE_EXTRACT_COMMAND, verifySequenceCandidates } from './sequences.mjs'

const SOURCE = 'supabase_db_shinseikai-hub'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 })
    const stdout = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', () => {})
    child.on('error', () => reject(new Error('DOCKER_COMMAND_FAILED')))
    child.stdin.on('error', () => {})
    child.on('close', code => {
      // Do not propagate command output or a database error's SQL/context.
      if (code !== 0) reject(new Error('DOCKER_COMMAND_FAILED'))
      else resolve(Buffer.concat(stdout).toString('utf8'))
    })
    child.stdin.end(input)
  })
}

async function inspect(container) {
  const format = '{"name":{{json .Name}},"image":{{json .Image}},"running":{{json .State.Running}},"network":{{json .HostConfig.NetworkMode}},"ports":{{json .HostConfig.PortBindings}},"binds":{{json .HostConfig.Binds}},"mounts":{{json .Mounts}},"labels":{{json .Config.Labels}}}'
  return JSON.parse(await run(['inspect', '--format', format, container]))
}

function reader(container, database, socket) {
  return async query => {
    const sql = `${READ_CONTEXT}
      SET LOCAL statement_timeout='10s';
      SET LOCAL lock_timeout='2s';
      SELECT coalesce(json_agg(metadata_row),'[]'::json) FROM (${query}) metadata_row;
      COMMIT;`
    const output = await run(['exec', '-i', container, 'psql', '-X', '-q', '-At', '-h', socket, '-U', 'supabase_admin', '-d', database, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate'], sql)
    const rows = JSON.parse(output)
    if (!Array.isArray(rows)) throw new Error('INVALID_QUERY_RESULT')
    return rows
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    'restored-container': { type: 'string' },
    database: { type: 'string', default: 'restore_check' },
    archive: { type: 'string' },
    report: { type: 'string' },
  } })
  const target = values['restored-container']
  if (!target || target === SOURCE || !/^shinseikai-(?:rpc-clone|restore-check)-[a-z0-9-]+$/.test(target)) throw new Error('INVALID_TARGET')
  if (!values.archive || !values.report || !/^[a-z_][a-z0-9_]*$/.test(values.database)) throw new Error('INVALID_ARGUMENTS')
  const backupRoot = await realpath(path.join(ROOT, 'backups'))
  const archive = await realpath(path.resolve(values.archive))
  const reportPath = path.resolve(values.report)
  if (!archive.startsWith(backupRoot + path.sep) || !archive.endsWith('.dump') || !reportPath.endsWith('.json')) throw new Error('INVALID_PATH')
  await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 })
  const parent = await realpath(path.dirname(reportPath))
  if (!parent.startsWith(backupRoot + path.sep)) throw new Error('INVALID_REPORT_PATH')
  const source = await inspect(SOURCE), restored = await inspect(target)
  if (source.name !== '/' + SOURCE || !source.running || restored.name !== '/' + target || !restored.running || source.image !== restored.image || restored.network !== 'none' || Object.keys(restored.ports ?? {}).length || restored.binds?.length || restored.mounts?.length) throw new Error('ISOLATION_CHECK_FAILED')
  if (restored.labels?.['shinseikai.rpc-clone-test'] !== 'true' && restored.labels?.['shinseikai.restore-test'] !== 'true') throw new Error('ISOLATION_LABEL_MISSING')
  const sourceRead = reader(SOURCE, 'postgres', '/var/run/postgresql')
  const restoredRead = reader(target, values.database, '/tmp')
  const before = await collectMetadata(sourceRead)
  const clone = await collectMetadata(restoredRead)
  const reporter = createReporter()
  let baseline
  try {
    if (clone.sequences.status !== 'ok') throw new Error('SEQUENCE_DEFINITIONS_UNAVAILABLE')
    const ids = clone.sequences.rows.map(row => row.id)
    const bytes = await readFile(archive)
    baseline = await readArchiveSequenceBaseline({
      list: () => run(['exec', '-i', target, 'pg_restore', '--list'], bytes),
      extract: selection => run(['exec', '-i', target, '/bin/bash', '-c', SEQUENCE_EXTRACT_COMMAND, 'sequence-baseline', selection], bytes),
    }, ids)
  } catch {
    baseline = { status: 'error', code: 'ARCHIVE_SEQUENCE_READ_FAILED' }
  }
  const report = compareSnapshots(before, clone, { sequenceBaseline: baseline, reporter })
  report.sequence_baseline = baseline.status === 'ok'
    ? { status: 'ok', ...baseline.evidence }
    : { status: 'error', code: baseline.code, ...(baseline.phase ? { phase: baseline.phase } : {}) }
  report.sequence_candidates = await verifySequenceCandidates(clone, restoredRead, reporter)
  // Detect metadata drift while collecting, independently of backup/live counters.
  const after = await collectMetadata(sourceRead)
  const stability = compareSnapshots(before, after, { sequenceBaseline: before.sequence_states, reporter })
  report.source_metadata_stable = stability.categories.filter(c => c.category !== 'sequence_states').every(c => c.matched)
  report.source_metadata_changes = stability.categories.filter(c => c.category !== 'sequence_states' && !c.matched)
  report.matched = report.matched && report.sequence_candidates.matched && report.source_metadata_stable
  report.can_run_rpc_tests = report.matched
  report.scope = ['public', 'registration_private', 'auth.uid', 'cluster_roles_extensions_sequences']
  report.read_only = true
  report.rpc_tests_executed = false
  report.container_created_or_removed = false
  // Exclusive create: cannot overwrite a backup or previous verification report.
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ matched: report.matched, can_run_rpc_tests: report.can_run_rpc_tests, categories: report.categories.length }) + '\n')
  process.exitCode = report.matched ? 0 : 1
}

main().catch(error => {
  const allowed = ['INVALID_TARGET', 'INVALID_ARGUMENTS', 'INVALID_PATH', 'INVALID_REPORT_PATH', 'ISOLATION_CHECK_FAILED', 'ISOLATION_LABEL_MISSING', 'DOCKER_COMMAND_FAILED']
  const code = allowed.includes(error?.message) ? error.message : 'VERIFICATION_SETUP_FAILED'
  process.stderr.write(`DB verification could not complete (${code}); no RPC tests were executed.\n`)
  process.exitCode = 1
})
