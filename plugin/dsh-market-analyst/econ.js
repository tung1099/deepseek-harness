/**
 * Deterministic market-economics arithmetic behind the `econ_calc` tool.
 *
 * Every function is pure: it validates its inputs, throws an `Error` naming the
 * offending field, and returns `{ metrics, notes }`. Percentages are returned
 * in percent points (12.5 means 12.5%), never as fractions.
 *
 * @module dsh-market-analyst/econ
 */

export const OPERATIONS = ['growth', 'concentration', 'elasticity', 'npv_irr', 'deflate', 'score']

/** Round to a fixed number of decimals without exposing float noise. */
function round(value, digits = 2) {
  // `+ 0` turns a rounded -0 into 0.
  return Number(value.toFixed(digits)) + 0
}

function metric(name, value, unit, formula) {
  return { name, value, unit, ...(formula ? { formula } : {}) }
}

/** Require a finite number inside the given bounds. */
function number(args, field, { min = -Infinity, max = Infinity, exclusiveMin = false } = {}) {
  const value = args[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} is required and must be a number`)
  if (exclusiveMin ? value <= min : value < min) {
    throw new Error(`${field} must be ${exclusiveMin ? 'greater than' : 'at least'} ${min}`)
  }
  if (value > max) throw new Error(`${field} must be at most ${max}`)
  return value
}

/** Require a list of finite numbers with at least `minLength` entries. */
function numberList(args, field, minLength) {
  const list = args[field]
  if (!Array.isArray(list) || list.length < minLength) throw new Error(`${field} is required and must list at least ${minLength} number(s)`)
  for (const [index, value] of list.entries()) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field}[${index}] must be a number`)
  }
  return list
}

/** Compound annual growth rate in percent points. */
function cagr(start, end, years) {
  return ((end / start) ** (1 / years) - 1) * 100
}

function growth(args) {
  if (args.series !== undefined) {
    const series = numberList(args, 'series', 2)
    series.forEach((value, index) => {
      if (value <= 0) throw new Error(`series[${index}] must be greater than 0 to compute growth`)
    })
    const metrics = series.slice(1).map((value, index) =>
      metric(`Tăng trưởng kỳ ${index + 1}`, round((value / series[index] - 1) * 100), '%', `series[${index + 1}] ÷ series[${index}] − 1`))
    metrics.push(metric('CAGR', round(cagr(series[0], series.at(-1), series.length - 1)), '%/kỳ', '(cuối ÷ đầu)^(1 ÷ số kỳ) − 1'))
    return { metrics, notes: [] }
  }
  const start = number(args, 'start_value', { min: 0, exclusiveMin: true })
  const end = number(args, 'end_value', { min: 0, exclusiveMin: true })
  const years = number(args, 'years', { min: 0, exclusiveMin: true })
  return {
    metrics: [
      metric('CAGR', round(cagr(start, end, years)), '%/năm', '(end_value ÷ start_value)^(1 ÷ years) − 1'),
      metric('Tổng thay đổi', round((end / start - 1) * 100), '%', 'end_value ÷ start_value − 1'),
    ],
    notes: [],
  }
}

function concentration(args, config) {
  const shares = numberList(args, 'shares', 1)
  shares.forEach((share, index) => {
    if (share < 0) throw new Error(`shares[${index}] must be at least 0`)
  })
  const total = shares.reduce((sum, share) => sum + share, 0)
  if (total > 100.5) throw new Error(`shares sum to ${round(total)}, which exceeds 100 percent points`)

  const sorted = [...shares].sort((a, b) => b - a)
  const hhi = sorted.reduce((sum, share) => sum + share * share, 0)
  const top = count => sorted.slice(0, count).reduce((sum, share) => sum + share, 0)

  const level = hhi >= config.hhiHigh ? 'tập trung cao' : hhi >= config.hhiModerate ? 'tập trung vừa' : 'phân tán'
  const notes = [`HHI ${round(hhi, 0)}: ${level} (ngưỡng vừa ${config.hhiModerate}, cao ${config.hhiHigh}).`]
  if (total < 99.5) {
    notes.push(`Các hãng nêu chỉ chiếm ${round(total)}% thị phần; HHI tính trên phần này là cận dưới của HHI thật.`)
  }
  return {
    metrics: [
      metric('HHI', round(hhi, 0), 'điểm', 'Σ (thị phần %)²'),
      metric('CR3', round(top(3)), '%', 'tổng thị phần 3 hãng lớn nhất'),
      metric('CR4', round(top(4)), '%', 'tổng thị phần 4 hãng lớn nhất'),
    ],
    notes,
  }
}

