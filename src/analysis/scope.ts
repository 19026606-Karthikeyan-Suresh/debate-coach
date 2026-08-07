/**
 * Which fields a rule is allowed to fire on.
 *
 * The field list comes from `flattenFields(buildSections(case, role))`, so it is already scoped
 * to one seat and already resolves only the chosen side of each "(OR)" fork. What it does *not*
 * know is that the template's rows are not all the same kind of writing, and a rule that treats
 * them alike is wrong in three separate ways:
 *
 * - "In ___ (speaker position)" holds the word "second". Judging its causal depth is nonsense.
 * - "Prop told us ___" holds *their* argument. Flagging a hedge in it flags the opponent.
 * - The scratch pad exists to hold half-formed thoughts. Grading it defeats its purpose.
 *
 * So this module classifies each field, and the rules ask for the kinds they apply to. The
 * classification lives here rather than in `src/case/fields.ts` on purpose: that registry is the
 * template's mirror and holds only what the docx says, while everything below is the analyzer's
 * opinion about the template.
 */

import type { CaseField, CaseSection } from '../case/sections.ts'

/**
 * What kind of writing a field holds.
 *
 * - `argument` — our own reasoning. Every rule applies.
 * - `report` — what the other side said or will say. Only length applies; the rest would be
 *   grading an opponent's prose, which is neither useful nor fair.
 * - `name` — an actor, a group, a 5W1H answer. Not prose, but it must be *specific*, so the
 *   vagueness rule applies and nothing else does.
 * - `skip` — positions, titles, the motion, the scratch pad. Nothing applies.
 */
export type FieldKind = 'argument' | 'report' | 'name' | 'skip'

// Answers that must name something concrete but are notes rather than sentences. `who` is also
// read directly by `stakeholderCoverage`, which is the reason a vague answer here is expensive:
// it is the input to a cross-field check, not just a line in the prep sheet.
const NAME_PATHS: ReadonlySet<string> = new Set(['prep.actorsSplit'])
const NAME_PREFIXES: readonly string[] = ['prep.fiveW1H.']

// The motion is a *source* for `linkBack`, never a target of it — it is quoted verbatim from
// the adjudicator, and flagging the wording of a motion the debater did not choose is useless.
// The scratch pad is where thinking goes before it is any good.
const SKIP_PATHS: ReadonlySet<string> = new Set([
  'prep.motion',
  'prep.scratch',
  'prep.needsMechanism',
])

// Last path segments that hold the other side's material rather than ours.
const REPORT_KEYS: ReadonlySet<string> = new Set([
  'theirSubstantive',
  'whatTheyTold',
  'theirResponse',
  'whatPropTold',
  'whatTheySaidInFirst',
  'whatOppCanSay',
  'concededCharacterisation',
  'theirBestCase',
  'theirBestCaseWhy',
  // `prep.pois.<id>.text` — the POI as the opponent would ask it.
  'text',
])

/**
 * Last path segments a judge actually weighs.
 *
 * `causalChain` fires only on these. Every row of the template deserves a reason, but only some
 * of them lose the round without one, and a depth warning on all forty would be forty warnings.
 */
const CORE_KEYS: ReadonlySet<string> = new Set([
  // SUBSTANTIVE STRUCTURE — impact, mechanism, causal link, counterfactual.
  'whyBad',
  'whyExists',
  'howThisSolves',
  'counterfactual',
  // POLICY and POLICY REBUTTAL.
  'whyProblemExists',
  'howWeSolve',
  'whyOppDoesNotMatter',
  'whyTheirSolutionFails',
  'howItWorsensProblem',
  // REBUTTAL and OPPOSING TEAM REBUTTALS.
  'whyWrong',
  'whyCharacterisationWrong',
  'evenIfRight',
  'whyOurWorstBeatsTheirBest',
  'whyOursIsBetter',
  // The Speaker 3 script slots that carry the engagement.
  'whyNotTrue',
  'whyStillFails',
  'furthermore',
  'ourWorstCase',
  'whyBestCaseBad',
  'whyInsufficient',
  'evenIfCharacterisation',
  'whyCharacterisationFails',
  'whyStillBad',
])

/**
 * Last segment of a field path — the property name on its block.
 *
 * @param path - A field path from `buildSections`. A path with no dot returns itself.
 * @returns The property name, e.g. `whyBad` for `substantives.<id>.whyBad`.
 */
export function fieldKey(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1)
}

/**
 * Classifies a field.
 *
 * @param field - A resolved field. Both its path and its `rows` matter: a one-row box is a name
 *   or a position by construction, because the registry only uses `rows: 1` where the answer is
 *   a couple of words.
 * @returns Which rules may fire on it.
 */
export function fieldKind(field: CaseField): FieldKind {
  if (NAME_PATHS.has(field.path) || NAME_PREFIXES.some((prefix) => field.path.startsWith(prefix))) {
    return 'name'
  }
  if (SKIP_PATHS.has(field.path) || field.rows <= 1) {
    return 'skip'
  }
  return REPORT_KEYS.has(fieldKey(field.path)) ? 'report' : 'argument'
}

/**
 * Whether a field is one a judge weighs the round on.
 *
 * @param field - A resolved field.
 * @returns True for the impact, mechanism, and comparative rows.
 */
export function isCoreField(field: CaseField): boolean {
  return CORE_KEYS.has(fieldKey(field.path))
}

/**
 * Selects the fields a rule applies to.
 *
 * Empty fields are always dropped. Emptiness belongs to the completeness meter — a blank row is
 * already counted, already named in the prep-timer nudge, and telling the debater twice that
 * they have not written something yet is how a panel becomes noise.
 *
 * @param fields - Every field for the seat, in document order.
 * @param kinds - Kinds the rule applies to.
 * @returns The subset with real text in it, in document order.
 */
export function fieldsOfKind(
  fields: readonly CaseField[],
  kinds: readonly FieldKind[],
): readonly CaseField[] {
  return fields.filter(
    (field) => field.value.trim().length > 0 && kinds.includes(fieldKind(field)),
  )
}

/** One substantive, regrouped from its section so the sub-level rules can address it whole. */
export interface SubstantiveView {
  /** Section id, `substantives.<uuid>`. */
  readonly sectionId: string
  /** Short name from the nav rail, e.g. "Sub 2". Used verbatim in cross-substantive messages. */
  readonly navLabel: string
  readonly fields: readonly CaseField[]
  /** Fields keyed by template row, e.g. `whyBad`. */
  readonly byKey: ReadonlyMap<string, CaseField>
  /** Every non-empty field joined by newlines, for rules that read the whole substantive. */
  readonly text: string
}

/**
 * Regroups the substantive sections into whole substantives.
 *
 * @param sections - Sections for the seat. A seat with no substantive block — any whip —
 *   produces an empty array, which is what silences the four sub-level rules for them.
 * @returns One view per substantive, in document order.
 */
export function substantiveViews(sections: readonly CaseSection[]): readonly SubstantiveView[] {
  return sections
    .filter((section) => section.blockId === 'substantives')
    .map((section) => {
      const fields = section.groups.flatMap((group) => [...group.fields])
      return {
        sectionId: section.id,
        navLabel: section.navLabel,
        fields,
        byKey: new Map(fields.map((field) => [fieldKey(field.path), field])),
        text: fields
          .map((field) => field.value.trim())
          .filter((value) => value.length > 0)
          .join('\n'),
      }
    })
}
