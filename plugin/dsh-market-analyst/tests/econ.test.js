import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculate } from '../econ.js'

const config = {
  hhiModerate: 1000,
  hhiHigh: 1800,
  scoreWeights: [1, 1, 1, 1],
  verdictAttractive: 3.5,
  verdictCautious: 2.5,
  confidenceHigh: 4,
  confidenceMedium: 3,
}

const run = (operation, args, overrides = {}) => calculate(operation, args, { ...config, ...overrides })
const byName = result => Object.fromEntries(result.metrics.map(m => [m.name, m.value]))

test('growth: CAGR from two points and from a series', () => {
  assert.equal(byName(run('growth', { start_value: 100, end_value: 121, years: 2 })).CAGR, 10)
  const result = byName(run('growth', { series: [100, 110, 121] }))
  assert.equal(result['Tăng trưởng kỳ 1'], 10)
  assert.equal(result['Tăng trưởng kỳ 2'], 10)
  assert.equal(result.CAGR, 10)
})

test('growth: rejects non-positive values and short series', () => {
  assert.throws(() => run('growth', { start_value: 0, end_value: 5, years: 2 }), /start_value must be greater than 0/)
  assert.throws(() => run('growth', { series: [5] }), /at least 2/)
  assert.throws(() => run('growth', { series: [5, -1] }), /series\[1\] must be greater than 0/)
})

test('concentration: HHI of 40/30/20/10 is 3000 and highly concentrated', () => {
  const result = run('concentration', { shares: [10, 40, 20, 30] })
  const m = byName(result)
  assert.equal(m.HHI, 3000)
  assert.equal(m.CR3, 90)
  assert.equal(m.CR4, 100)
  assert.match(result.notes[0], /tập trung cao/)
})

test('concentration: reports a lower bound when listed firms do not cover the market', () => {
  const result = run('concentration', { shares: [20, 10] })
  assert.equal(byName(result).HHI, 500)
  assert.match(result.notes[0], /phân tán/)
  assert.match(result.notes[1], /cận dưới/)
})

test('concentration: honours configured thresholds and rejects shares above 100', () => {
  assert.match(run('concentration', { shares: [50, 50] }, { hhiModerate: 6000, hhiHigh: 7000 }).notes[0], /phân tán/)
  assert.throws(() => run('concentration', { shares: [60, 60] }), /exceeds 100/)
  assert.throws(() => run('concentration', { shares: [-1, 5] }), /shares\[0\] must be at least 0/)
})

test('elasticity: midpoint method for a price rise from 10 to 12 with quantity 100 to 80', () => {
  const result = run('elasticity', { p1: 10, q1: 100, p2: 12, q2: 80 })
  const m = byName(result)
  assert.equal(m['Co giãn của cầu theo giá'], -1.222)
  assert.equal(m['%Δ lượng'], -22.22)
  assert.equal(m['%Δ giá'], 18.18)
  assert.equal(m['Thay đổi doanh thu'], -40)
  assert.match(result.notes[0], /co giãn \(\|e\| > 1\)/)
})

test('elasticity: inelastic, unit, and positive coefficients are explained', () => {
  assert.match(run('elasticity', { p1: 10, q1: 100, p2: 11, q2: 98 }).notes[0], /kém co giãn/)
  const unit = run('elasticity', { p1: 10, q1: 120, p2: 12, q2: 100 })
  assert.equal(byName(unit)['Co giãn của cầu theo giá'], -1)
  assert.match(unit.notes[0], /co giãn đơn vị/)
  assert.match(run('elasticity', { p1: 10, q1: 100, p2: 12, q2: 110 }).notes[0], /Hệ số dương/)
  assert.throws(() => run('elasticity', { p1: 10, q1: 100, p2: 10, q2: 90 }), /p2 must differ from p1/)
})

test('npv_irr: -100, 60, 60 at 10% gives NPV 4.13 and IRR about 13.07%', () => {
  const result = run('npv_irr', { cash_flows: [-100, 60, 60], discount_rate: 0.1 })
  const m = byName(result)
  assert.equal(m.NPV, 4.13)
  assert.equal(m.IRR, 13.07)
  assert.equal(m['Hoàn vốn (không chiết khấu)'], 1.67)
})

