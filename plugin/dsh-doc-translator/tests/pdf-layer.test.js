import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { run } from '../proc.js'
import { translateScan } from '../scan.js'
import { buildDocx } from './build.js'

const has = program => spawnSync('sh', ['-c', `command -v ${program}`]).status === 0
const PY = has('python3') && spawnSync('python3', ['-c', 'import PIL']).status === 0
const TOOLS = has('soffice') && has('pdftoppm') && has('pdfinfo') && has('pdftohtml') && PY
const MERGE = TOOLS && has('gs')

const OPTIONS = { spotModel: 'P', readModel: 'R', dpi: 80, maxPages: 5, pageConcurrency: 2, useTextLayer: true, minLayerLetters: 5, target: 'Vietnamese', models: ['T'], concurrency: 2, batchChars: 3000, batchItems: 40, maxTokens: 2000 }

/** A client that records which models were asked; only the translator answers sensibly. */
function fakeLlm() {
  return {
    calls: [],
    async chat(request) {
      this.calls.push(request.model)
      if (request.model === 'T') return { text: JSON.stringify(JSON.parse(request.user).map(r => ({ i: r.i, text: `VI ${r.text}` }))), usage: {} }
      throw new Error(`OCR model ${request.model} should not be asked`)
    },
  }
}

