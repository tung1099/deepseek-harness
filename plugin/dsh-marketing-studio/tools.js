/**
 * `marketing_calc` tool: exact marketing arithmetic (market size, unit
 * economics, ad return, break-even, budget split) so figures in a report come
 * from a calculation and not from model estimation.
 *
 * @module dsh-marketing-studio/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { OPERATIONS, calculate } from './calc.js'

export const name = 'marketing-studio-tools'
export const inject = ['tools']

export const Config = Schema.object({
  currency: Schema.string().default('VND')
    .description('Currency code shown as the unit of money results (ISO 4217, e.g. VND, USD).'),
})

const num = description => ({ type: 'number', description })

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: { type: 'string', required: true },
    metrics: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          value: { type: 'number', required: true },
          unit: { type: 'string', required: true },
          formula: { type: 'string' },
        },
      },
    },
    notes: { type: 'array', required: true, items: { type: 'string' } },
  },
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'marketing_calc',
    description: 'Exact marketing arithmetic. Use it for every figure that is computed from other figures; do not estimate by hand. '
      + 'Pass `operation` plus that operation\'s inputs, and state the inputs as assumptions in the report.\n'
      + '- market_size: population, annual_value_per_customer, serviceable_share (0-1), obtainable_share (0-1) → TAM, SAM, SOM.\n'
      + '- unit_economics: avg_order_value, gross_margin (0-1], orders_per_year, lifetime_years, cac → LTV, LTV/CAC, CAC payback.\n'
      + '- ad_return: ad_spend, revenue, optional gross_margin (0-1] → ROAS, break-even ROAS, profit after ad spend.\n'
      + '- break_even: fixed_costs, unit_price, unit_variable_cost → break-even units and revenue.\n'
      + '- budget_split: total_budget, channels [{name, weight}] → amount per channel, summing exactly to total_budget.',
    parameters: {
      operation: { type: 'string', required: true, description: `One of: ${OPERATIONS.join(', ')}.` },
      population: num('market_size: number of potential customers in the whole market.'),
      annual_value_per_customer: num('market_size: yearly spend of one customer, in the report currency.'),
      serviceable_share: num('market_size: fraction of the market the offer can reach, 0 to 1.'),
      obtainable_share: num('market_size: fraction of the serviceable market realistically won, 0 to 1.'),
      avg_order_value: num('unit_economics: average revenue per order.'),
      gross_margin: num('unit_economics, ad_return: gross margin as a fraction above 0 and up to 1, e.g. 0.6.'),
      orders_per_year: num('unit_economics: orders one customer places per year.'),
      lifetime_years: num('unit_economics: years a customer stays active.'),
      cac: num('unit_economics: cost to acquire one customer, above 0.'),
      ad_spend: num('ad_return: advertising spend, above 0.'),
      revenue: num('ad_return: revenue attributed to that spend.'),
      fixed_costs: num('break_even: fixed costs for the period.'),
      unit_price: num('break_even: selling price of one unit.'),
      unit_variable_cost: num('break_even: variable cost of one unit.'),
      total_budget: num('budget_split: amount to divide.'),
      channels: {
        type: 'array',
        description: 'budget_split: channels with a relative weight each; weights need not sum to 1.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            weight: { type: 'number', required: true },
          },
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const { metrics, notes } = calculate(args.operation, args)
      return {
        operation: args.operation,
        metrics: metrics.map(m => ({ ...m, unit: m.unit.replace('currency', config.currency) })),
        notes,
      }
    },
  }))
}

/** One line per metric with its formula, then any notes. */
function renderResult(value) {
  const lines = [`${value.operation}:`]
  for (const m of value.metrics) {
    lines.push(`- ${m.name}: ${m.value} ${m.unit}${m.formula ? `  (${m.formula})` : ''}`)
  }
  for (const note of value.notes) lines.push(`Note: ${note}`)
  return lines.join('\n')
}
