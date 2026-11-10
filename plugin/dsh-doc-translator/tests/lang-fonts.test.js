import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkFonts } from '../fonts.js'
import { languageInfo } from '../lang.js'

test('languages are found by English name, Vietnamese name or code, in any case', () => {
  assert.equal(languageInfo('English').code, 'en')
  assert.equal(languageInfo('  TIẾNG VIỆT ').code, 'vi')
  assert.equal(languageInfo('ja').code, 'ja')
  assert.equal(languageInfo('Japanese').cjk, true)
  assert.equal(languageInfo('Arabic').rtl, true)
  assert.deepEqual(languageInfo('Klingon'), { code: null })
  assert.deepEqual(languageInfo(undefined), { code: null })
})

const fakeRun = (all, covering) => async (_file, args) => ({ stdout: (args[0].startsWith(':lang=') ? covering : all).join('\n'), stderr: '' })

test('a font is reported as installed, covering the target language, or unknown', async () => {
  const run = fakeRun(['DejaVu Sans,DejaVu Sans Condensed', 'Noto Sans', 'Bebas Neue'], ['DejaVu Sans', 'Noto Sans'])
  const out = await checkFonts(['DejaVu Sans', 'Bebas Neue', 'Calibri'], 'vi', run)
  assert.deepEqual(out.fonts, [
    { font: 'DejaVu Sans', installed: true, coversTarget: true },
    { font: 'Bebas Neue', installed: true, coversTarget: false },
    { font: 'Calibri', installed: false, coversTarget: null },
  ])
})

test('an unknown target language leaves coverage unknown, and no fonts means nothing to check', async () => {
  const out = await checkFonts(['Noto Sans'], null, fakeRun(['Noto Sans'], []))
  assert.equal(out.fonts[0].coversTarget, null)
  assert.deepEqual(await checkFonts([], 'vi', fakeRun([], [])), { checked: true, fonts: [] })
})

test('when fc-list is missing the check says so instead of failing', async () => {
  const out = await checkFonts(['Calibri'], 'vi', async () => { throw new Error('fc-list is not installed') })
  assert.equal(out.checked, false)
  assert.match(out.note, /not installed/)
})
