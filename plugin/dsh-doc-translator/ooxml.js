/**
 * Text extraction and in-place replacement for Word, PowerPoint and Excel
 * packages.
 *
 * The translation unit is a line: the text of a paragraph between two line
 * breaks (Excel: one whole string). Line breaks and page breaks are boundaries
 * and are never touched, so their properties (for example the font size that
 * sets the line height in PowerPoint) stay as they were.
 *
 * The runs of a line are grouped into spans of identical formatting. A line
 * with more than one span is sent for translation with markers `⟦1⟧…⟦/1⟧`
 * around each span, and the translated spans are written back into the original
 * runs, so run properties (font, size, colour, bold, links) stay attached to the
 * same words. Only text nodes change; every other byte of a part is copied
 * through.
 *
 * @module dsh-doc-translator/ooxml
 */

import { decodeText, escapeText, serialize, tokenize } from './xml.js'

/** Per-format settings: which parts hold text and the element names inside them. */
const FORMATS = {
  docx: {
    parts: /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/,
    paragraph: 'w:p', runs: ['w:r'], text: 'w:t', tab: 'w:tab', breaks: ['w:br', 'w:cr'], props: 'w:rPr',
    skip: ['w:del', 'w:moveFrom', 'mc:Fallback'], preserveAttr: true, removeEmptyRuns: false,
  },
  // DrawingML: a line break sits between runs, a tab is a tab character, `a:t` takes no attributes, and `a:r` needs an `a:t`.
  pptx: {
    parts: /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/,
    paragraph: 'a:p', runs: ['a:r', 'a:fld'], text: 'a:t', tab: null, breaks: [], paragraphBreaks: ['a:br'], props: 'a:rPr',
    skip: ['mc:Fallback'], preserveAttr: false, removeEmptyRuns: true,
  },
  // SpreadsheetML: a newline inside a cell is a character of the string, and `r` needs a `t`.
  xlsx: {
    parts: /^xl\/(?:sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/,
    paragraph: ['si', 'is'], runs: ['r'], text: 't', tab: null, breaks: [], props: 'rPr',
    skip: ['rPh'], bareText: true, preserveAttr: true, removeEmptyRuns: true, keepNewlines: true,
  },
}

export const SUPPORTED_EXTENSIONS = Object.keys(FORMATS)

const MARK_OPEN = n => `⟦${n}⟧`
const MARK_CLOSE = n => `⟦/${n}⟧`
const MARKER = /⟦\/?\d+⟧/g
const LETTER = /\p{L}/u

/** Attributes and children of run properties that do not change how text looks. */
function normalizeProps(raw) {
  return raw
    .replace(/<w:lang\b[^>]*\/>/g, '')
    .replace(/<w:noProof\b[^>]*\/>/g, '')
    .replace(/\s(?:lang|dirty|err|smtClean|noProof|altLang)="[^"]*"/g, '')
}

/** Detect the package format from its entry names. */
export function detectFormat(entries) {
  const names = new Set(entries.map(entry => entry.name))
  if (names.has('word/document.xml')) return 'docx'
  if (names.has('ppt/presentation.xml')) return 'pptx'
  if (names.has('xl/workbook.xml')) return 'xlsx'
  return null
}

/** True when `name` is in `list` (a string or an array of strings). */
const isOneOf = (list, name) => (Array.isArray(list) ? list.includes(name) : list === name)

/** Index of the close token that matches the open token at `from`. */
function matchingClose(tokens, from) {
  let depth = 0
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === 'open' && token.name === tokens[from].name) depth++
    else if (token.type === 'close' && token.name === tokens[from].name && --depth === 0) return i
  }
  throw new Error(`unclosed element <${tokens[from].name}>`)
}

