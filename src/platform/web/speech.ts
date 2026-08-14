/**
 * Speech in a browser: the recogniser that is already written, and no review pass.
 *
 * `WebSpeechSource` is shared with the desktop, where it is the fallback for a machine that never
 * fetched whisper. Here it is the only option — a 150 MB model and a native binary are not things
 * a web page has — so the Speak screen says which engine is running and what that costs, exactly
 * as it already does on a desktop without whisper.
 *
 * **`hasReviewPass` is false, and that is the honest half of this file.** The accurate second
 * transcription and the pause detector both decode a WAV locally, which is a native decoder over
 * a file. Without them a report has no pauses, no per-section durations and no pace chart. The UI
 * already labels every number with which pass produced it, so the absence reads as a platform
 * rather than as a bug — which is why the flag exists instead of these two rejecting.
 *
 * Recording the audio is a separate question from transcribing it, and `MediaRecorder` can do it.
 * That lands with playback and sharing; see `recordings.ts` for the two container facts that make
 * it more than a one-liner.
 */

import type { Pause } from '../../speech/metrics.ts'
import type { SourceChoice } from '../../speech/source.ts'
import { speechRecognitionConstructor, WebSpeechSource } from '../../speech/webSpeech.ts'
import type { ReviewTranscript, SpeechPlatform } from '../types.ts'

/** Why the review pass is missing, in the words the report shows. */
const NO_REVIEW = 'The web app transcribes live only, so there is no second pass over the audio.'

/**
 * Picks the transcription source.
 *
 * @param sessionId - Ignored: this source keeps no recording to name.
 * @returns The browser recogniser, with the reason it is the one that got picked.
 * @throws If the browser has no recogniser at all — Firefox, and Safari before 14.5. That is the
 *   one case the Speak screen genuinely cannot open in, and it is better said outright than shown
 *   as a teleprompter that never advances.
 */
async function createTranscriptionSource(sessionId: string): Promise<SourceChoice> {
  void sessionId
  await Promise.resolve()
  if (!speechRecognitionConstructor()) {
    throw new Error(
      'This browser has no speech recognition. Chrome, Edge or Safari 14.5 and later can run the teleprompter.',
    )
  }
  return {
    source: new WebSpeechSource(),
    fallbackReason: 'the web app uses the browser’s own recogniser',
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

/** The browser's recogniser, live only. */
export const speech: SpeechPlatform = {
  hasReviewPass: false,
  createTranscriptionSource,
  retranscribe,
  findRecordingPauses,
}
