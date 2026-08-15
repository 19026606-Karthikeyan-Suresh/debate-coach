/**
 * The browser's own recogniser.
 *
 * Both shells use it: on the desktop it is the fallback for a machine where whisper was never
 * fetched, and in a browser it is the only thing there. It lives outside `recognition.ts` so a
 * platform implementation can reach it without importing the module that reaches back into
 * `@platform` to choose between sources.
 */

import type { LiveTranscript, SpeechRecording, TranscriptionSource } from './source.ts'
import { mergeSpeechResults } from './transcript.ts'
import type { SpeechResult } from './transcript.ts'

/** The bits of the Web Speech API this uses, declared locally so it compiles without the lib. */
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

/** Constructor shape, under either of the two names browsers expose it as. */
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

/**
 * The browser's recogniser constructor, or null where there is none.
 *
 * @returns The constructor. Null outside a browser, and null in Firefox and Safari, which is why
 *   every caller has to have something to say when there is no recogniser at all.
 */
export function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') {
    return null
  }
  const candidates = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return candidates.SpeechRecognition ?? candidates.webkitSpeechRecognition ?? null
}

/**
 * The browser's own recogniser, wrapped as a source.
 *
 * Three things it cannot do, all of which the UI has to say out loud rather than paper over: it
 * keeps no recording, so there is nothing for an accurate pass to re-transcribe and nothing to play
 * back; in Chrome it goes through Google's servers, so it is the one part of the app that is not
 * offline; and its transcripts are worse, which shows up as `near` matches the aligner has to
 * absorb.
 */
export class WebSpeechSource implements TranscriptionSource {
  readonly id = 'web-speech' as const
  readonly label = 'browser speech recognition'

  private recognition: SpeechRecognitionLike | null = null

  /** False once `stop` has been called, so the auto-restart below knows not to. */
  private wantsRunning = false

  /**
   * Starts recognition.
   *
   * @param onTranscript - Receives the merged transcript on every result.
   * @throws If the browser has no speech recogniser.
   */
  start(onTranscript: (transcript: LiveTranscript) => void): Promise<void> {
    const Recogniser = speechRecognitionConstructor()
    if (!Recogniser) {
      throw new Error('This browser has no speech recognition, and whisper is not installed.')
    }

    const recognition = new Recogniser()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event) => {
      const results: SpeechResult[] = []
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index]
        const alternative = result?.[0]
        if (result && alternative) {
          results.push({ transcript: alternative.transcript, isFinal: result.isFinal })
        }
      }
      onTranscript({ text: mergeSpeechResults(results), audioSeconds: 0, isFinal: false })
    }

    // Chrome ends the session after a pause even with `continuous` set, and a debater pauses.
    // Restarting is the only way to hold a recogniser open for a seven-minute speech.
    recognition.onend = () => {
      if (this.wantsRunning) {
        recognition.start()
      }
    }
    recognition.onerror = (event) => {
      console.warn('speech recognition error', event.error)
    }

    this.recognition = recognition
    this.wantsRunning = true
    recognition.start()
    return Promise.resolve()
  }

  /**
   * Stops recognition.
   *
   * @returns Always null — this source records nothing.
   */
  stop(): Promise<SpeechRecording | null> {
    this.wantsRunning = false
    this.recognition?.stop()
    this.recognition = null
    return Promise.resolve(null)
  }
}
