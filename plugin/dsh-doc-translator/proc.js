/**
 * Runs the external programs the translator relies on (`soffice`, `pdftoppm`,
 * `pdfinfo`, `fc-list`, `python3`). Programs run with a fixed argument list and
 * no shell, so a file name can never be read as a command.
 *
 * @module dsh-doc-translator/proc
 */

import { execFile } from 'node:child_process'

/**
 * Run a program and collect its output.
 * @param {string} file - program name.
 * @param {string[]} args - arguments, passed as given.
 * @param {{ timeoutMs?: number, signal?: AbortSignal, cwd?: string }} [options] - limits; the default timeout is 120 seconds.
 * @returns {Promise<{ stdout: string, stderr: string }>} output of a program that exited with status 0.
 */
export function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeoutMs ?? 120_000, signal: options.signal, cwd: options.cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const reason = error.code === 'ENOENT' ? `${file} is not installed` : (error.killed ? `${file} timed out` : `${file} failed: ${(stderr || error.message).trim().slice(0, 300)}`)
        reject(Object.assign(new Error(reason), { code: error.code, cause: error }))
      } else resolve({ stdout, stderr })
    })
  })
}
