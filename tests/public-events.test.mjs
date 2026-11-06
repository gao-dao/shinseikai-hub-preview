import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'

function compile(path, dependencies = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, URL, ...globals, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}
const availability = compile('lib/registrations/public-availability.ts')
const display = compile('lib/registrations/public-class-display.ts')
function schedule(id = 1, changes = {}) { return { id, title: `クラス${id}`, date: '2026-10-20', start_time: '10:00', end_time: '11:00', capacity: 10, registration_enabled: true, event_group_id: 1, ...changes } }
function seats(schedule_id = 1, changes = {}) { return { schedule_id, capacity: 10, registered_count: 2, remaining_capacity: 8, is_full: false, ...changes } }

// Only a mock anonymous client is exposed. No env files, real network or DB.
function setup({ groups = [{ id: 1, title: '講習会', description: '説明', registration_open: true }], schedules = [schedule()], counts = [seats()], groupError = null, classError = null, rpcError = null, rpcThrows = false, missingCount = false } = {}) {
  groups = groups.map(row => ({ is_cancelled: false, is_hidden: false, ...row }))
  const calls = []
  const dependencies = {
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/registrations/public-availability': availability,
    '@/lib/supabase/anonymous': { createAnonymousClient: () => {
      calls.push(['anonymous'])
      return {
        from: table => {
          assert.ok(['event_groups', 'schedules'].includes(table), 'Applicant tables must never be queried')
          calls.push(['from', table])
          const filters = []
          let range
          const query = {}
          const result = () => {
            const rows = (table === 'event_groups' ? groups : schedules).filter(row => filters.every(([key, value]) => row[key] === value))
            return { data: range ? rows.slice(range[0], range[1] + 1) : rows, error: table === 'event_groups' ? groupError : classError, count: missingCount ? null : rows.length }
          }
          for (const method of ['select', 'eq', 'order', 'range', 'maybeSingle']) query[method] = (...args) => {
            calls.push([method, ...args])
            if (method === 'eq') filters.push(args)
            if (method === 'range') range = args
            if (method === 'maybeSingle') { const response = result(); return Promise.resolve({ ...response, data: response.data[0] ?? null }) }
            return query
          }
          query.then = (resolve, reject) => Promise.resolve(result()).then(resolve, reject)
          return query
        },
        rpc: (name, params) => {
          assert.equal(name, 'get_event_group_availability')
          calls.push(['rpc', name, params])
          return { in: async (key, ids) => {
            calls.push(['rpc-filter', key, ids])
            if (rpcThrows) throw new Error('sensitive detail')
            return { data: counts.filter(item => ids.includes(item.schedule_id)), error: rpcError }
          } }
        },
      }
    } },
  }
  const list = compile('app/api/event-groups/route.ts', dependencies)
  const classes = compile('app/api/event-groups/[id]/classes/route.ts', dependencies)
  return { calls,
    list: (page = '1') => list.GET(new Request(`http://localhost/api/event-groups?page=${page}`)),
    classes: (page = '1', id = '1') => classes.GET(new Request(`http://localhost/api/event-groups/${id}/classes?page=${page}`), { params: Promise.resolve({ id }) }),
  }
}
function noCache(response) { assert.match(response.headers['Cache-Control'], /no-store/) }

