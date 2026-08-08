/**
 * One speech: a microphone, a transcript, and an alignment against the script.
 *
 * The hook is thin on purpose. Picking a transcription source is `recognition.ts`, deciding what
 * was skipped is `align.ts`, and both are already tested without a browser around them. What is
 * left here is lifecycle — start in an order that does not lose the opening words, stop in an
 * order that does not lose the closing ones, and never leave a microphone open because a render
 * threw.
 *
 * **The aligner is advanced inside a state updater.** `advanceAlignment` is pure and takes the
 * previous state, which is exactly what an updater is for; it also means a transcript arriving
 * while React is mid-render cannot align against a stale state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { AlignmentState } from '../speech/align.ts'
import { advanceAlignment, createAlignment } from '../speech/align.ts'
import type { SpeechRecording, TranscriptionSource } from '../speech/recognition.ts'
import { createTranscriptionSource } from '../speech/recognition.ts'
import { transcriptWords } from '../speech/transcript.ts'

/** Where a speech has got to. */
export type SpeechStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'finished' | 'error'

/** A speech in progress, or one that has just finished. */
export interface SpeechSession {
  readonly status: SpeechStatus
  /** Populated only when `status` is `error`. */
  readonly error: string | null
  /** Which recogniser is running, once one has been chosen. */
  readonly sourceLabel: string | null
  /** Why the browser fallback is being used, or null when whisper is. */
  readonly fallbackReason: string | null
  /** Every script word and what became of it. Drives the teleprompter. */
  readonly alignment: AlignmentState
  /** The transcript as it stands, whole. The tail is still revisable. */
  readonly transcript: string
  /** Seconds of audio behind the transcript. Zero on the browser fallback, which reports none. */
  readonly audioSeconds: number
  /** The WAV, once the speech has stopped. Null on the fallback, which records nothing. */
  readonly recording: SpeechRecording | null
  /** Opens the microphone. No-op unless idle or finished. */
  readonly start: () => void
  /** Closes it and waits for the final transcript. */
  readonly stop: () => void
}

/**
 * Runs one speech against one script.
 *
 * @param scriptWords - The script in delivery order, normally
 *   `compiled.tokens.map((token) => token.text)`. **Must be referentially stable** — memoize it.
 *   A new array identity resets the alignment, which is correct when the case was edited and
 *   destructive if it happens every render.
 * @param sessionId - Names the recording on disk. Stable for the life of the screen.
 * @returns The session.
 */
export function useSpeechSession(
  scriptWords: readonly string[],
  sessionId: string,
): SpeechSession {
  const [status, setStatus] = useState<SpeechStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [sourceLabel, setSourceLabel] = useState<string | null>(null)
  const [fallbackReason, setFallbackReason] = useState<string | null>(null)
  const [transcript, setTranscript] = useState('')
  const [audioSeconds, setAudioSeconds] = useState(0)
  const [recording, setRecording] = useState<SpeechRecording | null>(null)
  const [alignment, setAlignment] = useState<AlignmentState>(() => createAlignment(scriptWords))

  // The live source. A ref rather than state because nothing renders from it and re-rendering
  // when a microphone opens would be a render triggered by a side effect.
  const sourceRef = useRef<TranscriptionSource | null>(null)

  // Recompiling the case gives a different script, so the alignment against the old one is
  // meaningless and starts again. Done during render, not in an effect, so the teleprompter
  // never paints one frame of the previous script's strike-throughs over the new words.
  const [alignedScript, setAlignedScript] = useState(scriptWords)
  if (alignedScript !== scriptWords && status === 'idle') {
    setAlignedScript(scriptWords)
    setAlignment(createAlignment(scriptWords))
    setTranscript('')
  }

  // A speech that is still recording when the screen closes would leave the microphone open and
  // the Rust side holding a session nothing will ever stop, so the next speech could not start.
  useEffect(() => {
    return () => {
      void sourceRef.current?.stop()
      sourceRef.current = null
    }
  }, [])

  const start = useCallback((): void => {
    if (sourceRef.current) {
      return
    }
    setStatus('starting')
    setError(null)
    setRecording(null)
    setTranscript('')
    setAudioSeconds(0)
    setAlignment(createAlignment(scriptWords))

    createTranscriptionSource(sessionId)
      .then(async (choice) => {
        sourceRef.current = choice.source
        setSourceLabel(choice.source.label)
        setFallbackReason(choice.fallbackReason)

        await choice.source.start((update) => {
          setTranscript(update.text)
          setAudioSeconds(update.audioSeconds)
          setAlignment((current) => advanceAlignment(current, transcriptWords(update.text)))
        })
        setStatus('recording')
      })
      .catch((startError: unknown) => {
        sourceRef.current = null
        setError(startError instanceof Error ? startError.message : String(startError))
        setStatus('error')
      })
  }, [scriptWords, sessionId])

  const stop = useCallback((): void => {
    const source = sourceRef.current
    if (!source) {
      return
    }
    sourceRef.current = null
    setStatus('stopping')

    source
      .stop()
      .then((finished) => {
        setRecording(finished)
        setStatus('finished')
      })
      .catch((stopError: unknown) => {
        setError(stopError instanceof Error ? stopError.message : String(stopError))
        setStatus('error')
      })
  }, [])

  return {
    status,
    error,
    sourceLabel,
    fallbackReason,
    alignment,
    transcript,
    audioSeconds,
    recording,
    start,
    stop,
  }
}
