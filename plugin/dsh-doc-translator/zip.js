/**
 * Minimal ZIP reader and writer for Office Open XML packages.
 *
 * Reads every entry into memory and writes a new archive with the same entry
 * order, names and timestamps. Encrypted archives, ZIP64 and multi-disk
 * archives are rejected by name rather than misread.
 *
 * @module dsh-doc-translator/zip
 */

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/**
 * Read all entries of a ZIP archive.
 * @param {Buffer} buffer - the archive bytes.
 * @param {{ maxTotalBytes?: number }} [options] - `maxTotalBytes` bounds the sum of uncompressed sizes (default 512 MiB).
 * @returns {Array<{ name: string, data: Buffer, time: number, date: number, isDirectory: boolean }>} entries in archive order.
 */
export function readZip(buffer, options = {}) {
  const maxTotal = options.maxTotalBytes ?? 512 * 1024 * 1024
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (end of central directory not found)')
  const count = buffer.readUInt16LE(eocd + 10)
  const dirSize = buffer.readUInt32LE(eocd + 12)
  const dirOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported')
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) throw new Error('multi-disk ZIP archives are not supported')

  const entries = []
  let total = 0
  let pos = dirOffset
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(pos) !== CENTRAL) throw new Error('corrupt ZIP central directory')
    const flags = buffer.readUInt16LE(pos + 8)
    const method = buffer.readUInt16LE(pos + 10)
    const time = buffer.readUInt16LE(pos + 12)
    const date = buffer.readUInt16LE(pos + 14)
    const compressedSize = buffer.readUInt32LE(pos + 20)
    const size = buffer.readUInt32LE(pos + 24)
    const nameLength = buffer.readUInt16LE(pos + 28)
    const extraLength = buffer.readUInt16LE(pos + 30)
    const commentLength = buffer.readUInt16LE(pos + 32)
    const localOffset = buffer.readUInt32LE(pos + 42)
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength)
    pos += 46 + nameLength + extraLength + commentLength
    if (flags & 1) throw new Error(`encrypted ZIP entry "${name}" is not supported`)
    if (compressedSize === 0xffffffff || size === 0xffffffff) throw new Error('ZIP64 archives are not supported')
    total += size
    if (total > maxTotal) throw new Error(`archive expands beyond ${maxTotal} bytes; refusing to read it`)
    if (buffer.readUInt32LE(localOffset) !== LOCAL) throw new Error(`corrupt local header for "${name}"`)
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) })
    else throw new Error(`unsupported ZIP compression method ${method} for "${name}"`)
    if (data.length !== size) throw new Error(`size mismatch for "${name}"`)
    entries.push({ name, data, time, date, isDirectory: name.endsWith('/') })
  }
  return entries
}

/**
 * Write entries to a new ZIP archive.
 * @param {Array<{ name: string, data: Buffer, time?: number, date?: number }>} entries - entries in the order to write.
 * @returns {Buffer} the archive bytes.
 */
export function writeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const stored = data.length === 0 || entry.name === 'mimetype'
    const body = stored ? data : deflateRawSync(data, { level: 9 })
    const method = stored ? 0 : 8
    const sum = crc32(data)
    const time = entry.time ?? 0
    const date = entry.date ?? 0x21
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(sum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
