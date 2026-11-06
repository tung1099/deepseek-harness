/**
 * DeepSeek Harness plugin: a `weather` tool backed by Open-Meteo.
 *
 * The model passes a place name (resolved through the Open-Meteo geocoding
 * API) or coordinates, and receives current conditions plus a daily forecast.
 * Open-Meteo's free endpoints need no API key; a commercial deployment sets
 * `apiKey` together with its customer endpoints.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'weather'
export const inject = ['tools']

export const Config = Schema.object({
  forecastDays: Schema.natural().min(1).max(16).default(3)
    .description('Days of daily forecast returned when the model does not ask for a number.'),
  language: Schema.string().default('en')
    .description('Language of place names returned by geocoding (ISO 639-1, e.g. vi, en).'),
  temperatureUnit: Schema.union(['celsius', 'fahrenheit']).default('celsius'),
  windSpeedUnit: Schema.union(['kmh', 'ms', 'mph', 'kn']).default('kmh'),
  timeoutMs: Schema.natural().min(1).default(15_000)
    .description('Budget for one tool call, geocoding and forecast together, retries included.'),
  retries: Schema.natural().max(5).default(2)
    .description('Extra attempts after a connection failure. HTTP error responses are not retried.'),
  retryDelayMs: Schema.natural().default(500)
    .description('Wait before each retry, multiplied by the attempt number.'),
  forecastUrl: Schema.string().default('https://api.open-meteo.com/v1/forecast'),
  geocodingUrl: Schema.string().default('https://geocoding-api.open-meteo.com/v1/search'),
  apiKey: Schema.string().description('Open-Meteo commercial API key; leave empty for the free API.'),
})

/** Maximum forecast length accepted by the Open-Meteo forecast API. */
const MAX_FORECAST_DAYS = 16

/** WMO weather interpretation codes used by Open-Meteo `weather_code`. */
const WMO_CODES = {
  0: 'clear sky',
  1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  56: 'light freezing drizzle', 57: 'dense freezing drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'heavy freezing rain',
  71: 'slight snowfall', 73: 'moderate snowfall', 75: 'heavy snowfall',
  77: 'snow grains',
  80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
  85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
}

const nullableNumber = { oneOf: [{ type: 'number' }, { type: 'null' }] }

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    place: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        name: { type: 'string', required: true },
        region: { type: 'string' },
        country: { type: 'string' },
        latitude: { type: 'number', required: true },
        longitude: { type: 'number', required: true },
        timezone: { type: 'string', required: true },
      },
    },
    units: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        temperature: { type: 'string', required: true },
        precipitation: { type: 'string', required: true },
        windSpeed: { type: 'string', required: true },
      },
    },
    current: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        time: { type: 'string', required: true },
        temperature: { ...nullableNumber, required: true },
        apparentTemperature: { ...nullableNumber, required: true },
        humidity: { ...nullableNumber, required: true },
        precipitation: { ...nullableNumber, required: true },
        windSpeed: { ...nullableNumber, required: true },
        weather: { type: 'string', required: true },
      },
    },
    daily: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', required: true },
          weather: { type: 'string', required: true },
          temperatureMin: { ...nullableNumber, required: true },
          temperatureMax: { ...nullableNumber, required: true },
          precipitationSum: { ...nullableNumber, required: true },
          precipitationProbabilityMax: { ...nullableNumber, required: true },
        },
      },
    },
  },
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'weather',
    description: 'Get current weather and a daily forecast for a place. Pass `location` (a city or place name, optionally with `country_code`), or pass `latitude` and `longitude`. The result names the place that was matched; if it is the wrong place, call again with `country_code` or coordinates.',
    parameters: {
      location: { type: 'string', description: 'City or place name, e.g. "Hà Nội" or "Tokyo". Use the name only, without country or region.' },
      country_code: { type: 'string', description: 'ISO 3166-1 alpha-2 country code that narrows `location`, e.g. "VN".' },
      latitude: { type: 'number', description: 'Latitude in decimal degrees; use with `longitude` instead of `location`.' },
      longitude: { type: 'number', description: 'Longitude in decimal degrees; use with `latitude` instead of `location`.' },
      days: { type: 'integer', description: `Number of forecast days, 1 to ${MAX_FORECAST_DAYS}. Default ${config.forecastDays}.` },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const days = args.days ?? config.forecastDays
      if (!Number.isInteger(days) || days < 1 || days > MAX_FORECAST_DAYS) {
        throw new Error(`days must be an integer from 1 to ${MAX_FORECAST_DAYS}`)
      }
      const place = await resolvePlace(config, args, exec.signal)
      return await fetchForecast(config, place, days, exec.signal)
    },
  }))
}

