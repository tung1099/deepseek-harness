import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmError } from '../llm.js'
import { buildSystemPrompt, makeBatches, mapLimit, parseReply, translateSegments } from '../translate.js'

/** A model that "translates" by upper-casing, keeping markers; behaviour can be overridden per model. */
function fakeLlm(behaviour = {}) {
  const calls = []
  return {
    calls,
    async chat({ model, user, system }) {
      const rows = JSON.parse(user)
      calls.push({ model, count: rows.length, system })
      const custom = behaviour[model]
      if (custom) { const out = await custom(rows, calls.filter(c => c.model === model).length); if (out !== undefined) return { text: out, usage: { total_tokens: 10 } } }
      return { text: JSON.stringify(rows.map(r => ({ i: r.i, text: r.text.replace(/[^⟦⟧/\d]+/g, m => m.toUpperCase()) }))), usage: { total_tokens: 10 } }
    },
  }
}
const OPTIONS = { target: 'Vietnamese', models: ['A'], concurrency: 4, batchChars: 1000, batchItems: 50, maxTokens: 1000 }
const seg = (id, text) => ({ id, text })

test('segments with the same text are sent once and share the translation', async () => {
  const llm = fakeLlm()
  const out = await translateSegments(llm, [seg('1', 'hello'), seg('2', 'world'), seg('3', 'hello')], OPTIONS)
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].count, 2)
  assert.deepEqual([...out.translations], [['1', 'HELLO'], ['3', 'HELLO'], ['2', 'WORLD']])
  assert.deepEqual(out.failures, [])
})

test('batches respect the character and item limits, and an oversized item gets its own batch', () => {
  const items = [{ i: 0, text: 'a'.repeat(40) }, { i: 1, text: 'b'.repeat(40) }, { i: 2, text: 'c'.repeat(40) }, { i: 3, text: 'd'.repeat(500) }, { i: 4, text: 'e' }]
  assert.deepEqual(makeBatches(items, { batchChars: 100, batchItems: 10 }).map(b => b.map(x => x.i)), [[0, 1], [2], [3], [4]])
  assert.deepEqual(makeBatches(items.slice(0, 3), { batchChars: 1000, batchItems: 2 }).map(b => b.length), [2, 1])
})

