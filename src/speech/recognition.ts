/**
 * Where the words come from.
 *
 * Two implementations behind one interface, and the second one is not a nicety. Whisper is a
 * 150 MB model and a native binary; it is missing on a fresh clone, it is missing if the fetch
 * script has not been run, and it will be missing on somebody's machine at a tournament. A
 * speech trainer that refuses to open the teleprompter because a download failed is a speech
 * trainer nobody takes to a round, so the browser recogniser stays as the fallback — worse
 * transcripts, no recording, but the script still scrolls and the skips are still caught.
 *
 * Everything here is I/O. The decisions worth testing live in `transcript.ts`.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'

import { MicrophoneCapture } from './capture.ts'
import type { Pause, TranscriptSegment } from './metrics.ts'
import { mergeSpeechResults } from './transcript.ts'
import type { SpeechResult } from './transcript.ts'

/** Event name the Rust side emits transcripts on. Must match `TRANSCRIPT_EVENT` in `whisper.rs`. */
const TRANSCRIPT_EVENT = 'speech://transcript'

/** A transcript as it stands. Always the whole thing, never a delta. */
export interface LiveTranscript {
  /** Everything heard so far. The tail is still revisable; the aligner expects that. */
  readonly text: string
  /** Seconds of audio behind it. Zero from the browser recogniser, which reports no timing. */
  readonly audioSeconds: number
  /** True on the last update after a stop. */
  readonly isFinal: boolean
}

/** What a finished recording left on disk. */
export interface SpeechRecording {
  /** Absolute path to the local WAV. Stays local; phase 9 uploads an Opus copy. */
  readonly wavPath: string
  readonly durationSeconds: number
}

/** Which recogniser produced a transcript. Shown in the UI, and stored on the session row. */
export type TranscriptionSourceId = 'whisper' | 'web-speech'

/**
 * A live transcription session.
 *
 * One instance is one speech. Implementations do not support being restarted after `stop`.
 */
export interface TranscriptionSource {
  readonly id: TranscriptionSourceId
  /** Shown next to the record button, so it is never a mystery which engine is running. */
  readonly label: string
  /**
   * Opens the microphone and starts emitting.
   *
   * @param onTranscript - Called with the whole transcript on every update, not the new words.
   * @returns Resolves once audio is actually being captured.
   */
  start: (onTranscript: (transcript: LiveTranscript) => void) => Promise<void>
  /**
   * Ends the speech.
   *
   * @returns The recording, or null when the source does not produce one.
   */
  stop: () => Promise<SpeechRecording | null>
}

/** Whisper's availability, as `whisper_status` reports it. */
export interface WhisperStatus {
  readonly available: boolean
  readonly assets: { readonly cli: string; readonly liveModel: string; readonly reviewModel: string } | null
  /** Why not, phrased for a person. Null when available. */
  readonly reason: string | null
}

/** Whether the app is running inside the Tauri shell rather than a bare browser tab. */
export function isTauriShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Asks the shell whether whisper is installed.
 *
 * @returns The status. Outside the Tauri shell — the throwaway verify page, a browser tab —
 *   returns unavailable rather than throwing, because that is the honest answer there.
 */
export async function readWhisperStatus(): Promise<WhisperStatus> {
  if (!isTauriShell()) {
    return { available: false, assets: null, reason: 'Not running in the desktop shell.' }
  }
  try {
    return await invoke<WhisperStatus>('whisper_status')
  } catch (error) {
    return { available: false, assets: null, reason: String(error) }
  }
}

/** The accurate transcript and the timings only the post-speech pass has. */
export interface ReviewTranscript {
  /** Every segment's text, joined by single spaces. */
  readonly text: string
  /** The same words, still carrying the times they were said at. */
  readonly segments: readonly TranscriptSegment[]
}

/**
 * Re-transcribes a finished recording with `small.en`.
 *
 * The accurate pass, and the one the report's numbers are built from. `base.en` is chosen live
 * because it keeps up, not because it is right.
 *
 * Minutes of CPU on a seven-minute speech, which is why the Rust side runs it off the main
 * thread and why the UI is expected to show the live report first and swap this one in.
 *
 * @param wavPath - As returned by `stop`. A path from anywhere else is not guaranteed to be
 *   16 kHz mono, and whisper transcribes anything else as noise.
 * @returns The transcript, and the segments the timeline is built from.
 * @throws If whisper is unavailable or the decode fails.
 */
export function retranscribe(wavPath: string): Promise<ReviewTranscript> {
  return invoke<ReviewTranscript>('retranscribe_speech', { wavPath })
}

