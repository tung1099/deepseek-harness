/**
 * World Bank indicator reader behind the `econ_indicator` tool.
 *
 * Calls the World Bank Indicators API v2 (no key needed) and returns the most
 * recent non-empty yearly values together with the citation URLs. The API
 * publishes yearly national data with a lag that differs per indicator, so
 * every result carries its own latest year.
 *
 * @module dsh-market-analyst/indicator
 */

/** Friendly aliases the model may pass instead of a World Bank indicator code. */
export const INDICATOR_ALIASES = {
  gdp_growth: 'NY.GDP.MKTP.KD.ZG',
  inflation: 'FP.CPI.TOTL.ZG',
  gdp_per_capita: 'NY.GDP.PCAP.CD',
  population: 'SP.POP.TOTL',
  urban_share: 'SP.URB.TOTL.IN.ZS',
  lending_rate: 'FR.INR.LEND',
  fx_rate: 'PA.NUS.FCRF',
  unemployment: 'SL.UEM.TOTL.ZS',
  internet_users: 'IT.NET.USER.ZS',
}

const INDICATOR_CODE = /^[A-Z0-9]+(?:\.[A-Z0-9]+)+$/
const COUNTRY_CODE = /^[A-Za-z]{2,3}$/

/** Resolve an alias or a raw World Bank code to a code, or throw naming the accepted values. */
export function resolveIndicator(indicator) {
  if (typeof indicator !== 'string' || indicator.trim() === '') throw new Error('indicator is required')
  const key = indicator.trim()
  if (Object.hasOwn(INDICATOR_ALIASES, key)) return INDICATOR_ALIASES[key]
  if (INDICATOR_CODE.test(key)) return key
  throw new Error(`unknown indicator "${key}"; use an alias (${Object.keys(INDICATOR_ALIASES).join(', ')}) or a World Bank code such as NY.GDP.MKTP.KD.ZG`)
}

/**
 * Build the API request URL and the human-readable citation URL.
 * @param {{ baseUrl: string, siteUrl: string }} config - endpoint settings.
 * @param {string} country - ISO 3166 alpha-2 or alpha-3 country code.
 * @param {string} code - World Bank indicator code.
 * @param {number} years - number of most recent non-empty values to request.
 * @returns {{ apiUrl: string, sourceUrl: string }}
 */
export function buildUrls(config, country, code, years) {
  const apiUrl = new URL(`${config.baseUrl}/country/${country}/indicator/${code}`)
  apiUrl.searchParams.set('format', 'json')
  apiUrl.searchParams.set('mrnev', String(years))
  const sourceUrl = new URL(`${config.siteUrl}/indicator/${code}`)
  sourceUrl.searchParams.set('locations', country)
  return { apiUrl: apiUrl.toString(), sourceUrl: sourceUrl.toString() }
}

/**
 * Turn a World Bank response body into an ascending series.
 * @param {unknown} body - parsed JSON from the Indicators API.
 * @param {string} describe - "<code> for <country>" text used in error messages.
 * @returns {{ indicatorName: string, lastUpdated: string, series: Array<{ year: number, value: number | null }> }}
 */
export function parseSeries(body, describe) {
  // Errors arrive as `[{ message: [{ key, value }] }]` with HTTP 200.
  if (Array.isArray(body) && body[0] && typeof body[0] === 'object' && 'message' in body[0]) {
    const detail = body[0].message?.map(m => m.value).filter(Boolean).join('; ') || 'unknown error'
    throw new Error(`World Bank rejected ${describe}: ${detail}. Check the country code and indicator.`)
  }
  if (!Array.isArray(body) || body.length < 2) throw new Error(`World Bank returned an unexpected response for ${describe}`)
  const [meta, rows] = body
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`World Bank has no data for ${describe}`)
  const series = rows
    .map(row => ({ year: Number(row.date), value: typeof row.value === 'number' ? row.value : null }))
    .sort((a, b) => a.year - b.year)
  return { indicatorName: rows[0].indicator?.value ?? '', lastUpdated: meta.lastupdated ?? '', series }
}

/** GET a JSON endpoint with retries on connection failure; HTTP error responses are not retried. */
async function getJson(config, url, signal) {
  let response
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(url, { signal, headers: { accept: 'application/json' } })
      break
    } catch (error) {
      if (signal.aborted) throw error
      if (attempt >= config.retries) {
        throw new Error(`World Bank request failed after ${attempt + 1} attempt(s): ${error.cause?.code ?? error.message}`, { cause: error })
      }
      await sleep(config.retryDelayMs * (attempt + 1), signal)
    }
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`World Bank returned HTTP ${response.status}: ${text.slice(0, 200)}`)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`World Bank returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`, { cause: error })
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

/**
 * Fetch the most recent yearly values of one indicator for one country.
 * @param {object} config - plugin config (`baseUrl`, `siteUrl`, `defaultCountry`, `defaultYears`, `maxYears`, `retries`, `retryDelayMs`).
 * @param {{ country?: string, indicator: string, years?: number }} args - tool arguments.
 * @param {AbortSignal} signal - cancellation signal for the whole call.
 * @returns {Promise<object>} indicator metadata, ascending series, latest year, and citation URLs.
 */
export async function fetchIndicator(config, args, signal) {
  const country = (args.country ?? config.defaultCountry).trim()
  if (!COUNTRY_CODE.test(country)) throw new Error(`country must be a 2 or 3 letter ISO code, got "${country}"`)
  const years = args.years ?? config.defaultYears
  if (!Number.isInteger(years) || years < 1 || years > config.maxYears) {
    throw new Error(`years must be an integer from 1 to ${config.maxYears}`)
  }
  const code = resolveIndicator(args.indicator)
  const { apiUrl, sourceUrl } = buildUrls(config, country.toUpperCase(), code, years)

  const body = await getJson(config, apiUrl, signal)
  const { indicatorName, lastUpdated, series } = parseSeries(body, `${code} for ${country.toUpperCase()}`)
  return {
    country: country.toUpperCase(),
    indicator: { code, name: indicatorName },
    series,
    latestYear: series.at(-1).year,
    lastUpdated,
    sourceUrl,
    apiUrl,
  }
}
