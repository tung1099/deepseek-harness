import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyze, comparisonRow, industryPools, mapLimit } from '../analyze.js'
import { CONFIG, NOW, makeCompany, makeFetch } from './fixtures.js'

const signal = () => new AbortController().signal

async function withFetch(fake, run) {
  const original = globalThis.fetch
  globalThis.fetch = fake
  try { return await run() } finally { globalThis.fetch = original }
}

const run = (companies, args, config = CONFIG, options = {}) => withFetch(makeFetch(companies, options), () => analyze(config, args, signal(), NOW))

/** Target plus peers; each peer has a different size so the market-cap order is known. */
function industry(extra = {}) {
  const tickers = ['AAA', 'P1', 'P2', 'P3', 'P4']
  const industries = [{ level: 4, code: '9533', name: 'Dịch vụ máy tính', tickers }]
  return [
    makeCompany({ ticker: 'AAA', price: 60, shares: 100, industries, ...extra }),
    makeCompany({ ticker: 'P1', price: 10, shares: 100, industries }),
    makeCompany({ ticker: 'P2', price: 40, shares: 100, industries }),
    makeCompany({ ticker: 'P3', price: 30, shares: 100, industries }),
    makeCompany({ ticker: 'P4', price: 20, shares: 100, industries }),
  ]
}

test('mapLimit keeps input order and never exceeds the limit', async () => {
  let active = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    return x * 2
  })
  assert.deepEqual(out, [2, 4, 6, 8, 10])
  assert.equal(peak, 2)
})

test('industryPools lists narrower industries first and drops duplicates of the same members', () => {
  const raw = { ticker: 'AAA', industries: [
    { level: 1, code: '9000', name: 'Công nghệ', tickers: ['AAA', 'B', 'C', 'D'] },
    { level: 2, code: '9000', name: 'Công nghệ', tickers: ['AAA', 'B', 'C', 'D'] },
    { level: 4, code: '9533', name: 'Dịch vụ', tickers: ['AAA', 'B'] },
  ] }
  const pools = industryPools(raw, { peerIndustryLevel: 4 })
  assert.deepEqual(pools.map(p => [p.level, p.tickers]), [[4, ['B']], [2, ['B', 'C', 'D']]])
  assert.deepEqual(industryPools(raw, { peerIndustryLevel: 2 }).map(p => p.level), [2])
})

test('peers are the largest companies by market cap, and the comparison has a median', async () => {
  const result = await run(industry(), { ticker: 'aaa', maxPeers: 3 })
  assert.equal(result.ticker, 'AAA')
  assert.deepEqual(result.peers.map(p => p.ticker), ['P2', 'P3', 'P4'])
  assert.deepEqual(result.rows.map(r => r.ticker), ['AAA', 'P2', 'P3', 'P4'])
  assert.equal(result.target.annual.length, 3)
  assert.equal(result.peers[0].industry.level, 4)
  assert.equal(typeof result.peerMedian.roe, 'number')
  assert.ok(result.sources.length > 20)
  assert.ok(result.targetSources.every(s => s.url.includes('code:AAA') || s.url.includes('codeList:AAA')))
  assert.ok(result.notes.some(note => /vốn hóa lớn nhất/.test(note)))
})

test('P/E uses the last close and TTM profit: 60,000 VND / (400 / 100 shares)', async () => {
  const result = await run(industry(), { ticker: 'AAA', maxPeers: 3 })
  assert.equal(result.target.valuation.eps, 4)
  assert.equal(result.target.valuation.pe, 60_000 / 4)
  assert.equal(comparisonRow(result.target).pe, 15_000)
})

test('caller-chosen peers replace the classification and are noted', async () => {
  const result = await run(industry(), { ticker: 'AAA', peers: ['p1', 'P1', 'AAA', 'P4'] })
  assert.deepEqual(result.peers.map(p => p.ticker), ['P1', 'P4'])
  assert.ok(result.notes.some(note => /do người dùng chỉ định/.test(note)))
  assert.equal(result.peers[0].industry, null)
})

