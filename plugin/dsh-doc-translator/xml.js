/**
 * Lossless XML tokenizer for Office Open XML parts.
 *
 * Splits a document into tags and text without interpreting it, so that
 * serializing the tokens returns the original bytes. Only the structure the
 * translator needs is recognized: open, close and self-closing tags, text, and
 * everything else (comments, processing instructions, CDATA, doctype) kept raw.
 *
 * @module dsh-doc-translator/xml
 */

/** @typedef {{ type: 'open' | 'close' | 'self' | 'text' | 'other', raw: string, name?: string }} Token */

const NAME = /^<\/?([^\s/>]+)/

/**
 * Tokenize an XML document.
 * @param {string} xml - the document text.
 * @returns {Token[]} tokens whose `raw` values concatenate to `xml`.
 */
export function tokenize(xml) {
  const tokens = []
  let i = 0
  while (i < xml.length) {
    if (xml[i] !== '<') {
      const end = xml.indexOf('<', i)
      const stop = end < 0 ? xml.length : end
      tokens.push({ type: 'text', raw: xml.slice(i, stop) })
      i = stop
      continue
    }
    let end
    let type
    if (xml.startsWith('<!--', i)) { end = endOf(xml, '-->', i, 3); type = 'other' }
    else if (xml.startsWith('<![CDATA[', i)) { end = endOf(xml, ']]>', i, 3); type = 'text' }
    else if (xml.startsWith('<?', i)) { end = endOf(xml, '?>', i, 2); type = 'other' }
    else if (xml.startsWith('<!', i)) { end = endOf(xml, '>', i, 1); type = 'other' }
    else {
      end = tagEnd(xml, i)
      const raw = xml.slice(i, end)
      type = raw.startsWith('</') ? 'close' : (raw.endsWith('/>') ? 'self' : 'open')
      tokens.push({ type, raw, name: NAME.exec(raw)?.[1] })
      i = end
      continue
    }
    tokens.push({ type, raw: xml.slice(i, end) })
    i = end
  }
  return tokens
}

function endOf(xml, terminator, from, length) {
  const at = xml.indexOf(terminator, from)
  if (at < 0) throw new Error(`unterminated XML construct at offset ${from}`)
  return at + length
}

/** End offset of a tag starting at `from`, skipping `>` inside quoted attribute values. */
function tagEnd(xml, from) {
  let quote = ''
  for (let i = from + 1; i < xml.length; i++) {
    const ch = xml[i]
    if (quote) { if (ch === quote) quote = '' } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') return i + 1
  }
  throw new Error(`unterminated XML tag at offset ${from}`)
}

/** Serialize tokens back to text. */
export function serialize(tokens) {
  let out = ''
  for (const token of tokens) out += token.raw
  return out
}

const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g

/** Decode the five predefined entities and numeric character references. */
export function decodeText(text) {
  return text.replace(ENTITY, (_, body) => {
    if (body[0] === '#') return String.fromCodePoint(body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10))
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body]
  })
}

/** Escape text for use between tags. */
export function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
