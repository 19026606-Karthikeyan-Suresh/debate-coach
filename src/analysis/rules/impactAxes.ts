/**
 * Whether an impact is argued on the axes a judge weighs it on.
 *
 * Magnitude, probability, reversibility, timeframe. Most surface-level substantives argue one —
 * usually magnitude, loudly — and lose to a team that argues a smaller harm on all four.
 *
 * Read across the three rows that carry the impact rather than just "Why is the problem so
 * bad?", because the counterfactual and the problem statement routinely carry the timeframe and
 * the scale, and docking a substantive for an axis it did argue one row up would be wrong.
 */

import { IMPACT_AXES } from '../lexicons.ts'
import type { SubstantiveView } from '../scope.ts'
import { containsPhrase, wordCount } from '../text.ts'
import type { AnalysisRule, Finding, RuleContext } from '../types.ts'

/** Template rows that carry the impact, in the order they appear. */
const IMPACT_KEYS: readonly string[] = ['problem', 'whyBad', 'counterfactual']

// Below this the substantive is still being typed, and firing four findings at a half-written
// sentence teaches the debater to close the panel. Roughly two full sentences of impact.
const MIN_WORDS_BEFORE_JUDGING = 25

/** Collects the impact rows of one substantive. Returns the joined text and where to anchor. */
function impactOf(substantive: SubstantiveView): { text: string; anchorPath: string } | null {
  const rows = IMPACT_KEYS.map((key) => substantive.byKey.get(key)).filter(
    (field) => field !== undefined,
  )
  const filled = rows.filter((field) => field.value.trim().length > 0)
  if (filled.length === 0) {
    return null
  }

  // Anchor on "Why is the problem so bad?" when it exists, since that is the row the missing
  // axis belongs in; fall back to whichever impact row was actually written.
  const impactRow = substantive.byKey.get('whyBad')
  const anchor = impactRow && impactRow.value.trim().length > 0 ? impactRow : filled[0]
  if (!anchor) {
    return null
  }

  return { text: filled.map((field) => field.value).join('\n'), anchorPath: anchor.path }
}

/**
 * Runs the impact-axis check over each substantive.
 *
 * @param context - Rules context. Only `substantives` is read, so a whip gets nothing.
 * @returns One finding per missing axis per substantive.
 */
export function runImpactAxes(context: RuleContext): readonly Finding[] {
  return context.substantives.flatMap((substantive): Finding[] => {
    const impact = impactOf(substantive)
    if (!impact || wordCount(impact.text) < MIN_WORDS_BEFORE_JUDGING) {
      return []
    }

    return IMPACT_AXES.filter((axis) => !containsPhrase(impact.text, axis.markers)).map((axis) => ({
      fieldPath: impact.anchorPath,
      rule: 'impactAxes',
      severity: 'warn',
      span: null,
      message: `${substantive.navLabel} never argues ${axis.label}.`,
      socraticPrompt: axis.question,
    }))
  })
}

/** The impact-axis rule. */
export const IMPACT_AXES_RULE: AnalysisRule = {
  id: 'impactAxes',
  title: 'Impact axes',
  run: runImpactAxes,
}
