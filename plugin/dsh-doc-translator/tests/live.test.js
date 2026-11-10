import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { LIVE_PREFIX, createLiveView, liveDirName, pruneLiveViews } from '../live.js'
import { translateOffice } from '../office.js'
import { translateDocument } from '../translate-file.js'
import { translateSegments } from '../translate.js'
import { buildDocx } from './build.js'

let root
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined })
const temp = () => (root = mkdtempSync(join(tmpdir(), 'live-test-')))
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))
const state = dir => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))

test('the live directory name is hidden and makes the call id safe for a file name', () => {
  assert.equal(liveDirName('call_1-A'), `${LIVE_PREFIX}call_1-A`)
  assert.equal(liveDirName('a/b:c d'), `${LIVE_PREFIX}a_b_c_d`)
  assert.equal(liveDirName('x'.repeat(200)).length, LIVE_PREFIX.length + 80)
})

test('a page view lists the originals, then adds each translated page as it finishes', async () => {
  const dir = join(temp(), 'live')
  const images = ['a.png', 'b.png', 'c.jpg'].map(name => { const path = join(root, name); writeFileSync(path, name); return path })
  const view = createLiveView({ dir, kind: 'pages', source: 'scan.pdf', intervalMs: 0 })
  await view.pages(images)
  assert.deepEqual(state(dir), { version: 1, kind: 'pages', status: 'running', source: 'scan.pdf', pages: [{ original: 'o-1.png' }, { original: 'o-2.png' }, { original: 'o-3.jpg' }] })
  writeFileSync(join(root, 'out-2.png'), 'translated b')
  await view.page(1, join(root, 'out-2.png'))
  assert.deepEqual(state(dir).pages[1], { original: 'o-2.png', translated: 't-2.png' })
  assert.equal(readFileSync(join(dir, 't-2.png'), 'utf8'), 'translated b')
  assert.equal(readFileSync(join(dir, 'o-3.jpg'), 'utf8'), 'c.jpg')
  await view.close({ status: 'done', output: '/w/scan.en.pdf' })
  assert.equal(state(dir).status, 'done')
  assert.equal(state(dir).output, '/w/scan.en.pdf')
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left behind')
  await view.page(0, join(root, 'out-2.png'))
  assert.equal(existsSync(join(dir, 't-1.png')), false, 'nothing is written after close')
})

/** Wait until `check()` is true, polling every few milliseconds, for at most two seconds. */
async function until(check) {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > 2000) throw new Error('condition not reached')
    await tick(5)
  }
}
const segmentsOf = dir => { try { return state(dir).segments } catch { return undefined } }

test('segment updates are written at most once per interval, the latest only, without markers', async () => {
  const dir = join(temp(), 'live')
  const view = createLiveView({ dir, kind: 'segments', source: 'a.docx', intervalMs: 400 })
  const built = []
  view.segments(() => { built.push(1); return [{ s: '⟦1⟧Hello⟦/1⟧ world' }] })
  await until(() => segmentsOf(dir)?.length === 1)
  assert.deepEqual(segmentsOf(dir), [{ s: 'Hello world' }])
  const second = Date.now()
  view.segments(() => { built.push(2); return [{ s: 'Hello', t: 'Xin chào' }] })
  view.segments(() => { built.push(3); return [{ s: '⟦1⟧Hello⟦/1⟧', t: '⟦1⟧Chào⟦/1⟧' }] })
  await until(() => segmentsOf(dir)?.[0].t !== undefined)
  assert.ok(Date.now() - second >= 300, 'the next update waits for the interval')
  assert.deepEqual(segmentsOf(dir), [{ s: 'Hello', t: 'Chào' }])
  assert.deepEqual(built, [1, 3], 'replaced updates are never built')
})

test('close writes the waiting segments with the final status', async () => {
  const dir = join(temp(), 'live')
  const view = createLiveView({ dir, kind: 'segments', source: 'a.docx', intervalMs: 10_000 })
  view.segments(() => [{ s: 'a' }])
  await tick(10)
  view.segments(() => [{ s: 'a', t: 'A' }])
  await view.close({ status: 'failed', error: 'stopped' })
  assert.deepEqual(state(dir), { version: 1, kind: 'segments', status: 'failed', source: 'a.docx', segments: [{ s: 'a', t: 'A' }], error: 'stopped' })
})

test('a failed write stops the view without throwing to the translation', async () => {
  const dir = join(temp(), 'live')
  const view = createLiveView({ dir, kind: 'pages', source: 'x.pdf', intervalMs: 0 })
  await view.pages([join(root, 'missing.png')])
  assert.match(view.failure, /ENOENT/)
  await view.page(0, join(root, 'missing.png'))
  await view.close({ status: 'done' })
  assert.equal(state(dir).status, 'running', 'the state stays at the last good write')
})

test('only live directories older than the retention period are pruned', async () => {
  const dir = temp()
  const old = join(dir, `${LIVE_PREFIX}old`)
  const fresh = join(dir, `${LIVE_PREFIX}fresh`)
  mkdirSync(old); mkdirSync(fresh)
  writeFileSync(join(old, 'state.json'), '{}')
  writeFileSync(join(dir, 'old-report.pdf'), 'x')
  const now = Date.now()
  for (const path of [old, join(dir, 'old-report.pdf')]) utimesSync(path, new Date(now - 10_000), new Date(now - 10_000))
  await pruneLiveViews(dir, 5_000, now)
  assert.deepEqual(readdirSync(dir).sort(), [`${LIVE_PREFIX}fresh`, 'old-report.pdf'])
  await pruneLiveViews(join(dir, 'missing'), 5_000, now)
})

