/**
 * Translate PDF pages and images: render pages to images, get the text lines
 * with their positions, translate the lines, and draw the translation over the
 * old text.
 *
 * Lines come from the PDF text layer when a page has one (exact text, with the
 * font family, size, colour and weight the PDF names) and from the OCR models
 * otherwise (the position and size of a line but not its font, so the
 * translation is drawn in a sans-serif font that covers the target language,
 * bold when the original ink is dense, in the original ink colour).
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
import { letterCount, parsePdfXml } from './layer.js'
import { ocrPage } from './ocr.js'
import { run as defaultRun } from './proc.js'
import { mapLimit, translateSegments } from './translate.js'

export const SCAN_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp']
const SCRIPT = fileURLToPath(new URL('./scripts/render_overlay.py', import.meta.url))
const LETTER = /\p{L}/u

/**
 * Translate a scanned document.
 * @param {{ buffer: Buffer, extension: string, llm: object, options: object, langCode: string | null, signal?: AbortSignal, run?: typeof defaultRun }} input - file bytes, extension, LLM client, options (`spotModel`, `readModel`, `dpi`, `maxPages`, `pageConcurrency`, `useTextLayer`, `minLayerLetters`, plus translation options) and the `fc-match` language code of the target.
 * @returns {Promise<object>} output bytes, extension and a report.
 */
export async function translateScan({ buffer, extension, llm, options, langCode, signal, run = defaultRun }) {
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
    const needOcr = pages.map((_, p) => p).filter(p => layerOf(p) === null)
    const ocrResults = await mapLimit(needOcr, options.pageConcurrency, p => ocrPage(llm, { imagePath: pages[p], spotModel: options.spotModel, readModel: options.readModel, signal }))
    const ocr = pages.map(() => null)
    needOcr.forEach((p, i) => { ocr[p] = ocrResults[i] })
    pages.forEach((_, p) => {
      if (ocr[p] === null) ocr[p] = { lines: layerOf(p).lines.map(line => ({ ...line, source: 'layer' })), notes: [] }
    })
    for (const [n, page] of ocr.entries()) for (const note of page.notes) notes.push(`page ${n + 1}: ${note}`)
    const routes = { layer: pages.length - needOcr.length, ocr: needOcr.length }

    const segments = []
    ocr.forEach((page, p) => page.lines.forEach((line, i) => { if (LETTER.test(line.text)) segments.push({ id: `${p}:${i}`, text: line.text }) }))
    if (segments.length === 0) throw new Error('no text was found on the pages')
    const { translations, failures, stats } = await translateSegments(llm, segments, { ...options, signal })

    const ext = extension === 'pdf' ? 'pdf' : (extension === 'jpg' || extension === 'jpeg' ? 'jpg' : 'png')
    const spec = {
      dpi: options.dpi,
      language: langCode,
      pdf: extension === 'pdf' ? join(dir, 'out.pdf') : null,
      pages: pages.map((image, p) => ({
        image,
        obstacles: ocr[p].lines.filter(line => line.source === 'layer').map(line => line.quad),
        output: join(dir, `out-${p + 1}.${ext === 'pdf' ? 'png' : ext}`),
        items: ocr[p].lines.flatMap((line, i) => {
          if (!translations.has(`${p}:${i}`)) return []
          const style = line.source === 'layer' ? { exact: true, family: line.family, size: line.size, color: line.color, bold: line.bold, italic: line.italic } : {}
          return [{ quad: line.quad, text: translations.get(`${p}:${i}`), ...style }]
        }),
      })),
    }
    await writeFile(join(dir, 'spec.json'), JSON.stringify(spec))
    const rendered = JSON.parse((await run('python3', [SCRIPT, join(dir, 'spec.json')], { timeoutMs: 300_000, signal })).stdout)
    const outPath = extension === 'pdf' ? spec.pdf : spec.pages[0].output
    return {
      buffer: await readFile(outPath),
      extension: ext,
      pages: pages.length,
      routes,
      lines: { total: segments.length, translated: translations.size, failed: failures.length },
      failures,
      stats,
      render: rendered,
      notes,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
