/**
 * Text lines of a PDF that has a text layer, read with `pdftohtml -xml`.
 *
 * A page with a text layer needs no OCR: the text is exact and every line
 * comes with its position, font family, size, colour and weight. The family
 * name is cleaned of the subset prefix (`ABCDEF+`) and of weight and style
 * suffixes (`Arial-BoldMT`).
 *
 * @module dsh-doc-translator/layer
 */

import { decodeText } from './xml.js'

const LETTER = /\p{L}/gu

/** The family name of an embedded font, and the weight and slant its name carries. */
export function cleanFamily(raw) {
  const unprefixed = raw.replace(/^[A-Z]{6}\+/, '')
  const [base] = unprefixed.split('-')
  const family = base
    .replace(/(?:PSMT|PS|MT)$/, '')
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    family: family === '' ? unprefixed : family,
    bold: /bold|black|heavy|demi/i.test(unprefixed),
    italic: /italic|oblique/i.test(unprefixed),
  }
}

/**
 * Parse the output of `pdftohtml -xml`.
 * @param {string} xml - the document.
 * @returns {Array<{ number: number, lines: Array<{ text: string, quad: number[], family: string, size: number, color: string, bold: boolean, italic: boolean, pageWidth: number }> }>} pages with their lines; each quad has four corners on a 0 to 1000 scale and `size` is a fraction of the page width.
 */
export function parsePdfXml(xml) {
  const fonts = new Map()
  const pages = []
  for (const page of xml.matchAll(/<page number="(\d+)"[^>]*?height="(\d+(?:\.\d+)?)"[^>]*?width="(\d+(?:\.\d+)?)"[^>]*>([\s\S]*?)<\/page>/g)) {
    const [, number, h, w, body] = page
    const height = Number(h)
    const width = Number(w)
    for (const spec of body.matchAll(/<fontspec id="(\d+)" size="(\d+(?:\.\d+)?)" family="([^"]*)" color="([^"]*)"\s*\/>/g)) {
      fonts.set(spec[1], { size: Number(spec[2]), color: spec[4], ...cleanFamily(decodeText(spec[3])) })
    }
    const lines = []
    for (const item of body.matchAll(/<text top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)" font="(\d+)">([\s\S]*?)<\/text>/g)) {
      const [, top, left, boxWidth, boxHeight, fontId, inner] = item
      const font = fonts.get(fontId)
      const text = decodeText(inner.replace(/<[^>]+>/g, ''))
      if (!font || text.trim() === '') continue
      const x1 = Number(left)
      const y1 = Number(top)
      const x2 = x1 + Number(boxWidth)
      const y2 = y1 + Number(boxHeight)
      const scale = (value, total) => Math.round((value / total) * 1000 * 10) / 10
      const wholeBold = /^\s*(?:<a [^>]*>)?\s*<b>[\s\S]*<\/b>\s*(?:<\/a>)?\s*$/.test(inner)
      const wholeItalic = /^\s*(?:<a [^>]*>)?\s*<i>[\s\S]*<\/i>\s*(?:<\/a>)?\s*$/.test(inner)
      lines.push({
        text: text.replace(/\s+$/, ''),
        quad: [scale(x1, width), scale(y1, height), scale(x2, width), scale(y1, height), scale(x2, width), scale(y2, height), scale(x1, width), scale(y2, height)],
        family: font.family,
        size: Math.round((font.size / width) * 10000) / 10000,
        color: font.color,
        bold: font.bold || wholeBold,
        italic: font.italic || wholeItalic,
      })
    }
    pages.push({ number: Number(number), lines })
  }
  return pages
}

/** Number of letters on a page; a page with few letters has no usable text layer. */
export function letterCount(page) {
  return page.lines.reduce((sum, line) => sum + (line.text.match(LETTER)?.length ?? 0), 0)
}
