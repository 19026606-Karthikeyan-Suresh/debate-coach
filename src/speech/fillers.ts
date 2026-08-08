/**
 * The words that filled a second without saying anything.
 *
 * Two honest limits, both of which the report has to state rather than hide:
 *
 * **The count is a floor, never a total.** whisper is trained to produce readable text, and
 * readable text has no "um" in it. `base.en` drops most disfluencies outright and `small.en`
 * drops fewer, so a session showing three is a session with at least three — and two sessions are
 * only comparable when they were transcribed by the same model. That is why {@link FillerHit}
 * carries the word as transcribed: seeing which ones survived is the only way to judge the number.
 *
 * **This is not the analyzer's hedge list.** `hedgeAndFiller` grades the case text a debater
 * wrote and can still edit. This grades a delivery that is over. The overlap is real —
 * "basically" is both — but the lists are not the same, because "very" and "really" are weak
 * writing and not a verbal tic, while "um" is a tic and cannot be written at all.
 */

import { findPhrases, tokenize } from '../analysis/text.ts'
import type { TextSpan } from '../analysis/text.ts'

/** Whether a filler is a sound or a word. Shown separately, because the cures differ. */
export type FillerKind =
  /** A noise standing in for a word: um, uh, er. Fixed by pausing instead. */
  | 'disfluency'
  /** A real word carrying no load: you know, sort of, basically. Fixed by cutting it. */
  | 'crutch'

/** One entry in the filler lexicon, plus the neighbours that mean it is not filler. */
export interface FillerTerm {
  readonly phrase: string
  readonly kind: FillerKind
  /** Words that, immediately before the match, make it something other than filler. */
  readonly notPrecededBy: readonly string[]
  /** Words that, immediately after the match, make it something other than filler. */
  readonly notFollowedBy: readonly string[]
  /**
   * True when the term only counts if the transcript closes it with a comma.
   *
   * Only `like` needs this, and it needs it badly — see {@link FILLER_TERMS}.
   */
  readonly needsTrailingComma: boolean
}

/** Builds a lexicon entry. Every guard defaults to off, which is right for the sounds. */
function filler(
  phrase: string,
  kind: FillerKind,
  notPrecededBy: readonly string[] = [],
  notFollowedBy: readonly string[] = [],
  needsTrailingComma = false,
): FillerTerm {
  return { phrase, kind, notPrecededBy, notFollowedBy, needsTrailingComma }
}

/**
 * What counts as filler in a delivered speech.
 *
 * The bias is the analyzer's: a list that flags real speech gets ignored, and then the entries
 * that were right go with it. Three deliberate omissions, each of which a debater says constantly
 * in a sense that is not filler:
 *
 * - `so` — "so that", "and so", "so many". The causal and consequential uses swamp the discourse
 *   marker, and there is no guard that separates them.
 * - `right` — "the right to", "human rights", "rights-based". The tag-question use is real but it
 *   is a needle in that haystack.
 * - `actually` — "what actually happens", "it actually costs". In debate prose this is usually
 *   doing contrastive work, unlike the rest of the crutches here.
 *
 * `like` is the hard one and is kept only under a comma guard. Its filler use is a discourse
 * marker — "so, like, the government has to" — and whisper closes those with a comma, while the
 * comparative and the verb ("policies like this", "looks like", "would like to") never carry one.
 * Without the guard every simile in the speech is a filler.
 */
export const FILLER_TERMS: readonly FillerTerm[] = [
  filler('um', 'disfluency'),
  filler('umm', 'disfluency'),
  filler('uh', 'disfluency'),
  filler('uhh', 'disfluency'),
  filler('er', 'disfluency'),
  filler('erm', 'disfluency'),
  filler('ah', 'disfluency'),
  filler('hmm', 'disfluency'),
  filler('mhm', 'disfluency'),

  filler('you know', 'crutch', [], ['that', 'what', 'how', 'when', 'why', 'the', 'this', 'these']),
  filler('i mean', 'crutch', [], ['that', 'to', 'by', 'what', 'it', 'this']),
  filler('sort of', 'crutch'),
  filler('kind of', 'crutch'),
  filler('basically', 'crutch'),
  filler('literally', 'crutch'),
  filler('obviously', 'crutch'),
  filler('honestly', 'crutch'),
  filler('like', 'crutch', [], [], true),
]

