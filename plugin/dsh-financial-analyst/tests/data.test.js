import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchCompany, finfoUrl, normalizeTicker } from '../data.js'
import { CONFIG, NOW, makeCompany, makeFetch } from './fixtures.js'

const OPTIONS = { annual: true, annualYears: 3, now: NOW }
const signal = () => new AbortController().signal

async function withFetch(fake, run) {
  const original = globalThis.fetch
  globalThis.fetch = fake
  try { return await run() } finally { globalThis.fetch = original }
}

test('normalizeTicker upper-cases and rejects anything that is not 2 to 6 letters or digits', () => {
  assert.equal(normalizeTicker(' fpt '), 'FPT')
  for (const bad of ['', 'F', 'FPT;DROP', 'a b', 'TOOLONGCODE', undefined, 42]) assert.throws(() => normalizeTicker(bad), /ticker must be/)
})

test('finfoUrl keeps the query readable and refuses characters that would need escaping', () => {
  assert.equal(finfoUrl({ baseUrl: 'https://x/v4' }, 'stocks', 'code:FPT~a:in:(1,2)', { size: 1 }), 'https://x/v4/stocks?q=code:FPT~a:in:(1,2)&size=1')
  assert.throws(() => finfoUrl({ baseUrl: 'https://x/v4' }, 'stocks', 'code:FPT&x=1'), /unsupported characters/)
})

test('fetchCompany reads profile, price in VND, shares, industries and statements, and records every URL', async () => {
  const company = makeCompany({ ticker: 'FPT', price: 51, shares: 1000 })
  const calls = []
  const raw = await withFetch(makeFetch([company], { calls }), () => fetchCompany(CONFIG, 'FPT', OPTIONS, signal()))
  assert.equal(raw.profile.name, 'Công ty FPT')
  assert.deepEqual(raw.price, { close: 51_000, date: '2026-11-10' })
  assert.equal(raw.shares, 1000)
  assert.equal(raw.industries[0].tickers[0], 'FPT')
  assert.equal(raw.quarterly.income.size, 9)
  assert.equal(raw.annual.income.size, 4)
  assert.equal(raw.annual.cashflow.get('2025-12-31').operating, 440)
  assert.equal(raw.sources.length, calls.length)
  assert.deepEqual(raw.sources.map(s => s.url), calls)
})

test('peers skip annual statements', async () => {
  const calls = []
  await withFetch(makeFetch([makeCompany({ ticker: 'AAA' })], { calls }), () => fetchCompany(CONFIG, 'AAA', { ...OPTIONS, annual: false }, signal()))
  assert.equal(calls.some(url => url.includes('reportType:ANNUAL')), false)
  assert.equal(calls.length, 6)
})

test('an unlisted code is rejected by name', async () => {
  await withFetch(makeFetch([]), async () => {
    await assert.rejects(fetchCompany(CONFIG, 'ZZZ', OPTIONS, signal()), /ZZZ is not a listed code/)
  })
})

test('HTTP errors and non-JSON bodies fail with the status or the body start', async () => {
  const company = makeCompany({ ticker: 'AAA' })
  await withFetch(makeFetch([company], { failFor: { '/stocks': 503 } }), async () => {
    await assert.rejects(fetchCompany(CONFIG, 'AAA', OPTIONS, signal()), /HTTP 503/)
  })
  await withFetch(makeFetch([company], { failFor: { '/stocks': 'non-json' } }), async () => {
    await assert.rejects(fetchCompany(CONFIG, 'AAA', OPTIONS, signal()), /non-JSON/)
  })
})

test('a connection failure is retried and then reported with the attempt count', async () => {
  let attempts = 0
  const failing = async () => { attempts++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }
  await withFetch(failing, async () => {
    await assert.rejects(fetchCompany({ ...CONFIG, retries: 1 }, 'AAA', OPTIONS, signal()), /failed after 2 attempt\(s\): ECONNRESET/)
  })
  assert.ok(attempts >= 2)
})