/**
 * Walk one part and collect its paragraphs with their runs.
 *
 * `stack` holds the names of the open elements. A paragraph context records the
 * stack height at its open tag; a run does the same, so a child of a run is a
 * token seen while the stack is exactly that tall. Paragraphs nested inside a
 * run (text boxes) get their own context and leave the outer run untouched.
 * @param {import('./xml.js').Token[]} tokens - tokens of the part.
 * @param {object} cfg - format settings.
 * @returns {object[]} paragraphs: `{ openIdx, closeIdx, runs }`.
 */
function collectParagraphs(tokens, cfg) {
  const stack = []
  const opened = []
  const contexts = []
  const done = []
  let skipDepth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === 'text' || token.type === 'other') continue
    const ctx = contexts.at(-1)

    if (token.type === 'close') {
      if (isOneOf(cfg.skip, token.name)) skipDepth--
      if (ctx?.run && stack.length === ctx.run.base && token.name === ctx.run.name) {
        ctx.run.closeIdx = i
        ctx.runs.push(ctx.run)
        ctx.run = null
      }
      if (ctx && token.name === ctx.name && stack.length === ctx.base) {
        done.push({ openIdx: ctx.openIdx, closeIdx: i, runs: ctx.runs })
        contexts.pop()
      }
      stack.pop()
      opened.pop()
      continue
    }

    const insideRun = ctx?.run && stack.length === ctx.run.base
    if (token.type === 'open' && isOneOf(cfg.paragraph, token.name)) {
      contexts.push({ name: token.name, openIdx: i, base: stack.length + 1, runs: [], run: null })
    } else if (ctx && skipDepth === 0 && !ctx.run && token.type === 'open' && cfg.runs.includes(token.name)) {
      ctx.run = { name: token.name, openIdx: i, base: stack.length + 1, items: [], others: [], props: null, parent: opened.at(-1) }
    } else if (ctx && skipDepth === 0 && !ctx.run && cfg.paragraphBreaks?.includes(token.name) && stack.length === ctx.base) {
      // A line break that sits between runs: a boundary between two lines.
      ctx.runs.push({ name: token.name, openIdx: i, items: [], others: [], props: null, boundary: true })
    } else if (ctx && skipDepth === 0 && !ctx.run && cfg.bareText && token.name === cfg.text && stack.length === ctx.base) {
      // A string with no run wrapper: `<si><t>…</t></si>`.
      const run = { name: cfg.text, openIdx: i, base: stack.length + 1, items: [], others: [], props: null, bare: true, parent: opened.at(-1) }
      noteText(tokens, i, token, run, cfg)
      if (token.type === 'self') { run.closeIdx = i; ctx.runs.push(run) } else ctx.run = run
    } else if (insideRun && skipDepth === 0) {
      const run = ctx.run
      const end = token.type === 'self' ? i : matchingClose(tokens, i)
      if (token.name === cfg.props) run.props = { start: i, end }
      else if (token.name === cfg.text) noteText(tokens, i, token, run, cfg)
      else if (token.name === cfg.tab) run.items.push({ kind: 'tab', start: i, end })
      else if (cfg.breaks.includes(token.name)) run.items.push({ kind: 'br', start: i, end })
      else run.others.push(i)
    }

    if (isOneOf(cfg.skip, token.name) && token.type === 'open') skipDepth++
    if (token.type === 'open') { stack.push(token.name); opened.push(i) }
  }
  return done
}

/** Record a text element of a run. */
function noteText(tokens, i, token, run, cfg) {
  if (token.type === 'self') { run.items.push({ kind: 't', start: i, end: i, text: '' }); return }
  const next = tokens[i + 1]
  if (next?.type === 'text' && tokens[i + 2]?.type === 'close' && tokens[i + 2].name === cfg.text) {
    run.items.push({ kind: 't', start: i, end: i + 2, text: decodeText(next.raw) })
  } else if (next?.type === 'close' && next.name === cfg.text) {
    run.items.push({ kind: 't', start: i, end: i + 1, text: '' })
  }
}

