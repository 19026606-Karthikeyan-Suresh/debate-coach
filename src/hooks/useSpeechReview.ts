/**
 * Everything that happens after the speaker sits down.
 *
 * Two reports, not one, and the order matters. The live one is built from the `base.en` transcript
 * the teleprompter was already following, so it is on screen the moment the speech ends — a report
 * that appears three minutes later is a report nobody reads, because by then the round has moved
 * on. The accurate one replaces it when `small.en` has re-transcribed the recording, and only it
 * carries timings, pauses, and numbers worth comparing between sessions.
 *
 * **The session row is written before the re-pass starts.** If whisper falls over, or the app is
 * closed, or the laptop sleeps, the speech is still in the history with the numbers that were
 * known at the time. The accurate report overwrites the same row when it lands.
 *
 * Every state change happens inside a promise callback rather than in an effect body, which is
 * both what the lint requires and what the work wants: building a report over a thousand-word
 * alignment is real CPU, and doing it synchronously while React is committing would drop the
 * frame the report renders in.
 */

import { useCallback, useState } from 'react'

import { saveSession } from '../db/index.ts'
import type { CompiledScript } from '../script/types.ts'
import type { AlignmentState } from '../speech/align.ts'
import { alignSpeech } from '../speech/align.ts'
import { buildTimeline, buildUntimedTimeline } from '../speech/metrics.ts'
import type { SpeechRecording, TranscriptionSourceId } from '../speech/recognition.ts'
import { findRecordingPauses, retranscribe } from '../speech/recognition.ts'
import { buildSpeechReport } from '../speech/report.ts'
import type { SpeechReport } from '../speech/report.ts'
import { transcriptWords } from '../speech/transcript.ts'

/** Where the review has got to. */
export type ReviewStatus =
  /** No speech has finished yet. */
  | 'idle'
  /** Building the report from the live transcript. */
  | 'building'
  /** The live report is on screen; `small.en` is re-transcribing behind it. */
  | 'reviewing'
  /** Nothing further is coming. */
  | 'ready'
  | 'error'

/** One finished speech, as handed to {@link useSpeechReview}. */
export interface ReviewRequest {
  /** Names the session row and the WAV. One per speech. */
  readonly sessionId: string
  readonly caseId: string
  readonly motion: string
  readonly format: 'AP' | 'BP'
  readonly roleId: string
  readonly roleLabel: string
  readonly isReply: boolean
  /** The script as delivered, including any delivery edits. */
  readonly script: CompiledScript
  /**
   * Row labels by field path, from `flattenFields(buildSections(case, role))`.
   *
   * Copied into the report so it can still name a row after the case has been rewritten.
   */
  readonly fieldLabels: Readonly<Record<string, string>>
  /** The alignment as it stood at the end of the speech. */
  readonly alignment: AlignmentState
  /** The live transcript, whole. Must be the one `alignment` was advanced against. */
  readonly transcript: string
  /** The WAV, or null on the browser fallback — which is what decides whether a re-pass happens. */
  readonly recording: SpeechRecording | null
  readonly source: TranscriptionSourceId
  /** Length of the speech: the recording's duration where there is one, else the clock's. */
  readonly deliveredSeconds: number
}

/** A report, and whether a better one is still coming. */
export interface SpeechReview {
  /** Null until the first report is built. Replaced, never mutated. */
  readonly report: SpeechReport | null
  readonly status: ReviewStatus
  /**
   * What went wrong, or null.
   *
   * A re-pass that fails sets this and leaves `status` at `ready` with the live report standing:
   * losing the accurate numbers is a caveat on the report, not the loss of it.
   */
  readonly error: string | null
  /** Builds the report for a finished speech. Safe to call once per session id. */
  readonly begin: (request: ReviewRequest) => void
  /** Drops the report, for starting another speech. */
  readonly clear: () => void
}

/** The half of a report's input that does not change between the live pass and the accurate one. */
function commonInput(request: ReviewRequest): {
  sessionId: string
  caseId: string
  motion: string
  format: 'AP' | 'BP'
  roleId: string
  roleLabel: string
  isReply: boolean
  script: CompiledScript
  fieldLabels: Readonly<Record<string, string>>
  deliveredSeconds: number
  source: TranscriptionSourceId
} {
  return {
    sessionId: request.sessionId,
    caseId: request.caseId,
    motion: request.motion,
    format: request.format,
    roleId: request.roleId,
    roleLabel: request.roleLabel,
    isReply: request.isReply,
    script: request.script,
    fieldLabels: request.fieldLabels,
    deliveredSeconds: request.deliveredSeconds,
    source: request.source,
  }
}

/** Reads a thrown value as a sentence. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs the post-speech review.
 *
 * @returns The review state. One instance serves one Speak screen; `begin` is called once per
 *   speech and calling it again with the same `sessionId` overwrites that session's row rather
 *   than adding a second one.
 */
export function useSpeechReview(): SpeechReview {
  const [report, setReport] = useState<SpeechReport | null>(null)
  const [status, setStatus] = useState<ReviewStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const begin = useCallback((request: ReviewRequest): void => {
    const wavPath = request.recording?.wavPath ?? null
    // Whether the live report ever got built, so the catch below can tell "the review failed"
    // from "the report failed" — the first is a caveat and the second is an error state.
    let hasLiveReport = false

    // Nothing is set synchronously: `begin` is called from an effect when the speech ends, and a
    // setState in an effect body is what the react-hooks rule bans.
    Promise.resolve()
      .then(() => {
        setStatus('building')
        setError(null)

        const live = buildSpeechReport({
          ...commonInput(request),
          alignment: request.alignment,
          timeline: buildUntimedTimeline(request.transcript),
          pauses: [],
          isAccurate: false,
        })
        setReport(live)
        setStatus(wavPath === null ? 'ready' : 'reviewing')
        hasLiveReport = true
        return saveSession(live, wavPath).catch((saveError: unknown) => {
          setError(`The speech was not saved to the library: ${messageOf(saveError)}`)
        })
      })
      .then(async () => {
        if (wavPath === null) {
          return
        }

        // Pauses come off the samples and the transcript off whisper; neither needs the other, and
        // a pause detector that fails should not cost the accurate transcript.
        const [review, pauses] = await Promise.all([
          retranscribe(wavPath),
          findRecordingPauses(wavPath).catch(() => []),
        ])

        const timeline = buildTimeline(review.segments)
        const accurate = buildSpeechReport({
          ...commonInput(request),
          // Re-aligned against the better transcript: a `spokenIndex` only means anything against
          // the transcript it came from, so the live alignment cannot be reused here.
          alignment: alignSpeech(
            request.script.tokens.map((token) => token.text),
            [...transcriptWords(timeline.transcript)],
          ),
          timeline,
          pauses,
          isAccurate: true,
        })

        setReport(accurate)
        setStatus('ready')
        await saveSession(accurate, wavPath)
      })
      .catch((reviewError: unknown) => {
        // Once the live report is on screen and stored, a failed re-pass is a caveat rather than
        // a failure. Only a report that was never built at all is an error state.
        setError(
          hasLiveReport
            ? `The accurate re-pass did not run: ${messageOf(reviewError)}`
            : messageOf(reviewError),
        )
        setStatus(hasLiveReport ? 'ready' : 'error')
      })
  }, [])

  const clear = useCallback((): void => {
    setReport(null)
    setStatus('idle')
    setError(null)
  }, [])

  return { report, status, error, begin, clear }
}
