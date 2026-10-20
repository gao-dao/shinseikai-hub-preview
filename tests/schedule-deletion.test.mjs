import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const exports = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/(app)/admin/schedule-deletion.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports })
const { scheduleDeletionBlockReason, deleteScheduleSafely } = exports

function setup({ status = { hasRegistrationHistory: false, activeRegistrationCount: 0 }, loading = false, error = '', result = { data: [{ id: 7 }], error: null }, confirm = true, throws = false } = {}) {
  const calls = []
  const context = { loading, error, status }
  return {
    context, calls,
    run: () => deleteScheduleSafely({
      id: 7,
      getBlockReason: () => { calls.push('check'); return scheduleDeletionBlockReason(context) },
      confirmDelete: () => { calls.push('confirm'); return confirm },
      remove: async () => { calls.push('delete'); if (throws) throw new Error('sensitive detail'); return result },
      refresh: async () => { calls.push('refresh') },
    }),
  }
}

test('known no-history schedule is deleted and list refreshed only after success', async () => {
  const context = setup()
  assert.equal(await context.run(), null)
  assert.deepEqual(context.calls, ['check', 'confirm', 'check', 'delete', 'refresh'])
})

test('active and cancelled-only history both prevent deletion before confirmation', async () => {
  for (const activeRegistrationCount of [0, 3]) {
    const context = setup({ status: { hasRegistrationHistory: true, activeRegistrationCount } })
    assert.match(await context.run(), /取消済みを含む申込履歴/)
    assert.deepEqual(context.calls, ['check'])
  }
})

test('loading, retrieval errors, unknown and malformed history all block deletion', async () => {
  for (const options of [
    { loading: true }, { error: 'failed' }, { status: null },
    { status: {} }, { status: { hasRegistrationHistory: false, activeRegistrationCount: -1 } },
    { status: { hasRegistrationHistory: false, activeRegistrationCount: 2 } },
  ]) {
    const context = setup(options)
    assert.match(await context.run(), /削除できません/)
    assert.deepEqual(context.calls, ['check'])
  }
})

test('cancelled confirmation performs no deletion or refresh', async () => {
  const context = setup({ confirm: false })
  assert.equal(await context.run(), null)
  assert.deepEqual(context.calls, ['check', 'confirm'])
})

test('history is rechecked immediately before delete', async () => {
  let blocked = false
  let deletes = 0
  const message = await deleteScheduleSafely({
    id: 7,
    getBlockReason: () => blocked ? '申込履歴があるため削除できません。' : null,
    confirmDelete: () => { blocked = true; return true },
    remove: async () => { deletes += 1; throw new Error('must not delete') },
    refresh: async () => assert.fail('must not refresh'),
  })
  assert.match(message, /申込履歴/)
  assert.equal(deletes, 0)
})

test('foreign key rejection after a concurrent registration is safe and does not refresh', async () => {
  const context = setup({ result: { data: null, error: { code: '23503', message: 'sensitive detail' } } })
  const message = await context.run()
  assert.match(message, /関連データがあるため削除できません/)
  assert.doesNotMatch(message, /sensitive/)
  assert.equal(context.calls.includes('delete'), true)
  assert.equal(context.calls.includes('refresh'), false)
})

test('other database errors and network exceptions never refresh or expose internals', async () => {
  for (const options of [
    { result: { data: [{ id: 7 }], error: { code: '42501', message: 'sensitive detail' } } },
    { throws: true },
  ]) {
    const context = setup(options)
    const message = await context.run()
    assert.match(message, /確認|削除できません/)
    assert.doesNotMatch(message, /sensitive/)
    assert.equal(context.calls.includes('refresh'), false)
  }
})

test('zero affected rows, missing result or unexpected row is not treated as success', async () => {
  for (const data of [[], null, [{ id: 8 }]]) {
    const context = setup({ result: { data, error: null } })
    assert.match(await context.run(), /削除を確認できません/)
    assert.equal(context.calls.includes('refresh'), false)
  }
})

test('list refresh failure is distinguished from deletion failure', async () => {
  const message = await deleteScheduleSafely({
    id: 7, getBlockReason: () => null, confirmDelete: () => true,
    remove: async () => ({ data: [{ id: 7 }], error: null }),
    refresh: async () => { throw new Error('sensitive refresh detail') },
  })
  assert.match(message, /削除しましたが、一覧を更新できません/)
  assert.doesNotMatch(message, /sensitive/)
})
