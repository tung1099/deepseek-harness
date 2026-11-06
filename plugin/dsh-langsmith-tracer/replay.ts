/**
 * Replay a cold DSH session log through the real surface fold, to see how the
 * log becomes the history a model saw.
 *
 * It imports `foldSurface` and `deriveEventMessage` from `@deepseek-ai/dsh-session`
 * instead of reimplementing them, so what it prints is what the harness itself
 * derives. Run it from the repository root, where the workspace resolves those
 * imports:
 *
 *   node --import tsx/esm plugin/dsh-langsmith-tracer/replay.ts <log> [options]
 *
 *   (no option)   classify every event, then print the final surface
 *   --requests    for each model call, the exact history that went into it
 *   --at <seq>    the messages a model would see folding only seq 0..<seq>
 *   --full        do not truncate message previews
 *
 * `<log>` is a `session.vN.jsonl[.zstd]` path; a compressed log is decoded with
 * `zstdcat`, and a torn tail from an interrupted write stops the read there.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  deriveEventMessage,
  foldSurface,
  isAppendSurfaceEvent,
  isReplacementSurfaceEvent,
  isSurfaceEvent,
  pluginRecordOf,
  SessionSeq,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'

/** Decoded log: the header line plus the events whose index equals their seq. */
interface Decoded {
  header: Record<string, unknown>
  events: SessionEvent[]
  /** Lines after the first one that failed to parse, which a torn tail produces. */
  stoppedAt: number | null
}

/**
 * Decode one session log file into its header and contiguous events.
 * @param path - absolute or relative path to a `session.vN.jsonl[.zstd]` log.
 * @returns the parsed header, the events in seq order, and where parsing stopped.
 */
function decode(path: string): Decoded {
  let text: string
  if (path.endsWith('.zstd')) {
    const run = spawnSync('zstdcat', ['-q', path], { maxBuffer: 1 << 30 })
    if (run.error !== undefined) throw new Error(`zstdcat failed: ${run.error.message}`)
    text = run.stdout.toString('utf8')
  } else {
    text = readFileSync(path, 'utf8')
  }

  const lines = text.split('\n').filter(line => line.length > 0)
  let header: Record<string, unknown> = {}
  const events: SessionEvent[] = []
  let stoppedAt: number | null = null

  for (const [index, line] of lines.entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      stoppedAt = index
      break
    }
    const row = parsed as Record<string, unknown>
    if (index === 0 && row['type'] === 'session') {
      header = row
      continue
    }
    if (typeof row['type'] !== 'string' || typeof row['seq'] !== 'number') {
      stoppedAt = index
      break
    }
    events.push(row as unknown as SessionEvent)
  }

  for (const [index, event] of events.entries()) {
    if (event.seq !== index) {
      throw new Error(`log is not contiguous: index ${index} holds seq ${event.seq}; the fold requires seq === index`)
    }
  }
  return { header, events, stoppedAt }
}

