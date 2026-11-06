/**
 * Deterministic marketing arithmetic behind the `marketing_calc` tool.
 *
 * Every function is pure: it validates its inputs, throws an `Error` naming the
 * offending field, and returns `{ metrics, notes }`. Money metrics carry the
 * unit `currency`, which the caller replaces with the configured currency code.
 *
 * @module dsh-marketing-studio/calc
 */

export const OPERATIONS = ['market_size', 'unit_economics', 'ad_return', 'break_even', 'budget_split']

/** Round to a fixed number of decimals without exposing float noise. */
function round(value, digits = 2) {
  return Number(value.toFixed(digits))
}

function metric(name, value, unit, formula) {
  return { name, value, unit, ...(formula ? { formula } : {}) }
}

/** Require a finite number inside `[min, max]`; `min`/`max` default to unbounded. */
function number(args, field, { min = -Infinity, max = Infinity, exclusiveMin = false } = {}) {
  const value = args[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} is required and must be a number`)
  if (exclusiveMin ? value <= min : value < min) {
    throw new Error(`${field} must be ${exclusiveMin ? 'greater than' : 'at least'} ${min}`)
  }
  if (value > max) throw new Error(`${field} must be at most ${max}`)
  return value
}

const share = (args, field) => number(args, field, { min: 0, max: 1 })
const margin = (args, field) => number(args, field, { min: 0, max: 1, exclusiveMin: true })

function marketSize(args) {
  const population = number(args, 'population', { min: 0 })
  const valuePerCustomer = number(args, 'annual_value_per_customer', { min: 0 })
  const serviceable = share(args, 'serviceable_share')
  const obtainable = share(args, 'obtainable_share')

  const samCustomers = population * serviceable
  const somCustomers = samCustomers * obtainable
  return {
    metrics: [
      metric('TAM', round(population * valuePerCustomer), 'currency/year', 'population × annual_value_per_customer'),
      metric('SAM', round(samCustomers * valuePerCustomer), 'currency/year', 'TAM × serviceable_share'),
      metric('SOM', round(somCustomers * valuePerCustomer), 'currency/year', 'SAM × obtainable_share'),
      metric('TAM customers', round(population, 0), 'customers'),
      metric('SAM customers', round(samCustomers, 0), 'customers'),
      metric('SOM customers', round(somCustomers, 0), 'customers'),
    ],
    notes: ['Every input is an assumption unless the report cites a source for it; label each one as such.'],
  }
}

function unitEconomics(args) {
  const orderValue = number(args, 'avg_order_value', { min: 0 })
  const grossMargin = margin(args, 'gross_margin')
  const ordersPerYear = number(args, 'orders_per_year', { min: 0 })
  const lifetimeYears = number(args, 'lifetime_years', { min: 0 })
  const cac = number(args, 'cac', { min: 0, exclusiveMin: true })

  const annualProfit = orderValue * grossMargin * ordersPerYear
  const ltv = annualProfit * lifetimeYears
  const metrics = [
    metric('Annual gross profit per customer', round(annualProfit), 'currency/year', 'avg_order_value × gross_margin × orders_per_year'),
    metric('LTV', round(ltv), 'currency', 'annual gross profit × lifetime_years'),
    metric('CAC', round(cac), 'currency'),
    metric('LTV/CAC', round(ltv / cac), 'ratio', 'LTV ÷ CAC'),
  ]
  const notes = []
  if (annualProfit > 0) {
    metrics.push(metric('CAC payback', round((cac / annualProfit) * 12, 1), 'months', 'CAC ÷ (annual gross profit ÷ 12)'))
  } else {
    notes.push('Annual gross profit per customer is zero, so CAC is never paid back.')
  }
  return { metrics, notes }
}

function adReturn(args) {
  const spend = number(args, 'ad_spend', { min: 0, exclusiveMin: true })
  const revenue = number(args, 'revenue', { min: 0 })
  const metrics = [metric('ROAS', round(revenue / spend), 'ratio', 'revenue ÷ ad_spend')]
  const notes = []
  if (args.gross_margin === undefined) {
    notes.push('Pass gross_margin to also get break-even ROAS and profit after ad spend.')
  } else {
    const grossMargin = margin(args, 'gross_margin')
    metrics.push(
      metric('Break-even ROAS', round(1 / grossMargin), 'ratio', '1 ÷ gross_margin'),
      metric('Profit after ad spend', round(revenue * grossMargin - spend), 'currency', 'revenue × gross_margin − ad_spend'),
    )
  }
  return { metrics, notes }
}

function breakEven(args) {
  const fixedCosts = number(args, 'fixed_costs', { min: 0 })
  const price = number(args, 'unit_price', { min: 0, exclusiveMin: true })
  const variableCost = number(args, 'unit_variable_cost', { min: 0 })
  const contribution = price - variableCost
  if (contribution <= 0) {
    throw new Error('unit_price must exceed unit_variable_cost, otherwise no sales volume breaks even')
  }
  const units = Math.ceil(fixedCosts / contribution)
  return {
    metrics: [
      metric('Contribution per unit', round(contribution), 'currency', 'unit_price − unit_variable_cost'),
      metric('Break-even units', units, 'units', 'ceil(fixed_costs ÷ contribution)'),
      metric('Break-even revenue', round(units * price), 'currency', 'break-even units × unit_price'),
    ],
    notes: [],
  }
}

function budgetSplit(args) {
  const total = number(args, 'total_budget', { min: 0 })
  const channels = args.channels
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('channels is required and must list at least one channel')
  const names = new Set()
  let weightSum = 0
  for (const [index, channel] of channels.entries()) {
    const label = `channels[${index}]`
    if (typeof channel?.name !== 'string' || channel.name.trim() === '') throw new Error(`${label}.name is required`)
    if (names.has(channel.name)) throw new Error(`${label}.name "${channel.name}" appears twice`)
    names.add(channel.name)
    weightSum += number(channel, 'weight', { min: 0, exclusiveMin: true })
  }

  const amounts = channels.map(channel => round((total * channel.weight) / weightSum))
  // Rounding each channel can leave a few cents; the largest channel absorbs them so the split sums to `total`.
  const largest = amounts.indexOf(Math.max(...amounts))
  amounts[largest] = round(amounts[largest] + total - amounts.reduce((sum, amount) => sum + amount, 0))

  return {
    metrics: channels.map((channel, index) =>
      metric(channel.name, amounts[index], 'currency', `${round((channel.weight / weightSum) * 100, 1)}% of total_budget`)),
    notes: [],
  }
}

const HANDLERS = {
  market_size: marketSize,
  unit_economics: unitEconomics,
  ad_return: adReturn,
  break_even: breakEven,
  budget_split: budgetSplit,
}

/**
 * Run one marketing calculation.
 * @param {string} operation - one of {@link OPERATIONS}.
 * @param {Record<string, unknown>} args - the operation's numeric inputs.
 * @returns {{ metrics: Array<{ name: string, value: number, unit: string, formula?: string }>, notes: string[] }}
 */
export function calculate(operation, args) {
  const handler = Object.hasOwn(HANDLERS, operation) ? HANDLERS[operation] : undefined
  if (!handler) throw new Error(`unknown operation "${operation}"; use one of: ${OPERATIONS.join(', ')}`)
  return handler(args)
}
