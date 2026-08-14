/**
 * A speech's audio in a browser — not yet, and two facts that make it more than a one-liner.
 *
 * The desktop path is: capture to a WAV, encode it to Ogg Opus in Rust, upload the encoded copy.
 * A browser does the first two at once — `MediaRecorder` on the capture stream emits a compressed
 * container directly, so `opus.rs` and the hand-written Ogg muxer have no counterpart here.
 *
 * Two things it is not safe to assume while writing that:
 *
 *   * **WebM/Opus is not universal.** Safari's `MediaRecorder` produced MP4/AAC only until 18.4.
 *     So the container has to be negotiated with `isTypeSupported` and the *actual* type recorded
 *     alongside the bytes — `recordingObjectKey` currently hardcodes `.opus`, and a bucket full of
 *     files whose extension disagrees with their contents is a problem that surfaces at playback,
 *     on somebody else's machine.
 *   * **The local path and the bucket key are two separate columns** and must stay that way. On
 *     the desktop the first is `C:\Users\<name>\…`, which is a path on one machine and a person's
 *     name on the wire. A browser has no local path at all, which makes conflating them tempting
 *     and no less wrong.
 */

import type { RecordingEncoding, RecordingPlatform } from '../types.ts'

/** Why nothing here works yet, in the words the player shows. */
const NO_AUDIO = 'The web app does not keep a recording of a speech yet.'

/**
 * Encodes a recording for upload and playback.
 *
 * @param wavPath - Ignored; there is no local WAV in a browser.
 * @returns Never, for now.
 */
function prepareRecording(wavPath: string): Promise<RecordingEncoding> {
  void wavPath
  return Promise.reject(new Error(NO_AUDIO))
}

/**
 * Reads a local recording's bytes.
 *
 * @param path - Ignored.
 * @returns Never, for now.
 */
function readRecordingBytes(path: string): Promise<Uint8Array> {
  void path
  return Promise.reject(new Error(NO_AUDIO))
}

/**
 * Deletes a speech's audio from this machine.
 *
 * @param wavPath - Ignored.
 * @returns Resolves. Deleting audio that was never kept is the state the caller wanted, so this
 *   one succeeds rather than rejecting — a "delete the recording" button that errors on a shell
 *   with no recordings is a worse lie than one that quietly agrees.
 */
async function deleteLocalRecording(wavPath: string): Promise<void> {
  void wavPath
  await Promise.resolve()
}

/** Nothing kept yet. */
export const recordings: RecordingPlatform = {
  prepareRecording,
  readRecordingBytes,
  deleteLocalRecording,
}
