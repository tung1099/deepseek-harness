/**
 * Anomaly screening for one company against its own history and its peers.
 *
 * A flag states a measurable deviation and the numbers behind it. It is a
 * prompt to read the notes to the statements, not a finding of error and not a
 * judgement about the company's value. Thresholds come from plugin config.
 *
 * @module dsh-financial-analyst/anomalies
 */

import { median } from './metrics.js'

const f = (value, digits = 1) => value.toLocaleString('vi-VN', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** Peer metrics compared with the target: `kind` `relative` uses a percent gap to the median, `points` an absolute gap in percent points. */
const PEER_METRICS = [
  { key: 'pe', label: 'P/E', kind: 'relative', read: c => c.valuation.pe },
  { key: 'roe', label: 'ROE', kind: 'relative', read: c => c.ttm.view.metrics.roe },
  { key: 'liabilitiesToEquity', label: 'Nợ phải trả / vốn chủ', kind: 'relative', read: c => c.ttm.view.metrics.liabilitiesToEquity },
  { key: 'grossMargin', label: 'Biên lợi nhuận gộp', kind: 'points', read: c => c.ttm.view.metrics.grossMargin },
  { key: 'operatingMargin', label: 'Biên lợi nhuận hoạt động', kind: 'points', read: c => c.ttm.view.metrics.operatingMargin },
  { key: 'netMargin', label: 'Biên lợi nhuận ròng', kind: 'points', read: c => c.ttm.view.metrics.netMargin },
]

export { PEER_METRICS }

/**
 * Screen one company.
 * @param {{ ttm: object, annual: object[], valuation: object }} target - computed views of the company.
 * @param {Array<{ ticker: string, ttm: object, valuation: object }>} peers - peers with computed views.
 * @param {object} t - thresholds (see tools.js Config).
 * @returns {object[]} flags with `id`, `title`, `period`, `detail`, `observed` and `reference`.
 */
export function detectAnomalies(target, peers, t) {
  const flags = []
  const { view } = target.ttm
  const m = view.metrics
  const ttmPeriod = `TTM đến ${view.period.to}`
  const add = (id, title, period, detail, observed, reference) => flags.push({ id, title, period, detail, observed, reference })

  if (typeof m.netProfit === 'number' && m.netProfit <= 0) {
    add('net_loss', 'Lợi nhuận ròng không dương', ttmPeriod, `Lợi nhuận sau thuế của công ty mẹ 4 quý gần nhất là ${f(m.netProfit / 1e9, 0)} tỷ đồng; P/E không có ý nghĩa.`, { netProfit: m.netProfit }, { threshold: 0 })
  }

  if (view.revenueGrowth !== null && view.profitGrowth !== null) {
    const gap = view.profitGrowth - view.revenueGrowth
    if (Math.abs(gap) > t.divergencePp) {
      add('growth_divergence', 'Lợi nhuận và doanh thu tăng trưởng lệch nhau', ttmPeriod,
        `Doanh thu thay đổi ${f(view.revenueGrowth)}% còn lợi nhuận ròng thay đổi ${f(view.profitGrowth)}% so với 4 quý liền trước (chênh ${f(gap)} điểm %).`,
        { revenueGrowth: view.revenueGrowth, profitGrowth: view.profitGrowth }, { thresholdPoints: t.divergencePp })
    }
  }

  if (view.prior) {
    for (const [key, label] of [['grossMargin', 'Biên lợi nhuận gộp'], ['netMargin', 'Biên lợi nhuận ròng']]) {
      if (m[key] !== null && view.prior[key] !== null && Math.abs(m[key] - view.prior[key]) > t.marginSwingPp) {
        add(`${key}_swing`, `${label} biến động mạnh`, ttmPeriod,
          `${label} là ${f(m[key])}% so với ${f(view.prior[key])}% cùng kỳ năm trước (đổi ${f(m[key] - view.prior[key])} điểm %).`,
          { current: m[key], prior: view.prior[key] }, { thresholdPoints: t.marginSwingPp })
      }
    }
  }

  for (const [growthKey, label] of [['receivablesGrowth', 'Phải thu ngắn hạn'], ['inventoryGrowth', 'Hàng tồn kho']]) {
    if (view[growthKey] !== null && view.revenueGrowth !== null && view[growthKey] - view.revenueGrowth > t.workingCapitalGapPp) {
      add(`${growthKey}_outpaces_revenue`, `${label} tăng nhanh hơn doanh thu`, ttmPeriod,
        `${label} tăng ${f(view[growthKey])}% so với cùng kỳ năm trước, trong khi doanh thu TTM tăng ${f(view.revenueGrowth)}%.`,
        { itemGrowth: view[growthKey], revenueGrowth: view.revenueGrowth }, { thresholdPoints: t.workingCapitalGapPp })
    }
  }

  if (m.liabilitiesToEquity !== null && view.priorLiabilitiesToEquity !== null && m.liabilitiesToEquity - view.priorLiabilitiesToEquity > t.leverageJump) {
    add('leverage_jump', 'Nợ phải trả / vốn chủ tăng mạnh', ttmPeriod,
      `Nợ phải trả / vốn chủ là ${f(m.liabilitiesToEquity, 2)}x so với ${f(view.priorLiabilitiesToEquity, 2)}x một năm trước.`,
      { current: m.liabilitiesToEquity, prior: view.priorLiabilitiesToEquity }, { thresholdMultiple: t.leverageJump })
  }

  if (m.interestCoverage !== null && m.interestCoverage < t.interestCoverageMin) {
    add('low_interest_coverage', 'Khả năng chi trả lãi vay thấp', ttmPeriod,
      `(Lợi nhuận trước thuế + chi phí lãi vay) / chi phí lãi vay là ${f(m.interestCoverage, 2)}x.`,
      { interestCoverage: m.interestCoverage }, { minimum: t.interestCoverageMin })
  }

  if (m.nonCoreIncomeShare !== null && m.nonCoreIncomeShare > t.nonCoreShareMaxPct) {
    add('non_core_income_share', 'Thu nhập tài chính và thu nhập khác chiếm tỷ trọng lớn', ttmPeriod,
      `Doanh thu tài chính cộng thu nhập khác bằng ${f(m.nonCoreIncomeShare)}% lợi nhuận trước thuế.`,
      { share: m.nonCoreIncomeShare }, { maximumPct: t.nonCoreShareMaxPct })
  }

  if (m.effectiveTaxRate !== null && (m.effectiveTaxRate < t.taxRateMinPct || m.effectiveTaxRate > t.taxRateMaxPct)) {
    add('tax_rate_out_of_band', 'Thuế suất thực tế nằm ngoài khoảng thông thường', ttmPeriod,
      `Chi phí thuế TNDN bằng ${f(m.effectiveTaxRate)}% lợi nhuận trước thuế (khoảng tham chiếu ${t.taxRateMinPct}% đến ${t.taxRateMaxPct}%). Ưu đãi thuế hoặc khoản chi không được trừ có thể giải thích điều này.`,
      { effectiveTaxRate: m.effectiveTaxRate }, { minPct: t.taxRateMinPct, maxPct: t.taxRateMaxPct })
  }

  const lastYear = target.annual.at(-1)
  if (lastYear && lastYear.operatingCashFlow !== null && lastYear.netProfit > 0) {
    const period = `Năm tài chính ${lastYear.year}`
    if (lastYear.operatingCashFlow < 0) {
      add('negative_operating_cash_flow', 'Lưu chuyển tiền thuần từ hoạt động kinh doanh âm trong khi có lãi', period,
        `Dòng tiền kinh doanh là ${f(lastYear.operatingCashFlow / 1e9, 0)} tỷ đồng, lợi nhuận ròng ${f(lastYear.netProfit / 1e9, 0)} tỷ đồng.`,
        { operatingCashFlow: lastYear.operatingCashFlow, netProfit: lastYear.netProfit }, { minimumConversion: t.cashConversionMin })
    } else if (lastYear.cashConversion !== null && lastYear.cashConversion < t.cashConversionMin) {
      add('low_cash_conversion', 'Dòng tiền kinh doanh thấp so với lợi nhuận', period,
        `Dòng tiền kinh doanh / lợi nhuận ròng là ${f(lastYear.cashConversion, 2)}x.`,
        { cashConversion: lastYear.cashConversion }, { minimumConversion: t.cashConversionMin })
    }
  }

  if (peers.length >= t.minPeers) {
    for (const metric of PEER_METRICS) {
      const own = metric.read(target)
      const group = peers.map(metric.read).filter(value => typeof value === 'number')
      if (own === null || group.length < t.minPeers) continue
      const mid = median(group)
      const gap = own - mid
      const outlier = metric.kind === 'relative'
        ? mid > 0 && Math.abs(gap) / mid * 100 > t.peerDeviationPct
        : Math.abs(gap) > t.peerMarginDevPp
      if (!outlier) continue
      const direction = gap > 0 ? 'cao hơn' : 'thấp hơn'
      const gapText = metric.kind === 'relative' ? `${direction} trung vị ${f(Math.abs(gap) / mid * 100)}%` : `${direction} trung vị ${f(Math.abs(gap))} điểm %`
      add(`peer_${metric.key}`, `${metric.label} lệch xa trung vị cùng ngành`, ttmPeriod,
        `${metric.label} là ${f(own, 2)} trong khi trung vị của ${group.length} công ty cùng ngành là ${f(mid, 2)} (${gapText}).`,
        { value: own, peerMedian: mid, peers: group.length },
        metric.kind === 'relative' ? { thresholdPct: t.peerDeviationPct } : { thresholdPoints: t.peerMarginDevPp })
    }
  }
  return flags
}