/**
 * Split a paragraph into lines. Each line is a list of fragments: the part of a
 * run's text that lies between two breaks. Breaks belong to no fragment.
 */
function splitLines(paragraph) {
  const lines = [[]]
  for (const run of paragraph.runs) {
    if (run.boundary) { lines.push([]); continue }
    let fragment = null
    for (const item of run.items) {
      if (item.kind === 'br') { lines.push([]); fragment = null; continue }
      if (!fragment) { fragment = { run, items: [] }; lines.at(-1).push(fragment) }
      fragment.items.push(item)
    }
  }
  return lines
}

const fragmentText = fragment => fragment.items.map(item => (item.kind === 't' ? item.text : '\t')).join('')

/**
 * Group the fragments of a line into spans of equal formatting that share a
 * parent element. Runs under different parents (content controls, links) stay
 * in separate spans so each wrapper keeps its own text, and the translator
 * still sees the whole line. Whitespace-only fragments join the neighbouring
 * span when they share its parent and are otherwise a span of their own.
 */
function buildSpans(tokens, fragments) {
  const spans = []
  let pending = []
  const own = ({ fragment, text, sig, parent, rawProps }) => ({ sig, parent, rawProps, anchor: fragment, fragments: [fragment], text })
  const describe = (fragment) => {
    const { props, parent } = fragment.run
    const rawProps = props ? serialize(tokens.slice(props.start, props.end + 1)) : ''
    return { fragment, parent, rawProps, sig: `${normalizeProps(rawProps)}#${parent}`, text: fragmentText(fragment) }
  }
  for (const fragment of fragments) {
    const info = describe(fragment)
    if (info.text === '') continue
    const last = spans.at(-1)
    if (info.text.trim() === '') {
      if (last && last.parent === info.parent) { last.fragments.push(fragment); last.text += info.text } else pending.push(info)
      continue
    }
    const lead = pending.filter(p => p.parent === info.parent)
    for (const other of pending.filter(p => p.parent !== info.parent)) spans.push(own(other))
    pending = []
    const previous = spans.at(-1)
    if (previous && previous.sig === info.sig && lead.length === 0) {
      previous.fragments.push(fragment)
      previous.text += info.text
    } else {
      spans.push({ sig: info.sig, parent: info.parent, rawProps: info.rawProps, anchor: fragment, fragments: [...lead.map(p => p.fragment), fragment], text: lead.map(p => p.text).join('') + info.text })
    }
  }
  for (const other of pending) spans.push(own(other))
  return spans
}

/**
 * Read a package and list the text to translate.
 * @param {Array<{ name: string, data: Buffer }>} entries - ZIP entries of the package.
 * @param {'docx' | 'pptx' | 'xlsx'} format - package format.
 * @returns {{ format: string, parts: object[], segments: Array<{ id: string, text: string }> }} the parsed parts and the lines to translate.
 */
export function analyze(entries, format) {
  const cfg = FORMATS[format]
  const parts = []
  const segments = []
  for (const entry of entries) {
    if (!cfg.parts.test(entry.name)) continue
    const tokens = tokenize(entry.data.toString('utf8'))
    const lines = []
    const runs = new Set()
    for (const paragraph of collectParagraphs(tokens, cfg)) {
      for (const run of paragraph.runs) if (!run.boundary) runs.add(run)
      for (const fragments of splitLines(paragraph)) {
        const spans = buildSpans(tokens, fragments)
        if (!LETTER.test(spans.map(span => span.text).join(''))) continue
        const id = `${parts.length}:${lines.length}`
        const text = spans.length === 1 ? spans[0].text : spans.map((span, k) => `${MARK_OPEN(k + 1)}${span.text}${MARK_CLOSE(k + 1)}`).join('')
        lines.push({ id, spans, text })
        segments.push({ id, text })
      }
    }
    parts.push({ name: entry.name, tokens, lines, runs: [...runs] })
  }
  return { format, parts, segments }
}

