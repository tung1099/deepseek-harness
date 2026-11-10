/**
 * Writes the HTML report into the Session working directory under the
 * Session's own sandbox policy.
 *
 * The file name is fixed (`fin-report-<TICKER>.html`), so the model never
 * chooses a path. The write passes the Session's standing policy, as
 * `dsh-tool-fs` does for its `write` tool; without it the filesystem provider
 * falls back to the deployment default root, which is not the Session
 * directory. The tool never asks to escalate: a denial is reported, not retried.
 *
 * @module dsh-financial-analyst/deliver
 */

/**
 * Write the report file.
 * @param {{ fs: object, workingDirectory: object }} ctx - the `fs` and `workingDirectory` services.
 * @param {{ resolve(request: { session: object }): object } | undefined} sandboxPolicy - the policy service, or `undefined` when no confining filesystem is mounted.
 * @param {{ agent: object, signal: AbortSignal }} exec - tool execution context.
 * @param {string} ticker - normalized ticker used in the file name.
 * @param {string} html - the report document.
 * @returns {Promise<{ file: string, reason: null } | { file: null, reason: string }>} the written path, or why the write was refused (a filesystem error such as a sandbox denial).
 */
export async function writeReport(ctx, sandboxPolicy, exec, ticker, html) {
  const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  const target = await ctx.fs.resolve(`fin-report-${ticker}.html`, { cwd, signal: exec.signal })
  const policy = sandboxPolicy?.resolve({ session: exec.agent.session })
  try {
    await ctx.fs.writeText(target, html, undefined, exec.signal, policy)
  } catch (error) {
    // Only filesystem failures (FS_*) are reported; anything else is a defect and propagates.
    if (exec.signal.aborted || typeof error?.code !== 'string' || !error.code.startsWith('FS_')) throw error
    return { file: null, reason: error.message }
  }
  return { file: ctx.fs.processPath(target), reason: null }
}
