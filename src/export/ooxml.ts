/**
 * The WordprocessingML this app writes, and the five-part package it goes in.
 *
 * A `.docx` is a ZIP of XML parts. Only five are needed for a document made of headings and
 * two-column tables, and they are written out here as string templates rather than built through
 * a document library — the same trade `readDocx.ts` made in the other direction, for the same
 * reason: one file of known XML beats a dependency whose output nobody in this repo can predict.
 *
 * **Everything a debater typed goes through {@link escapeXml}.** A motion containing `&` or a
 * substantive quoting `<` produces a file Word refuses to open, and the failure arrives as
 * "the file is corrupt" days later rather than as an error here.
 */

import { buildZip, type ZipEntry } from './zip.ts'

/** A4 portrait, in twentieths of a point — the unit every measurement below is in. */
const PAGE_WIDTH = 11906
const PAGE_HEIGHT = 16838
const PAGE_MARGIN = 1134

/** Usable width between the margins, split between the two columns of every table. */
const LABEL_COLUMN_WIDTH = 3500
const VALUE_COLUMN_WIDTH = PAGE_WIDTH - 2 * PAGE_MARGIN - LABEL_COLUMN_WIDTH

/** Paragraph styles defined in `word/styles.xml`. Anything else falls back to Normal. */
export type ParagraphStyle = 'Normal' | 'Title' | 'Heading1' | 'Heading2' | 'Meta'

/** The four characters that cannot appear literally in XML content or a quoted attribute. */
const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

/**
 * Escapes text for an XML text node or attribute value.
 *
 * Also drops the C0 control characters XML 1.0 forbids outright. They cannot be typed into a
 * textarea but they can arrive through a paste from a PDF, and one of them makes the whole
 * document unopenable — a failure that surfaces as Word's generic repair prompt with nothing
 * pointing back at the field that carried it.
 *
 * @param text - Raw text. Already-escaped input is escaped again, so never call this twice.
 * @returns Text safe to place between tags or inside a quoted attribute.
 */
export function escapeXml(text: string): string {
  let escaped = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    // Tab, newline and carriage return are the only C0 characters XML 1.0 permits; any other
    // one makes the whole package unopenable, so it is dropped rather than encoded.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      continue
    }
    escaped += XML_ESCAPES[character] ?? character
  }
  return escaped
}

/** Style reference, or nothing at all for Normal — Word treats an absent `pStyle` as default. */
function styleProperty(style: ParagraphStyle): string {
  return style === 'Normal' ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
}

/**
 * Renders one paragraph.
 *
 * @param text - The paragraph's text. Empty produces an empty paragraph, which is how vertical
 *   space is made in WordprocessingML — there is no margin to set from here.
 * @param style - Paragraph style. Defaults to Normal.
 * @returns One `w:p` element.
 */
export function paragraph(text: string, style: ParagraphStyle = 'Normal'): string {
  const properties = styleProperty(style)
  if (text.length === 0) {
    return `<w:p>${properties}</w:p>`
  }
  // `xml:space="preserve"` unconditionally: without it Word collapses the leading and trailing
  // spaces of a run, and a field that ends mid-sentence loses the space before the next one.
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

/**
 * Renders a block of text as one paragraph per line.
 *
 * A textarea's newlines are the debater's own paragraphing — a list of three harms, a numbered
 * mechanism — and flattening them into one run loses the only structure the field had.
 *
 * @param text - Possibly multi-line. Empty produces a single empty paragraph, because a table
 *   cell with no paragraph in it is invalid WordprocessingML.
 * @param style - Style applied to every line.
 * @returns One or more `w:p` elements.
 */
export function paragraphs(text: string, style: ParagraphStyle = 'Normal'): string {
  if (text.length === 0) {
    return paragraph('', style)
  }
  return text
    .split(/\r?\n/)
    .map((line) => paragraph(line, style))
    .join('')
}

/** One row of a label/value table. */
export interface TableRow {
  /** Left column. Rendered bold; this is the template's question. */
  readonly label: string
  /** Right column. Multi-line is expected and becomes one paragraph per line. */
  readonly value: string
}

/** A cell holding pre-rendered paragraphs, at a fixed width. */
function cell(width: number, content: string): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${String(width)}" w:type="dxa"/></w:tcPr>${content}</w:tc>`
}