test('batches are spread over the models in turn and all run in parallel up to the limit', async () => {
  let active = 0
  let peak = 0
  const slow = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); active--; return undefined }
  const llm = fakeLlm({ A: slow, B: slow })
  const segments = Array.from({ length: 8 }, (_, i) => seg(String(i), `text number ${i} `.repeat(6)))
  await translateSegments(llm, segments, { ...OPTIONS, models: ['A', 'B'], batchChars: 100, concurrency: 3 })
  assert.deepEqual(llm.calls.map(c => c.model).sort(), ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B'])
  assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`)
})

test('a model that fails hands the batch to the next model', async () => {
  const llm = fakeLlm({ A: () => { throw new LlmError('A down', { retryable: true }) } })
  const out = await translateSegments(llm, [seg('1', 'hello')], { ...OPTIONS, models: ['A', 'B'] })
  assert.equal(out.translations.get('1'), 'HELLO')
  assert.deepEqual(llm.calls.map(c => c.model), ['A', 'B'])
  assert.equal(out.stats.fallbacks, 1)
})

test('when every model fails the segments are reported, not silently dropped', async () => {
  const down = () => { throw new LlmError('down') }
  const out = await translateSegments(fakeLlm({ A: down, B: down }), [seg('1', 'hello'), seg('2', 'bye')], { ...OPTIONS, models: ['A', 'B'] })
  assert.equal(out.translations.size, 0)
  assert.deepEqual(out.failures.map(f => f.id), ['1', '2'])
  assert.match(out.failures[0].reason, /down/)
})

test('a reply in the wrong shape splits the batch and keeps the good half', async () => {
  // The model cannot handle 4 items at once and answers with a bare string.
  const llm = fakeLlm({ A: rows => (rows.length > 2 ? 'sorry, here you go: nothing' : undefined) })
  const segments = ['a1', 'a2', 'a3', 'a4'].map((t, i) => seg(String(i), t))
  const out = await translateSegments(llm, segments, OPTIONS)
  assert.deepEqual([...out.translations.values()].sort(), ['A1', 'A2', 'A3', 'A4'])
  assert.equal(out.stats.splits, 1)
})

test('a single item the model cannot return in shape moves on to the next model', async () => {
  const llm = fakeLlm({ A: () => '[{"i":0}]' })
  const out = await translateSegments(llm, [seg('1', 'hello')], { ...OPTIONS, models: ['A', 'B'] })
  assert.equal(out.translations.get('1'), 'HELLO')
})

test('items whose markers were lost are asked again once; the retry result is used', async () => {
  let first = true
  const llm = fakeLlm({ A: (rows) => { if (first) { first = false; return JSON.stringify(rows.map(r => ({ i: r.i, text: r.text.replace(/⟦\/?\d+⟧/g, '') }))) } return undefined } })
  const out = await translateSegments(llm, [seg('1', '⟦1⟧bold⟦/1⟧⟦2⟧plain⟦/2⟧')], OPTIONS)
  assert.equal(out.translations.get('1'), '⟦1⟧BOLD⟦/1⟧⟦2⟧PLAIN⟦/2⟧')
  assert.equal(out.stats.markerRetries, 1)
  assert.equal(llm.calls.length, 2)
})

test('items that keep losing markers are still returned so the writer can fall back', async () => {
  const strip = rows => JSON.stringify(rows.map(r => ({ i: r.i, text: r.text.replace(/⟦\/?\d+⟧/g, '') })))
  const out = await translateSegments(fakeLlm({ A: strip }), [seg('1', '⟦1⟧a⟦/1⟧⟦2⟧b⟦/2⟧')], OPTIONS)
  assert.equal(out.translations.get('1'), 'ab')
})

test('parseReply accepts fenced JSON and rejects missing, duplicate and empty rows', () => {
  const batch = [{ i: 0, text: 'a' }, { i: 1, text: 'b' }]
  assert.equal(parseReply('```json\n[{"i":0,"text":"x"},{"i":1,"text":"y"}]\n```', batch).get(1), 'y')
  assert.equal(parseReply('[{"i":0,"text":"x"}]', batch), null)
  assert.equal(parseReply('[{"i":0,"text":"x"},{"i":0,"text":"y"}]', batch), null)
  assert.equal(parseReply('[{"i":0,"text":"x"},{"i":1,"text":" "}]', batch), null)
  assert.equal(parseReply('no json', batch), null)
})

test('the prompt names the languages, forbids notes, and lists only glossary terms that occur in the batch', () => {
  const prompt = buildSystemPrompt({ target: 'English', source: 'Vietnamese', glossary: [{ source: 'hợp đồng', target: 'contract' }, { source: 'bảo hành', target: 'warranty' }] }, [{ i: 0, text: 'Hợp đồng này' }])
  assert.match(prompt, /from Vietnamese into English/)
  assert.match(prompt, /Do not add notes/)
  assert.match(prompt, /Translate every item that is not already written in English, whatever language it is in/)
  assert.match(prompt, /hợp đồng => contract/)
  assert.doesNotMatch(prompt, /bảo hành/)
  assert.doesNotMatch(buildSystemPrompt({ target: 'English' }, [{ i: 0, text: 'x' }]), /Glossary|from /)
})

test('mapLimit keeps order and bounds concurrency', async () => {
  let active = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return x * 2 })
  assert.deepEqual(out, [2, 4, 6, 8, 10])
  assert.equal(peak, 2)
})

test('cancellation propagates instead of being recorded as a failed batch', async () => {
  const controller = new AbortController()
  const llm = { chat: async () => { controller.abort(new Error('user cancelled')); throw new Error('aborted') } }
  await assert.rejects(translateSegments(llm, [seg('1', 'hello')], { ...OPTIONS, signal: controller.signal }), /aborted|cancelled/)
})
