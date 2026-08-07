/**
 * Whether the closing line of a substantive closes back to the motion.
 *
 * The template's last row is "Link ( close up the sub)", and the failure it invites is linking
 * back to your own sub title instead of to the motion — which proves you proved your point, not
 * that your point wins the debate.
 *
 * Only fires on a link that has been written. An empty one is the completeness meter's business.
 */

import { contentWords } from '../text.ts'
import type { AnalysisRule, Finding, RuleContext } from '../types.ts'

/**
 * Runs the link-back check over each substantive.
 *
 * @param context - Rules context. Silent until a motion is typed, since with no motion there is
 *   nothing to link back to and every link would fail.
 * @returns One finding per link that shares no vocabulary with the motion.
 */
export function runLinkBack(context: RuleContext): readonly Finding[] {
  if (context.motionWords.size === 0) {
    return []
  }

  return context.substantives.flatMap((substantive): Finding[] => {
    const link = substantive.byKey.get('link')
    if (!link || link.value.trim().length === 0) {
      return []
    }
    const written = contentWords(link.value)
    if ([...written].some((word) => context.motionWords.has(word))) {
      return []
    }

    return [
      {
        fieldPath: link.path,
        rule: 'linkBack',
        severity: 'warn',
        span: null,
        message: 'This close-up uses none of the motion’s words.',
        socraticPrompt: 'Which words of the motion does this substantive prove? Land on those.',
      },
    ]
  })
}

/** The link-back rule. */
export const LINK_BACK_RULE: AnalysisRule = {
  id: 'linkBack',
  title: 'Link back to the motion',
  run: runLinkBack,
}