/** Bold paragraphs, for the question column. */
function boldParagraphs(text: string): string {
  return text
    .split(/\r?\n/)
    .map(
      (line) =>
        `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
    )
    .join('')
}

/**
 * Renders a two-column table: the template's question on the left, the answer on the right.
 *
 * @param rows - Rows in document order. An empty array returns an empty string rather than an
 *   empty table — Word renders a table with no rows as a repair prompt.
 * @returns The `w:tbl` element followed by an empty paragraph. That paragraph is not decoration:
 *   two adjacent tables with nothing between them are merged into one by Word.
 */
export function table(rows: readonly TableRow[]): string {
  if (rows.length === 0) {
    return ''
  }

  const border = '<w:top w:val="single" w:sz="4" w:color="BFBFBF"/>'
  const borders = [
    '<w:tblBorders>',
    border,
    '<w:left w:val="single" w:sz="4" w:color="BFBFBF"/>',
    '<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/>',
    '<w:right w:val="single" w:sz="4" w:color="BFBFBF"/>',
    '<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/>',
    '<w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>',
    '</w:tblBorders>',
  ].join('')

  const properties = [
    '<w:tblPr>',
    '<w:tblW w:w="0" w:type="auto"/>',
    borders,
    // Fixed layout so the grid below is honoured. Auto-fit would size the question column to
    // whichever row happens to be longest, which on the substantive table is a paragraph.
    '<w:tblLayout w:type="fixed"/>',
    '<w:tblCellMar>',
    '<w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>',
    '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>',
    '</w:tblCellMar>',
    '</w:tblPr>',
    `<w:tblGrid><w:gridCol w:w="${String(LABEL_COLUMN_WIDTH)}"/>`,
    `<w:gridCol w:w="${String(VALUE_COLUMN_WIDTH)}"/></w:tblGrid>`,
  ].join('')

  const body = rows
    .map(
      (row) =>
        `<w:tr>${cell(LABEL_COLUMN_WIDTH, boldParagraphs(row.label))}${cell(
          VALUE_COLUMN_WIDTH,
          paragraphs(row.value),
        )}</w:tr>`,
    )
    .join('')

  return `<w:tbl>${properties}${body}</w:tbl>${paragraph('')}`
}

/** XML declaration. Word writes `standalone="yes"` and so does everything that reads it. */
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const WORDPROCESSING_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** Page setup. Always last in the body — `w:sectPr` describes the section that precedes it. */
const SECTION_PROPERTIES =
  `<w:sectPr><w:pgSz w:w="${String(PAGE_WIDTH)}" w:h="${String(PAGE_HEIGHT)}"/>` +
  `<w:pgMar w:top="${String(PAGE_MARGIN)}" w:right="${String(PAGE_MARGIN)}" ` +
  `w:bottom="${String(PAGE_MARGIN)}" w:left="${String(PAGE_MARGIN)}" ` +
  'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'

/**
 * One style definition. `outlineLvl` is what puts a heading in Word's navigation pane.
 *
 * The children of `w:pPr` and `w:rPr` are a *sequence* in the schema, not a set: `w:spacing`
 * comes before `w:outlineLvl` and `w:b` before `w:sz`, and Word rejects the whole document with
 * "unreadable content" if they are the other way round. Well-formed XML is not enough here.
 */
function styleDefinition(
  styleId: string,
  name: string,
  runProperties: string,
  paragraphProperties: string,
): string {
  return (
    `<w:style w:type="paragraph" w:styleId="${styleId}"><w:name w:val="${name}"/>` +
    `<w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:pPr>${paragraphProperties}</w:pPr><w:rPr>${runProperties}</w:rPr></w:style>`
  )
}

/**
 * `word/styles.xml`.
 *
 * Font sizes are in half-points, so `w:sz w:val="22"` is 11pt. Calibri because it is present on
 * every Windows install and on Word for the web; a font the reader lacks is substituted silently
 * and the export stops looking like the template.
 */
const STYLES_XML =
  `${XML_DECLARATION}<w:styles xmlns:w="${WORDPROCESSING_NAMESPACE}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/>' +
  '</w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  styleDefinition('Title', 'Title', '<w:b/><w:sz w:val="36"/>', '<w:spacing w:after="60"/>') +
  styleDefinition(
    'Heading1',
    'heading 1',
    '<w:b/><w:sz w:val="28"/>',
    '<w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/>',
  ) +
  styleDefinition(
    'Heading2',
    'heading 2',
    '<w:b/><w:sz w:val="24"/>',
    '<w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/>',
  ) +
  styleDefinition('Meta', 'Meta', '<w:color w:val="595959"/><w:sz w:val="18"/>', '') +
  '</w:styles>'

const CONTENT_TYPES_XML =
  `${XML_DECLARATION}` +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '</Types>'

const PACKAGE_RELATIONSHIPS_XML =
  `${XML_DECLARATION}` +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>'

const DOCUMENT_RELATIONSHIPS_XML =
  `${XML_DECLARATION}` +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>'

/**
 * Wraps a rendered body into a complete `.docx`.
 *
 * @param body - Block-level XML: paragraphs and tables, already escaped. Passing raw user text
 *   here writes a file Word cannot open — go through {@link paragraph} or {@link table}.
 * @returns The whole archive, ready to write to disk.
 */
export function buildDocx(body: string): Uint8Array {
  const documentXml =
    `${XML_DECLARATION}<w:document xmlns:w="${WORDPROCESSING_NAMESPACE}">` +
    `<w:body>${body}${SECTION_PROPERTIES}</w:body></w:document>`

  const encoder = new TextEncoder()
  // `[Content_Types].xml` first: the OPC spec requires readers to find it, and some do so by
  // reading the first entry rather than by walking the central directory.
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', bytes: encoder.encode(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', bytes: encoder.encode(PACKAGE_RELATIONSHIPS_XML) },
    { name: 'word/document.xml', bytes: encoder.encode(documentXml) },
    { name: 'word/_rels/document.xml.rels', bytes: encoder.encode(DOCUMENT_RELATIONSHIPS_XML) },
    { name: 'word/styles.xml', bytes: encoder.encode(STYLES_XML) },
  ]
  return buildZip(entries)
}
