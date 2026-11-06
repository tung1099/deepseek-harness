/**
 * Persona Switcher service (`ctx.personaSwitcher`).
 *
 * Owns the persona catalog and each Session's persona selection. A selection
 * is a durable `plugin:persona-switcher/select` record in the Session log; the
 * service applies it by registering the persona text as the agent-scoped
 * `deployment:persona-prefix` prompt section, which shadows the preset's own
 * persona for that agent only. The agent loop logs the resulting system prompt
 * as `system/message`, so every model request stays reconstructable from the log.
 *
 * Personas are contributed by sub-plugins through {@link PersonaSwitcher#register}.
 * The id `default` means "no override": the agent preset's own persona applies.
 *
 * @module dsh-persona-switcher
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'

/** Persona id that removes the override and restores the preset's persona. */
export const DEFAULT_PERSONA_ID = 'default'
/** Session projection key read by the Web client (`useProjection('personaSwitcher')`). */
export const PROJECTION_KEY = 'personaSwitcher'
/** Plugin record holding one Session's persona selection. */
export const SELECT_RECORD = 'plugin:persona-switcher/select'
/** Plugin record holding the persona catalog last offered to one Session. */
export const CATALOG_RECORD = 'plugin:persona-switcher/catalog'
/** Lowercase persona id grammar shared by registration and the tool/command parsers. */
export const PERSONA_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/

const SELECTION_SOURCES = ['user', 'agent']

/** Thrown when a selection names a persona that is not installed. */
export class PersonaNotFoundError extends Error {
  /**
   * @param {string} personaId - the requested id.
   * @param {string[]} available - installed ids, `default` first.
   */
  constructor(personaId, available) {
    super(`unknown persona "${personaId}"; available: ${available.join(', ')}`)
    this.name = 'PersonaNotFoundError'
    this.personaId = personaId
    this.available = available
  }
}

// ── Projection ────────────────────────────────────────────────────────────

/** Fail with a precise path; projection schemas guard checkpoint restores. */
function invalid(path, expected) {
  throw new TypeError(`${PROJECTION_KEY}: ${path} must be ${expected}`)
}

function parseEntry(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'an object')
  for (const key of ['id', 'name', 'icon']) {
    if (typeof value[key] !== 'string') invalid(`${path}.${key}`, 'a string')
  }
  if (value.description !== undefined && typeof value.description !== 'string') invalid(`${path}.description`, 'a string')
  return value
}

/** `{ selected, catalog }` is both the host state and the client view. */
const stateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object') invalid('state', 'an object')
    if (value.selected !== null) parseEntry(value.selected, 'selected')
    if (!Array.isArray(value.catalog)) invalid('catalog', 'an array')
    value.catalog.forEach((entry, i) => parseEntry(entry, `catalog[${i}]`))
    return value
  },
}

const INITIAL_STATE = Object.freeze({ selected: null, catalog: Object.freeze([]) })

/** Fold the two plugin records; a malformed or newer record is skipped, never thrown. */
const projection = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => INITIAL_STATE,
  apply(state, event) {
    const record = pluginRecordOf(event)
    if (record === undefined) return state
    try {
      switch (record.type) {
        case SELECT_RECORD: {
          const { personaId, name, icon } = record.data
          if (personaId === DEFAULT_PERSONA_ID) return state.selected === null ? state : { ...state, selected: null }
          return { ...state, selected: parseEntry({ id: personaId, name, icon }, 'selected') }
        }
        case CATALOG_RECORD:
          return { ...state, catalog: record.data.personas.map((entry, i) => parseEntry(entry, `catalog[${i}]`)) }
        default:
          return state
      }
    } catch {
      // A record this version cannot read keeps the previous state; throwing would fail every later read of the Session.
      return state
    }
  },
  wire: { summary: false, viewSchema: stateSchema, view: state => state },
}

// ── Service ───────────────────────────────────────────────────────────────

/**
 * @typedef {object} PersonaDefinition
 * @property {string} id - lowercase id matching {@link PERSONA_ID_PATTERN}; not `default`.
 * @property {string} name - display name.
 * @property {string} [icon] - one emoji or short glyph.
 * @property {string} [description] - one line shown in the picker and to the model.
 * @property {string} prompt - replaces the preset persona prefix; `{{model}}` expands to the model name.
 * @property {string} [suffix] - replaces the preset persona suffix when set.
 */

export const Config = Schema.object({
  defaultName: Schema.string().default('Default').description('Picker label for the preset persona.'),
  defaultIcon: Schema.string().default('💻'),
  defaultDescription: Schema.string().default('The agent preset’s own persona'),
})

export default class PersonaSwitcher extends Service {
  static inject = ['agents', 'systemPrompt', 'sessionProjections']
  static Config = Config

  /** @type {Map<string, Required<Pick<PersonaDefinition, 'id' | 'name' | 'icon' | 'description' | 'prompt'>> & { suffix?: string }>} */
  _personas = new Map()
  /** Agent → the persona whose sections are registered on its scope. */
  _applied = new Map()
  _projection
  _catalogQueued = false
  _closed = false

  constructor(ctx, config) {
    super(ctx, 'personaSwitcher')
    this.config = config
  }

  async [Service.init]() {
    this._projection = await this.ctx.sessionProjections.register(projection)
    this.ctx.on('agent/created', ({ agent }) => { this._refresh(agent) })
    this.ctx.on('agent/disposed', ({ agent }) => { this._applied.delete(agent) })
    this.ctx.effect(() => () => {
      this._closed = true
      for (const { dispose } of this._applied.values()) dispose()
      this._applied.clear()
    }, 'persona-switcher: agent sections')
    for (const agent of this.ctx.agents.list()) this._refresh(agent)
  }

