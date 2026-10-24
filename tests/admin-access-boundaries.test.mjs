import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Only explicit mock dependencies are available: no process.env, fetch or DB.
function compile(file, dependencies, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, ...globals, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}

for (const [label, user, userError, profile, profileError, expected] of [
  ['anonymous', null, null, null, null, 401],
  ['invalid session', { id: 'synthetic-user' }, {}, { role: 'admin' }, null, 401],
  ['member', { id: 'synthetic-user' }, null, { role: 'member' }, null, 403],
  ['missing profile', { id: 'synthetic-user' }, null, null, null, 403],
  ['profile read failure', { id: 'synthetic-user' }, null, { role: 'admin' }, {}, 403],
  ['nonexact admin role', { id: 'synthetic-user' }, null, { role: 'Admin' }, null, 403],
  ['administrator', { id: 'synthetic-user' }, null, { role: 'admin' }, null, 200],
]) test(`real requireAdmin boundary: ${label}`, async () => {
  const calls = []
  const query = {
    select(value) { assert.equal(value, 'role'); return this },
    eq(field, value) { assert.equal(field, 'id'); assert.equal(value, 'synthetic-user'); return this },
    async maybeSingle() { return { data: profile, error: profileError } },
  }
  const { requireAdmin } = compile('lib/supabase/require-admin.ts', {
    './server': { createClient: async () => ({
      auth: { getUser: async () => ({ data: { user }, error: userError }) },
      from(table) { calls.push(table); assert.equal(table, 'profiles'); return query },
    }) },
  })
  const result = await requireAdmin()
  assert.equal(result.ok, expected === 200)
  if (!result.ok) {
    assert.equal(result.status, expected)
    assert.deepEqual(Object.keys(result).sort(), ['error', 'ok', 'status'])
  }
  assert.equal(calls.length, expected === 401 ? 0 : 1)
})

for (const [folder, component] of [['event-groups', './admin-index-view'], ['registrations', './registration-list']]) {
  for (const [status, destination] of [[401, '/login'], [403, '/videos'], [200, null]]) {
    test(`admin ${folder} page boundary: ${status}`, async () => {
      let rendered = 0
      const page = compile(`app/(app)/admin/${folder}/page.tsx`, {
        'next/navigation': { redirect(path) { assert.equal(path, destination); throw new Error('TEST_REDIRECT') } },
        '@/lib/supabase/require-admin': { requireAdmin: async () => status === 200 ? { ok: true } : { ok: false, status } },
        [component]: { default: () => null },
        '@/lib/event-groups/admin-index': { indexOptions: () => ({}) },
        '@/lib/event-groups/admin-index-server': { loadAdminIndex: async () => { assert.equal(status, 200); return {} } },
        'react/jsx-runtime': { jsx() { rendered++; return 'TEST_PAGE' } },
      })
      if (destination) {
        await assert.rejects(page.default(), /TEST_REDIRECT/)
        assert.equal(rendered, 0)
      } else {
        assert.equal(await page.default(), 'TEST_PAGE')
        assert.equal(rendered, 1)
      }
    })
  }
}

// The retired endpoint has no Supabase or environment dependency.
for (const role of ['member', 'admin', 'unexpected-role']) test(`retired email lookup never exposes an account: ${role}`, async () => {
  const api = compile('app/api/auth/get-email-by-role/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => ({ body, ...options }) } },
  })
  const response = await api.POST({ json: async () => ({ role }) })
  assert.equal(response.status, 410)
  assert.equal('email' in response.body, false)
  assert.equal(response.headers['Cache-Control'], 'no-store')
})
