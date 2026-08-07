/**
 * Whether a substantive compares two worlds or just describes one.
 *
 * A close round is decided on "our worst case beats their best case", and a substantive with no
 * comparative language anywhere in it has nothing to say when that moment arrives. Checked over
 * the whole substantive rather than only the counterfactual row, because a debater who weighs
 * inside "Why is the problem so bad?" has done the work wherever they wrote it.
 */

import { COMPARATIVE_MARKERS } from '../lexicons.ts'
import type { SubstantiveView } from '../scope.ts'
import { containsPhrase, wordCount } from '../text.ts'
import type { AnalysisRule, Finding, RuleContext } from '../types.ts'

// A substantive shorter than this has not reached the point where weighing is the missing piece.
const MIN_WORDS_BEFORE_JUDGING = 40

/** Where to hang the finding: the counterfactual row if written, else the first filled row. */
function anchorFor(substantive: SubstantiveView): string | null {
  const counterfactual = substantive.byKey.get('counterfactual')
  if (counterfactual && counterfactual.value.trim().length > 0) {
    return counterfactual.path
  }
  return substantive.fields.find((field) => field.value.trim().length > 0)?.path ?? null
}

/**
 * Runs the comparative-weighing check over each substantive.
 *
 * @param context - Rules context. Only `substantives` is read.
 * @returns At most one finding per substantive.
 */
export function runComparativeWeighing(context: RuleContext): readonly Finding[] {
  return context.substantives.flatMap((substantive): Finding[] => {
    if (wordCount(substantive.text) < MIN_WORDS_BEFORE_JUDGING) {
      return []
    }
    if (containsPhrase(substantive.text, COMPARATIVE_MARKERS)) {
      return []
    }
    const anchorPath = anchorFor(substantive)
    if (!anchorPath) {
      return []
    }

    return [
      {
        fieldPath: anchorPath,
        rule: 'comparativeWeighing',
        severity: 'warn',
        span: null,
        message: `${substantive.navLabel} describes one world and never compares it to another.`,
        socraticPrompt: 'What happens if your side simply loses? Say why that world is worse.',
      },
    ]
  })
}

/** The comparative-weighing rule. */
export const COMPARATIVE_WEIGHING_RULE: AnalysisRule = {
  id: 'comparativeWeighing',
  title: 'Comparative weighing',
  run: runComparativeWeighing,
}
