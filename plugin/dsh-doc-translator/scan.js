/**
 * Translate PDF pages and images: render pages to images, get the text lines
 * with their positions, translate the lines, and draw the translation over the
 * old text.
 *
 * Lines come from the PDF text layer when a page has one (exact text, with the
 * font family, size, colour and weight the PDF names; the lines are grouped into
 * paragraphs, translated whole and wrapped again into the paragraph's box) and from the OCR models
 * otherwise (the position and size of a line but not its font, so the
 * translation is drawn in a sans-serif font that covers the target language,
 * bold when the original ink is dense, in the original ink colour).
 *
 * Each page is read, translated and drawn on its own, so a page is finished
 * while later pages are still being read; an optional observer receives the
 * page images first and then each translated page image as it is finished. A
 * line that repeats on several pages is translated once per page.
 *
 * The result is made of page images. A PDF comes out as an image-only PDF whose
 * text cannot be selected, even when the original's could.
 *
 * @module dsh-doc-translator/scan
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { groupParagraphs, letterCount, parsePdfXml } from './layer.js'
import { ocrPage } from './ocr.js'
import { run as defaultRun } from './proc.js'
import { mapLimit, translateSegments } from './translate.js'

export const SCAN_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp']
const SCRIPT = fileURLToPath(new URL('./scripts/render_overlay.py', import.meta.url))
const LETTER = /\p{L}/u

/**
 * Extension of the translated file for an input extension: a PDF stays a PDF, a
 * JPEG stays a JPEG, and other images become PNG.
 * @param {string} extension - lower-case input extension without the dot.
 * @returns {'pdf' | 'jpg' | 'png'} the output extension.
 */
export function scanOutputExtension(extension) {
  if (extension === 'pdf') return 'pdf'
  return extension === 'jpg' || extension === 'jpeg' ? 'jpg' : 'png'
}

/** Add the counters of one `translateSegments` call into `total`. */
function addStats(total, stats) {
  for (const [key, value] of Object.entries(stats)) {
    if (key === 'byModel') for (const [model, calls] of Object.entries(value)) total.byModel[model] = (total.byModel[model] ?? 0) + calls
    else total[key] = (total[key] ?? 0) + value
  }
}

/** Add the drawing report of one page into `total`. */
function addRender(total, report) {
  total.lines += report.lines
  total.overflow += report.overflow
  total.shrunk += report.shrunk
  for (const font of report.fonts) if (!total.fonts.includes(font)) total.fonts.push(font)
  total.sizes.push(...report.sizes)
}

/**
 * Translate a scanned document.
 * @param {{ buffer: Buffer, extension: string, llm: object, options: object, langCode: string | null, signal?: AbortSignal, run?: typeof defaultRun, observer?: { pages(images: string[]): void, page(index: number, image: string): void } }} input - file bytes, extension, LLM client, options (`spotModel`, `readModel`, `dpi`, `maxPages`, `pageConcurrency`, `useTextLayer`, `minLayerLetters`, plus translation options), the `fc-match` language code of the target, and an optional observer told the page images (PNG, in page order, except a JPEG or WebP input) and then each finished translated page image; a returned promise is awaited, and the images are removed when this call returns.
 * @returns {Promise<object>} output bytes, extension and a report.
 */
