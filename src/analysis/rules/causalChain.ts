/**
 * How many "why"s deep an answer goes.
 *
 * The single most diagnostic signal for surface-level writing, and the reason is arithmetic: a
 * judge asks "why" until you run out of answers, and a paragraph with one `because` in it runs
 * out on the second question. Depth is not about length — a hundred-word paragraph that asserts
 * the same thing six ways scores 0.
 */

import type { CaseField } from '../../case/sections.ts'
import { CAUSAL_CONNECTIVES } from '../lexicons.ts'
import { fieldsOfKind, isCoreField } from '../scope.ts'
import { contentWords, findPhrases, splitSentences } from '../text.ts'
import type { LexiconEntry, Sentence, TextSpan } from '../text.ts'
import type { AnalysisRule, Finding, RuleContext } from '../types.ts'

/** Depth of the longest causal chain, and where it is. */
export interface CausalChainResult {
  /** Longest run of linked causal steps. 0 means bare assertion; 3+ survives three "why"s. */
  readonly depth: number
  /** The run's span, or null at depth 0 where there is nothing to point at. */
  readonly span: TextSpan | null
}

// Two connectives with fewer than this many content words between them are one step restated,
// not two steps: "because it is bad, because it harms" is depth 1 with a comma in it.
const MIN_WORDS_PER_STEP = 2

// A connective more than one sentence after the previous one is a new claim, not a continuation.
// Chains are allowed to cross a single sentence boundary because that is how people write them
// ("...because X. This in turn means Y."), but not three.
const MAX_SENTENCE_GAP = 1

/**
 * Finds the longest chain of linked causal steps in a passage.
 *
 * Depth 0 means bare assertion; 3+ means the argument survives a judge asking "why" three times.
 * Steps link across sentence boundaries, which is how a real chain is usually written, but two
 * connectives with unrelated sentences between them count as two separate one-step claims.
 *
 * @param passage - One field. Multi-sentence is expected.
 * @param connectives - Causal markers to match. Pass a trimmed set to test one family in
 *   isolation; passing an empty array always yields depth 0.
 * @returns Depth, plus the span of the longest chain so the editor can underline it.
 */
export function measureCausalChain(
  passage: string,
  connectives: readonly LexiconEntry[],
): CausalChainResult {
  const sentences = splitSentences(passage)
  const matches = findPhrases(passage, connectives)
  if (matches.length === 0) {
    return { depth: 0, span: null }
  }

  // Walk the connectives in order, extending the current run while each one is close enough to
  // the last and has real content between them. Track the best run seen, keyed by the index of
  // its first and last connective so the span can be recovered afterwards.
  let bestStart = 0
  let bestEnd = 0
  let runStart = 0

  for (let matchIndex = 1; matchIndex < matches.length; matchIndex += 1) {
    const previous = matches[matchIndex - 1]
    const current = matches[matchIndex]
    if (!previous || !current) {
      continue
    }

    const stepWords = contentWords(passage.slice(previous.span.end, current.span.start)).size
    const sentenceGap =
      sentenceIndexAt(sentences, current.span.start) - sentenceIndexAt(sentences, previous.span.start)

    if (stepWords < MIN_WORDS_PER_STEP || sentenceGap > MAX_SENTENCE_GAP) {
      runStart = matchIndex
      continue
    }
    if (matchIndex - runStart > bestEnd - bestStart) {
      bestStart = runStart
      bestEnd = matchIndex
    }
  }

  const first = matches[bestStart]
  const last = matches[bestEnd]
  if (!first || !last) {
    return { depth: 0, span: null }
  }

  // The chain is worth reading whole, so the span runs from the start of the sentence holding
  // its first connective to the end of the sentence holding its last.
  const from = sentences[sentenceIndexAt(sentences, first.span.start)]?.start ?? first.span.start
  const to = sentences[sentenceIndexAt(sentences, last.span.start)]?.end ?? last.span.end

  return { depth: bestEnd - bestStart + 1, span: { start: from, end: to } }
}

/** Index of the sentence containing an offset. Falls back to the last sentence. */
function sentenceIndexAt(sentences: readonly Sentence[], offset: number): number {
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index]
    if (sentence && offset < sentence.end) {
      return index
    }
  }
  return Math.max(0, sentences.length - 1)
}

/** Builds the finding for one under-depth field, or null when the field is deep enough. */
function judgeField(field: CaseField): Finding | null {
  const measured = measureCausalChain(field.value, CAUSAL_CONNECTIVES)
  if (measured.depth >= 2) {
    return null
  }

  if (measured.depth === 0) {
    return {
      fieldPath: field.path,
      rule: 'causalChain',
      severity: 'critical',
      span: null,
      message: 'Bare assertion — nothing in this answer says why it is true.',
      socraticPrompt: 'Why is that the case? Give the step, not another way of saying the claim.',
    }
  }

  return {
    fieldPath: field.path,
    rule: 'causalChain',
    severity: 'warn',
    span: measured.span,
    message: 'One step deep. A judge asking "why" a second time gets no answer.',
    socraticPrompt: 'And why does *that* happen? Keep going until the answer is structural.',
  }
}

/**
 * Runs the causal-depth check over the seat's core rows.
 *
 * @param context - Rules context. Only `fields` is read.
 * @returns One finding per core field that is shallower than two steps.
 */
export function runCausalChain(context: RuleContext): readonly Finding[] {
  return fieldsOfKind(context.fields, ['argument'])
    .filter(isCoreField)
    .map(judgeField)
    .filter((finding): finding is Finding => finding !== null)
}

/** The causal-depth rule. */
export const CAUSAL_CHAIN_RULE: AnalysisRule = {
  id: 'causalChain',
  title: 'Causal depth',
  run: runCausalChain,
}
