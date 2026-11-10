import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeReport } from '../deliver.js'
import { renderText } from '../summary.js'
import { analyze } from '../analyze.js'
import { CONFIG, NOW, makeCompany, makeFetch } from './fixtures.js'

const SESSION = { id: 'session-1' }
const CWD = '/home/u/Documents/ws'

/** Services shaped like the real ones: the writer refuses when the policy does not cover the target. */
function services({ mode = 'workspace-write', failWith } = {}) {
  const writes = []
  const policyRequests = []
  const fs = {
    resolve: async (path, { cwd }) => ({ displayPath: `${cwd}/${path}` }),
    processPath: target => target.displayPath,
    writeText: async (target, content, expected, signal, policy) => {
      writes.push({ target, content, policy })
      if (failWith) throw failWith
      // Without a session policy the provider falls back to a deployment root that does not contain the session directory.
      const root = policy?.workspaceRoot ?? '/home/u/default-root'
      if (policy?.mode === 'read-only' || !target.displayPath.startsWith(root)) {
        throw Object.assign(new Error(`cannot write "${target.displayPath}": file access denied under ${policy?.mode ?? 'workspace-write'} mode`), { code: 'FS_SANDBOX_DENIED' })
      }
    },
  }
  const workingDirectory = { ensure: async () => CWD }
  const sandboxPolicy = { resolve: (request) => { policyRequests.push(request); return { mode, workspaceRoot: CWD } } }
  return { ctx: { fs, workingDirectory }, sandboxPolicy, writes, policyRequests }
}

const exec = () => ({ agent: { session: SESSION }, signal: new AbortController().signal })

test('the report is written under the Session policy at a fixed file name', async () => {
  const { ctx, sandboxPolicy, writes, policyRequests } = services()
  const result = await writeReport(ctx, sandboxPolicy, exec(), 'FPT', '<html></html>')
  assert.deepEqual(result, { file: `${CWD}/fin-report-FPT.html`, reason: null })
  assert.deepEqual(policyRequests, [{ session: SESSION }])
  assert.equal(writes[0].policy.workspaceRoot, CWD)
  assert.equal(writes[0].content, '<html></html>')
})

test('without the Session policy the write is refused, which is why the policy must be passed', async () => {
  const { ctx, writes } = services()
  const result = await writeReport(ctx, undefined, exec(), 'FPT', 'x')
  assert.equal(result.file, null)
  assert.match(result.reason, /file access denied under workspace-write mode/)
  assert.equal(writes[0].policy, undefined)
})

test('a read-only Session refuses the write and the reason is reported, not thrown', async () => {
  const { ctx, sandboxPolicy } = services({ mode: 'read-only' })
  const result = await writeReport(ctx, sandboxPolicy, exec(), 'FPT', 'x')
  assert.equal(result.file, null)
  assert.match(result.reason, /read-only/)
})

test('failures that are not filesystem errors propagate', async () => {
  const { ctx, sandboxPolicy } = services({ failWith: new TypeError('boom') })
  await assert.rejects(writeReport(ctx, sandboxPolicy, exec(), 'FPT', 'x'), /boom/)
})

test('a cancelled call propagates even for a filesystem error', async () => {
  const { ctx, sandboxPolicy } = services({ failWith: Object.assign(new Error('aborted'), { code: 'FS_ABORTED' }) })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(writeReport(ctx, sandboxPolicy, { agent: { session: SESSION }, signal: controller.signal }, 'FPT', 'x'), /aborted/)
})

test('the model digest tells the agent not to call present when the file was not written', async () => {
  const industries = [{ level: 4, code: '1', name: 'N', tickers: ['AAA'] }]
  const original = globalThis.fetch
  globalThis.fetch = makeFetch([makeCompany({ ticker: 'AAA', price: 60, shares: 100, industries })])
  try {
    const analysis = await analyze(CONFIG, { ticker: 'AAA', maxPeers: 0 }, new AbortController().signal, NOW)
    const missing = renderText(analysis, null, 'cannot write: denied')
    assert.match(missing, /Report file NOT written: cannot write: denied\. Do not call present/)
    assert.doesNotMatch(missing, /Report file: /)
    assert.match(renderText(analysis, '/ws/fin-report-AAA.html'), /Report file: \/ws\/fin-report-AAA\.html/)
  } finally { globalThis.fetch = original }
})
