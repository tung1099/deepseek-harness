import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../skills.js'

const ROOT = join(import.meta.dirname, '..')
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const skill = readFileSync(join(ROOT, 'skills', 'document-translation', 'SKILL.md'), 'utf8')

test('the bundled skill registers under its directory name', () => {
  const registered = []
  apply({ skills: { register: s => registered.push(s) } })
  assert.deepEqual(registered.map(s => s.name), ['document-translation'])
  assert.ok(registered[0].content.length > 500)
})

test('the preset has no file or web tool, so the document text never reaches the agent', () => {
  assert.doesNotMatch(patch, /dsh-tool-fs|dsh-tool-web|dsh-tool-bash/)
  assert.match(patch, /dsh-doc-translator\/tools/)
  assert.match(patch, /dsh-tool-present/)
})

test('the preset chooses its first step from what the user gave, and asks nothing else', () => {
  assert.match(patch, /A file and a target language: call doc_translate at once\. Ask nothing else\./)
  assert.match(patch, /A file but no target language: call ask_user_question once with id language/)
  assert.match(patch, /A target language but no file: call ask_user_question once with a single question that has no options/)
  assert.match(patch, /no questions about tone, purpose or style/)
  assert.match(patch, /Never guess a file or a language/)
})

test('the preset and the skill forbid claiming an identical result and require stating only what was checked', () => {
  assert.match(patch, /Never say the result is identical to the original/)
  assert.match(patch, /If the result says the layout check was not done, say so/)
  assert.match(skill, /Không nói "giữ nguyên hoàn toàn", "giống hệt bản gốc"/)
  assert.match(skill, /số trang không đổi/)
  assert.match(skill, /lỗi OCR sẽ thành lỗi dịch/)
})

test('the skill states the fidelity of every supported file type, and that scans are approximate', () => {
  for (const type of ['`.docx`, `.pptx`, `.xlsx`', '`.pdf` quét', '`.doc`, `.xls`, `.ppt`']) assert.ok(skill.includes(type), type)
  assert.match(skill, /\*\*Gần đúng\*\*/)
  assert.match(skill, /PDF ra là PDF toàn ảnh, không chọn được chữ/)
})

test('the tool settings in the preset name an endpoint, translation models and both OCR models', () => {
  assert.match(patch, /baseUrl: https:\/\/[^\s]+\/v1\n/)
  assert.match(patch, /translationModels:\n\s+- \S+/)
  assert.match(patch, /spotModel: \S+/)
  assert.match(patch, /readModel: \S+/)
  assert.match(patch, /allowParallelInProgress: true/)
})

test('the preset and the skill tell the agent to report a tool error and stop, not to improvise', () => {
  assert.match(patch, /If doc_translate returns an error, tell the user what it says in one or two plain sentences and stop/)
  assert.match(patch, /never call a tool again with the same arguments/)
  assert.match(skill, /## Khi công cụ báo lỗi/)
  assert.match(skill, /đừng gọi lại công cụ với đúng các đối số cũ/)
})
