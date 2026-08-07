/**
 * Proves the field registry covers every template row and still quotes the template.
 *
 * Two failure modes this catches. One, a block gains a field in `case.ts` and the UI silently
 * never renders it — the coverage checks compare spec keys against the label records key for
 * key, in order. Two, a Speaker 3 script slot gets reworded to read better, which would break
 * phase 4's compiler against the real document; the slot labels are split on their blanks and
 * every fragment is looked up in the actual `.docx`.
 */

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import {
  CASE_DIVISION_FIELDS,
  CLASH_TITLE_FIELD,
  DEFINITION_FIELDS,
  EXTENSION_FIELDS,
  FIVE_W1H_FIELDS,
  HANDLED_ARGUMENT_FIELD,
  OPPOSING_REBUTTAL_FIELDS,
  OUR_ARGUMENT_FIELDS,
  OVERLAP_FIELDS,
  POLICY_FIELDS,
  POLICY_REBUTTAL_FIELDS,
  PREP_FIELDS,
  REBUTTAL_FIELDS,
  REFUSED_BRANCH_FIELDS,
  RESPONDED_BRANCH_FIELDS,
  SETUP_FIELDS,
  SUBSTANTIVE_FIELDS,
  THEIR_ARGUMENT_FIELDS,
  withOpponentName,
  type FieldSpec,
} from '../fields.ts'
import {
  CASE_DIVISION_LABELS,
  DEFINITION_LABELS,
  EXTENSION_LABELS,
  FIVE_W1H_LABELS,
  OPPOSING_REBUTTAL_LABELS,
  POLICY_LABELS,
  POLICY_REBUTTAL_LABELS,
  REBUTTAL_LABELS,
  SUBSTANTIVE_LABELS,
} from '../../types/case.ts'
import { readDocxParagraphs } from '../../types/__tests__/readDocx.ts'

const BLANK_TEMPLATE = fileURLToPath(
  new URL('../../../reference/template-blank.docx', import.meta.url),
)

// One string holding the whole script. Slot fragments are looked up here rather than
// paragraph by paragraph, because a single template sentence is split across paragraphs
// in a few places where the author pressed return mid-thought.
const templateText = readDocxParagraphs(BLANK_TEMPLATE).join('\n')

/** Every table-backed registry array, paired with the label record it must cover. */
const tableBlocks: [string, readonly FieldSpec[], Readonly<Record<string, string>>][] = [
  ['5W1H', FIVE_W1H_FIELDS, FIVE_W1H_LABELS],
  ['Case Division', CASE_DIVISION_FIELDS, CASE_DIVISION_LABELS],
  ['DEFINITION', DEFINITION_FIELDS, DEFINITION_LABELS],
  ['POLICY', POLICY_FIELDS, POLICY_LABELS],
  ['SUBSTANTIVE STRUCTURE', SUBSTANTIVE_FIELDS, SUBSTANTIVE_LABELS],
  ['POLICY REBUTTAL', POLICY_REBUTTAL_FIELDS, POLICY_REBUTTAL_LABELS],
  ['REBUTTAL', REBUTTAL_FIELDS, REBUTTAL_LABELS],
  ['OPPOSING TEAM REBUTTALS', OPPOSING_REBUTTAL_FIELDS, OPPOSING_REBUTTAL_LABELS],
  ['EXTENSION', EXTENSION_FIELDS, EXTENSION_LABELS],
]

describe('registry covers every row of every table', () => {
  it.each(tableBlocks)('%s has one spec per row, in order', (_name, specs, labels) => {
    expect(specs.map((spec) => spec.key)).toEqual(Object.keys(labels))
  })

  it.each(tableBlocks)('%s quotes the template labels verbatim', (_name, specs, labels) => {
    expect(specs.map((spec) => spec.label)).toEqual(Object.values(labels))
  })
})

