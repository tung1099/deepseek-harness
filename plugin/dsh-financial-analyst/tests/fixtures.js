/**
 * Test fixtures: synthetic companies and a `fetch` stand-in that answers the
 * VNDirect finfo queries the plugin sends, using the same `q` filter syntax.
 */

import { BS_ITEMS, CF_ITEMS, IS_ITEMS } from '../data.js'

export const CONFIG = {
  baseUrl: 'https://finfo.test/v4',
  userAgent: 'test',
  retries: 1,
  retryDelayMs: 0,
  concurrency: 2,
  defaultYears: 3,
  maxYears: 10,
  maxPeers: 3,
  maxPeersLimit: 10,
  minPeers: 3,
  peerIndustryLevel: 4,
  maxStatementAgeDays: 400,
  divergencePp: 30,
  marginSwingPp: 3,
  workingCapitalGapPp: 20,
  cashConversionMin: 0.5,
  interestCoverageMin: 3,
  leverageJump: 0.3,
  nonCoreShareMaxPct: 30,
  taxRateMinPct: 10,
  taxRateMaxPct: 30,
  peerDeviationPct: 50,
  peerMarginDevPp: 5,
}

export const NOW = new Date('2026-11-10T08:00:00Z')

/** Quarter-end dates, newest first, `count` of them ending at `end` (YYYY-MM-DD). */
export function quarterEnds(end, count) {
  const dates = []
  let [year, month] = end.split('-').map(Number)
  for (let i = 0; i < count; i++) {
    const day = [3, 12].includes(month) ? 31 : 30
    dates.push(`${year}-${String(month).padStart(2, '0')}-${day}`)
    month -= 3
    if (month < 1) { month += 12; year -= 1 }
  }
  return dates
}

const DEFAULT_FLOWS = { sales: 1000, gross: 300, operating: 150, pretax: 140, netParent: 100, interest: 10, finIncome: 10, otherIncome: 2, tax: 28 }
const DEFAULT_BALANCE = { receivables: 200, inventory: 150, totalAssets: 2000, liabilities: 800, shortDebt: 200, longDebt: 100, equity: 1200, minority: 100 }

/**
 * A synthetic company.
 * @param {object} spec - `ticker`, optional `price` (thousand VND), `shares`, `industries`, and overrides.
 * @param {(i: number) => object} [spec.quarter] - per-quarter flow overrides; `i` is 0 for the latest quarter.
 * @param {(i: number) => object} [spec.balance] - per-quarter balance overrides.
 */
export function makeCompany(spec) {
  const quarters = quarterEnds(spec.end ?? '2026-09-30', spec.quarterCount ?? 9)
  const quarterly = { income: [], balance: [] }
  quarters.forEach((date, i) => {
    quarterly.income.push({ date, ...DEFAULT_FLOWS, ...spec.quarter?.(i) })
    quarterly.balance.push({ date, ...DEFAULT_BALANCE, ...spec.balance?.(i) })
  })
  const annual = (spec.annualYears ?? [2025, 2024, 2023, 2022]).map((year, i) => ({
    date: `${year}-12-31`,
    flows: { ...Object.fromEntries(Object.entries(DEFAULT_FLOWS).map(([k, v]) => [k, v * 4])), ...spec.yearFlows?.(i) },
    balance: { ...DEFAULT_BALANCE, ...spec.yearBalance?.(i) },
    operating: spec.cfo?.(i) ?? 440,
  }))
  return {
    price: 50,
    shares: 100,
    name: `Công ty ${spec.ticker}`,
    floor: 'HOSE',
    industries: [{ level: 4, code: '9533', name: 'Dịch vụ máy tính', tickers: [spec.ticker] }],
    ...spec,
    quarterly,
    annual,
  }
}

const rowsFor = (byDate, model, reportType, code) => byDate.flatMap((entry) => {
  const values = model === 3 ? { operating: entry.operating } : (model === 2 ? entry.flows ?? entry : entry.balance ?? entry)
  const names = model === 2 ? IS_ITEMS : (model === 1 ? BS_ITEMS : CF_ITEMS)
  return Object.entries(names).filter(([name]) => values[name] !== undefined).map(([name, itemCode]) => ({
    code, reportType, modelType: model, fiscalDate: entry.date, itemCode, numericValue: values[name],
  }))
})

/**
 * A `fetch` replacement serving the given companies.
 * @param {object[]} companies - results of `makeCompany`.
 * @param {{ calls?: string[], failFor?: Record<string, number | 'non-json'> }} [options] - records URLs; `failFor` maps a substring of the URL to an HTTP status.
 */
export function makeFetch(companies, options = {}) {
  const byCode = new Map(companies.map(c => [c.ticker, c]))
  return async (input) => {
    const url = new URL(String(input))
    options.calls?.push(String(input))
    for (const [needle, status] of Object.entries(options.failFor ?? {})) {
      if (String(input).includes(needle)) {
        if (status === 'non-json') return new Response('<html>blocked</html>', { status: 200 })
        return new Response(JSON.stringify({ message: 'boom' }), { status })
      }
    }
    const filters = Object.fromEntries(url.searchParams.get('q').split('~').map(part => [part.split(':')[0], part.slice(part.indexOf(':') + 1)]))
    const codes = (filters.code ?? filters.codeList ?? '').split(',').filter(Boolean)
    const path = url.pathname.replace('/v4/', '')
    const ok = data => new Response(JSON.stringify({ data }), { status: 200 })
    switch (path) {
      case 'stocks':
        if (filters.type) return ok([...byCode.values()].map(c => ({ code: c.ticker, companyName: c.name, shortName: c.shortName, floor: c.floor })))
        return ok(codes.filter(c => byCode.has(c)).map(c => ({ code: c, companyName: byCode.get(c).name, shortName: c, floor: byCode.get(c).floor, listedDate: '2010-01-01' })))
      case 'stock_prices':
        return ok(codes.filter(c => byCode.has(c)).map(c => ({ code: c, date: '2026-11-10', close: byCode.get(c).price })))
      case 'ratios':
        return ok(codes.filter(c => byCode.has(c)).map(c => ({ code: c, reportDate: '2026-12-31', value: byCode.get(c).shares })))
      case 'industry_classification': {
        const company = byCode.get(filters.codeList)
        return ok((company?.industries ?? []).map(i => ({ industryLevel: String(i.level), industryCode: i.code, vietnameseName: i.name, codeList: i.tickers.join(',') })))
      }
      case 'financial_statements': {
        const company = byCode.get(filters.code)
        if (!company) return ok([])
        const model = Number(filters.modelType)
        const quarter = filters.reportType === 'QUARTER'
        if (quarter) return ok(rowsFor(model === 2 ? company.quarterly.income : company.quarterly.balance, model, 'QUARTER', company.ticker))
        const annual = company.annual
        const entries = annual.map(a => ({ ...a, ...(model === 2 ? { flows: a.flows } : {}) }))
        return ok(rowsFor(entries, model, 'ANNUAL', company.ticker))
      }
      default:
        return new Response(JSON.stringify({ code: 'FFv4-101', message: 'This resource is not found' }), { status: 200 })
    }
  }
}
