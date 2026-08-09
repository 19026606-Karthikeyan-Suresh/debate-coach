/**
 * Coach comments on a recording — the shape, the ordering, and which one is on screen.
 *
 * A comment is a note anchored to a second of a speech, and that anchor is the whole feature: a
 * coach who writes "your second substantive had no mechanism" is giving advice, and a coach who
 * writes it *at 4:12* is pointing at the sentence. Everything here is pure so the two questions
 * that actually decide what the player shows — which comment is current, and where the markers go
 * — are testable without an audio element.
 *
 * **A comment's timestamp is clamped, never rejected.** A note left at 7:02 on a seven-minute
 * speech is a coach who paused at the end, and dropping it loses the note to save a rounding
 * error.
 */

/** One note left on a recording. */
export interface SpeechComment {
  readonly id: string
  readonly sessionId: string
  /**
   * The `auth.uid()` of whoever wrote it, or null for one written before this install signed in.
   * Null is not "anonymous" — it is "written offline", and the drain stamps it at push time.
   */
  readonly authorId: string | null
  /** Their display name at the time. Empty when they never set one. */
  readonly authorName: string
  /** Seconds into the recording. Never negative. */
  readonly atSeconds: number
  readonly body: string
  readonly createdAt: string
  /** True when it came from the project rather than being typed here. */
  readonly isRemote: boolean
}

/**
 * Puts comments in playback order.
 *
 * @param comments - In any order.
 * @returns A new array, earliest first, with ties broken by `createdAt` so two notes on the same
 *   second keep the order they were written in rather than an order that changes between renders.
 */
export function sortComments(comments: readonly SpeechComment[]): SpeechComment[] {
  return [...comments].sort((left, right) => {
    if (left.atSeconds !== right.atSeconds) {
      return left.atSeconds - right.atSeconds
    }
    return left.createdAt.localeCompare(right.createdAt)
  })
}

/**
 * Clamps a timestamp onto a recording.
 *
 * @param seconds - Where the player was. A non-finite value — which is what an audio element
 *   reports before it has loaded — becomes zero rather than `NaN`, because `NaN` seconds stored
 *   on a comment is a note that can never be found again.
 * @param durationSeconds - Length of the recording. Zero or unknown leaves the value uncapped, so
 *   a comment written before metadata loaded is not all pinned to 0:00.
 * @returns A number safe to store.
 */
export function clampToRecording(seconds: number, durationSeconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 0
  }
  if (durationSeconds > 0 && Number.isFinite(durationSeconds)) {
    return Math.min(seconds, durationSeconds)
  }
  return seconds
}

/**
 * How long a comment stays highlighted once playback passes it.
 *
 * Long enough to read a sentence, short enough that two notes eight seconds apart do not both
 * claim to be current. A comment is a pointer at a moment, not a subtitle.
 */
export const COMMENT_DWELL_SECONDS = 6

/**
 * The comment playback is currently inside.
 *
 * @param comments - Any order; sorted internally.
 * @param atSeconds - Where the player is.
 * @returns The latest comment at or before `atSeconds` and within {@link COMMENT_DWELL_SECONDS}
 *   of it, or null. Latest rather than first: two coaches commenting on the same clause should
 *   surface the one that starts nearest where the audio actually is.
 */
export function activeCommentAt(
  comments: readonly SpeechComment[],
  atSeconds: number,
): SpeechComment | null {
  let current: SpeechComment | null = null
  for (const comment of sortComments(comments)) {
    if (comment.atSeconds > atSeconds) {
      break
    }
    if (atSeconds - comment.atSeconds <= COMMENT_DWELL_SECONDS) {
      current = comment
    }
  }
  return current
}

/** A comment's place on the scrub bar. */
export interface CommentMarker {
  readonly comment: SpeechComment
  /** Position along the bar, 0–1. */
  readonly position: number
}

/**
 * Places every comment on the scrub bar.
 *
 * @param comments - Any order.
 * @param durationSeconds - Length of the recording. Zero or negative returns no markers rather
 *   than stacking them all at the left edge — a bar with no length has no positions on it, and
 *   drawing them at 0 would claim every note was left in the first second.
 * @returns Markers in playback order, each clamped to the bar.
 */
export function commentMarkers(
  comments: readonly SpeechComment[],
  durationSeconds: number,
): CommentMarker[] {
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) {
    return []
  }
  return sortComments(comments).map((comment) => ({
    comment,
    position: Math.min(1, Math.max(0, comment.atSeconds / durationSeconds)),
  }))
}

/**
 * Whether a comment may be saved.
 *
 * Mirrors the Postgres check constraint rather than restating it loosely: `body` is
 * `check (length(trim(body)) > 0)`, so a comment of spaces is rejected by the database at drain
 * time — hours later, on a machine nobody is looking at. Refusing it here is the same rule
 * enforced where somebody can still fix it.
 *
 * @param body - What was typed.
 * @returns The trimmed body, or null when there is nothing in it.
 */
export function normalisedCommentBody(body: string): string | null {
  const trimmed = body.trim()
  return trimmed.length > 0 ? trimmed : null
}
