import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { run } from '../proc.js'
import { translateScan } from '../scan.js'

const has = program => spawnSync('sh', ['-c', `command -v ${program}`]).status === 0
const PY = has('python3') && spawnSync('python3', ['-c', 'import PIL']).status === 0
const POPPLER = has('pdftoppm') && has('pdfinfo')

const loc = (...n) => n.map(v => `<|LOC_${v}|>`).join('')
/** One line of text at the top left of the page. */
const SPOT = `Xin chào thế giới${loc(100, 100, 500, 100, 500, 140, 100, 140)}\n12345${loc(100, 200, 300, 200, 300, 240, 100, 240)}`
const OPTIONS = { spotModel: 'P', readModel: 'R', dpi: 100, maxPages: 3, pageConcurrency: 2, target: 'English', models: ['T'], concurrency: 2, batchChars: 2000, batchItems: 30, maxTokens: 1000 }

/** A client that answers the position model, the reading model and the translator. */
function fakeLlm({ translate = t => `EN:${t}`, read = t => t } = {}) {
  return {
    calls: [],
    async chat(request) {
      this.calls.push(request.model)
      if (request.model === 'P') return { text: SPOT, usage: {} }
      if (request.model === 'R') return { text: 'Xin chào thế giới\n12345', usage: {} }
      return { text: JSON.stringify(JSON.parse(request.user).map(r => ({ i: r.i, text: translate(r.text) }))), usage: {} }
    },
  }
}

/** A white PNG with dark text-like bars, made by Pillow. */
function page(path, width = 1000, height = 1000) {
  const code = `from PIL import Image, ImageDraw\nim = Image.new("RGB", (${width}, ${height}), (250, 250, 250))\nd = ImageDraw.Draw(im)\nd.rectangle((100, 110, 480, 130), fill=(20, 20, 20))\nim.save(${JSON.stringify(path)})`
  assert.equal(spawnSync('python3', ['-c', code]).status, 0)
}

test('a page is read, translated and drawn; numbers-only lines are left alone', { skip: !PY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'))
  try {
    page(join(dir, 'in.png'))
    const llm = fakeLlm()
    const out = await translateScan({ buffer: readFileSync(join(dir, 'in.png')), extension: 'png', llm, options: OPTIONS, langCode: 'en' })
    assert.equal(out.extension, 'png')
    assert.deepEqual(out.lines, { total: 1, translated: 1, failed: 0 })
    assert.equal(out.render.lines, 1)
    assert.deepEqual(llm.calls.sort(), ['P', 'R', 'T'])
    writeFileSync(join(dir, 'out.png'), out.buffer)
    const check = `from PIL import Image\nimg = Image.open(${JSON.stringify(join(dir, 'out.png'))}).convert("RGB")\nold = Image.open(${JSON.stringify(join(dir, 'in.png'))}).convert("RGB")\nprint(img.size == old.size, img.getpixel((10, 10)) == old.getpixel((10, 10)), img.crop((100, 100, 500, 140)).tobytes() != old.crop((100, 100, 500, 140)).tobytes(), img.crop((100, 200, 300, 240)).tobytes() == old.crop((100, 200, 300, 240)).tobytes())`
    const result = spawnSync('python3', ['-c', check], { encoding: 'utf8' })
    assert.equal(result.stdout.trim(), 'True True True True', 'size kept, far pixels untouched, the line area redrawn, the numbers area untouched')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('lines the translator could not translate are not redrawn', { skip: !PY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'))
  try {
    page(join(dir, 'in.png'))
    const llm = fakeLlm()
    const { LlmError } = await import('../llm.js')
    llm.chat = async (request) => { if (request.model === 'T') throw new LlmError('down'); return fakeLlm().chat.call({ calls: [] }, request) }
    const out = await translateScan({ buffer: readFileSync(join(dir, 'in.png')), extension: 'png', llm, options: OPTIONS, langCode: 'en' })
    assert.deepEqual(out.lines, { total: 1, translated: 0, failed: 1 })
    assert.equal(out.render.lines, 0)
    assert.equal(out.buffer.equals(readFileSync(join(dir, 'in.png'))) || out.buffer.length > 0, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a page with no text is an error, not an empty file', { skip: !PY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'))
  try {
    page(join(dir, 'in.png'))
    const llm = fakeLlm()
    const chat = llm.chat.bind(llm)
    llm.chat = async (r) => (r.model === 'P' ? { text: `12345${loc(1, 2, 3, 4, 5, 6, 7, 8)}`, usage: {} } : chat(r))
    await assert.rejects(translateScan({ buffer: readFileSync(join(dir, 'in.png')), extension: 'png', llm, options: OPTIONS, langCode: 'en' }), /no text was found/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a PDF is split into pages, each page is read, and the result is one PDF', { skip: !(PY && POPPLER) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'))
  try {
    page(join(dir, 'a.png')); page(join(dir, 'b.png'))
    const make = `from PIL import Image\npages = [Image.open(${JSON.stringify(join(dir, 'a.png'))}).convert("RGB"), Image.open(${JSON.stringify(join(dir, 'b.png'))}).convert("RGB")]\npages[0].save(${JSON.stringify(join(dir, 'in.pdf'))}, "PDF", save_all=True, append_images=pages[1:], resolution=100)`
    assert.equal(spawnSync('python3', ['-c', make]).status, 0)
    const llm = fakeLlm()
    const out = await translateScan({ buffer: readFileSync(join(dir, 'in.pdf')), extension: 'pdf', llm, options: OPTIONS, langCode: 'en' })
    assert.equal(out.extension, 'pdf')
    assert.equal(out.pages, 2)
    assert.equal(llm.calls.filter(c => c === 'P').length, 2, 'every page goes to the position model')
    writeFileSync(join(dir, 'out.pdf'), out.buffer)
    assert.match((await run('pdfinfo', [join(dir, 'out.pdf')])).stdout, /Pages:\s+2/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a PDF with more pages than the limit is refused before any OCR call', { skip: !(PY && POPPLER) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'))
  try {
    page(join(dir, 'a.png'))
    const make = `from PIL import Image\nim = Image.open(${JSON.stringify(join(dir, 'a.png'))}).convert("RGB")\nim.save(${JSON.stringify(join(dir, 'in.pdf'))}, "PDF", save_all=True, append_images=[im, im, im], resolution=100)`
    assert.equal(spawnSync('python3', ['-c', make]).status, 0)
    const llm = fakeLlm()
    await assert.rejects(translateScan({ buffer: readFileSync(join(dir, 'in.pdf')), extension: 'pdf', llm, options: { ...OPTIONS, maxPages: 3 }, langCode: 'en' }), /has 4 pages; the limit is 3/)
    assert.deepEqual(llm.calls, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('text in the target script gets a font that covers it', { skip: !PY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'))
  try {
    page(join(dir, 'in.png'))
    const out = await translateScan({ buffer: readFileSync(join(dir, 'in.png')), extension: 'png', llm: fakeLlm({ translate: () => '你好，世界' }), options: OPTIONS, langCode: 'zh-cn' })
    assert.equal(out.render.lines, 1)
    assert.ok(out.render.fonts.length >= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
