import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { LlmError, Semaphore, createLlm } from '../llm.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; delete process.env.TEST_KEY })

const CONFIG = { baseUrl: 'https://llm.test/v1', timeoutMs: 200, retries: 2, retryDelayMs: 1, defaultConcurrency: 2, concurrency: { slow: 1 } }
const reply = (content, extra = {}) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { total_tokens: 7 }, ...extra }), { status: 200 })

test('a chat request carries model, messages, temperature 0 and the key from the named environment variable', async () => {
  let seen
  globalThis.fetch = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return reply('ok') }
  process.env.TEST_KEY = 'sekret'
  const llm = createLlm({ ...CONFIG, apiKeyEnv: 'TEST_KEY' })
  const out = await llm.chat({ model: 'm1', system: 'sys', user: 'hello', maxTokens: 50 })
  assert.deepEqual(out, { text: 'ok', usage: { total_tokens: 7 }, finish: 'stop' })
  assert.equal(seen.url, 'https://llm.test/v1/chat/completions')
  assert.deepEqual(seen.body, { model: 'm1', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }], max_tokens: 50, temperature: 0 })
  assert.equal(seen.init.headers.authorization, 'Bearer sekret')
})

test('without a key variable no authorization header is sent', async () => {
  let headers
  globalThis.fetch = async (_url, init) => { headers = init.headers; return reply('ok') }
  await createLlm(CONFIG).chat({ model: 'm', user: 'x' })
  assert.equal(headers.authorization, undefined)
})

test('gateway errors and dropped connections are retried; other 4xx are not', async () => {
  const statuses = [504, 502]
  let calls = 0
  globalThis.fetch = async () => { calls++; const s = statuses.shift(); return s ? new Response('<html>Gateway</html>', { status: s }) : reply('fine') }
  assert.equal((await createLlm(CONFIG).chat({ model: 'm', user: 'x' })).text, 'fine')
  assert.equal(calls, 3)

  calls = 0
  globalThis.fetch = async () => { calls++; return new Response('{"error":"bad"}', { status: 400 }) }
  await assert.rejects(createLlm(CONFIG).chat({ model: 'm', user: 'x' }), (e) => e instanceof LlmError && e.status === 400 && !e.retryable)
  assert.equal(calls, 1)

  calls = 0
  globalThis.fetch = async () => { calls++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }
  await assert.rejects(createLlm(CONFIG).chat({ model: 'm', user: 'x' }), /failed: ECONNRESET/)
  assert.equal(calls, 3, 'one try plus two retries')
})

/** AbortSignal.timeout does not keep the process alive; a real socket does, a fake fetch does not. */
const keepAlive = () => { const timer = setInterval(() => {}, 20); return () => clearInterval(timer) }

test('a request that outlives the timeout fails as a retryable timeout', async () => {
  const stop = keepAlive()
  globalThis.fetch = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  try {
    await assert.rejects(createLlm({ ...CONFIG, timeoutMs: 20, retries: 0 }).chat({ model: 'm', user: 'x' }), (e) => e instanceof LlmError && e.retryable && /timed out after 20 ms/.test(e.message))
  } finally { stop() }
})

test('cancelling the caller stops the call without a retry', async () => {
  const stop = keepAlive()
  let calls = 0
  globalThis.fetch = (_url, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) }
  const controller = new AbortController()
  const pending = createLlm({ ...CONFIG, timeoutMs: 5000 }).chat({ model: 'm', user: 'x', signal: controller.signal })
  setTimeout(() => controller.abort(new Error('stop')), 10)
  try {
    await assert.rejects(pending, /stop/)
    assert.equal(calls, 1)
  } finally { stop() }
})

test('a 200 reply without a message, or with a body that is not JSON, is an error', async () => {
  globalThis.fetch = async () => new Response('{"choices":[]}', { status: 200 })
  await assert.rejects(createLlm(CONFIG).chat({ model: 'm', user: 'x' }), /returned no message/)
  globalThis.fetch = async () => new Response('oops', { status: 200 })
  await assert.rejects(createLlm(CONFIG).chat({ model: 'm', user: 'x' }), /non-JSON/)
})

test('each model has its own concurrency limit', async () => {
  const active = { slow: 0, fast: 0 }
  const peak = { slow: 0, fast: 0 }
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(init.body).model
    active[model]++; peak[model] = Math.max(peak[model], active[model])
    await new Promise(resolve => setTimeout(resolve, 15))
    active[model]--
    return reply('ok')
  }
  const llm = createLlm({ ...CONFIG, timeoutMs: 5000 })
  await Promise.all([...Array(6).fill('slow'), ...Array(6).fill('fast')].map(model => llm.chat({ model, user: 'x' })))
  assert.equal(peak.slow, 1)
  assert.equal(peak.fast, 2, 'the default limit applies to models without their own')
  assert.equal(llm.limitFor('slow'), 1)
})

test('Semaphore releases waiters in order and a cancelled waiter leaves the queue', async () => {
  const sem = new Semaphore(1)
  const order = []
  let release
  const first = sem.run(() => new Promise(resolve => { release = resolve }))
  const second = sem.run(async () => { order.push('second') })
  const controller = new AbortController()
  const third = sem.run(async () => { order.push('third') }, controller.signal)
  controller.abort(new Error('gone'))
  await assert.rejects(third, /gone/)
  release()
  await first
  await second
  assert.deepEqual(order, ['second'])
  assert.equal(await sem.run(async () => 'free'), 'free')
})
