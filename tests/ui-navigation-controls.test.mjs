import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
const plain = value => JSON.parse(JSON.stringify(value))
function compile(file, deps, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, ...globals, require(name) { assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name] } })
  return exports
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.props?.children)]
}
function hooks() {
  const state = [], refs = [], effects = []
  let s = 0, r = 0, e = 0
  const react = {
    useState(value) { const i = s++; if (!(i in state)) state[i] = typeof value === 'function' ? value() : value; return [state[i], next => { state[i] = typeof next === 'function' ? next(state[i]) : next }] },
    useRef(value) { return refs[r++] ??= { current: value } },
    useEffect(fn, deps) { const i = e++, old = effects[i]; if (!old || deps.some((v,j) => v !== old.deps[j])) effects[i] = { fn, deps, pending: true, cleanup: old?.cleanup } },
    useLayoutEffect() {}, useMemo: fn => fn(), useCallback: fn => fn,
  }
  return { react, state, refs, render(Component, props = {}) { s = 0; r = 0; e = 0; return nodes(Component(props)) },
    flush(i) { const effect = effects[i]; if (effect?.pending) { effect.cleanup?.(); effect.cleanup = effect.fn(); effect.pending = false } },
    unmount() { for (const effect of effects) effect.cleanup?.() } }
}
const Link = 'Link'
test('login uses public links and a labelled password input; login role is exposed', () => {
  const h = hooks()
  const Login = compile('app/(auth)/login/page.tsx', { react: h.react, 'react/jsx-runtime': jsxRuntime, 'next/link': { default: Link } }).default
  const tree = h.render(Login)
  assert.equal(tree.find(n => n.props?.href === '/events').props.children, '開催案内を見る')
  assert.ok(tree.some(n => n.type === Link && n.props.href === '/schedule'))
  assert.ok(tree.some(n => n.type === 'label' && n.props.htmlFor === 'login-password'))
  assert.equal(tree.find(n => n.props?.id === 'login-password').type, 'input')
  const roles = tree.filter(n => n.props?.className?.startsWith('role-btn'))
  assert.deepEqual(roles.map(n => n.props['aria-pressed']), [true, false])
})
function tools(tab) {
  const h = hooks()
  const noop = () => null
  const Tools = compile('app/(app)/admin/management-tools.tsx', {
    react: h.react, 'react/jsx-runtime': jsxRuntime, 'next/link': { default: Link },
    'next/navigation': { useRouter: () => ({}) }, '@/lib/supabase/client': { createClient: () => ({}) },
    './schedule-registration-status': { useScheduleRegistrationStatuses: () => ({ statuses: {}, loading: false, error: '', refresh() {} }), ScheduleRegistrationStatus: noop },
    './schedule-deletion': { scheduleDeletionBlockReason: () => 'history unknown' },
    './new-schedule-form': { default: noop }, './edit-schedule-fields': { default: noop },
    '@/lib/schedules/new-schedule': {}, '@/lib/schedules/edit-schedule': {},
  }).default
  h.render(Tools, { initialTab: tab }); h.state[1] = true; h.state[2] = false
  return { h, render: () => h.render(Tools, { initialTab: tab }) }
}
for (const tab of ['videos', 'passwords']) test(`management navigation identifies current page: ${tab}`, () => {
  const { render } = tools(tab); const tree = render()
  const current = tree.filter(n => n.props?.['aria-current'] === 'page')
  assert.equal(current.length, 1); assert.equal(current[0].props.href, `/admin/${tab}`); assert.match(current[0].props.className, /\bact\b/)
  assert.equal(tree.find(n => n.props?.href === '/admin/event-groups').props.children.trim(), '開催回管理')
  for (const label of tree.filter(n => n.type === 'label')) {
    assert.ok(label.props.htmlFor); assert.ok(tree.some(n => n.props?.id === label.props.htmlFor))
  }
})
for (const tab of ['videos', 'schedules']) test(`${tab} editing moves to the rendered form once and keeps values on cancel`, () => {
  const { h, render } = tools(tab)
  const row = tab === 'videos' ? { id: 1, title: '対象動画', description: '説明', url: 'https://example.invalid/video', duration: '10:00', tag: '基本型' }
    : { id: 1, title: '対象予定', date: '2030-01-01', start_time: '10:00', end_time: '11:00', location: '会場', type: '稽古会', event_group_id: null, registration_enabled: false, capacity: null }
  h.state[tab === 'videos' ? 3 : 4] = [row]
  render().find(n => n.type === 'button' && n.props.children === '編集').props.onClick()
  let tree = render(); const heading = tree.find(n => n.type === 'h2' && n.props.tabIndex === -1)
  assert.ok(heading); const movement = []
  heading.props.ref.current = { focus: options => movement.push(['focus', plain(options)]), scrollIntoView: options => movement.push(['scroll', plain(options)]) }
  h.flush(0)
  assert.deepEqual(movement, [['focus', { preventScroll: true }], ['scroll', { behavior: 'instant', block: 'start' }]])
  assert.equal(tree.find(n => n.props?.id === `management-${tab === 'videos' ? 'vTitle' : 'sTitle'}`).props.value, row.title)
  render(); h.flush(0); assert.equal(movement.length, 2)
  tree.find(n => n.type === 'button' && n.props.children === 'キャンセル').props.onClick()
  tree = render(); h.flush(0); assert.equal(movement.length, 2)
  if (tab === 'videos') assert.equal(tree.find(n => n.props?.id === 'management-vTitle').props.value, '')
  else assert.equal(tree.some(n => n.props?.id === 'management-sTitle'), false)
})
test('registration list returns directly to occurrence management', () => {
  const h = hooks()
  const List = compile('app/(app)/admin/registrations/registration-list.tsx', { react: h.react, 'react/jsx-runtime': jsxRuntime, 'next/link': { default: Link },
    './registration-details-form': { default: () => null }, './cancel-registration-item': { default: () => null }, './add-registration-items': { default: () => null }, './proxy-registration-form': { default: () => null } }).default
  const link = h.render(List).find(n => n.type === Link)
  assert.equal(link.props.href, '/admin/event-groups'); assert.match(link.props.children, /開催回管理/)
})
const video = { id: 9, title: 'テスト動画', description: '説明', duration: '10:00', tag: '基本型', url: 'https://example.invalid/synthetic-video' }
function library(user = { id: 'synthetic' }) {
  const h = hooks(), calls = []
  const query = { select(columns) { calls.push(['select',columns]); return query }, order: async () => ({data:[video]}) }
  const client = { auth: { getUser: async () => ({data:{user}}) }, from(table) { calls.push(['from',table]); return query } }
  const VideoDialog = compile('app/(app)/videos/video-dialog.tsx', { react: h.react, 'react/jsx-runtime': jsxRuntime }).default
  const code = compile('app/(app)/videos/page.tsx', { react: h.react, 'react/jsx-runtime': jsxRuntime, './video-dialog': { default: VideoDialog }, 'next/navigation': { useRouter: () => ({ push: path => calls.push(['push',path]) }) }, '@/lib/supabase/client': { createClient: () => client } })
  return { h, calls, VideoDialog, ...code }
}
test('video cards are native keyboard buttons and retain the selected target and opener', () => {
  const { h, default: Page, VideoDialog } = library(); h.render(Page); h.state[0] = [video]; h.state[3] = false
  const tree = h.render(Page), card = tree.find(n => n.props?.className === 'vcard')
  assert.equal(card.type, 'button'); assert.equal(card.props.type, 'button'); assert.equal(card.props['aria-haspopup'], 'dialog'); assert.match(card.props['aria-label'], /テスト動画/)
  // Native button supplies Enter/Space activation; no custom key handler suppresses it.
  assert.equal(card.props.onKeyDown, undefined)
  const opener = { isConnected: true, focus() {} }; card.props.onClick({ currentTarget: opener })
  const dialog = h.render(Page).find(n => n.type === VideoDialog)
  assert.equal(dialog.props.video.id, 9); assert.equal(dialog.props.opener.current, opener)
  dialog.props.onClose(); assert.equal(h.render(Page).some(n => n.type === VideoDialog), false)
})
test('video loading still checks auth and only reads videos', async () => {
  const {h, calls, default:Page} = library();h.render(Page);h.flush(0)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls,[['from','videos'],['select','*']])
})
for (const mode of ['close','escape','backdrop']) test(`native modal closes via ${mode} and restores focus without scrolling`, () => {
  const { h, VideoDialog } = library(), movement = []; let closed = 0
  const opener = { isConnected: true, focus: options => movement.push(['return',plain(options)]) }
  const tree = h.render(VideoDialog, { video, opener: { current: opener }, onClose: () => closed++ })
  const dialog = tree.find(n => n.type === 'dialog'), button = tree.find(n => n.props?.className === 'close-btn')
  assert.equal(dialog.props['aria-labelledby'], 'video-dialog-title'); assert.ok(button.props['aria-label'])
  dialog.props.ref.current = { showModal: () => movement.push('showModal'), close: () => movement.push('close') }
  button.props.ref.current = { focus: options => movement.push(['focus',plain(options)]) }
  h.flush(0)
  assert.deepEqual(movement, ['showModal',['focus',{preventScroll:true}]])
  const link = tree.find(n => n.type === 'a'); assert.equal(link.props.href,video.url); assert.equal(link.props.rel,'noopener noreferrer')
  if(mode === 'close')button.props.onClick()
  else if(mode === 'escape'){let prevented=false;dialog.props.onCancel({preventDefault(){prevented=true}});assert.equal(prevented,true)}
  else {const target={};dialog.props.onClick({target,currentTarget:target});dialog.props.onClick({target:{},currentTarget:target})}
  assert.equal(closed,1)
  h.unmount(); assert.deepEqual(movement.slice(-2),['close',['return',{preventScroll:true}]])
})
test('modal does not focus a removed opener on route unmount', () => {
  const {h,VideoDialog}=library();const tree=h.render(VideoDialog,{video,opener:{current:{isConnected:false,focus(){assert.fail('Detached opener')}}},onClose(){}})
  tree.find(n=>n.type==='dialog').props.ref.current={showModal(){},close(){}}
  tree.find(n=>n.props?.className==='close-btn').props.ref.current={focus(){}}
  h.flush(0);h.unmount()
})

test('unauthenticated video visit redirects before reading videos', async()=>{
 const {h,calls,default:Page}=library(null);h.render(Page);h.flush(0);await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(calls,[['push','/login']])
})
