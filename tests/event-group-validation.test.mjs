import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const exports = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/event-groups/validation.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports })
const { validateEventGroupOccurrence: create, validateEventGroupOccurrenceUpdate: update } = exports
const plain = value => JSON.parse(JSON.stringify(value))
const empty = { city: null, start_date: null, end_date: null }
const current = { city: '福岡', start_date: '2026-11-01', end_date: '2026-11-03' }

for (const city of [null, '', '   ', '　']) test(`optional city normalizes ${JSON.stringify(city)} to null`, () => {
  assert.deepEqual(plain(create({ city }).data), empty)
})
test('omitted occurrence fields become null for creation', () => {
  assert.deepEqual(plain(create({}).data), empty)
})
test('city is trimmed and Unicode characters are counted rather than UTF-16 units', () => {
  assert.equal(create({ city: ' 福岡　' }).data.city, '福岡')
  for (const city of ['東', '東'.repeat(100), '😀'.repeat(100)]) assert.equal(create({ city }).data.city, city)
  assert.ok(create({ city: '東'.repeat(101) }).error)
  assert.ok(create({ city: '😀'.repeat(101) }).error)
})
for (const date of ['2026-11-01', '2024-02-29', '2000-02-29', '0001-01-01', '9999-12-31']) test(`valid same-day event ${date}`, () => {
  assert.deepEqual(plain(create({ start_date: date, end_date: date }).data), { ...empty, start_date: date, end_date: date })
})
test('multiple-day and cross-year events are accepted', () => {
  assert.ok(create(current).data)
  assert.ok(create({ start_date: '2026-12-31', end_date: '2027-01-02' }).data)
})
for (const date of ['2026-02-29', '1900-02-29', '2026-02-30', '2026-04-31', '0000-01-01', '2026-00-01', '2026-13-01', '2026-01-00', '2026-1-01', '2026/01/01', '2026-01-01T00:00:00Z', ' 2026-01-01', '2026-01-01 ']) test(`invalid date ${date} is rejected`, () => {
  for (const field of ['start_date', 'end_date']) assert.ok(create({ start_date: '2026-01-01', end_date: '2026-12-31', [field]: date }).error)
})
test('blank date pairs normalize to null; one-sided dates are rejected', () => {
  assert.deepEqual(plain(create({ start_date: '', end_date: null }).data), empty)
  for (const body of [{ start_date: '2026-01-01' }, { end_date: '2026-01-01' }, { start_date: '', end_date: '2026-01-01' }, { start_date: '2026-01-01', end_date: null }]) assert.ok(create(body).error)
  assert.ok(create({ start_date: '2026-02-02', end_date: '2026-02-01' }).error)
})
test('invalid bodies, field types and unknown fields are rejected without echoing values', () => {
  for (const body of [null, undefined, 1, false, 'bad', []]) assert.ok(create(body).error)
  for (const field of ['city', 'start_date', 'end_date']) {
    for (const value of [undefined, 1, true, [], {}, ['PRIVATE_VALUE']]) {
      const result = create({ [field]: value })
      assert.ok(result.error)
      assert.doesNotMatch(result.error, /PRIVATE_VALUE/)
    }
  }
  assert.ok(create({ secret: 'PRIVATE_VALUE' }).error)
})
test('update distinguishes omission from explicit null and leaves inputs unchanged', () => {
  const snapshot = JSON.stringify(current)
  assert.deepEqual(plain(update({}, current).data), {})
  assert.deepEqual(plain(update({ city: null }, current).data), { city: null })
  assert.deepEqual(plain(update({ city: '  ' }, current).data), { city: null })
  assert.deepEqual(plain(update({ city: ' 東京 ' }, current).data), { city: '東京' })
  assert.equal(JSON.stringify(current), snapshot)
})
test('update checks the merged date pair and returns only specified fields', () => {
  assert.deepEqual(plain(update({ start_date: '2026-11-02' }, current).data), { start_date: '2026-11-02' })
  assert.ok(update({ start_date: '2026-11-04' }, current).error)
  assert.ok(update({ end_date: '2026-10-31' }, current).error)
  assert.ok(update({ start_date: null }, current).error)
  assert.deepEqual(plain(update({ start_date: null, end_date: '' }, current).data), { start_date: null, end_date: null })
  assert.ok(update({ start_date: '2026-11-01' }, empty).error)
  assert.deepEqual(plain(update(current, empty).data), current)
})
test('update rejects malformed patches and invalid current state', () => {
  for (const body of [null, undefined, 1, 'bad', []]) assert.ok(update(body, current).error)
  assert.ok(update({ city: undefined }, current).error)
  assert.ok(update({ unexpected: true }, current).error)
  assert.ok(update({}, { ...current, end_date: null }).error)
})