test('anonymous client uses only publishable configuration, no persisted session, and uncached fetch', async () => {
  let argumentsUsed, fetchOptions
  const { createAnonymousClient } = compile('lib/supabase/anonymous.ts', {
    'server-only': {}, '@supabase/supabase-js': { createClient: (...args) => { argumentsUsed = args; return {} } },
  }, {
    process: { env: new Proxy({}, { get: (_, key) => {
      assert.ok(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'].includes(key))
      return key === 'NEXT_PUBLIC_SUPABASE_URL' ? 'http://localhost:54321' : 'test-publishable'
    } }) },
    fetch: async (_input, options) => { fetchOptions = options; return {} },
  })
  createAnonymousClient()
  assert.equal(argumentsUsed[1], 'test-publishable')
  assert.equal(argumentsUsed[2].auth.persistSession, false)
  assert.equal(argumentsUsed[2].auth.autoRefreshToken, false)
  assert.equal(argumentsUsed[2].auth.detectSessionInUrl, false)
  assert.equal(argumentsUsed[2].global.headers, undefined)
  await argumentsUsed[2].global.fetch('http://localhost', { cache: 'force-cache' })
  assert.equal(fetchOptions.cache, 'no-store')
})

test('public list excludes stopped groups and whitelists metadata only', async () => {
  const context = setup({ groups: [
    { id: 1, title: '公開', description: '説明', registration_open: true, name: 'private', contact: 'private', notes: 'private' },
    { id: 2, title: '停止', description: null, registration_open: false },
  ] })
  const response = await context.list()
  assert.equal(response.status, 200)
  assert.equal(response.body.total, 1)
  assert.equal(response.body.eventGroups[0].title, '公開')
  assert.equal(response.body.eventGroups.length, 1)
  assert.doesNotMatch(JSON.stringify(response.body), /private|contact|notes|registration_items/)
  assert.deepEqual(context.calls.find(call => call[0] === 'select').slice(0, 2), ['select', 'id, title, description'])
  noCache(response)
})

test('group pagination includes records beyond fifty and supports empty results', async () => {
  const groups = Array.from({ length: 53 }, (_, i) => ({ id: i + 1, title: `講習会${i + 1}`, description: null, registration_open: true }))
  const context = setup({ groups })
  const first = await context.list('1'), second = await context.list('2')
  assert.equal(first.body.eventGroups.length, 50)
  assert.equal(second.body.eventGroups.length, 3)
  assert.equal(second.body.eventGroups[0].id, 51)
  assert.equal(second.body.total, 53)
  assert.equal((await setup({ groups: [] }).list()).body.total, 0)
})

test('stopped and nonexistent groups cannot expose classes or invoke availability RPC', async () => {
  for (const groups of [[], [{ id: 1, registration_open: false }]]) {
    const context = setup({ groups })
    const response = await context.classes()
    assert.equal(response.status, 404)
    assert.equal(context.calls.some(call => call[0] === 'rpc'), false)
    assert.equal(context.calls.some(call => call[0] === 'from' && call[1] === 'schedules'), false)
    noCache(response)
  }
})

test('class metadata and safe RPC provide seats without applicant reads or extra row fields', async () => {
  const context = setup({ schedules: [schedule(1, { name: 'private', notes: 'private', contact: 'private' }), schedule(2, { event_group_id: 2 })] })
  const response = await context.classes()
  assert.equal(response.status, 200)
  assert.equal(response.body.schedules.length, 1)
  const item = response.body.schedules[0]
  assert.equal(item.remainingCapacity, 8)
  assert.equal(item.capacity, 10)
  assert.equal(item.canRegister, true)
  assert.equal(item.status, '受付可能')
  assert.doesNotMatch(JSON.stringify(response.body), /private|contact|notes|registration_items/)
  assert.equal(context.calls.filter(call => call[0] === 'rpc').length, 1)
  assert.equal(context.calls.find(call => call[0] === 'rpc')[2].p_event_group_id, 1)
  assert.deepEqual(context.calls.find(call => call[0] === 'rpc-filter').slice(0, 2), ['rpc-filter', 'schedule_id'])
  noCache(response)
})

test('class pages and RPC filters handle groups exceeding fifty and default RPC row limits', async () => {
  const context = setup({ schedules: Array.from({ length: 1005 }, (_, i) => schedule(i + 1)), counts: Array.from({ length: 1005 }, (_, i) => seats(i + 1)) })
  const response = await context.classes('21')
  assert.equal(response.body.total, 1005)
  assert.equal(response.body.schedules.length, 5)
  assert.equal(response.body.schedules[0].id, 1001)
  assert.ok(response.body.schedules.every(item => item.remainingCapacity === 8))
  assert.equal(context.calls.find(call => call[0] === 'rpc-filter')[2].length, 5)
  const empty = setup({ schedules: [] })
  assert.equal((await empty.classes()).body.schedules.length, 0)
  assert.equal(empty.calls.some(call => call[0] === 'rpc'), false)
})

test('disabled classes, no capacity and full classes never indicate acceptance', async () => {
  const context = setup({ schedules: [schedule(1, { registration_enabled: false }), schedule(2, { capacity: null }), schedule(3)], counts: [seats(1), seats(3, { registered_count: 10, remaining_capacity: 0, is_full: true })] })
  const response = await context.classes()
  assert.deepEqual(Array.from(response.body.schedules, item => item.status), ['クラス受付停止中', '定員未設定', '満員'])
  assert.ok(response.body.schedules.every(item => !item.canRegister))
})

test('availability errors, exceptions, missing or inconsistent counts fail closed', async () => {
  for (const options of [{ rpcError: { message: 'sensitive detail' } }, { rpcThrows: true }, { counts: [] }, { counts: [seats(1, { remaining_capacity: 9 })] }, { counts: [seats(1, { registered_count: null })] }, { counts: [seats(1, { capacity: 20 })] }, { counts: [seats(), seats()] }]) {
    const response = await setup(options).classes()
    assert.equal(response.status, 200)
    assert.equal(response.body.schedules[0].canRegister, false)
    assert.equal(response.body.schedules[0].remainingCapacity, null)
    assert.equal(response.body.schedules[0].status, '残席確認不可')
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    noCache(response)
  }
})

test('invalid query parameters are rejected before creating any client', async () => {
  for (const value of ['0', '-1', 'abc', '1.2', '', '1000001']) {
    const context = setup()
    assert.equal((await context.list(value)).status, 400)
    assert.equal((await context.classes(value)).status, 400)
    assert.equal(context.calls.length, 0)
  }
  const context = setup()
  assert.equal((await context.classes('1', '9007199254740992')).status, 400)
  assert.equal(context.calls.length, 0)
})

test('database errors and missing totals return safe uncached failures', async () => {
  for (const options of [{ groupError: { message: 'sensitive detail' } }, { missingCount: true }]) {
    for (const method of ['list', 'classes']) {
      const response = await setup(options)[method]()
      assert.equal(response.status, 500)
      assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
      noCache(response)
    }
  }
  const response = await setup({ classError: { message: 'sensitive detail' } }).classes()
  assert.equal(response.status, 500)
  assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
})

test('no date deadline or class type restrictions are introduced', async () => {
  const context = setup({ schedules: [schedule(1, { date: '2000-01-01', type: '稽古会' })] })
  const response = await context.classes()
  assert.equal(response.body.schedules[0].canRegister, true)
  assert.equal(response.body.schedules[0].date, '2000-01-01')
  assert.ok(context.calls.filter(call => call[0] === 'eq').every(call => !['date', 'type'].includes(call[1])))
})

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.props?.children)]
}
function ui() {
  const state = [], effects = [], calls = []
  let index = 0
  const react = { useState(initial) {
    const slot = index++
    if (!(slot in state)) state[slot] = initial
    return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
  }, useRef(initial) { const slot = index++; if (!(slot in state)) state[slot] = { current: initial }; return state[slot] }, useEffect(fn) { effects.push(fn) } }
  let response = { ok: true, json: async () => ({ eventGroups: [], page: 1, pageSize: 50, total: 0 }) }
  const exports = compile('app/(public)/events/events-list.tsx', { react, '@/lib/registrations/public-class-display': display, 'react/jsx-runtime': jsxRuntime, 'next/link': { default: () => null }, './registration-form': { default: () => null } }, {
    AbortController, fetch: async (...args) => { calls.push(args); return response },
  })
  const render = (Component = exports.default, props = {}) => { index = 0; effects.length = 0; return elements(Component(props)) }
  return { state, effects, calls, exports, render, setResponse(value) { response = value } }
}

