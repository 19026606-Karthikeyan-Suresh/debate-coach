/**
 * Where the words come from.
 *
 * A facade over the shell's choice of recogniser. The desktop tries whisper and falls back to the
 * browser's; a browser build has only the browser's, beside a `MediaRecorder` for the audio. What
 * every caller sees either way is one `TranscriptionSource` and a reason, when there is one.
 *
 * The interface itself is in `source.ts` and the browser recogniser in `webSpeech.ts`, both of
 * which are shell-free — `metrics.ts` and `report.ts` reason about a transcript and must keep
 * running in node with nothing underneath them.
 *
 * `retranscribe` and `findRecordingPauses` are the review pass, and a browser has neither. Read
 * `speech.hasReviewPass` from `@platform` before offering them rather than calling and handling
 * the rejection: a report that quietly lacks its pause section looks like a bug.
 */

import { speech } from '@platform'

export type { ReviewTranscript } from '../platform/types.ts'
export type {
  LiveTranscript,
  SourceChoice,
  SpeechRecording,
  TranscriptionSource,
  TranscriptionSourceId,
} from './source.ts'
export { WebSpeechSource } from './webSpeech.ts'

export const { createTranscriptionSource, retranscribe, findRecordingPauses } = speech
