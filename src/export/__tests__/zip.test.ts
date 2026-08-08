/**
 * The ZIP writer, checked against the reader the rest of the repo already trusts.
 *
 * `readDocx.ts` walks a real `.docx`'s central directory, and every fidelity test in the project
 * depends on it being right. Writing an archive here and reading it back with that is therefore
 * not a tautology — it proves the two independently-written halves agree on the format, and the
 * reader's half is already pinned by the reference template opening correctly.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readZipEntry } from '../../types/__tests__/readDocx.ts'
import { buildZip, crc32 } from '../zip.ts'

const workingDirectory = mkdtempSync(join(tmpdir(), 'debate-zip-'))

afterAll(() => {
  rmSync(workingDirectory, { recursive: true, force: true })
})

/** Writes an archive to disk so the on-disk reader can be pointed at it. */
function writeArchive(name: string, bytes: Uint8Array): string {
  const path = join(workingDirectory, name)
  writeFileSync(path, bytes)
  return path
}

const encoder = new TextEncoder()

describe('crc32', () => {
  it('matches the check value every CRC-32 implementation publishes', () => {
    // The standard check vector. If this is wrong, Word reports every export as corrupt and
    // says nothing about why.
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926)
  })

  it('is zero for no bytes', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('stays unsigned past the sign bit', () => {
    // `^ 0xffffffff` on a value with the top bit set gives a negative number in JavaScript
    // unless it is coerced back, and a negative length field writes garbage into the header.
    const checksum = crc32(encoder.encode('a'))
    expect(checksum).toBeGreaterThan(0x7fffffff)
    expect(Number.isInteger(checksum)).toBe(true)
  })
})

describe('buildZip', () => {
  it('round-trips an entry through the project’s own reader', () => {
    const archive = buildZip([
      { name: 'first.txt', bytes: encoder.encode('hello') },
      { name: 'nested/second.xml', bytes: encoder.encode('<a>b</a>') },
    ])
    const path = writeArchive('round-trip.zip', archive)

    expect(readZipEntry(path, 'first.txt').toString('utf8')).toBe('hello')
    expect(readZipEntry(path, 'nested/second.xml').toString('utf8')).toBe('<a>b</a>')
  })

  it('round-trips text that is longer than one header', () => {
    // A single short entry can pass with a wrong offset by coincidence; a long one cannot,
    // because the second entry's local header offset has to be exactly right.
    const long = 'x'.repeat(5000)
    const archive = buildZip([
      { name: 'long.txt', bytes: encoder.encode(long) },
      { name: 'after.txt', bytes: encoder.encode('after') },
    ])
    const path = writeArchive('long.zip', archive)

    expect(readZipEntry(path, 'long.txt').toString('utf8')).toBe(long)
    expect(readZipEntry(path, 'after.txt').toString('utf8')).toBe('after')
  })

  it('round-trips non-ASCII content', () => {
    const text = 'characterisation — “Prop’s” café'
    const archive = buildZip([{ name: 'utf8.txt', bytes: encoder.encode(text) }])
    const path = writeArchive('utf8.zip', archive)

    expect(readZipEntry(path, 'utf8.txt').toString('utf8')).toBe(text)
  })

  it('produces the same bytes twice', () => {
    // The reason the timestamp is fixed: two exports of one case must be diffable.
    const entries = [{ name: 'a.txt', bytes: encoder.encode('same') }]
    expect(buildZip(entries)).toEqual(buildZip(entries))
  })

  it('handles an empty entry', () => {
    const archive = buildZip([{ name: 'empty.txt', bytes: new Uint8Array(0) }])
    const path = writeArchive('empty.zip', archive)

    expect(readZipEntry(path, 'empty.txt').length).toBe(0)
  })
})
