/**
 * Trace the Session log write path.
 *
 * The log file shows what was written; it does not show when, in what batch, or
 * at which checkpoint. This plugin observes the three write-path events Cordis
 * exposes and writes one line per occurrence to a trace file:
 *
 *   `session/created`   a session entered the store
 *   `session/event`     one append committed — post-commit and fire-and-forget,
 *                       so observing it cannot fail or delay the append
 *   `session/flush`     the awaited durability checkpoint the agent loop uses
 *                       before claiming the next turn
 *
 * Batching is inferred from what the events themselves show: `pending` counts
 * appends since the previous flush, and `file` is the log's size on disk at
 * that moment. The size stays flat while appends accumulate in the backend's
 * write-behind window, then jumps when a Zstandard frame lands — that jump is
 * the batch.
 *
 * `session/flush` is a parallel event whose caller awaits every listener, so
 * this listener only records a timestamp and returns. The post-flush file size
 * is sampled shortly after, outside the checkpoint.
 *
 * The log path is found by globbing `$DSH_HOME/sessions`, not through the
 * persistence seam: a second write handle would be refused, and `stat` would
 * couple an observer to a service it has no business holding.
 */

import { createWriteStream, statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'session-writer-trace'
export const inject = ['sessions']

const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

/**
 * Locate one session's log file under the sessions root.
 * @param {string} sessionId - the session's id, as it appears in its directory name.
 * @returns {string | null} absolute path, or null while the backend has not materialized it yet.
 */
function findLog(sessionId) {
  let projects
  try {
    projects = readdirSync(SESSIONS_ROOT)
  } catch (error) {
    void error // sessions root absent: nothing has been persisted yet
    return null
  }
  for (const project of projects) {
    const dir = join(SESSIONS_ROOT, project, sessionId)
    let names
    try {
      names = readdirSync(dir)
    } catch (error) {
      void error // not this project
      continue
    }
    const log = names.find(entry => entry.startsWith('session.') && entry.includes('.jsonl'))
    if (log !== undefined) return join(dir, log)
  }
  return null
}

/** Size of a file right now, or null when it does not exist yet. */
function sizeOf(path) {
  if (path === null) return null
  try {
    return statSync(path).size
  } catch (error) {
    void error // not materialized yet
    return null
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ file?: string, stdout?: boolean, postFlushDelayMs?: number }} [config]
 *   `file`: where to append the trace (default `$DSH_HOME/session-write-trace.log`).
 *   `stdout`: also print each line to the process's stdout.
 *   `postFlushDelayMs`: how long after a checkpoint to sample the file size again.
 */
export function apply(ctx, config = {}) {
  const file = config.file ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'session-write-trace.log')
  const postFlushDelayMs = config.postFlushDelayMs ?? 60
  const stream = createWriteStream(file, { flags: 'a' })
  ctx.effect(() => () => stream.end())

  const write = (line) => {
    stream.write(`${line}\n`)
    if (config.stdout === true) console.log(line)
  }

  /** sessionId -> write-path bookkeeping */
  const state = new Map()
  const stateOf = (session) => {
    let entry = state.get(session.id)
    if (entry === undefined) {
      entry = { log: null, t0: Date.now(), last: Date.now(), pending: 0, appends: 0, bytes: 0, flushes: 0, pendingBytes: 0 }
      state.set(session.id, entry)
    }
    if (entry.log === null) entry.log = findLog(session.id)
    return entry
  }

  const stamp = (entry) => String(Date.now() - entry.t0).padStart(8)

  ctx.on('session/created', (session) => {
    const entry = stateOf(session)
    write('')
    write(`════ session ${session.id}  ${new Date().toISOString()}`)
    write(`     log: ${entry.log ?? '(chưa materialize — backend hoãn tới append đầu tiên)'}`)
    write(`     ${'+ms'.padStart(8)}  ${'seq'.padStart(4)}  ${'event'.padEnd(30)} ${'byte'.padStart(7)}  ${'Δt'.padStart(6)}  surface  pending  file trên đĩa`)
  })

  ctx.on('session/event', (session, event) => {
    const entry = stateOf(session)
    const now = Date.now()
    const bytes = JSON.stringify(event).length
    entry.appends += 1
    entry.bytes += bytes
    entry.pending += 1
    entry.pendingBytes += bytes
    const surface = event.surfaceOp === undefined ? '    -   ' : String(event.surfaceOp.op ?? event.surfaceOp).padEnd(8)
    const size = sizeOf(entry.log)
    write(
      `     ${stamp(entry)}  ${String(event.seq).padStart(4)}  ${String(event.type).padEnd(30)} ${String(bytes).padStart(7)}  ${String(now - entry.last).padStart(5)}ms  ${surface} ${String(entry.pending).padStart(6)}   ${size === null ? '(chưa có file)' : `${size} B`}`,
    )
    entry.last = now
  })

  ctx.on('session/flush', (session) => {
    const entry = stateOf(session)
    const batch = entry.pending
    const batchBytes = entry.pendingBytes
    const before = sizeOf(entry.log)
    entry.pending = 0
    entry.pendingBytes = 0
    entry.flushes += 1
    write(`     ${stamp(entry)}  ──── FLUSH #${entry.flushes}: checkpoint cho ${batch} append (${batchBytes} B JSON), file lúc này ${before === null ? '(chưa có)' : `${before} B`}`)
    // Sampled outside the checkpoint: this listener must return at once, because
    // the caller awaits every session/flush listener before continuing the loop.
    setTimeout(() => {
      if (entry.log === null) entry.log = findLog(session.id)
      const after = sizeOf(entry.log)
      const delta = before !== null && after !== null ? after - before : null
      write(`     ${stamp(entry)}  ──── sau flush ${postFlushDelayMs}ms: file ${after === null ? '(chưa có)' : `${after} B`}${delta === null ? '' : ` (+${delta} B nén)`}`)
    }, postFlushDelayMs).unref?.()
  })

  ctx.on('session/disposed', (session) => {
    const entry = state.get(session.id)
    if (entry === undefined) return
    state.delete(session.id)
    write(`════ xong ${session.id}: ${entry.appends} append, ${entry.bytes} B JSON, ${entry.flushes} flush, file ${sizeOf(entry.log) ?? '?'} B`)
  })
}