/**
 * Finds the silences in a finished recording.
 *
 * Measured off the samples rather than off the transcript — whisper's segment timestamps are
 * usually flush against each other, so a pause the speaker really took shows up as no gap at all.
 *
 * @param wavPath - As returned by `stop`.
 * @param minSeconds - Shortest gap to report. Omit for two seconds, which is roughly where a
 *   pause stops reading as emphasis and starts reading as lost.
 * @returns The pauses in order. Empty for a recording with no speech in it.
 * @throws If the file cannot be read or is not 16 kHz mono.
 */
export function findRecordingPauses(wavPath: string, minSeconds?: number): Promise<Pause[]> {
  return invoke<Pause[]>('find_recording_pauses', { wavPath, minSeconds })
}

/**
 * Whisper via the Rust sidecar. The primary source.
 *
 * The browser owns the microphone and Rust owns the model: capture, downsampling and the device
 * permission stay where they already work, and the PCM goes over one command as a raw body.
 */
export class WhisperLiveSource implements TranscriptionSource {
  readonly id = 'whisper' as const
  readonly label = 'whisper base.en'

  private capture: MicrophoneCapture | null = null
  private unlisten: UnlistenFn | null = null
  private isRunning = false

  /**
   * @param sessionId - Names the WAV on disk. Pass the session row's id so the recording can be
   *   found again; anything not safe in a filename will fail when the file is created.
   */
  constructor(private readonly sessionId: string) {}

  /**
   * Starts the sidecar, then the microphone.
   *
   * Ordered that way deliberately: the worker has to be listening before the first PCM arrives,
   * or the opening words of the speech go into a buffer nothing is reading.
   *
   * @param onTranscript - Receives every update the worker emits.
   * @throws If whisper is unavailable or a recording is already open.
   */
  async start(onTranscript: (transcript: LiveTranscript) => void): Promise<void> {
    this.unlisten = await listen<LiveTranscript>(TRANSCRIPT_EVENT, (event) => {
      onTranscript(event.payload)
    })

    try {
      await invoke<string>('start_speech_session', { sessionId: this.sessionId })
    } catch (error) {
      await this.unlisten()
      this.unlisten = null
      throw error
    }

    this.capture = new MicrophoneCapture({
      onChunk: (pcm) => {
        // Fire and forget. Awaiting would back-pressure the audio callback, and a dropped chunk
        // is a fraction of a second the transcript is short — far better than a stalled capture
        // graph, which loses everything after it.
        void invoke('push_speech_audio', new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)).catch(
          (error: unknown) => {
            console.warn('dropped an audio chunk', error)
          },
        )
      },
    })

    try {
      await this.capture.start()
      this.isRunning = true
    } catch (error) {
      // The microphone was refused after the session opened; close it so the next attempt is not
      // rejected as "already recording".
      await invoke('stop_speech_session').catch(() => undefined)
      await this.unlisten()
      this.unlisten = null
      this.capture = null
      throw error
    }
  }

  /**
   * Stops capture and waits for the worker's final flush.
   *
   * @returns The WAV and its duration. Null only when `start` never succeeded.
   */
  async stop(): Promise<SpeechRecording | null> {
    if (!this.isRunning) {
      return null
    }
    this.isRunning = false

    // The microphone closes first so the last words reach the buffer before the worker is told
    // there is no more audio coming.
    await this.capture?.stop()
    this.capture = null

    try {
      return await invoke<SpeechRecording>('stop_speech_session')
    } finally {
      await this.unlisten?.()
      this.unlisten = null
    }
  }
}

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

/** The browser's recogniser constructor, or null where there is none. */
function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
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
 * The browser's own recogniser. The fallback when whisper is not installed.
 *
 * Three things it cannot do, all of which the UI has to say out loud rather than paper over: it
 * keeps no recording, so there is nothing for `small.en` to re-transcribe and nothing to play
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

/** A source, plus why it is the one that got picked. */
export interface SourceChoice {
  readonly source: TranscriptionSource
  /** Null when whisper was chosen; the reason it was not, when it was not. */
  readonly fallbackReason: string | null
}

/**
 * Picks the best available transcription source.
 *
 * @param sessionId - Names the recording if whisper is chosen. Ignored by the fallback.
 * @returns The source and, when it is the fallback, why. Throws only when neither is available,
 *   which is the one case the Speak screen genuinely cannot open in.
 * @throws If whisper is missing and the browser has no recogniser either.
 */
export async function createTranscriptionSource(sessionId: string): Promise<SourceChoice> {
  const status = await readWhisperStatus()
  if (status.available) {
    return { source: new WhisperLiveSource(sessionId), fallbackReason: null }
  }
  if (!speechRecognitionConstructor()) {
    throw new Error(
      `No transcription available. ${status.reason ?? ''} Run scripts/fetch-whisper.ps1.`.trim(),
    )
  }
  return {
    source: new WebSpeechSource(),
    fallbackReason: status.reason ?? 'whisper is not installed',
  }
}
