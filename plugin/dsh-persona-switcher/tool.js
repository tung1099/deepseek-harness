/**
 * `switch_persona` tool: lets the model change its own persona for the current
 * Session. The description lists the installed personas and is re-registered
 * when the catalog changes, so the schema the model sees is always current.
 *
 * @module dsh-persona-switcher/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-switch-persona'
export const inject = ['personaSwitcher', 'tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  let unregister

  const register = () => {
    unregister?.()
    const personas = ctx.personaSwitcher.catalog()
    const listing = personas.map(p => `- ${p.id}: ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n')
    unregister = ctx.tools.register(defineTool({
      name: 'switch_persona',
      description: 'Switch your persona for this conversation when the user asks for a different role or expertise. '
        + 'The new persona replaces your role instructions from your next response onward. Available personas:\n'
        + listing,
      parameters: {
        persona: { type: 'string', required: true, description: 'Persona id from the list above; "default" restores the original persona.' },
        reason: { type: 'string', description: 'Short reason, shown to the user.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            persona: { type: 'string', required: true },
            name: { type: 'string', required: true },
            changed: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.changed
            ? `Persona switched to ${value.name} (${value.persona}). Follow that persona from your next response.`
            : `Persona ${value.name} (${value.persona}) is already active.`,
        }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('switch_persona requires an agent Session')
        try {
          const result = ctx.personaSwitcher.select(exec.agent, args.persona.trim(), {
            source: 'agent',
            ...(args.reason ? { reason: args.reason } : {}),
          })
          return { persona: result.to, name: result.name, changed: result.changed }
        } catch (error) {
          // The message lists the valid ids, so the model can correct the call.
          if (error?.name === 'PersonaNotFoundError') throw new Error(error.message)
          throw error
        }
      },
    }))
  }

  register()
  ctx.on('persona-switcher/catalog-changed', register)
}
