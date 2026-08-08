/**
 * The speech sheet, against the same compiled fixture phase 4 and phase 6 use.
 *
 * The sheet adds nothing to `compileScript` except grouping and a header, so what is worth
 * pinning is exactly that: consecutive segments merge under one heading, the gap list survives,
 * and the length estimate is compared against the right slot.
 */

import { describe, expect, it } from 'vitest'

import { buildFilledExampleCase } from '../../analysis/__tests__/fixture.ts'
import { buildWhipCase } from '../../script/__tests__/whipFixture.ts'
import { getFormat, getRole } from '../../formats/index.ts'
import { compileScript } from '../../script/compile.ts'
import { createEmptyCase } from '../../types/createCase.ts'
import { buildSpeechSheet } from '../speechSheet.ts'

/** The seat a case says it is for. Throws rather than falling back — a wrong seat is a wrong sheet. */
function roleOf(caseFile: ReturnType<typeof buildFilledExampleCase>) {
  const role = getRole(caseFile.format, caseFile.position)
  if (!role) {
    throw new Error(`fixture has no role: ${caseFile.position}`)
  }
  return role
}

describe('buildSpeechSheet', () => {
  const caseFile = buildFilledExampleCase()
  const sheet = buildSpeechSheet(caseFile, roleOf(caseFile))

  it('heads the sheet with the motion and the seat', () => {
    expect(sheet.motion).toBe(caseFile.prep.motion)
    expect(sheet.meta).toBe('Asian Parliamentary · Government · Prime Minister')
  })

  it('carries the compiler’s own word count and estimate', () => {
    const script = compileScript(caseFile, roleOf(caseFile))
    expect(sheet.wordCount).toBe(script.wordCount)
    expect(sheet.estimatedSeconds).toBe(script.estimatedSeconds)
  })

  it('measures against the format’s slot, not a constant', () => {
    expect(sheet.speechSeconds).toBe(getFormat('AP').speechSeconds)
    expect(sheet.isOverLength).toBe(sheet.estimatedSeconds > sheet.speechSeconds)
  })

  it('loses no paragraph to the grouping', () => {
    const script = compileScript(caseFile, roleOf(caseFile))
    const paragraphCount = sheet.sections.reduce(
      (total, section) => total + section.paragraphs.length,
      0,
    )
    expect(paragraphCount).toBe(script.segments.length)
  })

  it('keeps the paragraphs in delivery order', () => {
    const script = compileScript(caseFile, roleOf(caseFile))
    expect(sheet.sections.flatMap((section) => section.paragraphs)).toEqual(
      script.segments.map((segment) => segment.text),
    )
  })

  it('merges consecutive segments that share a heading', () => {
    // The setup block compiles to two segments — the opening and the case division — under one
    // nav label, and a sheet that repeated "Set-up" above each is harder to find a place in.
    const headings = sheet.sections.map((section) => section.heading)
    expect(new Set(headings).size).toBe(headings.length)
  })

  it('names the lines that cannot be said yet', () => {
    const script = compileScript(caseFile, roleOf(caseFile))
    expect(sheet.gaps).toEqual(script.gaps)
    // The example leaves CASE SET-UP entirely blank, so there is plenty here.
    expect(sheet.gaps.length).toBeGreaterThan(0)
  })
})

describe('the sheet at both ends of a prep', () => {
  it('is empty but not broken on a case with nothing in it', () => {
    const blank = createEmptyCase('BP', 'gov', 'bp-pm')
    const sheet = buildSpeechSheet(blank, roleOf(blank))

    expect(sheet.motion).toBe('Untitled case')
    expect(sheet.sections).toEqual([])
    expect(sheet.wordCount).toBe(0)
    expect(sheet.isOverLength).toBe(false)
    // Every line is a gap, which is the whole content of the sheet at this point.
    expect(sheet.gaps.length).toBeGreaterThan(0)
  })

  it('lays a whip’s clash script out under its own headings', () => {
    const whip = buildWhipCase()
    const sheet = buildSpeechSheet(whip, roleOf(whip))

    expect(sheet.meta).toBe('British Parliamentary · Opposition · Opposition Whip')
    // A clash's signpost and each of its engagements are separate headings, because they are
    // separate places to look when you lose your line.
    expect(sheet.sections.map((section) => section.heading)).toContain('Clash 1')
    expect(
      sheet.sections.some((section) => section.heading.startsWith('Clash 1 — ')),
    ).toBe(true)
    expect(sheet.wordCount).toBeGreaterThan(100)
  })
})
