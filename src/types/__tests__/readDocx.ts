/**
 * Minimal .docx reader for the template-fidelity test.
 *
 * A .docx is a ZIP holding `word/document.xml`. Rather than depend on a document library
 * for one test, this walks the ZIP central directory and inflates the single entry it needs,
 * then scans the XML for table text. Node's zlib does the decompression.
 *
 * The XML scan assumes tables are not nested, which holds for this template — every table in
 * it is a flat two-column question/answer grid. A nested table would silently mis-group rows.
 */

import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

// ZIP record signatures, little-endian.
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50

// The EOCD record is 22 bytes plus an optional trailing comment of up to 64 KiB.
const MAX_END_OF_CENTRAL_DIRECTORY_SCAN = 22 + 0xffff

/**
 * Locates the end-of-central-directory record.
 *
 * @param archive - Whole ZIP file. A truncated or non-ZIP buffer throws rather than
 *   returning a plausible-looking offset.
 * @returns Byte offset of the EOCD signature.
 */
function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - MAX_END_OF_CENTRAL_DIRECTORY_SCAN)
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset
    }
  }
  throw new Error('Not a ZIP archive: no end-of-central-directory record')
}

/**
 * Extracts one entry from a ZIP archive by exact path.
 *
 * @param archivePath - Path to the .docx on disk.
 * @param entryName - Entry to read, e.g. `word/document.xml`. A name that is not present
 *   throws; a partial match is not attempted.
 * @returns The decompressed entry bytes.
 */
export function readZipEntry(archivePath: string, entryName: string): Buffer {
  const archive = readFileSync(archivePath)
  const endOfCentralDirectory = findEndOfCentralDirectory(archive)
  const entryCount = archive.readUInt16LE(endOfCentralDirectory + 10)
  let cursor = archive.readUInt32LE(endOfCentralDirectory + 16)

  // Walk the central directory. Each header carries the entry name and a pointer back to the
  // local header, where the actual data sits after a second, independently sized name+extra.
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`Corrupt central directory at entry ${entryIndex}`)
    }
    const compressionMethod = archive.readUInt16LE(cursor + 10)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localHeaderOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength)

    if (name === entryName) {
      const localNameLength = archive.readUInt16LE(localHeaderOffset + 26)
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28)
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
      const data = archive.subarray(dataStart, dataStart + compressedSize)
      return compressionMethod === 0 ? Buffer.from(data) : inflateRawSync(data)
    }

    cursor += 46 + nameLength + extraLength + commentLength
  }

  throw new Error(`Entry not found in archive: ${entryName}`)
}

/**
 * Decodes the five predefined XML entities.
 *
 * @param text - Raw text from between XML tags. Numeric character references are not decoded;
 *   Word does not emit them for the characters this template uses.
 * @returns Text with entities resolved.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Concatenates the visible text of a WordprocessingML fragment.
 *
 * @param fragment - XML slice, typically one `w:tc` cell. Runs are joined with no separator
 *   because Word splits a single sentence across runs at formatting boundaries.
 * @returns The fragment's text, whitespace-collapsed and trimmed.
 */
function fragmentText(fragment: string): string {
  const runs = fragment.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) ?? []
  const joined = runs
    .map((run) => run.replace(/<w:t(?:\s[^>]*)?>/, '').replace(/<\/w:t>$/, ''))
    .map(decodeXmlEntities)
    .join('')
  return joined.replace(/\s+/g, ' ').trim()
}

/**
 * Reads every table in a .docx as a grid of cell text.
 *
 * @param docxPath - Path to the .docx. A file that is not a ZIP throws.
 * @returns One entry per table, in document order; each is an array of rows, each row an
 *   array of cell strings.
 */
export function readDocxTables(docxPath: string): string[][][] {
  const documentXml = readZipEntry(docxPath, 'word/document.xml').toString('utf8')
  const tables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []

  return tables.map((table) => {
    const rows = table.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? []
    return rows.map((row) => {
      const cells = row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []
      return cells.map(fragmentText)
    })
  })
}

/**
 * Reads every non-empty paragraph in a .docx, in document order.
 *
 * Paragraphs inside tables are stripped first, so the result is only the loose prose — the
 * prep sheet, CASE SET-UP labels, and the Speaker 3 script.
 *
 * @param docxPath - Path to the .docx. A file that is not a ZIP throws.
 * @returns Paragraph text, empties removed.
 */
export function readDocxParagraphs(docxPath: string): string[] {
  const documentXml = readZipEntry(docxPath, 'word/document.xml').toString('utf8')
  const withoutTables = documentXml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, '')
  const paragraphs = withoutTables.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []
  return paragraphs.map(fragmentText).filter((text) => text.length > 0)
}
