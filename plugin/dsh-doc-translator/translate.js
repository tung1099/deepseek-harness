/**
 * Batch translation of text segments through one or more models.
 *
 * Segments are de-duplicated, grouped into batches, and sent in parallel.
 * Batches are spread over the configured models in turn; a model that fails or
 * answers in the wrong shape hands the batch to the next model, and a batch
 * with a wrong-shaped answer is split in halves before giving up on a model.
 *
 * @module dsh-doc-translator/translate
 */

import { LlmError } from './llm.js'

const MARKER = /⟦\/?\d+⟧/g

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Group items into batches bounded by characters and by item count. */
export function makeBatches(items, { batchChars, batchItems }) {
  const batches = []
  let current = []
  let size = 0
  for (const item of items) {
    if (current.length > 0 && (size + item.text.length > batchChars || current.length >= batchItems)) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += item.text.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** The system prompt for one batch; the glossary lists only terms that occur in it. */
export function buildSystemPrompt({ target, source, glossary = [] }, batch) {
  const haystack = batch.map(item => item.text.toLowerCase()).join('\n')
  const terms = glossary.filter(entry => haystack.includes(entry.source.toLowerCase()))
  return [
    `You are a professional translator. Translate each item ${source ? `from ${source} ` : ''}into ${target}.`,
    'Rules:',
    '- Keep the meaning, register and terminology. Write natural, fluent text in the target language.',
    '- Copy unchanged: numbers, URLs, email addresses, product and brand names, code, and placeholders such as {0} or %s.',
    '- Items may contain markers like ⟦1⟧text⟦/1⟧ that mark formatted parts. Keep every marker, exactly once, in the same item. You may move a marked part if the target grammar needs it.',
    '- Keep tab and newline characters where they separate parts.',
    `- Translate every item that is not already written in ${target}, whatever language it is in: a document may mix languages, and a line in another language than the rest still needs translating.`,
    '- Do not add notes or explanations. Do not merge or split items. Return an item unchanged only when it is already in the target language or has no words (numbers, codes, names).',
    ...(terms.length > 0 ? ['Glossary (always translate these terms as given):', ...terms.map(entry => `- ${entry.source} => ${entry.target}`)] : []),
    'Input: a JSON array of {"i": number, "text": string}. Output: only a JSON array of {"i": number, "text": string} with the same i values, no code fence.',
  ].join('\n')
}

/** Parse a model reply into `Map(i -> text)`, or `null` when it is not exactly the requested shape. */
export function parseReply(reply, batch) {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start < 0 || end < start) return null
  let rows
  try { rows = JSON.parse(reply.slice(start, end + 1)) } catch { return null }
  if (!Array.isArray(rows) || rows.length !== batch.length) return null
  const out = new Map()
  for (const row of rows) {
    if (typeof row?.i !== 'number' || typeof row.text !== 'string' || out.has(row.i)) return null
    out.set(row.i, row.text)
  }
  return batch.every(item => out.has(item.i) && (out.get(item.i).trim() !== '' || item.text.trim() === '')) ? out : null
}

const markerSet = text => (text.match(MARKER) ?? []).sort().join(',')

/**
 * Translate segments.
 * @param {{ chat: Function }} llm - client from `createLlm`.
 * @param {Array<{ id: string, text: string }>} segments - text to translate.
 * @param {{ target: string, source?: string, glossary?: Array<{ source: string, target: string }>, models: string[], concurrency: number, batchChars: number, batchItems: number, maxTokens: number, signal?: AbortSignal, onProgress?: (progress: { batchesDone: number, batches: number, translations: () => Map<string, string> }) => void }} options - languages, models in preference order, batch limits, and an optional listener called after each settled batch; its `translations()` returns the segments translated so far, by id.
 * @returns {Promise<{ translations: Map<string, string>, failures: Array<{ id: string, reason: string }>, stats: object }>} translations by segment id, segments that stayed untranslated, and call statistics.
 */
export async function translateSegments(llm, segments, options) {
  const stats = { batches: 0, calls: 0, splits: 0, fallbacks: 0, markerRetries: 0, tokens: 0, byModel: {} }
  const unique = new Map()
  for (const segment of segments) {
    if (!unique.has(segment.text)) unique.set(segment.text, [])
    unique.get(segment.text).push(segment.id)
  }
  const items = [...unique.keys()].map((text, i) => ({ i, text }))
  const done = new Map()
  const failed = new Map()

  async function ask(model, batch) {
    stats.calls++
    stats.byModel[model] = (stats.byModel[model] ?? 0) + 1
    const reply = await llm.chat({
      model,
      system: buildSystemPrompt(options, batch),
      user: JSON.stringify(batch.map(item => ({ i: item.i, text: item.text }))),
      maxTokens: options.maxTokens,
      signal: options.signal,
    })
    stats.tokens += reply.usage?.total_tokens ?? 0
    return parseReply(reply.text, batch)
  }

  /** Translate a batch with the given model order; returns Map(i -> text) or throws a summary error. */
  async function run(batch, order) {
    let lastError = 'no model answered'
    for (const [rank, model] of order.entries()) {
      try {
        let rows = await ask(model, batch)
        if (rows === null && batch.length > 1) {
          stats.splits++
          const half = Math.ceil(batch.length / 2)
          const [a, b] = await Promise.all([run(batch.slice(0, half), order.slice(rank)), run(batch.slice(half), order.slice(rank))])
          return new Map([...a, ...b])
        }
        if (rows === null) { lastError = `${model} did not return the requested JSON`; stats.fallbacks++; continue }
        const bad = batch.filter(item => markerSet(item.text) !== markerSet(rows.get(item.i)))
        if (bad.length > 0) {
          stats.markerRetries++
          const retry = await ask(model, bad)
          if (retry !== null) for (const item of bad) rows.set(item.i, retry.get(item.i))
        }
        return rows
      } catch (error) {
        if (options.signal?.aborted || !(error instanceof LlmError)) throw error
        lastError = error.message
        stats.fallbacks++
      }
    }
    throw new Error(lastError)
  }

  /** Translations by segment id for the texts translated so far. */
  const byId = () => {
    const out = new Map()
    for (const [text, ids] of unique) if (done.has(text)) for (const id of ids) out.set(id, done.get(text))
    return out
  }

  const batches = makeBatches(items, options)
  stats.batches = batches.length
  let batchesDone = 0
  await mapLimit(batches, options.concurrency, async (batch, index) => {
    const order = options.models.map((_, k) => options.models[(index + k) % options.models.length])
    try {
      const rows = await run(batch, order)
      for (const item of batch) done.set(item.text, rows.get(item.i))
    } catch (error) {
      if (options.signal?.aborted || !(error instanceof Error) || error instanceof TypeError) throw error
      for (const item of batch) failed.set(item.text, error.message)
    }
    options.onProgress?.({ batchesDone: ++batchesDone, batches: batches.length, translations: byId })
  })

  const translations = byId()
  const failures = []
  for (const [text, ids] of unique) {
    if (!done.has(text)) for (const id of ids) failures.push({ id, reason: failed.get(text) ?? 'not translated' })
  }
  return { translations, failures, stats }
}
