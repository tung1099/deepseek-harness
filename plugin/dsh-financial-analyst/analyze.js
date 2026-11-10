/**
 * Orchestration behind `fin_report` and `fin_peers`: read the target and its
 * peers, compute ratios, compare, and screen for anomalies.
 *
 * @module dsh-financial-analyst/analyze
 */

import { detectAnomalies, PEER_METRICS } from './anomalies.js'
import { fetchCompany, finfoUrl, normalizeTicker } from './data.js'
import { buildAnnual, buildTtm, median, valuation } from './metrics.js'

/** Run `fn` over `items` with at most `limit` calls in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Read JSON from a finfo path; used for the two market-cap lookups. */
async function readRows(config, path, query, extra, signal) {
  const url = finfoUrl(config, path, query, extra)
  const response = await fetch(url, { signal, headers: { accept: 'application/json', 'user-agent': config.userAgent } })
  if (!response.ok) throw new Error(`VNDirect returned HTTP ${response.status} for ${path}`)
  const body = await response.json()
  return { rows: Array.isArray(body.data) ? body.data : [], url }
}

/**
 * Industry pools to draw peers from, narrowest first.
 * @param {{ ticker: string, industries: object[] }} target - raw target data.
 * @param {{ peerIndustryLevel: number }} config - the narrowest level to start from.
 * @returns {Array<{ level: number, code: string, name: string, tickers: string[] }>} industries at or above `peerIndustryLevel` that list at least one other company; a pool with the same members as a narrower one is dropped.
 */
export function industryPools(target, config) {
  const pools = []
  const seen = new Set()
  for (const industry of [...target.industries].sort((a, b) => b.level - a.level)) {
    if (industry.level > config.peerIndustryLevel) continue
    const tickers = industry.tickers.filter(code => code !== target.ticker)
    const key = tickers.join(',')
    if (tickers.length === 0 || seen.has(key)) continue
    seen.add(key)
    pools.push({ level: industry.level, code: industry.code, name: industry.name, tickers })
  }
  return pools
}

/** Order candidates by market cap on `date`, largest first; throws when the lookup fails so the caller can say so. */
async function rankByMarketCap(config, candidates, date, signal) {
  const list = candidates.join(',')
  const [prices, shares] = await Promise.all([
    readRows(config, 'stock_prices', `code:${list}~date:${date}`, { size: candidates.length, fields: 'code,close' }, signal),
    readRows(config, 'ratios', `code:${list}~ratioCode:OUTSTANDING_SHARES`, { sort: 'reportDate:desc', size: candidates.length * 3, fields: 'code,value' }, signal),
  ])
  const close = new Map(prices.rows.map(row => [row.code, row.close * 1000]))
  const count = new Map()
  for (const row of shares.rows) if (!count.has(row.code)) count.set(row.code, row.value)
  const cap = code => (close.get(code) ?? 0) * (count.get(code) ?? 0)
  return { ordered: [...candidates].sort((a, b) => cap(b) - cap(a)), sources: [{ label: 'Giá đóng cửa các công ty cùng ngành', url: prices.url }, { label: 'Số cổ phiếu các công ty cùng ngành', url: shares.url }] }
}

/** Compute the views of one company from fetched data; throws when its statements cannot support the ratios. */
function computeCompany(config, raw, years, now) {
  const ttm = buildTtm(raw.quarterly)
  if (!ttm.ok) {
    const empty = raw.quarterly.income.size === 0 && raw.annual.income.size === 0
    throw new Error(empty
      ? `${raw.ticker} has no recent statements in the non-financial model (a bank, securities firm or insurer, or a company that stopped reporting)`
      : `${raw.ticker}: ${ttm.reason}`)
  }
  const ageDays = (now.getTime() - Date.parse(ttm.view.period.to)) / 86_400_000
  if (ageDays > config.maxStatementAgeDays) {
    throw new Error(`${raw.ticker}: latest quarterly statement is dated ${ttm.view.period.to}, ${Math.round(ageDays)} days old (limit ${config.maxStatementAgeDays})`)
  }
  return {
    ticker: raw.ticker,
    name: raw.profile.name,
    floor: raw.profile.floor,
    price: raw.price,
    shares: raw.shares,
    ttm,
    annual: years > 0 ? buildAnnual(raw.annual, years) : [],
    valuation: valuation(raw.price?.close ?? null, raw.shares, ttm.view.metrics.netProfit),
  }
}

/** One comparison row from a computed company. */
export function comparisonRow(company) {
  const m = company.ttm.view.metrics
  return {
    ticker: company.ticker,
    name: company.name,
    marketCap: company.valuation.marketCap,
    pe: company.valuation.pe,
    roe: m.roe,
    grossMargin: m.grossMargin,
    operatingMargin: m.operatingMargin,
    netMargin: m.netMargin,
    liabilitiesToEquity: m.liabilitiesToEquity,
    debtToEquity: m.debtToEquity,
  }
}

/**
 * Full analysis of one ticker against its peers.
 * @param {object} config - plugin config.
 * @param {{ ticker: string, peers?: string[], years?: number, maxPeers?: number }} args - tool arguments.
 * @param {AbortSignal} signal - cancellation signal.
 * @param {Date} [now] - clock used for date filters and the report timestamp.
 * @returns {Promise<object>} the target, peers, medians, flags, notes and every URL read.
 */
