/**
 * DeepSeek Harness plugin: send each Session turn to LangSmith as one trace.
 *
 *   dsh-turn (chain)          input = what the user typed, injected_context = harness-added messages;
 *   │                         metadata = queue wait, preset, environment, context peak; tags case:/run:
 *   ├─ step N (chain)         output = the tool calls the model made; metadata = agent/pre-step decision,
 *   │                         request/header reason, whether the system prompt was (re)logged
 *   │  ├─ harness (chain)     from step start to the model call: events written, prompt and tool sizes
 *   │  │  ├─ service: tools.resolve / systemPrompt.assemble / llm.prepareCall   (instrumentServices)
 *   │  │  └─ hook: agent/pre-step
 *   │  ├─ <model> (llm)       history, available tool schemas, call parameters, tool_calls, token usage,
 *   │  │                      time to first token, finish reason, stream timings, context window use
 *   │  ├─ <tool> (tool)       parsed arguments, result, error, tool_call_id, queued vs execute time
 *   │  │  └─ hook: tools/pre-execute · execute · hook: tools/post-execute
 *   │  └─ event: … (chain)    persona switch, tool set change, /command, approval, compaction, failed attempt
 *   └─ event: …               events between steps
 *
 * `instrumentServices: true` (debugging only) wraps `ctx.tools.resolve`,
 * `ctx.systemPrompt.assemble` and `ctx.llm.prepareCall` to record what the
 * agent loop asked each service and what it got back. The wrappers call the
 * original method and return its result unchanged; they are removed when the
 * plugin unloads.
 *
 * Commands and other events outside a turn are sent as their own small
 * `dsh-event` trace. Every trace carries `session_id`, so LangSmith groups a
 * conversation into one Thread.
 *
 * The trace is built from durable Session events (`session/event`) and posted
 * when the turn ends, so a crash mid-turn loses that turn's trace.
 */

import { createRequire } from 'node:module'
import { Client, RunTree } from 'langsmith'

export const name = 'langsmith-tracer'
export const inject = ['sessions']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   apiKey?: string, endpoint?: string, project?: string, tags?: string[],
 *   historyMode?: 'full' | 'delta' | 'none', includeToolSchemas?: boolean, instrumentServices?: boolean,
 * }} [config]
 *   `historyMode`: `full` sends the whole model history on every LLM run (default),
 *   `delta` only the messages added since the previous LLM run of the session, `none` nothing.
 */
