/**
 * Putting a clock on the transcript, and the numbers that fall out of it.
 *
 * The aligner says *what* was skipped. Everything a debater wants to know beyond that is a
 * question about *when* — how fast was I going, where did I stall, did the second substantive eat
 * the third one's time — and none of it can be answered from a bare string of words.
 *
 * **Only the post-speech pass has timings, and that is not an oversight.** The live path decodes a
 * rolling window and slides it forward, so a timestamp from one window means nothing once the
 * window has moved past it. The `small.en` re-pass decodes the whole recording once, in one frame
 * of reference, and its timestamps are the first ones that are comparable with each other. The
 * live report is therefore built on an **untimed** timeline: same words, same offsets, no clock.
 * Both shapes are the same type, so nothing downstream has to know which one it has —
 * {@link SpeechTimeline.hasTimings} is the one question worth asking.
 *
 * Pure: no I/O, no Tauri, no clock of its own.
 */

import type { TranscriptionSourceId } from './source.ts'
import { wordsPerMinute } from './transcript.ts'

/**
 * One timestamped chunk of transcript, as whisper prints it.
 *
 * Mirrors `TranscriptSegment` in `src-tauri/src/whisper.rs`. Declared here rather than in
 * `recognition.ts` so the modules that reason about it stay testable in node with no shell.
 */
export interface TranscriptSegment {
  /** Seconds from the start of the recording. */
  readonly start: number
  /** Seconds from the start of the recording. Never before `start`. */
  readonly end: number
  /** The words, already trimmed. Never empty. */
  readonly text: string
}

/** A stretch of the recording where nobody was speaking. Mirrors `Pause` in `audio.rs`. */
export interface Pause {
  readonly startSeconds: number
  readonly endSeconds: number
}

/** One word of the transcript, where it sits in the text and when it was said. */
export interface TranscriptWord {
  /** Position in the transcript. The same index `AlignedToken.spokenIndex` carries. */
  readonly index: number
  readonly text: string
  /** Offset into `SpeechTimeline.transcript`, so a character span maps back to a word. */
  readonly start: number
  /** Index one past the last character. */
  readonly end: number
  /** Null on an untimed timeline. Approximate even when present — see {@link buildTimeline}. */
  readonly startSeconds: number | null
  /** Null on an untimed timeline. */
  readonly endSeconds: number | null
}

/**
 * A transcript with its words addressed the way the rest of the app addresses them.
 *
 * The load-bearing property: `words` is exactly what `transcriptWords(transcript)` produces, in
 * the same order, so a transcript word index means the same thing here as it does to the aligner.
 * Build one any other way and every skipped word is attributed to the wrong moment.
 */
export interface SpeechTimeline {
  readonly transcript: string
  readonly words: readonly TranscriptWord[]
  /** False when the words carry no clock — the live pass, or the browser fallback. */
  readonly hasTimings: boolean
  /** Seconds of audio the transcript covers, or null when untimed. */
  readonly durationSeconds: number | null
}

/** Splits a piece of text into words with their offsets. Agrees with `transcriptWords` by shape. */
function wordSpans(text: string): readonly { readonly text: string; readonly start: number }[] {
  return [...text.matchAll(/\S+/g)].map((match) => ({ text: match[0], start: match.index }))
}

/**
 * Builds a timeline from the review pass's segments.
 *
 * **Word times are interpolated across their segment, not measured.** whisper-cli times segments,
 * not words, and a segment is a clause or a sentence. So a word's time is good to about the
 * length of the clause holding it — fine for "the rebuttal ran ninety seconds" and for putting a
 * filler in the right part of the speech, and not good enough to claim a word was said at 2:14.3.
 * Nothing in the report claims that.
 *
 * @param segments - As `retranscribe_speech` returns them, in order. Blank ones are dropped; a
 *   segment whose `end` precedes its `start` contributes zero-length words rather than negative
 *   ones, because a bad timestamp must not make a section's duration come out backwards.
 * @returns The joined transcript and its words. Joining is single-spaced, which is what makes
 *   `transcriptWords(result.transcript)` agree with `result.words`.
 */