/**
 * Split a translation into its marked spans.
 * Whitespace between markers stays with the span before it. Text outside the
 * markers, a stray marker, a nested marker, or a marker set that is not exactly
 * the source set makes the split fail.
 * @param {string} translation - translated text with markers.
 * @param {number} count - number of spans in the source line.
 * @returns {Array<{ k: number, text: string }> | null} spans in translation order, or `null` when the markers do not match the source.
 */
export function splitMarkers(translation, count) {
  const pattern = /⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧/g
  const found = []
  let last = 0
  let match
  while ((match = pattern.exec(translation)) !== null) {
    const gap = translation.slice(last, match.index)
    if (gap.trim() !== '') return null
    if (gap !== '') {
      if (found.length > 0) found.at(-1).text += gap
      else return null
    }
    if (/⟦\/?\d+⟧/.test(match[2])) return null
    found.push({ k: Number(match[1]) - 1, text: match[2] })
    last = pattern.lastIndex
  }
  const tail = translation.slice(last)
  if (tail.trim() !== '') return null
  if (tail !== '' && found.length > 0) found.at(-1).text += tail
  if (found.length !== count) return null
  const ks = found.map(part => part.k).sort((x, y) => x - y)
  return ks.every((k, i) => k === i) ? found : null
}

/** Remove every marker from text. */
export const stripMarkers = text => text.replace(MARKER, '')

/** XML for translated text inside one run: text and, where the format has one, tab elements. */
function contentXml(text, cfg) {
  const element = piece => (piece === '' ? '' : `<${cfg.text}${cfg.preserveAttr ? ' xml:space="preserve"' : ''}>${escapeText(piece)}</${cfg.text}>`)
  const clean = cfg.keepNewlines ? text : text.replace(/[\r\n]+/g, ' ')
  if (!cfg.tab) return element(clean)
  let out = ''
  for (const piece of clean.split(/(\t)/)) out += piece === '\t' ? `<${cfg.tab}/>` : element(piece)
  return out
}

/**
 * Write translations back into the parts.
 * @param {ReturnType<typeof analyze>} model - result of `analyze`.
 * @param {Map<string, string>} translations - translated text by segment id; a missing id keeps the source text.
 * @returns {{ files: Map<string, string>, warnings: Array<{ id: string, reason: string }>, applied: number }} new part contents by entry name.
 */
