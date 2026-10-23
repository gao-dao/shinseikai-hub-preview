import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const origin = 'https://preview.example.invalid'
const secret = 'synthetic-private-token'
const defaults = { ADMIN_LOGIN_EMAIL: 'admin@example.invalid', MEMBER_SHARED_EMAIL: 'member@example.invalid', NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.invalid', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public' }
function compile(file, dependencies, env) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, URL, TextDecoder, Uint8Array, process: { env: new Proxy(env, { get(target, key) {
    assert.ok(Object.hasOwn(defaults, key), 'No privileged/environment fallback is permitted')
    return target[key]
  } }) }, require(name) { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`); return dependencies[name] } })
  return exports
}
function setup(options = {}) {
  const writes = [], calls = []
  const env = { ...defaults, ...options.env }
  let user
  const json = (body, init = {}) => {
    const local = []
    return { body, status: init.status ?? 200, headers: init.headers, written: local, cookies: { set(name, value, settings) {
      if (options.cookieFailure && local.length === 1) throw new Error(secret)
      local.push({ name, value, settings }); writes.push(name)
    } } }
  }
  const api = compile('app/api/auth/login/route.ts', {
    'next/server': { NextResponse: { json } },
    'next/headers': { cookies: async () => ({ getAll: () => [{ name: 'old-session', value: 'old' }], set() { assert.fail('Never write ambient cookie store') } }) },
    '@supabase/ssr': { createServerClient(url, key, config) {
      calls.push('client'); assert.equal(url, defaults.NEXT_PUBLIC_SUPABASE_URL); assert.equal(key, defaults.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
      assert.equal(config.cookies.getAll()[0].name, 'old-session')
      return {
        auth: {
          async signInWithPassword(input) {
            calls.push('signin'); user = { id: 'synthetic-id', email: input.email }
            assert.equal(input.password, options.password ?? ' synthetic password ')
            if (options.throws) throw new Error(secret)
            if (!options.noCookies) config.cookies.setAll([
              { name: 'sb-session.0', value: secret, options: { path: '/', sameSite: 'lax' } },
              { name: 'sb-session.1', value: secret, options: { path: '/', maxAge: 123 } },
            ])
            return { data: { user, session: options.noSession ? null : { access_token: secret } }, error: options.authError ? { message: secret, status: options.authError } : null }
          },
          async getUser() { calls.push('verify'); return { data: { user: options.badIdentity ? { ...user, email: 'other@example.invalid' } : user }, error: options.verifyError ? { message: secret } : null } },
        },
        from(table) {
          calls.push('profile'); assert.equal(table, 'profiles')
          return { select(columns) { assert.equal(columns, 'role'); return this }, eq(field, id) { assert.equal(field, 'id'); assert.equal(id, user.id); return this }, async maybeSingle() {
            return { data: Object.hasOwn(options, 'profile') ? options.profile : { role: user.email === defaults.ADMIN_LOGIN_EMAIL ? 'admin' : 'member' }, error: options.profileError ? { message: secret } : null }
          } }
        },
      }
    } },
  }, env)
  return { calls, writes, async post(body = { role: 'admin', password: ' synthetic password ' }, headers = {}, raw = false) {
    return api.POST(new Request(`${origin}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: raw ? body : JSON.stringify(body) }))
  } }
}
function safeFailure(response, status) {
  assert.equal(response.status, status)
  assert.equal(response.written.length, 0)
  assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0')
  assert.equal(JSON.stringify(response.body).includes(secret), false)
  assert.equal('email' in response.body, false)
}
for (const role of ['member', 'admin']) test(`server password login issues standard cookies only after role verification: ${role}`, async () => {
  const c = setup(), response = await c.post({ role, password: ' synthetic password ' })
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(response.body)), { success: true })
  assert.deepEqual(c.calls, ['client', 'signin', 'verify', 'profile'])
  assert.equal(response.written.length, 2)
  for (const cookie of response.written) {
    assert.equal(cookie.settings.secure, true); assert.equal(cookie.settings.sameSite, 'lax'); assert.equal(cookie.settings.domain, undefined)
  }
  assert.equal(response.written[1].settings.maxAge, 123)
})
test('shared member without profile remains compatible', async () => {
  const c = setup({ profile: null }); assert.equal((await c.post({ role: 'member', password: ' synthetic password ' })).status, 200)
})
for (const role of ['admin', 'member']) for (const field of [role === 'admin' ? 'ADMIN_LOGIN_EMAIL' : 'MEMBER_SHARED_EMAIL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']) {
  test(`missing ${field} fails closed for ${role}`, async () => {
    const c = setup({ env: { [field]: '' } }); safeFailure(await c.post({ role, password: ' synthetic password ' }), 503); assert.equal(c.calls.length, 0)
  })
}
test('same admin and member identities are rejected', async () => {
  const c = setup({ env: { MEMBER_SHARED_EMAIL: defaults.ADMIN_LOGIN_EMAIL } }); safeFailure(await c.post(), 503)
})
for (const [options, status] of [
  [{ authError: 400 }, 401], [{ authError: 503 }, 503], [{ authError: 429 }, 429], [{ profile: null }, 401], [{ profile: { role: 'member' } }, 401],
  [{ profile: { role: 'Admin' } }, 401], [{ profileError: true }, 401], [{ verifyError: true }, 401], [{ badIdentity: true }, 401],
  [{ noSession: true }, 401], [{ noCookies: true }, 503], [{ cookieFailure: true }, 503], [{ throws: true }, 503],
]) test(`failure emits no cookies or private response: ${JSON.stringify(options)}`, async () => {
  safeFailure(await setup(options).post(), status)
})
test('member cannot receive an admin profile session', async () => {
  safeFailure(await setup({ profile: { role: 'admin' } }).post({ role: 'member', password: ' synthetic password ' }), 401)
})
for (const headers of [{ Origin: '' }, { Origin: 'null' }, { Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) test(`CSRF rejection: ${JSON.stringify(headers)}`, async () => {
  const c = setup(); safeFailure(await c.post(undefined, headers), 403); assert.equal(c.calls.length, 0)
})
for (const body of [null, [], {}, { role: 'Admin', password: 'x' }, { role: 'admin', password: '' }, { role: 'admin', password: 1 }, { role: 'admin', password: 'x', email: 'other@example.invalid' }]) test(`invalid login body: ${JSON.stringify(body)}`, async () => {
  const c = setup(); safeFailure(await c.post(body), 400); assert.equal(c.calls.length, 0)
})
test('content type, malformed JSON and streamed size limit fail before auth', async () => {
  const c = setup()
  safeFailure(await c.post(undefined, { 'Content-Type': 'text/plain' }), 415)
  safeFailure(await c.post('{', {}, true), 400)
  safeFailure(await c.post('x'.repeat(8193), {}, true), 400)
  safeFailure(await c.post(undefined, { 'Content-Length': '99999' }), 400)
  assert.equal(c.calls.length, 0)
})
test('wrong password and wrong role have indistinguishable bodies', async () => {
  const a = await setup({ authError: 400 }).post(), b = await setup({ profile: { role: 'member' } }).post()
  assert.equal(JSON.stringify(a.body), JSON.stringify(b.body))
})

for (const mode of ['refresh', 'logout', 'failure']) test(`session proxy forwards only standard cookie changes: ${mode}`, async () => {
  const jar = new Map([['sb-session.0', 'old']])
  let requests = 0
  const next = () => ({ written: [], headers: new Headers(), cookies: { set(name, value) { this.owner.written.push({ name, value }) } } })
  const proxyModule = compile('proxy.ts', {
    'next/server': { NextResponse: { next({ request }) { const r = next(); r.cookies.owner = r; r.forwarded = request.cookies.getAll(); return r } } },
    '@supabase/ssr': { createServerClient(url, key, options) {
      assert.equal(key, defaults.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
      return { auth: { async getUser() {
        requests++
        if (mode === 'failure') throw new Error(secret)
        options.cookies.setAll([{ name: 'sb-session.0', value: mode === 'logout' ? '' : 'refreshed', options: {} }])
      } } }
    } },
  }, defaults)
  const request = { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), set: (name, value) => jar.set(name, value) }, nextUrl: { protocol: 'https:' } }
  const response = await proxyModule.proxy(request)
  assert.equal(requests, 1)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0')
  assert.equal(response.written.length, mode === 'failure' ? 0 : 1)
  if (mode !== 'failure') assert.equal(response.forwarded[0].value, mode === 'logout' ? '' : 'refreshed')
})


test('real Supabase SSR cookies work with browser client, refresh, server verification and local logout using mock transport', async () => {
  const { createServerClient, createBrowserClient } = await import('@supabase/ssr')
  const now = Math.floor(Date.now() / 1000)
  const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: defaults.ADMIN_LOGIN_EMAIL, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
  const token = suffix => [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, iat: now, exp: now + 3600, marker: suffix })).toString('base64url'), 'synthetic-signature'].join('.')
  const jar = new Map()
  const methods = {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: values => { for (const { name, value } of values) { if (value) jar.set(name, value); else jar.delete(name) } },
  }
  let refreshed = 0, loggedOut = 0
  const transport = async (input, options) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://db.example.invalid')
    if (url.pathname === '/auth/v1/token') {
      const body = JSON.parse(options.body)
      if (url.searchParams.get('grant_type') === 'password') {
        assert.equal(body.email, defaults.ADMIN_LOGIN_EMAIL)
        assert.equal(body.password, ' synthetic password ')
      } else {
        assert.equal(url.searchParams.get('grant_type'), 'refresh_token'); refreshed++
      }
      return new Response(JSON.stringify({ access_token: token(refreshed), refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600, user }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.pathname === '/auth/v1/user') return new Response(JSON.stringify(user), { headers: { 'Content-Type': 'application/json' } })
    if (url.pathname === '/rest/v1/profiles') return new Response(JSON.stringify({ role: 'admin' }), { headers: { 'Content-Type': 'application/json' } })
    if (url.pathname === '/auth/v1/logout') { loggedOut++; return new Response(null, { status: 204 }) }
    assert.fail('Unexpected network destination')
  }
  const route = compile('app/api/auth/login/route.ts', {
    '@supabase/ssr': { createServerClient: (url, key, options) => createServerClient(url, key, { ...options, global: { fetch: transport } }) },
    'next/headers': { cookies: async () => ({ getAll: methods.getAll }) },
    'next/server': { NextResponse: { json(body, init = {}) {
      const written = []
      return { body, status: init.status ?? 200, written, cookies: { set(name, value, options) { written.push({ name, value, options }) } } }
    } } },
  }, defaults)
  const result = await route.POST(new Request(`${origin}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin', password: ' synthetic password ' }) }))
  assert.equal(result.status, 200)
  assert.ok(result.written.some(cookie => cookie.value))
  methods.setAll(result.written)
  const browser = createBrowserClient(defaults.NEXT_PUBLIC_SUPABASE_URL, defaults.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { isSingleton: false, cookies: methods, auth: { autoRefreshToken: false }, global: { fetch: transport } })
  assert.equal((await browser.auth.getSession()).data.session.user.id, user.id)
  assert.equal((await browser.auth.refreshSession()).error, null)
  assert.equal(refreshed, 1)
  const server = createServerClient(defaults.NEXT_PUBLIC_SUPABASE_URL, defaults.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { cookies: methods, global: { fetch: transport } })
  const helper = compile('lib/supabase/require-admin.ts', { './server': { createClient: async () => server } }, {})
  assert.equal((await helper.requireAdmin()).ok, true)
  assert.equal((await browser.auth.signOut({ scope: 'local' })).error, null)
  assert.equal(loggedOut, 1)
  assert.equal((await browser.auth.getSession()).data.session, null)
  const after = createServerClient(defaults.NEXT_PUBLIC_SUPABASE_URL, defaults.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { cookies: methods, global: { fetch: transport } })
  const denied = compile('lib/supabase/require-admin.ts', { './server': { createClient: async () => after } }, {})
  assert.equal((await denied.requireAdmin()).status, 401)
})