export async function analyze(config, args, signal, now = new Date()) {
  const ticker = normalizeTicker(args.ticker)
  const years = args.years ?? config.defaultYears
  if (!Number.isInteger(years) || years < 1 || years > config.maxYears) throw new Error(`years must be an integer from 1 to ${config.maxYears}`)
  const maxPeers = args.maxPeers ?? config.maxPeers
  if (!Number.isInteger(maxPeers) || maxPeers < 0 || maxPeers > config.maxPeersLimit) throw new Error(`maxPeers must be an integer from 0 to ${config.maxPeersLimit}`)

  const notes = []
  const sources = []
  const rawTarget = await fetchCompany(config, ticker, { annual: true, annualYears: years, now }, signal)
  sources.push(...rawTarget.sources)
  const target = computeCompany(config, rawTarget, years, now)

  const skippedPeers = []
  const peers = []
  const loadPeers = async (codes, industry) => {
    const results = await mapLimit(codes, config.concurrency, async (code) => {
      try {
        const raw = await fetchCompany(config, code, { annual: false, annualYears: 0, now }, signal)
        return { company: { ...computeCompany(config, raw, 0, now), industry }, sources: raw.sources }
      } catch (error) {
        if (signal.aborted) throw error
        skippedPeers.push({ ticker: code, reason: error.message })
        return null
      }
    })
    for (const entry of results) {
      if (entry === null) continue
      peers.push(entry.company)
      sources.push(...entry.sources)
    }
  }

  let industry = null
  if (args.peers !== undefined) {
    const codes = [...new Set(args.peers.map(normalizeTicker))].filter(code => code !== ticker).slice(0, maxPeers)
    if (codes.length === 0 && maxPeers > 0) throw new Error('peers must list at least one ticker other than the target')
    notes.push('Nhóm so sánh do người dùng chỉ định, không lấy từ phân ngành.')
    await loadPeers(codes, null)
  } else if (maxPeers > 0) {
    const tried = new Set()
    for (const pool of industryPools(rawTarget, config)) {
      const fresh = pool.tickers.filter(code => !tried.has(code))
      if (fresh.length === 0) continue
      industry ??= { level: pool.level, code: pool.code, name: pool.name }
      let ordered = fresh
      if (fresh.length > maxPeers - peers.length) {
        try {
          const ranked = await rankByMarketCap(config, fresh, rawTarget.price?.date ?? now.toISOString().slice(0, 10), signal)
          ordered = ranked.ordered
          sources.push(...ranked.sources)
        } catch (error) {
          notes.push(`Không xếp hạng được các công ty ngành ${pool.name} theo vốn hóa (${error.message}); lấy theo thứ tự trong danh sách phân ngành.`)
        }
      }
      // Load only what is still needed; a skipped company is replaced by the next candidate.
      let cursor = 0
      while (peers.length < maxPeers && cursor < ordered.length) {
        const chunk = ordered.slice(cursor, cursor + (maxPeers - peers.length))
        cursor += chunk.length
        for (const code of chunk) tried.add(code)
        await loadPeers(chunk, { level: pool.level, name: pool.name })
      }
      if (peers.length >= config.minPeers) break
      notes.push(`Ngành bậc ${pool.level} (${pool.name}) chỉ có ${peers.length} công ty dùng được, ít hơn ${config.minPeers}; đã mở rộng sang bậc ngành rộng hơn.`)
    }
    if (peers.length > 0) notes.push(`Nhóm so sánh là các công ty có vốn hóa lớn nhất (theo ngày giao dịch gần nhất) trong phân ngành và có báo cáo dùng được, tối đa ${maxPeers} công ty.`)
    else notes.push('Không tìm thấy công ty cùng ngành nào có báo cáo dùng được nên không có phần so sánh.')
  }
  if (skippedPeers.length > 0) notes.push(`${skippedPeers.length} công ty trong phân ngành bị bỏ qua vì không có báo cáo dùng được.`)
  if (peers.length > 0 && peers.length < config.minPeers) notes.push(`Chỉ có ${peers.length} công ty để so sánh, ít hơn ${config.minPeers} nên không đưa cờ lệch so với ngành.`)
  if (target.ttm.view.averageEquityNote) notes.push(target.ttm.view.averageEquityNote)

  const rows = [comparisonRow(target), ...peers.map(comparisonRow)]
  const peerRows = rows.slice(1)
  const peerMedian = {}
  for (const metric of PEER_METRICS) peerMedian[metric.key] = median(peerRows.map(row => row[metric.key]))
  peerMedian.debtToEquity = median(peerRows.map(row => row.debtToEquity))

  const narrowest = [...rawTarget.industries].sort((a, b) => b.level - a.level)[0]
  const seen = new Set()
  return {
    ticker,
    fetchedAt: now.toISOString(),
    target,
    targetSources: rawTarget.sources,
    industry,
    targetIndustry: narrowest ? { level: narrowest.level, code: narrowest.code, name: narrowest.name } : null,
    peers,
    skippedPeers,
    rows,
    peerMedian,
    anomalies: detectAnomalies(target, peers, config),
    notes,
    sources: sources.filter(source => !seen.has(source.url) && seen.add(source.url)),
  }
}