export function apply(model, translations) {
  const cfg = FORMATS[model.format]
  const files = new Map()
  const warnings = []
  let applied = 0
  for (const part of model.parts) {
    const deleted = new Set()
    const inserts = new Map()
    const contentRuns = new Set()
    const insert = (index, text) => { if (text !== '') inserts.set(index, [...(inserts.get(index) ?? []), text]) }
    // A run that holds text of more than one line must keep its own properties.
    const owners = new Map()
    for (const line of part.lines) {
      for (const span of line.spans) {
        for (const fragment of span.fragments) owners.set(fragment.run, new Set([...(owners.get(fragment.run) ?? []), line.id]))
      }
    }
    let changed = false
    for (const line of part.lines) {
      const translation = translations.get(line.id)
      if (translation === undefined) continue
      const { spans } = line
      let pieces
      if (spans.length === 1) pieces = [{ k: 0, text: stripMarkers(translation) }]
      else {
        pieces = splitMarkers(translation, spans.length)
        // Moving a span gives its slot another span's run properties, which is only safe when the run holds no other line.
        const unsafe = pieces?.some((piece, slot) => piece.k !== slot && owners.get(spans[slot].anchor.run).size > 1)
        if (pieces === null || unsafe) {
          const dominant = spans.reduce((best, span, k) => (span.text.length > spans[best].text.length ? k : best), 0)
          pieces = spans.map((_, k) => ({ k, text: k === dominant ? stripMarkers(translation) : '' }))
          warnings.push({ id: line.id, reason: 'format_simplified' })
        }
      }
      pieces.forEach((piece, slot) => {
        const target = spans[slot]
        const { anchor } = target
        for (const fragment of target.fragments) {
          for (const item of fragment.items) for (let i = item.start; i <= item.end; i++) deleted.add(i)
        }
        if (piece.k !== slot && !anchor.run.bare) {
          // The span moved: give this slot the formatting of the words now in it.
          const { props } = anchor.run
          if (props) for (let i = props.start; i <= props.end; i++) deleted.add(i)
          insert(anchor.run.openIdx + 1, spans[piece.k].rawProps)
        }
        if (piece.text !== '') {
          insert(anchor.items[0].start, contentXml(piece.text, cfg))
          contentRuns.add(anchor.run)
        }
        for (const fragment of target.fragments) {
          const lo = fragment.items[0].start
          const hi = fragment.items.at(-1).end
          if (fragment.run.others.some(index => index > lo && index < hi)) warnings.push({ id: line.id, reason: 'content_moved' })
        }
      })
      applied++
      changed = true
    }
    if (!changed) continue
    if (cfg.removeEmptyRuns) {
      // A run with no text left is invalid in DrawingML and SpreadsheetML: remove it whole.
      for (const run of part.runs) {
        if (run.bare || contentRuns.has(run) || run.items.length === 0 || run.others.length > 0) continue
        if (!run.items.every(item => deleted.has(item.start))) continue
        for (let i = run.openIdx; i <= run.closeIdx; i++) deleted.add(i)
      }
    }
    let out = ''
    part.tokens.forEach((token, i) => {
      if (inserts.has(i)) out += inserts.get(i).join('')
      if (!deleted.has(i)) out += token.raw
    })
    files.set(part.name, out)
  }
  return { files, warnings, applied }
}

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'])

/**
 * One font family from a font attribute. Files exported from web tools name a
 * CSS list such as `'Times New Roman',serif`: the first family is the font and
 * the generic name is only a fallback.
 * @param {string} raw - attribute value.
 * @returns {string | null} the family, or `null` for an empty or generic name.
 */
export function fontFamily(raw) {
  const first = raw.split(',')[0].trim().replace(/^['"]+|['"]+$/g, '').trim()
  return first === '' || GENERIC_FAMILIES.has(first.toLowerCase()) ? null : first
}

/**
 * Font names used by a package, for the report.
 * @param {Array<{ name: string, data: Buffer }>} entries - ZIP entries.
 * @returns {string[]} distinct font family names (compared without regard to case), sorted.
 */
export function usedFonts(entries) {
  const fonts = new Map()
  const add = (raw) => {
    const family = fontFamily(decodeText(raw))
    if (family !== null && !fonts.has(family.toLowerCase())) fonts.set(family.toLowerCase(), family)
  }
  for (const entry of entries) {
    if (!/\.xml$/.test(entry.name) || !/^(?:word|ppt|xl)\//.test(entry.name)) continue
    const xml = entry.data.toString('utf8')
    // Only font elements: `w:lang w:eastAsia="zh-CN"` is a language tag, not a font.
    for (const match of xml.matchAll(/<(?:w:rFonts|a:latin|a:ea|a:cs|a:sym)\b[^>]*>/g)) {
      for (const attr of match[0].matchAll(/(?:w:ascii|w:hAnsi|w:eastAsia|w:cs|typeface)="([^"]+)"/g)) {
        if (!/^[+]|^(?:minorHAnsi|majorHAnsi|minorEastAsia|majorEastAsia|minorBidi|majorBidi)$/.test(attr[1])) add(attr[1])
      }
    }
    for (const match of xml.matchAll(/<font\b[^>]*\bname="([^"]+)"/g)) add(match[1])
    for (const match of xml.matchAll(/<name val="([^"]+)"/g)) add(match[1])
  }
  return [...fonts.values()].sort()
}
