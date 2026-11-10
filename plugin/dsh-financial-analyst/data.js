/**
 * VNDirect finfo reader behind the financial-analyst tools.
 *
 * Reads raw statement lines of non-financial companies (annual and quarterly
 * income statement, balance sheet, cash flow), the last trade price, the
 * outstanding share count and the industry peer list. Every request URL is
 * recorded so the report can cite exactly what was read.
 *
 * @module dsh-financial-analyst/data
 */

/** VNDirect statement line codes, by model: income statement (modelType 2), balance sheet (1), cash flow (3). */
export const IS_ITEMS = {
  sales: 21001,
  gross: 23100,
  operating: 23110,
  pretax: 23800,
  netParent: 23000,
  interest: 22510,
  finIncome: 21500,
  otherIncome: 21900,
  tax: 22070,
}
export const BS_ITEMS = {
  receivables: 11300,
  inventory: 11400,
  totalAssets: 12700,
  liabilities: 13000,
  shortDebt: 13110,
  longDebt: 13340,
  equity: 14000,
  minority: 14240,
}
export const CF_ITEMS = { operating: 32000 }

const MODEL = { balance: 1, income: 2, cashflow: 3 }
const STATEMENT_LABEL = { 1: 'Bảng cân đối kế toán', 2: 'Báo cáo kết quả kinh doanh', 3: 'Báo cáo lưu chuyển tiền tệ' }
const TICKER = /^[A-Z0-9]{2,6}$/

/** Upper-case a ticker or throw naming the accepted form. */
export function normalizeTicker(value) {
  const ticker = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (!TICKER.test(ticker)) throw new Error(`ticker must be 2 to 6 letters or digits such as FPT, got "${value}"`)
  return ticker
}

/** GET a JSON endpoint with retries on connection failure; HTTP error responses are not retried. */
export async function getJson(config, url, signal) {
  let response
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(url, { signal, headers: { accept: 'application/json', 'user-agent': config.userAgent } })
      break
    } catch (error) {
      if (signal.aborted) throw error
      if (attempt >= config.retries) {
        throw new Error(`VNDirect request failed after ${attempt + 1} attempt(s): ${error.cause?.code ?? error.message}`, { cause: error })
      }
      await sleep(config.retryDelayMs * (attempt + 1), signal)
    }
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`VNDirect returned HTTP ${response.status}: ${text.slice(0, 200)}`)
  let body
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new Error(`VNDirect returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`, { cause: error })
  }
  // Errors arrive as `{ code, message }` with HTTP 200 on some paths.
  if (body && !Array.isArray(body.data) && typeof body.message === 'string') throw new Error(`VNDirect rejected the request: ${body.message}`)
  return body
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

/**
 * Build a finfo URL; `query` becomes the `q` filter.
 * Values use only letters, digits and `: ~ , ( ) - _ .`, which are legal in a query string, so the URL stays readable and clickable.
 */
export function finfoUrl(config, path, query, extra = {}) {
  const pairs = [['q', query], ...Object.entries(extra)]
  for (const [key, value] of pairs) {
    if (!/^[A-Za-z0-9:~,()._-]+$/.test(String(value))) throw new Error(`finfo query value for "${key}" has unsupported characters: ${value}`)
  }
  return `${config.baseUrl}/${path}?${pairs.map(([key, value]) => `${key}=${value}`).join('&')}`
}

/** Group statement rows by fiscal date into `{ [name]: value }` objects using the given code map. */
export function pivot(rows, itemMap) {
  const byCode = new Map(Object.entries(itemMap).map(([name, code]) => [code, name]))
  const out = new Map()
  for (const row of rows) {
    const name = byCode.get(Number(row.itemCode))
    if (name === undefined || typeof row.numericValue !== 'number') continue
    const entry = out.get(row.fiscalDate) ?? {}
    entry[name] = row.numericValue
    out.set(row.fiscalDate, entry)
  }
  return out
}

/**
 * Read the raw material for one company.
 * @param {object} config - plugin config (`baseUrl`, `retries`, `retryDelayMs`, `userAgent`).
 * @param {string} ticker - normalized ticker.
 * @param {{ annualYears: number, annual: boolean, now: Date }} options - `annual: false` skips annual statements (peers).
 * @param {AbortSignal} signal - cancellation signal.
 * @returns {Promise<object>} profile, price, shares, statement maps by fiscal date, and the URLs read.
 */
export async function fetchCompany(config, ticker, options, signal) {
  const sources = []
  const read = async (label, path, query, extra) => {
    const url = finfoUrl(config, path, query, extra)
    const body = await getJson(config, url, signal)
    sources.push({ label, url })
    return body.data
  }
  const year = options.now.getUTCFullYear()
  const statements = (model, reportType, itemMap, sinceDate) => read(
    `${STATEMENT_LABEL[model]} ${reportType === 'ANNUAL' ? 'năm' : 'quý'}`,
    'financial_statements',
    `code:${ticker}~reportType:${reportType}~modelType:${model}~itemCode:in:(${Object.values(itemMap).join(',')})~fiscalDate:gte:${sinceDate}`,
    { sort: 'fiscalDate:desc', size: 1000, fields: 'fiscalDate,itemCode,numericValue' },
  )
  const quarterSince = `${year - 3}-01-01`
  const annualSince = `${year - options.annualYears - 2}-01-01`

  const [stock, prices, shareRows, industries, qIS, qBS] = await Promise.all([
    read('Hồ sơ công ty', 'stocks', `code:${ticker}`),
    read('Giá đóng cửa gần nhất', 'stock_prices', `code:${ticker}`, { sort: 'date:desc', size: 1 }),
    read('Số cổ phiếu đang lưu hành', 'ratios', `code:${ticker}~ratioCode:OUTSTANDING_SHARES`, { sort: 'reportDate:desc', size: 1 }),
    read('Phân ngành', 'industry_classification', `codeList:${ticker}`),
    statements(MODEL.income, 'QUARTER', IS_ITEMS, quarterSince),
    statements(MODEL.balance, 'QUARTER', BS_ITEMS, quarterSince),
  ])
  if (stock.length === 0) throw new Error(`${ticker} is not a listed code in VNDirect data`)

  let aIS = []
  let aBS = []
  let aCF = []
  if (options.annual) {
    [aIS, aBS, aCF] = await Promise.all([
      statements(MODEL.income, 'ANNUAL', IS_ITEMS, annualSince),
      statements(MODEL.balance, 'ANNUAL', BS_ITEMS, annualSince),
      statements(MODEL.cashflow, 'ANNUAL', CF_ITEMS, annualSince),
    ])
  }
  const price = prices[0]
  return {
    ticker,
    profile: {
      name: stock[0].companyName,
      shortName: stock[0].shortName,
      floor: stock[0].floor,
      listedDate: stock[0].listedDate,
    },
    // VNDirect quotes prices in thousand VND.
    price: price ? { close: price.close * 1000, date: price.date } : null,
    shares: shareRows[0]?.value ?? null,
    industries: industries.map(row => ({
      level: Number(row.industryLevel),
      code: row.industryCode,
      name: row.vietnameseName,
      tickers: String(row.codeList).split(',').filter(Boolean),
    })),
    quarterly: { income: pivot(qIS, IS_ITEMS), balance: pivot(qBS, BS_ITEMS) },
    annual: { income: pivot(aIS, IS_ITEMS), balance: pivot(aBS, BS_ITEMS), cashflow: pivot(aCF, CF_ITEMS) },
    sources,
  }
}
