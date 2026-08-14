/**
 * What a transcription source is, with no opinion about where one comes from.
 *
 * Split out of `recognition.ts` when the platform seam landed, for the reason that file already
 * gave for keeping `TranscriptionSourceId` shallow: the modules that reason about a transcript —
 * `metrics.ts`, `report.ts`, and the aligner behind them — must stay testable in node with no
 * shell. `recognition.ts` now reaches into `@platform` to pick a source, so anything importing
 * these types from there would be importing a shell to read an interface.
 */

/** A transcript as it stands. Always the whole thing, never a delta. */
export interface LiveTranscript {
  /** Everything heard so far. The tail is still revisable; the aligner expects that. */
  readonly text: string
  /** Seconds of audio behind it. Zero from the browser recogniser, which reports no timing. */
  readonly audioSeconds: number
  /** True on the last update after a stop. */
  readonly isFinal: boolean
}

/** What a finished recording left behind. */
export interface SpeechRecording {
  /** Absolute path to the local WAV. Stays local; an Opus copy is what gets uploaded. */
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

/** A source, plus why it is the one that got picked. */
export interface SourceChoice {
  readonly source: TranscriptionSource
  /** Null when the primary source was chosen; the reason it was not, when it was not. */
  readonly fallbackReason: string | null
}