/** A one-page PDF with a real text layer, made by LibreOffice from a Word file. */
async function textPdf(dir, name = 'text') {
  const body = ['<w:p><w:r><w:rPr><w:b/><w:color w:val="CC0000"/><w:sz w:val="40"/></w:rPr><w:t>Annual report</w:t></w:r></w:p>', '<w:p><w:r><w:t>The company grew strongly this year and plans to expand.</w:t></w:r></w:p>', '<w:p><w:r><w:t>12345</w:t></w:r></w:p>']
  writeFileSync(join(dir, `${name}.docx`), buildDocx({ body }))
  await run('soffice', ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', dir, join(dir, `${name}.docx`)], { timeoutMs: 180_000 })
  return join(dir, `${name}.pdf`)
}

test('a PDF with a text layer is translated with no OCR call and in the PDF’s own font family', { skip: !TOOLS, timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'layer-test-'))
  try {
    const llm = fakeLlm()
    const out = await translateScan({ buffer: readFileSync(await textPdf(dir)), extension: 'pdf', llm, options: OPTIONS, langCode: 'vi' })
    assert.deepEqual(llm.calls, ['T'], 'the OCR models are never asked')
    assert.deepEqual(out.routes, { layer: 1, ocr: 0 })
    assert.equal(out.extension, 'pdf')
    assert.equal(out.lines.translated, 2, 'the numbers-only line is left alone')
    assert.equal(out.render.lines, 2)
    assert.ok(out.render.fonts.some(f => /Liberation|Noto|DejaVu/.test(f)), out.render.fonts.join())
    writeFileSync(join(dir, 'out.pdf'), out.buffer)
    assert.match((await run('pdfinfo', [join(dir, 'out.pdf')])).stdout, /Pages:\s+1/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the colour of a line in the PDF is the colour of its translation', { skip: !TOOLS, timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'layer-test-'))
  try {
    const out = await translateScan({ buffer: readFileSync(await textPdf(dir)), extension: 'pdf', llm: fakeLlm(), options: OPTIONS, langCode: 'vi' })
    writeFileSync(join(dir, 'out.pdf'), out.buffer)
    await run('pdftoppm', ['-r', '80', '-png', join(dir, 'out.pdf'), join(dir, 'out')])
    const count = `from PIL import Image\nim = Image.open(${JSON.stringify(join(dir, 'out-1.png'))}).convert("RGB")\nred = sum(1 for r, g, b in im.getdata() if r > 150 and g < 90 and b < 90)\nprint(red)`
    assert.ok(Number(spawnSync('python3', ['-c', count], { encoding: 'utf8' }).stdout) > 100, 'the heading is drawn in the red the PDF names')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('with the text layer switched off every page goes to OCR', { skip: !TOOLS, timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'layer-test-'))
  try {
    const llm = fakeLlm()
    await assert.rejects(translateScan({ buffer: readFileSync(await textPdf(dir)), extension: 'pdf', llm, options: { ...OPTIONS, useTextLayer: false }, langCode: 'vi' }), /OCR model P should not be asked|position model P failed/)
    assert.ok(llm.calls.includes('P'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a page with too few letters in its layer is read with OCR', { skip: !TOOLS, timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'layer-test-'))
  try {
    const llm = fakeLlm()
    await assert.rejects(translateScan({ buffer: readFileSync(await textPdf(dir)), extension: 'pdf', llm, options: { ...OPTIONS, minLayerLetters: 100000 }, langCode: 'vi' }), /position model P failed/)
    assert.ok(llm.calls.includes('P'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('when pdftohtml fails the note says so and the pages are read with OCR', { skip: !TOOLS, timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'layer-test-'))
  try {
    const llm = fakeLlm()
    const failing = (file, args, options) => (file === 'pdftohtml' ? Promise.reject(new Error('pdftohtml is not installed')) : run(file, args, options))
    await assert.rejects(translateScan({ buffer: readFileSync(await textPdf(dir)), extension: 'pdf', llm, options: OPTIONS, langCode: 'vi', run: failing }), /position model P failed/)
    assert.ok(llm.calls.includes('P'), 'the page fell back to OCR')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a PDF with one text page and one image page uses the text layer for the first and OCR for the second', { skip: !MERGE, timeout: 400_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'layer-test-'))
  try {
    const text = await textPdf(dir)
    const make = `from PIL import Image, ImageDraw\nim = Image.new("RGB", (680, 880), (255, 255, 255))\nImageDraw.Draw(im).rectangle((80, 100, 400, 130), fill=(10, 10, 10))\nim.save(${JSON.stringify(join(dir, 'image.pdf'))}, "PDF", resolution=80)`
    assert.equal(spawnSync('python3', ['-c', make]).status, 0)
    await run('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', `-sOutputFile=${join(dir, 'mixed.pdf')}`, text, join(dir, 'image.pdf')])
    const loc = (...n) => n.map(v => `<|LOC_${v}|>`).join('')
    const llm = {
      calls: [],
      async chat(request) {
        this.calls.push(request.model)
        if (request.model === 'P') return { text: `Hello from the scan${loc(100, 100, 600, 100, 600, 140, 100, 140)}`, usage: {} }
        if (request.model === 'R') return { text: 'Hello from the scan', usage: {} }
        return { text: JSON.stringify(JSON.parse(request.user).map(r => ({ i: r.i, text: `VI ${r.text}` }))), usage: {} }
      },
    }
    const out = await translateScan({ buffer: readFileSync(join(dir, 'mixed.pdf')), extension: 'pdf', llm, options: OPTIONS, langCode: 'vi' })
    assert.deepEqual(out.routes, { layer: 1, ocr: 1 })
    assert.equal(llm.calls.filter(c => c === 'P').length, 1, 'only the image page is spotted')
    assert.equal(llm.calls.filter(c => c === 'R').length, 1)
    assert.equal(out.pages, 2)
    assert.equal(out.lines.translated, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- the renderer on its own ----

const render = (dir, items, language = 'vi', obstacles = []) => {
  const image = join(dir, 'in.png')
  spawnSync('python3', ['-c', `from PIL import Image\nImage.new("RGB", (800, 400), (255, 255, 255)).save(${JSON.stringify(image)})`])
  const spec = { dpi: 100, language, pdf: null, pages: [{ image, obstacles, output: join(dir, 'out.png'), items }] }
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec))
  const result = spawnSync('python3', [join(import.meta.dirname, '..', 'scripts', 'render_overlay.py'), join(dir, 'spec.json')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
const QUAD = [100, 100, 600, 100, 600, 160, 100, 160]

test('the font family of the PDF picks the installed equivalent for Latin text and is ignored for other scripts', { skip: !PY || !has('fc-match') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-test-'))
  try {
    const serif = render(dir, [{ quad: QUAD, text: 'Báo cáo thường niên', exact: true, family: 'Times New Roman', size: 0.04, color: '#000000', bold: false, italic: false }])
    assert.ok(serif.fonts.some(f => /Serif|Times/i.test(f)), serif.fonts.join())
    const bold = render(dir, [{ quad: QUAD, text: 'Báo cáo thường niên', exact: true, family: 'Times New Roman', size: 0.04, color: '#000000', bold: true, italic: false }])
    assert.ok(bold.fonts.some(f => /Bold/i.test(f)), bold.fonts.join())
    const japanese = render(dir, [{ quad: QUAD, text: '年次報告書', exact: true, family: 'Times New Roman', size: 0.04, color: '#000000', bold: false, italic: false }], 'ja')
    assert.ok(japanese.fonts.every(f => !/LiberationSerif/.test(f)), `a Latin-only font cannot draw Japanese: ${japanese.fonts.join()}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the size named in the PDF is the largest size used, and a longer translation shrinks to fit', { skip: !PY }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-test-'))
  try {
    const roomy = render(dir, [{ quad: QUAD, text: 'Hi', exact: true, family: 'Arial', size: 0.03, color: '#000000' }])
    assert.equal(roomy.shrunk, 0)
    const tight = render(dir, [{ quad: [100, 100, 160, 100, 160, 160, 100, 160], text: 'A very long translated sentence that cannot fit', exact: true, family: 'Arial', size: 0.03, color: '#000000' }])
    assert.equal(tight.shrunk + tight.overflow > 0, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an exact line grows into the free room on its row, but stops short of the next line', { skip: !PY }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-test-'))
  try {
    const SELF = [100, 100, 200, 100, 200, 160, 100, 160]
    const item = [{ quad: SELF, text: 'Họ và tên đầy đủ', exact: true, family: 'Arial', size: 0.03, color: '#000000' }]
    const free = render(dir, item, 'vi', [SELF, [900, 100, 990, 100, 990, 160, 900, 160]])
    const blocked = render(dir, item, 'vi', [SELF, [230, 100, 330, 100, 330, 160, 230, 160]])
    const alone = render(dir, item, 'vi', [])
    assert.ok(free.sizes[0] > blocked.sizes[0], `free ${free.sizes[0]} should exceed blocked ${blocked.sizes[0]}`)
    assert.ok(free.sizes[0] > alone.sizes[0], 'without row information the line only has its own width')
    // In the blocked case no ink reaches the neighbour at x = 184 px.
    const check = `from PIL import Image\nim = Image.open(${JSON.stringify(join(dir, 'out.png'))}).convert("L")\nprint(sum(1 for x in range(178, 800) for y in range(40, 64) if im.getpixel((x, y)) < 128))`
    render(dir, item, 'vi', [SELF, [230, 100, 330, 100, 330, 160, 230, 160]])
    assert.equal(spawnSync('python3', ['-c', check], { encoding: 'utf8' }).stdout.trim(), '0')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a centred line does not grow sideways, and growth is capped', { skip: !PY }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-test-'))
  try {
    const CENTRE = [450, 100, 550, 100, 550, 160, 450, 160]
    const centred = render(dir, [{ quad: CENTRE, text: 'Tiêu đề rất dài ở giữa trang', exact: true, family: 'Arial', size: 0.03, color: '#000000' }], 'vi', [CENTRE])
    const wide = render(dir, [{ quad: [100, 100, 200, 100, 200, 160, 100, 160], text: 'x'.repeat(80), exact: true, family: 'Arial', size: 0.03, color: '#000000' }], 'vi', [[100, 100, 200, 100, 200, 160, 100, 160]])
    assert.ok(centred.sizes[0] <= wide.sizes[0] + 40)
    assert.ok(wide.overflow + wide.shrunk > 0, 'eighty letters do not fit even 2.5 times the width, so the line shrinks')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the colour comes from the PDF, not from the ink on the page: on a blank page it is still drawn', { skip: !PY }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-test-'))
  try {
    const item = { quad: QUAD, text: 'Tiêu đề', exact: true, family: 'Arial', size: 0.04, bold: true }
    render(dir, [{ ...item, color: '#00aa00' }])
    const count = (rule) => `from PIL import Image\nim = Image.open(${JSON.stringify(join(dir, 'out.png'))}).convert("RGB")\nprint(sum(1 for r, g, b in im.getdata() if ${rule}))`
    const green = Number(spawnSync('python3', ['-c', count('g > 120 and r < 80 and b < 80')], { encoding: 'utf8' }).stdout)
    assert.ok(green > 50, `green pixels: ${green}`)
    render(dir, [item])
    const black = Number(spawnSync('python3', ['-c', count('r < 60 and g < 60 and b < 60')], { encoding: 'utf8' }).stdout)
    assert.ok(black > 50, 'without a colour the page default (black on a blank page) is used')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
