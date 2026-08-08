/**
 * What the microphone heard, and the three numbers that follow from it.
 *
 * The transcript is shown for one reason: when the prompter stops following, the debater has to
 * be able to see whether that is because they went off script or because the microphone is not
 * hearing them. Those are opposite problems and nothing else on the screen distinguishes them.
 */

import type { AlignmentState } from '../../speech/align.ts'
import { skipRate, tokensWithStatus } from '../../speech/align.ts'
import { transcriptWords, wordsPerMinute } from '../../speech/transcript.ts'

/** Props for {@link LiveTranscript}. */
export interface LiveTranscriptProps {
  readonly transcript: string
  readonly alignment: AlignmentState
  /** Seconds of audio behind the transcript. Zero on the browser fallback, which reports none. */
  readonly audioSeconds: number
  /** Falls back to `audioSeconds` for pace when the source reports no timing of its own. */
  readonly elapsedSeconds: number
}

/** One labelled number in the stat row. `tone` is a colour class, or '' for the default. */
function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</span>
      <span className="text-[0.65rem] tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
        {label}
      </span>
    </div>
  )
}

/**
 * Renders the live transcript and the delivery numbers.
 *
 * @param props - See {@link LiveTranscriptProps}.
 * @param props.transcript - The whole transcript so far.
 * @param props.alignment - Supplies the skip count and the improvisations.
 * @param props.audioSeconds - Audio behind the transcript, for pace.
 * @param props.elapsedSeconds - Clock time, used for pace when the source reports no audio time.
 * @returns The transcript panel.
 */
export function LiveTranscript({
  transcript,
  alignment,
  audioSeconds,
  elapsedSeconds,
}: LiveTranscriptProps): React.JSX.Element {
  const spokenCount = transcriptWords(transcript).length
  const skipped = tokensWithStatus(alignment, 'skipped').length
  const pace = wordsPerMinute(spokenCount, audioSeconds > 0 ? audioSeconds : elapsedSeconds)

  // Rounded from the aligner's share-of-what-was-reached, not from skipped-over-whole-script:
  // the rest of the speech has not been missed, it has not happened.
  const skippedShare = Math.round(skipRate(alignment) * 100)

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="words/min" value={pace > 0 ? String(pace) : '—'} tone="" />
        <Stat
          label="skipped"
          value={String(skipped)}
          tone={skipped > 0 ? 'text-red-600 dark:text-red-400' : ''}
        />
        <Stat label="skip rate" value={`${String(skippedShare)}%`} tone="" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md bg-neutral-100 p-2 text-xs leading-relaxed text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
        {transcript.length > 0 ? (
          transcript
        ) : (
          <span className="text-neutral-400 dark:text-neutral-500">
            Nothing heard yet. If this stays empty while you speak, the microphone is the problem,
            not the script.
          </span>
        )}
      </div>

      {alignment.improvisations.length > 0 ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {alignment.improvisations.length} word
          {alignment.improvisations.length === 1 ? '' : 's'} said that are not in the script.
        </p>
      ) : null}
    </div>
  )
}
