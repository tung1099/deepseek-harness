import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { assertWritable, chooseOutputDirectory, readInput, writeOutput } from '../io.js'

let root
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined })
const make = () => { root = mkdtempSync(join(tmpdir(), 'io-test-')); mkdirSync(join(root, 'ws')); mkdirSync(join(root, 'outside')); return root }

test('no policy and danger-full-access allow any directory', async () => {
  make()
  await assertWritable(undefined, join(root, 'outside'))
  await assertWritable({ mode: 'danger-full-access', workspaceRoot: join(root, 'ws') }, join(root, 'outside'))
})

test('read-only refuses every write', async () => {
  make()
  await assert.rejects(assertWritable({ mode: 'read-only', workspaceRoot: join(root, 'ws') }, join(root, 'ws')), (e) => e.code === 'FS_SANDBOX_DENIED' && /read-only/.test(e.message))
})

test('workspace-write allows the workspace and extra roots and refuses everything else', async () => {
  make()
  const policy = { mode: 'workspace-write', workspaceRoot: join(root, 'ws') }
  await assertWritable(policy, join(root, 'ws'))
  mkdirSync(join(root, 'ws', 'sub'))
  await assertWritable(policy, join(root, 'ws', 'sub'))
  await assert.rejects(assertWritable(policy, join(root, 'outside')), (e) => e.code === 'FS_SANDBOX_DENIED' && /outside the workspace/.test(e.message))
  await assertWritable({ ...policy, additionalWritableRoots: [join(root, 'outside')] }, join(root, 'outside'))
})

test('a symbolic link inside the workspace cannot lead the write outside it', async () => {
  make()
  symlinkSync(join(root, 'outside'), join(root, 'ws', 'escape'))
  await assert.rejects(assertWritable({ mode: 'workspace-write', workspaceRoot: join(root, 'ws') }, join(root, 'ws', 'escape')), /outside the workspace/)
})

test('output is named name.lang.ext and never replaces an existing file', async () => {
  make()
  const input = join(root, 'ws', 'report.docx')
  writeFileSync(input, 'in')
  const base = { directory: join(root, 'ws'), inputHostPath: input, suffix: 'vi', extension: '.docx', policy: undefined }
  const first = await writeOutput({ ...base, bytes: Buffer.from('one') })
  const second = await writeOutput({ ...base, bytes: Buffer.from('two') })
  assert.equal(first, join(root, 'ws', 'report.vi.docx'))
  assert.equal(second, join(root, 'ws', 'report.vi-2.docx'))
  assert.equal(readFileSync(first, 'utf8'), 'one')
  assert.deepEqual(readdirSync(join(root, 'ws')).sort(), ['report.docx', 'report.vi-2.docx', 'report.vi.docx'], 'no temporary file is left')
})

test('a refused write leaves nothing behind', async () => {
  make()
  const input = join(root, 'ws', 'a.docx')
  writeFileSync(input, 'in')
  await assert.rejects(writeOutput({ directory: join(root, 'ws'), inputHostPath: input, suffix: 'vi', extension: '.docx', bytes: Buffer.from('x'), policy: { mode: 'read-only', workspaceRoot: join(root, 'ws') } }), /read-only/)
  assert.deepEqual(readdirSync(join(root, 'ws')), ['a.docx'])
})

test('the output goes beside an input inside the working directory, and into the working directory for any other input', async () => {
  make()
  mkdirSync(join(root, 'ws', 'sub'))
  writeFileSync(join(root, 'ws', 'sub', 'a.docx'), 'x')
  writeFileSync(join(root, 'outside', 'upload.pdf'), 'x')
  assert.equal(await chooseOutputDirectory(join(root, 'ws', 'sub', 'a.docx'), join(root, 'ws')), join(root, 'ws', 'sub'))
  assert.equal(await chooseOutputDirectory(join(root, 'ws', 'a.docx'), join(root, 'ws')), join(root, 'ws'))
  assert.equal(await chooseOutputDirectory(join(root, 'outside', 'upload.pdf'), join(root, 'ws')), join(root, 'ws'), 'an uploaded file sits in the attachment store')
  assert.equal(await chooseOutputDirectory(join(root, 'gone', 'x.pdf'), join(root, 'ws')), join(root, 'ws'))
})

const fakeCtx = (files, host = '/work/in.docx') => ({
  workingDirectory: { ensure: async () => '/work' },
  fs: {
    resolve: async (path, { cwd }) => ({ displayPath: `${cwd}/${path}` }),
    stat: async (target) => files.get(target.displayPath),
    readBytes: async (target, _signal, max) => { const f = files.get(target.displayPath); if (f.bytes.length > max) throw new Error('too big'); return f.bytes },
    processPath: () => host,
  },
})
const exec = { agent: {}, signal: new AbortController().signal }

test('input is read through the fs service with size and type checks', async () => {
  const files = new Map([['/work/in.docx', { type: 'file', size: 3, bytes: Buffer.from('abc') }], ['/work/dir', { type: 'directory' }], ['/work/big.docx', { type: 'file', size: 999, bytes: Buffer.alloc(999) }]])
  const out = await readInput(fakeCtx(files), exec, 'in.docx', 100)
  assert.equal(out.bytes.toString(), 'abc')
  assert.equal(out.hostPath, '/work/in.docx')
  await assert.rejects(readInput(fakeCtx(files), exec, 'missing.docx', 100), /file not found/)
  await assert.rejects(readInput(fakeCtx(files), exec, 'dir', 100), /not a regular file/)
  await assert.rejects(readInput(fakeCtx(files), exec, 'big.docx', 100), /999 bytes; the limit is 100/)
  await assert.rejects(readInput(fakeCtx(files, 'ssh://host/in.docx'), exec, 'in.docx', 100), /not on this machine/)
})
