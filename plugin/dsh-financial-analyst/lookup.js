/**
 * Company lookup behind `fin_find_company`: resolves a stock code or a company
 * name to listed tickers using the VNDirect list of listed companies.
 *
 * Names are matched on the registered company name and short name, ignoring
 * accents and legal-form prefixes. A brand that is not part of the registered
 * name (for example "Vinamilk" for "Sữa Việt Nam") does not match.
 *
 * @module dsh-financial-analyst/lookup
 */

import { finfoUrl, getJson } from './data.js'

const FLOOR_ORDER = { HOSE: 0, HNX: 1, UPCOM: 2 }

/** Lower-case, accent-free text with single spaces; `đ` becomes `d`. */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Legal-form words at the start of a registered name, removed before comparing names. */
const LEGAL_PREFIX = /^(?:(?:tong )?cong ty(?: co phan| tnhh| trach nhiem huu han)?|ctcp|tap doan|ngan hang thuong mai co phan)\s+/

/** Fold a name and drop leading legal-form words. */
export function coreName(text) {
  let name = fold(text)
  for (let guard = 0; guard < 3 && LEGAL_PREFIX.test(name); guard++) name = name.replace(LEGAL_PREFIX, '')
  return name
}

/**
 * Score one company against a query; 0 means no match.
 * 100 the query is the stock code; 90 the query equals the short name or the core of the registered name;
 * 60 the query appears as a phrase in the names; 50 every query word appears in the names.
 */
export function scoreCompany(company, query) {
  const code = String(company.code).toLowerCase()
  const q = fold(query)
  if (q === '') return 0
  if (q === code) return 100
  const registered = coreName(company.companyName)
  const short = coreName(company.shortName ?? '')
  if (q === registered || (short !== '' && q === short)) return 90
  const haystack = ` ${fold(company.companyName)} ${fold(company.shortName ?? '')} `
  if (haystack.includes(` ${q} `)) return 60
  const words = q.split(' ')
  return words.every(word => haystack.includes(` ${word} `)) ? 50 : 0
}

/**
 * Rank listed companies for a query.
 * @param {Array<{ code: string, companyName: string, shortName?: string, floor?: string }>} companies - listed companies.
 * @param {string} query - a stock code or part of a company name.
 * @param {number} limit - most matches to return.
 * @returns {{ matches: object[], confident: boolean }} best matches first; `confident` is true when one match is clearly the company meant: the only match, or the only match that is an exact code or exact name.
 */
export function searchCompanies(companies, query, limit) {
  const scored = []
  for (const company of companies) {
    const score = scoreCompany(company, query)
    if (score > 0) scored.push({ ticker: company.code, name: String(company.companyName).trim(), shortName: company.shortName?.trim() ?? null, floor: company.floor ?? null, score })
  }
  scored.sort((a, b) => b.score - a.score || (FLOOR_ORDER[a.floor] ?? 3) - (FLOOR_ORDER[b.floor] ?? 3) || a.ticker.localeCompare(b.ticker))
  const exact = scored.filter(match => match.score >= 90)
  return { matches: scored.slice(0, limit), confident: scored.length === 1 || exact.length === 1, total: scored.length }
}

/**
 * Read every listed company in one request.
 * @param {object} config - plugin config (`baseUrl`, `retries`, `retryDelayMs`, `userAgent`).
 * @param {AbortSignal} signal - cancellation signal.
 * @returns {Promise<{ companies: object[], sourceUrl: string }>} the listed companies and the URL read.
 */
export async function listCompanies(config, signal) {
  const url = finfoUrl(config, 'stocks', 'type:STOCK~status:listed', { size: 5000, fields: 'code,companyName,shortName,floor' })
  const body = await getJson(config, url, signal)
  return { companies: body.data, sourceUrl: url }
}
