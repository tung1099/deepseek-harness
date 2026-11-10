import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { liveDirName } from '../live.js'

/**
 * Load client.js the way the browser module loader does, with a React stub
 * whose hooks run inline: `useEffect` runs its effect at once, and `useState`
 * returns `states.shift()` when the test queued a value, else the initial value.
 */
function loadClient(states = []) {
  let registration
  const window = { __ModuleLoader__: { load: entry => { registration = entry } } }
  const document = { baseURI: 'http://127.0.0.1:3080/', head: { appendChild() {} }, createElement: () => ({ dataset: {}, remove() {} }) }
  const sandbox = { window, document, fetch: async () => ({ ok: false, status: 404 }), setTimeout: () => 0, clearTimeout() {}, URL }
  runInNewContext(readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8'), sandbox)
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: initial => [states.length > 0 ? states.shift() : initial, () => {}],
    useEffect: effect => { effect() },
    useRef: value => ({ current: value }),
  }
  const primitives = { DisclosureRow: 'DisclosureRow', IconGlobeOutlineRegular: 'Icon' }
  const exports = registration.factory(name => ({ react: React, '@deepseek-ai/dsh-client-ui-primitives': primitives })[name])
  return { id: registration.id, exports }
}

/** Apply the plugin to a fake context and return what it registered. */
function register(states) {
  const { id, exports } = loadClient(states)
  const registered = { slots: new Map(), dictionaries: undefined, tabType: undefined, opened: [] }
  const ctx = {
    effect: fn => fn(),
    locale: { bind: () => key => key, register: (ns, dicts) => { registered.dictionaries = dicts; return () => {} } },
    slots: { inject: (_name, fn) => fn(), register: (options, component) => { registered.slots.set(options.name, { options, component }); return () => {} } },
    sidebarRightTabs: { register: definition => { registered.tabType = definition; return () => {} } },
    sidebarRight: { openResource: address => registered.opened.push(address) },
  }
  exports.apply(ctx)
  return { id, inject: [...exports.inject], ...registered }
}

/** Expand a rendered element tree through function components. */
function expand(node, out = { buttons: [], nodes: [] }) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof node.type === 'function') return expand(node.type({ ...node.props }), out)
  out.nodes.push(node)
  if (node.type === 'button') out.buttons.push(node)
  for (const child of [...node.children, node.props.collapsedContent]) expand(child, out)
  return out
}
const text = tree => tree.nodes.flatMap(node => node.children.filter(child => typeof child === 'string')).join('|')
const click = button => button.props.onClick({ stopPropagation() {} })

const t = key => key
const running = (callId, args) => ({ phase: 'start', callId, cwd: '/w', block: { argsRaw: JSON.stringify(args) } })

