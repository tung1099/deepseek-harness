/**
 * OCR of page images through two models: one that returns the position of each
 * text line and one that reads the text accurately.
 *
 * The position model is asked to "spot" text: it returns each line followed by
 * eight `<|LOC_n|>` values, the four corners of the line on a 0 to 1000 scale.
 * The reading model returns the page text. Each spotted line takes the text of
 * the closest line the reading model returned, which keeps the boxes of the
 * first model and the diacritics of the second.
 *
 * Measured on a synthetic Vietnamese page with 24 lines, the spotting model
 * alone got 20 lines exactly right and the reading model 23 to 24.
 *
 * @module dsh-doc-translator/ocr
 */

import { readFile } from 'node:fs/promises'

export const SPOT_PROMPT = 'Spotting:'
export const READ_PROMPT = 'Extract all text from this image exactly as written, preserving line breaks and diacritics. Output only the text.'

const LOC = /<\|LOC_(\d+)\|>/g

/** Lower-case text without accents, for comparing lines that differ only in diacritics. */
export function plain(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Dice coefficient over character bigrams, 0 to 1. */
export function similarity(a, b) {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = text => { const m = new Map(); for (let i = 0; i < text.length - 1; i++) { const g = text.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1) } return m }
  const [x, y] = [grams(a), grams(b)]
  let shared = 0
  for (const [g, n] of x) shared += Math.min(n, y.get(g) ?? 0)
  return (2 * shared) / (a.length - 1 + b.length - 1)
}

/**
 * Parse spotting output.
 * @param {string} reply - model reply.
 * @returns {Array<{ text: string, quad: number[] }>} lines with their four corners (x1,y1 … x4,y4, each 0 to 1000); lines without eight values are dropped.
 */
export function parseSpotting(reply) {
  const out = []
  for (const row of reply.split('\n')) {
    const values = [...row.matchAll(LOC)].map(m => Number(m[1]))
    const text = row.replace(LOC, '').trim()
    if (values.length >= 8 && text !== '') out.push({ text, quad: values.slice(0, 8) })
  }
  return out
}

/** Text lines of a reading-model reply: one per line, and one per tab-separated cell. */
export function readingLines(reply) {
  return reply.split('\n').flatMap(row => row.split('\t')).map(cell => cell.trim()).filter(Boolean)
}

/**
 * Find the part of `haystack` that is closest to `needle`, allowing edits.
 * Both strings are compared as given; callers pass accent-free text.
 * @param {string} haystack - text to search.
 * @param {string} needle - text to find.
 * @param {number} maxRatio - most edits allowed per character of `needle`.
 * @returns {{ start: number, end: number, distance: number } | null} the best window, or `null` when none is close enough.
 */
export function approximateSubstring(haystack, needle, maxRatio) {
  const n = needle.length
  if (n === 0) return null
  let previous = new Int32Array(haystack.length + 1)
  let previousStart = new Int32Array(haystack.length + 1)
  for (let j = 0; j <= haystack.length; j++) previousStart[j] = j
  for (let i = 1; i <= n; i++) {
    const row = new Int32Array(haystack.length + 1)
    const rowStart = new Int32Array(haystack.length + 1)
    row[0] = i
    for (let j = 1; j <= haystack.length; j++) {
      const diagonal = previous[j - 1] + (needle[i - 1] === haystack[j - 1] ? 0 : 1)
      const up = previous[j] + 1
      const left = row[j - 1] + 1
      if (diagonal <= up && diagonal <= left) { row[j] = diagonal; rowStart[j] = previousStart[j - 1] } else if (up <= left) { row[j] = up; rowStart[j] = previousStart[j] } else { row[j] = left; rowStart[j] = rowStart[j - 1] }
    }
    previous = row
    previousStart = rowStart
  }
  let best = 0
  for (let j = 1; j <= haystack.length; j++) if (previous[j] < previous[best] || (previous[j] === previous[best] && j - previousStart[j] > best - previousStart[best])) best = j
  if (previous[best] > maxRatio * n) return null
  return { start: previousStart[best], end: best, distance: previous[best] }
}

