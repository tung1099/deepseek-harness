import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { readZip, writeZip } from '../zip.js'
import { buildDocx } from './build.js'

test('a written archive reads back with the same names, order and bytes', () => {
  const entries = [
    { name: 'mimetype', data: Buffer.from('application/x') },
    { name: 'a/b.xml', data: Buffer.from('<r>' + 'x'.repeat(5000) + '</r>'), time: 1234, date: 0x5a21 },
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'dir/', data: Buffer.alloc(0) },
    { name: 'vi/tiếng-việt.txt', data: Buffer.from('xin chào') },
  ]
  const back = readZip(writeZip(entries))
  assert.deepEqual(back.map(e => e.name), entries.map(e => e.name))
  assert.deepEqual(back.map(e => e.data.toString()), entries.map(e => e.data.toString()))
  assert.equal(back[1].time, 1234)
  assert.equal(back[1].date, 0x5a21)
  assert.equal(back[3].isDirectory, true)
})

test('compression shrinks repetitive content and the archive is deterministic', () => {
  const data = Buffer.from('abc'.repeat(10000))
  const once = writeZip([{ name: 'x', data }])
  assert.ok(once.length < 1000)
  assert.deepEqual(once, writeZip([{ name: 'x', data }]))
})

test('a package built by the test builders reads back as a ZIP with its parts', () => {
  const names = readZip(buildDocx()).map(e => e.name)
  assert.ok(names.includes('word/document.xml'))
  assert.equal(names[0], '[Content_Types].xml')
})

test('input that is not a ZIP, or is truncated, is rejected', () => {
  assert.throws(() => readZip(Buffer.from('plain text file')), /not a ZIP archive/)
  const good = writeZip([{ name: 'a', data: Buffer.from('hello') }])
  assert.throws(() => readZip(good.subarray(0, good.length - 30)), /ZIP|central directory/)
})

test('an encrypted entry is refused by name', () => {
  const good = Buffer.from(writeZip([{ name: 'secret.xml', data: Buffer.from('hello') }]))
  const eocd = good.length - 22
  const central = good.readUInt32LE(eocd + 16)
  good.writeUInt16LE(good.readUInt16LE(central + 8) | 1, central + 8)
  assert.throws(() => readZip(good), /encrypted ZIP entry "secret.xml"/)
})

test('an archive that expands beyond the limit is refused before inflating', () => {
  const bomb = writeZip([{ name: 'big', data: Buffer.alloc(100_000, 'a') }])
  assert.throws(() => readZip(bomb, { maxTotalBytes: 50_000 }), /expands beyond 50000 bytes/)
})

test('an unsupported compression method is refused', () => {
  const good = Buffer.from(writeZip([{ name: 'a.xml', data: Buffer.from('x'.repeat(100)) }]))
  const eocd = good.length - 22
  const central = good.readUInt32LE(eocd + 16)
  good.writeUInt16LE(14, central + 10)
  assert.throws(() => readZip(good), /unsupported ZIP compression method 14/)
  void deflateRawSync
})