export function buildTimeline(segments: readonly TranscriptSegment[]): SpeechTimeline {
  const words: TranscriptWord[] = []
  let transcript = ''
  let durationSeconds = 0

  for (const segment of segments) {
    const text = segment.text.trim()
    if (text.length === 0) {
      continue
    }

    // Where this segment's text starts in the joined transcript, after the separating space.
    const offset = transcript.length === 0 ? 0 : transcript.length + 1
    transcript = transcript.length === 0 ? text : `${transcript} ${text}`

    const spans = wordSpans(text)
    const span = Math.max(0, segment.end - segment.start)
    for (const [position, word] of spans.entries()) {
      words.push({
        index: words.length,
        text: word.text,
        start: offset + word.start,
        end: offset + word.start + word.text.length,
        startSeconds: segment.start + (span * position) / spans.length,
        endSeconds: segment.start + (span * (position + 1)) / spans.length,
      })
    }
    durationSeconds = Math.max(durationSeconds, segment.end)
  }

  return { transcript, words, hasTimings: true, durationSeconds }
}

/**
 * Builds a timeline for a transcript that has no timings.
 *
 * The live pass and the browser fallback both land here. Everything that does not need a clock —
 * which words were skipped, what was improvised, how many fillers — works identically off this.
 *
 * @param transcript - What was heard, whole.
 * @returns A timeline whose words carry offsets but no times.
 */
export function buildUntimedTimeline(transcript: string): SpeechTimeline {
  const words = wordSpans(transcript).map((word, index) => ({
    index,
    text: word.text,
    start: word.start,
    end: word.start + word.text.length,
    startSeconds: null,
    endSeconds: null,
  }))
  return { transcript, words, hasTimings: false, durationSeconds: null }
}

/**
 * Finds the word a character offset falls in.
 *
 * @param timeline - The timeline to search.
 * @param offset - A character offset into `timeline.transcript`, normally the start of a filler's
 *   span. An offset in the whitespace between two words resolves to the word after it.
 * @returns The word, or null past the end of the transcript.
 */
export function wordAtOffset(timeline: SpeechTimeline, offset: number): TranscriptWord | null {
  return timeline.words.find((word) => word.end > offset) ?? null
}

/**
 * When a transcript word was said.
 *
 * @param timeline - The timeline to read.
 * @param index - A transcript word index, normally an `AlignedToken.spokenIndex`. Out of range
 *   returns null rather than throwing — the alignment and the timeline are built from the same
 *   transcript, but a caller that mixes the live one with the review one would otherwise crash.
 * @returns Seconds from the start of the recording, or null when untimed.
 */
export function secondsAtWord(timeline: SpeechTimeline, index: number | null): number | null {
  if (index === null) {
    return null
  }
  return timeline.words[index]?.startSeconds ?? null
}

/** Words per minute over one stretch of the speech. */
export interface PacePoint {
  /** Start of the bucket, in seconds. */
  readonly atSeconds: number
  readonly wordsPerMinute: number
}

/**
 * Window the pace chart is drawn in.
 *
 * Twenty seconds is roughly one substantive's worth of body text. Shorter buckets chart the
 * speaker breathing; longer ones flatten the sprint at the end that every debater does and that
 * this chart exists to show them.
 */
export const PACE_BUCKET_SECONDS = 20

/**
 * Pace across the speech.
 *
 * @param timeline - Must have timings; an untimed one returns an empty series rather than a flat
 *   line at the average, which would be a chart of a number nobody measured.
 * @param bucketSeconds - Window width. Values under a second produce one bucket per word.
 * @returns One point per bucket, in order. A trailing bucket covering less than a third of its
 *   width is dropped: three words in the last two seconds of a speech is not 90 words a minute.
 */
