import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectAnomalies } from '../anomalies.js'
import { buildAnnual, buildTtm, valuation } from '../metrics.js'
import { CONFIG, makeCompany } from './fixtures.js'

/** Build the computed views `detectAnomalies` takes from a fixture company. */
function view(spec) {
  const company = makeCompany(spec)
  const ttm = buildTtm({
    income: new Map(company.quarterly.income.map(({ date, ...v }) => [date, v])),
    balance: new Map(company.quarterly.balance.map(({ date, ...v }) => [date, v])),
  })
  assert.equal(ttm.ok, true)
  const annual = buildAnnual({
    income: new Map(company.annual.map(a => [a.date, a.flows])),
    balance: new Map(company.annual.map(a => [a.date, a.balance])),
    cashflow: new Map(company.annual.map(a => [a.date, { operating: a.operating }])),
  }, 2)
  return { ticker: spec.ticker, ttm, annual, valuation: valuation(spec.price * 1000, spec.shares, ttm.view.metrics.netProfit) }
}

const ids = flags => flags.map(f => f.id)

test('a steady company with no peers raises no flags', () => {
  assert.deepEqual(detectAnomalies(view({ ticker: 'AAA', price: 50, shares: 100 }), [], CONFIG), [])
})

test('profit moving away from revenue is flagged with both growth figures', () => {
  const target = view({ ticker: 'AAA', price: 50, shares: 100, quarter: i => (i < 4 ? { sales: 900, netParent: 160, gross: 270, operating: 140, pretax: 200 } : {}) })
  const flags = detectAnomalies(target, [], CONFIG)
  const flag = flags.find(f => f.id === 'growth_divergence')
  assert.ok(flag)
  assert.ok(Math.abs(flag.observed.revenueGrowth - -10) < 1e-9)
  assert.ok(Math.abs(flag.observed.profitGrowth - 60) < 1e-9)
})

test('margin swings beyond the threshold are flagged and smaller ones are not', () => {
  const big = detectAnomalies(view({ ticker: 'AAA', price: 50, shares: 100, quarter: i => (i < 4 ? { gross: 220 } : {}) }), [], CONFIG)
  assert.ok(ids(big).includes('grossMargin_swing'))
  const small = detectAnomalies(view({ ticker: 'AAA', price: 50, shares: 100, quarter: i => (i < 4 ? { gross: 320 } : {}) }), [], CONFIG)
  assert.equal(ids(small).includes('grossMargin_swing'), false)
})

test('receivables and inventory growing faster than revenue are flagged', () => {
  const target = view({ ticker: 'AAA', price: 50, shares: 100, balance: i => (i === 0 ? { receivables: 400, inventory: 300 } : {}) })
  const found = ids(detectAnomalies(target, [], CONFIG))
  assert.ok(found.includes('receivablesGrowth_outpaces_revenue'))
  assert.ok(found.includes('inventoryGrowth_outpaces_revenue'))
})

test('a jump in liabilities to equity and a thin interest cover are flagged', () => {
  const target = view({ ticker: 'AAA', price: 50, shares: 100, balance: i => (i === 0 ? { liabilities: 1800 } : {}), quarter: i => (i < 4 ? { interest: 60, pretax: 100 } : {}) })
  const found = ids(detectAnomalies(target, [], CONFIG))
  assert.ok(found.includes('leverage_jump'))
  assert.ok(found.includes('low_interest_coverage'))
})

test('weak cash conversion and negative operating cash flow with a profit are flagged', () => {
  const low = detectAnomalies(view({ ticker: 'AAA', price: 50, shares: 100, cfo: () => 100 }), [], CONFIG)
  assert.ok(ids(low).includes('low_cash_conversion'))
  const negative = detectAnomalies(view({ ticker: 'AAA', price: 50, shares: 100, cfo: () => -50 }), [], CONFIG)
  assert.ok(ids(negative).includes('negative_operating_cash_flow'))
  assert.equal(ids(negative).includes('low_cash_conversion'), false)
})

test('non-core income share and an out-of-band tax rate are flagged', () => {
  const target = view({ ticker: 'AAA', price: 50, shares: 100, quarter: () => ({ finIncome: 60, tax: 4 }) })
  const found = ids(detectAnomalies(target, [], CONFIG))
  assert.ok(found.includes('non_core_income_share'))
  assert.ok(found.includes('tax_rate_out_of_band'))
})

test('a loss is flagged and the detail says P/E has no meaning', () => {
  const target = view({ ticker: 'AAA', price: 50, shares: 100, quarter: () => ({ netParent: -10 }) })
  const flag = detectAnomalies(target, [], CONFIG).find(f => f.id === 'net_loss')
  assert.ok(flag)
  assert.match(flag.detail, /P\/E không có ý nghĩa/)
})

test('peer outlier flags need at least minPeers peers and use the median', () => {
  const target = view({ ticker: 'AAA', price: 50, shares: 100, quarter: () => ({ netParent: 300 }) })
  const peers = ['B', 'C', 'D'].map(ticker => ({ ...view({ ticker, price: 50, shares: 100 }), ticker }))
  const flags = detectAnomalies(target, peers, CONFIG)
  const roe = flags.find(f => f.id === 'peer_roe')
  assert.ok(roe)
  assert.equal(roe.observed.peers, 3)
  assert.match(roe.detail, /cao hơn trung vị/)
  const tooFew = detectAnomalies(target, peers.slice(0, 2), CONFIG)
  assert.equal(ids(tooFew).some(id => id.startsWith('peer_')), false)
})

test('flags carry no rating, score or recommendation field', () => {
  const target = view({ ticker: 'AAA', price: 50, shares: 100, quarter: () => ({ netParent: -10 }) })
  for (const flag of detectAnomalies(target, [], CONFIG)) {
    assert.deepEqual(Object.keys(flag).sort(), ['detail', 'id', 'observed', 'period', 'reference', 'title'])
    assert.doesNotMatch(`${flag.title} ${flag.detail}`, /nên mua|nên bán|khuyến nghị mua|giá mục tiêu|đáng mua/i)
  }
})
