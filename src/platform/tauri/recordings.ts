/**
 * A speech's audio on this machine: encoded, read, and taken away.
 *
 * **The Opus copy is made on the way to playback, not on the way to upload.** `prepareRecording`
 * is called by the player too, so the encoder runs whenever anybody scrubs a speech rather than
 * only on the day somebody shares one. That also means Share has nothing to wait for on a
 * recording that has already been listened to.
 */

import { invoke } from '@tauri-apps/api/core'

import type { RecordingEncoding, RecordingPlatform } from '../types.ts'

/**
 * Encodes a speech's WAV to Opus, or reports the copy already beside it.
 *
 * @param wavPath - The local recording, from the session row.
 * @returns The encoding, including both sizes — "a tenth the size" is the argument for encoding
 *   at all, and the panel shows the two numbers rather than repeating the claim.
 * @throws If the WAV is missing or is not 16 kHz mono. Both mean the recording cannot be played,
 *   which is a different thing to say than "the upload failed".
 */
function prepareRecording(wavPath: string): Promise<RecordingEncoding> {
  return invoke<RecordingEncoding>('encode_recording_opus', { wavPath })
}

/**
 * Reads a local recording's bytes.
 *
 * @param path - A `.opus` or `.wav`. Anything else is refused by the command; see `opus.rs`.
 * @returns The file. Comes back as an `ArrayBuffer` because the command returns a raw IPC
 *   response — a `Vec<u8>` would arrive as a JSON array of a million numbers.
 * @throws If the file cannot be read.
 */
async function readRecordingBytes(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>('read_recording_bytes', { path })
  return new Uint8Array(buffer)
}

/**
 * Deletes a speech's audio from this machine.
 *
 * Takes the `.opus` as well as the WAV: leaving the encoded copy behind would mean "deleted"
 * freed a tenth of what it appeared to.
 *
 * @param wavPath - The local recording. One that is already gone is not an error.
 * @throws If a file exists and cannot be removed.
 */
function deleteLocalRecording(wavPath: string): Promise<void> {
  return invoke('delete_recording', { wavPath })
}

/** A WAV on disk, encoded to Ogg Opus by `opus.rs`. */
export const recordings: RecordingPlatform = {
  prepareRecording,
  readRecordingBytes,
  deleteLocalRecording,
}
