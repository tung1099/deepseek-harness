/**
 * Pure helpers for the `fin_report` tool: configuration checks and the
 * plain-text digest returned to the model.
 *
 * @module dsh-financial-analyst/summary
 */

/**
 * Check settings that must stay ordered; throws naming the offending pair.
 * @param {object} config - tool settings (see `Config` in tools.js).
 */
export function validate(config) {
  if (config.taxRateMinPct >= config.taxRateMaxPct) {
    throw new Error(`financial-analyst-tools: taxRateMinPct (${config.taxRateMinPct}) must be below taxRateMaxPct (${config.taxRateMaxPct})`)
  }
  if (config.maxPeers > config.maxPeersLimit) {
    throw new Error(`financial-analyst-tools: maxPeers (${config.maxPeers}) must not exceed maxPeersLimit (${config.maxPeersLimit})`)
  }
  if (config.defaultYears > config.maxYears) {
    throw new Error(`financial-analyst-tools: defaultYears (${config.defaultYears}) must not exceed maxYears (${config.maxYears})`)
  }
}

const n = (value, digits = 2) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a')
const bn = value => (typeof value === 'number' ? (value / 1e9).toFixed(0) : 'n/a')

/**
 * Plain-text digest of an analysis: figures, flags, notes and the target's source URLs.
 * It ends with a reminder not to recommend; it contains no rating or target price.
 * @param {object} analysis - result of `analyze()`.
 * @param {string | null} file - path of the written report, or `null` when it could not be written.
 * @param {string | null} [reason] - why the report was not written.
 * @returns {string} the text the model reads.
 */
export function renderText(analysis, file, reason = null) {
  const { target, rows, peerMedian, anomalies, notes, skippedPeers, sources } = analysis
  const view = target.ttm.view
  const m = view.metrics
  const lines = [
    `${target.ticker} - ${target.name} (${target.floor}). Industry: ${analysis.targetIndustry?.name ?? 'unknown'}.`,
    `Last close ${n(target.price?.close ?? null, 0)} VND on ${target.price?.date ?? 'unknown date'}; TTM ${view.period.from} to ${view.period.to}.`,
    file === null
      ? `Report file NOT written: ${reason}. Do not call present. Tell the user the HTML report could not be saved and give the figures below in your answer.`
      : `Report file: ${file}`,
    '',
    'TTM ratios (company vs peer median):',
    `- P/E: ${n(target.valuation.pe)} vs ${n(peerMedian.pe)}${target.valuation.note ? ` (${target.valuation.note})` : ''}`,
    `- ROE %: ${n(m.roe)} vs ${n(peerMedian.roe)}`,
    `- Gross margin %: ${n(m.grossMargin)} vs ${n(peerMedian.grossMargin)}`,
    `- Operating margin %: ${n(m.operatingMargin)} vs ${n(peerMedian.operatingMargin)}`,
    `- Net margin %: ${n(m.netMargin)} vs ${n(peerMedian.netMargin)}`,
    `- Liabilities / equity: ${n(m.liabilitiesToEquity)} vs ${n(peerMedian.liabilitiesToEquity)}`,
    `- Interest-bearing debt / equity: ${n(m.debtToEquity)} vs ${n(peerMedian.debtToEquity)}`,
    `- TTM revenue growth %: ${n(view.revenueGrowth)}; TTM net profit growth %: ${n(view.profitGrowth)}`,
    `(peer median over ${analysis.peers.length} companies)`,
    '',
    'Annual (VND billions; margins and ROE in %):',
    'year | revenue | net profit | gross | operating | net | ROE | liab/equity | debt/equity | CFO/profit',
  ]
  for (const a of target.annual) {
    lines.push(`${a.year} | ${bn(a.revenue)} | ${bn(a.netProfit)} | ${n(a.grossMargin, 1)} | ${n(a.operatingMargin, 1)} | ${n(a.netMargin, 1)} | ${n(a.roe, 1)} | ${n(a.liabilitiesToEquity)} | ${n(a.debtToEquity)} | ${n(a.cashConversion)}`)
  }
  lines.push('', 'Peers (TTM):', 'ticker | market cap (VND bn) | P/E | ROE % | gross % | operating % | net % | liab/equity | debt/equity')
  for (const r of rows) {
    lines.push(`${r.ticker} | ${bn(r.marketCap)} | ${n(r.pe)} | ${n(r.roe, 1)} | ${n(r.grossMargin, 1)} | ${n(r.operatingMargin, 1)} | ${n(r.netMargin, 1)} | ${n(r.liabilitiesToEquity)} | ${n(r.debtToEquity)}`)
  }
  lines.push('', anomalies.length === 0 ? 'Anomaly flags: none above the configured thresholds.' : 'Anomaly flags (deviations to read in the notes, not conclusions):')
  for (const a of anomalies) lines.push(`- [${a.id}] ${a.detail} (${a.period})`)
  if (skippedPeers.length > 0) lines.push('', `Skipped peer candidates: ${skippedPeers.map(s => `${s.ticker} (${s.reason})`).join('; ')}`)
  for (const note of notes) lines.push(`Note: ${note}`)
  lines.push('', `Sources for ${target.ticker} (${sources.length} URLs in total, all listed in the report):`)
  for (const s of analysis.targetSources) lines.push(`- ${s.label}: ${s.url}`)
  lines.push('', 'Reminder: state these figures and deviations only. Do not recommend buying, selling or holding, and do not give a target price.')
  return lines.join('\n')
}

const KIND = score => (score >= 100 ? 'stock code' : (score >= 90 ? 'company name' : 'partial name'))

/**
 * Plain-text result of a company lookup, ending with the next step for the model.
 * @param {string} query - the text searched.
 * @param {{ matches: object[], confident: boolean, total: number }} result - output of `searchCompanies`.
 * @param {string} sourceUrl - the list URL that was read.
 * @returns {string} the text the model reads.
 */
export function renderMatches(query, result, sourceUrl) {
  const { matches, confident, total } = result
  const lines = [`Listed companies matching "${query}" (${sourceUrl}):`]
  if (matches.length === 0) {
    lines.push('None. Ask the user for the stock code or the registered company name; a brand name can differ from the registered name.')
    return lines.join('\n')
  }
  matches.forEach((m, i) => lines.push(`${i + 1}. ${m.ticker} - ${m.name}${m.shortName ? ` (${m.shortName})` : ''}, ${m.floor ?? 'unknown floor'} [${KIND(m.score)}]`))
  if (total > matches.length) lines.push(`${total - matches.length} more match(es) not shown.`)
  lines.push(confident
    ? `Confident: yes. ${matches[0].ticker} is the only exact match. Use it now with fin_report and say in your answer which company you used.`
    : 'Confident: no. Ask the user which company they mean with ask_user_question, offering these matches as options (label the stock code, describe the company name).')
  return lines.join('\n')
}
