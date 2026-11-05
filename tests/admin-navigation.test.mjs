import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsx from 'react/jsx-runtime'

function compile(file, dependencies, globals = {}) {
  const exports = {}
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(source, { exports, ...globals, require(name) { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`); return dependencies[name] } })
  return exports
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  if (typeof tree.type === 'function') return nodes(tree.type(tree.props))
  return [tree, ...nodes(tree.props?.children)]
}
const Nav = compile('app/(app)/admin/admin-navigation.tsx', {
  'next/link': { default: 'a' }, 'react/jsx-runtime': jsx,
  './event-groups/admin-index.module.css': { default: { nav: 'nav', adminNav: 'adminNav' } },
}).default
const expected = [
  ['/admin', '管理ホーム'], ['/admin/event-groups', '開催回管理'], ['/admin/registrations', '申込者管理'],
  ['/admin/videos', '動画管理'], ['/admin/event-groups/history', '開催履歴'], ['/admin/passwords', 'パスワード管理'],
]
const routes = [
  ['/admin', '/admin'], ['/admin/event-groups', '/admin/event-groups'],
  ['/admin/event-groups/new', '/admin/event-groups'], ['/admin/event-groups/17', '/admin/event-groups'],
  ['/admin/event-groups/17/edit', '/admin/event-groups'], ['/admin/event-groups/history', '/admin/event-groups/history'],
  ['/admin/event-groups/history/', '/admin/event-groups/history'], ['/admin/registrations', '/admin/registrations'],
  ['/admin/videos', '/admin/videos'], ['/admin/passwords', '/admin/passwords'],
]
for (const [pathname, active] of routes) test(`shared admin navigation links and current location: ${pathname}`, () => {
  const tree = nodes(Nav({ pathname })), links = tree.filter(n => n.type === 'a')
  assert.deepEqual(links.map(n => [n.props.href, n.props.children]), expected)
  assert.deepEqual(links.filter(n => n.props['aria-current'] === 'page').map(n => n.props.href), [active])
  assert.ok(links.every(n => n.props.prefetch === false))
  assert.equal(tree.filter(n => n.type === 'nav').length, 1)
  assert.equal(tree.find(n => n.type === 'nav').props['aria-label'], '管理画面メニュー')
})

async function layout(pathname, role) {
  const slots = [], calls = []; let cursor = 0, effect
  const client = {
    auth: { getUser: async () => { calls.push('user'); return { data: { user: role === 'anonymous' ? null : { id: 'synthetic' } }, error: role === 'auth-error' ? {} : null } } },
    from(table) { assert.equal(table, 'profiles'); calls.push('profile'); return { select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: role === 'missing-profile' ? null : { role }, error: role === 'profile-error' ? {} : null }) } },
  }
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useEffect(fn) { effect = fn }, useMemo(fn) { return fn() },
  }
  const Layout = compile('app/(app)/layout.tsx', {
    react, 'react/jsx-runtime': jsx, 'next/link': { default: 'a' }, './admin/admin-navigation': { default: Nav },
    'next/navigation': { usePathname: () => pathname, useRouter: () => ({}) },
    '@/lib/supabase/client': { createClient: () => client },
  }).default
  function render() { cursor = 0; return nodes(Layout({ children: jsx.jsx('p', { children: 'Page content' }) })) }
  const initial = render()
  assert.equal(initial.some(n => n.props?.['aria-label'] === '管理画面メニュー'), false)
  const cleanup = effect()
  await new Promise(resolve => setImmediate(resolve))
  const tree = render(); cleanup()
  return { tree, calls }
}
for (const [pathname] of routes) for (const role of ['admin', 'member', 'anonymous', 'auth-error', 'profile-error', 'missing-profile']) test(`shared layout menu visibility: ${pathname}, ${role}`, async () => {
  const { tree, calls } = await layout(pathname, role)
  const menus = tree.filter(n => n.props?.['aria-label'] === '管理画面メニュー')
  assert.equal(menus.length, role === 'admin' ? 1 : 0)
  assert.equal(calls.filter(v => v === 'user').length, 1)
  assert.equal(calls.filter(v => v === 'profile').length, ['anonymous', 'auth-error'].includes(role) ? 0 : 1)
  if (role === 'admin') {
    assert.deepEqual(nodes(menus[0]).filter(n => n.type === 'a').map(n => [n.props.href, n.props.children]), expected)
    const header = tree.find(n => n.type === 'header')
    assert.equal(nodes(header).some(n => n.type === 'a' && n.props.href === '/admin'), false)
    for (const href of ['/', '/events', '/schedule', '/videos']) assert.ok(nodes(header).some(n => n.props?.href === href))
  }
})
for (const pathname of ['/videos', '/schedule', '/events', '/administrator']) test(`admin menu is absent outside the admin route segment: ${pathname}`, async () => {
  const { tree } = await layout(pathname, 'admin')
  assert.equal(tree.some(n => n.props?.['aria-label'] === '管理画面メニュー'), false)
  assert.ok(tree.some(n => n.type === 'a' && n.props.href === '/admin'))
})

function pages(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? pages(path.join(dir, entry.name)) : entry.name === 'page.tsx' ? [path.join(dir, entry.name)] : []) }
for (const file of pages('app/(app)/admin')) for (const status of [401, 403]) test(`existing server boundary is retained: ${file}, ${status}`, async () => {
  let checks = 0
  const dependencies = {}
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/from ['"]([^'"]+)['"]/g)) dependencies[match[1]] = {
    default: 'PageView', indexOptions() { assert.fail('no read before authorization') }, loadAdminIndex() { assert.fail('no read before authorization') }, adminReturnHref() { assert.fail('no parameter handling before authorization') },
  }
  Object.assign(dependencies, {
    'react/jsx-runtime': jsx, 'next/link': { default: 'a' },
    'next/navigation': { redirect(target) { throw Object.assign(new Error('REDIRECT'), { target }) }, notFound() { assert.fail('must authenticate first') } },
    '@/lib/supabase/require-admin': { requireAdmin: async () => { checks++; return { ok: false, status } } },
  })
  const Page = compile(file, dependencies).default
  await assert.rejects(Page({ params: Promise.resolve({ id: '17' }), searchParams: Promise.resolve({}) }), error => error.message === 'REDIRECT' && error.target === (status === 401 ? '/login' : '/videos'))
  assert.equal(checks, 1)
})

test('common menu remains display only and reuses responsive CSS and design variables', () => {
  const source = fs.readFileSync('app/(app)/admin/admin-navigation.tsx', 'utf8')
  assert.doesNotMatch(source, /getUser|requireAdmin|createClient|fetch\(|process\.env/)
  const css = fs.readFileSync('app/(app)/admin/event-groups/admin-index.module.css', 'utf8')
  assert.match(css, /\.nav\s*\{[^}]*flex-wrap:\s*wrap/s)
  assert.match(css, /\.adminNav a\s*\{[^}]*min-height:\s*44px/s)
  assert.match(css, /\.adminNav a:focus-visible/)
  assert.match(css, /var\(--hub-gutter-mobile\)/)
  assert.match(css, /var\(--hub-gutter-pc\)/)
})