test('legacy list URL redirects to guide without querying groups or rendering registration', async () => {
  const page = compile('app/(public)/events/page.tsx', {
    'react/jsx-runtime': jsxRuntime, './events-list': { default: () => assert.fail('must not render') },
    'next/link': { default: () => null }, 'next/navigation': { redirect(path) { throw Object.assign(new Error('REDIRECT'), { path }) } },
    '@/lib/event-groups/public-guide-server': { loadGuidePage() { assert.fail('must not query') }, loadGuideDetail() { assert.fail('must not query') } },
    '@/lib/event-groups/public-guide': {}, './type-labels': { default: () => null }, './guide.module.css': { default: {} },
  })
  for (const params of [{ view: 'registration' }, { view: 'registration', page: '2' }]) {
    await assert.rejects(page.default({ searchParams: Promise.resolve(params) }), e => e.message === 'REDIRECT' && e.path === '/events')
  }
})

for(const flags of [{is_hidden:true},{is_cancelled:true},{is_cancelled:true,is_hidden:true}])test(`public list and direct class URL reject lifecycle flags ${JSON.stringify(flags)}`,async()=>{
 const c=setup({groups:[{id:1,title:'Blocked',description:null,registration_open:true,...flags}]});const result=await c.list();assert.equal(result.body.total,0);assert.equal((await c.classes()).status,404);assert.equal(c.calls.filter(v=>v[0]==='rpc').length,0)
})

