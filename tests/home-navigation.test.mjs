import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function load(file, mocks) {
  const exports = {}
  const jsx = (type, props) => ({ type, props })
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    assert.ok(name in mocks, `Unexpected dependency: ${name}`)
    return mocks[name]
  } })
  return exports.default
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
const Link = 'Link'
test('public homepage needs no session or DB and prioritizes event announcements', () => {
  const Home = load('app/page.tsx', { 'next/link': { default: Link }, './home.module.css': { default: {} } })
  const links = nodes(Home()).filter(n => n.type === Link)
  assert.equal(links.length, 3)
  assert.ok(links.some(n => n.props.href === '/events'))
  assert.ok(links.some(n => n.props.href === '/videos'))
  assert.ok(links.some(n => n.props.href === '/login'))
})

for (const role of ['anonymous', 'member', 'admin', 'profile-error', 'auth-error']) {
  test(`navigation uses verified user role: ${role}`, async () => {
    const state = []
    let index = 0, effect, memo
    const calls = []
    const client = {
      auth: {
        getUser: async () => ({ data: { user: role === 'anonymous' ? null : { id: 'own-user' } }, error: role === 'auth-error' ? {} : null }),
        signOut: async options => { calls.push(options.scope); return { error: null } },
      },
      from(table) { assert.equal(table, 'profiles'); return { select(columns) { assert.equal(columns, 'role'); return { eq(key, value) { assert.equal(key, 'id'); assert.equal(value, 'own-user'); return { maybeSingle: async () => ({ data: { role }, error: role === 'profile-error' ? {} : null }) } } } } } },
    }
    const Layout = load('app/(app)/layout.tsx', {
      react: {
        useState(initial) { const slot = index++; if (!(slot in state)) state[slot] = initial; return [state[slot], next => { state[slot] = next }] },
        useMemo(fn) { return memo ??= fn() }, useEffect(fn) { effect = fn },
      },
      'next/link': { default: Link },
      'next/navigation': { useRouter: () => ({ push: path => calls.push(path) }), usePathname: () => '/schedule' },
      '@/lib/supabase/client': { createClient: () => client },
    })
    function render() { index = 0; return nodes(Layout({ children: 'existing content' })) }
    assert.equal(render().some(n => n.props?.href === '/admin'), false)
    const cleanup = effect()
    await new Promise(resolve => setImmediate(resolve))
    const result = render()
    assert.equal(result.some(n => n.props?.href === '/admin'), role === 'admin')
    assert.equal(result.some(n => n.props?.href === '/videos'), !['anonymous', 'auth-error'].includes(role))
    assert.ok(result.some(n => n.props?.href === '/schedule'))
    assert.ok(result.some(n => n.props?.href === '/'))
    const logout = result.find(n => n.type === 'button')
    if (logout) {
      await logout.props.onClick()
      assert.deepEqual(calls, ['local', '/login'])
    } else assert.ok(result.some(n => n.props?.href === '/login'))
    cleanup()
  })
}
