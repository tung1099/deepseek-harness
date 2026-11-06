/**
 * One persona as a plugin row. Each loader row of this module adds one persona
 * to `ctx.personaSwitcher`; unloading or disabling the row removes it.
 *
 * ```yaml
 * - id: persona-lawyer
 *   name: dsh-persona-switcher/persona
 *   config: { id: lawyer, name: Luật sư, icon: ⚖️, description: ..., prompt: ... }
 * ```
 *
 * @module dsh-persona-switcher/persona
 */

import Schema from '@deepseek-ai/schemastery'

export const name = 'persona'
export const inject = ['personaSwitcher']

export const Config = Schema.object({
  id: Schema.string().pattern(/^[a-z][a-z0-9-]{0,39}$/).required()
    .description('Lowercase id used by /persona and switch_persona; "default" is reserved.'),
  name: Schema.string().required().description('Display name.'),
  icon: Schema.string().default('🎭'),
  description: Schema.string().default('').description('One line shown in the picker and to the model.'),
  prompt: Schema.string().required().description('Replaces the preset persona text; {{model}} expands to the model name.'),
  suffix: Schema.string().description('Replaces the preset persona suffix when set.'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  ctx.effect(() => ctx.personaSwitcher.register(config), `persona: ${config.id}`)
}