for (const [name, enabled, registered, missing, label, selectable] of [
  ['open',true,2,false,'受付可能',true],
  ['stopped with seats',false,2,false,'受付停止中',false],
  ['stopped with zero seats',false,10,false,'受付停止中',false],
  ['open with zero seats',true,10,false,'満員',false],
  ['availability failed',true,0,true,'申込状況を確認できません',false],
  ['stopped despite availability failure',false,0,true,'受付停止中',false],
]) test(`public card presentation preserves eligibility and hides counts: ${name}`,()=>{
 const source=schedule(1,{registration_enabled:enabled})
 const item=availability.publicClassAvailability(source,missing?undefined:{capacity:10,registered_count:registered,remaining_capacity:Math.max(10-registered,0),is_full:registered>=10})
 const before=JSON.stringify(item)
 const labelText=display.publicClassLabel(item)
 assert.ok(labelText.includes(label));assert.doesNotMatch(labelText,/定員|残席|残り[0-9]/)
 assert.doesNotMatch(labelText,/満席/)
 assert.equal(item.canRegister,selectable);assert.equal(JSON.stringify(item),before);assert.equal(source.registration_enabled,enabled)
})

test('server-validated target opens immediately and retains its focus and scroll target',()=>{
 const c=ui(),initialGroup={id:501,title:'対象開催回',description:null},props={initialGroup}
 const render=()=>c.render(c.exports.default,props)
 let tree=render(),form=tree.find(n=>n.props?.group?.id===501);assert.ok(form)
 const start=tree.find(n=>n.props?.['aria-label']==='対象開催回の参加申込'),movement=[]
 start.props.ref.current={focus:o=>movement.push(['focus',o]),scrollIntoView:o=>movement.push(['scroll',o])};c.effects[0]()
 assert.equal(JSON.stringify(movement),JSON.stringify([['focus',{preventScroll:true}],['scroll',{behavior:'instant',block:'start'}]]))
 assert.equal(form.props.onClose,undefined);assert.equal(render().some(n=>n.props?.group?.id===501),true)
})

test('targeted registration omits unrelated groups, list refresh and pagination, without fetching the list',async()=>{
 const c=ui(),initialGroup={id:501,title:'対象開催回',description:null},props={initialGroup}
 c.render(c.exports.default,props)
 c.effects[0]();await new Promise(resolve=>setImmediate(resolve))
 let tree=c.render(c.exports.default,props)
 assert.equal(c.calls.length,0)
 assert.ok(tree.some(n=>n.props?.group?.id===501))
 assert.equal(tree.some(n=>n.type==='article'),false)
 assert.equal(tree.some(n=>n.props?.children==='講習会一覧を更新'),false)
 assert.equal(tree.some(n=>n.props?.['aria-label']==='講習会のページ切替'),false)
 assert.equal(tree.some(n=>n.props?.children==='別の講習会を探す'),false)
 assert.equal(tree.some(n=>n.props?.href==='/events?view=registration'),false)
 assert.equal(tree.some(n=>n.props?.children==='申込フォームを開く'),false)
 assert.equal(tree.some(n=>n.type==='p'&&String(n.props?.children).includes('申込フォームを閉じました')),false)
 assert.ok(tree.some(n=>n.props?.href==='/events'&&n.props.children==='開催案内へ'))
 assert.equal(c.calls.length,0)
})
test('retired list rendering, class cards and list fetch are absent from the form host', () => {
 const source=fs.readFileSync('app/(public)/events/events-list.tsx','utf8')
 assert.doesNotMatch(source,/公開講習会|講習会一覧を更新|次の講習会|function EventClasses|function PublicClassCard|fetch\(/)
})


test('public labels explain every existing API status without changing eligibility or counts',()=>{
 for (const [source,count,expected] of [
  [schedule(),seats(),'受付可能'],
  [schedule(1,{registration_enabled:false}),seats(),'受付停止中'],
  [schedule(),seats(1,{registered_count:10,remaining_capacity:0,is_full:true}),'満員'],
  [schedule(1,{capacity:null}),undefined,'現在受付できません'],
  [schedule(),undefined,'申込状況を確認できません'],
 ]) {
  const item=availability.publicClassAvailability(source,count),before=JSON.stringify(item)
  assert.equal(display.publicClassLabel(item),expected)
  assert.equal(JSON.stringify(item),before)
 }
})
