/**
 * A speech's audio on this machine: encoded, read, and taken away.
 *
 * **The Opus copy is made on the way to playback, not on the way to upload.** `prepareRecording`
 * is called by the player too, so the encoder runs whenever anybody scrubs a speech rather than
 * only on the day somebody shares one. That also means Share has nothing to wait for on a
 * recording that has already been listened to.
 */

import { invoke } from '@tauri-apps/api/core'

import type { RecordedBytes, RecordingEncoding, RecordingPlatform } from '../types.ts'

/**
 * Encodes a speech's WAV to Opus, or reports the copy already beside it.
 *
 * @param handle - The local WAV path, from the session row.
 * @returns The encoding, including both sizes — "a tenth the size" is the argument for encoding
 *   at all, and the panel shows the two numbers rather than repeating the claim. The extension is
 *   a constant here because `opus.rs` writes exactly one container.
 * @throws If the WAV is missing or is not 16 kHz mono. Both mean the recording cannot be played,
 *   which is a different thing to say than "the upload failed".
 */
async function prepareRecording(handle: string): Promise<RecordingEncoding> {
  const encoded = await invoke<Omit<RecordingEncoding, 'extension'>>('encode_recording_opus', {
    wavPath: handle,
  })
  return { ...encoded, extension: 'opus' }
}

/**
 * Reads a local recording's bytes.
 *
 * @param handle - A `.opus` or `.wav` path. Anything else is refused by the command; see
 *   `opus.rs`.
 * @returns The file and its container. Comes back as an `ArrayBuffer` because the command returns
 *   a raw IPC response — a `Vec<u8>` would arrive as a JSON array of a million numbers. The type
 *   is derived from the extension, which is sound here precisely because the command only accepts
 *   those two.
 * @throws If the file cannot be read.
 */
async function readRecordingBytes(handle: string): Promise<RecordedBytes> {
  const buffer = await invoke<ArrayBuffer>('read_recording_bytes', { path: handle })
  return {
    bytes: new Uint8Array(buffer),
    mimeType: handle.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/ogg',
  }
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
  // The encode is real here and saves about nine tenths, which is what the player reports.
  encodesOnDemand: true,
  prepareRecording,
  readRecordingBytes,
  deleteLocalRecording,
}
