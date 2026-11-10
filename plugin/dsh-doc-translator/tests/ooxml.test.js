import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyze, apply, detectFormat, splitMarkers, stripMarkers, usedFonts } from '../ooxml.js'
import { readZip } from '../zip.js'
import { buildDocx, buildPptx, buildXlsx } from './build.js'

const load = (buffer, format) => {
  const entries = readZip(buffer)
  return { entries, model: analyze(entries, format ?? detectFormat(entries)) }
}
const byText = (model, needle) => model.segments.find(s => s.text.includes(needle))
const withoutSpacePreserve = xml => xml.replace(/ xml:space="preserve"/g, '')
const partXml = (entries, name) => entries.find(e => e.name === name).data.toString('utf8')
/** The text of every `<w:t>`-like element in order, for readable assertions. */
const texts = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, 'g'))].map(m => m[1])

test('the package format is detected from its parts', () => {
  assert.equal(detectFormat(readZip(buildDocx())), 'docx')
  assert.equal(detectFormat(readZip(buildPptx())), 'pptx')
  assert.equal(detectFormat(readZip(buildXlsx())), 'xlsx')
  assert.equal(detectFormat([{ name: 'readme.txt' }]), null)
})

// ---- DOCX ----

test('docx: one segment per line; marked spans where formatting changes', () => {
  const { model } = load(buildDocx())
  const text = model.segments.map(s => s.text)
  assert.ok(text.includes('Annual report'))
  assert.ok(text.includes('⟦1⟧This is ⟦/1⟧⟦2⟧very important⟦/2⟧⟦3⟧ and ⟦/3⟧⟦4⟧urgent⟦/4⟧⟦5⟧.⟦/5⟧'))
  assert.ok(text.includes('⟦1⟧Visit ⟦/1⟧⟦2⟧our website⟦/2⟧⟦3⟧ for details & more.⟦/3⟧'), 'entities decoded, link text is its own span')
  assert.ok(text.includes('Name\tValue'), 'a tab becomes a character')
  assert.ok(text.includes('Second line'), 'a line break ends a segment')
  assert.ok(!text.some(t => t.includes('\n')), 'no segment spans a line break')
  assert.ok(text.includes('Cell one') && text.includes('Cell two'))
})

test('docx: numbers-only, empty, deleted and page-break content is not offered for translation', () => {
  const { model } = load(buildDocx())
  const all = model.segments.map(s => s.text).join('|')
  assert.doesNotMatch(all, /12345/)
  assert.doesNotMatch(all, /old text/)
  assert.ok(model.segments.some(s => s.text === 'Before the break'), 'text before a page break is translated')
  assert.ok(model.segments.some(s => s.text === 'kept text'))
})

test('docx: a paragraph inside a text box is its own segment and does not leak into the outer one', () => {
  const { model } = load(buildDocx())
  assert.ok(model.segments.some(s => s.text === 'Inside box'))
  assert.ok(model.segments.some(s => s.text === 'Outer text'))
})

test('docx: headers are translated and keep their own part', () => {
  const { model } = load(buildDocx({ header: '<w:p><w:r><w:t>Page header text</w:t></w:r></w:p>' }))
  assert.ok(model.parts.some(p => p.name === 'word/header1.xml' && p.lines.length === 1))
})

test('docx: applying the source text back changes nothing but xml:space', () => {
  const { entries, model } = load(buildDocx())
  const identity = new Map(model.segments.map(s => [s.id, s.text]))
  const { files, warnings } = apply(model, identity)
  assert.deepEqual(warnings, [])
  assert.equal(withoutSpacePreserve(files.get('word/document.xml')), withoutSpacePreserve(partXml(entries, 'word/document.xml')))
})

