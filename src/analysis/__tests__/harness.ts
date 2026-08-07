/**
 * Test scaffolding for the analyzer.
 *
 * Rules read a `RuleContext`, which is built from a whole `Case` projected through a role. Most
 * tests care about one field, so everything here exists to get from "this text, in this row" to
 * a context without each test rebuilding a case by hand.
 *
 * Substantive ids are fixed (`sub-1`, `sub-2`, …) so an assertion can name a field path
 * literally and stay readable.
 *
 * Not a `.test.ts` file, so vitest's `include` does not pick it up as a suite.
 */

import { getRole } from '../../formats/index.ts'
import type { SpeakerRole } from '../../formats/index.ts'
import type { Case, Substantive, SubstantiveFieldKey } from '../../types/case.ts'
import {
  createDefinitionBlock,
  createPolicyBlock,
  createPolicyRebuttalBlock,
  createPrepBlock,
  createSetupBlock,
  createSubstantive,
} from '../../types/createCase.ts'
import { setFieldByPath } from '../../case/update.ts'
import { buildRuleContext } from '../index.ts'
import type { AnalysisRule, Finding, RuleContext } from '../types.ts'

/** Rows of one substantive, all optional. */
export type SubstantiveRows = Partial<Record<SubstantiveFieldKey, string>>

/** The AP first speaker — the seat that fills the definition, policy, and substantive tables. */
export const FIRST_SPEAKER: SpeakerRole = mustFindRole('ap-pm')

/** The AP government whip — no substantives, which is what silences the sub-level rules. */
export const WHIP: SpeakerRole = mustFindRole('ap-gov-whip')

/** Looks up a role, failing loudly at import time rather than as a confusing undefined later. */
function mustFindRole(roleId: string): SpeakerRole {
  const role = getRole('AP', roleId)
  if (!role) {
    throw new Error(`AP has no role ${roleId}`)
  }
  return role
}

/**
 * Builds a case with nothing written in it.
 *
 * @returns An AP government first-speaker case with no substantives at all, so a caller adds
 *   exactly the ones their test needs.
 */
export function blankCase(): Case {
  return {
    id: 'test-case',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    format: 'AP',
    side: 'gov',
    position: 'ap-pm',
    visibility: 'private',
    prep: createPrepBlock(),
    setup: createSetupBlock(),
    definition: createDefinitionBlock(),
    policy: createPolicyBlock(),
    substantives: [],
    policyRebuttal: createPolicyRebuttalBlock(),
    rebuttals: [],
    opposingRebuttals: [],
    clashes: [],
    extension: null,
  }
}

/**
 * Builds a case holding the given substantives.
 *
 * @param rows - One entry per substantive; unlisted rows are empty. Order is preserved, so the
 *   first entry is "Sub 1".
 * @param motion - Motion text. Several rules subtract the motion's vocabulary or stay silent
 *   without one, so pass it whenever the rule under test reads it.
 * @returns The case.
 */
export function caseWithSubstantives(rows: readonly SubstantiveRows[], motion = ''): Case {
  const base = blankCase()
  const substantives: Substantive[] = rows.map((filled, index) => ({
    ...createSubstantive(),
    ...filled,
    id: `sub-${String(index + 1)}`,
  }))
  return { ...base, prep: { ...base.prep, motion }, substantives }
}

/**
 * Builds a case with one substantive.
 *
 * @param rows - Rows to fill.
 * @param motion - Motion text, when the rule under test reads it.
 * @returns A case whose only substantive is `sub-1`.
 */
export function caseWithSubstantive(rows: SubstantiveRows, motion = ''): Case {
  return caseWithSubstantives([rows], motion)
}

/**
 * Writes one field by path.
 *
 * @param caseFile - Case to edit.
 * @param path - Field path, as `buildSections` produces it. An unroutable path throws.
 * @param value - Text to write.
 * @returns The edited case.
 */
export function withField(caseFile: Case, path: string, value: string): Case {
  return setFieldByPath(caseFile, path, value)
}

/**
 * Builds a rule context.
 *
 * @param caseFile - The case to project.
 * @param role - The seat. Defaults to the first speaker, who owns the substantive tables.
 * @returns The context every rule takes.
 */
export function contextFor(caseFile: Case, role: SpeakerRole = FIRST_SPEAKER): RuleContext {
  return buildRuleContext(caseFile, role)
}

/**
 * Runs one rule.
 *
 * @param rule - The rule under test.
 * @param caseFile - The case to run it over.
 * @param role - The seat. Defaults to the first speaker.
 * @returns That rule's findings only, so an assertion on length means what it says.
 */
export function analyse(
  rule: AnalysisRule,
  caseFile: Case,
  role: SpeakerRole = FIRST_SPEAKER,
): readonly Finding[] {
  return rule.run(contextFor(caseFile, role))
}

/**
 * Runs one rule against a single substantive row.
 *
 * @param rule - The rule under test.
 * @param key - Which template row to write into. The row matters: several rules only fire on
 *   the core rows, so passing `example` where a test meant `whyBad` yields nothing.
 * @param text - The text to analyse.
 * @returns That rule's findings.
 */
export function analyseRow(
  rule: AnalysisRule,
  key: SubstantiveFieldKey,
  text: string,
): readonly Finding[] {
  return analyse(rule, caseWithSubstantive({ [key]: text }))
}