export async function translateScan({ buffer, extension, llm, options, langCode, signal, run = defaultRun, observer }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-doc-translator-scan-'))
  try {
    const notes = []
    let pages
    if (extension === 'pdf') {
      const input = join(dir, 'input.pdf')
      await writeFile(input, buffer)
      const count = Number(/Pages:\s+(\d+)/.exec((await run('pdfinfo', [input], { timeoutMs: 30_000, signal })).stdout)?.[1])
      if (!(count >= 1)) throw new Error('could not read the page count of the PDF')
      if (count > options.maxPages) throw new Error(`the PDF has ${count} pages; the limit is ${options.maxPages}`)
      await run('pdftoppm', ['-r', String(options.dpi), '-png', input, join(dir, 'page')], { timeoutMs: 300_000, signal })
      pages = (await readdir(dir)).filter(name => /^page-\d+\.png$/.test(name)).sort().map(name => join(dir, name))
    } else {
      const input = join(dir, `page-1.${extension === 'jpeg' ? 'jpg' : extension}`)
      await writeFile(input, buffer)
      pages = [input]
    }

    // A page with a text layer needs no OCR.
    let layerPages = []
    if (extension === 'pdf' && options.useTextLayer) {
      try {
        const { stdout } = await run('pdftohtml', ['-xml', '-i', '-nodrm', '-enc', 'UTF-8', '-stdout', join(dir, 'input.pdf')], { timeoutMs: 120_000, signal })
        layerPages = parsePdfXml(stdout)
      } catch (error) {
        if (signal?.aborted) throw error
        notes.push(`the PDF text layer could not be read (${error.message}); every page was read with OCR`)
      }
    }
    const layerOf = (p) => {
      const page = layerPages.find(candidate => candidate.number === p + 1)
      return page && letterCount(page) >= options.minLayerLetters ? page : null
    }

    const ext = scanOutputExtension(extension)
    const outputs = pages.map((_, p) => join(dir, `out-${p + 1}.${ext === 'pdf' ? 'png' : ext}`))
    await observer?.pages(pages)

    const stats = { batches: 0, calls: 0, splits: 0, fallbacks: 0, markerRetries: 0, tokens: 0, byModel: {} }
    const render = { lines: 0, overflow: 0, shrunk: 0, fonts: [], sizes: [] }
    const translations = new Map()
    const failures = []
    const pageNotes = pages.map(() => [])
    let ocrPages = 0
    let total = 0
    await mapLimit(pages.map((_, p) => p), options.pageConcurrency, async (p) => {
      const layer = layerOf(p)
      let lines
      if (layer === null) {
        ocrPages++
        const result = await ocrPage(llm, { imagePath: pages[p], spotModel: options.spotModel, readModel: options.readModel, signal })
        lines = result.lines
        pageNotes[p] = result.notes
      } else {
        // A text-layer page is translated paragraph by paragraph and each paragraph is wrapped again into its own box.
        lines = groupParagraphs(layer).map(block => ({ ...block, source: 'layer' }))
      }

      const segments = []
      lines.forEach((line, i) => { if (LETTER.test(line.text)) segments.push({ id: `${p}:${i}`, text: line.text }) })
      total += segments.length
      if (segments.length > 0) {
        const page = await translateSegments(llm, segments, { ...options, signal })
        addStats(stats, page.stats)
        for (const [id, text] of page.translations) translations.set(id, text)
        failures.push(...page.failures)
      }

      const spec = {
        dpi: options.dpi,
        language: langCode,
        pdf: null,
        pages: [{
          image: pages[p],
          obstacles: layer === null ? [] : layer.lines.map(line => line.quad),
          output: outputs[p],
          items: lines.flatMap((line, i) => {
            if (!translations.has(`${p}:${i}`)) return []
            const style = line.source === 'layer'
              ? { exact: true, block: true, quads: line.quads, sources: line.sources, align: line.align, lineHeight: line.lineHeight, family: line.family, size: line.size, color: line.color, bold: line.bold, italic: line.italic }
              : {}
            return [{ quad: line.quad, text: translations.get(`${p}:${i}`), ...style }]
          }),
        }],
      }
      const specPath = join(dir, `spec-${p + 1}.json`)
      await writeFile(specPath, JSON.stringify(spec))
      addRender(render, JSON.parse((await run('python3', [SCRIPT, specPath], { timeoutMs: 300_000, signal })).stdout))
      await observer?.page(p, outputs[p])
    })
    for (const [n, list] of pageNotes.entries()) for (const note of list) notes.push(`page ${n + 1}: ${note}`)
    if (total === 0) throw new Error('no text was found on the pages')
    if (extension === 'pdf') await run('python3', [SCRIPT, '--assemble', join(dir, 'out.pdf'), String(options.dpi), ...outputs], { timeoutMs: 300_000, signal })

    return {
      buffer: await readFile(extension === 'pdf' ? join(dir, 'out.pdf') : outputs[0]),
      extension: ext,
      pages: pages.length,
      routes: { layer: pages.length - ocrPages, ocr: ocrPages },
      lines: { total, translated: translations.size, failed: failures.length },
      failures,
      stats,
      render,
      notes,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
