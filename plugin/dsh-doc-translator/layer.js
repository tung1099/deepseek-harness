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
 * @returns {Array<{ number: number, width: number, height: number, lines: Array<{ text: string, raw: string, quad: number[], box: { x1: number, y1: number, x2: number, y2: number }, font: string, family: string, size: number, color: string, bold: boolean, italic: boolean }> }>} pages with their lines; each quad has four corners on a 0 to 1000 scale, `box` is in page units, `raw` keeps the spaces at both ends, and `size` is a fraction of the page width.
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
        raw: text,
        box: { x1, y1, x2, y2 },
        font: fontId,
        quad: [scale(x1, width), scale(y1, height), scale(x2, width), scale(y1, height), scale(x2, width), scale(y2, height), scale(x1, width), scale(y2, height)],
        family: font.family,
        size: Math.round((font.size / width) * 10000) / 10000,
        color: font.color,
        bold: font.bold || wholeBold,
        italic: font.italic || wholeItalic,
      })
    }
    pages.push({ number: Number(number), width, height, lines })
  }
  return pages
}

/** Number of letters on a page; a page with few letters has no usable text layer. */
export function letterCount(page) {
  return page.lines.reduce((sum, line) => sum + (line.text.match(LETTER)?.length ?? 0), 0)
}

const BULLET = /^\s*(?:[•●▪■◦·\-–—*]|\d{1,2}[.)]\s)/

/**
 * Join the pieces of one visual line. Items are taken from left to right; an
 * item joins the row whose last piece ends just before it and overlaps it
 * vertically by at least half the smaller height, the row with the largest
 * overlap when several qualify. A small glyph set lower than the text (an arrow
 * in another font) therefore joins its own line, and lines of other columns
 * never link two rows.
 */
function joinRows(lines) {
  const height = box => box.y2 - box.y1
  const rows = []
  for (const line of [...lines].sort((a, b) => a.box.x1 - b.box.x1 || a.box.y1 - b.box.y1)) {
    let best
    let bestOverlap = 0
    for (const row of rows) {
      const last = row.at(-1)
      const gap = line.box.x1 - last.box.x2
      if (gap < -2 || gap > 0.6 * Math.max(height(line.box), height(last.box))) continue
      const overlap = Math.min(last.box.y2, line.box.y2) - Math.max(last.box.y1, line.box.y1)
      if (overlap >= 0.5 * Math.min(height(line.box), height(last.box)) && overlap > bestOverlap) {
        best = row
        bestOverlap = overlap
      }
    }
    if (best) best.push(line)
    else rows.push([line])
  }
  return rows.map((parts) => {
    // The style of a row is the style of its widest piece.
    const main = parts.reduce((best, part) => (part.box.x2 - part.box.x1 > best.box.x2 - best.box.x1 ? part : best))
    let raw = ''
    parts.forEach((part, i) => {
      if (i > 0) {
        const before = parts[i - 1]
        const spaced = /\s$/.test(raw) || /^\s/.test(part.raw)
        if (!spaced && part.box.x1 - before.box.x2 > 0.2 * height(part.box)) raw += ' '
      }
      raw += part.raw
    })
    const box = {
      x1: Math.min(...parts.map(p => p.box.x1)),
      y1: Math.min(...parts.map(p => p.box.y1)),
      x2: Math.max(...parts.map(p => p.box.x2)),
      y2: Math.max(...parts.map(p => p.box.y2)),
    }
    return { ...main, raw, text: raw.trim().replace(/\s+/g, ' '), box }
  }).sort((a, b) => a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1)
}

/** Whether two lines are set in the same font, size, weight and colour. */
function sameStyle(a, b) {
  return a.font === b.font || (a.family === b.family && a.size === b.size && a.bold === b.bold && a.color === b.color)
}

/** Whether `next` continues the paragraph whose last line is `last`. */
function continues(block, last, next) {
  if (!sameStyle(last, next)) return false
  const height = last.box.y2 - last.box.y1
  const gap = next.box.y1 - last.box.y2
  if (gap < -0.3 * height || gap > 0.8 * height) return false
  const overlap = Math.min(last.box.x2, next.box.x2) - Math.max(last.box.x1, next.box.x1)
  if (overlap <= 0) return false
  if (BULLET.test(next.text)) return false
  // A short left-aligned line ends its paragraph.
  const left = Math.abs(next.box.x1 - last.box.x1) < 0.5 * height
  const widest = Math.max(...block.map(line => line.box.x2 - line.box.x1))
  if (left && block.length > 0 && last.box.x2 - last.box.x1 < 0.6 * widest && /[.!?:;。！？]$/.test(last.text)) return false
  return true
}

