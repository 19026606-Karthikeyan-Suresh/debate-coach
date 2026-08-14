/**
 * Whisper through the Rust sidecar, and the browser recogniser behind it.
 *
 * The browser owns the microphone and Rust owns the model: capture, downsampling and the device
 * permission stay where they already work, and the PCM goes over one command as a raw body.
 *
 * The fallback is not a nicety. Whisper is a 150 MB model and a native binary; it is missing on a
 * fresh clone, it is missing if the fetch script has not been run, and it will be missing on
 * somebody's machine at a tournament. A speech trainer that refuses to open the teleprompter
 * because a download failed is a speech trainer nobody takes to a round.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'

import { MicrophoneCapture } from '../../speech/capture.ts'
import type { Pause } from '../../speech/metrics.ts'
import type {
  LiveTranscript,
  SourceChoice,
  SpeechRecording,
  TranscriptionSource,
} from '../../speech/source.ts'
import { speechRecognitionConstructor, WebSpeechSource } from '../../speech/webSpeech.ts'
import type { ReviewTranscript, SpeechPlatform } from '../types.ts'

/** Event name the Rust side emits transcripts on. Must match `TRANSCRIPT_EVENT` in `whisper.rs`. */
const TRANSCRIPT_EVENT = 'speech://transcript'

/** Whisper's availability, as `whisper_status` reports it. */
interface WhisperStatus {
  readonly available: boolean
  readonly assets: {
    readonly cli: string
    readonly liveModel: string
    readonly reviewModel: string
  } | null
  /** Why not, phrased for a person. Null when available. */
  readonly reason: string | null
}

/**
 * Whether the Tauri IPC is actually underneath this bundle.
 *
 * Not redundant with the build target. `npm run dev` serves the desktop bundle into a plain
 * browser tab — which is how the UI is driven without the shell — and every `invoke` there throws.
 */
function isTauriShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Asks the shell whether whisper is installed, answering honestly when there is no shell. */
async function readWhisperStatus(): Promise<WhisperStatus> {
  if (!isTauriShell()) {
    return { available: false, assets: null, reason: 'Not running in the desktop shell.' }
  }
  try {
    return await invoke<WhisperStatus>('whisper_status')
  } catch (error) {
    return { available: false, assets: null, reason: String(error) }
  }
}

/**
 * Re-transcribes a finished recording with `small.en`.
 *
 * The accurate pass, and the one the report's numbers are built from. `base.en` is chosen live
 * because it keeps up, not because it is right.
 *
 * Minutes of CPU on a seven-minute speech, which is why the Rust side runs it off the main thread
 * and why the UI is expected to show the live report first and swap this one in.
 *
 * @param wavPath - As returned by `stop`. A path from anywhere else is not guaranteed to be
 *   16 kHz mono, and whisper transcribes anything else as noise.
 * @returns The transcript, and the segments the timeline is built from.
 * @throws If whisper is unavailable or the decode fails.
 */
function retranscribe(wavPath: string): Promise<ReviewTranscript> {
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
function findRecordingPauses(wavPath: string, minSeconds?: number): Promise<Pause[]> {
  return invoke<Pause[]>('find_recording_pauses', { wavPath, minSeconds })
}

/** Whisper via the Rust sidecar. The primary source. */
class WhisperLiveSource implements TranscriptionSource {
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
        void invoke(
          'push_speech_audio',
          new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        ).catch((error: unknown) => {
          console.warn('dropped an audio chunk', error)
        })
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

/**
 * Picks the best available transcription source.
 *
 * @param sessionId - Names the recording if whisper is chosen. Ignored by the fallback.
 * @returns The source and, when it is the fallback, why.
 * @throws If whisper is missing and the browser has no recogniser either — the one case the Speak
 *   screen genuinely cannot open in.
 */
async function createTranscriptionSource(sessionId: string): Promise<SourceChoice> {
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

/** Whisper first, the browser recogniser second, and a real review pass over the WAV. */
export const speech: SpeechPlatform = {
  hasReviewPass: true,
  createTranscriptionSource,
  retranscribe,
  findRecordingPauses,
}
