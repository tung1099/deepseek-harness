import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { legacyHint, resolveFormat, translateOffice } from '../office.js'
import { verifyLayout } from '../verify.js'
import { run } from '../proc.js'
import { readZip } from '../zip.js'
import { buildDocx, buildPptx, buildXlsx } from './build.js'

const OPTIONS = { target: 'Vietnamese', models: ['A'], concurrency: 2, batchChars: 2000, batchItems: 30, maxTokens: 2000, maxArchiveBytes: 50_000_000, expansionWarn: 1.5 }

/** A translator that applies `fn` to the text between markers, keeping markers. */
function llmWith(fn) {
  return { async chat({ user }) { return { text: JSON.stringify(JSON.parse(user).map(r => ({ i: r.i, text: r.text.split(/(⟦\/?\d+⟧)/).map(p => (/^⟦/.test(p) ? p : fn(p))).join('') }))), usage: { total_tokens: 5 } } } }
}
const upper = s => s.toUpperCase()
const partText = (buffer, name) => readZip(buffer).find(e => e.name === name).data.toString('utf8')

test('a docx is translated end to end and every other part is carried over byte for byte', async () => {
  const input = buildDocx({ header: '<w:p><w:r><w:t>Page header</w:t></w:r></w:p>' })
  const out = await translateOffice({ buffer: input, extension: 'docx', llm: llmWith(upper), options: OPTIONS })
  assert.equal(out.format, 'docx')
  assert.equal(out.segments.failed, 0)
  assert.equal(out.segments.translated, out.segments.total)
  const doc = partText(out.buffer, 'word/document.xml')
  assert.match(doc, />ANNUAL REPORT</)
  assert.match(doc, /<w:b\/><\/w:rPr><w:t xml:space="preserve">VERY IMPORTANT</)
  assert.match(partText(out.buffer, 'word/header1.xml'), />PAGE HEADER</)
  const before = readZip(input)
  const after = readZip(out.buffer)
  assert.deepEqual(after.map(e => e.name), before.map(e => e.name))
  for (const entry of before.filter(e => !/^word\/(document|header1)\.xml$/.test(e.name))) {
    assert.deepEqual(after.find(e => e.name === entry.name).data, entry.data, entry.name)
  }
})

test('pptx and xlsx are translated the same way', async () => {
  const pptx = await translateOffice({ buffer: buildPptx(), extension: 'pptx', llm: llmWith(upper), options: OPTIONS })
  assert.match(partText(pptx.buffer, 'ppt/slides/slide1.xml'), /<a:t>QUARTERLY RESULTS<\/a:t>/)
  const xlsx = await translateOffice({ buffer: buildXlsx(), extension: 'xlsx', llm: llmWith(upper), options: OPTIONS })
  assert.match(partText(xlsx.buffer, 'xl/sharedStrings.xml'), /<t xml:space="preserve">TOTAL REVENUE<\/t>/)
  assert.match(partText(xlsx.buffer, 'xl/workbook.xml'), /name="Summary"/)
})

test('failed segments keep their source text and are reported', async () => {
  const llm = { chat: async () => { throw Object.assign(new Error('down'), { name: 'LlmError' }) } }
  const bad = { async chat() { const { LlmError } = await import('../llm.js'); throw new LlmError('down') } }
  const out = await translateOffice({ buffer: buildDocx(), extension: 'docx', llm: bad, options: OPTIONS })
  assert.equal(out.segments.translated, 0)
  assert.equal(out.segments.failed, out.segments.total)
  assert.match(partText(out.buffer, 'word/document.xml'), />Annual report</)
  void llm
})

test('format simplification and text growth are counted in the report', async () => {
  const llm = { async chat({ user }) { return { text: JSON.stringify(JSON.parse(user).map(r => ({ i: r.i, text: r.text.replace(/⟦\/?\d+⟧/g, '') + ' (dài hơn rất nhiều)' }))), usage: {} } } }
  const out = await translateOffice({ buffer: buildDocx(), extension: 'docx', llm, options: OPTIONS })
  assert.ok(out.warnings.format_simplified >= 2)
  assert.ok(out.expansion.average > 1)
})

