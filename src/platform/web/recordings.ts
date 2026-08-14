/**
 * A speech's audio in a browser, held in memory for as long as the tab is on that speech.
 *
 * The desktop keeps a WAV on disk and addresses it by path, so a recording survives a quit and can
 * be shared from the history screen weeks later. A browser has nowhere comparable to put seven
 * minutes of audio — so this keeps the blob in a module-level registry and the session row's
 * "handle" is a key into it rather than a path.
 *
 * **The consequence is a real limitation and the UI has to say it: an unshared recording does not
 * survive leaving the screen.** Sharing uploads it to the bucket, and from then on it comes back
 * down the same remote path a teammate's does. Not sharing means the transcript and the report
 * survive — they are in Postgres — and the audio does not.
 *
 * That is also why nothing here encodes. `MediaRecorder` already produced a compressed container;
 * re-encoding it would be work with no output, which is what `encodesOnDemand` says.
 */

import type { RecordedAudio } from '../../speech/recorder.ts'
import type { RecordedBytes, RecordingEncoding, RecordingPlatform } from '../types.ts'

/**
 * Recordings this tab has made, by handle.
 *
 * Module-level rather than React state on purpose: `shareRecording` and the player reach it from
 * different components, and threading a blob through both would put seven megabytes in a prop.
 * One entry per speech; a new speech replaces the one before it, because two are never wanted at
 * once and holding every recording of a session would grow without limit.
 */
const held = new Map<string, RecordedAudio>()

/**
 * Files a finished recording under a handle.
 *
 * @param handle - The session id. Whatever is passed here is what the rest of the app will use to
 *   ask for these bytes back, so it must be the same string that reaches the session row.
 * @param audio - From `MicrophoneRecorder.stop`.
 */
export function registerRecording(handle: string, audio: RecordedAudio): void {
  held.clear()
  held.set(handle, audio)
}

/**
 * Whether a handle still resolves to audio in this tab.
 *
 * @param handle - The session id.
 * @returns False after a reload, and false for a speech recorded in another tab. Callers use it
 *   to decide whether to offer Share at all rather than to offer it and fail.
 */
export function hasRecording(handle: string): boolean {
  return held.has(handle)
}

/** Raised identically by all three, so the panel says the same thing however it got here. */
function missing(): Error {
  return new Error(
    'That recording is no longer in this tab. Audio is kept only until the page reloads, unless it was shared.',
  )
}

/**
 * Reports what the recorder produced.
 *
 * There is no encode step in a browser, so both sizes are the same number — which is what
 * `encodesOnDemand: false` tells the player, so it does not present that as a saving.
 *
 * @param handle - The session id.
 * @returns The recording's size, format and duration.
 * @throws If the handle no longer resolves.
 */
async function prepareRecording(handle: string): Promise<RecordingEncoding> {
  await Promise.resolve()
  const audio = held.get(handle)
  if (!audio) {
    throw missing()
  }
  return {
    opusPath: handle,
    opusBytes: audio.blob.size,
    wavBytes: audio.blob.size,
    durationSeconds: audio.durationSeconds,
    extension: audio.extension,
  }
}

/**
 * Reads a recording's bytes.
 *
 * @param handle - The session id.
 * @returns The bytes and the container they are in. The type comes from the recorder rather than
 *   from the extension — the player hands it straight to a `Blob`, and a mislabelled blob is a
 *   file Safari refuses for a reason it does not explain.
 * @throws If the handle no longer resolves.
 */
async function readRecordingBytes(handle: string): Promise<RecordedBytes> {
  const audio = held.get(handle)
  if (!audio) {
    throw missing()
  }
  return {
    bytes: new Uint8Array(await audio.blob.arrayBuffer()),
    mimeType: audio.mimeType,
  }
}

/**
 * Forgets a recording.
 *
 * @param handle - The session id. One that is already gone is not an error — that is the state
 *   the caller wanted.
 */
async function deleteLocalRecording(handle: string): Promise<void> {
  await Promise.resolve()
  held.delete(handle)
}

/** In-memory, for this tab, until it is shared. */
export const recordings: RecordingPlatform = {
  encodesOnDemand: false,
  prepareRecording,
  readRecordingBytes,
  deleteLocalRecording,
}
