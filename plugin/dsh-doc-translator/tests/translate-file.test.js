import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { STOP_GUIDANCE, explain, suffixFor, translateDocument, validateArgs, validateConfig } from '../translate-file.js'
import { readZip } from '../zip.js'
import { buildDocx } from './build.js'

let root
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined })

const CONFIG = { baseUrl: 'https://x/v1', translationModels: ['T'], modelConcurrency: {}, maxFileBytes: 10_000_000, maxArchiveBytes: 100_000_000, batchConcurrency: 2, batchChars: 2000, batchItems: 30, maxOutputTokens: 2000, expansionWarn: 1.5, verifyLayout: false, ocr: { spotModel: 'P', readModel: 'R', dpi: 100, maxPages: 3, pageConcurrency: 2 } }
const llm = { async chat({ user }) { return { text: JSON.stringify(JSON.parse(user).map(r => ({ i: r.i, text: r.text.split(/(⟦\/?\d+⟧)/).map(p => (/^⟦/.test(p) ? p : p.toUpperCase())).join('') }))), usage: {} } } }

/** A workspace on disk, with ctx services over it. */
function workspace(mode = 'workspace-write') {
  root = mkdtempSync(join(tmpdir(), 'tf-test-'))
  const ws = join(root, 'ws')
  mkdirSync(ws)
  const files = new Map()
  const ctx = {
    workingDirectory: { ensure: async () => ws },
    fs: {
      resolve: async (path, { cwd }) => ({ displayPath: isAbsolute(path) ? path : join(cwd, path) }),
      stat: async (target) => { try { const b = readFileSync(target.displayPath); return { type: 'file', size: b.length } } catch { return undefined } },
      readBytes: async (target) => readFileSync(target.displayPath),
      processPath: target => target.displayPath,
    },
  }
  void files
  mkdirSync(join(root, 'store'))
  return { ws, store: join(root, 'store'), requests: [], ctx, policy: { mode, workspaceRoot: ws }, exec: { agent: { session: { id: 's1' } }, signal: new AbortController().signal } }
}
/** The tool passes the policy service, not a resolved policy: `resolve` is called with the Session. */
const service = w => ({ resolve: (request) => { w.requests.push(request); return w.policy } })
const input = (w, args, extra = {}) => ({ ctx: w.ctx, sandboxPolicy: service(w), exec: w.exec, args, config: CONFIG, llm, ...extra })

test('arguments are checked with messages the model can act on', () => {
  assert.throws(() => validateArgs({}), /path is required/)
  assert.throws(() => validateArgs({ path: 'a.docx' }), /target_language is required/)
  assert.throws(() => validateArgs({ path: 'a.docx', target_language: 'x'.repeat(61) }), /target_language/)
  assert.throws(() => validateArgs({ path: 'a.docx', target_language: 'English', glossary: [{ source: '', target: 'x' }] }), /glossary entry/)
  assert.throws(() => validateArgs({ path: 'a.docx', target_language: 'English', glossary: 'nope' }), /glossary must be a list/)
  assert.deepEqual(validateArgs({ path: ' a.docx ', target_language: ' English ', verify_layout: false }), { path: 'a.docx', target: 'English', source: undefined, glossary: [], verifyLayout: false })
})

test('the output suffix is the language code, or a safe form of the name', () => {
  assert.equal(suffixFor('Vietnamese', { code: 'vi' }), 'vi')
  assert.equal(suffixFor('Klingon / tlhIngan', { code: null }), 'klingon-tlhingan')
  assert.equal(suffixFor('///', { code: null }), 'translated')
})

test('a docx is translated and written next to the input, with a summary that states only what was done', async () => {
  const w = workspace()
  writeFileSync(join(w.ws, 'report.docx'), buildDocx())
  const out = await translateDocument(input(w, { path: 'report.docx', target_language: 'Vietnamese' }))
  assert.equal(out.file, join(w.ws, 'report.vi.docx'))
  const doc = readZip(readFileSync(out.file)).find(e => e.name === 'word/document.xml').data.toString()
  assert.match(doc, />ANNUAL REPORT</)
  assert.match(out.text, /Translated the docx file into Vietnamese\. Output: .*report\.vi\.docx/)
  assert.match(out.text, /Layout check: not done \(turned off\)\. Do not say the layout was verified\./)
  assert.match(out.text, /do not claim the result is identical/)
})

test('the Session policy is asked for through the service and the write is allowed under workspace-write', async () => {
  const w = workspace()
  writeFileSync(join(w.ws, 'a.docx'), buildDocx())
  const out = await translateDocument(input(w, { path: 'a.docx', target_language: 'English' }))
  assert.equal(out.file, join(w.ws, 'a.en.docx'))
  assert.deepEqual(w.requests[0], { session: { id: 's1' } })
})

test('an uploaded file in the attachment store is translated and the result goes to the working directory', async () => {
  const w = workspace()
  writeFileSync(join(w.store, 'My Report (v2).docx'), buildDocx())
  const out = await translateDocument(input(w, { path: join(w.store, 'My Report (v2).docx'), target_language: 'Vietnamese' }))
  assert.equal(out.file, join(w.ws, 'My Report (v2).vi.docx'))
  assert.deepEqual(readdirSync(w.store), ['My Report (v2).docx'], 'nothing is written into the store')
})

