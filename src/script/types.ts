/**
 * What the script compiler produces.
 *
 * The hinge between the two halves of the app. A case is a grid of answers; a speech is a run
 * of words with a clock against it. Everything downstream — teleprompter, aligner, timer,
 * report — indexes into the same `tokens` array, so "you skipped word 412" and "word 412 came
 * from `substantives.<uuid>.whyBad`" are the same lookup.
 *
 * Two properties are load-bearing and both cost something to keep:
 *
 * - **Every token knows where it came from.** `fieldPath` is the string `buildSections` hands
 *   out and `setFieldByPath` accepts, so a skipped word in the report links to the row that
 *   produced it. Template prose carries null — the debater did not write "In response they
 *   told us", so a skip there is a delivery note, not a case note.
 * - **Segment ids are derived, not counted.** They are built from case ids, so recompiling
 *   after a keystroke lands a delivery edit back on the same segment instead of orphaning it.
 */

/** Which part of the speech a segment belongs to. Drives the teleprompter's section headers. */
export type SegmentKind =
  | 'setup'
  | 'definition'
  | 'policy'
  | 'substantive'
  | 'policyRebuttal'
  | 'rebuttal'
  | 'opposingRebuttal'
  | 'extension'
  | 'clash'
  | 'engagement'

/** One word of the script. */
export interface ScriptToken {
  /** Position in the whole speech. The aligner's cursor is an index into this. */
  readonly index: number
  /** The word as it will be said, without surrounding punctuation. */
  readonly text: string
  /** Offset into the owning segment's `text`, not into the whole script. */
  readonly start: number
  /** Index one past the last character, so `segment.text.slice(start, end)` is the word. */
  readonly end: number
  readonly segmentId: string
  /**
   * The case field this word was typed into, or null where it is the template's own prose.
   *
   * Null on every token of an edited segment — see `isEdited`.
   */
  readonly fieldPath: string | null
}

/**
 * One deliverable paragraph.
 *
 * Roughly what a speaker says in one breath-group before pausing: an engagement, a substantive
 * body, a clash signpost. The teleprompter scrolls by these.
 */
export interface ScriptSegment {
  /**
   * `<sectionId>#<part>`, e.g. `substantives.<uuid>#body`. Stable across recompiles because
   * both halves come from case ids rather than from a running count.
   */
  readonly id: string
  /** Section id from `buildSections`, so the teleprompter can jump back to the editor. */
  readonly sectionId: string
  readonly kind: SegmentKind
  /** Short heading for the teleprompter rail, e.g. "Sub 2". Taken from the section's nav label. */
  readonly heading: string
  readonly text: string
  readonly tokens: readonly ScriptToken[]
  /**
   * True when a stored delivery edit replaced the compiled text.
   *
   * An edited segment's tokens all carry `fieldPath: null`: the words are the debater's own
   * rewrite, and guessing which of them still came from which row would be a heuristic
   * pretending to be provenance.
   */
  readonly isEdited: boolean
}

/**
 * A line the compiler could not emit because a field it needs is blank.
 *
 * This is the compiler's half of the completeness story, and it says something the meter does
 * not: not "you have 12 rows left" but "these are the sentences you cannot say yet".
 */
export interface ScriptGap {
  /** Path of the empty field. */
  readonly fieldPath: string
  /** The field's rendered label, so the gap can be named without a second lookup. */
  readonly label: string
  /** Section the field lives in, for jumping to it. */
  readonly sectionId: string
  /** Segment the missing line would have landed in. */
  readonly segmentId: string
}

/** A whole speech. */
export interface CompiledScript {
  readonly segments: readonly ScriptSegment[]
  /** Every token of every segment, in delivery order. The aligner consumes this. */
  readonly tokens: readonly ScriptToken[]
  /** Fields that blocked a line, in document order, one entry per field. */
  readonly gaps: readonly ScriptGap[]
  readonly wordCount: number
  /** Rounded to the second. See `SPEAKING_WORDS_PER_MINUTE` for what it assumes. */
  readonly estimatedSeconds: number
}

/**
 * Delivery pace used to estimate a script's length.
 *
 * A competitive parliamentary speaker runs fast — 160 is the middle of the range you actually
 * hear in a round, and reading at 120 would tell every debater their case is far too short.
 * A placeholder until phase 6 has measured this debater's own pace across sessions.
 */
export const SPEAKING_WORDS_PER_MINUTE = 160

/**
 * Estimates how long a script takes to deliver.
 *
 * @param wordCount - Words in the script. Zero returns zero rather than a floor of one second.
 * @returns Seconds, rounded. Compare against `format.speechSeconds`, not against the clock —
 *   this is the script's length, not the speech's, and POIs are not in it.
 */
export function estimateSeconds(wordCount: number): number {
  return Math.round((wordCount / SPEAKING_WORDS_PER_MINUTE) * 60)
}