  /**
   * Add a persona to the catalog. Wrap the call in `ctx.effect()` so plugin
   * unload removes it.
   * @param {PersonaDefinition} definition
   * @returns {() => void} disposer that removes the persona.
   */
  register(definition) {
    const persona = normalize(definition)
    if (this._personas.has(persona.id)) throw new Error(`persona-switcher: persona "${persona.id}" is already registered`)
    this._personas.set(persona.id, persona)
    this._catalogChanged()
    return () => {
      if (this._personas.get(persona.id) !== persona) return
      this._personas.delete(persona.id)
      this._catalogChanged()
    }
  }

  /**
   * Installed personas in picker order, the preset persona first.
   * @returns {{ id: string, name: string, icon: string, description: string }[]}
   */
  catalog() {
    return [
      { id: DEFAULT_PERSONA_ID, name: this.config.defaultName, icon: this.config.defaultIcon, description: this.config.defaultDescription },
      ...[...this._personas.values()].map(({ id, name, icon, description }) => ({ id, name, icon, description })),
    ]
  }

  /**
   * The persona recorded for a Session, or `null` for the preset persona.
   * @param {import('@deepseek-ai/dsh-session').Session} session
   * @returns {{ id: string, name: string, icon: string } | null}
   */
  selected(session) {
    return this._projection.stateOf(session).selected
  }

  /**
   * Record a persona selection for the agent's Session and apply it from the next model request.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {string} personaId - installed id or `default`.
   * @param {{ source: 'user' | 'agent', reason?: string }} origin
   * @returns {{ changed: boolean, from: string, to: string, name: string, icon: string }}
   * @throws {PersonaNotFoundError} when the id is not installed.
   */
  select(agent, personaId, origin) {
    if (!SELECTION_SOURCES.includes(origin.source)) throw new TypeError(`persona-switcher: unknown selection source "${origin.source}"`)
    const target = this.catalog().find(entry => entry.id === personaId)
    if (target === undefined) throw new PersonaNotFoundError(personaId, this.catalog().map(entry => entry.id))
    const from = this.selected(agent.session)?.id ?? DEFAULT_PERSONA_ID
    const result = { changed: from !== target.id, from, to: target.id, name: target.name, icon: target.icon }
    if (!result.changed) return result
    appendPluginRecord(agent.session, SELECT_RECORD, {
      personaId: target.id,
      name: target.name,
      icon: target.icon,
      source: origin.source,
      ...(origin.reason ? { reason: origin.reason } : {}),
    })
    this._apply(agent)
    return result
  }

  /** Coalesce registrations made in one tick (startup loads every persona row at once). */
  _catalogChanged() {
    if (this._catalogQueued) return
    this._catalogQueued = true
    queueMicrotask(() => {
      this._catalogQueued = false
      if (this._closed || this._projection === undefined) return
      for (const agent of this.ctx.agents.list()) this._refresh(agent)
      this.ctx.emit('persona-switcher/catalog-changed')
    })
  }

  /** Offer the current catalog to the agent's Session and (re)apply its selection. */
  _refresh(agent) {
    try {
      this._syncCatalog(agent)
      this._apply(agent)
    } catch (error) {
      // Persona state must never fail agent creation; the preset persona stays in effect.
      this.ctx.logger.warn(`persona-switcher: could not refresh persona for session ${agent.session.id}:`, error)
    }
  }

  _syncCatalog(agent) {
    const current = this.catalog()
    const recorded = this._projection.stateOf(agent.session).catalog
    if (JSON.stringify(recorded) === JSON.stringify(current)) return
    appendPluginRecord(agent.session, CATALOG_RECORD, { personas: current })
  }

  /** Register (or remove) the agent-scoped persona sections that match the recorded selection. */
  _apply(agent) {
    if (this._closed) return
    const selectedId = this.selected(agent.session)?.id
    const persona = selectedId === undefined ? undefined : this._personas.get(selectedId)
    const previous = this._applied.get(agent)
    if (previous?.persona === persona) return
    previous?.dispose()
    this._applied.delete(agent)
    // A selection whose persona was uninstalled falls back to the preset persona until it returns.
    if (persona === undefined) return

    const prompt = agent.ctx.systemPrompt
    const disposers = [prompt.section({
      name: PERSONA_PREFIX_SECTION,
      order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: persona.prompt,
    })]
    if (persona.suffix !== undefined) {
      disposers.push(prompt.section({
        name: PERSONA_SUFFIX_SECTION,
        order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
        text: persona.suffix,
      }))
    }
    this._applied.set(agent, { persona, dispose: () => { for (const dispose of disposers) dispose() } })
  }
}

/** Validate a definition from YAML or code; sub-plugin config arrives already schema-checked. */
function normalize(definition) {
  const { id, name, prompt } = definition
  if (typeof id !== 'string' || !PERSONA_ID_PATTERN.test(id)) {
    throw new TypeError(`persona-switcher: persona id ${JSON.stringify(id)} must match ${PERSONA_ID_PATTERN}`)
  }
  if (id === DEFAULT_PERSONA_ID) throw new TypeError(`persona-switcher: "${DEFAULT_PERSONA_ID}" is reserved for the preset persona`)
  if (typeof name !== 'string' || name.trim() === '') throw new TypeError(`persona-switcher: persona "${id}" needs a name`)
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new TypeError(`persona-switcher: persona "${id}" needs a prompt`)
  return {
    id,
    name: name.trim(),
    icon: definition.icon ?? '🎭',
    description: definition.description ?? '',
    prompt,
    ...(definition.suffix === undefined ? {} : { suffix: definition.suffix }),
  }
}
