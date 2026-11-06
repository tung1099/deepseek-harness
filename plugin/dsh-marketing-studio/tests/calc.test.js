import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculate } from '../calc.js'
import { parseSkill } from '../skills.js'

const byName = result => Object.fromEntries(result.metrics.map(m => [m.name, m.value]))

test('market_size narrows TAM to SAM to SOM', () => {
  const m = byName(calculate('market_size', {
    population: 1_000_000,
    annual_value_per_customer: 2_000_000,
    serviceable_share: 0.2,
    obtainable_share: 0.05,
  }))
  assert.equal(m.TAM, 2_000_000_000_000)
  assert.equal(m.SAM, 400_000_000_000)
  assert.equal(m.SOM, 20_000_000_000)
  assert.equal(m['SOM customers'], 10_000)
})

test('unit_economics matches a hand calculation', () => {
  // 500k × 0.4 × 6 orders = 1.2M gross profit a year; 2 years → LTV 2.4M; CAC 600k → 4.0; payback 6 months.
  const result = calculate('unit_economics', {
    avg_order_value: 500_000, gross_margin: 0.4, orders_per_year: 6, lifetime_years: 2, cac: 600_000,
  })
  const m = byName(result)
  assert.equal(m.LTV, 2_400_000)
  assert.equal(m['LTV/CAC'], 4)
  assert.equal(m['CAC payback'], 6)
})

test('unit_economics reports a customer that never pays back', () => {
  const result = calculate('unit_economics', {
    avg_order_value: 100, gross_margin: 0.5, orders_per_year: 0, lifetime_years: 3, cac: 50,
  })
  assert.equal(byName(result)['CAC payback'], undefined)
  assert.match(result.notes[0], /never paid back/)
})

test('ad_return derives break-even ROAS only when margin is given', () => {
  assert.equal(byName(calculate('ad_return', { ad_spend: 100, revenue: 400 })).ROAS, 4)
  const m = byName(calculate('ad_return', { ad_spend: 100, revenue: 400, gross_margin: 0.5 }))
  assert.equal(m['Break-even ROAS'], 2)
  assert.equal(m['Profit after ad spend'], 100)
})

test('break_even rounds units up and rejects a non-positive contribution', () => {
  const m = byName(calculate('break_even', { fixed_costs: 1000, unit_price: 30, unit_variable_cost: 20 }))
  assert.equal(m['Break-even units'], 100)
  assert.equal(byName(calculate('break_even', { fixed_costs: 1001, unit_price: 30, unit_variable_cost: 20 }))['Break-even units'], 101)
  assert.throws(() => calculate('break_even', { fixed_costs: 1, unit_price: 20, unit_variable_cost: 20 }), /unit_price must exceed/)
})

test('budget_split sums exactly to the total even when shares do not divide evenly', () => {
  const result = calculate('budget_split', {
    total_budget: 100,
    channels: [{ name: 'a', weight: 1 }, { name: 'b', weight: 1 }, { name: 'c', weight: 1 }],
  })
  const total = result.metrics.reduce((sum, m) => sum + m.value, 0)
  assert.equal(Number(total.toFixed(2)), 100)
})

test('invalid inputs name the offending field', () => {
  assert.throws(() => calculate('market_size', { population: 10, annual_value_per_customer: 5, serviceable_share: 1.5, obtainable_share: 0.1 }), /serviceable_share must be at most 1/)
  assert.throws(() => calculate('unit_economics', { avg_order_value: 1, gross_margin: 0, orders_per_year: 1, lifetime_years: 1, cac: 1 }), /gross_margin must be greater than 0/)
  assert.throws(() => calculate('budget_split', { total_budget: 10, channels: [{ name: 'a', weight: 1 }, { name: 'a', weight: 1 }] }), /appears twice/)
  assert.throws(() => calculate('budget_split', { total_budget: 10, channels: [] }), /at least one channel/)
  assert.throws(() => calculate('constructor', {}), /unknown operation/)
})

test('parseSkill reads frontmatter and rejects a missing description', () => {
  const { fields, body } = parseSkill('---\nname: demo\ndescription: "A demo"\n---\n# Body\n', 'demo.md')
  assert.equal(fields.description, 'A demo')
  assert.equal(body, '# Body')
  assert.throws(() => parseSkill('---\nname: demo\n---\nx', 'demo.md'), /description/)
  assert.throws(() => parseSkill('no frontmatter', 'demo.md'), /frontmatter/)
})
