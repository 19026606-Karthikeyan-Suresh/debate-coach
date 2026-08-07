/**
 * Sentences too long to say without dropping a clause.
 *
 * This is the one rule in Layer A aimed at the delivery problem rather than the depth problem.
 * Every field it looks at gets compiled into speech text in phase 4 and then read off a
 * teleprompter under a seven-minute clock, and a forty-word sentence is where words go missing.
 *
 * Runs on reported material too — "Prop told us ___" is said out loud exactly like everything
 * else, and a sentence being someone else's does not make it easier to deliver.
 */

import type { CaseField } from '../../case/sections.ts'
import { fieldsOfKind } from '../scope.ts'
import { splitSentences, wordCount } from '../text.ts'
import type { AnalysisRule, Finding, RuleContext } from '../types.ts'

/**
 * Longest sentence that survives delivery.
 *
 * About fourteen seconds at a debater's pace. Past it the speaker is reading ahead of their own
 * breath, which is the mechanism behind the skipped words the speech trainer measures.
 */
export const MAX_SENTENCE_WORDS = 35

/** Flags each over-long sentence in one field. */
function judgeField(field: CaseField): readonly Finding[] {
  return splitSentences(field.value).flatMap((sentence): Finding[] => {
    const words = wordCount(sentence.text)
    if (words <= MAX_SENTENCE_WORDS) {
      return []
    }

    return [
      {
        fieldPath: field.path,
        rule: 'sentenceLength',
        severity: 'warn',
        span: { start: sentence.start, end: sentence.end },
        message: `${String(words)} words in one sentence — too long to say without dropping something.`,
        socraticPrompt: 'Where does this sentence make its second point? Break it there.',
      },
    ]
  })
}

/**
 * Runs the sentence-length check.
 *
 * @param context - Rules context. Only `fields` is read.
 * @returns One finding per over-long sentence.
 */
export function runSentenceLength(context: RuleContext): readonly Finding[] {
  return fieldsOfKind(context.fields, ['argument', 'report']).flatMap(judgeField)
}

/** The sentence-length rule. */
export const SENTENCE_LENGTH_RULE: AnalysisRule = {
  id: 'sentenceLength',
  title: 'Sentence length',
  run: runSentenceLength,
}