export function apply(ctx, config = {}) {
  const apiKey = config.apiKey ?? process.env.LANGSMITH_API_KEY
  if (!apiKey) throw new Error('langsmith-tracer: set config.apiKey or LANGSMITH_API_KEY')
  const historyMode = config.historyMode ?? 'full'
  if (!['full', 'delta', 'none'].includes(historyMode)) {
    throw new Error(`langsmith-tracer: historyMode must be full, delta, or none (got ${JSON.stringify(historyMode)})`)
  }
  const includeToolSchemas = config.includeToolSchemas ?? true
  const projectName = config.project ?? process.env.LANGSMITH_PROJECT ?? 'deepseek-harness'
  const baseTags = config.tags ?? ['dsh']
  const instrumentServices = config.instrumentServices === true
  const client = new Client({ apiKey, apiUrl: config.endpoint ?? process.env.LANGSMITH_ENDPOINT })
  const environment = describeEnvironment()

  /** sessionId -> per-session tracing state */
  const sessions = new Map()

  const stateOf = (session) => {
    let state = sessions.get(session.id)
    if (state === undefined) {
      state = {
        turn: null, header: null, context: null, persona: 'default', preset: null, historySent: 0,
        open: new Map(), live: new Map(), preStep: null,
        /** Service calls made before the step they belong to opened (preStep runs before step/start). */
        preService: [],
        /** message id -> time it entered the inbox */
        queued: new Map(),
      }
      sessions.set(session.id, state)
    }
    return state
  }

  // ── Live agent-loop hooks (process-local; observe only) ──────────────────
  // Waterfall listeners must call next() and return its result unchanged, so
  // tracing never alters a decision. Recording failures are swallowed.

  const record = (fn) => { try { fn() } catch (error) { console.warn('[langsmith-tracer] live hook', error) } }
  const liveTool = (exec) => {
    const session = exec.agent?.session
    if (session === undefined) return undefined
    const live = stateOf(session).live
    let entry = live.get(exec.callId)
    if (entry === undefined) { entry = {}; live.set(exec.callId, entry) }
    return entry
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const start = Date.now()
    const decision = await next()
    record(() => {
      stateOf(payload.agent.session).preStep = {
        kind: decision.kind,
        messages: decision.kind === 'enter' ? decision.messages.length : 0,
        claimed: payload.messages.length,
        ...(decision.startsRequestSeries ? { startsRequestSeries: true } : {}),
        start,
        end: Date.now(),
      }
    })
    return decision
  })

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    record(() => stateOf(agent.session).queued.set(message.id, Date.now()))
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    record(() => {
      const state = stateOf(agent.session)
      const at = state.queued.get(message.id)
      state.queued.delete(message.id)
      if (at === undefined || state.turn?.turn !== turn) return
      state.turn.queueWaitMs = Math.max(state.turn.queueWaitMs ?? 0, Date.now() - at)
    })
  })

  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    record(() => {
      const state = stateOf(agent.session)
      state.queued.delete(message.id)
      addEvent(state, { name: 'queued message discarded', time: Date.now(), end: Date.now(), inputs: { text: textOf(message.content).slice(0, 200) } })
    })
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const start = Date.now()
    const decision = await next()
    record(() => {
      const entry = liveTool(exec)
      if (entry) entry.pre = { kind: decision.kind, ...(decision.reason ? { reason: decision.reason } : {}), start, end: Date.now() }
    })
    return decision
  })

  ctx.on('tools/execute', async (exec, next) => {
    const start = Date.now()
    const result = await next()
    record(() => {
      const entry = liveTool(exec)
      if (entry) entry.dispatch = { start, end: Date.now(), isError: result.isError === true }
    })
    return result
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const start = Date.now()
    const decision = await next()
    record(() => {
      const entry = liveTool(exec)
      if (entry) entry.post = { kind: decision.kind, additionalContexts: decision.additionalContexts?.length ?? 0, start, end: Date.now() }
    })
    return decision
  })

  // ── Service instrumentation (debugging only) ────────────────────────────

  if (instrumentServices) {
    ctx.inject(['tools', 'systemPrompt', 'llm'], (inner) => {
      inner.effect(() => {
        const restore = [
          wrapMethod(inner.tools, 'resolve', (args, result, start, end, error) => {
            const agent = args[0]?.agent
            const names = result ? [...result.view(agent).keys()] : []
            recordService(agent, { name: 'tools.resolve', start, end, error,
              inputs: { model: args[0]?.modelSelection?.model },
              outputs: { tools: names.length, names } })
          }),
          wrapMethod(inner.systemPrompt, 'assemble', (args, result, start, end, error) => {
            const agent = args[0]?.scope
            recordService(agent, { name: 'systemPrompt.assemble', start, end, error,
              inputs: { model: args[0]?.modelSelection?.model, tools_in_set: args[0]?.toolSet ? 'yes' : 'no' },
              outputs: result && {
                sections: result.sections.map(s => ({ name: s.name, chars: s.text.length })),
                sections_chars: result.sections.reduce((n, s) => n + s.text.length, 0),
                contexts: result.contexts.map(c => ({ name: c.name, chars: c.text.length })),
                variables: Object.keys(result.variables),
                tools: result.tools.length,
              } })
          }),
          wrapMethod(inner.llm, 'prepareCall', (args, result, start, end, error) => {
            const agent = ctx.get('agents')?.currentInitiator?.()
            recordService(agent, { name: 'llm.prepareCall', start, end, error,
              inputs: { provider: args[0]?.provider, model: args[0]?.model, reasoning_effort: args[0]?.reasoningEffort },
              outputs: result && {
                provider: result.config?.provider, model: result.config?.model,
                context_window: result.context?.contextWindow,
                system_prompt_update: result.systemPromptUpdate ?? 'normalize',
                tool_update: result.toolUpdate ?? 'header',
                retry_policy: result.retryPolicy,
                adapter_defaults: result.adapterDefaults,
              } })
          }),
        ].filter(Boolean)
        return () => { for (const undo of restore) undo() }
      }, 'langsmith-tracer: service instrumentation')
    })
  }

  /**
   * Replace `service[method]` on the service's prototype with a wrapper that
   * calls the original, reports the call, and returns or rethrows unchanged.
   * @returns the undo function, or undefined when the method is absent.
   */
  function wrapMethod(service, method, report) {
    const owner = Object.getPrototypeOf(service)
    const original = owner?.[method]
    if (typeof original !== 'function') {
      console.warn(`[langsmith-tracer] cannot instrument ${method}: not found`)
      return undefined
    }
    const wrapped = async function (...args) {
      const start = Date.now()
      try {
        const result = await original.apply(this, args)
        record(() => report(args, result, start, Date.now()))
        return result
      } catch (error) {
        record(() => report(args, undefined, start, Date.now(), error instanceof Error ? error.message : String(error)))
        throw error
      }
    }
    owner[method] = wrapped
    return () => { if (owner[method] === wrapped) owner[method] = original }
  }

  /** Attach a service call to the agent's open step, or hold it until the step opens. */
  function recordService(agent, entry) {
    const session = agent?.session
    if (session === undefined) return // calls outside an agent turn (titles, summaries) are not traced
    const state = stateOf(session)
    const step = state.turn?.currentStep
    if (step) step.services.push(entry)
    else state.preService.push(entry)
  }

  ctx.on('agent/request-error', async (payload, next) => {
    const action = await next()
    record(() => {
      const { failure } = payload
      addEvent(stateOf(payload.agent.session), {
        name: `model request failed: ${failure.code}${failure.status ? ` (HTTP ${failure.status})` : ''} → ${action?.kind ?? 'no retry'}`,
        time: Date.now(),
        end: Date.now(),
        inputs: { provider: payload.provider, step: payload.step },
        outputs: {
          message: failure.message, code: failure.code, status: failure.status,
          request_id: failure.requestId, retry_after_ms: failure.providerRetryAfterMs, action: action?.kind ?? 'none',
        },
        error: failure.message,
      })
    })
    return action
  })

  ctx.on('agent/error', ({ agent, step, error }) => {
    record(() => addEvent(stateOf(agent.session), {
      name: 'agent loop error', time: Date.now(), end: Date.now(), inputs: { step }, error: error instanceof Error ? error.message : String(error),
    }))
  })

  ctx.on('session/event', (session, event) => {
    if (event.seq < session.inheritedEventCount) return
    try {
      handle(session, event)
    } catch (error) {
      console.warn('[langsmith-tracer] failed to record event', event.type, error)
    }
  })

  ctx.effect(() => async () => {
    sessions.clear()
    await client.awaitPendingTraceBatches()
  })

  // ── Event intake ────────────────────────────────────────────────────────

  function handle(session, event) {
    const { type, data, time } = event
    const state = stateOf(session)
    const turn = state.turn
    const step = turn?.currentStep

    if (step && !step.llm && type !== 'step/start' && type !== 'assistant/message') step.eventsBeforeModel.push(type)

    switch (type) {
      case 'turn/start':
        state.turn = { turn: data.turn, start: time, input: [], injected: [], steps: new Map(), events: [], currentStep: null, contextPeakPct: 0 }
        state.preService = []
        return
      case 'step/start': {
        if (!turn) return
        const created = {
          step: data.step, start: time, readyAt: time, header: state.header, context: state.context,
          preStep: state.preStep, llm: null, attempts: 0, tools: new Map(), events: [],
          services: state.preService, eventsBeforeModel: [],
        }
        state.preStep = null
        state.preService = []
        turn.steps.set(data.step, created)
        turn.currentStep = created
        return
      }
      case 'request/header':
        state.header = data.header
        if (step) {
          step.header = data.header
          step.headerReason = data.reason
          if (data.startsSeries) step.startsSeries = true
          step.readyAt = time
        }
        return
      case 'request/context':
        state.context = data
        if (step) step.context = data
        return
      case 'developer/message': {
        const blocks = data.message.content ?? []
        const added = blocks.filter(b => b.type === 'tool-addition').map(b => b.toolName)
        const removed = blocks.filter(b => b.type === 'tool-removal').map(b => b.toolName)
        if (step) step.readyAt = time
        if (added.length || removed.length) {
          addEvent(state, { name: `tool set changed (+${added.length} −${removed.length})`, time, end: time, inputs: { source: data.message.source?.kind }, outputs: { added, removed } })
        } else {
          addEvent(state, { name: 'developer message', time, end: time, inputs: { source: data.message.source?.kind }, outputs: { text: textOf(blocks).slice(0, 500) } })
        }
        return
      }
      case 'agent-preset/selected':
        state.preset = data.agentPreset
        addEvent(state, { name: `preset → ${data.agentPreset}`, time, end: time, inputs: {}, outputs: { preset: data.agentPreset } })
        return
      case 'system/message':
        if (step) { step.systemPromptLogged = true; step.systemPromptChars = textOf(data.message?.content ?? []).length; step.readyAt = time }
        return
      case 'user/message': {
        if (step) step.readyAt = time
        if (!turn) return
        const text = textOf(data.content)
        if (data.source?.kind === 'user') turn.input.push(text)
        else turn.injected.push({ source: data.source?.kind ?? 'unknown', content: text })
        return
      }
      case 'assistant/message': {
        const target = turn?.steps.get(data.step)
        if (!target) return
        target.llm = {
          start: target.readyAt,
          end: time,
          header: target.header,
          output: toChatMessage(data.message),
          usage: data.usage,
          interrupted: data.interrupted === true,
          stream: streamStats(data.stream, target.readyAt),
          history: historyFor(session, state, data.message.id),
        }
        const pct = contextUsedPct(target.context, data.usage)
        if (pct !== undefined && turn) turn.contextPeakPct = Math.max(turn.contextPeakPct, pct)
        return
      }
      case 'assistant/attempt': {
        const target = turn?.steps.get(data.step)
        if (!target) return
        target.attempts++
        addEvent(state, { name: 'model attempt failed', time, end: time, inputs: { step: data.step }, error: 'attempt settled without a message (retried, cancelled, or stream error)' })
        return
      }
      case 'tool/call':
        turn?.steps.get(data.step)?.tools.set(data.callId, { callId: data.callId, name: data.name, argsJson: data.arguments, start: time })
        return
      case 'tool/result': {
        const call = turn?.steps.get(data.step)?.tools.get(data.message.toolCallId)
        if (!call) return
        call.end = time
        call.output = textOf(data.message.content)
        call.isError = data.message.isError === true
        if (data.error) call.error = data.error
        if (data.meta !== undefined) call.meta = data.meta
        return
      }
      case 'step/end': {
        const target = turn?.steps.get(data.step)
        if (target) target.end = time
        if (turn) turn.currentStep = null
        return
      }
      case 'turn/end': {
        if (!turn) return
        state.turn = null
        // Attach live tool-pipeline facts collected for this turn's calls, then drop them.
        for (const s of turn.steps.values()) {
          for (const call of s.tools.values()) {
            call.live = state.live.get(call.callId)
            state.live.delete(call.callId)
          }
        }
        if (state.preStep?.kind === 'reject') turn.events.push({ name: 'pre-step rejected the input (no model call)', time, end: time })
        state.preStep = null
        void postTurn(session, state, turn, data.reason, time).catch((error) => {
          console.warn('[langsmith-tracer] failed to post turn', error)
        })
        return
      }

      // ── Events worth seeing in the trace (proposal F) ──
      case 'command/run':
        state.open.set(`command:${data.commandId}`, { name: `command: /${data.name}${data.args ?? ''}`, time, inputs: { command: data.name, args: (data.args ?? '').trim() }, children: [] })
        return
      case 'command/done':
        closeEvent(state, `command:${data.commandId}`, time, { kind: data.kind, text: data.text }, data.kind === 'error' ? data.text ?? 'command failed' : undefined)
        return
      case 'approval/asked':
        state.open.set(`approval:${data.id}`, { name: `approval: ${data.toolName}`, time, inputs: { tool: data.toolName, tool_call_id: data.callId, reason: data.reason } })
        return
      case 'approval/decided':
        closeEvent(state, `approval:${data.id}`, time, { outcome: data.outcome })
        return
      case 'compaction/start':
        state.open.set(`compaction:${data.compactionId}`, { name: 'compaction', time, inputs: { turn: data.turn } })
        return
      case 'compaction/end':
        closeEvent(state, `compaction:${data.compactionId}`, time, {}, data.error)
        return
      default:
        if (event.ignorable === true && type.startsWith('plugin:')) recordPluginEvent(state, type, data, time)
    }
  }

  /** Plugin records; the persona switcher's catalog record is bookkeeping and skipped. */
  function recordPluginEvent(state, type, data, time) {
    if (type === 'plugin:persona-switcher/catalog') return
    if (type === 'plugin:persona-switcher/select') {
      state.persona = data.personaId
      addEvent(state, { name: `persona → ${data.personaId}`, time, end: time, inputs: { source: data.source, reason: data.reason }, outputs: { persona: data.personaId, name: data.name } })
      return
    }
    addEvent(state, { name: type, time, end: time, inputs: {}, outputs: { data } })
  }

  function closeEvent(state, key, time, outputs, error) {
    const opened = state.open.get(key)
    if (!opened) return
    state.open.delete(key)
    addEvent(state, { ...opened, end: time, outputs, ...(error ? { error } : {}) })
  }

  /**
   * Attach to the command that is running (its handler caused the event), else
   * the open step, else the open turn, else send as a standalone trace.
   */
  function addEvent(state, entry) {
    const command = [...state.open.entries()].reverse().find(([key]) => key.startsWith('command:'))?.[1]
    if (command && entry !== command) { command.children.push(entry); return }
    const target = state.turn?.currentStep ?? state.turn
    if (target) { target.events.push(entry); return }
    void postStandaloneEvent(state, entry).catch((error) => {
      console.warn('[langsmith-tracer] failed to post event', error)
    })
  }

  /** History sent with one LLM run, per `historyMode` (proposal G). */
  function historyFor(session, state, assistantId) {
    if (historyMode === 'none') return []
    const history = session.deriveMessages().filter(m => m.id !== assistantId).map(toChatMessage)
    if (historyMode === 'full') return history
    // Compaction can shrink history; resend it whole in that case.
    const start = state.historySent <= history.length ? state.historySent : 0
    state.historySent = history.length + 1
    return history.slice(start)
  }

  // ── Posting ─────────────────────────────────────────────────────────────

  async function postTurn(session, state, turn, reason, end) {
    // The persona switcher (when installed) knows selections made before this process started.
    try {
      const selected = ctx.get('personaSwitcher')?.selected(session)
      if (selected !== undefined) state.persona = selected?.id ?? 'default'
    } catch (error) {
      void error // Optional service; keep the persona tracked from records.
    }
    const steps = [...turn.steps.values()].sort((a, b) => a.step - b.step)
    const toolsUsed = [...new Set(steps.flatMap(s => [...s.tools.values()].map(c => c.name)))]
    const finalStep = [...steps].reverse().find(s => s.llm)
    const model = finalStep?.llm.header?.config ?? state.header?.config
    const totals = steps.reduce((acc, s) => {
      const u = s.llm?.usage && toUsageMetadata(s.llm.usage)
      if (u) { acc.input += u.input_tokens; acc.output += u.output_tokens }
      return acc
    }, { input: 0, output: 0 })

    const caseTag = parseCaseTag(turn.input.join('\n'))
    const peak = turn.contextPeakPct
    const contextTag = peak >= 90 ? 'context:>90%' : peak >= 75 ? 'context:>75%' : peak >= 50 ? 'context:>50%' : undefined
    const root = new RunTree({
      name: 'dsh-turn',
      run_type: 'chain',
      project_name: projectName,
      client,
      tracingEnabled: true,
      start_time: turn.start,
      inputs: { input: turn.input.join('\n\n'), injected_context: turn.injected },
      tags: [
        ...baseTags, `persona:${state.persona}`, ...(model ? [`model:${model.model}`] : []), ...toolsUsed.map(n => `tool:${n}`),
        ...(state.preset ? [`preset:${state.preset}`] : []), ...(contextTag ? [contextTag] : []),
        ...(caseTag ? [`case:${caseTag.id}`, ...(caseTag.run ? [`run:${caseTag.run}`] : [])] : []),
        ...(steps.some(s => s.attempts) ? ['retried'] : []), ...(instrumentServices ? ['instrumented'] : []),
      ],
      // Children inherit the parent's metadata at creation; the turn summary is attached after them (below).
      metadata: { session_id: session.id, turn: turn.turn },
    })
    const summary = {
      steps: steps.length,
      tools_used: toolsUsed,
      tool_calls: steps.reduce((n, s) => n + s.tools.size, 0),
      persona: state.persona,
      ...(model ? { ls_provider: model.provider, ls_model_name: model.model } : {}),
      input_tokens: totals.input,
      output_tokens: totals.output,
      end_reason: reason.kind,
      ...(turn.queueWaitMs !== undefined ? { queue_wait_ms: turn.queueWaitMs } : {}),
      ...(state.preset ? { preset: state.preset } : {}),
      ...(peak ? { context_peak_pct: peak } : {}),
      ...(caseTag ? { case_id: caseTag.id, ...(caseTag.run ? { case_run: caseTag.run } : {}) } : {}),
      harness_ms: steps.reduce((n, s) => n + (s.llm ? Math.max(0, s.llm.start - s.start) : 0), 0),
      model_ms: steps.reduce((n, s) => n + (s.llm ? s.llm.end - s.llm.start : 0), 0),
      tool_ms: steps.reduce((n, s) => n + [...s.tools.values()].reduce((m, c) => m + ((c.end ?? c.start) - c.start), 0), 0),
      ...environment,
    }
    const tree = { run: root, children: [] }

    for (const step of steps) {
      const toolCalls = [...step.tools.values()]
      const stepRun = root.createChild({
        name: `step ${step.step}`,
        run_type: 'chain',
        start_time: harnessStart(step),
        inputs: {},
        metadata: { step: step.step },
        tags: toolCalls.map(c => `tool:${c.name}`),
      })
      const stepNode = { run: stepRun, children: [] }
      tree.children.push(stepNode)

      stepNode.children.push(await harnessRun(stepRun, step))
      if (step.llm) stepNode.children.push(await llmRun(stepRun, step))
      for (const call of toolCalls) stepNode.children.push(await toolRun(stepRun, step, call, end))
      for (const entry of step.events) stepNode.children.push(await eventRun(stepRun, entry))

      // Set after the children exist so they do not inherit step-only facts.
      stepRun.metadata = {
        ...(step.preStep ? { pre_step: step.preStep.kind, pre_step_messages: step.preStep.messages } : {}),
        ...(step.preStep?.startsRequestSeries || step.startsSeries ? { starts_request_series: true } : {}),
        ...(step.headerReason ? { request_header: step.headerReason } : {}),
        system_prompt_logged: step.systemPromptLogged === true,
        ...(step.attempts ? { failed_attempts: step.attempts } : {}),
      }

      await stepRun.end({
        text: step.llm?.output.content ?? '',
        tool_calls: toolCalls.map(c => ({ name: c.name, arguments: parseArguments(c.argsJson), is_error: c.isError === true })),
      }, undefined, step.end ?? end)
    }
    for (const entry of turn.events) tree.children.push(await eventRun(root, entry))

    root.metadata = summary
    await root.end(
      { output: finalStep?.llm.output.content ?? '' },
      reason.kind === 'completed' ? undefined : describeReason(reason),
      end,
    )
    await postTree(tree)
  }

  async function llmRun(parent, step) {
    const { llm } = step
    const config = llm.header?.config
    const tools = includeToolSchemas ? (llm.header?.tools ?? []).map(toOpenAiTool) : undefined
    const run = parent.createChild({
      name: config?.model ?? 'llm',
      run_type: 'llm',
      start_time: llm.start,
      inputs: { messages: llm.history, ...(tools ? { tools } : {}) },
      extra: {
        invocation_params: {
          ...(config ? { provider: config.provider, model: config.model } : {}),
          ...(config?.reasoningEffort !== undefined ? { reasoning_effort: config.reasoningEffort } : {}),
          ...(config?.temperature !== undefined ? { temperature: config.temperature } : {}),
          ...(config?.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
          ...(tools ? { tools } : {}),
        },
      },
      metadata: {
        step: step.step,
        history_mode: historyMode,
        available_tools: (llm.header?.tools ?? []).map(t => t.name),
        ...(config ? { ls_provider: config.provider, ls_model_name: config.model } : {}),
        ...(llm.interrupted ? { interrupted: true } : {}),
        ...streamMetadata(llm.stream),
        ...contextMetadata(step.context, llm.usage),
      },
    })
    // LangSmith derives "time to first token" from the first new_token event.
    if (llm.stream.firstAt !== undefined) run.addEvent({ name: 'new_token', time: new Date(llm.stream.firstAt).toISOString() })
    await run.end({
      choices: [{ message: llm.output }],
      ...(llm.usage ? { usage_metadata: toUsageMetadata(llm.usage) } : {}),
    }, llm.interrupted ? 'interrupted: the turn was cancelled while the model was answering' : undefined, llm.end)
    return { run, children: [] }
  }

  /** Time between step start and the model call: what the harness did to prepare the request. */
  async function harnessRun(parent, step) {
    const end = step.llm?.start ?? step.end ?? step.start
    const header = step.llm?.header ?? step.header
    const run = parent.createChild({
      name: 'harness',
      run_type: 'chain',
      start_time: harnessStart(step),
      inputs: {
        claimed_messages: step.preStep?.claimed ?? 0,
        model: header?.config?.model,
      },
      tags: ['harness'],
    })
    const children = []
    for (const service of step.services) children.push(await serviceRun(run, service))
    if (step.preStep) {
      children.push(await spanRun(run, 'hook: agent/pre-step', step.preStep.start, step.preStep.end,
        { claimed: step.preStep.claimed }, { decision: step.preStep.kind, messages: step.preStep.messages }))
    }
    const counts = {}
    for (const t of step.eventsBeforeModel) counts[t] = (counts[t] ?? 0) + 1
    await run.end({
      events_written: counts,
      tools: header?.tools?.length ?? 0,
      tool_schema_chars: JSON.stringify(header?.tools ?? []).length,
      ...(step.systemPromptChars !== undefined ? { system_prompt_chars: step.systemPromptChars } : {}),
      request_header: step.headerReason ?? 'unchanged',
      system_prompt_logged: step.systemPromptLogged === true,
      prep_ms: Math.max(0, end - step.start),
    }, undefined, end)
    return { run, children }
  }

  /** Tool resolution, prompt assembly and pre-step hooks run before `step/start` is logged. */
  function harnessStart(step) {
    return Math.min(step.start, ...step.services.map(s => s.start), ...(step.preStep ? [step.preStep.start] : []))
  }

  async function serviceRun(parent, service) {
    const run = parent.createChild({ name: `service: ${service.name}`, run_type: 'chain', start_time: service.start, inputs: service.inputs ?? {}, tags: ['service'] })
    await run.end(service.outputs ?? {}, service.error, service.end)
    return { run, children: [] }
  }

  async function spanRun(parent, name, start, end, inputs, outputs, error) {
    const run = parent.createChild({ name, run_type: 'chain', start_time: start, inputs: inputs ?? {}, tags: ['hook'] })
    await run.end(outputs ?? {}, error, end)
    return { run, children: [] }
  }

  async function toolRun(parent, step, call, fallbackEnd) {
    const run = parent.createChild({
      name: call.name,
      run_type: 'tool',
      start_time: call.start,
      inputs: parseArguments(call.argsJson),
      metadata: {
        step: step.step,
        tool_call_id: call.callId,
        is_error: call.isError === true,
        ...(call.error ? { error_code: call.error.code, error_name: call.error.name } : {}),
        ...pipelineMetadata(call),
      },
      tags: ['tool', `tool:${call.name}`, ...(call.isError ? ['tool-error'] : []), ...(call.live?.pre && call.live.pre.kind !== 'allow' ? [`pre-execute:${call.live.pre.kind}`] : [])],
    })
    const children = []
    const live = call.live
    if (live?.pre) children.push(await spanRun(run, 'hook: tools/pre-execute', live.pre.start, live.pre.end, {}, { decision: live.pre.kind, ...(live.pre.reason ? { reason: live.pre.reason } : {}) }))
    if (live?.dispatch) children.push(await spanRun(run, 'execute', live.dispatch.start, live.dispatch.end, {}, { is_error: live.dispatch.isError === true }))
    if (live?.post) children.push(await spanRun(run, 'hook: tools/post-execute', live.post.start, live.post.end, {}, { decision: live.post.kind, additional_contexts: live.post.additionalContexts }))
    const finished = call.end !== undefined
    await run.end(
      {
        output: call.output ?? '',
        is_error: call.isError === true,
        ...(call.error ? { error: call.error } : {}),
        ...(call.meta !== undefined ? { meta: call.meta } : {}),
      },
      !finished ? 'no result recorded (turn ended first)'
        : call.isError ? (call.error?.reason ?? call.error?.code ?? call.output ?? 'tool error') : undefined,
      call.end ?? step.end ?? fallbackEnd,
    )
    return { run, children }
  }

  async function eventRun(parent, entry) {
    const run = parent.createChild({
      name: `event: ${entry.name}`,
      run_type: 'chain',
      start_time: entry.time,
      inputs: entry.inputs ?? {},
      tags: ['event'],
    })
    const children = []
    for (const child of entry.children ?? []) children.push(await eventRun(run, child))
    await run.end(entry.outputs ?? {}, entry.error, entry.end ?? entry.time)
    return { run, children }
  }

  async function postStandaloneEvent(state, entry) {
    const sessionId = [...sessions.entries()].find(([, s]) => s === state)?.[0]
    const root = new RunTree({
      name: 'dsh-event',
      run_type: 'chain',
      project_name: projectName,
      client,
      tracingEnabled: true,
      start_time: entry.time,
      inputs: { event: entry.name },
      tags: [...baseTags, 'event', `persona:${state.persona}`],
      metadata: { session_id: sessionId, persona: state.persona },
    })
    const child = await eventRun(root, entry)
    await root.end(entry.outputs ?? {}, entry.error, entry.end ?? entry.time)
    await postTree({ run: root, children: [child] })
  }

  /** Post parent before children; `postRun()` clears `child_runs`, so the tree is tracked here. */
  async function postTree(node) {
    await node.run.postRun()
    for (const child of node.children) await postTree(child)
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────

/** Convert a DSH message to an OpenAI-style chat message, which LangSmith renders natively. */
function toChatMessage(message) {
  const role = message.role === 'developer' ? 'system' : message.role
  const out = { role, content: textOf(message.content) }
  if (message.role === 'user' && message.source?.kind && message.source.kind !== 'user') out.name = message.source.kind
  const reasoning = message.content.filter(b => b.type === 'reasoning').map(b => b.text ?? '').join('')
  if (reasoning) out.reasoning_content = reasoning
  const toolCalls = message.content.filter(b => b.type === 'tool-call')
  if (toolCalls.length > 0) {
    out.tool_calls = toolCalls.map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }))
  }
  if (message.role === 'tool') out.tool_call_id = message.toolCallId
  return out
}

