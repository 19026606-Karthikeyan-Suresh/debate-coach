/**
 * Recording a speech in a browser.
 *
 * The desktop path is: capture to a WAV, encode it to Ogg Opus in Rust, upload the encoded copy.
 * `MediaRecorder` collapses the first two — it emits a compressed container directly — so
 * `opus.rs` and the hand-written Ogg muxer have no counterpart here.
 *
 * **What container comes out is negotiated, not assumed**, and {@link pickRecordingFormat} is
 * where that lives because it is the only part of this file a test can reach: everything else
 * needs a microphone.
 */

/** A container this shell can record into, and what to call the file it produces. */
export interface RecordingFormat {
  /** Passed to `MediaRecorder` as `mimeType`. Empty means "let the browser choose". */
  readonly mimeType: string
  /** Extension for the object key, without the dot. */
  readonly extension: string
}

/**
 * Containers to try, best first.
 *
 * **`audio/mp4;codecs=opus` is deliberately absent, and Chromium reports it as supported.** Opus
 * inside an MP4 container does not play on Safari or iOS, and a recording is the one artefact in
 * this app that is made on one machine and opened on somebody else's — a coach's iPad, most
 * likely. A container the recorder is happy with and the listener cannot open is a failure that
 * only surfaces at playback, on a device the debater does not have.
 *
 * WebM/Opus is what Chrome, Edge and Firefox produce, and what Safari produces from 18.4. Before
 * that Safari's `MediaRecorder` did MP4/AAC only, which is why the fallback is AAC rather than
 * another flavour of Opus.
 */
const CANDIDATE_FORMATS: readonly RecordingFormat[] = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
  // Safari before 18.4. `.m4a` rather than `.mp4` because it is audio-only, and a `.mp4` that
  // will not open in a video player is a support question nobody needs.
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
  { mimeType: 'audio/mp4', extension: 'm4a' },
]

/**
 * Picks the container to record into.
 *
 * @param isSupported - `MediaRecorder.isTypeSupported`, passed in so a test can pretend to be
 *   Safari. A browser with no `MediaRecorder` at all should not be calling this.
 * @returns The first candidate the browser accepts, or an empty `mimeType` when it accepts none —
 *   which is not a failure. `MediaRecorder` with no `mimeType` picks its own container, and a
 *   recording in an unnamed format beats no recording. The extension is `webm` in that case
 *   because every browser that has ever shipped `MediaRecorder` and refused all four of these
 *   does not exist; it is a label, and the bytes are what the player sniffs.
 */
export function pickRecordingFormat(isSupported: (mimeType: string) => boolean): RecordingFormat {
  for (const candidate of CANDIDATE_FORMATS) {
    if (isSupported(candidate.mimeType)) {
      return candidate
    }
  }
  return { mimeType: '', extension: 'webm' }
}

/**
 * Whether this browser can record at all.
 *
 * @returns False in Firefox before `MediaRecorder`, in an insecure context, and anywhere without
 *   `getUserMedia`. The Speak screen still opens — the teleprompter needs a recogniser, not a
 *   recorder — it just says there will be nothing to play back.
 */
export function canRecordAudio(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices?.getUserMedia !== undefined
  )
}

/** What a finished browser recording produced. */
export interface RecordedAudio {
  readonly blob: Blob
  readonly mimeType: string
  readonly extension: string
  readonly durationSeconds: number
}

/**
 * The microphone, recorded to a compressed container.
 *
 * One instance is one speech; it does not restart after `stop`.
 *
 * **This opens its own `getUserMedia` stream rather than sharing one with the recogniser.** The
 * Web Speech API opens the microphone internally and cannot be handed a `MediaStream`, so there
 * is no stream to share even if it were preferable — two consumers is the only arrangement
 * available, not a choice.
 */
export class MicrophoneRecorder {
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private readonly chunks: Blob[] = []
  private format: RecordingFormat = { mimeType: '', extension: 'webm' }

  /**
   * Wall clock, not the recorder's — `MediaRecorder` reports no duration of its own.
   *
   * It over-reports slightly, because the clock starts before the first sample does. Measured
   * against a synthetic stream: 1.56 s of wall clock produced audio that decoded to 1.26 s. That
   * is a fixed startup cost rather than drift, so on a seven-minute speech it is under a tenth of
   * a percent — but it is not a sample count, and nothing should treat it as one.
   */
  private startedAt = 0

  /**
   * Opens the microphone and starts recording.
   *
   * @throws If the microphone is refused or absent. The caller is expected to carry on with the
   *   transcript alone rather than abandoning the speech.
   */
  async start(): Promise<void> {
    this.format = pickRecordingFormat((mimeType) => MediaRecorder.isTypeSupported(mimeType))
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })

    this.recorder = new MediaRecorder(
      this.stream,
      this.format.mimeType === '' ? undefined : { mimeType: this.format.mimeType },
    )
    this.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data)
      }
    })
    // A timeslice rather than one blob at the end: without it a tab that is discarded mid-speech
    // loses everything, and with it the chunks already collected are still a playable file.
    this.recorder.start(1000)
    this.startedAt = Date.now()
  }

  /**
   * Stops recording and releases the microphone.
   *
   * @returns The recording, or null when `start` never succeeded or nothing was captured.
   */
  async stop(): Promise<RecordedAudio | null> {
    const recorder = this.recorder
    if (!recorder) {
      return null
    }
    this.recorder = null

    // `stop()` fires one last `dataavailable` before `stop`, so the blob is only complete once
    // that event has been through — awaiting the element's own event is the only way to know.
    await new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => {
        resolve()
      })
      recorder.stop()
    })

    for (const track of this.stream?.getTracks() ?? []) {
      track.stop()
    }
    this.stream = null

    if (this.chunks.length === 0) {
      return null
    }
    // The recorder's own `mimeType` rather than the requested one: with no `mimeType` passed, the
    // browser chose, and only it knows what it chose.
    const mimeType = recorder.mimeType === '' ? this.format.mimeType : recorder.mimeType
    return {
      blob: new Blob(this.chunks, mimeType === '' ? undefined : { type: mimeType }),
      mimeType,
      extension: this.format.extension,
      durationSeconds: Math.max(0, (Date.now() - this.startedAt) / 1000),
    }
  }
}
