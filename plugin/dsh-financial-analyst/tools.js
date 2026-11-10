/**
 * `fin_report` tool for the financial-analyst preset.
 *
 * One call reads the statements of a listed non-financial company and its
 * industry peers from VNDirect, computes margins, ROE, P/E and debt to equity,
 * compares them with the peer median, screens for anomalies, and writes an HTML
 * report with charts, tables and the URL of every source. The tool states data
 * and deviations only; it has no rating, target price or recommendation field.
 *
 * @module dsh-financial-analyst/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { analyze } from './analyze.js'
import { writeReport } from './deliver.js'
import { normalizeTicker } from './data.js'
import { renderReport } from './report.js'
import { listCompanies, searchCompanies } from './lookup.js'
import { renderMatches, renderText, validate } from './summary.js'

export const name = 'financial-analyst-tools'
export const inject = ['tools', 'fs', 'workingDirectory']

export const Config = Schema.object({
  baseUrl: Schema.string().default('https://api-finfo.vndirect.com.vn/v4')
    .description('VNDirect finfo API root. This API is public but unofficial and may change without notice.'),
  userAgent: Schema.string().default('dsh-financial-analyst')
    .description('User-Agent header sent with every request.'),
  timeoutMs: Schema.natural().min(1).default(90_000)
    .description('Budget for one fin_report call, retries included.'),
  retries: Schema.natural().max(5).default(2)
    .description('Extra attempts after a connection failure. HTTP error responses are not retried.'),
  retryDelayMs: Schema.natural().default(500)
    .description('Wait before each retry, multiplied by the attempt number.'),
  maxMatches: Schema.natural().min(1).max(10).default(5)
    .description('Most companies fin_find_company returns for one query.'),
  concurrency: Schema.natural().min(1).max(8).default(3)
    .description('Companies read in parallel when loading peers.'),
  defaultYears: Schema.natural().min(1).default(5)
    .description('Fiscal years in the annual table and charts when the model gives none.'),
  maxYears: Schema.natural().min(1).default(10)
    .description('Largest number of fiscal years one call may request.'),
  maxPeers: Schema.natural().default(5)
    .description('Peers compared with the target when the model gives none.'),
  maxPeersLimit: Schema.natural().min(1).default(10)
    .description('Largest number of peers one call may request.'),
  minPeers: Schema.natural().min(1).default(3)
    .description('Smallest peer group that supports peer-outlier flags. A smaller group widens the industry level.'),
  peerIndustryLevel: Schema.natural().min(1).max(4).default(4)
    .description('Narrowest industry classification level peers are drawn from (4 is narrowest, 1 is the whole sector).'),
  maxStatementAgeDays: Schema.natural().min(1).default(400)
    .description('A company whose latest quarterly statement is older than this is left out as stale.'),
  divergencePp: Schema.number().min(0).default(30)
    .description('Flag when TTM profit growth and TTM revenue growth differ by more than this many percent points.'),
  marginSwingPp: Schema.number().min(0).default(3)
    .description('Flag when gross or net margin moved by more than this many percent points against the same period a year earlier.'),
  workingCapitalGapPp: Schema.number().min(0).default(20)
    .description('Flag when receivables or inventory grew more than this many percent points faster than revenue.'),
  cashConversionMin: Schema.number().min(0).default(0.5)
    .description('Flag when operating cash flow divided by net profit is below this value in the latest fiscal year.'),
  interestCoverageMin: Schema.number().min(0).default(3)
    .description('Flag when (pretax profit + interest expense) / interest expense is below this multiple.'),
  leverageJump: Schema.number().min(0).default(0.3)
    .description('Flag when liabilities to equity rose by more than this multiple against a year earlier.'),
  nonCoreShareMaxPct: Schema.number().min(0).default(30)
    .description('Flag when financial income plus other income exceeds this percent of pretax profit.'),
  taxRateMinPct: Schema.number().min(0).default(10)
    .description('Flag when the effective tax rate is below this percent.'),
  taxRateMaxPct: Schema.number().min(0).default(30)
    .description('Flag when the effective tax rate is above this percent.'),
  peerDeviationPct: Schema.number().min(0).default(50)
    .description('Flag P/E, ROE or liabilities to equity when it differs from the peer median by more than this percent of the median.'),
  peerMarginDevPp: Schema.number().min(0).default(5)
    .description('Flag a margin when it differs from the peer median by more than this many percent points.'),
}).description('Financial-analyst tool settings.')

const FIND_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    query: { type: 'string', required: true },
    confident: { type: 'boolean', required: true },
    text: { type: 'string', required: true },
  },
}

const OUTPUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ticker: { type: 'string', required: true },
    file: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    text: { type: 'string', required: true },
  },
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  validate(config)
  // Same condition `dsh-tool-fs` uses: the policy service matters only when a confining filesystem is mounted.
  const sandboxPolicy = ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')

  ctx.tools.register(defineTool({
    name: 'fin_find_company',
    description: 'Find the stock code of a listed Vietnamese company from its name, or check that a code exists. '
      + 'It matches the registered company name and short name, ignoring accents and prefixes such as "Công ty cổ phần". '
      + 'A brand that is not part of the registered name may not match. '
      + 'The result says whether one company is clearly the one meant; if it is, call fin_report with it without asking the user. '
      + 'You do not need it when the user already gave a stock code.',
    parameters: {
      query: { type: 'string', required: true, description: 'A company name or part of one, for example "Hòa Phát" or "Sữa Việt Nam", or a stock code.' },
    },
    output: {
      schema: FIND_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '' || query.length > 100) throw new Error('query must be 1 to 100 characters')
      const { companies, sourceUrl } = await listCompanies(config, exec.signal)
      const result = searchCompanies(companies, query, config.maxMatches)
      return { query, confident: result.confident, matches: result.matches, text: renderMatches(query, result, sourceUrl) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fin_report',
    description: 'Analyze the financial statements of one listed Vietnamese non-financial company (for example FPT, VNM, HPG) and write an HTML report. '
      + 'It reads annual and quarterly statements, the last price and the industry peers from VNDirect, computes gross, operating and net margin, ROE, P/E and debt to equity from the raw lines, '
      + 'compares them with the peer median, flags anomalies with the numbers behind them, and saves charts, tables, formulas and the URL of every source to fin-report-<TICKER>.html in the working directory. '
      + 'Call present on that file afterwards, unless the result says the file was not written. It states data and deviations only: it gives no rating, target price or buy/sell/hold view, and you must not add one. '
      + 'Banks, securities firms and insurers are not supported. Data is unofficial and may lag the published statements.',
    parameters: {
      ticker: { type: 'string', required: true, description: 'Stock code such as FPT, VNM or HPG.' },
      peers: { type: 'array', items: { type: 'string' }, description: 'Peer stock codes to compare with. Omit to use the largest companies in the same industry classification.' },
      years: { type: 'integer', description: `Fiscal years in the annual table and charts, 1 to ${config.maxYears}. Default ${config.defaultYears}.` },
      max_peers: { type: 'integer', description: `Peers to compare, 0 to ${config.maxPeersLimit}. Default ${config.maxPeers}. 0 skips the peer comparison.` },
    },
    output: {
      schema: OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('fin_report requires an agent Session with a working directory')
      const ticker = normalizeTicker(args.ticker)
      const analysis = await analyze(config, { ticker, peers: args.peers, years: args.years, maxPeers: args.max_peers }, exec.signal)
      const { file, reason } = await writeReport(ctx, sandboxPolicy, exec, ticker, renderReport(analysis))
      return { ticker, file, text: renderText(analysis, file, reason) }
    },
  }))
}