test('maxPeers 0 skips the comparison', async () => {
  const result = await run(industry(), { ticker: 'AAA', maxPeers: 0 })
  assert.deepEqual(result.peers, [])
  assert.equal(result.industry, null)
  assert.deepEqual(result.anomalies.filter(a => a.id.startsWith('peer_')), [])
})

test('a peer without recent statements is skipped with its reason and replaced by the next candidate', async () => {
  const companies = industry()
  const empty = makeCompany({ ticker: 'P2', price: 40, shares: 100, industries: companies[0].industries, quarterCount: 0, annualYears: [] })
  const result = await run([companies[0], companies[1], empty, companies[3], companies[4]], { ticker: 'AAA', maxPeers: 3 })
  assert.deepEqual(result.skippedPeers.map(s => s.ticker), ['P2'])
  assert.match(result.skippedPeers[0].reason, /no recent statements/)
  assert.deepEqual(result.peers.map(p => p.ticker), ['P3', 'P4', 'P1'])
  assert.ok(result.notes.some(note => /bị bỏ qua/.test(note)))
})

test('a stale peer is skipped', async () => {
  const companies = industry()
  const stale = makeCompany({ ticker: 'P2', price: 40, shares: 100, industries: companies[0].industries, end: '2024-06-30' })
  const result = await run([companies[0], companies[1], stale, companies[3], companies[4]], { ticker: 'AAA', maxPeers: 3 })
  assert.match(result.skippedPeers[0].reason, /days old/)
})

test('a narrow industry with too few usable peers widens to the next level', async () => {
  const narrow = [{ level: 4, code: '9533', name: 'Hẹp', tickers: ['AAA', 'P1'] }, { level: 3, code: '9530', name: 'Rộng', tickers: ['AAA', 'P1', 'P2', 'P3', 'P4'] }]
  const companies = industry().map(c => ({ ...c, industries: narrow }))
  const result = await run(companies, { ticker: 'AAA', maxPeers: 3 })
  assert.equal(result.industry.level, 4)
  assert.equal(result.peers.length, 3)
  assert.deepEqual([...new Set(result.peers.map(p => p.industry.level))].sort(), [3, 4])
  assert.ok(result.notes.some(note => /mở rộng sang bậc ngành rộng hơn/.test(note)))
})

test('with fewer than minPeers peers no peer-outlier flag is raised and the note says so', async () => {
  const companies = industry({ quarter: () => ({ netParent: 400 }) })
  const result = await run(companies, { ticker: 'AAA', peers: ['P1', 'P2'] })
  assert.equal(result.anomalies.some(a => a.id.startsWith('peer_')), false)
  assert.ok(result.notes.some(note => /ít hơn 3 nên không đưa cờ/.test(note)))
})

test('a failed market-cap lookup falls back to classification order and says so', async () => {
  const result = await run(industry(), { ticker: 'AAA', maxPeers: 3 }, CONFIG, { failFor: { 'stock_prices?q=code:P1,P2': 500 } })
  assert.deepEqual(result.peers.map(p => p.ticker), ['P1', 'P2', 'P3'])
  assert.ok(result.notes.some(note => /Không xếp hạng được/.test(note)))
})

test('a target with no usable statements is an error, not an empty report', async () => {
  const bank = makeCompany({ ticker: 'BNK', quarterCount: 0, annualYears: [] })
  await assert.rejects(run([bank], { ticker: 'BNK' }), /no recent statements in the non-financial model/)
})

test('bad arguments are rejected before any request', async () => {
  const calls = []
  const options = { calls }
  await assert.rejects(run(industry(), { ticker: 'AAA', years: 0 }, CONFIG, options), /years must be an integer from 1 to 10/)
  await assert.rejects(run(industry(), { ticker: 'AAA', maxPeers: 99 }, CONFIG, options), /maxPeers must be an integer from 0 to 10/)
  await assert.rejects(run(industry(), { ticker: 'AAA', peers: ['AAA'] }), /peers must list at least one ticker other than the target/)
  await assert.rejects(run(industry(), { ticker: 'A;B' }, CONFIG, options), /ticker must be/)
  assert.equal(calls.length, 0)
})