/** One filler, where it was said. */
export interface FillerHit {
  /** The lexicon entry that matched, for grouping. */
  readonly phrase: string
  /** The words as transcribed, so a model that writes "Um" and one that writes "erm" are visible. */
  readonly text: string
  readonly kind: FillerKind
  /** Character offsets into the transcript the hit was found in. */
  readonly span: TextSpan
}

/** Whether the transcript closes a span with a comma, which is how it renders an aside. */
function hasTrailingComma(transcript: string, span: TextSpan): boolean {
  return transcript.slice(span.end).startsWith(',')
}

/**
 * Whether a match is the filler sense of the word rather than one of its real ones.
 *
 * **The comma is the strongest signal there is, and it outranks the word guards.** whisper writes
 * an aside as an aside — "you know, the government has to" — while the same two words doing real
 * work run straight on: "you know the answer". So a trailing comma admits a term whose following
 * word would otherwise have disqualified it, and for `like` it is required outright.
 *
 * A *leading* comma proves nothing, which the guard learned the hard way: in "it spreads, um,
 * like wildfire" the comma before `like` belongs to the `um` in front of it, and reading it as
 * `like`'s made every simile after a filler into a filler too.
 */
function isFillerUse(transcript: string, term: FillerTerm, span: TextSpan): boolean {
  const isClosed = hasTrailingComma(transcript, span)
  if (term.needsTrailingComma) {
    return isClosed
  }
  if (isClosed) {
    return true
  }
  const before = tokenize(transcript.slice(0, span.start)).at(-1)?.normalized ?? ''
  const after = tokenize(transcript.slice(span.end)).at(0)?.normalized ?? ''
  return !term.notPrecededBy.includes(before) && !term.notFollowedBy.includes(after)
}

/**
 * Finds every filler in a transcript.
 *
 * @param transcript - What was actually said, whole. Pass the accurate `small.en` transcript
 *   where there is one: the live pass drops more disfluencies than the review pass, so running
 *   this against it under-counts against a number the debater will compare between sessions.
 * @returns Hits in transcript order, non-overlapping. Spans index into the string that was
 *   passed, which is what lets a hit be given a timestamp through the timeline.
 */
export function findFillers(transcript: string): readonly FillerHit[] {
  const hits: FillerHit[] = []
  for (const term of FILLER_TERMS) {
    for (const match of findPhrases(transcript, [term.phrase])) {
      if (isFillerUse(transcript, term, match.span)) {
        hits.push({ phrase: term.phrase, text: match.text, kind: term.kind, span: match.span })
      }
    }
  }

  // Each term was scanned on its own, so two entries can land on the same words — "kind of" and a
  // hypothetical "of" would. Longest-first at a shared start, then drop anything already covered.
  hits.sort((left, right) =>
    left.span.start !== right.span.start
      ? left.span.start - right.span.start
      : right.span.end - left.span.end,
  )

  const kept: FillerHit[] = []
  let consumedTo = -1
  for (const hit of hits) {
    if (hit.span.start >= consumedTo) {
      kept.push(hit)
      consumedTo = hit.span.end
    }
  }
  return kept
}

/** How often one filler was said. */
export interface FillerCount {
  readonly phrase: string
  readonly kind: FillerKind
  readonly count: number
}

/**
 * Groups hits by the word that was said.
 *
 * @param hits - As returned by {@link findFillers}.
 * @returns One entry per distinct phrase, commonest first. Ties keep transcript order, so the
 *   list is stable between two runs over the same speech.
 */
export function countFillers(hits: readonly FillerHit[]): readonly FillerCount[] {
  const counts = new Map<string, FillerCount>()
  for (const hit of hits) {
    const existing = counts.get(hit.phrase)
    counts.set(hit.phrase, {
      phrase: hit.phrase,
      kind: hit.kind,
      count: (existing?.count ?? 0) + 1,
    })
  }
  return [...counts.values()].sort((left, right) => right.count - left.count)
}
