/**
 * The analyzer's contract.
 *
 * A finding addresses a field by the same `path` string `buildSections` hands the editor and
 * `setFieldByPath` accepts. That is the whole reason phase 2 keyed repeatable blocks by id
 * rather than index: a finding survives the debater deleting Sub 1, because it points at
 * `substantives.<uuid>.whyBad` and not at `substantives.1.whyBad`.
 *
 * Every finding carries two strings and they do different jobs. `message` states what is
 * missing. `socraticPrompt` is the question a judge would ask — it never answers itself, never
 * proposes wording, and is the only half of a finding the debater is meant to act on. Layer B
 * enforces that structurally with a JSON schema; here it is a convention the rules keep.
 */

import type { SpeakerRole } from '../formats/index.ts'
import type { CaseField, CaseSection } from '../case/sections.ts'
import type { Case } from '../types/case.ts'
import type { SubstantiveView } from './scope.ts'
import type { TextSpan } from './text.ts'

/**
 * How much a finding matters.
 *
 * - `critical` — the round is lost on this. A bare assertion in an impact row.
 * - `warn` — a judge will ask about it and there is no answer prepared.
 * - `info` — polish. Worth fixing with time to spare, never worth interrupting prep for.
 */
export type Severity = 'critical' | 'warn' | 'info'

/** Sort weight per severity; lower comes first. */
export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  critical: 0,
  warn: 1,
  info: 2,
}

/** Every heuristic in Layer A. Persisted nowhere yet, but treat as a stable enum. */
export type RuleId =
  | 'causalChain'
  | 'assertionWithoutMechanism'
  | 'vagueness'
  | 'impactAxes'
  | 'comparativeWeighing'
  | 'stakeholderCoverage'
  | 'subOverlap'
  | 'hedgeAndFiller'
  | 'linkBack'
  | 'sentenceLength'

/** One thing wrong with one field. */
export interface Finding {
  /** Path of the field this is about, from `buildSections`. */
  readonly fieldPath: string
  readonly rule: RuleId
  readonly severity: Severity
  /**
   * The run of text to underline, or null when the whole field is the problem.
   *
   * Offsets are into the field's value **as the rule saw it**. Analysis is debounced, so by the
   * time this renders the text may have moved on; the editor clamps rather than trusting it.
   */
  readonly span: TextSpan | null
  /** What is wrong, stated flatly. One sentence. */
  readonly message: string
  /** The question a judge would ask. Never contains its own answer. */
  readonly socraticPrompt: string
}

/**
 * Everything a rule is handed.
 *
 * Rules read `fields` and `substantives`, not `caseFile`. Both are already role-scoped, so a
 * whip is never told their DEFINITION table is shallow — they do not have one. `caseFile` is
 * present for the two rules that need structure the projection flattens away.
 */
export interface RuleContext {
  readonly caseFile: Case
  readonly role: SpeakerRole
  readonly sections: readonly CaseSection[]
  /** Every field this seat fills, in document order, including the empty ones. */
  readonly fields: readonly CaseField[]
  readonly fieldsByPath: ReadonlyMap<string, CaseField>
  /** The seat's substantives, regrouped. Empty for a whip, which silences the sub-level rules. */
  readonly substantives: readonly SubstantiveView[]
  /**
   * Stemmed content words of the motion, empty until a motion is typed.
   *
   * Three rules subtract these before comparing anything, because every substantive in a round
   * shares the motion's nouns and counting that as similarity would flag every case ever built.
   */
  readonly motionWords: ReadonlySet<string>
}

/** One heuristic. */
export interface AnalysisRule {
  readonly id: RuleId
  /** Human name, shown as the finding's category in the depth panel. */
  readonly title: string
  /**
   * Produces findings. Must be pure and must not throw — one bad rule taking the panel down
   * would take the other nine with it.
   */
  readonly run: (context: RuleContext) => readonly Finding[]
}