test('the plugin registers the live tab type and body, the doc_translate row, and complete dictionaries', () => {
  const r = register()
  assert.equal(r.id, 'dsh-doc-translator')
  assert.deepEqual(r.inject, ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'])
  assert.equal(r.slots.get('tool.call.toolview').options.key, 'doc_translate')
  assert.equal(r.slots.get('sidebar.right.pane.tab').options.key, r.tabType.id)
  assert.deepEqual([...r.tabType.patterns], ['dsh-resource://doc-translate/live/**'])
  assert.equal(r.tabType.canOpen('dsh-resource://doc-translate/live/%2Fw%2F.dsh-translating-c1'), true)
  assert.equal(r.tabType.canOpen('dsh-resource://doc-translate/live/%E0%A4%A'), false)
  assert.equal(r.tabType.canOpen('dsh-resource://doc-translate/live/'), false)
  const keys = Object.keys(r.dictionaries.en).sort()
  for (const locale of ['zh', 'vi']) assert.deepEqual(Object.keys(r.dictionaries[locale]).sort(), keys, locale)
})

test('a running call opens the live directory the Host writes, once per call', () => {
  const r = register()
  const row = r.slots.get('tool.call.toolview')
  const face = row.options.inject()
  const props = { ...running('call:1/x', { path: 'scan.pdf', target_language: 'English' }), ...face, t, openFile() {} }
  const expected = `dsh-resource://doc-translate/live/${encodeURIComponent(`/w/${liveDirName('call:1/x')}`)}`
  const tree = expand(row.component(props))
  assert.deepEqual(r.opened, [expected])
  expand(row.component(props))
  assert.equal(r.opened.length, 1, 'a remounted row does not reopen the view')
  click(tree.buttons[0])
  assert.deepEqual(r.opened, [expected, expected], 'the progress button reopens it')
})

test('a row without a working directory, or still preparing, opens nothing', () => {
  const r = register()
  const row = r.slots.get('tool.call.toolview')
  const face = row.options.inject()
  expand(row.component({ ...running('c1', { path: 'a.pdf' }), cwd: undefined, ...face, t, openFile() {} }))
  expand(row.component({ phase: 'preparing', callId: 'c2', block: {}, ...face, t, openFile() {} }))
  assert.deepEqual(r.opened, [])
})

test('a settled call opens nothing by itself and offers its live view and its translated file', () => {
  const r = register()
  const row = r.slots.get('tool.call.toolview')
  const face = row.options.inject()
  const files = []
  const block = (meta, extra = {}) => ({ kind: 'tool-result', call: { argsRaw: JSON.stringify({ path: 'a.pdf' }) }, content: [{ type: 'text', text: 'done' }], isError: false, meta, ...extra })
  const ok = expand(row.component({ phase: 'result', callId: 'c1', cwd: '/w', block: block({ file: '/w/a.vi.pdf', live: '/w/.dsh-translating-c1' }), ...face, t, openFile: path => files.push(path) }))
  assert.deepEqual(r.opened, [])
  assert.equal(ok.buttons.length, 2)
  click(ok.buttons[0])
  click(ok.buttons[1])
  assert.deepEqual(r.opened, [`dsh-resource://doc-translate/live/${encodeURIComponent('/w/.dsh-translating-c1')}`])
  assert.deepEqual(files, ['/w/a.vi.pdf'])
  const failed = expand(row.component({ phase: 'result', callId: 'c3', cwd: '/w', block: block(undefined, { isError: true }), ...face, t, openFile() {} }))
  assert.equal(failed.buttons.length, 0)
})

const tabProps = (address, opened = []) => ({
  sessionId: 's1', t,
  useTabInfo: () => ({ tab: { navigation: { address }, actions: { openResource: a => opened.push(a) } } }),
})
const address = `dsh-resource://doc-translate/live/${encodeURIComponent('/w/.dsh-translating-c1')}`

test('the live tab waits for the state, then shows the original pages with translated pages over them', () => {
  const r = register()
  const body = r.slots.get('sidebar.right.pane.tab').component
  assert.match(text(expand(body(tabProps(address)))), /tab\.loading/)

  const state = { version: 1, kind: 'pages', status: 'running', source: 'scan.pdf', pages: [{ original: 'o-1.png', translated: 't-1.png' }, { original: 'o-2.png' }] }
  const tree = expand(register([{ phase: 'ready', state }]).slots.get('sidebar.right.pane.tab').component(tabProps(address)))
  const images = tree.nodes.filter(node => node.type === 'img').map(node => decodeURIComponent(new URL(node.props.src).searchParams.get('path')))
  assert.deepEqual(images, ['/w/.dsh-translating-c1/o-1.png', '/w/.dsh-translating-c1/t-1.png', '/w/.dsh-translating-c1/o-2.png'])
  const pages = tree.nodes.filter(node => node.props.className === 'dshdt-page')
  assert.deepEqual(pages.map(page => [page.props['data-done'], page.props['data-working']]), [[true, undefined], [undefined, true]])
  assert.match(text(tree), /scan\.pdf/)
  assert.match(text(tree), /tab\.running · tab\.pages/)
  assert.equal(tree.buttons.length, 0, 'no open button before the translation is done')
})

test('a finished line view shows the translations and opens the translated file', () => {
  const opened = []
  const state = { version: 1, kind: 'segments', status: 'done', source: 'a.docx', output: '/w/a.vi.docx', segments: [{ s: 'Hello', t: 'Xin chào' }, { s: 'World', t: 'Thế giới' }] }
  const tree = expand(register([{ phase: 'ready', state }]).slots.get('sidebar.right.pane.tab').component(tabProps(address, opened)))
  assert.match(text(tree), /Xin chào\|Thế giới/)
  click(tree.buttons[0])
  assert.deepEqual(opened, ['dsh-resource://file/session/s1//w/a.vi.docx'])
})

test('a failed view says why, and a stopped one says it was stopped', () => {
  const failed = { version: 1, kind: 'segments', status: 'failed', source: 'a.docx', error: 'endpoint down', segments: [{ s: 'Hello' }] }
  assert.match(text(expand(register([{ phase: 'ready', state: failed }]).slots.get('sidebar.right.pane.tab').component(tabProps(address)))), /tab\.failed.*\|endpoint down/)
  const stopped = { ...failed, error: 'stopped' }
  const tree = expand(register([{ phase: 'ready', state: stopped }]).slots.get('sidebar.right.pane.tab').component(tabProps(address)))
  assert.match(text(tree), /tab\.stopped/)
  assert.doesNotMatch(text(tree), /\|stopped/)
})
