/**
 * Chat client for an OpenAI-compatible endpoint, with a concurrency limit per
 * model, a timeout per request, and retries for connection and gateway errors.
 *
 * The endpoint sits behind a gateway that cuts requests at 60 seconds, so the
 * default request timeout stays below that.
 *
 * @module dsh-doc-translator/llm
 */

/** Error from the endpoint; `retryable` marks connection, timeout and gateway failures. */
export class LlmError extends Error {
  constructor(message, { status = null, retryable = false, cause } = {}) {
    super(message, { cause })
    this.name = 'LlmError'
    this.status = status
    this.retryable = retryable
  }
}

/** Runs at most `limit` async functions at once; the rest wait in arrival order. */
export class Semaphore {
  constructor(limit) {
    this.limit = limit
    this.active = 0
    this.waiting = []
  }

  async run(fn, signal) {
    if (this.active >= this.limit) {
      await new Promise((resolve, reject) => {
        const entry = { resolve }
        this.waiting.push(entry)
        signal?.addEventListener('abort', () => {
          const at = this.waiting.indexOf(entry)
          if (at >= 0) { this.waiting.splice(at, 1); reject(signal.reason) }
        }, { once: true })
      })
    } else this.active++
    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next.resolve()
      else this.active--
    }
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

/**
 * Create a client.
 * @param {{ baseUrl: string, apiKeyEnv?: string, timeoutMs: number, retries: number, retryDelayMs: number, defaultConcurrency: number, concurrency?: Record<string, number> }} config - endpoint settings.
 * @returns {{ chat(request: object): Promise<{ text: string, usage: object, finish: string | null }>, limitFor(model: string): number }} the client.
 */
export function createLlm(config) {
  const semaphores = new Map()
  const limitFor = model => config.concurrency?.[model] ?? config.defaultConcurrency
  const semaphoreFor = (model) => {
    if (!semaphores.has(model)) semaphores.set(model, new Semaphore(limitFor(model)))
    return semaphores.get(model)
  }

  async function once(request, signal) {
    const key = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const messages = []
    if (request.system) messages.push({ role: 'system', content: request.system })
    messages.push({ role: 'user', content: request.user })
    let response
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: combined,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: request.model, messages, max_tokens: request.maxTokens, temperature: request.temperature ?? 0 }),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      const timedOut = timeout.aborted
      throw new LlmError(timedOut ? `request to ${request.model} timed out after ${config.timeoutMs} ms` : `request to ${request.model} failed: ${error.cause?.code ?? error.message}`, { retryable: true, cause: error })
    }
    const text = await response.text()
    if (!response.ok) {
      const gateway = [429, 500, 502, 503, 504].includes(response.status)
      throw new LlmError(`${request.model} returned HTTP ${response.status}: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`, { status: response.status, retryable: gateway })
    }
    let body
    try { body = JSON.parse(text) } catch (error) { throw new LlmError(`${request.model} returned non-JSON: ${text.slice(0, 120)}`, { status: response.status, cause: error }) }
    const choice = body.choices?.[0]
    if (typeof choice?.message?.content !== 'string') throw new LlmError(`${request.model} returned no message: ${text.slice(0, 160)}`, { status: response.status })
    return { text: choice.message.content, usage: body.usage ?? {}, finish: choice.finish_reason ?? null }
  }

  return {
    limitFor,
    /**
     * Send one chat request.
     * @param {{ model: string, system?: string, user: string, maxTokens?: number, temperature?: number, signal?: AbortSignal }} request - the request.
     * @returns {Promise<{ text: string, usage: object, finish: string | null }>} the reply text and token usage.
     */
    async chat(request) {
      return await semaphoreFor(request.model).run(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await once(request, request.signal)
          } catch (error) {
            if (request.signal?.aborted || !(error instanceof LlmError) || !error.retryable || attempt >= config.retries) throw error
            await sleep(config.retryDelayMs * (attempt + 1), request.signal)
          }
        }
      }, request.signal)
    },
  }
}
