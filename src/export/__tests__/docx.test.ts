/**
 * The `.docx` export, read back with the reader that reads the real template.
 *
 * Two things are being proved and they are different. That the file is a well-formed Word
 * document is proved by `readDocxTables` finding tables in it at all — that function is what
 * every fidelity test in the repo runs against `reference/template-blank.docx`. That it is the
 * *template's* layout is proved by looking the exported question column back up in the blank
 * template itself, which is the same guarantee `skeleton.test.ts` gives the compiler.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFilledExampleCase } from '../../analysis/__tests__/fixture.ts'
import { readDocxParagraphs, readDocxTables, readZipEntry } from '../../types/__tests__/readDocx.ts'
import { SUBSTANTIVE_LABELS } from '../../types/case.ts'
import { createEmptyCase, createPreempt } from '../../types/createCase.ts'
import { setFieldByPath } from '../../case/update.ts'
import { buildCaseDocx } from '../docx.ts'

const BLANK_TEMPLATE = fileURLToPath(
  new URL('../../../reference/template-blank.docx', import.meta.url),
)

const EXPORTED_ON = '2026-08-09'

const workingDirectory = mkdtempSync(join(tmpdir(), 'debate-docx-'))

afterAll(() => {
  rmSync(workingDirectory, { recursive: true, force: true })
})

/** Writes an export to disk and returns its path, so the on-disk reader can open it. */
function writeExport(name: string, bytes: Uint8Array): string {
  const path = join(workingDirectory, name)
  writeFileSync(path, bytes)
  return path
}

/** Every heading `buildSections` can produce, so the order test does not depend on casing. */
const BLOCK_TITLES = [
  'PREP SHEET',
  'CASE SET-UP',
  'DEFINITION',
  'POLICY',
  'SUBSTANTIVE STRUCTURE',
  'POLICY REBUTTAL',
  'REBUTTAL',
  'OPPOSING TEAM REBUTTALS',
  'THIRD SPEAKER',
  'EXTENSION',
]

/** The table whose first row's question is `label`, or undefined. */
function tableWithQuestion(tables: string[][][], label: string): string[][] | undefined {
  return tables.find((rows) => rows[0]?.[0] === label)
}

const filledPath = writeExport('filled.docx', buildCaseDocx(buildFilledExampleCase(), EXPORTED_ON))
const filledTables = readDocxTables(filledPath)
const filledParagraphs = readDocxParagraphs(filledPath)

describe('buildCaseDocx', () => {
  it('opens as a Word document with tables in it', () => {
    expect(filledTables.length).toBeGreaterThan(5)
    expect(readZipEntry(filledPath, 'word/styles.xml').length).toBeGreaterThan(0)
  })

  it('leads with the motion and the seat', () => {
    expect(filledParagraphs[0]).toBe(buildFilledExampleCase().prep.motion)
    expect(filledParagraphs[1]).toBe(
      'Asian Parliamentary · Government · Prime Minister · exported 2026-08-09',
    )
  })

  it('prints every block the case has, in the template’s order', () => {
    const printed = filledParagraphs.filter((text) =>
      BLOCK_TITLES.some((title) => text === title || text.startsWith(`${title} — `)),
    )
    expect(printed).toEqual([
      'PREP SHEET',
      'CASE SET-UP',
      'DEFINITION',
      'POLICY',
      'SUBSTANTIVE STRUCTURE — Sub 1',
      'SUBSTANTIVE STRUCTURE — Sub 2',
      'SUBSTANTIVE STRUCTURE — Sub 3',
      'POLICY REBUTTAL',
      'REBUTTAL',
      'OPPOSING TEAM REBUTTALS',
    ])
  })

  it('names each substantive table so three of them are tellable apart', () => {
    expect(filledParagraphs).toContain('SUBSTANTIVE STRUCTURE — Sub 1')
    expect(filledParagraphs).toContain('SUBSTANTIVE STRUCTURE — Sub 2')
    expect(filledParagraphs).toContain('SUBSTANTIVE STRUCTURE — Sub 3')
    // A block that appears once keeps the template's heading with nothing appended.
    expect(filledParagraphs).toContain('DEFINITION')
  })

  it('asks the substantive questions verbatim, in template order', () => {
    const substantive = tableWithQuestion(filledTables, SUBSTANTIVE_LABELS.oneSentence)
    expect(substantive).toBeDefined()
    expect(substantive?.map((row) => row[0])).toEqual(Object.values(SUBSTANTIVE_LABELS))
  })

  it('asks questions that are still in the blank template', () => {
    // The claim this export makes is "the original template layout". `fields.ts` imports its
    // labels from the `*_LABELS` records rather than retyping them, so this holds by
    // construction — and this is what fails if someone ever stops importing them.
    const templateQuestions = new Set(
      readDocxTables(BLANK_TEMPLATE).flatMap((rows) => rows.map((row) => row[0] ?? '')),
    )
    const substantive = tableWithQuestion(filledTables, SUBSTANTIVE_LABELS.oneSentence)
    for (const row of substantive ?? []) {
      expect(templateQuestions).toContain(row[0])
    }
  })

  it('carries the answers across', () => {
    const substantive = tableWithQuestion(filledTables, SUBSTANTIVE_LABELS.oneSentence)
    expect(substantive?.[0]?.[1]).toBe('Fake news causes irreparable damage')
    // Row 9 is `link`, which the example left blank — an unanswered question is still printed.
    expect(substantive?.at(-1)?.[0]).toBe(SUBSTANTIVE_LABELS.link)
    expect(substantive?.at(-1)?.[1]).toBe('')
  })

  it('writes the same bytes twice for one case', () => {
    const once = buildCaseDocx(buildFilledExampleCase(), EXPORTED_ON)
    const twice = buildCaseDocx(buildFilledExampleCase(), EXPORTED_ON)
    expect(once).toEqual(twice)
  })
})

