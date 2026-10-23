import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'

const row = { id: 11, title: '午前クラス', date: '2026-11-01', start_time: '10:00', end_time: '12:00', location: '合成会場', capacity: 10, registeredCount: 2, registration_enabled: true }
const page = (schedules = [row], extra = {}) => ({ schedules, page: 1, pageSize: 50, total: schedules.length, ...extra })
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.props?.children)]
}
function setup({ body = page(), status = 200, throws = false, pending = false, initiallyExpanded = false, hideEndTime = false } = {}) {
  const slots = [], effects = [], calls = []
  let cursor = 0, payload = body, httpStatus = status, release, refreshToken = 0
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value }] },
    useEffect(fn, deps) {
      const i = cursor++, old = slots[i]
      if (!old || deps.some((value, j) => value !== old.deps[j])) {
        const effect = { deps, fn, cleanup: old?.cleanup }; slots[i] = effect; effects.push(effect)
      }
    },
  }
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/(app)/admin/event-groups/group-classes.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, AbortController,
    require(name) { if (name === 'react') return react; assert.equal(name, 'react/jsx-runtime'); return jsxRuntime },
    fetch: async (url, options) => {
      calls.push({ url, options }); if (throws) throw new Error('PRIVATE_DETAIL')
      if (pending) return new Promise(resolve => { release = resolve })
      return { ok: httpStatus === 200, status: httpStatus, json: async () => payload }
    },
  })
  const render = () => { cursor = 0; return elements(exports.default({ groupId: 7, refreshToken, initiallyExpanded, hideEndTime })) }
  const button = text => render().find(item => item.type === 'button' && item.props.children === text)
  return { calls, render, button, refresh: () => { refreshToken += 1 }, change: (value, nextStatus = 200) => { payload = value; httpStatus = nextStatus },
    text: () => render().filter(item => item.type === 'p' || item.type === 'h3').map(item => JSON.stringify(item.props.children)).join(' '),
    async flush() { render(); for (const effect of effects.splice(0)) { effect.cleanup?.(); effect.cleanup = effect.fn() } await new Promise(resolve => setImmediate(resolve)); render() },
    release: value => release({ ok: true, json: async () => value }),
  }
}
async function open(context) {
  await context.flush(); context.button('所属クラス一覧を表示').props.onClick(); await context.flush()
}

test('class list fetches only after expansion, shows metadata, and collapses accessibly', async () => {
  const c = setup(); await c.flush(); assert.equal(c.calls.length, 0)
  await open(c)
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0].url, '/api/admin/event-groups/7/classes?page=1')
  assert.equal(c.calls[0].options.cache, 'no-store'); assert.equal(c.calls[0].options.method, undefined)
  for (const text of ['午前クラス', '2026-11-01', '10:00', '12:00', '合成会場', '10名', '2', '有効']) assert.ok(c.text().includes(text))
  assert.equal(c.button('所属クラス一覧を閉じる').props['aria-expanded'], true)
  c.button('所属クラス一覧を閉じる').props.onClick(); await c.flush()
  assert.equal(c.render().some(item => item.type === 'section'), false)
  assert.equal(c.calls[0].options.signal.aborted, true)
})
test('zero classes are explicitly shown as unregistered', async () => {
  const c = setup({ body: page([]) }); await open(c)
  assert.match(c.text(), /クラス未登録/)
})
test('disabled class reception is independent from the group reception explanation', async () => {
  const c = setup({ body: page([{ ...row, registration_enabled: false, capacity: null, registeredCount: 0, location: '', start_time: null, end_time: null }]) }); await open(c)
  assert.match(c.text(), /クラス受付/); assert.match(c.text(), /無効/)
  assert.match(c.text(), /グループ全体が停止中/); assert.match(c.text(), /未設定/)
})
for (const status of [401, 403, 404, 500]) test(`HTTP ${status} never guesses class counts`, async () => {
  const c = setup({ status }); await open(c)
  assert.ok(c.render().some(item => item.props?.role === 'alert'))
  assert.equal(c.render().some(item => item.type === 'li'), false)
  assert.doesNotMatch(c.text(), /クラス未登録|PRIVATE_DETAIL/)
})
test('network errors are safe and a manual refresh can recover', async () => {
  const c = setup({ status: 500 }); await open(c)
  c.change(page()); c.button('所属クラスを再取得').props.onClick(); await c.flush()
  assert.equal(c.calls.length, 2); assert.match(c.text(), /午前クラス/)
  const broken = setup({ throws: true }); await open(broken)
  assert.ok(broken.render().some(item => item.props?.role === 'alert')); assert.doesNotMatch(broken.text(), /PRIVATE_DETAIL/)
})
test('invalid or unknown metadata never becomes a normal count or empty result', async () => {
  for (const body of [null, {}, page([{ ...row, registeredCount: null }]), page([{ ...row, registeredCount: -1 }]), page([{ ...row, registration_enabled: undefined }]), page([{ ...row, location: undefined }]), page([], { total: 1 }), page([row, row]), page([row], { page: 2 })]) {
    const c = setup({ body }); await open(c)
    assert.ok(c.render().some(item => item.props?.role === 'alert'))
    assert.equal(c.render().some(item => item.type === 'li'), false)
    assert.doesNotMatch(c.text(), /クラス未登録/)
  }
})
test('pagination exposes all classes without writing or fetching unrelated groups', async () => {
  const c = setup({ body: page([row], { pageSize: 1, total: 2 }) }); await open(c)
  c.change(page([{ ...row, id: 12, title: '午後クラス' }], { page: 2, pageSize: 1, total: 2 }))
  c.button('次のクラス').props.onClick(); await c.flush()
  assert.equal(c.calls[1].url, '/api/admin/event-groups/7/classes?page=2')
  assert.match(c.text(), /午後クラス/); assert.equal(c.button('次のクラス').props.disabled, true)
})
test('closing during loading ignores the stale response', async () => {
  const c = setup({ pending: true }); await open(c)
  c.button('所属クラス一覧を閉じる').props.onClick(); await c.flush()
  c.release(page()); await c.flush()
  assert.equal(c.render().some(item => item.type === 'li'), false)
  assert.equal(c.calls.length, 1)
})


