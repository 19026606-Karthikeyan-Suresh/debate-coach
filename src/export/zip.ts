/**
 * A minimal ZIP writer, because a `.docx` is a ZIP.
 *
 * The mirror of `src/types/__tests__/readDocx.ts`, which walks a ZIP central directory to read
 * the reference template. That reader exists so one test does not pull in a document library;
 * this writer exists for the same reason on the way out, and the two are tested against each
 * other — `docx.test.ts` builds an archive here and reads it back with that.
 *
 * **Entries are stored, never deflated.** A compressed archive needs `CompressionStream`, which
 * is async and turns every caller into a promise, and the thing being compressed is a case file:
 * a hundred kilobytes of XML that nobody transfers over a network. Sync and pure is worth more
 * here than a file five times smaller.
 *
 * **The output is deterministic.** Timestamps are fixed, so exporting the same case twice
 * produces byte-identical archives and a diff between two exports is a diff between two cases.
 */

/** One file in the archive. */
export interface ZipEntry {
  /** Path inside the archive — forward slashes, no leading slash, e.g. `word/document.xml`. */
  readonly name: string
  readonly bytes: Uint8Array
}

// Reflected CRC-32, the polynomial every ZIP implementation uses. Word rejects an archive whose
// checksums do not match, so this is load-bearing rather than a formality.
const CRC32_POLYNOMIAL = 0xedb88320

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50

/** ZIP 2.0: store and deflate, no encryption, no zip64. */
const VERSION_NEEDED = 20

/** Compression method 0. See the module docstring for why nothing here deflates. */
const METHOD_STORED = 0

// 1980-01-01 00:00 in DOS date/time — the epoch of the format, and the earliest legal value.
// Fixed rather than `new Date()` so the export is reproducible; nothing reads a docx's internal
// timestamps, and Word shows the filesystem's.
const DOS_DATE = 0x0021
const DOS_TIME = 0x0000

/** Lookup table for {@link crc32}, built once. */
const CRC32_TABLE = buildCrcTable()

/** Builds the 256-entry reflected CRC-32 table. */
function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let byteValue = 0; byteValue < 256; byteValue += 1) {
    let remainder = byteValue
    for (let bit = 0; bit < 8; bit += 1) {
      remainder = (remainder & 1) === 1 ? (remainder >>> 1) ^ CRC32_POLYNOMIAL : remainder >>> 1
    }
    table[byteValue] = remainder >>> 0
  }
  return table
}

/**
 * Checksums a byte run the way ZIP does.
 *
 * @param bytes - The data. An empty run returns 0, which is what the format expects for an
 *   empty entry — do not special-case it to something else.
 * @returns The CRC as an unsigned 32-bit number.
 */
export function crc32(bytes: Uint8Array): number {
  let remainder = 0xffffffff
  for (const byte of bytes) {
    remainder = (remainder >>> 8) ^ (CRC32_TABLE[(remainder ^ byte) & 0xff] ?? 0)
  }
  return (remainder ^ 0xffffffff) >>> 0
}

/** A growable little-endian byte buffer. Every ZIP field is little-endian. */
class ByteWriter {
  private readonly chunks: Uint8Array[] = []

  private length = 0

  /** Bytes written so far — also the offset the next write lands at, which is what headers store. */
  get offset(): number {
    return this.length
  }

  pushBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.length += bytes.length
  }

  pushUint16(value: number): void {
    this.pushBytes(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]))
  }

  pushUint32(value: number): void {
    this.pushBytes(
      new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]),
    )
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length)
    let cursor = 0
    for (const chunk of this.chunks) {
      out.set(chunk, cursor)
      cursor += chunk.length
    }
    return out
  }
}

/** Where one entry's local header landed, and what its central directory record has to repeat. */
interface EntryRecord {
  readonly nameBytes: Uint8Array
  readonly checksum: number
  readonly size: number
  readonly localHeaderOffset: number
}

/**
 * Packs entries into a ZIP archive.
 *
 * Order is preserved, which matters for OPC: `[Content_Types].xml` is expected first, and while
 * most readers cope either way, Word is not the only thing that will ever open this.
 *
 * @param entries - Files to pack. Names are written as UTF-8 with the language-encoding flag
 *   unset, so a non-ASCII name is technically out of spec — every name this app writes is ASCII,
 *   and the parts of a `.docx` are fixed by the format anyway.
 * @returns The whole archive.
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const writer = new ByteWriter()
  const records: EntryRecord[] = []

  // Local headers and data first, recording where each landed; the central directory afterwards
  // repeats every field and points back at those offsets.
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const checksum = crc32(entry.bytes)
    const localHeaderOffset = writer.offset

    writer.pushUint32(LOCAL_FILE_HEADER_SIGNATURE)
    writer.pushUint16(VERSION_NEEDED)
    writer.pushUint16(0)
    writer.pushUint16(METHOD_STORED)
    writer.pushUint16(DOS_TIME)
    writer.pushUint16(DOS_DATE)
    writer.pushUint32(checksum)
    writer.pushUint32(entry.bytes.length)
    writer.pushUint32(entry.bytes.length)
    writer.pushUint16(nameBytes.length)
    writer.pushUint16(0)
    writer.pushBytes(nameBytes)
    writer.pushBytes(entry.bytes)

    records.push({ nameBytes, checksum, size: entry.bytes.length, localHeaderOffset })
  }

  const centralDirectoryOffset = writer.offset
  for (const record of records) {
    writer.pushUint32(CENTRAL_FILE_HEADER_SIGNATURE)
    writer.pushUint16(VERSION_NEEDED)
    writer.pushUint16(VERSION_NEEDED)
    writer.pushUint16(0)
    writer.pushUint16(METHOD_STORED)
    writer.pushUint16(DOS_TIME)
    writer.pushUint16(DOS_DATE)
    writer.pushUint32(record.checksum)
    writer.pushUint32(record.size)
    writer.pushUint32(record.size)
    writer.pushUint16(record.nameBytes.length)
    // Extra, comment, disk number, internal attributes, external attributes — all zero. External
    // attributes carry the unix mode on archives that have one; a docx does not.
    writer.pushUint16(0)
    writer.pushUint16(0)
    writer.pushUint16(0)
    writer.pushUint16(0)
    writer.pushUint32(0)
    writer.pushUint32(record.localHeaderOffset)
    writer.pushBytes(record.nameBytes)
  }
  const centralDirectorySize = writer.offset - centralDirectoryOffset

  writer.pushUint32(END_OF_CENTRAL_DIRECTORY_SIGNATURE)
  writer.pushUint16(0)
  writer.pushUint16(0)
  writer.pushUint16(records.length)
  writer.pushUint16(records.length)
  writer.pushUint32(centralDirectorySize)
  writer.pushUint32(centralDirectoryOffset)
  writer.pushUint16(0)

  return writer.finish()
}
