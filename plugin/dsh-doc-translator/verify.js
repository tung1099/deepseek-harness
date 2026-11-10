/**
 * Layout check for translated Office files: LibreOffice renders the original
 * and the translated file to PDF and the page counts are compared. A different
 * page count means the translation changed the layout; the same count does not
 * prove the layout is identical.
 *
 * @module dsh-doc-translator/verify
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run as defaultRun } from './proc.js'

const PAGES = /^Pages:\s+(\d+)/m

/** Render one package to PDF in `dir` and return the PDF path. */
async function toPdf(run, dir, name, buffer, profile, signal) {
  const input = join(dir, name)
  await writeFile(input, buffer)
  await run('soffice', ['--headless', `-env:UserInstallation=file://${profile}`, '--convert-to', 'pdf', '--outdir', join(dir, 'pdf'), input], { timeoutMs: 180_000, signal })
  return join(dir, 'pdf', `${name.replace(/\.[^.]+$/, '')}.pdf`)
}

async function pageCount(run, pdf, signal) {
  const { stdout } = await run('pdfinfo', [pdf], { timeoutMs: 30_000, signal })
  const match = PAGES.exec(stdout)
  if (!match) throw new Error(`pdfinfo gave no page count for ${pdf}`)
  return Number(match[1])
}

/**
 * Compare the page counts of the original and translated package.
 * @param {{ original: Buffer, translated: Buffer, extension: string, signal?: AbortSignal, run?: typeof defaultRun }} input - both packages and the file extension.
 * @returns {Promise<{ checked: true, originalPages: number, translatedPages: number, samePages: boolean } | { checked: false, reason: string }>} the comparison, or why it could not be made (a missing program is not an error).
 */
export async function verifyLayout({ original, translated, extension, signal, run = defaultRun }) {
  let dir
  try {
    dir = await mkdtemp(join(tmpdir(), 'dsh-doc-translator-'))
    await mkdir(join(dir, 'pdf'))
    const profile = join(dir, 'profile')
    const pdfA = await toPdf(run, dir, `original.${extension}`, original, profile, signal)
    const pdfB = await toPdf(run, dir, `translated.${extension}`, translated, profile, signal)
    const [originalPages, translatedPages] = [await pageCount(run, pdfA, signal), await pageCount(run, pdfB, signal)]
    return { checked: true, originalPages, translatedPages, samePages: originalPages === translatedPages }
  } catch (error) {
    if (signal?.aborted) throw error
    return { checked: false, reason: error.message }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true })
  }
}