test('wrong extension, legacy binary formats and files with no text are explained', async () => {
  assert.throws(() => resolveFormat('xlsx', readZip(buildDocx())), /does not match the content, which is a docx/)
  assert.throws(() => resolveFormat('docx', [{ name: 'a.txt' }]), /does not look like/)
  assert.match(legacyHint('doc'), /convert it to \.docx/)
  assert.equal(legacyHint('docx'), null)
  await assert.rejects(translateOffice({ buffer: buildDocx({ body: ['<w:p><w:r><w:t>123</w:t></w:r></w:p>'] }), extension: 'docx', llm: llmWith(upper), options: OPTIONS }), /no translatable text/)
})

test('verifyLayout compares page counts and reports a missing program instead of failing', async () => {
  const pages = { 'original.docx': 2, 'translated.docx': 3 }
  const fake = async (file, args) => {
    if (file === 'soffice') return { stdout: '', stderr: '' }
    const name = args[0].match(/(original|translated)\.pdf$/)[1] + '.docx'
    return { stdout: `Pages:           ${pages[name]}\n`, stderr: '' }
  }
  const out = await verifyLayout({ original: Buffer.from('a'), translated: Buffer.from('b'), extension: 'docx', run: fake })
  assert.deepEqual(out, { checked: true, originalPages: 2, translatedPages: 3, samePages: false })
  const missing = await verifyLayout({ original: Buffer.from('a'), translated: Buffer.from('b'), extension: 'docx', run: async () => { throw new Error('soffice is not installed') } })
  assert.deepEqual(missing, { checked: false, reason: 'soffice is not installed' })
})

// ---- Checks against real LibreOffice, skipped when it or the PDF tools are missing ----

const has = program => spawnSync('sh', ['-c', `command -v ${program}`]).status === 0
const REAL = has('soffice') && has('pdftoppm') && has('pdfinfo') && has('pdftotext')

/** Render a package with LibreOffice and return its page images and text. */
async function render(dir, name, buffer) {
  const file = join(dir, name)
  writeFileSync(file, buffer)
  await run('soffice', ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', join(dir, 'pdf'), file], { timeoutMs: 180_000 })
  const pdf = join(dir, 'pdf', name.replace(/\.[^.]+$/, '.pdf'))
  const prefix = join(dir, name.replace(/\.[^.]+$/, ''))
  await run('pdftoppm', ['-r', '60', '-png', pdf, prefix])
  const text = (await run('pdftotext', ['-layout', pdf, '-'])).stdout
  const pages = Number(/Pages:\s+(\d+)/.exec((await run('pdfinfo', [pdf])).stdout)[1])
  return { text, pages, png: (n) => readFileSync(`${prefix}-${String(n).padStart(pages > 9 ? 2 : 1, '0')}.png`) }
}

for (const [format, build] of [['docx', buildDocx], ['pptx', buildPptx], ['xlsx', buildXlsx]]) {
  test(`real LibreOffice: a ${format} translated with identical text renders pixel for pixel like the original`, { skip: !REAL, timeout: 400_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dt-real-'))
    try {
      const original = build()
      const same = await translateOffice({ buffer: original, extension: format, llm: llmWith(s => s), options: OPTIONS })
      const a = await render(dir, `a.${format}`, original)
      const b = await render(dir, `b.${format}`, same.buffer)
      assert.equal(b.pages, a.pages)
      assert.equal(b.text, a.text)
      for (let n = 1; n <= a.pages; n++) assert.ok(a.png(n).equals(b.png(n)), `page ${n} differs`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test(`real LibreOffice: a translated ${format} opens and shows the translated words`, { skip: !REAL, timeout: 400_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dt-real-'))
    try {
      const out = await translateOffice({ buffer: build(), extension: format, llm: llmWith(upper), options: OPTIONS })
      const rendered = await render(dir, `t.${format}`, out.buffer)
      const expected = { docx: 'ANNUAL REPORT', pptx: 'QUARTERLY RESULTS', xlsx: 'TOTAL REVENUE' }[format]
      assert.match(rendered.text, new RegExp(expected))
      assert.doesNotMatch(rendered.text, /⟦/)
      const check = await verifyLayout({ original: build(), translated: out.buffer, extension: format })
      assert.equal(check.checked, true)
      assert.equal(check.samePages, true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
