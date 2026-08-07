/**
 * Layer A — the offline depth analyzer.
 *
 * Always on, never optional, no network. Claude's Layer B (phase 7) is an addition to this, not
 * a replacement for it: a debater on a tournament wifi that does not work still gets every rule
 * below.
 *
 * The field list comes from `flattenFields(buildSections(case, role))` rather than from walking
 * the `Case` object, which buys three things at once — it is role-scoped, so a whip is never
 * told their DEFINITION table is thin; it resolves only the selected side of each "(OR)" fork,
 * so nothing fires on a branch that will not be said; and the `path` it produces is the same
 * string `setFieldByPath` accepts, so a finding routes back to its field with no second
 * addressing scheme.
 */

import type { SpeakerRole } from '../formats/index.ts'
import { buildSections, flattenFields } from '../case/sections.ts'
import type { CaseField } from '../case/sections.ts'
import type { Case } from '../types/case.ts'
import { ASSERTION_WITHOUT_MECHANISM_RULE } from './rules/assertionWithoutMechanism.ts'
import { CAUSAL_CHAIN_RULE } from './rules/causalChain.ts'
import { COMPARATIVE_WEIGHING_RULE } from './rules/comparativeWeighing.ts'
import { HEDGE_AND_FILLER_RULE } from './rules/hedgeAndFiller.ts'
import { IMPACT_AXES_RULE } from './rules/impactAxes.ts'
import { LINK_BACK_RULE } from './rules/linkBack.ts'
import { SENTENCE_LENGTH_RULE } from './rules/sentenceLength.ts'
import { STAKEHOLDER_COVERAGE_RULE } from './rules/stakeholderCoverage.ts'
import { SUB_OVERLAP_RULE } from './rules/subOverlap.ts'
import { VAGUENESS_RULE } from './rules/vagueness.ts'
import { substantiveViews } from './scope.ts'
import { contentWords } from './text.ts'
import { SEVERITY_ORDER } from './types.ts'
import type { AnalysisRule, Finding, RuleContext, RuleId, Severity } from './types.ts'

/**
 * Every Layer A rule.
 *
 * Order here does not affect the output — findings are sorted by where they point, not by which
 * rule produced them — so this list is in the order the rules are described in `PLAN.md`.
 */
export const ANALYSIS_RULES: readonly AnalysisRule[] = [
  CAUSAL_CHAIN_RULE,
  ASSERTION_WITHOUT_MECHANISM_RULE,
  VAGUENESS_RULE,
  IMPACT_AXES_RULE,
  COMPARATIVE_WEIGHING_RULE,
  STAKEHOLDER_COVERAGE_RULE,
  SUB_OVERLAP_RULE,
  HEDGE_AND_FILLER_RULE,
  LINK_BACK_RULE,
  SENTENCE_LENGTH_RULE,
]

/** Rule titles, keyed by id, for anything rendering a finding's category. */
export const RULE_TITLES: Readonly<Record<RuleId, string>> = Object.fromEntries(
  ANALYSIS_RULES.map((rule) => [rule.id, rule.title]),
) as Record<RuleId, string>

/**
 * Assembles what every rule is handed.
 *
 * @param caseFile - The case to analyse.
 * @param role - The seat. Drives which blocks exist at all, so passing the wrong one produces
 *   findings about fields this debater does not fill.
 * @returns The shared context.
 */
export function buildRuleContext(caseFile: Case, role: SpeakerRole): RuleContext {
  const sections = buildSections(caseFile, role)
  const fields = flattenFields(sections)

  return {
    caseFile,
    role,
    sections,
    fields,
    fieldsByPath: new Map(fields.map((field) => [field.path, field])),
    substantives: substantiveViews(sections),
    motionWords: contentWords(caseFile.prep.motion),
  }
}

/**
 * Runs every rule over one seat's case.
 *
 * @param caseFile - The case to analyse. Empty fields produce no findings at all — a blank row
 *   is the completeness meter's job, and saying it twice is how a panel becomes noise.
 * @param role - The seat being prepped.
 * @returns Findings in document order, strongest first within a field.
 */
export function runAnalysis(caseFile: Case, role: SpeakerRole): readonly Finding[] {
  const context = buildRuleContext(caseFile, role)
  const findings = ANALYSIS_RULES.flatMap((rule) => [...rule.run(context)])
  return sortFindings(findings, context.fields)
}

/**
 * Orders findings the way the editor reads them: down the page, worst first within a field.
 *
 * @param findings - Findings in whatever order the rules produced them.
 * @param fields - The seat's fields in document order, which defines what "down the page" means.
 * @returns A new sorted array.
 */
export function sortFindings(
  findings: readonly Finding[],
  fields: readonly CaseField[],
): readonly Finding[] {
  const documentOrder = new Map(fields.map((field, index) => [field.path, index]))

  return [...findings].sort((left, right) => {
    // A finding whose field has vanished sorts last rather than to the top, where it would be
    // the first thing read after deleting a substantive.
    const leftPosition = documentOrder.get(left.fieldPath) ?? Number.MAX_SAFE_INTEGER
    const rightPosition = documentOrder.get(right.fieldPath) ?? Number.MAX_SAFE_INTEGER
    if (leftPosition !== rightPosition) {
      return leftPosition - rightPosition
    }
    const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    return bySeverity !== 0 ? bySeverity : left.rule.localeCompare(right.rule)
  })
}

/**
 * A stable identity for one finding.
 *
 * Findings have no id of their own — they are derived, thrown away, and rederived on every
 * debounced pass — but anything listing them needs a key that survives a rerun. The message is
 * part of it because a rule can legitimately produce several findings on one field with no
 * span: `impactAxes` emits one per missing axis, and rule plus path alone would collide.
 *
 * @param finding - The finding to identify.
 * @returns A key unique among the findings of one analysis pass.
 */
export function findingKey(finding: Finding): string {
  const at = finding.span ? `${String(finding.span.start)}-${String(finding.span.end)}` : 'field'
  return `${finding.fieldPath}|${finding.rule}|${at}|${finding.message}`
}

/**
 * Buckets findings by the field they point at.
 *
 * @param findings - Findings to group, already sorted if the order within a field matters.
 * @returns A map from field path to its findings, insertion-ordered to match the input.
 */
export function groupFindingsByPath(
  findings: readonly Finding[],
): ReadonlyMap<string, readonly Finding[]> {
  const grouped = new Map<string, Finding[]>()
  for (const finding of findings) {
    const bucket = grouped.get(finding.fieldPath)
    if (bucket) {
      bucket.push(finding)
    } else {
      grouped.set(finding.fieldPath, [finding])
    }
  }
  return grouped
}

/**
 * Counts findings per severity.
 *
 * @param findings - Findings to tally.
 * @returns A count for each severity, zero where there are none.
 */
export function countBySeverity(findings: readonly Finding[]): Readonly<Record<Severity, number>> {
  const counts: Record<Severity, number> = { critical: 0, warn: 0, info: 0 }
  for (const finding of findings) {
    counts[finding.severity] += 1
  }
  return counts
}

export type { AnalysisRule, Finding, RuleContext, RuleId, Severity } from './types.ts'
