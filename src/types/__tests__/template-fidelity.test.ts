/**
 * Proves the data model still mirrors `reference/template-blank.docx` 1:1.
 *
 * This reads the real .docx on every run rather than a checked-in fixture, so editing a label
 * in `case.ts` to something that "reads better" fails here. If the template itself changes,
 * the template is the thing to change first — then these expectations follow.
 */

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import {
  CASE_DIVISION_LABELS,
  DEFINITION_LABELS,
  FIVE_W1H_LABELS,
  OPPOSING_REBUTTAL_LABELS,
  POLICY_LABELS,
  POLICY_REBUTTAL_LABELS,
  PREP_LABELS,
  REBUTTAL_LABELS,
  SETUP_LABELS,
  SUBSTANTIVE_LABELS,
} from '../case.ts'
import { readDocxParagraphs, readDocxTables } from './readDocx.ts'

const BLANK_TEMPLATE = fileURLToPath(
  new URL('../../../reference/template-blank.docx', import.meta.url),
)
const FILLED_TEMPLATE = fileURLToPath(
  new URL('../../../reference/template-filled-example.docx', import.meta.url),
)

// The blank template's tables, in document order. The index is the contract: table 2 is the
// substantive scaffold, and a new table inserted above it would shift everything below.
const [
  definitionTable,
  policyTable,
  substantiveTable,
  policyRebuttalTable,
  rebuttalTable,
  opposingRebuttalTable,
] = readDocxTables(BLANK_TEMPLATE)

const blankParagraphs = readDocxParagraphs(BLANK_TEMPLATE)

/**
 * Pulls the question column out of a template table.
 *
 * @param table - Rows of a two-column table. The second column is the answer area and is
 *   empty in the blank template; only the first is a label.
 * @returns One label per row, in order.
 */
function questionColumn(table: string[][] | undefined): string[] {
  if (!table) {
    throw new Error('Expected table missing from template-blank.docx')
  }
  return table.map((row) => row[0] ?? '')
}

describe('template-blank.docx structure', () => {
  it('has the six tables the data model expects', () => {
    expect(readDocxTables(BLANK_TEMPLATE)).toHaveLength(6)
  })

  it('keeps the substantive scaffold at nine rows', () => {
    // The 9 rows are the depth rubric. Losing one silently drops a rule in phase 3.
    expect(substantiveTable).toHaveLength(9)
  })
})

describe('table labels match the template verbatim', () => {
  it('DEFINITION', () => {
    expect(questionColumn(definitionTable)).toEqual(Object.values(DEFINITION_LABELS))
  })

  it('POLICY', () => {
    expect(questionColumn(policyTable)).toEqual(Object.values(POLICY_LABELS))
  })

  it('SUBSTANTIVE STRUCTURE', () => {
    expect(questionColumn(substantiveTable)).toEqual(Object.values(SUBSTANTIVE_LABELS))
  })

  it('POLICY REBUTTAL', () => {
    expect(questionColumn(policyRebuttalTable)).toEqual(Object.values(POLICY_REBUTTAL_LABELS))
  })

  it('REBUTTAL', () => {
    expect(questionColumn(rebuttalTable)).toEqual(Object.values(REBUTTAL_LABELS))
  })

  it('OPPOSING TEAM REBUTTALS', () => {
    expect(questionColumn(opposingRebuttalTable)).toEqual(Object.values(OPPOSING_REBUTTAL_LABELS))
  })
})

describe('prep sheet and case set-up labels appear verbatim', () => {
  it.each(Object.entries(PREP_LABELS))('prep label %s', (_key, label) => {
    expect(blankParagraphs).toContain(label)
  })

  it.each(Object.entries(SETUP_LABELS))('setup label %s', (_key, label) => {
    expect(blankParagraphs).toContain(label)
  })

  it.each(Object.entries(CASE_DIVISION_LABELS))('case division label %s', (_key, label) => {
    expect(blankParagraphs).toContain(label)
  })

  it('keeps "Rebuttals (if opp 1)" between Stance and Case Division', () => {
    // This field is easy to miss when reading the template quickly — it sits in CASE SET-UP,
    // separate from the REBUTTAL table, because opposition's first speaker rebuts before
    // running their own case.
    const stanceIndex = blankParagraphs.indexOf(SETUP_LABELS.stance)
    const rebuttalsIndex = blankParagraphs.indexOf(SETUP_LABELS.oppositionRebuttals)
    const divisionIndex = blankParagraphs.indexOf(SETUP_LABELS.caseDivision)

    expect(stanceIndex).toBeGreaterThanOrEqual(0)
    expect(rebuttalsIndex).toBeGreaterThan(stanceIndex)
    expect(divisionIndex).toBeGreaterThan(rebuttalsIndex)
  })
})

describe('5W1H sub-prompts match the filled example', () => {
  // The blank template gives a bare "5W1H:" line; the six prompts below are how the template's
  // author actually expanded it, so the filled example is the authority for these.
  const filledParagraphs = readDocxParagraphs(FILLED_TEMPLATE)

  // Matched by prefix, not equality: the author answered some prompts inline on the same
  // line ("When - NIL"), so the prompt is the start of the paragraph rather than all of it.
  it.each(Object.entries(FIVE_W1H_LABELS))('%s prompt', (_key, label) => {
    expect(filledParagraphs.some((paragraph) => paragraph.startsWith(label))).toBe(true)
  })
})

describe('Speaker 3 script slots the compiler depends on', () => {
  // Phase 4 slot-fills these skeletons directly. If the template's wording changes, the
  // compiler's output changes with it, so the exact phrases are pinned here.
  const requiredPhrases = [
    'I have two clashes for the house.',
    'They refused to respond. This is bad because',
    '(OR)',
    'In response they told us',
    'Even if we accept their characterisation of',
    'Furthermore, their argument is tenuous, and this is my extension because',
    'What did we tell you? In',
    'Moving on to my second clash on',
    'Their response is problematic because',
  ]

  it.each(requiredPhrases)('contains %s', (phrase) => {
    expect(blankParagraphs.some((paragraph) => paragraph.includes(phrase))).toBe(true)
  })

  it('has an overlap variant', () => {
    expect(blankParagraphs).toContain('IF THE ARGUMENTS OVERLAP, SAY THIS')
  })
})
