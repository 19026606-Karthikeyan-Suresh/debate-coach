/**
 * Sentences that pass a judgement and then move on.
 *
 * "This is devastating." is not an argument, it is an adjective. The check is narrow on purpose:
 * a value word only counts as unsupported if there is no causal connective in its own sentence
 * *or the next one*, because the reason often lands in the sentence after the claim, and
 * flagging that pattern would flag correct writing.
 */

import type { CaseField } from '../../case/sections.ts'
import { CAUSAL_CONNECTIVES, EVALUATIVE_MARKERS } from '../lexicons.ts'
import { fieldsOfKind } from '../scope.ts'
import { containsPhrase, firstPhrase, splitSentences } from '../text.ts'
import type { AnalysisRule, Finding, RuleContext } from '../types.ts'

/** Flags each unsupported judgement in one field. */
function judgeField(field: CaseField): readonly Finding[] {
  const sentences = splitSentences(field.value)

  return sentences.flatMap((sentence, sentenceIndex): Finding[] => {
    const verdict = firstPhrase(sentence.text, EVALUATIVE_MARKERS)
    if (!verdict) {
      return []
    }
    // The reason is allowed to arrive one sentence late. Any later and the judgement was
    // delivered on its own, which is the habit this rule exists to catch.
    const supporting = `${sentence.text} ${sentences[sentenceIndex + 1]?.text ?? ''}`
    if (containsPhrase(supporting, CAUSAL_CONNECTIVES)) {
      return []
    }

    return [
      {
        fieldPath: field.path,
        rule: 'assertionWithoutMechanism',
        severity: 'warn',
        span: { start: sentence.start, end: sentence.end },
        message: `"${verdict.text}" is a verdict, and nothing here or next says how it follows.`,
        socraticPrompt: 'What has to be true about the world for this to be bad? Say that part.',
      },
    ]
  })
}

/**
 * Runs the unsupported-judgement check.
 *
 * @param context - Rules context. Only `fields` is read.
 * @returns One finding per evaluative sentence with no reason attached.
 */
export function runAssertionWithoutMechanism(context: RuleContext): readonly Finding[] {
  return fieldsOfKind(context.fields, ['argument']).flatMap(judgeField)
}

/** The unsupported-judgement rule. */
export const ASSERTION_WITHOUT_MECHANISM_RULE: AnalysisRule = {
  id: 'assertionWithoutMechanism',
  title: 'Unsupported judgement',
  run: runAssertionWithoutMechanism,
}
