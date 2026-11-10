/**
 * File access for the translator tool.
 *
 * Input is read through the harness `fs` service. The `fs` service writes text
 * only, so output bytes are written here with the Session's own sandbox policy
 * enforced by `assertWritable`: no write under `read-only`, and under
 * `workspace-write` only below the workspace root or an extra writable root,
 * after resolving symbolic links.
 *
 * @module dsh-doc-translator/io
 */

import { randomBytes } from 'node:crypto'
import { access, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'

/** True when `child` is `parent` or lies below it. */
function isUnder(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * Refuse a write the Session's sandbox policy does not allow.
 * @param {{ mode: string, workspaceRoot: string, additionalWritableRoots?: readonly string[] } | undefined} policy - the Session policy, or `undefined` when no confining filesystem is mounted.
 * @param {string} directory - directory that will receive the file; it must exist.
 * @throws {Error} with `code: 'FS_SANDBOX_DENIED'` when the policy forbids the write.
 */
export async function assertWritable(policy, directory) {
  if (policy === undefined || policy.mode === 'danger-full-access') return
  const deny = reason => Object.assign(new Error(`cannot write in "${directory}": file access denied under ${policy.mode} mode${reason ? ` (${reason})` : ''}`), { code: 'FS_SANDBOX_DENIED' })
  if (policy.mode !== 'workspace-write') throw deny()
  const real = await realpath(directory)
  for (const root of [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])]) {
    let realRoot
    try { realRoot = await realpath(root) } catch { continue }
    if (isUnder(realRoot, real)) return
  }
  throw deny('outside the workspace')
}

/** A host path the process can open, from a filesystem target, or an error for a remote backend. */
function hostPathOf(ctx, target) {
  const path = ctx.fs.processPath(target)
  if (!isAbsolute(path)) throw new Error('the working directory is not on this machine, so the translator cannot read or write files there')
  return path
}

/**
 * Read an input file under the working directory.
 * @param {{ fs: object, workingDirectory: object }} ctx - the `fs` and `workingDirectory` services.
 * @param {{ agent: object, signal: AbortSignal }} exec - tool execution context.
 * @param {string} path - path given by the model; relative paths resolve against the Session directory.
 * @param {number} maxBytes - largest file accepted.
 * @returns {Promise<{ bytes: Buffer, hostPath: string }>} file bytes and the host path.
 */
export async function readInput(ctx, exec, path, maxBytes) {
  const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (!info) throw new Error(`file not found: ${path}`)
  if (info.type !== 'file') throw new Error(`${path} is not a regular file`)
  if (typeof info.size === 'number' && info.size > maxBytes) throw new Error(`${path} is ${info.size} bytes; the limit is ${maxBytes}`)
  const bytes = Buffer.from(await ctx.fs.readBytes(target, exec.signal, maxBytes))
  return { bytes, hostPath: hostPathOf(ctx, target) }
}

/** First of `name`, `name-2`, `name-3`… that does not exist in `directory`. */
async function freeName(directory, stem, extension) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}${extension}` : `${stem}-${n}${extension}`
    try { await access(join(directory, name)) } catch { return name }
  }
}

/**
 * Pick the directory for the output. Next to the input when the input lies in
 * the Session working directory; otherwise the working directory itself. An
 * uploaded file lives in the attachment store, which is neither writable nor a
 * place for results.
 * @param {string} inputHostPath - host path of the input file.
 * @param {string} workingDirectory - host path of the Session working directory.
 * @returns {Promise<string>} the directory to write into.
 */
export async function chooseOutputDirectory(inputHostPath, workingDirectory) {
  const beside = dirname(inputHostPath)
  try {
    if (isUnder(await realpath(workingDirectory), await realpath(beside))) return beside
  } catch { /* the input directory is not reachable: use the working directory */ }
  return workingDirectory
}

/**
 * Write an output file without replacing an existing file.
 * @param {{ directory: string, inputHostPath: string, suffix: string, extension: string, bytes: Buffer, policy: object | undefined }} input - target directory, input path (its name becomes the output name), language suffix such as `vi`, extension with the dot, file content, and the resolved Session sandbox policy.
 * @returns {Promise<string>} host path of the written file, named `<input name>.<suffix><extension>`.
 */
export async function writeOutput({ directory, inputHostPath, suffix, extension, bytes, policy }) {
  await assertWritable(policy, directory)
  const stem = `${basename(inputHostPath, extname(inputHostPath))}.${suffix}`
  const name = await freeName(directory, stem, extension)
  const finalPath = join(directory, name)
  const temp = join(directory, `.${name}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(temp, bytes, { flag: 'wx' })
    await rename(temp, finalPath)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  return finalPath
}
