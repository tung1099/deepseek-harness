/**
 * `econ_calc` and `econ_indicator` tools for the market-analyst presets.
 *
 * `econ_calc` does exact market-economics arithmetic so figures come from a
 * calculation, not from model estimation. `econ_indicator` reads yearly
 * national indicators from the World Bank and returns them with citation URLs.
 *
 * @module dsh-market-analyst/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { OPERATIONS, SCORE_AXES, calculate } from './econ.js'
import { INDICATOR_ALIASES, fetchIndicator } from './indicator.js'

export const name = 'market-analyst-tools'
export const inject = ['tools']

export const Config = Schema.object({
  defaultCountry: Schema.string().default('VN')
    .description('Country used by econ_indicator when the model gives none (ISO 3166 alpha-2 or alpha-3).'),
  defaultYears: Schema.natural().min(1).default(10)
    .description('Number of recent yearly values econ_indicator returns when the model gives none.'),
  maxYears: Schema.natural().min(1).default(30)
    .description('Largest number of yearly values one econ_indicator call may request.'),
  baseUrl: Schema.string().default('https://api.worldbank.org/v2')
    .description('World Bank Indicators API root.'),
  siteUrl: Schema.string().default('https://data.worldbank.org')
    .description('World Bank data site root used to build the citation URL in results.'),
  timeoutMs: Schema.natural().min(1).default(20_000)
    .description('Budget for one econ_indicator call, retries included.'),
  retries: Schema.natural().max(5).default(2)
    .description('Extra attempts after a connection failure. HTTP error responses are not retried.'),
  retryDelayMs: Schema.natural().default(500)
    .description('Wait before each retry, multiplied by the attempt number.'),
  hhiModerate: Schema.natural().min(1).default(1000)
    .description('HHI at or above this value counts as moderately concentrated (US 2023 Merger Guidelines).'),
  hhiHigh: Schema.natural().min(1).default(1800)
    .description('HHI at or above this value counts as highly concentrated (US 2023 Merger Guidelines).'),
  scoreWeights: Schema.array(Schema.number().min(0)).default([1, 1, 1, 1])
    .description('Relative weights of the four verdict axes in the order: size and growth, competition intensity, barriers and unit economics, macro risk.'),
  verdictAttractive: Schema.number().min(1).max(5).default(3.5)
    .description('Weighted score at or above this value gives the verdict "Hấp dẫn".'),
  verdictCautious: Schema.number().min(1).max(5).default(2.5)
    .description('Weighted score at or below this value gives the verdict "Thận trọng"; scores in between give "Trung lập".'),
  confidenceHigh: Schema.number().min(1).max(5).default(4)
    .description('Data-reliability score at or above this value gives confidence "cao".'),
  confidenceMedium: Schema.number().min(1).max(5).default(3)
    .description('Data-reliability score at or above this value, and below confidenceHigh, gives confidence "vừa"; lower gives "thấp".'),
}).description('Market-analyst tool settings.')

const num = description => ({ type: 'number', description })
const numList = description => ({ type: 'array', description, items: { type: 'number' } })

const CALC_OUTPUT = {
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

const nullableNumber = { oneOf: [{ type: 'number' }, { type: 'null' }] }

const INDICATOR_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    country: { type: 'string', required: true },
    indicator: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        code: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
    },
    series: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          year: { type: 'integer', required: true },
          value: { ...nullableNumber, required: true },
        },
      },
    },
    latestYear: { type: 'integer', required: true },
    lastUpdated: { type: 'string', required: true },
    sourceUrl: { type: 'string', required: true },
    apiUrl: { type: 'string', required: true },
  },
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  if (config.hhiModerate >= config.hhiHigh) {
    throw new Error(`market-analyst-tools: hhiModerate (${config.hhiModerate}) must be below hhiHigh (${config.hhiHigh})`)
  }
  if (config.scoreWeights.length !== SCORE_AXES.length || !config.scoreWeights.some(weight => weight > 0)) {
    throw new Error(`market-analyst-tools: scoreWeights must list ${SCORE_AXES.length} weights, at least one above 0`)
  }
  if (config.verdictCautious >= config.verdictAttractive) {
    throw new Error(`market-analyst-tools: verdictCautious (${config.verdictCautious}) must be below verdictAttractive (${config.verdictAttractive})`)
  }
  if (config.confidenceMedium >= config.confidenceHigh) {
    throw new Error(`market-analyst-tools: confidenceMedium (${config.confidenceMedium}) must be below confidenceHigh (${config.confidenceHigh})`)
  }

  ctx.tools.register(defineTool({
    name: 'econ_calc',
    description: 'Exact market-economics arithmetic. Use it for every figure computed from other figures; do not estimate by hand. '
      + 'Pass `operation` plus that operation\'s inputs, and state the inputs as facts or assumptions in the report.\n'
      + '- growth: start_value, end_value, years → CAGR; or series (values in time order) → growth per period and CAGR.\n'
      + '- concentration: shares (market shares in percent points) → HHI, CR3, CR4 and a concentration level.\n'
      + '- elasticity: p1, q1, p2, q2 (two price-quantity observations on one demand curve) → price elasticity of demand and revenue effect.\n'
      + '- npv_irr: cash_flows (index 0 is time 0), discount_rate as a fraction such as 0.1 → NPV, IRR, payback.\n'
      + '- deflate: nominal (values in time order), inflation_pct (percent inflation for each period after the first) → real values and real CAGR.\n'
      + `- score: scores (four numbers from 1 to 5 in this order: ${SCORE_AXES.join(', ')}), data_reliability (1 to 5) → weighted score, verdict (Hấp dẫn, Trung lập or Thận trọng) and confidence (cao, vừa or thấp). Use it for the final verdict; do not pick the verdict yourself.`,
    parameters: {
      operation: { type: 'string', required: true, description: `One of: ${OPERATIONS.join(', ')}.` },
      start_value: num('growth: value in the first period, above 0.'),
      end_value: num('growth: value in the last period, above 0.'),
      years: num('growth: number of periods between start_value and end_value, above 0.'),
      series: numList('growth: values in time order, at least 2, each above 0. Use instead of start_value, end_value and years.'),
      shares: numList('concentration: market share of each firm in percent points; the sum must not exceed 100.'),
      p1: num('elasticity: first price, above 0.'),
      q1: num('elasticity: quantity sold at p1, above 0.'),
      p2: num('elasticity: second price, above 0 and different from p1.'),
      q2: num('elasticity: quantity sold at p2, above 0.'),
      cash_flows: numList('npv_irr: cash flow per period, index 0 at time 0 (usually the negative investment).'),
      discount_rate: num('npv_irr: discount rate per period as a fraction, e.g. 0.1 for 10%.'),
      nominal: numList('deflate: nominal values in time order, at least 2.'),
      inflation_pct: numList('deflate: inflation in percent for each period after the first, so one entry fewer than nominal.'),
      scores: numList(`score: exactly ${SCORE_AXES.length} scores from 1 (worst) to 5 (best for an entrant), in this order: ${SCORE_AXES.join(', ')}.`),
      data_reliability: num('score: how well the facts are sourced, from 1 (mostly assumptions) to 5 (every key figure cited from two sources).'),
    },
    output: {
      schema: CALC_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderCalc(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const { metrics, notes } = calculate(args.operation, args, config)
      return { operation: args.operation, metrics, notes }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'econ_indicator',
    description: 'Read yearly national economic indicators from the World Bank, with the year of every value and a URL to cite. '
      + 'Prefer it over searching the web for GDP, inflation, population and similar macro figures. '
      + 'Data is yearly and published with a lag that differs per indicator, so check `latestYear` before calling a value current. '
      + `Aliases: ${Object.entries(INDICATOR_ALIASES).map(([alias, code]) => `${alias} (${code})`).join(', ')}. Any other World Bank indicator code also works. `
      + 'It has no industry-level or company data.',
    parameters: {
      indicator: { type: 'string', required: true, description: 'An alias from the list above or a World Bank indicator code such as NY.GDP.MKTP.KD.ZG.' },
      country: { type: 'string', description: `ISO 3166 country code, e.g. "VN" or "US". Default "${config.defaultCountry}".` },
      years: { type: 'integer', description: `How many recent yearly values to return, 1 to ${config.maxYears}. Default ${config.defaultYears}.` },
    },
    output: {
      schema: INDICATOR_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderIndicator(value) }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return await fetchIndicator(config, args, exec.signal)
    },
  }))
}

/** One line per metric with its formula, then any notes. */
function renderCalc(value) {
  const lines = [`${value.operation}:`]
  for (const m of value.metrics) {
    lines.push(`- ${m.name}: ${m.value} ${m.unit}${m.formula ? `  (${m.formula})` : ''}`)
  }
  for (const note of value.notes) lines.push(`Note: ${note}`)
  return lines.join('\n')
}

/** Header with source and freshness, then one line per year. */
function renderIndicator(value) {
  const lines = [
    `${value.indicator.name} (${value.indicator.code}), ${value.country}`,
    `Latest year: ${value.latestYear}. World Bank dataset last updated: ${value.lastUpdated}.`,
    `Cite: ${value.sourceUrl}`,
  ]
  for (const point of value.series) lines.push(`${point.year}: ${point.value ?? 'no data'}`)
  return lines.join('\n')
}
