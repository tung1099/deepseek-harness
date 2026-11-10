import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, parseSkill } from '../skills.js'

const ROOT = join(import.meta.dirname, '..')
const SKILLS = join(ROOT, 'skills')

test('parseSkill reads single-line frontmatter and rejects malformed files', () => {
  const { fields, body } = parseSkill('---\nname: x\ndescription: "d"\n---\nbody\n', 'f')
  assert.deepEqual(fields, { name: 'x', description: 'd' })
  assert.equal(body, 'body')
  assert.throws(() => parseSkill('no frontmatter', 'f'), /must start with/)
  assert.throws(() => parseSkill('---\nname: x\n---\nb', 'f'), /"description" is required/)
})

test('apply registers every bundled skill under its directory name', () => {
  const registered = []
  apply({ skills: { register: skill => registered.push(skill) } })
  assert.deepEqual(registered.map(s => s.name).sort(), readdirSync(SKILLS).sort())
  assert.ok(registered.every(s => s.content.length > 200 && s.source === 'bundled'))
})

test('both skills state that the agent only analyzes and never recommends buying or selling', () => {
  for (const name of readdirSync(SKILLS)) {
    const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')
    assert.match(text, /không khuyến nghị mua, bán hay nắm giữ|không đưa ra khuyến nghị|không khuyến nghị/i, name)
    assert.match(text, /giá mục tiêu/, name)
  }
})

test('the analysis skill lists what is forbidden and what is allowed', () => {
  const text = readFileSync(join(SKILLS, 'financial-statement-analysis', 'SKILL.md'), 'utf8')
  assert.match(text, /Không được:/)
  assert.match(text, /Được phép:/)
  assert.match(text, /Khuyến nghị mua, bán, nắm giữ/)
})

test('the preset persona forbids recommendations and mounts no file-writing tool', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /Never recommend buying, selling or holding/)
  assert.match(patch, /Never give a target price/)
  assert.doesNotMatch(patch, /dsh-tool-fs/)
  assert.match(patch, /allowParallelInProgress: true/)
})

test('the preset picks the first step from what the user named, with a text form for a general request', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /dsh-tool-ask-user/)
  assert.match(patch, /A stock code .*call fin_report at once\. Ask nothing/)
  assert.match(patch, /call fin_find_company\. If its result says Confident: yes, call fin_report at once without asking/)
  assert.match(patch, /call ask_user_question once with a single question that has no options, so the user gets a text field/)
  assert.match(patch, /Never guess a stock code/)
})

test('the analysis skill describes the same three cases', () => {
  const text = readFileSync(join(SKILLS, 'financial-statement-analysis', 'SKILL.md'), 'utf8')
  assert.match(text, /\*\*Có mã cổ phiếu\*\*.*gọi `fin_report` ngay, không hỏi gì thêm/)
  assert.match(text, /\*\*Có tên công ty\*\*.*`fin_find_company`.*`Confident: yes`.*gọi `fin_report` ngay mà không hỏi xác nhận/)
  assert.match(text, /\*\*Yêu cầu chung chung.*\*\*không có `options`\*\*/)
  assert.match(text, /Không bao giờ đoán mã/)
})