function elasticity(args) {
  const p1 = number(args, 'p1', { min: 0, exclusiveMin: true })
  const q1 = number(args, 'q1', { min: 0, exclusiveMin: true })
  const p2 = number(args, 'p2', { min: 0, exclusiveMin: true })
  const q2 = number(args, 'q2', { min: 0, exclusiveMin: true })
  if (p1 === p2) throw new Error('p2 must differ from p1, otherwise elasticity is undefined')

  const quantityChange = (q2 - q1) / ((q1 + q2) / 2)
  const priceChange = (p2 - p1) / ((p1 + p2) / 2)
  const e = round(quantityChange / priceChange, 3)
  const revenueBefore = p1 * q1
  const revenueAfter = p2 * q2

  const notes = []
  if (e > 0) {
    notes.push('Hệ số dương: lượng tăng khi giá tăng. Cầu thông thường không như vậy, hãy kiểm tra yếu tố khác (thu nhập, chất lượng, mùa vụ) đã đổi cùng lúc.')
  } else if (Math.abs(e) > 1) {
    notes.push('Cầu co giãn (|e| > 1): giá tăng làm doanh thu giảm, giá giảm làm doanh thu tăng.')
  } else if (Math.abs(e) < 1) {
    notes.push('Cầu kém co giãn (|e| < 1): giá tăng làm doanh thu tăng, giá giảm làm doanh thu giảm.')
  } else {
    notes.push('Cầu co giãn đơn vị (|e| = 1): doanh thu không đổi khi giá đổi.')
  }
  notes.push('Hệ số chỉ đúng nếu hai điểm quan sát cùng một đường cầu; nếu cầu dịch chuyển giữa hai kỳ thì kết quả sai lệch.')
  return {
    metrics: [
      metric('Co giãn của cầu theo giá', e, 'hệ số', '(%Δ lượng) ÷ (%Δ giá), theo điểm giữa'),
      metric('%Δ lượng', round(quantityChange * 100), '%', '(q2 − q1) ÷ trung bình(q1, q2)'),
      metric('%Δ giá', round(priceChange * 100), '%', '(p2 − p1) ÷ trung bình(p1, p2)'),
      metric('Thay đổi doanh thu', round(revenueAfter - revenueBefore), 'tiền', 'p2 × q2 − p1 × q1'),
    ],
    notes,
  }
}

/** Net present value of `flows` (index 0 is time 0) at `rate` (a fraction). */
function npv(flows, rate) {
  return flows.reduce((sum, flow, t) => sum + flow / (1 + rate) ** t, 0)
}

/** IRR by bisection on [-0.99, 10]; undefined when NPV does not change sign there. */
function irr(flows) {
  let low = -0.99
  let high = 10
  let fLow = npv(flows, low)
  const fHigh = npv(flows, high)
  if (fLow * fHigh > 0) return undefined
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2
    const fMid = npv(flows, mid)
    if (fMid === 0) return mid
    if (fLow * fMid < 0) {
      high = mid
    } else {
      low = mid
      fLow = fMid
    }
  }
  return (low + high) / 2
}

/** Periods until cumulative undiscounted flows turn non-negative, interpolated within the period. */
function payback(flows) {
  let cumulative = 0
  for (const [t, flow] of flows.entries()) {
    const before = cumulative
    cumulative += flow
    if (t > 0 && before < 0 && cumulative >= 0) return t - 1 + -before / flow
    if (t === 0 && cumulative >= 0) return 0
  }
  return undefined
}

function npvIrr(args) {
  const flows = numberList(args, 'cash_flows', 2)
  const rate = number(args, 'discount_rate', { min: -1, exclusiveMin: true })

  const metrics = [metric('NPV', round(npv(flows, rate)), 'tiền', 'Σ dòng tiền_t ÷ (1 + discount_rate)^t')]
  const notes = []

  const signChanges = flows.slice(1).filter((flow, index) => flow !== 0 && flows[index] !== 0 && Math.sign(flow) !== Math.sign(flows[index])).length
  const internalRate = irr(flows)
  if (internalRate === undefined) {
    notes.push('Không tìm được IRR trong khoảng −99% đến 1000%: dòng tiền không đổi dấu hoặc NPV không cắt trục 0.')
  } else {
    metrics.push(metric('IRR', round(internalRate * 100), '%/kỳ', 'tỉ lệ chiết khấu làm NPV bằng 0'))
    if (signChanges > 1) notes.push('Dòng tiền đổi dấu nhiều lần nên có thể có nhiều IRR; hãy dựa vào NPV.')
  }
  const back = payback(flows)
  if (back === undefined) {
    notes.push('Dòng tiền cộng dồn không bao giờ về không trong các kỳ đã cho: chưa hoàn vốn.')
  } else {
    metrics.push(metric('Hoàn vốn (không chiết khấu)', round(back), 'kỳ', 'kỳ đầu tiên dòng tiền cộng dồn ≥ 0, nội suy trong kỳ'))
  }
  return { metrics, notes }
}

