import assert from 'node:assert/strict'
import { afterEach, test, mock } from 'node:test'
import { buildUrls, fetchIndicator, parseSeries, resolveIndicator } from '../indicator.js'

const config = {
  baseUrl: 'https://api.worldbank.org/v2',
  siteUrl: 'https://data.worldbank.org',
  defaultCountry: 'VN',
  defaultYears: 10,
  maxYears: 30,
  retries: 2,
  retryDelayMs: 0,
}

/** A response body shaped like the World Bank API: newest year first. */
const BODY = [
  { page: 1, pages: 1, per_page: 50, total: 2, lastupdated: '2026-10-08' },
  [
    { indicator: { id: 'NY.GDP.MKTP.KD.ZG', value: 'GDP growth (annual %)' }, date: '2025', value: 8.01882998978245 },
    { indicator: { id: 'NY.GDP.MKTP.KD.ZG', value: 'GDP growth (annual %)' }, date: '2024', value: 7.03955197123018 },
  ],
]

const ERROR_BODY = [{ message: [{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' }] }]

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const signal = () => new AbortController().signal

afterEach(() => mock.restoreAll())

test('resolveIndicator accepts aliases and codes and rejects anything else', () => {
  assert.equal(resolveIndicator('gdp_growth'), 'NY.GDP.MKTP.KD.ZG')
  assert.equal(resolveIndicator(' SP.POP.TOTL '), 'SP.POP.TOTL')
  assert.throws(() => resolveIndicator('gdp growth'), /unknown indicator "gdp growth"/)
  assert.throws(() => resolveIndicator('constructor'), /unknown indicator/)
  assert.throws(() => resolveIndicator(''), /indicator is required/)
})

test('buildUrls asks for the most recent non-empty values and builds a citation URL', () => {
  const { apiUrl, sourceUrl } = buildUrls(config, 'VN', 'NY.GDP.MKTP.KD.ZG', 5)
  assert.equal(apiUrl, 'https://api.worldbank.org/v2/country/VN/indicator/NY.GDP.MKTP.KD.ZG?format=json&mrnev=5')
  assert.equal(sourceUrl, 'https://data.worldbank.org/indicator/NY.GDP.MKTP.KD.ZG?locations=VN')
})

test('parseSeries sorts ascending and keeps the update date', () => {
  const parsed = parseSeries(BODY, 'test')
  assert.deepEqual(parsed.series.map(p => p.year), [2024, 2025])
  assert.equal(parsed.lastUpdated, '2026-10-08')
  assert.equal(parsed.indicatorName, 'GDP growth (annual %)')
})

test('parseSeries keeps null values as null instead of inventing a number', () => {
  const body = [BODY[0], [{ indicator: { value: 'x' }, date: '2023', value: null }]]
  assert.equal(parseSeries(body, 'test').series[0].value, null)
})

test('parseSeries reports API errors, empty data, and unexpected shapes by name', () => {
  assert.throws(() => parseSeries(ERROR_BODY, 'NOPE for VN'), /rejected NOPE for VN: The provided parameter value is not valid/)
  assert.throws(() => parseSeries([BODY[0], null], 'X for VN'), /no data for X for VN/)
  assert.throws(() => parseSeries([BODY[0], []], 'X for VN'), /no data for X for VN/)
  assert.throws(() => parseSeries({ not: 'an array' }, 'X for VN'), /unexpected response/)
})

test('fetchIndicator returns the series with citation fields', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => json(BODY))
  const result = await fetchIndicator(config, { indicator: 'gdp_growth', country: 'vn', years: 2 }, signal())
  assert.equal(result.country, 'VN')
  assert.equal(result.indicator.code, 'NY.GDP.MKTP.KD.ZG')
  assert.equal(result.latestYear, 2025)
  assert.equal(result.lastUpdated, '2026-10-08')
  assert.equal(result.sourceUrl, 'https://data.worldbank.org/indicator/NY.GDP.MKTP.KD.ZG?locations=VN')
  assert.match(String(fetchMock.mock.calls[0].arguments[0]), /mrnev=2/)
})

test('fetchIndicator uses the configured default country and years', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => json(BODY))
  await fetchIndicator({ ...config, defaultCountry: 'TH', defaultYears: 7 }, { indicator: 'inflation' }, signal())
  assert.match(String(fetchMock.mock.calls[0].arguments[0]), /country\/TH\/.*mrnev=7/)
})

test('fetchIndicator retries a connection failure and then succeeds', async () => {
  let calls = 0
  mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls < 3) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    return json(BODY)
  })
  const result = await fetchIndicator(config, { indicator: 'gdp_growth' }, signal())
  assert.equal(calls, 3)
  assert.equal(result.latestYear, 2025)
})

test('fetchIndicator gives up after the configured retries and names the cause', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) })
  await assert.rejects(fetchIndicator(config, { indicator: 'gdp_growth' }, signal()), /failed after 3 attempt\(s\): ENOTFOUND/)
  assert.equal(fetchMock.mock.callCount(), 3)
})

test('fetchIndicator does not retry an HTTP error response', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('server broke', { status: 503 }))
  await assert.rejects(fetchIndicator(config, { indicator: 'gdp_growth' }, signal()), /HTTP 503: server broke/)
  assert.equal(fetchMock.mock.callCount(), 1)
})

test('fetchIndicator reports non-JSON and API-level errors', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('<html>nope</html>', { status: 200 }))
  await assert.rejects(fetchIndicator(config, { indicator: 'gdp_growth' }, signal()), /non-JSON/)
  mock.restoreAll()
  mock.method(globalThis, 'fetch', async () => json(ERROR_BODY))
  await assert.rejects(fetchIndicator(config, { indicator: 'NOPE.NOPE', country: 'VN' }, signal()), /rejected NOPE.NOPE for VN/)
})

test('fetchIndicator rejects bad arguments before any request', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => json(BODY))
  await assert.rejects(fetchIndicator(config, { indicator: 'gdp_growth', country: 'Viet Nam' }, signal()), /2 or 3 letter ISO code/)
  await assert.rejects(fetchIndicator(config, { indicator: 'gdp_growth', years: 0 }, signal()), /years must be an integer from 1 to 30/)
  await assert.rejects(fetchIndicator(config, { indicator: 'gdp_growth', years: 31 }, signal()), /years must be an integer from 1 to 30/)
  await assert.rejects(fetchIndicator(config, { indicator: 'bogus' }, signal()), /unknown indicator/)
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('fetchIndicator stops retrying when the call is cancelled', async () => {
  const controller = new AbortController()
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    controller.abort(new Error('cancelled'))
    throw new TypeError('fetch failed')
  })
  await assert.rejects(fetchIndicator(config, { indicator: 'gdp_growth' }, controller.signal), /fetch failed/)
  assert.equal(fetchMock.mock.callCount(), 1)
})