test('a Session that may not write is told before any model call is spent', async () => {
  const w = workspace('read-only')
  writeFileSync(join(w.ws, 'a.docx'), buildDocx())
  let calls = 0
  const counting = { chat: async () => { calls++; return { text: '[]', usage: {} } } }
  await assert.rejects(translateDocument(input(w, { path: 'a.docx', target_language: 'English' }, { llm: counting })), (e) => e.code === 'FS_SANDBOX_DENIED')
  assert.equal(calls, 0, 'the check runs before the translation')
})

test('without a confining filesystem there is no policy and the write is allowed', async () => {
  const w = workspace()
  writeFileSync(join(w.ws, 'a.docx'), buildDocx())
  const out = await translateDocument({ ...input(w, { path: 'a.docx', target_language: 'English' }), sandboxPolicy: undefined })
  assert.equal(out.file, join(w.ws, 'a.en.docx'))
})

test('a read-only Session cannot receive the output, and the failure says why', async () => {
  const w = workspace('read-only')
  writeFileSync(join(w.ws, 'report.docx'), buildDocx())
  await assert.rejects(translateDocument(input(w, { path: 'report.docx', target_language: 'Vietnamese' })), (e) => e.code === 'FS_SANDBOX_DENIED' && /read-only/.test(e.message))
})

test('unsupported and legacy extensions are explained before any model call', async () => {
  const w = workspace()
  let calls = 0
  const counting = { chat: async () => { calls++; return { text: '[]', usage: {} } } }
  await assert.rejects(translateDocument(input(w, { path: 'a.doc', target_language: 'English' }, { llm: counting })), /old binary format; convert it to \.docx/)
  await assert.rejects(translateDocument(input(w, { path: 'a.txt', target_language: 'English' }, { llm: counting })), /\.txt is not supported; supported: \.docx, \.pptx, \.xlsx, \.pdf/)
  await assert.rejects(translateDocument(input(w, { path: 'noext', target_language: 'English' }, { llm: counting })), /\.\(none\) is not supported/)
  assert.equal(calls, 0)
})

test('notes tell about a language the font check does not know and about right-to-left text', async () => {
  const w = workspace()
  writeFileSync(join(w.ws, 'a.docx'), buildDocx())
  const unknown = await translateDocument(input(w, { path: 'a.docx', target_language: 'Klingon' }))
  assert.match(unknown.text, /Note: "Klingon" is not a language the font check knows/)
  const rtl = await translateDocument(input(w, { path: 'a.docx', target_language: 'Arabic' }))
  assert.match(rtl.text, /right-to-left language: the text is translated but the layout is not mirrored/)
})

test('a docx saved with the wrong extension is reported, and a file with no text is reported', async () => {
  const w = workspace()
  writeFileSync(join(w.ws, 'mislabeled.xlsx'), buildDocx())
  await assert.rejects(translateDocument(input(w, { path: 'mislabeled.xlsx', target_language: 'English' })), /does not match the content, which is a docx/)
  writeFileSync(join(w.ws, 'empty.docx'), buildDocx({ body: ['<w:p><w:r><w:t>123</w:t></w:r></w:p>'] }))
  await assert.rejects(translateDocument(input(w, { path: 'empty.docx', target_language: 'English' })), /no translatable text/)
})

test('configuration that cannot work is refused by name', () => {
  assert.doesNotThrow(() => validateConfig(CONFIG))
  assert.throws(() => validateConfig({ ...CONFIG, translationModels: [] }), /translationModels/)
  assert.throws(() => validateConfig({ ...CONFIG, baseUrl: 'https://x/v1/' }), /must not end with a slash/)
  assert.throws(() => validateConfig({ ...CONFIG, modelConcurrency: { T: 0 } }), /modelConcurrency for T/)
})

test('every failure ends with the instruction to report and stop, and keeps its code', async () => {
  const w = workspace('read-only')
  writeFileSync(join(w.ws, 'a.docx'), buildDocx())
  await assert.rejects(translateDocument(input(w, { path: 'a.docx', target_language: 'English' })), (e) => e.code === 'FS_SANDBOX_DENIED' && e.message.endsWith(STOP_GUIDANCE) && /read-only mode\. Report this/.test(e.message))
  await assert.rejects(translateDocument(input(w, { path: 'missing.docx', target_language: 'English' })), (e) => /file not found: missing\.docx\. Report this to the user/.test(e.message))
  await assert.rejects(translateDocument(input(w, { path: 'a.txt', target_language: 'English' })), /not supported; supported: .*\. Report this to the user/)
})

test('guidance is added once, and a cancelled call is not wrapped', async () => {
  const once = explain(new Error('boom'))
  assert.equal(explain(once), once)
  assert.equal(once.message, `boom.${STOP_GUIDANCE}`)
  const w = workspace()
  writeFileSync(join(w.ws, 'a.docx'), buildDocx())
  w.exec.signal = AbortSignal.abort(new Error('cancelled by user'))
  const failing = { chat: async () => { throw new Error('aborted') } }
  await assert.rejects(translateDocument(input(w, { path: 'a.docx', target_language: 'English' }, { llm: failing })), (e) => !e.message.includes('Report this to the user'))
})