test('docx: translated spans land in the runs that carry their formatting', () => {
  const { model } = load(buildDocx())
  const seg = byText(model, 'very important')
  const out = apply(model, new Map([[seg.id, '⟦1⟧Đây là ⟦/1⟧⟦2⟧rất quan trọng⟦/2⟧⟦3⟧ và ⟦/3⟧⟦4⟧khẩn cấp⟦/4⟧⟦5⟧.⟦/5⟧']])).files.get('word/document.xml')
  assert.match(out, /<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">rất quan trọng<\/w:t><\/w:r>/)
  assert.match(out, /<w:r><w:rPr><w:i\/><w:lang w:val="en-US"\/><\/w:rPr><w:t xml:space="preserve">khẩn cấp<\/w:t><\/w:r>/)
  assert.doesNotMatch(out, /very important|urgent/)
})

test('docx: when word order changes, each span keeps its own formatting', () => {
  const { model } = load(buildDocx())
  const seg = byText(model, 'very important')
  const out = apply(model, new Map([[seg.id, '⟦4⟧Urgent⟦/4⟧⟦3⟧ and ⟦/3⟧⟦2⟧very important⟦/2⟧⟦1⟧ this is ⟦/1⟧⟦5⟧.⟦/5⟧']])).files.get('word/document.xml')
  const runs = [...out.matchAll(/<w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t xml:space="preserve">([^<]*)<\/w:t><\/w:r>/g)].map(m => [m[1] ?? '', m[2]])
  const urgent = runs.find(([, t]) => t === 'Urgent')
  assert.match(urgent[0], /<w:i\/>/, 'the moved word is italic, as in the source')
  const important = runs.find(([, t]) => t === 'very important')
  assert.match(important[0], /<w:b\/>/)
  assert.deepEqual(texts(out, 'w:t').slice(1, 6), ['Urgent', ' and ', 'very important', ' this is ', '.'])
})

test('docx: lost markers fall back to one run, keep every word, and are reported', () => {
  const { model } = load(buildDocx())
  const seg = byText(model, 'very important')
  const { files, warnings } = apply(model, new Map([[seg.id, 'Đây là rất quan trọng và khẩn cấp.']]))
  assert.deepEqual(warnings, [{ id: seg.id, reason: 'format_simplified' }])
  const out = files.get('word/document.xml')
  assert.match(out, /Đây là rất quan trọng và khẩn cấp\./)
  assert.doesNotMatch(out, /very important|⟦/)
})

test('docx: stray, duplicate or extra markers also fall back instead of producing broken text', () => {
  const { model } = load(buildDocx())
  const seg = byText(model, 'very important')
  for (const bad of ['⟦1⟧A⟦/1⟧⟦2⟧B⟦/2⟧', '⟦1⟧A⟦/1⟧⟦1⟧B⟦/1⟧⟦3⟧C⟦/3⟧⟦4⟧D⟦/4⟧⟦5⟧E⟦/5⟧', '⟦1⟧A⟦/1⟧⟦2⟧B⟦/2⟧⟦3⟧C⟦/3⟧⟦4⟧D⟦/4⟧⟦5⟧E⟦/5⟧ extra', 'x ⟦9⟧']) {
    const { files, warnings } = apply(model, new Map([[seg.id, bad]]))
    assert.equal(warnings[0]?.reason, 'format_simplified', bad)
    assert.doesNotMatch(files.get('word/document.xml'), /⟦/, bad)
  }
})

test('docx: a tab in the translation becomes a tab element and the line break between two lines is left exactly as it was', () => {
  const body = ['<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Name</w:t><w:tab/><w:t>Value</w:t><w:br w:clear="all"/><w:t>Second line</w:t></w:r></w:p>']
  const { model } = load(buildDocx({ body }))
  assert.deepEqual(model.segments.map(s => s.text), ['Name\tValue', 'Second line'])
  const out = apply(model, new Map([['0:0', 'Tên\tGiá trị'], ['0:1', 'Dòng hai']])).files.get('word/document.xml')
  assert.match(out, /<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Tên<\/w:t><w:tab\/><w:t xml:space="preserve">Giá trị<\/w:t><w:br w:clear="all"\/><w:t xml:space="preserve">Dòng hai<\/w:t><\/w:r>/)
})

test('docx: a newline the model adds inside a line does not become a break', () => {
  const { model } = load(buildDocx())
  const seg = byText(model, 'Cell one')
  const out = apply(model, new Map([[seg.id, 'Ô một\nô hai']])).files.get('word/document.xml')
  assert.match(out, /<w:t xml:space="preserve">Ô một ô hai<\/w:t>/)
})

test('docx: a page break stays where it was, and text with markup characters is escaped', () => {
  const { model } = load(buildDocx())
  const seg = byText(model, 'Before the break')
  const out = apply(model, new Map([[seg.id, 'Trước <ngắt> & trang']])).files.get('word/document.xml')
  assert.match(out, /<w:t xml:space="preserve">Trước &lt;ngắt&gt; &amp; trang<\/w:t><w:br w:type="page"\/>/)
})

test('docx: the hyperlink wrapper and its relationship id survive translation', () => {
  const { model } = load(buildDocx())
  const seg = byText(model, 'our website')
  const out = apply(model, new Map([[seg.id, '⟦1⟧Truy cập ⟦/1⟧⟦2⟧trang web của chúng tôi⟦/2⟧⟦3⟧ để biết chi tiết & thêm.⟦/3⟧']])).files.get('word/document.xml')
  assert.match(out, /<w:hyperlink r:id="rId5"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t xml:space="preserve">trang web của chúng tôi<\/w:t><\/w:r><\/w:hyperlink>/)
  assert.match(out, /để biết chi tiết &amp; thêm\./)
})

test('docx: segments that get no translation are left exactly as they were', () => {
  const { entries, model } = load(buildDocx())
  const { files } = apply(model, new Map())
  assert.equal(files.size, 0)
  assert.ok(entries.length > 0)
})

test('docx: translating the text box paragraph does not disturb the outer paragraph', () => {
  const { model } = load(buildDocx())
  const inner = model.segments.find(s => s.text === 'Inside box')
  const out = apply(model, new Map([[inner.id, 'Trong hộp']])).files.get('word/document.xml')
  assert.match(out, /<w:t>Outer text<\/w:t>/)
  assert.match(out, /<w:txbxContent><w:p><w:r><w:t xml:space="preserve">Trong hộp<\/w:t><\/w:r><\/w:p><\/w:txbxContent>/)
})

// ---- PPTX ----

test('pptx: a line break splits two lines that stay in order; fields and slide numbers are not offered', () => {
  const { model } = load(buildPptx())
  assert.deepEqual(model.segments.map(s => s.text), ['Quarterly results', '⟦1⟧Revenue grew ⟦/1⟧⟦2⟧strongly⟦/2⟧⟦3⟧ this quarter⟦/3⟧', 'Second line'])
})

test('pptx: language tags do not split spans; formatting stays on the translated runs; a:t gets no attributes', () => {
  const { model } = load(buildPptx())
  const seg = byText(model, 'strongly')
  const out = apply(model, new Map([[seg.id, '⟦1⟧Doanh thu tăng ⟦/1⟧⟦2⟧mạnh⟦/2⟧⟦3⟧ trong quý này⟦/3⟧']])).files.get('ppt/slides/slide1.xml')
  assert.match(out, /<a:r><a:rPr lang="en-US" sz="2000" b="1"\/><a:t>mạnh<\/a:t><\/a:r>/)
  assert.doesNotMatch(out, /<a:t [^>]*>/, 'PowerPoint rejects attributes on a:t')
  assert.match(out, /<a:fld id="\{B1\}" type="slidenum"><a:rPr lang="en-US"\/><a:t>3<\/a:t><\/a:fld>/)
})

test('pptx: a line break keeps its own properties byte for byte, including a leading one', () => {
  const shape = '<p:sp><p:nvSpPr><p:cNvPr id="4" name="B"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:br><a:rPr sz="1200"/></a:br><a:r><a:rPr sz="1200" b="1"/><a:t>First</a:t></a:r><a:br><a:rPr sz="1800"/></a:br><a:r><a:rPr sz="1200" b="1"/><a:t>Second</a:t></a:r></a:p></p:txBody></p:sp>'
  const { model } = load(buildPptx({ shapes: [shape] }))
  assert.deepEqual(model.segments.map(s => s.text), ['First', 'Second'])
  const out = apply(model, new Map([['0:0', 'Đầu'], ['0:1', 'Hai']])).files.get('ppt/slides/slide1.xml')
  assert.match(out, /<a:p><a:br><a:rPr sz="1200"\/><\/a:br><a:r><a:rPr sz="1200" b="1"\/><a:t>Đầu<\/a:t><\/a:r><a:br><a:rPr sz="1800"\/><\/a:br><a:r><a:rPr sz="1200" b="1"\/><a:t>Hai<\/a:t><\/a:r><\/a:p>/)
})

test('pptx: a run left without text is removed, because a:r without a:t is invalid', () => {
  const shape = '<p:sp><p:nvSpPr><p:cNvPr id="4" name="B"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1200"/><a:t>Hello </a:t></a:r><a:r><a:rPr sz="1200" lang="vi-VN"/><a:t>world</a:t></a:r></a:p></p:txBody></p:sp>'
  const { model } = load(buildPptx({ shapes: [shape] }))
  assert.equal(model.segments[0].text, 'Hello world', 'language tags do not split the span')
  const out = apply(model, new Map([['0:0', 'Xin chào thế giới']])).files.get('ppt/slides/slide1.xml')
  assert.match(out, /<a:p><a:r><a:rPr sz="1200"\/><a:t>Xin chào thế giới<\/a:t><\/a:r><\/a:p>/)
  assert.equal((out.match(/<a:r>/g) ?? []).length, (out.match(/<a:t>/g) ?? []).length, 'every run has its text')
})

test('pptx: applying the source text back keeps every segment', () => {
  const { model } = load(buildPptx())
  const identity = new Map(model.segments.map(s => [s.id, s.text]))
  const files = apply(model, identity).files
  const again = analyze([{ name: 'ppt/slides/slide1.xml', data: Buffer.from(files.get('ppt/slides/slide1.xml')) }], 'pptx')
  assert.deepEqual(again.segments.map(s => s.text), model.segments.map(s => s.text))
})

test('docx: two content controls with the same formatting stay two spans, so neither is left empty', () => {
  const sdt = text => `<w:sdt><w:sdtPr><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>${text}</w:t></w:r></w:sdtContent></w:sdt>`
  const { model } = load(buildDocx({ body: [`<w:p>${sdt('address postal code')}<w:r><w:rPr></w:rPr></w:r>${sdt('address city')}</w:p>`] }))
  assert.deepEqual(model.segments.map(s => s.text), ['⟦1⟧address postal code⟦/1⟧⟦2⟧address city⟦/2⟧'])
  const out = apply(model, new Map([['0:0', '⟦1⟧mã bưu chính⟦/1⟧ ⟦2⟧thành phố⟦/2⟧']])).files.get('word/document.xml')
  assert.match(out, /<w:sdtContent><w:r><w:t xml:space="preserve">mã bưu chính <\/w:t><\/w:r><\/w:sdtContent>/)
  assert.match(out, /<w:sdtContent><w:r><w:t xml:space="preserve">thành phố<\/w:t><\/w:r><\/w:sdtContent>/)
})

test('docx: a space in its own wrapper stays in the text the model sees and in its own wrapper', () => {
  const body = ['<w:p><w:r><w:t>Hello</w:t></w:r><w:hyperlink r:id="rId5"><w:r><w:t xml:space="preserve"> </w:t></w:r></w:hyperlink><w:r><w:t>world</w:t></w:r></w:p>']
  const { model } = load(buildDocx({ body }))
  assert.equal(model.segments[0].text, '⟦1⟧Hello⟦/1⟧⟦2⟧ ⟦/2⟧⟦3⟧world⟦/3⟧')
  const out = apply(model, new Map([['0:0', '⟦1⟧Xin⟦/1⟧⟦2⟧ ⟦/2⟧⟦3⟧chào⟦/3⟧']])).files.get('word/document.xml')
  assert.match(out, /<w:hyperlink r:id="rId5"><w:r><w:t xml:space="preserve"> <\/w:t><\/w:r><\/w:hyperlink>/)
})

test('docx: a break inside a content control does not merge the lines on either side', () => {
  const body = ['<w:p><w:sdt><w:sdtPr><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Sender</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Company</w:t></w:r></w:sdtContent></w:sdt></w:p>']
  const { model } = load(buildDocx({ body }))
  assert.deepEqual(model.segments.map(s => s.text), ['Sender', 'Company'])
  const out = apply(model, new Map([['0:0', 'Người gửi'], ['0:1', 'Công ty']])).files.get('word/document.xml')
  assert.match(out, /<w:r><w:t xml:space="preserve">Người gửi<\/w:t><\/w:r><w:r><w:br\/><\/w:r><w:r><w:t xml:space="preserve">Công ty<\/w:t><\/w:r>/)
})

test('docx: text after a whitespace-only run of another format keeps the format of the words, not of the spaces', () => {
  const body = ['<w:p><w:r><w:t xml:space="preserve">  </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Heading</w:t></w:r></w:p>']
  const { model } = load(buildDocx({ body }))
  assert.equal(model.segments[0].text, '  Heading')
  const out = apply(model, new Map([[model.segments[0].id, '  Tiêu đề']])).files.get('word/document.xml')
  assert.match(out, /<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">  Tiêu đề<\/w:t><\/w:r>/)
  assert.doesNotMatch(out, /Heading/)
})

// ---- XLSX ----

test('xlsx: shared strings are read, rich text becomes spans, phonetic text and numbers are skipped', () => {
  const { model } = load(buildXlsx())
  const text = model.segments.map(s => s.text)
  assert.deepEqual(text, ['Total revenue', '⟦1⟧Net⟦/1⟧⟦2⟧ profit margin⟦/2⟧', '  Padded text  ', 'Tokyo'])
})

test('xlsx: edge spaces keep xml:space, rich-text formats stay on their runs, phonetic text is untouched', () => {
  const { model } = load(buildXlsx())
  const rich = byText(model, 'profit margin')
  const padded = byText(model, 'Padded')
  const tokyo = byText(model, 'Tokyo')
  const out = apply(model, new Map([[rich.id, '⟦1⟧Biên ⟦/1⟧⟦2⟧lợi nhuận ròng⟦/2⟧'], [padded.id, '  Văn bản đệm  '], [tokyo.id, 'Tô-ky-ô']])).files.get('xl/sharedStrings.xml')
  assert.match(out, /<r><rPr><b\/><sz val="11"\/><\/rPr><t xml:space="preserve">Biên <\/t><\/r><r><rPr><sz val="11"\/><\/rPr><t xml:space="preserve">lợi nhuận ròng<\/t><\/r>/)
  assert.match(out, /<t xml:space="preserve">  Văn bản đệm  <\/t>/)
  assert.match(out, /<t xml:space="preserve">Tô-ky-ô<\/t><rPh sb="0" eb="2"><t>トウキョウ<\/t><\/rPh>/)
})

test('xlsx: the workbook part with sheet names is never touched', () => {
  const { model } = load(buildXlsx())
  assert.ok(model.parts.every(p => p.name !== 'xl/workbook.xml'))
})

// ---- markers and fonts ----

test('splitMarkers keeps whitespace between spans and rejects anything else outside markers', () => {
  assert.deepEqual(splitMarkers('⟦1⟧A⟦/1⟧ ⟦2⟧B⟦/2⟧', 2), [{ k: 0, text: 'A ' }, { k: 1, text: 'B' }])
  assert.equal(splitMarkers('⟦1⟧A⟦/1⟧ text ⟦2⟧B⟦/2⟧', 2), null)
  assert.equal(splitMarkers('⟦1⟧A⟦/1⟧', 2), null)
  assert.equal(splitMarkers('⟦1⟧A ⟦2⟧B⟦/2⟧⟦/1⟧', 2), null, 'nested markers are not supported')
  assert.deepEqual(splitMarkers('⟦2⟧B⟦/2⟧⟦1⟧A⟦/1⟧', 2).map(p => p.k), [1, 0])
  assert.equal(stripMarkers('⟦1⟧A⟦/1⟧⟦2⟧B⟦/2⟧'), 'AB')
})

test('usedFonts lists families named in runs, themes and spreadsheets', () => {
  const docx = readZip(buildDocx({ extra: [{ name: 'word/styles.xml', data: Buffer.from('<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="MS Mincho"/><w:rFonts w:asciiTheme="minorHAnsi"/>') }] }))
  assert.deepEqual(usedFonts(docx), ['Calibri', 'MS Mincho'])
  const withLang = readZip(buildDocx({ extra: [{ name: 'word/styles.xml', data: Buffer.from('<w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/><w:rFonts w:ascii="Arial"/>') }] }))
  assert.deepEqual(usedFonts(withLang), ['Arial'], 'language tags are not fonts')
  assert.deepEqual(usedFonts(readZip(buildPptx())), ['Calibri'])
})
