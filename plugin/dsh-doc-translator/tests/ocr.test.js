import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alignLines, approximateSubstring, ocrPage, parseSpotting, plain, readingLines, similarity } from '../ocr.js'

const loc = (...n) => n.map(v => `<|LOC_${v}|>`).join('')
const SPOT = `CỘNG HÒA XÃ HỘI${loc(221, 49, 779, 49, 779, 73, 221, 73)}\nHỢP ĐỒNG DỊCH VỤ${loc(174, 126, 826, 126, 826, 155, 174, 155)}\nBên A: Phân mềm${loc(62, 215, 844, 215, 844, 233, 62, 233)}`

test('spotting output gives each line its text and four corners', () => {
  const lines = parseSpotting(SPOT)
  assert.deepEqual(lines.map(l => l.text), ['CỘNG HÒA XÃ HỘI', 'HỢP ĐỒNG DỊCH VỤ', 'Bên A: Phân mềm'])
  assert.deepEqual(lines[1].quad, [174, 126, 826, 126, 826, 155, 174, 155])
  assert.deepEqual(parseSpotting('text without positions\n<|LOC_1|><|LOC_2|>'), [])
})

test('plain removes accents and case; similarity is 1 for equal and ignores nothing else', () => {
  assert.equal(plain('Hợp ĐỒNG  Việt'), 'hop dong viet')
  assert.equal(similarity('abc', 'abc'), 1)
  assert.equal(similarity('hop dong', 'hop dong dich vu') > 0.6, true)
  assert.equal(similarity('xyz', 'abc'), 0)
})

test('reading lines come one per line and one per tab-separated cell', () => {
  assert.deepEqual(readingLines('A\n\nB\tC\n  D  '), ['A', 'B', 'C', 'D'])
})

test('approximateSubstring finds the closest stretch and refuses a distant one', () => {
  assert.deepEqual(approximateSubstring('xx hello world yy', 'hello world', 0.2), { start: 3, end: 14, distance: 0 })
  const near = approximateSubstring('xx helo world yy', 'hello world', 0.2)
  assert.equal(near.distance, 1)
  assert.equal('xx helo world yy'.slice(near.start, near.end).trim(), 'helo world')
  assert.equal(approximateSubstring('completely different', 'hello world', 0.2), null)
  assert.equal(approximateSubstring('abc', '', 0.2), null)
})

test('a spotted line takes the text of the reading model, ignoring accents when matching', () => {
  const spotted = parseSpotting(SPOT)
  const reading = 'CỘNG HÒA XÃ HỘI\nHỢP ĐỒNG DỊCH VỤ\nBên A: Phần mềm'
  const { lines, replaced } = alignLines(spotted, reading)
  assert.deepEqual(lines.map(l => l.text), ['CỘNG HÒA XÃ HỘI', 'HỢP ĐỒNG DỊCH VỤ', 'Bên A: Phần mềm'])
  assert.deepEqual(lines.map(l => l.source), ['reading', 'reading', 'reading'])
  assert.equal(replaced, 1)
  assert.deepEqual(lines[2].quad, spotted[2].quad, 'the box stays the one the position model gave')
})

test('cells the reading model joined into one row are still found inside the whole text', () => {
  const spotted = [{ text: 'Hạng mục', quad: [1, 2, 3, 4, 5, 6, 7, 8] }, { text: 'Sô lượng', quad: [1, 2, 3, 4, 5, 6, 7, 8] }, { text: 'Thanh tien', quad: [1, 2, 3, 4, 5, 6, 7, 8] }]
  const { lines } = alignLines(spotted, 'Header\nHạng mục Số lượng Thành tiền\nFooter')
  assert.deepEqual(lines.map(l => l.text), ['Hạng mục', 'Số lượng', 'Thành tiền'])
  assert.ok(lines.every(l => l.source === 'reading'))
})

test('repeated lines each take one occurrence and a line with no counterpart keeps its own text', () => {
  const quad = [1, 2, 3, 4, 5, 6, 7, 8]
  const { lines } = alignLines([{ text: 'Yes', quad }, { text: 'Yes', quad }, { text: 'Unrelated words here', quad }], 'Yes\nYes\nNothing alike')
  assert.deepEqual(lines.map(l => l.source), ['reading', 'reading', 'spotting'])
  assert.equal(lines[2].text, 'Unrelated words here')
})

// ---- ocrPage with a fake client ----

let dir
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })
function image() {
  dir = mkdtempSync(join(tmpdir(), 'ocr-test-'))
  const path = join(dir, 'page-1.png')
  writeFileSync(path, Buffer.from('89504e470d0a1a0a', 'hex'))
  return path
}
const fakeLlm = (handlers) => ({
  calls: [],
  async chat(request) {
    this.calls.push(request)
    const text = request.user.at(-1).text
    return handlers[request.model](text, this.calls.filter(c => c.model === request.model).length)
  },
})

test('the position and reading models run on the same page image at once, and the image goes as a data URL', async () => {
  const llm = fakeLlm({ P: () => ({ text: SPOT }), R: () => ({ text: 'CỘNG HÒA XÃ HỘI\nHỢP ĐỒNG DỊCH VỤ\nBên A: Phần mềm' }) })
  const out = await ocrPage(llm, { imagePath: image(), spotModel: 'P', readModel: 'R' })
  assert.deepEqual(llm.calls.map(c => [c.model, c.user.at(-1).text]).sort(), [['P', 'Spotting:'], ['R', llm.calls.find(c => c.model === 'R').user.at(-1).text]])
  assert.match(llm.calls[0].user[0].image_url.url, /^data:image\/png;base64,/)
  assert.deepEqual(out.lines.map(l => l.text), ['CỘNG HÒA XÃ HỘI', 'HỢP ĐỒNG DỊCH VỤ', 'Bên A: Phần mềm'])
  assert.match(out.notes[0], /1 line\(s\) took the text of R/)
})

test('a position model that returns no positions is asked once more, then reported', async () => {
  let n = 0
  const llm = fakeLlm({ P: () => ({ text: n++ === 0 ? 'just text' : SPOT }), R: () => ({ text: 'x' }) })
  assert.equal((await ocrPage(llm, { imagePath: image(), spotModel: 'P', readModel: 'R' })).lines.length, 3)
  const never = fakeLlm({ P: () => ({ text: 'just text' }), R: () => ({ text: 'x' }) })
  await assert.rejects(ocrPage(never, { imagePath: image(), spotModel: 'P', readModel: 'R' }), /returned no text lines with positions/)
})

test('when the reading model fails the position model text is used and the note says so', async () => {
  const llm = fakeLlm({ P: () => ({ text: SPOT }), R: () => { throw new Error('down') } })
  const out = await ocrPage(llm, { imagePath: image(), spotModel: 'P', readModel: 'R' })
  assert.equal(out.lines[2].text, 'Bên A: Phân mềm')
  assert.match(out.notes[0], /reading model R failed \(down\).*wrong diacritics/)
})

test('when the position model fails the page fails', async () => {
  const llm = fakeLlm({ P: () => { throw new Error('boom') }, R: () => ({ text: 'x' }) })
  await assert.rejects(ocrPage(llm, { imagePath: image(), spotModel: 'P', readModel: 'R' }), /position model P failed: boom/)
})