/** Use explicit coordinates, or geocode `location` to its best match. */
async function resolvePlace(config, args, signal) {
  const hasLat = args.latitude !== undefined
  const hasLon = args.longitude !== undefined
  if (hasLat !== hasLon) throw new Error('latitude and longitude must be given together')
  if (hasLat) {
    if (Math.abs(args.latitude) > 90 || Math.abs(args.longitude) > 180) {
      throw new Error('latitude must be within ±90 and longitude within ±180')
    }
    return { name: `${args.latitude}, ${args.longitude}`, latitude: args.latitude, longitude: args.longitude }
  }
  const location = args.location?.trim()
  if (!location) throw new Error('pass either location or latitude and longitude')

  const query = { name: location, count: 1, language: config.language, format: 'json' }
  if (args.country_code) query.countryCode = args.country_code.trim().toUpperCase()
  const body = await getJson(config, config.geocodingUrl, query, signal, 'geocoding')
  const match = body.results?.[0]
  if (!match) {
    const scope = query.countryCode ? ` in country ${query.countryCode}` : ''
    throw new Error(`no place named "${location}"${scope}; try another spelling, the name without region or country, or coordinates`)
  }
  return {
    name: match.name,
    region: match.admin1,
    country: match.country,
    latitude: match.latitude,
    longitude: match.longitude,
  }
}

async function fetchForecast(config, place, days, signal) {
  const body = await getJson(config, config.forecastUrl, {
    latitude: place.latitude,
    longitude: place.longitude,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: days,
    temperature_unit: config.temperatureUnit,
    wind_speed_unit: config.windSpeedUnit,
  }, signal, 'forecast')

  const c = body.current
  const d = body.daily
  return {
    place: {
      name: place.name,
      ...(place.region ? { region: place.region } : {}),
      ...(place.country ? { country: place.country } : {}),
      latitude: place.latitude,
      longitude: place.longitude,
      timezone: body.timezone,
    },
    units: {
      temperature: body.current_units.temperature_2m,
      precipitation: body.current_units.precipitation,
      windSpeed: body.current_units.wind_speed_10m,
    },
    current: {
      time: c.time,
      temperature: c.temperature_2m ?? null,
      apparentTemperature: c.apparent_temperature ?? null,
      humidity: c.relative_humidity_2m ?? null,
      precipitation: c.precipitation ?? null,
      windSpeed: c.wind_speed_10m ?? null,
      weather: describe(c.weather_code),
    },
    daily: d.time.map((date, i) => ({
      date,
      weather: describe(d.weather_code[i]),
      temperatureMin: d.temperature_2m_min[i] ?? null,
      temperatureMax: d.temperature_2m_max[i] ?? null,
      precipitationSum: d.precipitation_sum[i] ?? null,
      precipitationProbabilityMax: d.precipitation_probability_max[i] ?? null,
    })),
  }
}

/** GET a JSON endpoint; Open-Meteo reports failures as `{ error: true, reason }`. */
async function getJson(config, baseUrl, query, signal, label) {
  const url = new URL(baseUrl)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
  if (config.apiKey) url.searchParams.set('apikey', config.apiKey)

  let response
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(url, { signal, headers: { accept: 'application/json' } })
      break
    } catch (error) {
      if (signal.aborted) throw error
      if (attempt >= config.retries) {
        throw new Error(`Open-Meteo ${label} request failed after ${attempt + 1} attempt(s): ${networkReason(error)}`, { cause: error })
      }
      await sleep(config.retryDelayMs * (attempt + 1), signal)
    }
  }
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new Error(`Open-Meteo ${label} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`, { cause: error })
  }
  if (!response.ok || body.error) {
    throw new Error(`Open-Meteo ${label} failed (HTTP ${response.status}): ${body.reason ?? 'unknown error'}`)
  }
  return body
}

/** Name the socket failure; undici's `fetch failed` hides it in `cause` (or `cause.errors` per address). */
function networkReason(error) {
  const cause = error.cause
  const parts = cause?.errors?.map((e) => [e.code, e.address].filter(Boolean).join(' '))
    ?? [cause?.code, cause?.message].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : error.message
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

function describe(code) {
  return WMO_CODES[code] ?? `weather code ${code}`
}

/** Compact model-facing text: one line for the place, one for now, one per day. */
function renderReport(value) {
  const { place, units, current, daily } = value
  const where = [place.name, place.region, place.country].filter(Boolean).join(', ')
  const t = (v) => (v === null ? '?' : `${v}${units.temperature}`)
  const lines = [
    `${where} (${place.latitude}, ${place.longitude}), timezone ${place.timezone}`,
    `Now (${current.time} local): ${t(current.temperature)}, feels like ${t(current.apparentTemperature)}, ${current.weather}, humidity ${current.humidity ?? '?'}%, wind ${current.windSpeed ?? '?'} ${units.windSpeed}, precipitation ${current.precipitation ?? '?'} ${units.precipitation}`,
  ]
  for (const day of daily) {
    const chance = day.precipitationProbabilityMax === null ? '' : `, ${day.precipitationProbabilityMax}% chance`
    lines.push(`${day.date}: ${t(day.temperatureMin)} to ${t(day.temperatureMax)}, ${day.weather}, precipitation ${day.precipitationSum ?? '?'} ${units.precipitation}${chance}`)
  }
  return lines.join('\n')
}
