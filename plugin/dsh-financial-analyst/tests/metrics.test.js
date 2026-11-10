import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAnnual, buildTtm, growth, interestBearingDebt, median, parentEquity, percent, ratio, round, valuation } from '../metrics.js'
import { pivot, IS_ITEMS } from '../data.js'
import { makeCompany, quarterEnds } from './fixtures.js'

const toMaps = (company) => ({
  income: new Map(company.quarterly.income.map(({ date, ...v }) => [date, v])),
  balance: new Map(company.quarterly.balance.map(({ date, ...v }) => [date, v])),
})

test('ratio, percent and growth return null instead of 0 or NaN', () => {
  assert.equal(ratio(1, 0), null)
  assert.equal(ratio(1, -2), null)
  assert.equal(ratio(undefined, 2), null)
  assert.equal(percent(25, 200), 12.5)
  assert.equal(growth(110, 100), 10.000000000000009)
  assert.equal(growth(5, 0), null)
  assert.equal(growth(5, -3), null)
})

test('median ignores non-finite values and handles even and empty input', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([null, undefined, NaN, 5]), 5)
  assert.equal(median([]), null)
})

test('round keeps null', () => {
  assert.equal(round(1.2345, 2), 1.23)
  assert.equal(round(null), null)
})

test('parent equity subtracts minority interests and treats a missing line as 0', () => {
  assert.equal(parentEquity({ equity: 1200, minority: 100 }), 1100)
  assert.equal(parentEquity({ equity: 1200 }), 1200)
  assert.equal(parentEquity(undefined), null)
  assert.equal(interestBearingDebt({ shortDebt: 5 }), 5)
})

test('TTM sums four quarters and derives ratios from them', () => {
  const result = buildTtm(toMaps(makeCompany({ ticker: 'AAA' })))
  assert.equal(result.ok, true)
  const { view } = result
  assert.deepEqual(view.period, { from: '2025-12-31', to: '2026-09-30' })
  assert.equal(view.flows.sales, 4000)
  assert.equal(view.metrics.grossMargin, 30)
  assert.equal(view.metrics.operatingMargin, 15)
  assert.equal(view.metrics.netMargin, 10)
  assert.ok(Math.abs(view.metrics.roe - 400 / 1100 * 100) < 1e-9)
  assert.ok(Math.abs(view.metrics.liabilitiesToEquity - 800 / 1200) < 1e-9)
  assert.equal(view.metrics.debtToEquity, 0.25)
  assert.equal(view.metrics.interestCoverage, 15)
  assert.equal(view.metrics.effectiveTaxRate, 20)
  assert.ok(Math.abs(view.metrics.nonCoreIncomeShare - 48 / 560 * 100) < 1e-9)
  assert.equal(view.revenueGrowth, 0)
  assert.equal(view.profitGrowth, 0)
})

test('TTM growth compares the latest four quarters with the four before', () => {
  const maps = toMaps(makeCompany({ ticker: 'AAA', quarter: i => (i < 4 ? { sales: 800, netParent: 150 } : {}) }))
  const { view } = buildTtm(maps)
  assert.ok(Math.abs(view.revenueGrowth - -20) < 1e-9)
  assert.ok(Math.abs(view.profitGrowth - 50) < 1e-9)
})

test('TTM ROE averages parent equity at period end and one year earlier', () => {
  const maps = toMaps(makeCompany({ ticker: 'AAA', balance: i => (i === 0 ? { equity: 1300, minority: 100 } : (i === 4 ? { equity: 900, minority: 100 } : {})) }))
  const { view } = buildTtm(maps)
  // parent equity 1200 now and 800 a year earlier -> average 1000
  assert.ok(Math.abs(view.metrics.roe - 40) < 1e-9)
})

test('TTM is refused when quarters are missing or not consecutive', () => {
  const fewer = toMaps(makeCompany({ ticker: 'AAA', quarterCount: 3 }))
  assert.match(buildTtm(fewer).reason, /only 3 quarterly income statements/)
  const gap = toMaps(makeCompany({ ticker: 'AAA' }))
  gap.income.delete('2026-03-31')
  assert.match(buildTtm(gap).reason, /not consecutive/)
  const noBalance = toMaps(makeCompany({ ticker: 'AAA' }))
  noBalance.balance.delete('2026-09-30')
  assert.match(buildTtm(noBalance).reason, /no balance sheet for 2026-09-30/)
})

test('TTM falls back to period-end equity and says so when the year-ago balance sheet is missing', () => {
  const maps = toMaps(makeCompany({ ticker: 'AAA', quarterCount: 4 }))
  const { view } = buildTtm(maps)
  assert.ok(Math.abs(view.metrics.roe - 400 / 1100 * 100) < 1e-9)
  assert.match(view.averageEquityNote, /period-end parent equity|vốn chủ của công ty mẹ cuối kỳ/)
  assert.equal(view.prior, null)
  assert.equal(view.revenueGrowth, null)
})

test('annual series is oldest first with growth, ROE on average equity and cash conversion', () => {
  const company = makeCompany({ ticker: 'AAA', yearFlows: i => (i === 0 ? { sales: 5000, netParent: 600 } : {}), cfo: i => (i === 0 ? 300 : 440) })
  const annual = {
    income: new Map(company.annual.map(a => [a.date, a.flows])),
    balance: new Map(company.annual.map(a => [a.date, a.balance])),
    cashflow: new Map(company.annual.map(a => [a.date, { operating: a.operating }])),
  }
  const series = buildAnnual(annual, 2)
  assert.deepEqual(series.map(a => a.year), [2024, 2025])
  const last = series[1]
  assert.equal(last.revenue, 5000)
  assert.ok(Math.abs(last.revenueGrowth - 25) < 1e-9)
  assert.ok(Math.abs(last.profitGrowth - 50) < 1e-9)
  assert.ok(Math.abs(last.roe - 600 / 1100 * 100) < 1e-9)
  assert.equal(last.cashConversion, 0.5)
})

test('valuation gives P/E from TTM profit and explains when it is not meaningful', () => {
  const ok = valuation(50_000, 100, 1_000_000)
  assert.equal(ok.eps, 10_000)
  assert.equal(ok.pe, 5)
  assert.equal(ok.marketCap, 5_000_000)
  assert.match(valuation(50_000, 100, -5).note, /not meaningful/)
  assert.equal(valuation(50_000, 100, -5).pe, null)
  assert.match(valuation(null, 100, 5).note, /missing/)
})

test('pivot groups rows by fiscal date and drops unknown codes and non-numeric values', () => {
  const rows = [
    { fiscalDate: '2026-09-30', itemCode: 21001, numericValue: 10 },
    { fiscalDate: '2026-09-30', itemCode: 23000, numericValue: 2 },
    { fiscalDate: '2026-09-30', itemCode: 99999, numericValue: 7 },
    { fiscalDate: '2026-06-30', itemCode: 21001, numericValue: null },
  ]
  const out = pivot(rows, IS_ITEMS)
  assert.deepEqual(out.get('2026-09-30'), { sales: 10, netParent: 2 })
  assert.equal(out.has('2026-06-30'), false)
})

test('quarterEnds counts back across the year boundary', () => {
  assert.deepEqual(quarterEnds('2026-03-31', 3), ['2026-03-31', '2025-12-31', '2025-09-30'])
})