/** Alignment of a paragraph, from the spread of its line edges and centres. */
function alignmentOf(lines, pageWidth) {
  if (lines.length === 1) {
    const centre = (lines[0].box.x1 + lines[0].box.x2) / 2
    return Math.abs(centre - pageWidth / 2) < 0.04 * pageWidth ? 'center' : 'left'
  }
  const spread = values => Math.max(...values) - Math.min(...values)
  const lefts = spread(lines.map(l => l.box.x1))
  const rights = spread(lines.map(l => l.box.x2))
  const centres = spread(lines.map(l => (l.box.x1 + l.box.x2) / 2))
  const height = lines[0].box.y2 - lines[0].box.y1
  if (lefts <= 0.3 * height) return 'left'
  if (centres <= Math.min(lefts, rights) && centres <= 1.5 * height) return 'center'
  if (rights <= 0.3 * height) return 'right'
  return centres < lefts ? 'center' : 'left'
}

/**
 * Group the lines of a text-layer page into paragraphs. Pieces of one visual
 * line are joined first; then consecutive lines with the same font that touch
 * vertically and overlap horizontally form one paragraph, unless the next line
 * starts with a bullet or the previous one is a short left-aligned line ending a
 * sentence. A one-line paragraph takes its alignment from nearby one-line
 * paragraphs of the same style that share its right edge (right) or its centre
 * (centre) but not its left edge.
 * @param {{ width: number, height: number, lines: ReturnType<typeof parsePdfXml>[number]['lines'] }} page - one page from `parsePdfXml`.
 * @returns {Array<{ text: string, sources: string[], quads: number[][], quad: number[], family: string, size: number, color: string, bold: boolean, italic: boolean, align: 'left' | 'center' | 'right', lineHeight: number }>} paragraphs in reading order; `quads` are the lines', `quad` their union, and `lineHeight` the distance between line tops as a fraction of the page height.
 */
export function groupParagraphs(page) {
  const rows = joinRows(page.lines)
  const blocks = []
  for (const row of rows) {
    const open = blocks.find(block => continues(block, block.at(-1), row))
    if (open) open.push(row)
    else blocks.push([row])
  }
  // A one-line paragraph takes the alignment its neighbours of the same style share: a column of labels ending at one edge is right-aligned.
  const alignments = new Map()
  for (const block of blocks) {
    if (block.length > 1) continue
    const [line] = block
    const height = line.box.y2 - line.box.y1
    const peers = blocks.filter(other => other !== block && other.length === 1 && sameStyle(other[0], line)
      && Math.abs(other[0].box.y1 - line.box.y1) <= 6 * height
      && Math.min(other[0].box.x2, line.box.x2) - Math.max(other[0].box.x1, line.box.x1) > 0)
    const near = (a, b) => Math.abs(a - b) <= 0.3 * height
    const differ = (a, b) => Math.abs(a - b) > 0.5 * height
    const centre = box => (box.x1 + box.x2) / 2
    if (peers.some(peer => near(peer[0].box.x2, line.box.x2) && differ(peer[0].box.x1, line.box.x1))) alignments.set(block, 'right')
    else if (peers.some(peer => near(centre(peer[0].box), centre(line.box)) && differ(peer[0].box.x1, line.box.x1))) alignments.set(block, 'center')
  }
  const scale = (value, total) => Math.round((value / total) * 1000 * 10) / 10
  const quadOf = box => [scale(box.x1, page.width), scale(box.y1, page.height), scale(box.x2, page.width), scale(box.y1, page.height), scale(box.x2, page.width), scale(box.y2, page.height), scale(box.x1, page.width), scale(box.y2, page.height)]
  return blocks
    .sort((a, b) => a[0].box.y1 - b[0].box.y1 || a[0].box.x1 - b[0].box.x1)
    .map((lines) => {
      const union = { x1: Math.min(...lines.map(l => l.box.x1)), y1: lines[0].box.y1, x2: Math.max(...lines.map(l => l.box.x2)), y2: lines.at(-1).box.y2 }
      const steps = lines.slice(1).map((line, i) => line.box.y1 - lines[i].box.y1).sort((a, b) => a - b)
      const step = steps.length > 0 ? steps[Math.floor(steps.length / 2)] : 1.2 * (lines[0].box.y2 - lines[0].box.y1)
      let text = ''
      for (const line of lines) text = text === '' ? line.text : /[-‐]$/.test(text) && /^\p{Ll}/u.test(line.text) ? text.slice(0, -1) + line.text : `${text} ${line.text}`
      const { family, size, color, bold, italic } = lines[0]
      return {
        text,
        sources: lines.map(l => l.text),
        quads: lines.map(l => quadOf(l.box)),
        quad: quadOf(union),
        family, size, color, bold, italic,
        align: alignments.get(lines) ?? alignmentOf(lines, page.width),
        lineHeight: Math.round((step / page.height) * 100000) / 100000,
      }
    })
}
