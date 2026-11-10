/**
 * Translate a Word, PowerPoint or Excel package: read it, translate the text,
 * write it back in place, and describe what changed.
 *
 * @module dsh-doc-translator/office
 */

import { analyze, apply, detectFormat, usedFonts } from './ooxml.js'
import { translateSegments } from './translate.js'
import { readZip, writeZip } from './zip.js'

const LEGACY = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' }

/**
 * Check the file name against the package content.
 * @param {string} extension - lower-case extension without the dot.
 * @param {Array<{ name: string }>} entries - ZIP entries.
 * @returns {'docx' | 'pptx' | 'xlsx'} the package format.
 */
export function resolveFormat(extension, entries) {
  const format = detectFormat(entries)
  if (!format) throw new Error(`the file does not look like a Word, PowerPoint or Excel package (extension .${extension})`)
  if (format !== extension) throw new Error(`the extension .${extension} does not match the content, which is a ${format} package`)
  return format
}

/** Explain why a legacy binary Office extension is not handled. */
export function legacyHint(extension) {
  return LEGACY[extension] ? `.${extension} is the old binary format; convert it to .${LEGACY[extension]} first (for example with LibreOffice) and translate that` : null
}

/** The package with `translations` written in; segments without a translation keep their source text. */
function build(entries, model, translations) {
  const { files, warnings, applied } = apply(model, translations)
  const out = entries.map(entry => (files.has(entry.name) ? { ...entry, data: Buffer.from(files.get(entry.name), 'utf8') } : entry))
  return { buffer: writeZip(out), warnings, applied }
}

/**
 * Translate one package.
 * @param {{ buffer: Buffer, extension: string, llm: object, options: object, signal?: AbortSignal, observer?: { segments(build: () => Array<{ s: string, t?: string }>): void } }} input - package bytes, extension, LLM client, translation options (see `translateSegments`) plus `maxArchiveBytes` and `expansionWarn`, and an optional observer that receives, before the first batch and after each settled batch, a builder of the lines in document order with the translations so far.
 * @returns {Promise<object>} the translated package and a report.
 */
export async function translateOffice({ buffer, extension, llm, options, signal, observer }) {
  const entries = readZip(buffer, { maxTotalBytes: options.maxArchiveBytes })
  const format = resolveFormat(extension, entries)
  const model = analyze(entries, format)
  if (model.segments.length === 0) throw new Error('no translatable text was found in the file')

  const rows = translations => model.segments.map(segment => (translations.has(segment.id) ? { s: segment.text, t: translations.get(segment.id) } : { s: segment.text }))
  observer?.segments(() => rows(new Map()))
  const onProgress = observer && (progress => observer.segments(() => rows(progress.translations())))
  const { translations, failures, stats } = await translateSegments(llm, model.segments, { ...options, signal, onProgress })
  const { buffer: translated, warnings, applied } = build(entries, model, translations)

  const source = new Map(model.segments.map(s => [s.id, s.text.replace(/⟦\/?\d+⟧/g, '')]))
  const ratios = []
  for (const [id, text] of translations) {
    const before = source.get(id)
    if (before.length >= 12) ratios.push({ id, ratio: text.replace(/⟦\/?\d+⟧/g, '').length / before.length, text: before.slice(0, 60) })
  }
  ratios.sort((a, b) => b.ratio - a.ratio)
  const warningCounts = {}
  for (const w of warnings) warningCounts[w.reason] = (warningCounts[w.reason] ?? 0) + 1

  return {
    buffer: translated,
    format,
    segments: { total: model.segments.length, translated: applied, failed: failures.length },
    failures,
    warnings: warningCounts,
    warningDetails: warnings,
    expansion: {
      average: ratios.length ? ratios.reduce((sum, r) => sum + r.ratio, 0) / ratios.length : null,
      longest: ratios.filter(r => r.ratio >= options.expansionWarn).slice(0, 5),
    },
    fonts: usedFonts(entries),
    stats,
  }
}
