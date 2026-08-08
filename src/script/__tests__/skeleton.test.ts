/**
 * Proves the compiler still says what the template says, and still fills every blank it has.
 *
 * Two failure modes, and the whole phase rests on catching both.
 *
 * One: a phrase in `skeleton.ts` gets reworded because it reads better. It probably does — the
 * template is a Word document a sixth-former wrote — but the moment the compiler stops quoting
 * it, the case builder and the speech stop being the same document, and the reason the two
 * halves of this app are one pipeline quietly evaporates. Every phrase of three words or more
 * is looked back up in the real `.docx`.
 *
 * Two: a slot names a field that does not exist. That does not throw, by design — a mistyped
 * key silently drops its line rather than taking a speech down mid-round — so it has to be
 * caught here or not at all. Both directions are checked: every slot has a registry row, and
 * every registry row is either said or listed below as deliberately unspoken.
 */

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import {
  CASE_DIVISION_FIELDS,
  DEFINITION_FIELDS,
  EXTENSION_FIELDS,
  OPPOSING_REBUTTAL_FIELDS,
  OUR_ARGUMENT_FIELDS,
  OVERLAP_FIELDS,
  POLICY_FIELDS,
  POLICY_REBUTTAL_FIELDS,
  REBUTTAL_FIELDS,
  REFUSED_BRANCH_FIELDS,
  RESPONDED_BRANCH_FIELDS,
  SETUP_FIELDS,
  SUBSTANTIVE_FIELDS,
  THEIR_ARGUMENT_FIELDS,
  type FieldSpec,
} from '../../case/fields.ts'
import { readDocxParagraphs } from '../../types/__tests__/readDocx.ts'
import type { LineTemplate } from '../lines.ts'
import {
  OUR_ARGUMENT_LINES,
  OVERLAP_LINES,
  REFUSED_BRANCH_LINES,
  respondedBranchLines,
  TEMPLATE_PROSE,
  THEIR_ARGUMENT_LINES,
} from '../skeleton.ts'
import {
  CASE_DIVISION_LINES,
  DEFINITION_LINES,
  EXTENSION_LINES,
  OPPOSING_REBUTTAL_LINES,
  POLICY_LINES,
  POLICY_REBUTTAL_LINES,
  REBUTTAL_LINES,
  SETUP_LINES,
  SUBSTANTIVE_LINES,
} from '../signposts.ts'

const BLANK_TEMPLATE = fileURLToPath(
  new URL('../../../reference/template-blank.docx', import.meta.url),
)

// The document writes its blanks as long runs of underscores, and Word breaks a single sentence
// across paragraphs wherever the author pressed return mid-thought. Collapsing both leaves one
// string in which a template sentence is contiguous, which is what makes `toContain` meaningful.
const templateText = readDocxParagraphs(BLANK_TEMPLATE)
  .join('\n')
  .replace(/_+/g, ' ')
  .replace(/\s+/g, ' ')

/** Words in a phrase, ignoring its punctuation. */
function wordCount(phrase: string): number {
  return (phrase.match(/\p{L}+/gu) ?? []).length
}

describe('the script still quotes the template', () => {
  // Under three words a fragment is punctuation and glue — "In", ". But my", "stands." — and
  // pinning those tests the join rules rather than the document.
  const phrases = [...new Set(TEMPLATE_PROSE)].filter((phrase) => wordCount(phrase) >= 3)

  it('has phrases worth checking', () => {
    expect(phrases.length).toBeGreaterThan(20)
  })

  it.each(phrases.map((phrase) => [phrase] as const))('%s', (phrase) => {
    expect(templateText).toContain(phrase)
  })
})

/** Slot keys used by a run of line templates, in order of first appearance. */
function slotKeys(templates: readonly LineTemplate[]): readonly string[] {
  const keys: string[] = []
  for (const line of templates) {
    for (const part of line) {
      if (part.kind === 'slot' && !keys.includes(part.key)) {
        keys.push(part.key)
      }
    }
  }
  return keys
}

/**
 * Registry rows the script deliberately never says.
 *
 * "S1:", "S2:" and "S3:" are notes to the team about who covers what. Reading them to a judge
 * would be reading the prep sheet out loud.
 */
const NOT_SPOKEN: ReadonlyMap<string, readonly string[]> = new Map([
  ['Case Division', ['speaker1', 'speaker2', 'speaker3']],
])

/** Every template paired with the registry it fills, by the name used in the failure message. */
const blocks: [string, readonly LineTemplate[], readonly FieldSpec[]][] = [
  ['CASE SET-UP', SETUP_LINES, SETUP_FIELDS],
  ['Case Division', CASE_DIVISION_LINES, CASE_DIVISION_FIELDS],
  ['DEFINITION', DEFINITION_LINES, DEFINITION_FIELDS],
  ['POLICY', POLICY_LINES, POLICY_FIELDS],
  ['SUBSTANTIVE STRUCTURE', SUBSTANTIVE_LINES, SUBSTANTIVE_FIELDS],
  ['POLICY REBUTTAL', POLICY_REBUTTAL_LINES, POLICY_REBUTTAL_FIELDS],
  ['REBUTTAL', REBUTTAL_LINES, REBUTTAL_FIELDS],
  ['OPPOSING TEAM REBUTTALS', OPPOSING_REBUTTAL_LINES, OPPOSING_REBUTTAL_FIELDS],
  ['EXTENSION', EXTENSION_LINES, EXTENSION_FIELDS],
  ['their argument', THEIR_ARGUMENT_LINES, THEIR_ARGUMENT_FIELDS],
  ['our argument', OUR_ARGUMENT_LINES, OUR_ARGUMENT_FIELDS],
  ['refused branch', REFUSED_BRANCH_LINES, REFUSED_BRANCH_FIELDS],
  ['responded branch', respondedBranchLines(false), RESPONDED_BRANCH_FIELDS],
  ['responded branch, extension', respondedBranchLines(true), RESPONDED_BRANCH_FIELDS],
  ['overlap', OVERLAP_LINES, OVERLAP_FIELDS],
]

describe('every slot resolves to a field the editor renders', () => {
  it.each(blocks)('%s has no slot the registry lacks', (_name, templates, specs) => {
    const registryKeys = new Set(specs.map((spec) => spec.key))
    const orphaned = slotKeys(templates).filter((key) => !registryKeys.has(key))
    expect(orphaned).toEqual([])
  })

  it.each(blocks)('%s says every row it asks the debater to fill', (name, templates, specs) => {
    const spoken = new Set(slotKeys(templates))
    const silent = specs
      .map((spec) => spec.key)
      .filter((key) => !spoken.has(key) && !(NOT_SPOKEN.get(name) ?? []).includes(key))
    expect(silent).toEqual([])
  })
})