test('npv_irr: flows that never turn positive have no IRR and no payback', () => {
  const result = run('npv_irr', { cash_flows: [-100, -10, -10], discount_rate: 0.05 })
  assert.equal(byName(result).IRR, undefined)
  assert.equal(result.notes.length, 2)
  assert.match(result.notes[0], /Không tìm được IRR/)
  assert.match(result.notes[1], /chưa hoàn vốn/)
})

test('npv_irr: warns about several sign changes and validates the rate', () => {
  const result = run('npv_irr', { cash_flows: [-100, 50, -20, 120], discount_rate: 0.1 })
  assert.ok(byName(result).IRR !== undefined)
  assert.ok(result.notes.some(note => /nhiều IRR/.test(note)))
  assert.throws(() => run('npv_irr', { cash_flows: [-1, 2], discount_rate: -1 }), /discount_rate must be greater than -1/)
  assert.throws(() => run('npv_irr', { cash_flows: [-1], discount_rate: 0.1 }), /at least 2/)
})

test('deflate: removes cumulative inflation and reports real CAGR', () => {
  const result = run('deflate', { nominal: [100, 110, 121], inflation_pct: [10, 10] })
  const m = byName(result)
  assert.equal(m['Giá thực kỳ 0'], 100)
  assert.equal(m['Giá thực kỳ 1'], 100)
  assert.equal(m['Giá thực kỳ 2'], 100)
  assert.equal(m['CAGR danh nghĩa'], 10)
  assert.equal(m['CAGR thực'], 0)
})

test('deflate: inflation list must have one entry fewer than nominal', () => {
  assert.throws(() => run('deflate', { nominal: [1, 2, 3], inflation_pct: [5] }), /must have 2 entries/)
  assert.throws(() => run('deflate', { nominal: [1, 2], inflation_pct: [-100] }), /greater than -100/)
})

test('score: equal weights average the four axes and map to a verdict and confidence', () => {
  const result = run('score', { scores: [4, 4, 3, 5], data_reliability: 4 })
  assert.equal(byName(result)['Điểm tổng hợp'], 4)
  assert.match(result.notes[0], /Kết luận: Hấp dẫn/)
  assert.match(result.notes[1], /Mức tin cậy: cao/)
})

test('score: neutral and cautious bands, and weights change the outcome', () => {
  assert.match(run('score', { scores: [3, 3, 3, 3], data_reliability: 3 }).notes[0], /Trung lập/)
  assert.match(run('score', { scores: [3, 3, 3, 3], data_reliability: 3 }).notes[1], /vừa/)
  const cautious = run('score', { scores: [2, 2, 3, 3], data_reliability: 2 })
  assert.match(cautious.notes[0], /Thận trọng/)
  assert.match(cautious.notes[1], /thấp/)
  const weighted = run('score', { scores: [5, 1, 1, 1], data_reliability: 3 }, { scoreWeights: [7, 1, 1, 1] })
  assert.equal(byName(weighted)['Điểm tổng hợp'], 3.8)
  assert.match(weighted.notes[0], /Hấp dẫn/)
})

test('score: validates the axis count and ranges', () => {
  assert.throws(() => run('score', { scores: [4, 4, 4], data_reliability: 3 }), /at least 4/)
  assert.throws(() => run('score', { scores: [4, 4, 4, 4, 4], data_reliability: 3 }), /must list 4 numbers/)
  assert.throws(() => run('score', { scores: [4, 6, 4, 4], data_reliability: 3 }), /scores\[1\].*between 1 and 5/)
  assert.throws(() => run('score', { scores: [4, 4, 4, 4], data_reliability: 0 }), /data_reliability must be at least 1/)
})

test('unknown operations are rejected, including inherited property names', () => {
  assert.throws(() => run('nope', {}), /unknown operation/)
  assert.throws(() => run('constructor', {}), /unknown operation/)
})
