/**
 * Pure financial-ratio arithmetic for the financial-analyst tools.
 *
 * All money values are VND as published. Ratios are returned as plain numbers:
 * margins, ROE and growth in percent points, P/E and debt to equity as
 * multiples. A ratio whose input is missing or whose denominator is not
 * positive is `null`, never `0` or `NaN`.
 *
 * @module dsh-financial-analyst/metrics
 */

/** Statement lines summed over four quarters to form trailing-twelve-month (TTM) flows. */
const FLOW_KEYS = ['sales', 'gross', 'operating', 'pretax', 'netParent', 'interest', 'finIncome', 'otherIncome', 'tax']

/** `a / b`, or `null` when either is missing or `b` is not positive. */
export function ratio(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !(b > 0)) return null
  return a / b
}

/** `ratio(a, b)` in percent points. */
export function percent(a, b) {
  const value = ratio(a, b)
  return value === null ? null : value * 100
}

/** Growth from `previous` to `current` in percent points; `null` unless the base is positive. */
export function growth(current, previous) {
  if (typeof current !== 'number' || typeof previous !== 'number' || !(previous > 0)) return null
  return (current / previous - 1) * 100
}

/** Median of the finite numbers in `values`, or `null` when there are none. */
export function median(values) {
  const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Round to `digits` decimals for output; `null` stays `null`. */
export function round(value, digits = 2) {
  if (typeof value !== 'number') return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Equity attributable to the parent company: total equity minus non-controlling interests (absent counts as 0). */
export function parentEquity(balance) {
  if (balance?.equity === undefined) return null
  return balance.equity - (balance.minority ?? 0)
}

/** Interest-bearing debt: short-term plus long-term borrowings (an absent line counts as 0). */
export function interestBearingDebt(balance) {
  if (balance === undefined) return null
  return (balance.shortDebt ?? 0) + (balance.longDebt ?? 0)
}

/**
 * Ratios for one period.
 * @param {object} flows - income lines for the period (annual, or TTM sums).
 * @param {object | undefined} balance - balance-sheet lines at period end.
 * @param {number | null} averageParentEquity - mean of parent equity at period end and one year earlier.
 * @returns {object} ratios for the period.
 */
export function periodMetrics(flows, balance, averageParentEquity) {
  const equity = balance?.equity
  return {
    revenue: flows.sales ?? null,
    grossProfit: flows.gross ?? null,
    operatingProfit: flows.operating ?? null,
    netProfit: flows.netParent ?? null,
    grossMargin: percent(flows.gross, flows.sales),
    operatingMargin: percent(flows.operating, flows.sales),
    netMargin: percent(flows.netParent, flows.sales),
    roe: percent(flows.netParent, averageParentEquity),
    liabilitiesToEquity: ratio(balance?.liabilities, equity),
    debtToEquity: ratio(interestBearingDebt(balance), equity),
    interestCoverage: flows.interest > 0 && typeof flows.pretax === 'number' ? (flows.pretax + flows.interest) / flows.interest : null,
    effectiveTaxRate: percent(flows.tax, flows.pretax),
    nonCoreIncomeShare: percent((flows.finIncome ?? 0) + (flows.otherIncome ?? 0), flows.pretax),
    receivables: balance?.receivables ?? null,
    inventory: balance?.inventory ?? null,
  }
}

function sortedDates(map) {
  return [...map.keys()].sort().reverse()
}

/** Days between two ISO dates. */
function daysBetween(later, earlier) {
  return (Date.parse(later) - Date.parse(earlier)) / 86_400_000
}

/** True when the dates (newest first) are consecutive quarter ends, about 91 days apart. */
function consecutiveQuarters(dates) {
  for (let i = 0; i + 1 < dates.length; i++) {
    const gap = daysBetween(dates[i], dates[i + 1])
    if (gap < 80 || gap > 100) return false
  }
  return true
}

/** Sum the flow lines over quarters; `null` when any quarter lacks a line. */
function sumQuarters(income, dates) {
  const flows = {}
  for (const key of FLOW_KEYS) {
    let total = 0
    for (const date of dates) {
      const value = income.get(date)?.[key]
      if (typeof value !== 'number') { total = null; break }
      total += value
    }
    flows[key] = total
  }
  return flows
}

/**
 * Trailing-twelve-month view: the latest four quarters against the four before them.
 * @param {{ income: Map, balance: Map }} quarterly - statement maps by fiscal date.
 * @returns {{ ok: true, view: object } | { ok: false, reason: string }}
 */
export function buildTtm(quarterly) {
  const dates = sortedDates(quarterly.income)
  if (dates.length < 4) return { ok: false, reason: `only ${dates.length} quarterly income statements available, 4 needed` }
  const latest = dates.slice(0, 4)
  if (!consecutiveQuarters(latest)) return { ok: false, reason: `latest four quarters are not consecutive (${latest.join(', ')})` }
  const flows = sumQuarters(quarterly.income, latest)
  const periodEnd = latest[0]
  const balanceDates = sortedDates(quarterly.balance)
  const balance = quarterly.balance.get(periodEnd)
  if (balance === undefined) return { ok: false, reason: `no balance sheet for ${periodEnd}` }
  const yearAgoEnd = balanceDates.find(date => Math.abs(daysBetween(periodEnd, date) - 365) < 20)
  const yearAgoBalance = yearAgoEnd === undefined ? undefined : quarterly.balance.get(yearAgoEnd)
  const equityNow = parentEquity(balance)
  const equityBefore = parentEquity(yearAgoBalance)
  const averageEquity = equityNow !== null && equityBefore !== null ? (equityNow + equityBefore) / 2 : equityNow
  const metrics = periodMetrics(flows, balance, averageEquity)

  const priorDates = dates.slice(4, 8)
  const prior = priorDates.length === 4 && consecutiveQuarters([latest[3], ...priorDates])
    ? periodMetrics(sumQuarters(quarterly.income, priorDates), yearAgoBalance, null)
    : null
  return {
    ok: true,
    view: {
      period: { from: latest[3], to: periodEnd },
      flows,
      metrics,
      prior,
      priorPeriodEnd: prior ? priorDates[0] : null,
      averageEquityNote: yearAgoBalance === undefined ? 'ROE dùng vốn chủ của công ty mẹ cuối kỳ vì thiếu bảng cân đối kế toán một năm trước.' : null,
      revenueGrowth: prior ? growth(metrics.revenue, prior.revenue) : null,
      profitGrowth: prior ? growth(metrics.netProfit, prior.netProfit) : null,
      receivablesGrowth: yearAgoBalance ? growth(balance.receivables, yearAgoBalance.receivables) : null,
      inventoryGrowth: yearAgoBalance ? growth(balance.inventory, yearAgoBalance.inventory) : null,
      priorLiabilitiesToEquity: yearAgoBalance ? ratio(yearAgoBalance.liabilities, yearAgoBalance.equity) : null,
    },
  }
}

/**
 * Annual series, oldest first, for the last `years` fiscal years that have an income statement.
 * @param {{ income: Map, balance: Map, cashflow: Map }} annual - statement maps by fiscal date.
 * @param {number} years - how many fiscal years to return.
 * @returns {object[]} one entry per fiscal year with ratios, growth and cash conversion.
 */
export function buildAnnual(annual, years) {
  const incomeDates = sortedDates(annual.income)
  const out = []
  for (const date of incomeDates.slice(0, years)) {
    const year = Number(date.slice(0, 4))
    const priorDate = incomeDates.find(other => Number(other.slice(0, 4)) === year - 1)
    const balance = annual.balance.get(date)
    const priorBalance = priorDate === undefined ? undefined : annual.balance.get(priorDate)
    const equityNow = parentEquity(balance)
    const equityBefore = parentEquity(priorBalance)
    const averageEquity = equityNow !== null && equityBefore !== null ? (equityNow + equityBefore) / 2 : equityNow
    const flows = annual.income.get(date)
    const metrics = periodMetrics(flows, balance, averageEquity)
    const prior = priorDate === undefined ? null : periodMetrics(annual.income.get(priorDate), priorBalance, null)
    const operatingCashFlow = annual.cashflow.get(date)?.operating ?? null
    out.push({
      year,
      fiscalDate: date,
      ...metrics,
      revenueGrowth: prior ? growth(metrics.revenue, prior.revenue) : null,
      profitGrowth: prior ? growth(metrics.netProfit, prior.netProfit) : null,
      operatingCashFlow,
      cashConversion: ratio(operatingCashFlow, flows.netParent),
      priorGrossMargin: prior?.grossMargin ?? null,
      priorNetMargin: prior?.netMargin ?? null,
      priorLiabilitiesToEquity: priorBalance ? ratio(priorBalance.liabilities, priorBalance.equity) : null,
      averageEquityNote: priorBalance === undefined ? 'ROE dùng vốn chủ của công ty mẹ cuối năm vì thiếu bảng cân đối kế toán năm trước.' : null,
    })
  }
  return out.reverse()
}

/**
 * Valuation from the last trade price and the TTM profit.
 * @param {number | null} price - last close in VND.
 * @param {number | null} shares - outstanding shares.
 * @param {number | null} netProfitTtm - parent net profit over the last four quarters in VND.
 * @returns {{ marketCap: number | null, eps: number | null, pe: number | null, note: string | null }}
 */
export function valuation(price, shares, netProfitTtm) {
  const marketCap = price !== null && shares !== null ? price * shares : null
  const eps = typeof netProfitTtm === 'number' && typeof shares === 'number' && shares > 0 ? netProfitTtm / shares : null
  if (price === null || eps === null) return { marketCap, eps, pe: null, note: 'price, share count or TTM profit missing' }
  if (!(eps > 0)) return { marketCap, eps, pe: null, note: 'P/E is not meaningful because TTM profit is not positive' }
  return { marketCap, eps, pe: price / eps, note: null }
}