/**
 * Give each spotted line the text the reading model returned for it.
 * A line first looks for a similar line of the reading text; a line with none
 * (the reading model may join the cells of a table row) then looks for the
 * closest stretch of the whole reading text. Each piece of reading text is used once.
 * @param {Array<{ text: string, quad: number[] }>} spotted - lines with corners.
 * @param {string} readingReply - the reading model's reply.
 * @param {{ threshold?: number, maxRatio?: number }} [options] - least line similarity (accents ignored) and most edits per character for the stretch search.
 * @returns {{ lines: Array<{ text: string, quad: number[], source: 'reading' | 'spotting' }>, replaced: number }} lines in the spotted order.
 */
export function alignLines(spotted, readingReply, { threshold = 0.8, maxRatio = 0.2 } = {}) {
  const reading = readingLines(readingReply)
  const used = new Set()
  // The whole reading text with one character per plain character, so positions map back.
  const document = readingReply.normalize('NFC').replace(/\s+/g, ' ')
  const folded = [...document].map(ch => plain(ch).slice(0, 1) || ch.toLowerCase())
  let remaining = folded.join('')
  let replaced = 0
  const lines = spotted.map((line) => {
    const key = plain(line.text)
    let best = -1
    let score = 0
    reading.forEach((candidate, i) => {
      if (used.has(i)) return
      const s = similarity(key, plain(candidate))
      if (s > score) { score = s; best = i }
    })
    let text = null
    if (best >= 0 && score >= threshold) {
      used.add(best)
      text = reading[best]
      const at = plain(document).indexOf(plain(text))
      if (at >= 0) remaining = remaining.slice(0, at) + '\u0000'.repeat(plain(text).length) + remaining.slice(at + plain(text).length)
    } else {
      const found = approximateSubstring(remaining, key, maxRatio)
      if (found) {
        text = [...document].slice(found.start, found.end).join('').trim()
        remaining = remaining.slice(0, found.start) + '\u0000'.repeat(found.end - found.start) + remaining.slice(found.end)
      }
    }
    if (text === null || text === '') return { text: line.text, quad: line.quad, source: 'spotting' }
    if (text !== line.text) replaced++
    return { text, quad: line.quad, source: 'reading' }
  })
  return { lines, replaced }
}

/**
 * OCR one page image.
 * @param {{ chat: Function }} llm - client from `createLlm`.
 * @param {{ imagePath: string, spotModel: string, readModel: string, signal?: AbortSignal }} input - page image and the two models.
 * @returns {Promise<{ lines: Array<{ text: string, quad: number[], source: string }>, notes: string[] }>} lines with corners and notes about fallbacks.
 */
export async function ocrPage(llm, { imagePath, spotModel, readModel, signal }) {
  const bytes = await readFile(imagePath)
  const mime = /\.jpe?g$/i.test(imagePath) ? 'image/jpeg' : (/\.webp$/i.test(imagePath) ? 'image/webp' : 'image/png')
  const content = prompt => [
    { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
    { type: 'text', text: prompt },
  ]
  const ask = (model, prompt) => llm.chat({ model, user: content(prompt), maxTokens: 4096, signal })
  const notes = []
  const [spot, read] = await Promise.allSettled([ask(spotModel, SPOT_PROMPT), ask(readModel, READ_PROMPT)])
  if (signal?.aborted) throw signal.reason
  if (spot.status === 'rejected') throw new Error(`position model ${spotModel} failed: ${spot.reason.message}`)
  let spotted = parseSpotting(spot.value.text)
  if (spotted.length === 0) {
    const again = await ask(spotModel, SPOT_PROMPT)
    spotted = parseSpotting(again.text)
  }
  if (spotted.length === 0) throw new Error(`position model ${spotModel} returned no text lines with positions`)
  if (read.status === 'rejected') {
    notes.push(`reading model ${readModel} failed (${read.reason.message}); text comes from ${spotModel} and may have wrong diacritics`)
    return { lines: spotted.map(line => ({ ...line, source: 'spotting' })), notes }
  }
  const { lines, replaced } = alignLines(spotted, read.value.text)
  if (replaced > 0) notes.push(`${replaced} line(s) took the text of ${readModel}`)
  const kept = lines.filter(line => line.source === 'spotting').length
  if (kept > 0) notes.push(`${kept} line(s) had no close match in the reading model and kept the text of ${spotModel}`)
  return { lines, notes }
}