function toOpenAiTool(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
}

/**
 * DSH counts are disjoint (`inputTokens` excludes cached input); LangSmith's
 * `input_tokens` is the full prompt with cache counts as a breakdown.
 */
function toUsageMetadata(usage) {
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const input = usage.inputTokens + cacheRead + cacheWrite
  return {
    input_tokens: input,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens ?? input + usage.outputTokens,
    input_token_details: { cache_read: cacheRead, cache_creation: cacheWrite },
    ...(usage.reasoningTokens === undefined ? {} : { output_token_details: { reasoning: usage.reasoningTokens } }),
  }
}

/**
 * Timing from the compact timed stream embedded in `assistant/message`.
 * Chunk runs carry `time0` plus per-chunk `dt` offsets; single chunks carry `time`.
 */
function streamStats(stream, requestStart) {
  const stats = { records: stream?.length ?? 0, reasoningMs: 0, textMs: 0, toolArgsMs: 0 }
  for (const record of stream ?? []) {
    const begin = record.type === 'chunk' ? record.time : record.time0
    const span = record.type === 'chunk' ? 0 : record.dt.reduce((a, b) => a + b, 0)
    if (typeof begin !== 'number') continue
    stats.firstAt = Math.min(stats.firstAt ?? begin, begin)
    stats.lastAt = Math.max(stats.lastAt ?? begin + span, begin + span)
    if (record.type === 'reasoning-chunks') stats.reasoningMs += span
    if (record.type === 'text-chunks') stats.textMs += span
    if (record.type === 'tool-call-chunks') stats.toolArgsMs += span
    if (record.type === 'chunk' && record.chunk.type === 'finish') stats.finishReason = record.chunk.reason.kind
  }
  if (stats.firstAt !== undefined && typeof requestStart === 'number') stats.ttftMs = Math.max(0, stats.firstAt - requestStart)
  return stats
}

