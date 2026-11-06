/**
 * Registers the bundled marketing skills (`skills/<name>/SKILL.md`) into the
 * agent scope that mounts this plugin, so only the marketing preset sees them.
 *
 * @module dsh-marketing-studio/skills
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'marketing-studio-skills'
export const inject = ['skills']

const SKILLS_DIR = join(import.meta.dirname, 'skills')

/**
 * Split a `SKILL.md` into single-line frontmatter fields and the body.
 * @param {string} text - file contents.
 * @param {string} file - path used in error messages.
 * @returns {{ fields: Record<string, string>, body: string }}
 */
export function parseSkill(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${file}: SKILL.md must start with a --- frontmatter block`)
  const fields = {}
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) throw new Error(`${file}: frontmatter line "${line}" is not "key: value"`)
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  for (const required of ['name', 'description']) {
    if (!fields[required]) throw new Error(`${file}: frontmatter field "${required}" is required`)
  }
  return { fields, body: match[2].trim() }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(SKILLS_DIR, entry.name, 'SKILL.md')
    const { fields, body } = parseSkill(readFileSync(file, 'utf8'), file)
    if (fields.name !== entry.name) throw new Error(`${file}: frontmatter name "${fields.name}" must equal the directory name "${entry.name}"`)
    ctx.skills.register({
      name: fields.name,
      description: fields.description,
      ...(fields.whenToUse ? { whenToUse: fields.whenToUse } : {}),
      source: 'bundled',
      path: file,
      content: body,
    })
  }
}
