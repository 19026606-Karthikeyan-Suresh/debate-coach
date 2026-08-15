/**
 * Speech in a browser: the recogniser transcribes, `MediaRecorder` keeps the audio.
 *
 * `WebSpeechSource` is shared with the desktop, where it is the fallback for a machine that never
 * fetched whisper. Here it is the only transcriber — a 150 MB model and a native binary are not
 * things a web page has — so the Speak screen says which engine is running and what that costs,
 * exactly as it already does on a desktop without whisper.
 *
 * **Two microphone consumers, and it is not a choice.** The Web Speech API opens the microphone
 * internally and cannot be handed a `MediaStream`, so there is no stream to share with the
 * recorder even if sharing were preferable. This is the assumption most likely to break the
 * screen, and it cannot be proved without a real device: everything below is written so that a
 * refused recorder costs the *recording* and not the speech.
 *
 * **`hasReviewPass` is false, and that is the honest half of this file.** The accurate second
 * transcription and the pause detector both decode audio locally with a native decoder. Without
 * them a report has no pauses, no per-section durations and no pace chart. The UI already labels
 * every number with which pass produced it, so the absence reads as a platform rather than a bug.
 */

import type { Pause } from '../../speech/metrics.ts'
import { canRecordAudio, MicrophoneRecorder } from '../../speech/recorder.ts'
import type {
  LiveTranscript,
  SourceChoice,
  SpeechRecording,
  TranscriptionSource,
} from '../../speech/source.ts'
import { speechRecognitionConstructor, WebSpeechSource } from '../../speech/webSpeech.ts'
import type { ReviewTranscript, SpeechPlatform } from '../types.ts'
import { registerRecording } from './recordings.ts'

/** Why the review pass is missing, in the words the report shows. */
const NO_REVIEW = 'The web app transcribes live only, so there is no second pass over the audio.'

/**
 * The browser's recogniser, with the microphone recorded alongside it.
 *
 * The two halves fail independently on purpose. A refused or absent recorder leaves the
 * teleprompter running and the report intact — it costs the playback and the coach's comments,
 * which is a smaller loss than the speech. A refused recogniser is fatal, because without a
 * transcript there is nothing to align against and the screen has no job.
 */
class WebSpeechWithRecording implements TranscriptionSource {
  readonly id = 'web-speech' as const
  readonly label = 'browser speech recognition'

  private readonly transcriber = new WebSpeechSource()
  private recorder: MicrophoneRecorder | null = null

  /**
   * @param sessionId - Names the recording in the registry. Must be the id that reaches the
   *   session row, because that is what the player and the upload will ask for it by.
   */
  constructor(private readonly sessionId: string) {}

  /**
   * Starts recognition, and recording if the browser allows it.
   *
   * The recorder goes first: it is the one that prompts for the microphone, and a permission
   * dialog that appears *after* the speaker has started talking costs them the opening.
   *
   * @param onTranscript - Receives the whole transcript on every update.
   * @throws Only if recognition itself cannot start.
   */
  async start(onTranscript: (transcript: LiveTranscript) => void): Promise<void> {
    if (canRecordAudio()) {
      const recorder = new MicrophoneRecorder()
      try {
        await recorder.start()
        this.recorder = recorder
      } catch (error) {
        // Refused, or no input device. The speech is still worth giving.
        console.warn('recording unavailable; continuing without it', error)
        this.recorder = null
      }
    }
    await this.transcriber.start(onTranscript)
  }

  /**
   * Stops both halves.
   *
   * @returns The recording, or null when there was none. The duration comes from the recorder's
   *   own wall clock — the browser recogniser reports no timing at all, which is the same reason
   *   `LiveTranscript.audioSeconds` is zero throughout.
   */
  async stop(): Promise<SpeechRecording | null> {
    await this.transcriber.stop()

    const recorder = this.recorder
    this.recorder = null
    if (!recorder) {
      return null
    }
    const audio = await recorder.stop()
    if (!audio) {
      return null
    }
    registerRecording(this.sessionId, audio)
    return { handle: this.sessionId, durationSeconds: audio.durationSeconds }
  }
}

/**
 * Picks the transcription source.
 *
 * @param sessionId - Names the recording, and must match the session row's id.
 * @returns The browser recogniser, with the reason it is the one that got picked.
 * @throws If the browser has no recogniser at all — Firefox, and Safari before 14.5. That is the
 *   one case the Speak screen genuinely cannot open in, and it is better said outright than shown
 *   as a teleprompter that never advances.
 */
async function createTranscriptionSource(sessionId: string): Promise<SourceChoice> {
  await Promise.resolve()
  if (!speechRecognitionConstructor()) {
    throw new Error(
      'This browser has no speech recognition. Chrome, Edge or Safari 14.5 and later can run the teleprompter.',
    )
  }
  return {
    source: new WebSpeechWithRecording(sessionId),
    fallbackReason: canRecordAudio()
      ? 'the web app uses the browser’s own recogniser'
      : 'the web app uses the browser’s own recogniser, and this browser cannot record audio',
  }
}

/**
 * Re-transcribes a finished recording.
 *
 * @param wavPath - Ignored.
 * @returns Never. Guarded by `hasReviewPass`, so reaching this is a bug.
 */
function retranscribe(wavPath: string): Promise<ReviewTranscript> {
  void wavPath
  return Promise.reject(new Error(NO_REVIEW))
}

/**
 * Finds the silences in a finished recording.
 *
 * @param wavPath - Ignored.
 * @param minSeconds - Ignored.
 * @returns Never; same guard as {@link retranscribe}.
 */
function findRecordingPauses(wavPath: string, minSeconds?: number): Promise<Pause[]> {
  void wavPath
  void minSeconds
  return Promise.reject(new Error(NO_REVIEW))
}

/** The browser's recogniser, live only, with the audio kept beside it. */
export const speech: SpeechPlatform = {
  hasReviewPass: false,
  createTranscriptionSource,
  retranscribe,
  findRecordingPauses,
}