test('parent refresh reloads an expanded list and defers collapsed list until expansion', async () => {
  const c = setup(); await open(c); assert.equal(c.calls.length, 1)
  c.refresh(); await c.flush(); assert.equal(c.calls.length, 2)
  c.button('所属クラス一覧を閉じる').props.onClick(); await c.flush()
  c.refresh(); await c.flush(); assert.equal(c.calls.length, 2)
  c.button('所属クラス一覧を表示').props.onClick(); await c.flush(); assert.equal(c.calls.length, 3)
})


test('success-remounted list automatically expands and fetches page one exactly once', async () => {
  const c = setup({ initiallyExpanded: true, body: page([{ ...row, title: '追加した予定' }]) })
  await c.flush()
  assert.equal(c.button('所属クラス一覧を閉じる').props['aria-expanded'], true)
  assert.equal(c.calls.length, 1)
  assert.equal(c.calls[0].url, '/api/admin/event-groups/7/classes?page=1')
  assert.match(c.text(), /追加した予定/)
})
test('post-save list failure is separately reported and only retries on explicit refresh', async () => {
  const c = setup({ initiallyExpanded: true, status: 500 }); await c.flush()
  assert.equal(c.calls.length, 1)
  assert.ok(c.render().some(item => item.props?.role === 'alert'))
  assert.doesNotMatch(c.text(), /保存に失敗|クラス未登録/)
  c.render(); await Promise.resolve(); assert.equal(c.calls.length, 1)
  c.change(page()); c.button('所属クラスを再取得').props.onClick(); await c.flush()
  assert.equal(c.calls.length, 2); assert.match(c.text(), /午前クラス/)
})


test('class reception is display-only and list controls cannot call a reception update', async () => {
  const c = setup({ body: page([{ ...row, registration_enabled: false }]) })
  await open(c)
  assert.ok(c.text().includes('無効'))
  assert.equal(c.render().some(item => item.type === 'button' && /受付停止|受付開始/.test(String(item.props.children))), false)
  c.button('所属クラスを再取得').props.onClick(); await c.flush()
  c.button('所属クラス一覧を閉じる').props.onClick(); await c.flush()
  assert.ok(c.calls.length >= 2)
  assert.ok(c.calls.every(call => call.url.startsWith('/api/admin/event-groups/7/classes?') && (call.options.method ?? 'GET') === 'GET'))
})

test('venue display uses the API location verbatim and empty location only shows unset', async () => {
  for (const venue of ['【検証用】テスト会場', '登録済みの講習会グループ', '']) {
    const c = setup({ body: page([{ ...row, location: venue }]) }); await open(c)
    const line = c.render().find(item => item.type === 'p' && Array.isArray(item.props.children) && item.props.children[0] === '会場：')
    assert.ok(line)
    assert.equal(line.props.children[1], venue || '未設定')
  }
})


test('expanded class list explains where class reception can be edited', async () => {
  const c = setup(); await open(c)
  assert.ok(c.text().includes('クラスごとの受付設定は、管理画面の『予定 → 編集』から変更できます。'))
})


test('occurrence class view shows start, capacity, bookings and seats but not end time', async () => {
  const c = setup({ hideEndTime: true }); await open(c)
  assert.ok(c.text().includes('10:00')); assert.equal(c.text().includes('12:00'), false)
  assert.ok(c.text().includes('残席：')); assert.ok(c.text().includes('8名'))
})
