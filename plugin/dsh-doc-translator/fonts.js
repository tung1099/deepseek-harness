/**
 * Checks the fonts a document names against the fonts installed on this
 * machine, and which of those cover the target language.
 *
 * The result describes this machine only: a document font that is not
 * installed here may still be present where the file is opened.
 *
 * @module dsh-doc-translator/fonts
 */

import { run as defaultRun } from './proc.js'

const families = stdout => new Set(stdout.split('\n').flatMap(line => line.split(',')).map(name => name.trim()).filter(Boolean))

/**
 * @param {string[]} fonts - font family names used by the document.
 * @param {string | null} langCode - `fc-list` language code of the target language, if known.
 * @param {typeof defaultRun} [run] - program runner; replaced in tests.
 * @returns {Promise<{ checked: boolean, fonts: Array<{ font: string, installed: boolean, coversTarget: boolean | null }>, note?: string }>} one row per font; `coversTarget` is `null` when the font is not installed here or the language is unknown.
 */
export async function checkFonts(fonts, langCode, run = defaultRun) {
  if (fonts.length === 0) return { checked: true, fonts: [] }
  let installed
  let covering = null
  try {
    installed = families((await run('fc-list', ['--format', '%{family}\n'])).stdout)
    if (langCode) covering = families((await run('fc-list', [`:lang=${langCode}`, '--format', '%{family}\n'])).stdout)
  } catch (error) {
    return { checked: false, fonts: fonts.map(font => ({ font, installed: false, coversTarget: null })), note: error.message }
  }
  return {
    checked: true,
    fonts: fonts.map(font => ({
      font,
      installed: installed.has(font),
      coversTarget: installed.has(font) && covering ? covering.has(font) : null,
    })),
  }
}