describe('what the export refuses to invent', () => {
  it('omits POLICY when the case answered no to the mechanism question', () => {
    const withoutPolicy = { ...buildFilledExampleCase(), policy: null }
    const paragraphs = readDocxParagraphs(
      writeExport('no-policy.docx', buildCaseDocx(withoutPolicy, EXPORTED_ON)),
    )
    expect(paragraphs).not.toContain('POLICY')
    expect(paragraphs).toContain('POLICY REBUTTAL')
  })

  it('omits a repeatable block with no items rather than printing a blank one', () => {
    const withoutRebuttals = { ...buildFilledExampleCase(), rebuttals: [] }
    const paragraphs = readDocxParagraphs(
      writeExport('no-rebuttals.docx', buildCaseDocx(withoutRebuttals, EXPORTED_ON)),
    )
    expect(paragraphs).not.toContain('REBUTTAL')
    expect(paragraphs).toContain('OPPOSING TEAM REBUTTALS')
  })

  it('says so when the seat does not resolve', () => {
    const unassigned = { ...buildFilledExampleCase(), position: '' }
    const paragraphs = readDocxParagraphs(
      writeExport('unassigned.docx', buildCaseDocx(unassigned, EXPORTED_ON)),
    )
    expect(paragraphs[1]).toContain('no position assigned')
  })

  it('titles an unwritten motion rather than printing nothing', () => {
    const blank = createEmptyCase('BP', 'gov', 'bp-pm')
    const paragraphs = readDocxParagraphs(
      writeExport('blank.docx', buildCaseDocx(blank, EXPORTED_ON)),
    )
    expect(paragraphs[0]).toBe('Untitled case')
  })
})

describe('text that would otherwise produce a file Word cannot open', () => {
  /** Builds a one-field case carrying `value` in the motion, and reads that cell back. */
  function motionRoundTrip(value: string, name: string): string {
    const withMotion = setFieldByPath(createEmptyCase('AP', 'gov', 'ap-pm'), 'prep.motion', value)
    const path = writeExport(name, buildCaseDocx(withMotion, EXPORTED_ON))
    const prep = readDocxTables(path)[0]
    return prep?.[0]?.[1] ?? ''
  }

  it('round-trips the three characters that break XML', () => {
    const motion = 'THW ban "profit & loss" reporting <in schools>'
    expect(motionRoundTrip(motion, 'escapes.docx')).toBe(motion)
  })

  it('round-trips an apostrophe and an em dash', () => {
    const motion = 'THBT Prop’s case — as characterised — fails'
    expect(motionRoundTrip(motion, 'punctuation.docx')).toBe(motion)
  })

  it('drops a control character rather than writing an unopenable package', () => {
    // A vertical tab arrives by pasting out of a PDF. Word reports the whole file as corrupt
    // and names nothing, so it is dropped at the one place that can see it. Built rather than
    // written literally, so the character survives this file being edited.
    const verticalTab = String.fromCharCode(0x0b)
    const motion = [`THW ban`, verticalTab, `things`].join(``)
    expect(motionRoundTrip(motion, 'control.docx')).toBe('THW banthings')
  })

  it('keeps a multi-line answer as separate paragraphs', () => {
    const withLines = setFieldByPath(
      createEmptyCase('AP', 'gov', 'ap-pm'),
      'prep.actorsSplit',
      'Social media companies\nIndividuals in society',
    )
    const path = writeExport('multiline.docx', buildCaseDocx(withLines, EXPORTED_ON))
    const documentXml = readZipEntry(path, 'word/document.xml').toString('utf8')

    // The reader joins every run in a cell with no separator, so a round trip cannot tell one
    // paragraph from two. The XML can.
    expect(documentXml).toContain(
      '<w:t xml:space="preserve">Social media companies</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">Individuals in society</w:t>',
    )
  })
})

describe('preempts', () => {
  it('prints an answered attack under the substantive it defends', () => {
    const caseFile = buildFilledExampleCase()
    const withPreempt = {
      ...caseFile,
      substantives: caseFile.substantives.map((substantive) =>
        substantive.id === 'sub-1'
          ? {
              ...substantive,
              preempts: [
                {
                  ...createPreempt('claude'),
                  attack: 'Criminal liability will make platforms over-remove lawful speech.',
                  response: 'The review team is the check; only flagged posts reach it.',
                },
              ],
            }
          : substantive,
      ),
    }

    const path = writeExport('preempts.docx', buildCaseDocx(withPreempt, EXPORTED_ON))
    expect(readDocxParagraphs(path)).toContain('Preempts')

    const preemptTable = tableWithQuestion(readDocxTables(path), 'Anticipated attack (Claude)')
    expect(preemptTable?.[0]?.[1]).toBe(
      'Criminal liability will make platforms over-remove lawful speech.',
    )
    expect(preemptTable?.[1]).toEqual([
      'My answer',
      'The review team is the check; only flagged posts reach it.',
    ])
  })

  it('skips a preempt nobody wrote anything into', () => {
    const caseFile = buildFilledExampleCase()
    const withEmpty = {
      ...caseFile,
      substantives: caseFile.substantives.map((substantive) =>
        substantive.id === 'sub-1' ? { ...substantive, preempts: [createPreempt()] } : substantive,
      ),
    }
    const path = writeExport('empty-preempt.docx', buildCaseDocx(withEmpty, EXPORTED_ON))
    expect(readDocxParagraphs(path)).not.toContain('Preempts')
  })
})
