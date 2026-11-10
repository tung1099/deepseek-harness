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

const render = (dir, items, language = 'vi', obstacles = [], draw = '') => {
  const image = join(dir, 'in.png')
  spawnSync('python3', ['-c', `from PIL import Image, ImageDraw\nim = Image.new("RGB", (800, 400), (255, 255, 255))\nd = ImageDraw.Draw(im)\n${draw}\nim.save(${JSON.stringify(image)})`])
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

// ---- paragraphs of a text layer ----

import { groupParagraphs, parsePdfXml } from '../layer.js'

/** A `pdftohtml -xml` page from `[top, left, width, height, font, text]` items. */
function xmlPage(items, fonts = ['<fontspec id="0" size="25" family="AAAAAA+FSMagistralBook" color="#000000"/>', '<fontspec id="1" size="27" family="BAAAAA+FSMagistralBold" color="#000000"/>', '<fontspec id="2" size="13" family="CAAAAA+NotoSansCJKsc" color="#000000"/>']) {
  const texts = items.map(([top, left, width, height, font, text]) => `<text top="${top}" left="${left}" width="${width}" height="${height}" font="${font}">${text}</text>`)
  return `<pdf2xml><page number="1" position="absolute" top="0" left="0" height="1000" width="2000">${fonts.join('')}${texts.join('')}</page></pdf2xml>`
}

test('pieces of one line are joined, including a small glyph set lower than the text', () => {
  const [page] = parsePdfXml(xmlPage([
    [199, 439, 801, 33, 0, 'hằng ngày, đi từ tình huống '],
    [214, 1241, 28, 17, 2, '→'],
    [199, 1269, 227, 33, 0, ' đưa ra quyết định'],
  ]))
  const [paragraph] = groupParagraphs(page)
  assert.equal(paragraph.text, 'hằng ngày, đi từ tình huống → đưa ra quyết định')
  assert.equal(paragraph.family, 'FSMagistral Book')
  assert.equal(paragraph.quads.length, 1)
})

test('lines of one card form a centred paragraph; a title in another font and a far column stay apart', () => {
  const [page] = parsePdfXml(xmlPage([
    [558, 167, 253, 34, 1, '<b>Đổi cách định nghĩa</b>'],
    [599, 242, 103, 34, 1, '<b>nhu cầu</b>'],
    [671, 165, 252, 29, 0, 'Từ task category sang'],
    [706, 170, 243, 29, 0, 'life problem; capability'],
    [741, 154, 275, 29, 0, 'hiện có trở thành lớp nền'],
    [775, 223, 136, 29, 0, 'dùng chung.'],
    [671, 575, 228, 29, 0, 'Cột bên cạnh'],
  ]))
  const paragraphs = groupParagraphs(page)
  assert.deepEqual(paragraphs.map(p => [p.text, p.align, p.sources.length]), [
    ['Đổi cách định nghĩa nhu cầu', 'center', 2],
    ['Từ task category sang life problem; capability hiện có trở thành lớp nền dùng chung.', 'center', 4],
    ['Cột bên cạnh', 'left', 1],
  ])
  assert.ok(Math.abs(paragraphs[1].lineHeight - 0.0347) < 0.001, 'line height is the step between line tops')
})

test('a bullet, or a short left-aligned line that ends a sentence, starts a new paragraph; a hyphenated word is joined', () => {
  const [page] = parsePdfXml(xmlPage([
    [100, 100, 600, 29, 0, 'Một đoạn văn dài được ngắt xuống dòng và tiếp'],
    [135, 100, 300, 29, 0, 'tục ở đây. Hết.'],
    [170, 100, 600, 29, 0, 'Đoạn mới bắt đầu ở dòng này, viết liền mạch, được ngắt-'],
    [205, 100, 300, 29, 0, 'dòng ở giữa từ'],
    [240, 100, 500, 29, 0, '• Một gạch đầu dòng'],
  ]))
  assert.deepEqual(groupParagraphs(page).map(p => p.text), [
    'Một đoạn văn dài được ngắt xuống dòng và tiếp tục ở đây. Hết.',
    'Đoạn mới bắt đầu ở dòng này, viết liền mạch, được ngắtdòng ở giữa từ',
    '• Một gạch đầu dòng',
  ])
})

/** Bounds of the dark ink on the rendered page, as fractions of its size. */
function inkBounds(dir) {
  const code = `from PIL import Image\nimg = Image.open(${JSON.stringify(join(dir, 'out.png'))}).convert("RGB")\nw, h = img.size\nink = [(x, y) for y in range(h) for x in range(w) if sum(img.getpixel((x, y))) < 300]\nprint(min(p[0] for p in ink) / w, max(p[0] for p in ink) / w, min(p[1] for p in ink) / h, max(p[1] for p in ink) / h)`
  return spawnSync('python3', ['-c', code], { encoding: 'utf8' }).stdout.trim().split(' ').map(Number)
}
const PARAGRAPH = {
  block: true, exact: true, align: 'center', lineHeight: 0.08, family: 'FS Magistral', size: 0.022, color: '#000000', bold: false, italic: false,
  quads: [[200, 100, 450, 100, 450, 160, 200, 160], [220, 180, 430, 180, 430, 240, 220, 240]],
  sources: ['Từ task category sang', 'life problem; capability'],
  quad: [200, 100, 450, 100, 450, 240, 200, 240],
  text: 'From task categories to life problems; existing capabilities become a shared foundation layer for everyone → done',
}

test('inside a frame, a paragraph is wrapped in one size and its ink stays inside the frame', { skip: !PY || !has('fc-match') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-test-'))
  try {
    // A light grey card with a 2-pixel border just around the paragraph.
    const frame = 'd.rectangle((150, 30, 370, 260), fill=(235, 235, 235), outline=(120, 120, 120), width=2)'
    const report = render(dir, [PARAGRAPH], 'en', [], frame)
    assert.equal(report.lines, 1)
    assert.equal(new Set(report.sizes).size, 1)
    const [x1, x2, y1, y2] = inkBounds(dir)
    assert.ok(x1 > 150 / 800 && x2 < 370 / 800 && y1 > 30 / 400 && y2 < 260 / 400, `ink ${[x1, x2, y1, y2]} stays inside the card`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('on open background a paragraph grows only a little sideways, keeps one size, and stays above the text below it', { skip: !PY || !has('fc-match') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-test-'))
  try {
    const report = render(dir, [PARAGRAPH], 'en', [[200, 700, 260, 700, 260, 800, 200, 800]])
    assert.equal(report.overflow, 0)
    const [x1, x2, , y2] = inkBounds(dir)
    assert.ok(x1 > 0.2 - 0.25 * 0.15 - 0.01 && x2 < 0.45 + 0.25 * 0.15 + 0.01, `a paragraph grows at most 15% of its width on each side: ${[x1, x2]}`)
    assert.ok(y2 < 0.7, `the ink ends above the obstacle: ${y2}`)
    assert.equal(new Set(report.sizes).size, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('line breaking never cuts a word unless asked to', { skip: !PY }, () => {
  const code = `import sys\nsys.path.insert(0, ${JSON.stringify(join(import.meta.dirname, '..', 'scripts'))})\nfrom render_overlay import wrap\nclass F:\n    def getlength(self, t): return 10 * len(t)\nprint(wrap("Selective screening", F(), 60))\nprint(wrap("Selective screening", F(), 60, True))\nprint(wrap("你好世界你好", F(), 30))`
  const out = spawnSync('python3', ['-c', code], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(out.stdout.trim().split('\n'), ["['Selective', 'screening']", "['Select', 'ive', 'screen', 'ing']", "['你好世', '界你好']"])
})

test('one-line labels in a column ending at one edge are right-aligned', () => {
  const [page] = parsePdfXml(xmlPage([
    [490, 732, 146, 38, 0, 'Mua sắm'],
    [572, 735, 143, 38, 0, 'Công việc'],
    [642, 703, 175, 38, 0, 'Tài chính số'],
    [736, 583, 295, 38, 0, 'Tương tác và liên lạc'],
    [490, 1000, 400, 38, 0, 'Hôm nay tôi cần xử lý chuyện gì?'],
    [572, 1000, 600, 38, 0, 'Tình huống nào đang làm tôi mất thời gian?'],
  ]))
  const align = Object.fromEntries(groupParagraphs(page).map(p => [p.text, p.align]))
  assert.deepEqual(align, {
    'Mua sắm': 'right', 'Công việc': 'right', 'Tài chính số': 'right', 'Tương tác và liên lạc': 'right',
    'Hôm nay tôi cần xử lý chuyện gì?': 'left', 'Tình huống nào đang làm tôi mất thời gian?': 'left',
  })
})

test('paragraphs of one style get one size, apart from one that needs far less room', { skip: !PY || !has('fc-match') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-test-'))
  try {
    const label = (top, text, source) => ({
      block: true, exact: true, align: 'right', lineHeight: 0.08, family: 'FS Magistral', size: 0.022, color: '#333333', bold: false, italic: false,
      quads: [[300, top, 450, top, 450, top + 50, 300, top + 50]], sources: [source], quad: [300, top, 450, top, 450, top + 50, 300, top + 50], text,
    })
    // A frame tight around the column leaves the labels no room to grow, so their own sizes differ.
    const items = [label(100, 'Shop', 'Mua sắm'), label(250, 'Work', 'Công việc'), label(400, 'Digital money', 'Tài chính số'), label(550, 'Info', 'Thông tin')]
    const report = render(dir, items, 'en', [], 'd.rectangle((230, 30, 370, 270), outline=(0, 0, 0), width=2)')
    const sizes = report.sizes
    assert.equal(new Set([sizes[0], sizes[1], sizes[3]]).size, 1, `short labels share one size: ${sizes}`)
    assert.ok(sizes[2] <= sizes[0])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