describe('prep and set-up cover their text fields', () => {
  // `needsMechanism` and `pois` are excluded on purpose — a tri-state and a list, neither of
  // which is a text box. `caseDivision` has its own array.
  it('prep', () => {
    expect(PREP_FIELDS.map((spec) => spec.key)).toEqual(['motion', 'actorsSplit', 'scratch'])
  })

  it('set-up', () => {
    expect(SETUP_FIELDS.map((spec) => spec.key)).toEqual([
      'characterisation',
      'burdens',
      'policy',
      'stance',
      'oppositionRebuttals',
    ])
  })
})

/** Every registry array, including the script slots, flattened for the whole-registry checks. */
const everySpec: readonly FieldSpec[] = [
  ...PREP_FIELDS,
  ...FIVE_W1H_FIELDS,
  ...SETUP_FIELDS,
  ...CASE_DIVISION_FIELDS,
  ...DEFINITION_FIELDS,
  ...POLICY_FIELDS,
  ...SUBSTANTIVE_FIELDS,
  ...POLICY_REBUTTAL_FIELDS,
  ...REBUTTAL_FIELDS,
  ...OPPOSING_REBUTTAL_FIELDS,
  ...EXTENSION_FIELDS,
  CLASH_TITLE_FIELD,
  HANDLED_ARGUMENT_FIELD,
  ...THEIR_ARGUMENT_FIELDS,
  ...OUR_ARGUMENT_FIELDS,
  ...REFUSED_BRANCH_FIELDS,
  ...RESPONDED_BRANCH_FIELDS,
  ...OVERLAP_FIELDS,
]

describe('every spec is renderable', () => {
  it('has a hint short enough to sit under the label on one line', () => {
    // 110 characters is roughly the width of the field column. A hint that wraps to three
    // lines is a hint nobody reads during a 15-minute prep.
    const overlong = everySpec.filter((spec) => spec.hint.length === 0 || spec.hint.length > 110)
    expect(overlong.map((spec) => spec.key)).toEqual([])
  })

  it('sizes every field to at least one row', () => {
    expect(everySpec.every((spec) => spec.rows >= 1)).toBe(true)
  })
})

/** Script slot arrays, whose labels are template prose rather than table questions. */
const scriptSlots: readonly FieldSpec[] = [
  CLASH_TITLE_FIELD,
  HANDLED_ARGUMENT_FIELD,
  ...THEIR_ARGUMENT_FIELDS,
  ...OUR_ARGUMENT_FIELDS,
  ...REFUSED_BRANCH_FIELDS,
  ...RESPONDED_BRANCH_FIELDS,
  ...OVERLAP_FIELDS,
]

describe('Speaker 3 slot labels still quote the template', () => {
  // The label is the template's sentence with its underscore run replaced by `___`. Splitting
  // on that marker gives the fixed prose either side of the blank, which is what has to match.
  it.each(scriptSlots.map((spec) => [spec.label] as const))('%s', (label) => {
    const fragments = label
      .split('___')
      .map((fragment) => fragment.trim())
      .filter((fragment) => fragment.length > 0)

    expect(fragments.length).toBeGreaterThan(0)
    for (const fragment of fragments) {
      expect(templateText).toContain(fragment)
    }
  })
})

describe('withOpponentName', () => {
  it('leaves opposition labels alone — the template is written from their chair', () => {
    expect(withOpponentName('Prop told us ___', 'opp')).toBe('Prop told us ___')
  })

  it('points a government speaker at the actual opponent', () => {
    expect(withOpponentName('Prop told us ___', 'gov')).toBe('Opp told us ___')
  })

  it('swaps the lowercase form too', () => {
    expect(withOpponentName('This is what happens in prop’s best case: ___', 'gov')).toBe(
      'This is what happens in opp’s best case: ___',
    )
  })

  it('leaves labels that name no bench untouched on either side', () => {
    expect(withOpponentName(SUBSTANTIVE_LABELS.whyBad, 'gov')).toBe(SUBSTANTIVE_LABELS.whyBad)
    expect(withOpponentName(SUBSTANTIVE_LABELS.whyBad, 'opp')).toBe(SUBSTANTIVE_LABELS.whyBad)
  })
})
