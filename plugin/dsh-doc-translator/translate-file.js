/**
 * The work behind the `doc_translate` tool, apart from tool registration:
 * check the request, read the file, translate it by the right route, write the
 * result next to the input, and describe what was done.
 *
 * @module dsh-doc-translator/translate-file
 */

import { extname } from 'node:path'
import { checkFonts } from './fonts.js'
import { assertWritable, chooseOutputDirectory, readInput, writeOutput } from './io.js'
import { languageInfo } from './lang.js'
import { legacyHint, translateOffice } from './office.js'
import { SUPPORTED_EXTENSIONS } from './ooxml.js'
import { run as defaultRun } from './proc.js'
import { SCAN_EXTENSIONS, translateScan } from './scan.js'
import { renderOfficeSummary, renderScanSummary } from './summary.js'
import { verifyLayout } from './verify.js'

/** Check tool arguments; throws a message the model can act on. */
export function validateArgs(args) {
  if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('path is required')
  if (typeof args.target_language !== 'string' || args.target_language.trim() === '' || args.target_language.length > 60) throw new Error('target_language is required (for example "English" or "Vietnamese")')
  if (args.source_language !== undefined && (typeof args.source_language !== 'string' || args.source_language.length > 60)) throw new Error('source_language must be a short language name')
  const glossary = args.glossary ?? []
  if (!Array.isArray(glossary) || glossary.length > 200) throw new Error('glossary must be a list of at most 200 { source, target } entries')
  for (const entry of glossary) {
    if (typeof entry?.source !== 'string' || typeof entry?.target !== 'string' || entry.source.trim() === '' || entry.source.length > 200 || entry.target.length > 200) throw new Error('every glossary entry needs a non-empty source and a target of at most 200 characters')
  }
  return { path: args.path.trim(), target: args.target_language.trim(), source: args.source_language?.trim() || undefined, glossary, verifyLayout: args.verify_layout !== false }
}

/** File-name suffix for the output: the language code, or the language name made safe. */
export function suffixFor(target, info) {
  return info.code ?? (target.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 20) || 'translated')
}

/**
 * Translate one file.
 * @param {{ ctx: object, sandboxPolicy: { resolve(request: { session: object }): object } | undefined, exec: object, args: object, config: object, llm: object, run?: Function }} input - harness services, the sandbox policy service (`undefined` when no confining filesystem is mounted), tool execution context, tool arguments, plugin config and LLM client.
 * @returns {Promise<{ file: string, text: string }>} the output path and the digest for the model.
 */
export async function translateDocument(input) {
  try {
    return await translateDocumentUnguided(input)
  } catch (error) {
    if (input.exec.signal.aborted) throw error
    throw explain(error)
  }
}

/** What the model must do after a failure: report it, not work around it. */
export const STOP_GUIDANCE = ' Report this to the user in one or two plain sentences and stop. You cannot copy, move or edit files, and calling doc_translate again with the same arguments gives the same error.'

/** The same error with the guidance appended; the code and the cause are kept. */
export function explain(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.endsWith(STOP_GUIDANCE)) return error
  return Object.assign(new Error(`${message}.${STOP_GUIDANCE}`.replace(/\.\.\s/, '. '), { cause: error }), { code: error?.code })
}

async function translateDocumentUnguided({ ctx, sandboxPolicy, exec, args, config, llm, run = defaultRun }) {
  const request = validateArgs(args)
  const extension = extname(request.path).slice(1).toLowerCase()
  const hint = legacyHint(extension)
  if (hint) throw new Error(hint)
  const isOffice = SUPPORTED_EXTENSIONS.includes(extension)
  if (!isOffice && !SCAN_EXTENSIONS.includes(extension)) {
    throw new Error(`.${extension || '(none)'} is not supported; supported: ${[...SUPPORTED_EXTENSIONS, ...SCAN_EXTENSIONS].map(e => `.${e}`).join(', ')}`)
  }

  const info = languageInfo(request.target)
  const notes = []
  if (info.code === null) notes.push(`"${request.target}" is not a language the font check knows; fonts were not checked for it`)
  if (info.rtl) notes.push('this is a right-to-left language: the text is translated but the layout is not mirrored and right-to-left alignment is not set')
  const { bytes, hostPath } = await readInput(ctx, exec, request.path, config.maxFileBytes)
  // Decide where the output goes and whether this Session may write there before spending time and model calls.
  const policy = sandboxPolicy?.resolve({ session: exec.agent.session })
  const directory = await chooseOutputDirectory(hostPath, await ctx.workingDirectory.ensure(exec.agent, exec.signal))
  await assertWritable(policy, directory)
  const translation = {
    target: request.target,
    source: request.source,
    glossary: request.glossary,
    models: config.translationModels,
    concurrency: config.batchConcurrency,
    batchChars: config.batchChars,
    batchItems: config.batchItems,
    maxTokens: config.maxOutputTokens,
  }
  const suffix = suffixFor(request.target, info)

  if (isOffice) {
    const report = await translateOffice({ buffer: bytes, extension, llm, signal: exec.signal, options: { ...translation, maxArchiveBytes: config.maxArchiveBytes, expansionWarn: config.expansionWarn } })
    const layout = request.verifyLayout && config.verifyLayout
      ? await verifyLayout({ original: bytes, translated: report.buffer, extension, signal: exec.signal, run })
      : { checked: false, reason: 'turned off' }
    const fontCheck = await checkFonts(report.fonts, info.code, run)
    if (info.cjk) notes.push('Chinese, Japanese and Korean need fonts with those glyphs; the file keeps its original font names and may show missing characters if they lack them')
    const file = await writeOutput({ directory, inputHostPath: hostPath, suffix, extension: `.${extension}`, bytes: report.buffer, policy })
    return { file, text: renderOfficeSummary({ file, format: report.format, target: request.target, report, layout, fontCheck, notes }) }
  }

  const report = await translateScan({ buffer: bytes, extension, llm, signal: exec.signal, langCode: info.code, run, options: { ...translation, spotModel: config.ocr.spotModel, readModel: config.ocr.readModel, dpi: config.ocr.dpi, maxPages: config.ocr.maxPages, pageConcurrency: config.ocr.pageConcurrency, useTextLayer: config.ocr.useTextLayer, minLayerLetters: config.ocr.minLayerLetters } })
  const file = await writeOutput({ directory, inputHostPath: hostPath, suffix, extension: `.${report.extension}`, bytes: report.buffer, policy })
  return { file, text: renderScanSummary({ file, extension: report.extension, target: request.target, report: { ...report, notes: [...notes, ...report.notes] } }) }
}

/** Reject settings that cannot work, naming them. */
export function validateConfig(config) {
  if (config.translationModels.length === 0) throw new Error('doc-translator-tools: translationModels must list at least one model')
  if (/\/$/.test(config.baseUrl)) throw new Error('doc-translator-tools: baseUrl must not end with a slash')
  for (const [model, limit] of Object.entries(config.modelConcurrency)) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`doc-translator-tools: modelConcurrency for ${model} must be a whole number of at least 1`)
  }
}