function streamMetadata(stats) {
  return {
    ...(stats.ttftMs !== undefined ? { ttft_ms: stats.ttftMs } : {}),
    ...(stats.finishReason ? { finish_reason: stats.finishReason } : {}),
    ...(stats.reasoningMs ? { reasoning_ms: stats.reasoningMs } : {}),
    ...(stats.textMs ? { text_stream_ms: stats.textMs } : {}),
    ...(stats.toolArgsMs ? { tool_args_stream_ms: stats.toolArgsMs } : {}),
    stream_records: stats.records,
  }
}

function contextUsedPct(context, usage) {
  if (!context?.contextWindow || !usage) return undefined
  return Math.round((toUsageMetadata(usage).input_tokens / context.contextWindow) * 1000) / 10
}

/** `[W01]` or `[W01#2]` at the start of the input names an evaluation case and run. */
function parseCaseTag(input) {
  const match = /^\s*\[([A-Za-z0-9_.-]+)(?:#([A-Za-z0-9_.-]+))?\]/.exec(input)
  return match ? { id: match[1], run: match[2] } : undefined
}

/** Process facts attached to every turn. */
function describeEnvironment() {
  const env = { node_version: process.version, platform: `${process.platform}-${process.arch}`, cwd: process.cwd() }
  try {
    const require = createRequire(import.meta.url)
    env.dsh_core_version = require('@deepseek-ai/dsh-core/package.json').version
  } catch (error) {
    void error // Not resolvable from this plugin's location; the version is optional.
  }
  return env
}

function contextMetadata(context, usage) {
  if (!context) return {}
  const used = usage ? toUsageMetadata(usage).input_tokens : undefined
  return {
    ...(context.contextWindow ? { context_window: context.contextWindow } : {}),
    ...(context.contextWindow && used !== undefined ? { context_used_pct: Math.round((used / context.contextWindow) * 1000) / 10 } : {}),
    ...(context.systemPromptUpdate ? { system_prompt_update: context.systemPromptUpdate } : {}),
  }
}

/** Live tool-pipeline facts: policy decisions and where the time went. */
function pipelineMetadata(call) {
  const live = call.live
  if (!live) return {}
  return {
    ...(live.pre ? { pre_execute: live.pre.kind, ...(live.pre.reason ? { pre_execute_reason: live.pre.reason } : {}) } : {}),
    ...(live.dispatch ? {
      queued_ms: Math.max(0, live.dispatch.start - call.start),
      execute_ms: live.dispatch.end - live.dispatch.start,
    } : {}),
    ...(live.post ? { post_execute: live.post.kind, additional_contexts: live.post.additionalContexts } : {}),
  }
}

/** Join text blocks; replace non-text blocks with short placeholders. */
function textOf(content) {
  return content.map((block) => {
    switch (block.type) {
      case 'text': return block.text
      case 'image': return '[image]'
      case 'file': return `[file: ${block.attachment?.name ?? 'attachment'}]`
      default: return ''
    }
  }).filter(Boolean).join('\n')
}

function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { arguments: parsed }
  } catch (error) {
    // Model produced invalid JSON; keep the raw string visible in LangSmith.
    void error
    return { arguments: raw, invalid_json: true }
  }
}

function describeReason(reason) {
  switch (reason.kind) {
    case 'error': return reason.error?.message ?? 'turn failed'
    case 'aborted': return 'turn aborted'
    default: return `turn ended: ${reason.kind}`
  }
}
