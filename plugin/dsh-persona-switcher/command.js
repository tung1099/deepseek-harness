/**
 * `/persona` command: the user's way to view or change the Session persona
 * without a model turn. The Web picker runs this same command.
 *
 *   /persona            show the current persona and the installed list
 *   /persona <id>       switch to <id>
 *   /persona default    restore the agent preset's persona
 *
 * @module dsh-persona-switcher/command
 */

import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { DEFAULT_PERSONA_ID } from './index.js'

export const name = 'command-persona'
export const inject = ['personaSwitcher', 'commands']

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  const switcher = ctx.personaSwitcher

  const listing = (currentId) => switcher.catalog()
    .map(p => `${p.id === currentId ? '▶' : ' '} ${p.icon} ${p.id} — ${p.name}${p.description ? `: ${p.description}` : ''}`)
    .join('\n')

  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-persona-switcher'),
    name: 'persona',
    description: 'View or switch the agent persona for this conversation',
    input: { hint: '[<persona id>|default]' },
    handler(invocation) {
      const requested = invocation.rawInput.trim().toLowerCase()
      const currentId = switcher.selected(invocation.agent.session)?.id ?? DEFAULT_PERSONA_ID
      if (requested === '') {
        return { kind: 'success', text: `Current persona: ${currentId}\n\n${listing(currentId)}\n\nUsage: /persona <id>` }
      }
      try {
        const result = switcher.select(invocation.agent, requested, { source: 'user' })
        return {
          kind: 'success',
          text: result.changed
            ? `Persona switched to ${result.icon} ${result.name}. It applies from the next response.`
            : `${result.icon} ${result.name} is already the current persona.`,
        }
      } catch (error) {
        if (error?.name !== 'PersonaNotFoundError') throw error
        return { kind: 'error', text: `Unknown persona "${requested}".\n\n${listing(currentId)}` }
      }
    },
  })
}
