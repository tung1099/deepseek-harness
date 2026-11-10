import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyze } from '../analyze.js'
import { DISCLAIMER, FORMULAS, barChart, lineChart, peerBars, renderReport } from '../report.js'
import { renderText, validate } from '../summary.js'
import { CONFIG, NOW, makeCompany, makeFetch } from './fixtures.js'

async function analysis(overrides = {}) {
  const tickers = ['AAA', 'P1', 'P2', 'P3']
  const industries = [{ level: 4, code: '9533', name: 'Dịch vụ máy tính', tickers }]
  const companies = [
    makeCompany({ ticker: 'AAA', price: 60, shares: 100, industries, name: 'Công ty <b>"A"</b> & Co', ...overrides }),
    ...['P1', 'P2', 'P3'].map((ticker, i) => makeCompany({ ticker, price: 10 + i, shares: 100, industries })),
  ]
  const original = globalThis.fetch
  globalThis.fetch = makeFetch(companies)
  try { return await analyze(CONFIG, { ticker: 'AAA' }, new AbortController().signal, NOW) } finally { globalThis.fetch = original }
}

test('the report opens with the disclaimer and has no script, buy or sell wording outside it', async () => {
  const html = renderReport(await analysis())
  assert.ok(html.indexOf(DISCLAIMER.slice(0, 40)) < html.indexOf('Chỉ số chính'))
  assert.doesNotMatch(html, /<script/i)
  const outside = html.split(DISCLAIMER).join('')
  assert.doesNotMatch(outside, /nên mua|nên bán|nên nắm giữ|giá mục tiêu|đáng mua|khuyến nghị (mua|bán)/i)
})

test('company names from the API are escaped', async () => {
  const html = renderReport(await analysis())
  assert.ok(html.includes('Công ty &lt;b&gt;&quot;A&quot;&lt;/b&gt; &amp; Co'))
  assert.equal(html.includes('<b>"A"</b>'), false)
})

test('every source URL read appears as a link', async () => {
  const result = await analysis()
  const html = renderReport(result)
  for (const source of result.sources) assert.ok(html.includes(`href="${source.url.replace(/&/g, '&amp;')}"`), source.url)
})

test('the report carries tables, formulas and one chart per metric group', async () => {
  const html = renderReport(await analysis())
  for (const heading of ['Chỉ số chính (TTM)', 'Cờ bất thường', 'Số liệu theo năm', 'So sánh với công ty cùng ngành', 'Công thức', 'Nguồn dữ liệu']) assert.ok(html.includes(heading), heading)
  for (const [name] of FORMULAS) assert.ok(html.includes(name), name)
  assert.equal((html.match(/<svg /g) ?? []).length, 7)
})

test('a report without peers still renders and omits the peer charts', async () => {
  const original = globalThis.fetch
  globalThis.fetch = makeFetch([makeCompany({ ticker: 'AAA', price: 60, shares: 100 })])
  try {
    const result = await analyze(CONFIG, { ticker: 'AAA', maxPeers: 0 }, new AbortController().signal, NOW)
    const html = renderReport(result)
    assert.equal((html.match(/<svg /g) ?? []).length, 3)
  } finally { globalThis.fetch = original }
})

test('charts scale to the data and mark missing values without NaN', () => {
  const bars = barChart({ title: 't', categories: ['2024', '2025'], unit: 'u', series: [{ name: 's', values: [10, null] }] })
  assert.doesNotMatch(bars, /NaN|undefined/)
  assert.equal((bars.match(/<rect class="bar/g) ?? []).length, 1)
  const lines = lineChart({ title: 't', categories: ['a', 'b', 'c'], unit: '%', series: [{ name: 's', values: [1, null, 3] }] })
  assert.doesNotMatch(lines, /NaN|undefined/)
  assert.equal((lines.match(/<circle/g) ?? []).length, 2)
  const hbars = peerBars({ title: 't', unit: 'x', median: 2, rows: [{ label: 'A', value: -1, highlight: true }, { label: 'B', value: 3 }, { label: 'C', value: null }] })
  assert.doesNotMatch(hbars, /NaN|undefined/)
  assert.equal((hbars.match(/<rect class="bar/g) ?? []).length, 2)
})

test('the model digest lists the target URLs, a reminder not to recommend, and no rating field', async () => {
  const result = await analysis()
  const text = renderText(result, '/work/fin-report-AAA.html')
  assert.match(text, /Report file: \/work\/fin-report-AAA\.html/)
  for (const source of result.targetSources) assert.ok(text.includes(source.url))
  assert.match(text, /Do not recommend buying, selling or holding/)
  assert.doesNotMatch(text, /target price:|rating:|verdict/i)
})

test('validate rejects unordered settings and names them', () => {
  assert.doesNotThrow(() => validate(CONFIG))
  assert.throws(() => validate({ ...CONFIG, taxRateMinPct: 30, taxRateMaxPct: 10 }), /taxRateMinPct/)
  assert.throws(() => validate({ ...CONFIG, maxPeers: 11 }), /maxPeers/)
  assert.throws(() => validate({ ...CONFIG, defaultYears: 11 }), /defaultYears/)
})
