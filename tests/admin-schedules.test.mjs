import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

function compile(path, dependencies) {
  const source = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = {}
  vm.runInNewContext(source, { exports, URL, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}

function row(overrides = {}) {
  return {
    id: 1, title: '予定', date: '2026-10-20', start_time: null, end_time: null,
    location: '道場', type: '稽古会', event_group_id: null, event_groups: null,
    capacity: null, registration_enabled: false,
    history_items: [{ count: 0 }], active_items: [{ count: 0 }], ...overrides,
  }
}

// Only mock clients are available: tests never load env files or connect to DB.
function setup({ authorization = { ok: true }, result = { data: [], count: 0, error: null }, throws = false } = {}) {
  const calls = []
  const query = {}
  for (const method of ['select', 'eq', 'order', 'range']) {
    query[method] = (...args) => {
      calls.push([method, ...args])
      return method === 'range' ? Promise.resolve(result) : query
    }
  }
  const route = compile('app/api/admin/schedules/route.ts', {
    '@/lib/schedules/new-schedule': compile('lib/schedules/new-schedule.ts', {}),
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) } },
    '@/lib/supabase/require-admin': { requireAdmin: async () => {
      calls.push(['authorize'])
      if (throws) throw new Error('sensitive detail')
      return authorization
    } },
    '@/lib/supabase/server': { createClient: async () => {
      calls.push(['client'])
      return { from: table => { calls.push(['from', table]); return query } }
    } },
  })
  return { calls, get: (page = '1') => route.GET({ url: `http://localhost/api/admin/schedules?page=${page}` }) }
}

function noCache(response) {
  assert.match(response.headers['Cache-Control'], /private.*no-store/)
  assert.equal(response.headers.Vary, 'Cookie')
}

for (const status of [401, 403]) {
  test(`GET rejects ${status} before data access`, async () => {
    const context = setup({ authorization: { ok: false, status, error: 'denied' } })
    const response = await context.get()
    assert.equal(response.status, status)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(response)
  })
}

test('GET preserves ungrouped schedules, active and cancelled history and counts above row limits', async () => {
  const context = setup({ result: { data: [
    row(),
    row({ id: 2, event_group_id: 5, event_groups: { id: 5, title: '講習会' }, capacity: 2000, registration_enabled: true, history_items: [{ count: 1600 }], active_items: [{ count: 1200 }] }),
    row({ id: 3, history_items: [{ count: 2 }], active_items: [{ count: 0 }] }),
  ], count: 53, error: null } })
  const response = await context.get('2')
  assert.equal(response.status, 200)
  const schedules = response.body.schedules
  assert.equal(schedules[0].event_group_id, null)
  assert.equal(schedules[0].hasRegistrationHistory, false)
  assert.equal(schedules[1].event_groups.title, '講習会')
  assert.equal(schedules[1].capacity, 2000)
  assert.equal(schedules[1].registration_enabled, true)
  assert.equal(schedules[1].activeRegistrationCount, 1200)
  assert.equal(schedules[2].hasRegistrationHistory, true)
  assert.equal(schedules[2].activeRegistrationCount, 0)
  assert.equal('history_items' in schedules[0], false)
  assert.equal(response.body.total, 53)
  assert.deepEqual(context.calls.find(call => call[0] === 'range'), ['range', 50, 99])
  assert.deepEqual(context.calls.find(call => call[0] === 'eq'), ['eq', 'active_items.status', 'active'])
  const select = context.calls.find(call => call[0] === 'select')[1]
  assert.match(select, /history_items:registration_items!registration_items_schedule_group_fkey\(count\)/)
  assert.match(select, /active_items:registration_items!registration_items_schedule_group_fkey\(count\)/)
  assert.doesNotMatch(select, /!inner|contact|notes|\*|\bname\b/)
  noCache(response)
})

test('empty schedules is valid; bad page is rejected without data access', async () => {
  const response = await setup().get()
  assert.equal(response.body.schedules.length, 0)
  for (const page of ['0', '-1', '1.2', '', 'abc', '1000001']) {
    const context = setup()
    const invalid = await context.get(page)
    assert.equal(invalid.status, 400)
    assert.deepEqual(context.calls, [['authorize']])
    noCache(invalid)
  }
})

test('missing or invalid counts never become no-history success', async () => {
  for (const changes of [
    { history_items: [] }, { history_items: null }, { active_items: [] },
    { active_items: [{ count: null }] }, { active_items: [{ count: -1 }] },
    { active_items: [{ count: 1 }] }, { history_items: [{ count: '0' }] },
  ]) {
    const response = await setup({ result: { data: [row(changes)], count: 1, error: null } }).get()
    assert.equal(response.status, 500)
    assert.equal('schedules' in response.body, false)
    noCache(response)
  }
})

test('query failures, missing total and unexpected exceptions return safe errors', async () => {
  for (const options of [
    { result: { data: null, count: null, error: { message: 'sensitive detail' } } },
    { result: { data: [row()], count: null, error: null } },
    { throws: true },
  ]) {
    const response = await setup(options).get()
    assert.equal(response.status, 500)
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive/)
    noCache(response)
  }
})

test('read-only status display distinguishes loading, unknown and cancelled history', () => {
  const { ScheduleRegistrationStatus } = compile('app/(app)/admin/schedule-registration-status.tsx', {
    react: React, 'react/jsx-runtime': jsxRuntime,
  })
  const render = props => renderToStaticMarkup(React.createElement(ScheduleRegistrationStatus, props))
  const unknown = render({ loading: false })
  assert.match(unknown, /履歴の有無は不明/)
  assert.doesNotMatch(unknown, /履歴.*：なし/)
  assert.match(render({ loading: true }), /読み込み中/)
  const cancelled = render({ loading: false, status: { ...row(), activeRegistrationCount: 0, hasRegistrationHistory: true } })
  assert.match(cancelled, /有効申込数：0件/)
  assert.match(cancelled, /申込履歴.*：あり/)
  assert.match(cancelled, /変更・関連付け解除・予定の削除はDBの制約でできません/)
  assert.doesNotMatch(cancelled, /<button|<input/)
})
