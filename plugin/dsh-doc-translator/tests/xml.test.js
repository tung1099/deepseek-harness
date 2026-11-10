import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeText, escapeText, serialize, tokenize } from '../xml.js'

test('serializing the tokens returns the original text, byte for byte', () => {
  const samples = [
    '<?xml version="1.0"?>\n<a x="1 > 2" y=\'q\'><b/>text &amp; more<!-- c > d --><![CDATA[ <raw> ]]></a>',
    '<w:t xml:space="preserve">  spaces  </w:t>',
    '<a>\n  <b>\n  </b>\n</a>',
    'plain text with no tags',
    '',
  ]
  for (const xml of samples) assert.equal(serialize(tokenize(xml)), xml)
})

test('tokens carry type and element name, and ">" inside an attribute does not end the tag', () => {
  const tokens = tokenize('<p:a x="1>2"><b/>t</p:a>')
  assert.deepEqual(tokens.map(t => [t.type, t.name]), [['open', 'p:a'], ['self', 'b'], ['text', undefined], ['close', 'p:a']])
})

test('an unterminated tag or comment is reported', () => {
  assert.throws(() => tokenize('<a x="1'), /unterminated XML tag/)
  assert.throws(() => tokenize('<!-- never closed'), /unterminated XML construct/)
})

test('entities decode and text escapes only what must be escaped', () => {
  assert.equal(decodeText('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65; &#x42;'), 'a & b <c> "d" \'e\' A B')
  assert.equal(escapeText('a & b <c> "d"'), 'a &amp; b &lt;c&gt; "d"')
  assert.equal(decodeText(escapeText('x < y && z > w')), 'x < y && z > w')
})