/** Flatten message content blocks into one line of readable text. */
function textOf(message: { content?: unknown }): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: Record<string, unknown>) => {
      if (block['type'] === 'text') return String(block['text'] ?? '')
      if (block['type'] === 'tool-call') return `[tool-call ${String(block['name'])} ${String(block['arguments'])}]`
      return `[${String(block['type'])}]`
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Clip text for one terminal line unless --full was passed. */
function clip(text: string, full: boolean, width = 96): string {
  return full || text.length <= width ? text : `${text.slice(0, width)}…`
}

/**
 * Classify one event the way the fold does, using the shipped predicates.
 * @param event - the event to classify.
 * @returns a short label for its role in the log.
 */
function classify(event: SessionEvent): string {
  const record = pluginRecordOf(event)
  if (record !== undefined) return `plugin record${event.ignorable === true ? ', ignorable' : ''}`
  if (isReplacementSurfaceEvent(event)) {
    const op = event.surfaceOp
    const span = typeof op === 'object' ? `${op.startSeq}..${op.endSeq}` : '?'
    return `SURFACE replace ${span}`
  }
  if (isAppendSurfaceEvent(event)) return 'SURFACE append'
  if (isSurfaceEvent(event)) return 'SURFACE'
  return event.ignorable === true ? 'log-only, ignorable' : 'log-only'
}

/** Derive the model-visible messages for one folded prefix. */
function messagesOf(events: SessionEvent[], upTo: number) {
  const prefix = events.slice(0, upTo)
  const fold = foldSurface(prefix, currentSessionMessageProjections)
  const messages = fold.nodes
    .map(seq => ({ seq, message: deriveEventMessage(prefix[seq]!, fold.projectedMessages) }))
    .filter((entry): entry is { seq: SessionSeq, message: NonNullable<typeof entry.message> } => entry.message !== null)
  return { fold, messages }
}

function main(): void {
  const argv = process.argv.slice(2)
  const path = argv.find(arg => !arg.startsWith('--'))
  if (path === undefined) {
    console.error('usage: replay.ts <session.vN.jsonl[.zstd]> [--requests] [--at <seq>] [--full]')
    process.exit(2)
  }
  const full = argv.includes('--full')
  const atIndex = argv.indexOf('--at')
  const at = atIndex === -1 ? null : Number(argv[atIndex + 1])

  const { header, events, stoppedAt } = decode(path)
  console.log(`header   v${String(header['version'])}  ${String(header['id'])}  preset=${String(header['agentPreset'])}  seeded=${String(header['isSeeded'])}`)
  console.log(`events   ${events.length}${stoppedAt === null ? '' : `  (parsing stopped at line ${stoppedAt} — torn tail)`}`)

  if (at !== null) {
    const { fold, messages } = messagesOf(events, at + 1)
    console.log(`\nfold seq 0..${at}  →  ${fold.nodes.length} surface node, ${messages.length} message\n`)
    for (const { seq, message } of messages) {
      const text = textOf(message as { content?: unknown })
      console.log(`  ${String(seq).padStart(4)}  ${String(message.role).padEnd(9)} ${String(text.length).padStart(6)} ký tự  ${clip(text, full)}`)
    }
    return
  }

  if (argv.includes('--requests')) {
    console.log('\nMỗi lần gọi model: history được derive lại từ log, không lấy từ bộ nhớ.\n')
    for (const event of events) {
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
      const { fold, messages } = messagesOf(events, event.seq)
      const byRole = new Map<string, number>()
      let chars = 0
      for (const { message } of messages) {
        byRole.set(String(message.role), (byRole.get(String(message.role)) ?? 0) + 1)
        chars += textOf(message as { content?: unknown }).length
      }
      const roles = [...byRole].map(([role, n]) => `${role}×${n}`).join(' ')
      const label = event.type === 'assistant/attempt' ? 'attempt (thất bại)' : 'request'
      console.log(`  seq ${String(event.seq).padStart(4)}  ${label.padEnd(18)} ${String(messages.length).padStart(3)} message  ${String(chars).padStart(7)} ký tự  ${roles}`)
      if (fold.replacements.length > 0) console.log(`            đã có ${fold.replacements.length} replacement (compaction) trong prefix này`)
    }
    return
  }

  console.log('\nTừng event, phân loại bằng chính predicate của dsh-session:\n')
  for (const event of events) {
    console.log(`  ${String(event.seq).padStart(4)}  ${event.type.padEnd(34)} ${classify(event)}`)
  }

  const { fold, messages } = messagesOf(events, events.length)
  console.log(`\nSurface cuối cùng: ${fold.nodes.length} node → ${messages.length} message model thấy`)
  console.log(`Node seq: ${fold.nodes.join(', ')}`)
  if (fold.replacements.length === 0) {
    console.log('Replacement: không có (log này chưa compaction lần nào)')
  } else {
    for (const r of fold.replacements) {
      console.log(`Replacement tại seq ${r.seq}: khai ${r.start}..${r.end}, che thật ${r.shadowedSeqs.join(', ')}`)
    }
  }
  console.log()
  for (const { seq, message } of messages) {
    const text = textOf(message as { content?: unknown })
    console.log(`  ${String(seq).padStart(4)}  ${String(message.role).padEnd(9)} ${String(text.length).padStart(6)} ký tự  ${clip(text, full)}`)
  }
}

main()