const upper = { async chat({ user }) { return { text: JSON.stringify(JSON.parse(user).map(r => ({ i: r.i, text: r.text.toUpperCase() }))), usage: {} } } }

test('progress is reported after every batch with the translations so far, by segment id', async () => {
  const seen = []
  const segments = [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }, { id: 'c', text: 'one' }]
  await translateSegments(upper, segments, { target: 'English', models: ['T'], concurrency: 1, batchChars: 3, batchItems: 1, maxTokens: 100, onProgress: p => seen.push({ done: p.batchesDone, of: p.batches, map: [...p.translations()] }) })
  assert.deepEqual(seen, [
    { done: 1, of: 2, map: [['a', 'ONE'], ['c', 'ONE']] },
    { done: 2, of: 2, map: [['a', 'ONE'], ['c', 'ONE'], ['b', 'TWO']] },
  ])
})

test('an Office observer sees every line untranslated first, then translations as batches settle', async () => {
  const snapshots = []
  await translateOffice({ buffer: buildDocx(), extension: 'docx', llm: upper, observer: { segments: build => snapshots.push(build()) }, options: { target: 'English', models: ['T'], concurrency: 1, batchChars: 10, batchItems: 1, maxTokens: 100, maxArchiveBytes: 1e8, expansionWarn: 1.5 } })
  assert.ok(snapshots.length >= 3)
  assert.ok(snapshots[0].every(row => row.t === undefined))
  const counts = snapshots.map(rows => rows.filter(row => row.t !== undefined).length)
  assert.deepEqual(counts, [...counts].sort((a, b) => a - b), 'translated lines only grow')
  assert.ok(snapshots.at(-1).every(row => row.t === row.s.toUpperCase()))
})

/** A workspace with the ctx services `translateDocument` uses. */
function workspace() {
  const ws = join(temp(), 'ws')
  mkdirSync(ws)
  const ctx = {
    workingDirectory: { ensure: async () => ws },
    fs: {
      resolve: async (path, { cwd }) => ({ displayPath: isAbsolute(path) ? path : join(cwd, path) }),
      stat: async (target) => { try { return { type: 'file', size: readFileSync(target.displayPath).length } } catch { return undefined } },
      readBytes: async (target) => readFileSync(target.displayPath),
      processPath: target => target.displayPath,
    },
  }
  return { ws, ctx }
}
const CONFIG = { baseUrl: 'https://x/v1', translationModels: ['T'], modelConcurrency: {}, maxFileBytes: 1e7, maxArchiveBytes: 1e8, batchConcurrency: 1, batchChars: 10, batchItems: 1, maxOutputTokens: 2000, expansionWarn: 1.5, verifyLayout: false, ocr: {}, livePreview: { enabled: true, intervalMs: 0, retainMs: 86_400_000 } }
const exec = callId => ({ callId, agent: { session: {} }, signal: new AbortController().signal })

test('a call with an id writes its live view in the working directory and marks it done with the output', async () => {
  const { ws, ctx } = workspace()
  writeFileSync(join(ws, 'a.docx'), buildDocx())
  const out = await translateDocument({ ctx, sandboxPolicy: undefined, exec: exec('call-7'), args: { path: 'a.docx', target_language: 'English' }, config: CONFIG, llm: upper })
  assert.equal(out.live, join(ws, liveDirName('call-7')))
  const final = state(out.live)
  assert.equal(final.status, 'done')
  assert.equal(final.output, out.file)
  assert.equal(final.source, 'a.docx')
  assert.ok(final.segments.length > 0 && final.segments.every(row => row.t !== undefined))
  assert.doesNotMatch(out.text, /dsh-translating|live view|preview/i, 'the model is not told about the live view')
})

test('a failed call marks its live view failed, and a call with the view turned off writes none', async () => {
  const { ws, ctx } = workspace()
  writeFileSync(join(ws, 'a.docx'), buildDocx())
  let calls = 0
  const failing = { async chat(request) { if (++calls > 1) throw new TypeError('bug'); return upper.chat(request) } }
  await assert.rejects(translateDocument({ ctx, sandboxPolicy: undefined, exec: exec('call-8'), args: { path: 'a.docx', target_language: 'English' }, config: CONFIG, llm: failing }), /bug/)
  assert.equal(state(join(ws, liveDirName('call-8'))).status, 'failed')
  assert.equal(state(join(ws, liveDirName('call-8'))).error, 'bug')
  rmSync(join(ws, liveDirName('call-8')), { recursive: true })
  const out = await translateDocument({ ctx, sandboxPolicy: undefined, exec: exec('call-9'), args: { path: 'a.docx', target_language: 'English' }, config: { ...CONFIG, livePreview: { ...CONFIG.livePreview, enabled: false } }, llm: upper })
  assert.equal(out.live, undefined)
  assert.deepEqual(readdirSync(ws).sort(), ['a.docx', 'a.en.docx'])
})

test('a Session that may not write in its working directory still gets the translation, without a live view', async () => {
  const { ws, ctx } = workspace()
  const writable = join(ws, 'out')
  mkdirSync(writable)
  writeFileSync(join(writable, 'a.docx'), buildDocx())
  const policy = { mode: 'workspace-write', workspaceRoot: join(root, 'missing'), additionalWritableRoots: [writable] }
  const out = await translateDocument({ ctx, sandboxPolicy: { resolve: () => policy }, exec: exec('c9'), args: { path: 'out/a.docx', target_language: 'English' }, config: CONFIG, llm: upper })
  assert.equal(out.file, join(writable, 'a.en.docx'))
  assert.equal(out.live, undefined)
  assert.deepEqual(readdirSync(ws), ['out'])
})
