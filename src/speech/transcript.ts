/**
 * Turning what a transcription source emits into what the aligner takes.
 *
 * Kept apart from `recognition.ts` because everything here is pure and everything there talks to
 * a microphone or to Rust. The split is what lets the interesting decisions — where a word
 * boundary is, how a browser's interim result folds into the running text — be tested in node
 * with no shell around them.
 */

/**
 * Splits a transcript into the words the aligner indexes.
 *
 * Must agree with how the script side was split, which is `ScriptToken.text` — one token per
 * run of non-whitespace, punctuation still attached. Punctuation is not stripped here on
 * purpose: `normalize.ts` owns every decision about what makes two words the same word, and a
 * second place that quietly drops a full stop is a second place that can disagree with it.
 *
 * @param text - A transcript, or a fragment of one. Empty or whitespace-only gives an empty
 *   list rather than a list holding one empty string, which would align against nothing and
 *   count as an improvisation.
 * @returns The words in order.
 */
export function transcriptWords(text: string): readonly string[] {
  return text.split(/\s+/).filter((word) => word.length > 0)
}

/**
 * One result from a browser speech recogniser.
 *
 * The Web Speech API hands back a growing list where early entries are settled and the last few
 * are still being revised. `isFinal` is the recogniser's own claim about which is which.
 */
export interface SpeechResult {
  readonly transcript: string
  readonly isFinal: boolean
}

/**
 * Folds a browser recogniser's result list into one transcript.
 *
 * @param results - The whole `SpeechRecognitionResultList`, already unpacked. Passing only the
 *   new entries loses everything settled earlier, because the API's list is cumulative within a
 *   session and this makes the same assumption.
 * @returns Final and interim text joined in order, single-spaced. The interim tail is included
 *   deliberately — the teleprompter has to track a speaker mid-sentence, and waiting for the
 *   recogniser to settle puts the cursor a clause behind them.
 */
export function mergeSpeechResults(results: readonly SpeechResult[]): string {
  return results
    .map((result) => result.transcript.trim())
    .filter((piece) => piece.length > 0)
    .join(' ')
}

/**
 * Delivery pace over the whole speech so far.
 *
 * @param wordCount - Words transcribed. The transcript's count, not the script's — the point is
 *   what was said, not what was written.
 * @param elapsedSeconds - Seconds of speech. Under one second returns 0 rather than a figure in
 *   the thousands, which is what dividing by the first tick produces.
 * @returns Words per minute, rounded.
 */
export function wordsPerMinute(wordCount: number, elapsedSeconds: number): number {
  if (elapsedSeconds < 1) {
    return 0
  }
  return Math.round((wordCount / elapsedSeconds) * 60)
}
