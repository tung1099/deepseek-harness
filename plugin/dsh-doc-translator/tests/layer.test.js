import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanFamily, letterCount, parsePdfXml } from '../layer.js'
import { fontFamily, usedFonts } from '../ooxml.js'
import { renderScanSummary } from '../summary.js'

test('font names lose the subset prefix and the PostScript suffixes, and give weight and slant', () => {
  assert.deepEqual(cleanFamily('ABCDEE+Calibri-Bold'), { family: 'Calibri', bold: true, italic: false })
  assert.deepEqual(cleanFamily('ArialMT'), { family: 'Arial', bold: false, italic: false })
  assert.deepEqual(cleanFamily('TimesNewRomanPS-BoldItalicMT'), { family: 'Times New Roman', bold: true, italic: true })
  assert.deepEqual(cleanFamily('BAAAAA+LiberationSans'), { family: 'Liberation Sans', bold: false, italic: false })
  assert.equal(cleanFamily('Cambria-Italic').italic, true)
})

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<pdf2xml producer="poppler" version="24.02.0">
<page number="1" position="absolute" top="0" left="0" height="1000" width="800">
	<fontspec id="0" size="20" family="BAAAAA+LiberationSerif" color="#000000"/>
	<fontspec id="1" size="16" family="CAAAAA+Arial-BoldMT" color="#cc0000"/>
<text top="100" left="80" width="400" height="25" font="0">Tom &amp; Jerry&apos;s <i>report</i></text>
<text top="150" left="80" width="200" height="20" font="1"><b>Heading</b></text>
<text top="180" left="80" width="10" height="20" font="0"> </text>
<text top="200" left="-5" width="100" height="20" font="0"><a href="https://x.test/"><b>link text</b></a></text>
</page>
<page number="2" position="absolute" top="0" left="0" height="1000" width="800">
<text top="10" left="10" width="50" height="20" font="0">12345</text>
</page>
</pdf2xml>`

test('pages, lines, positions on a 0 to 1000 scale and the style of each line are read', () => {
  const pages = parsePdfXml(XML)
  assert.deepEqual(pages.map(p => p.number), [1, 2])
  const [first] = pages
  assert.deepEqual(first.lines.map(l => l.text), ["Tom & Jerry's report", 'Heading', 'link text'], 'entities decode, tags drop, blank lines are skipped')
  assert.deepEqual(first.lines[0].quad, [100, 100, 600, 100, 600, 125, 100, 125])
  assert.deepEqual(first.lines[2].quad.slice(0, 2), [-6.2, 200], 'a line that starts left of the page keeps its negative position')
  assert.deepEqual({ family: first.lines[0].family, size: first.lines[0].size, color: first.lines[0].color, bold: first.lines[0].bold, italic: first.lines[0].italic },
    { family: 'Liberation Serif', size: 0.025, color: '#000000', bold: false, italic: false }, 'the italic word does not make the whole line italic')
  assert.deepEqual({ family: first.lines[1].family, color: first.lines[1].color, bold: first.lines[1].bold }, { family: 'Arial', color: '#cc0000', bold: true })
  assert.equal(first.lines[2].bold, true, 'a line that is bold from end to end, inside a link, is bold')
})

test('a font defined on one page is known on the next', () => {
  const second = parsePdfXml(XML)[1]
  assert.equal(second.lines[0].family, 'Liberation Serif')
})

test('letters are counted per page, so a page of numbers or an empty page has no usable text layer', () => {
  const [first, second] = parsePdfXml(XML)
  assert.equal(letterCount(first), 'Tom & Jerry\'s report'.replace(/[^\p{L}]/gu, '').length + 'Heading'.length + 'linktext'.length)
  assert.equal(letterCount(second), 0)
  assert.equal(letterCount({ lines: [] }), 0)
  assert.deepEqual(parsePdfXml('<pdf2xml></pdf2xml>'), [])
})

// ---- font names in Office files ----

test('a CSS font list gives its first family, and a generic name alone gives none', () => {
  assert.equal(fontFamily("'Times New Roman',serif"), 'Times New Roman')
  assert.equal(fontFamily('Arial, sans-serif'), 'Arial')
  assert.equal(fontFamily('"Noto Sans"'), 'Noto Sans')
  assert.equal(fontFamily('serif'), null)
  assert.equal(fontFamily('  '), null)
})

test('the font report has each family once, whatever the spelling, and no generic names', () => {
  const styles = '<font><name val="&apos;Times New Roman&apos;,serif"/></font><font><name val="Times New Roman"/></font><font><name val="times new roman"/></font><font><name val="Arial, sans-serif"/></font><font><name val="serif"/></font><font><name val="Arial"/></font>'
  assert.deepEqual(usedFonts([{ name: 'xl/styles.xml', data: Buffer.from(styles) }]), ['Arial', 'Times New Roman'])
  const word = '<w:rFonts w:ascii="&apos;Calibri&apos;,sans-serif" w:hAnsi="Calibri" w:eastAsia="MS Mincho"/>'
  assert.deepEqual(usedFonts([{ name: 'word/styles.xml', data: Buffer.from(word) }]), ['Calibri', 'MS Mincho'])
})

// ---- summary ----

const REPORT = (routes, extra = {}) => ({ pages: routes.layer + routes.ocr, routes, lines: { total: 10, translated: 10, failed: 0 }, failures: [], stats: { calls: 2, byModel: { T: 2 } }, render: { overflow: 0, shrunk: 0 }, notes: [], ...extra })

test('a PDF read from its text layer says so, says the output lost selectable text, and gives no OCR warning', () => {
  const text = renderScanSummary({ file: '/w/a.vi.pdf', extension: 'pdf', target: 'Vietnamese', report: REPORT({ layer: 3, ocr: 0 }) })
  assert.match(text, /Text source: 3 page\(s\) read exactly from the PDF text layer \(no OCR\), 0 page\(s\) read with OCR\./)
  assert.match(text, /text cannot be selected or searched, although the text of the original could be/)
  assert.match(text, /keep the font family, size, colour and weight named in the PDF.*Arial as Liberation Sans/)
  assert.doesNotMatch(text, /scanned/)
  assert.doesNotMatch(text, /Text read wrongly by OCR/)
})

test('OCR pages get the approximation and the OCR-error warning, and a mixed PDF gets both', () => {
  const ocr = renderScanSummary({ file: '/w/a.vi.pdf', extension: 'pdf', target: 'Vietnamese', report: REPORT({ layer: 0, ocr: 2 }) })
  assert.match(ocr, /OCR pages: fonts are approximated.*Text read wrongly by OCR is translated wrongly/)
  assert.doesNotMatch(ocr, /although the text of the original could be/)
  const mixed = renderScanSummary({ file: '/w/a.vi.pdf', extension: 'pdf', target: 'Vietnamese', report: REPORT({ layer: 1, ocr: 1 }) })
  assert.match(mixed, /1 page\(s\) read exactly from the PDF text layer.*1 page\(s\) read with OCR/)
  assert.match(mixed, /named in the PDF/)
  assert.match(mixed, /OCR pages: fonts are approximated/)
})
