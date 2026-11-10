/**
 * Live view of a translation in progress.
 *
 * While `doc_translate` runs, its progress is written into one directory in the
 * Session working directory, named from the tool call id by {@link liveDirName}:
 *
 * - `state.json`: `{ version: 1, kind, status, source, output?, error?, pages?, segments? }`.
 *   `kind` is `'pages'` for PDFs and images and `'segments'` for Office files;
 *   `status` is `'running'`, `'done'` or `'failed'`. A page is
 *   `{ original, translated? }` (file names in the directory); a segment is
 *   `{ s, t? }`, its source text and, once translated, its translation, in
 *   document order.
 * - `o-<n>.<ext>` and `t-<n>.<ext>`: the original and the translated image of page `n`.
 *
 * Every file is written whole through a temporary file, and `state.json` names
 * an image only after the image is complete, so a reader never sees a partial
 * file. Each image is written once; only `state.json` changes. The browser half
 * of this package (`client.js`) derives the same directory from the call id,
 * polls `state.json`, and shows each page or line as it is finished.
 *
 * A failed write stops the live view and never fails the translation.
 * Directories older than the retention period are removed when the next call
 * starts.
 *
 * @module dsh-doc-translator/live
 */

import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

/** Name prefix of every live directory; `client.js` repeats it. */
export const LIVE_PREFIX = '.dsh-translating-'

/** Marker characters of formatted spans, which the live view does not show. */
const MARKER = /⟦\/?\d+⟧/g

/**
 * Name of the live directory of one tool call. `client.js` computes the same
 * name from the call id, so both rules must change together.
 * @param {string} callId - tool call id.
 * @returns {string} a hidden directory name such as `.dsh-translating-call_1`.
 */
export function liveDirName(callId) {
  return `${LIVE_PREFIX}${String(callId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}`
}

/** Write `path` whole: a reader sees the old file or the new one, never a part. */
async function replaceFile(path, write) {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await write(temp)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Remove live directories older than `maxAgeMs` from `directory`.
 * @param {string} directory - the Session working directory.
 * @param {number} maxAgeMs - age after which a live directory is removed.
 * @param {number} [now] - current time in epoch milliseconds.
 * @returns {Promise<void>} settles after the removals; an unreadable directory or entry is skipped.
 */
export async function pruneLiveViews(directory, maxAgeMs, now = Date.now()) {
  let names
  try { names = await readdir(directory) } catch { return } // An unreadable directory has nothing this package can prune.
  for (const name of names) {
    if (!name.startsWith(LIVE_PREFIX)) continue
    const path = join(directory, name)
    try {
      if (now - (await stat(path)).mtimeMs > maxAgeMs) await rm(path, { recursive: true, force: true })
    } catch { /* An entry removed or changed meanwhile is left to the next call. */ }
  }
}

/**
 * Open the live view of one call. Every method returns at once; the writes run
 * in order behind it. `segments`' updates are written at most once per
 * `intervalMs`, the latest one only; page events and the final status are written
 * as they come. `settled()` resolves when every queued write is done.
 * @param {{ dir: string, kind: 'pages' | 'segments', source: string, intervalMs: number }} input - live directory (created here), view kind, input file name shown to the user, and least time between two segment updates.
 * @returns {object} the live view controller.
 */
export function createLiveView({ dir, kind, source, intervalMs }) {
  const state = { version: 1, kind, status: 'running', source, ...(kind === 'pages' ? { pages: [] } : { segments: [] }) }
  let chain = mkdir(dir, { recursive: true }).then(() => writeState()).catch(fail)
  let failure
  let closed = false
  let pendingSegments
  let timer
  let lastSegments = -Infinity

  function fail(error) {
    failure ??= error instanceof Error ? error.message : String(error)
  }
  function writeState() {
    return replaceFile(join(dir, 'state.json'), temp => writeFile(temp, JSON.stringify(state)))
  }
  /** Queue one step and a state write after it, unless an earlier step failed; resolves when both are done. */
  function queue(step) {
    return chain = chain.then(async () => {
      if (failure !== undefined) return
      try {
        await step()
        await writeState()
      } catch (error) { fail(error) }
    })
  }
  function flushSegments() {
    timer = undefined
    const build = pendingSegments
    pendingSegments = undefined
    if (build === undefined) return
    queue(async () => {
      state.segments = build()
      lastSegments = Date.now()
    })
  }

  return {
    get failure() { return failure },
    /**
     * Show the original pages; `images` are image paths in page order.
     * @returns {Promise<void>} resolves once the images are copied, or the view has failed.
     */
    pages(images) {
      if (closed) return chain
      return queue(async () => {
        const names = images.map((image, i) => `o-${i + 1}${extname(image)}`)
        for (const [i, image] of images.entries()) await replaceFile(join(dir, names[i]), temp => copyFile(image, temp))
        state.pages = names.map(original => ({ original }))
      })
    },
    /**
     * Show the translated image of page `index` (0-based).
     * @returns {Promise<void>} resolves once the image is copied, or the view has failed.
     */
    page(index, image) {
      if (closed) return chain
      return queue(async () => {
        const name = `t-${index + 1}${extname(image)}`
        await replaceFile(join(dir, name), temp => copyFile(image, temp))
        state.pages[index] = { ...state.pages[index], translated: name }
      })
    },
    /**
     * Show the segments; `build` returns `{ s, t? }` rows in document order. Marker
     * characters are removed from the texts.
     */
    segments(build) {
      if (closed) return
      pendingSegments = () => build().map(row => (row.t === undefined
        ? { s: row.s.replace(MARKER, '') }
        : { s: row.s.replace(MARKER, ''), t: row.t.replace(MARKER, '') }))
      if (timer !== undefined) return
      timer = setTimeout(flushSegments, Math.max(0, lastSegments + intervalMs - Date.now()))
    },
    /**
     * Mark the view finished, write the last segments, and wait for every write.
     * @param {{ status: 'done' | 'failed', output?: string, error?: string }} result - final status, the translated file, or the failure shown to the user.
     */
    async close(result) {
      if (closed) return chain
      if (timer !== undefined) clearTimeout(timer)
      flushSegments()
      closed = true
      queue(async () => { Object.assign(state, result) })
      await chain
    },
  }
}
