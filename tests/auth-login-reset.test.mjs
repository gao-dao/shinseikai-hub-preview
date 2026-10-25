import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function screen(file, initial, dependencies, globals = {}) {
  const state = [...initial]
  let index = 0
  const jsx = (type, props) => ({ type, props })
  const exports = {}
  const mocks = {
    react: { useRef: value => ({ current: value }), useState(value) { const slot = index++; if (!(slot in state)) state[slot] = value; return [state[slot], next => { state[slot] = next }] } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'next/link': { default: () => null },
    ...dependencies,
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, URL, ...globals, require(name) {
    assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`)
    return mocks[name]
  } })
  function find(node, type) {
    if (!node || typeof node !== 'object') return undefined
    if (Array.isArray(node)) return node.map(child => find(child, type)).find(Boolean)
    return node.type === type ? node : find(node.props?.children, type)
  }
  return { state, form: find(exports.default(), 'form') }
}

for (const role of ['member', 'admin']) for (const status of [200, 401, 429]) {
  test(`password-only screen uses server login: ${role}, status=${status}`, async () => {
    const calls = []
    const ui = screen('app/(auth)/login/page.tsx', [role, 'synthetic-password'], {
      'next/navigation': { useRouter: () => ({ push() { assert.fail('Unexpected client navigation') } }) },
    }, { window: { location: { assign: path => calls.push(path) } }, fetch: async (path, options) => {
      assert.equal(path, '/api/auth/login')
      assert.equal(options.credentials, 'same-origin')
      assert.deepEqual(JSON.parse(options.body), { role, password: 'synthetic-password' })
      calls.push('login')
      return { ok: status === 200, status, json: async () => {
        assert.equal(status, 200, 'Error response body must not be displayed')
        return { success: true }
      } }
    } })
    await ui.form.props.onSubmit({ preventDefault() {} })
    assert.deepEqual(calls, status === 200 ? ['login', role === 'admin' ? '/admin/event-groups' : '/videos'] : ['login'])
    assert.equal(ui.state[1], 'synthetic-password')
    assert.equal(ui.state[3], false)
    if (status !== 200) assert.ok(ui.state[2])
  })
}

for (const failure of ['network', 'invalid-json', 'wrong-success']) test(`login failure does not leak response or retry: ${failure}`, async () => {
  let calls = 0
  const ui = screen('app/(auth)/login/page.tsx', ['admin', 'synthetic-password'], {
    'next/navigation': { useRouter: () => ({}) },
  }, { window: { location: { assign() { assert.fail('Unexpected navigation') } } }, fetch: async () => {
    calls++
    if (failure === 'network') throw new Error('synthetic-private')
    return { ok: true, json: async () => {
      if (failure === 'invalid-json') throw new Error('synthetic-private')
      return { success: false, email: 'synthetic-private' }
    } }
  } })
  await ui.form.props.onSubmit({ preventDefault() {} })
  assert.equal(calls, 1)
  assert.equal(ui.state[3], false)
  assert.equal(ui.state[2].includes('synthetic-private'), false)
})

test('login duplicate submit is blocked until the first request finishes', async () => {
  let resolve, calls = 0
  const ui = screen('app/(auth)/login/page.tsx', ['member', 'synthetic-password'], {
    'next/navigation': { useRouter: () => ({}) },
  }, { fetch: () => { calls++; return new Promise(done => { resolve = done }) } })
  const first = ui.form.props.onSubmit({ preventDefault() {} })
  await ui.form.props.onSubmit({ preventDefault() {} })
  assert.equal(calls, 1)
  resolve({ ok: false, status: 401 })
  await first
  assert.equal(ui.state[3], false)
})

for (const origin of ['https://shinseikai-hub-preview.vercel.app', 'http://localhost:3200']) {
  for (const failed of [false, true]) test(`reset stays on its current origin; local=${origin.startsWith('http:')}, error=${failed}`, async () => {
    let calls = 0
    const ui = screen('app/(auth)/reset-password/page.tsx', ['synthetic@example.invalid'], {
      '@/lib/supabase/client': { createClient: () => ({ auth: { async resetPasswordForEmail(email, options) {
        calls++
        assert.equal(email, 'synthetic@example.invalid')
        assert.equal(options.redirectTo, `${origin}/update-password`)
        assert.equal(new URL(options.redirectTo).origin, origin)
        return { error: failed ? { message: 'synthetic private error' } : null }
      } } }) },
    }, { window: { location: { origin, search: '?redirectTo=https://foreign.invalid' } } })
    await ui.form.props.onSubmit({ preventDefault() {} })
    assert.equal(calls, 1)
    assert.equal(ui.state[3], false)
    assert.equal(ui.state[1], failed ? '' : 'パスワードリセットのメールを送信しました。メールをご確認ください。')
    assert.equal(ui.state[2], failed ? 'エラーが発生しました: synthetic private error' : '')
  })
}