function deflate(args) {
  const nominal = numberList(args, 'nominal', 2)
  const inflation = numberList(args, 'inflation_pct', 1)
  if (inflation.length !== nominal.length - 1) {
    throw new Error(`inflation_pct must have ${nominal.length - 1} entries, one for each year after the first`)
  }
  inflation.forEach((rate, index) => {
    if (rate <= -100) throw new Error(`inflation_pct[${index}] must be greater than -100`)
  })

  let index = 1
  const real = [nominal[0]]
  for (const [i, rate] of inflation.entries()) {
    index *= 1 + rate / 100
    real.push(nominal[i + 1] / index)
  }
  const metrics = real.map((value, i) =>
    metric(`Giá thực kỳ ${i}`, round(value), 'tiền (giá kỳ 0)', i === 0 ? 'kỳ gốc' : 'danh nghĩa ÷ chỉ số giá cộng dồn'))
  const notes = []
  if (nominal[0] > 0 && real.at(-1) > 0) {
    const years = nominal.length - 1
    metrics.push(
      metric('CAGR danh nghĩa', round(cagr(nominal[0], nominal.at(-1), years)), '%/kỳ'),
      metric('CAGR thực', round(cagr(real[0], real.at(-1), years)), '%/kỳ'),
    )
  } else {
    notes.push('CAGR cần giá trị đầu và cuối dương, nên không được tính.')
  }
  return { metrics, notes }
}

/** Axis names in the fixed order the `scores` list uses. */
export const SCORE_AXES = ['quy mô và tăng trưởng', 'cường độ cạnh tranh', 'rào cản và kinh tế đơn vị', 'rủi ro vĩ mô']

function score(args, config) {
  const scores = numberList(args, 'scores', SCORE_AXES.length)
  if (scores.length !== SCORE_AXES.length) {
    throw new Error(`scores must list ${SCORE_AXES.length} numbers in this order: ${SCORE_AXES.join(', ')}`)
  }
  scores.forEach((value, index) => {
    if (value < 1 || value > 5) throw new Error(`scores[${index}] (${SCORE_AXES[index]}) must be between 1 and 5`)
  })
  const reliability = number(args, 'data_reliability', { min: 1, max: 5 })

  const weightSum = config.scoreWeights.reduce((sum, weight) => sum + weight, 0)
  const weighted = scores.reduce((sum, value, index) => sum + value * config.scoreWeights[index], 0) / weightSum
  const verdict = weighted >= config.verdictAttractive ? 'Hấp dẫn' : weighted <= config.verdictCautious ? 'Thận trọng' : 'Trung lập'
  const confidence = reliability >= config.confidenceHigh ? 'cao' : reliability >= config.confidenceMedium ? 'vừa' : 'thấp'
  return {
    metrics: [
      metric('Điểm tổng hợp', round(weighted), 'trên 5', 'Σ điểm trục × trọng số ÷ Σ trọng số'),
      metric('Độ tin cậy dữ liệu', round(reliability), 'trên 5'),
    ],
    notes: [
      `Kết luận: ${verdict} (Hấp dẫn từ ${config.verdictAttractive}, Thận trọng từ ${config.verdictCautious} trở xuống).`,
      `Mức tin cậy: ${confidence} (cao từ ${config.confidenceHigh}, vừa từ ${config.confidenceMedium}, tính theo độ tin cậy dữ liệu).`,
      `Trọng số theo thứ tự ${SCORE_AXES.join(', ')}: ${config.scoreWeights.join(', ')}.`,
    ],
  }
}

const HANDLERS = { growth, concentration, elasticity, npv_irr: npvIrr, deflate, score }

/**
 * Run one market-economics calculation.
 * @param {string} operation - one of {@link OPERATIONS}.
 * @param {Record<string, unknown>} args - the operation's numeric inputs.
 * @param {{ hhiModerate: number, hhiHigh: number, scoreWeights: number[], verdictAttractive: number, verdictCautious: number, confidenceHigh: number, confidenceMedium: number }} config - HHI thresholds for `concentration`; weights and thresholds for `score`.
 * @returns {{ metrics: Array<{ name: string, value: number, unit: string, formula?: string }>, notes: string[] }}
 */
export function calculate(operation, args, config) {
  const handler = Object.hasOwn(HANDLERS, operation) ? HANDLERS[operation] : undefined
  if (!handler) throw new Error(`unknown operation "${operation}"; use one of: ${OPERATIONS.join(', ')}`)
  return handler(args, config)
}
