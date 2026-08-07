/**
 * Two substantives that are one substantive.
 *
 * The most expensive structural mistake in a prepped case: three minutes spent proving a thing
 * twice while a whole line of argument goes unrun. It is also the hardest to see from inside,
 * because both versions feel distinct while you are writing them.
 *
 * Jaccard over content-word sets, **with the motion's own vocabulary subtracted first**. Without
 * that subtraction the score measures nothing: every substantive on "THW hold social media
 * companies criminally liable" says "social media", "companies" and "liable", so every pair in
 * every case scores the same baseline and the threshold has to be set so high it never fires.
 */

import type { SubstantiveView } from '../scope.ts'
import { contentWords, jaccard, withoutWords } from '../text.ts'
import type { AnalysisRule, Finding, RuleContext } from '../types.ts'

/**
 * Similarity at or above which two substantives are treated as the same argument.
 *
 * Measured, not guessed. On `reference/template-filled-example.docx` — motion words already
 * subtracted — the two substantives that really are one argument ("fake news causes irreparable
 * damage" and "allowing the spread is supporting it") score **0.11**, while either of them
 * against a substantive written on separate ground scores **0.04**. 0.07 sits between them with
 * roughly equal margin on both sides; `subOverlap.test.ts` pins both numbers, so a lexicon or
 * stemming change that collapses the gap fails there rather than quietly here.
 *
 * The absolute values look small because Jaccard over hundred-word vocabularies always does.
 * What matters is the 2.5× separation, which is what the threshold is placed inside.
 */
export const OVERLAP_THRESHOLD = 0.07

// Below this a substantive has too little vocabulary for a ratio to mean anything: two
// half-written subs sharing four words out of six is not evidence of anything.
const MIN_DISTINCT_WORDS = 25

/**
 * Runs the overlap check over every pair of substantives.
 *
 * @param context - Rules context. Reads `substantives` and subtracts `motionWords`.
 * @returns One finding per overlapping pair, hung on the later substantive — the earlier one is
 *   usually the keeper, and a finding on both would read as two problems.
 */
export function runSubOverlap(context: RuleContext): readonly Finding[] {
  const vocabularies = context.substantives.map((substantive) =>
    withoutWords(contentWords(substantive.text), context.motionWords),
  )
  const findings: Finding[] = []

  for (let laterIndex = 1; laterIndex < context.substantives.length; laterIndex += 1) {
    for (let earlierIndex = 0; earlierIndex < laterIndex; earlierIndex += 1) {
      const later = context.substantives[laterIndex]
      const earlier = context.substantives[earlierIndex]
      const laterWords = vocabularies[laterIndex]
      const earlierWords = vocabularies[earlierIndex]
      if (!later || !earlier || !laterWords || !earlierWords) {
        continue
      }
      if (laterWords.size < MIN_DISTINCT_WORDS || earlierWords.size < MIN_DISTINCT_WORDS) {
        continue
      }

      const similarity = jaccard(laterWords, earlierWords)
      if (similarity < OVERLAP_THRESHOLD) {
        continue
      }

      const anchorPath = anchorFor(later)
      if (!anchorPath) {
        continue
      }
      findings.push({
        fieldPath: anchorPath,
        rule: 'subOverlap',
        severity: 'warn',
        span: null,
        message: `${later.navLabel} shares most of its vocabulary with ${earlier.navLabel}.`,
        socraticPrompt: `If ${earlier.navLabel} were dropped, what would ${later.navLabel} still prove on its own?`,
      })
    }
  }

  return findings
}

/** Where to hang the finding: the one-sentence summary if written, else the first filled row. */
function anchorFor(substantive: SubstantiveView): string | null {
  const summary = substantive.byKey.get('oneSentence')
  if (summary && summary.value.trim().length > 0) {
    return summary.path
  }
  return substantive.fields.find((field) => field.value.trim().length > 0)?.path ?? null
}

/** The substantive-overlap rule. */
export const SUB_OVERLAP_RULE: AnalysisRule = {
  id: 'subOverlap',
  title: 'Overlapping substantives',
  run: runSubOverlap,
}
