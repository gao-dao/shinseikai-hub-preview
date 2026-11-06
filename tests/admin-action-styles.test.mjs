import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import postcss from 'postcss'

const root = 'app/(app)/admin'
const css = fs.readFileSync(`${root}/admin-actions.css`, 'utf8')
const parsed = postcss.parse(css)
const rules = [...parsed.nodes].filter(n => n.type === 'rule')
const declaration = (rule, prop) => rule.nodes.find(n => n.prop === prop)?.value
const rule = selector => {
  const found = rules.find(n => n.selector === selector)
  assert.ok(found, `Missing selector ${selector}`)
  return found
}
function source(file) { return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) }
function openings(ast) {
  const result = []
  function walk(n) { if (ts.isJsxOpeningElement(n)) result.push(n); ts.forEachChild(n, walk) }
  walk(ast)
  return result
}
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []) }
const attribute = (node, name) => node.attributes.properties.find(a => a.name?.text === name)

test('admin layout loads shared styles without adding a wrapper or changing authorization', () => {
  const text = fs.readFileSync(`${root}/layout.tsx`, 'utf8')
  const exports = {}, imports = []
  vm.runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, require(name) { imports.push(name); assert.equal(name, './admin-actions.css'); return {} } })
  const child = { original: true }
  assert.equal(exports.default({ children: child }), child)
  assert.deepEqual(imports, ['./admin-actions.css'])
  assert.doesNotMatch(text, /getUser|requireAdmin|redirect|fetch\(/)
})

test('shared action styles are scoped, wrap within the viewport and preserve touch targets', () => {
  assert.ok(rules.every(r => r.selector.startsWith('.hub-content ')))
  const base = rule('.hub-content :is(button, a)[data-admin-action]')
  assert.equal(declaration(base, 'min-height'), '44px')
  assert.equal(declaration(base, 'max-width'), '100%')
  assert.equal(declaration(base, 'box-sizing'), 'border-box')
  assert.equal(declaration(base, 'white-space'), 'normal')
  assert.equal(declaration(base, 'overflow-wrap'), 'anywhere')
  assert.equal(declaration(base, 'box-shadow'), 'none')
  assert.ok(!base.nodes.some(n => n.prop.startsWith('--')), 'role variables must not be overridden by the more specific base selector')
  assert.doesNotMatch(css, /!important|linear-gradient|pointer-events:\s*none/)
})

test('primary, navigation, secondary and danger roles have distinct presentation', () => {
  const primary = rule('.hub-content [data-admin-action="primary"]')
  assert.equal(declaration(primary, '--admin-action-background'), 'var(--hub-primary)')
  assert.equal(declaration(primary, '--admin-action-color'), '#fff')
  assert.equal(declaration(rule('.hub-content [data-admin-action="navigation"]'), '--admin-action-background'), '#f7eef0')
  assert.equal(declaration(rule('.hub-content [data-admin-action="danger"]'), '--admin-action-color'), '#9b303b')
  assert.match(css, /background: var\(--admin-action-background, #fff\)/)
})

test('disabled controls cannot receive hover styles, keyboard focus remains visible', () => {
  rule('.hub-content [data-admin-action]:not(:disabled):not([aria-disabled="true"]):hover')
  const disabled = rule('.hub-content [data-admin-action]:is(:disabled, [aria-disabled="true"])')
  assert.equal(declaration(disabled, 'border'), '1px dashed #c9c2b8')
  assert.equal(declaration(disabled, 'opacity'), '1')
  assert.equal(declaration(disabled, 'cursor'), 'not-allowed')
  assert.equal(declaration(rule('.hub-content [data-admin-action]:focus-visible'), 'outline'), '3px solid var(--hub-primary)')
  rule('.hub-content [data-admin-action="secondary"][aria-pressed="true"]')
})

for (const file of files(root).filter(p => !p.endsWith('/occurrence-list.tsx'))) test(`admin buttons declare presentation without changing their element: ${file}`, () => {
  for (const n of openings(source(file)).filter(n => n.tagName.getText() === 'button')) {
    assert.ok(attribute(n, 'data-admin-action'), `Unclassified button in ${file}`)
    assert.equal(attribute(n, 'role'), undefined, 'native button semantics retained')
    assert.equal(attribute(n, 'tabIndex'), undefined, 'native keyboard access retained')
  }
})

test('critical controls keep their role distinction, including hide versus redisplay', () => {
  const state = openings(source(`${root}/event-groups/occurrence-state.tsx`)).filter(n => n.tagName.getText() === 'button')
  assert.equal(attribute(state[0], 'data-admin-action').initializer.expression.getText(), "group.is_hidden ? 'secondary' : 'danger'")
  assert.equal(attribute(state[2], 'data-admin-action').initializer.text, 'danger')
  assert.equal(attribute(openings(source(`${root}/registrations/cancel-registration-item.tsx`)).find(n => n.tagName.getText() === 'button'), 'data-admin-action').initializer.text, 'danger')
  for (const file of ['event-groups/registration-control.tsx', 'event-groups/class-registration-control.tsx']) {
    const first = openings(source(`${root}/${file}`)).find(n => n.tagName.getText() === 'button')
    assert.equal(attribute(first, 'data-admin-action').initializer.text, 'primary')
  }
})


test('ordinary navigation stays a text link and existing home cards and menus retain their design', () => {
  const link = rule('.hub-content a[data-admin-link]')
  assert.equal(declaration(link, 'color'), 'var(--hub-primary)')
  assert.equal(declaration(link, 'min-height'), '44px')
  for (const prop of ['background', 'border', 'padding']) assert.equal(declaration(link, prop), undefined)
  rule('.hub-content a[data-admin-link]:focus-visible')
  const home = openings(source(`${root}/page.tsx`)).find(n => attribute(n, 'className')?.getText().includes('styles.homeCard'))
  assert.ok(home)
  assert.equal(attribute(home, 'data-admin-link'), undefined)
  assert.equal(attribute(home, 'data-admin-action'), undefined)
  assert.doesNotMatch(fs.readFileSync(`${root}/admin-navigation.tsx`, 'utf8'), /data-admin-action|data-admin-link/)
})