export function pacePoints(
  timeline: SpeechTimeline,
  bucketSeconds: number = PACE_BUCKET_SECONDS,
): readonly PacePoint[] {
  if (!timeline.hasTimings || timeline.words.length === 0) {
    return []
  }
  const width = Math.max(1, bucketSeconds)
  const duration = timeline.durationSeconds ?? 0

  const counts = new Map<number, number>()
  for (const word of timeline.words) {
    const bucket = Math.floor((word.startSeconds ?? 0) / width)
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }

  const lastBucket = Math.max(...counts.keys())
  const points: PacePoint[] = []
  for (let bucket = 0; bucket <= lastBucket; bucket += 1) {
    const covered = Math.min(width, duration - bucket * width)
    if (bucket === lastBucket && covered < width / 3) {
      break
    }
    points.push({
      atSeconds: bucket * width,
      wordsPerMinute: wordsPerMinute(counts.get(bucket) ?? 0, width),
    })
  }
  return points
}

/**
 * The dozen numbers a session is compared by.
 *
 * Kept small and flat on purpose: this is what goes in `sessions.metrics`, what phase 9 syncs to
 * the team, and what the history charts read. The detail behind it lives in the report, which
 * stays on the machine that recorded it.
 */
export interface SessionMetrics {
  /** Shape version. Bumped when a field changes meaning, so an old row is never charted as a new one. */
  readonly version: 1
  readonly durationSeconds: number
  /** Words in the compiled script. */
  readonly scriptWords: number
  /** Words actually transcribed. Higher than `scriptWords` means a lot was improvised. */
  readonly spokenWords: number
  readonly skippedWords: number
  /** Share of the script *reached* that was skipped, 0 to 1. See `skipRate` in `align.ts`. */
  readonly skipRate: number
  readonly improvisedWords: number
  readonly fillerCount: number
  /** Fillers per minute of speech. The comparable number; a raw count rewards a short speech. */
  readonly fillersPerMinute: number
  readonly pauseCount: number
  readonly longestPauseSeconds: number
  readonly wordsPerMinute: number
  readonly source: TranscriptionSourceId
  /**
   * True when these came from the `small.en` re-pass.
   *
   * A false here is not a small caveat. Filler counts especially are not comparable across
   * models, so the history chart must not plot a live number beside a reviewed one without
   * saying so.
   */
  readonly isAccurate: boolean
}

/** Everything {@link summariseSession} needs. Assembled by `report.ts`, which owns the counting. */
export interface SessionMetricsInput {
  readonly durationSeconds: number
  readonly scriptWords: number
  readonly spokenWords: number
  readonly skippedWords: number
  readonly skipRate: number
  readonly improvisedWords: number
  readonly fillerCount: number
  readonly pauses: readonly Pause[]
  readonly source: TranscriptionSourceId
  readonly isAccurate: boolean
}

/**
 * Rolls the counts into the session's row.
 *
 * @param input - The raw counts. `durationSeconds` under one second yields a pace and a filler
 *   rate of zero rather than a figure in the thousands, which is what dividing by the first tick
 *   produces.
 * @returns The metrics, safe to serialise straight into `sessions.metrics`.
 */
export function summariseSession(input: SessionMetricsInput): SessionMetrics {
  const minutes = input.durationSeconds / 60
  const longest = input.pauses.reduce(
    (longestSoFar, pause) => Math.max(longestSoFar, pause.endSeconds - pause.startSeconds),
    0,
  )

  return {
    version: 1,
    durationSeconds: Math.round(input.durationSeconds),
    scriptWords: input.scriptWords,
    spokenWords: input.spokenWords,
    skippedWords: input.skippedWords,
    skipRate: input.skipRate,
    improvisedWords: input.improvisedWords,
    fillerCount: input.fillerCount,
    fillersPerMinute:
      minutes > 1 / 60 ? Math.round((input.fillerCount / minutes) * 10) / 10 : 0,
    pauseCount: input.pauses.length,
    longestPauseSeconds: Math.round(longest * 10) / 10,
    wordsPerMinute: wordsPerMinute(input.spokenWords, input.durationSeconds),
    source: input.source,
    isAccurate: input.isAccurate,
  }
}
