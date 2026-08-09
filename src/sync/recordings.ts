/**
 * The recording's round trip: encode, share, fetch, and take back down.
 *
 * **Audio is the one thing the queue does not carry.** Every other row goes up on a drain, because
 * a row is a few hundred bytes and a case you edited is a case you meant to back up. A recording
 * is seven minutes of somebody's voice, and phase 9's rule — nothing that identifies a person
 * leaves unasked — applies to it more than to anything else in the app. So sharing is a button,
 * and unsharing is the same button.
 *
 * **The Opus copy is made on the way to playback, not on the way to upload.** `prepareRecording`
 * is called by the player too, so the encoder runs whenever anybody scrubs a speech rather than
 * only on the day somebody shares one. That also means Share has nothing to wait for on a
 * recording that has already been listened to.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { invoke } from '@tauri-apps/api/core'

import { setSessionRecordingObject } from '../db/index.ts'
import { recordingObjectKey } from './rows.ts'
import {
  deleteRemoteRecording,
  downloadRecording,
  ensureSignedIn,
  uploadRecording,
} from './supabase.ts'

/** What an encode produced, as `encode_recording_opus` reports it. */
export interface RecordingEncoding {
  readonly opusPath: string
  readonly opusBytes: number
  readonly wavBytes: number
  readonly durationSeconds: number
}

/**
 * Encodes a speech's WAV to Opus, or reports the copy already beside it.
 *
 * @param wavPath - The local recording, from the session row.
 * @returns The encoding, including both sizes — "a tenth the size" is the argument for encoding
 *   at all, and the panel shows the two numbers rather than repeating the claim.
 * @throws If the WAV is missing or is not 16 kHz mono. Both mean the recording cannot be played,
 *   which is a different thing to say than "the upload failed".
 */
export function prepareRecording(wavPath: string): Promise<RecordingEncoding> {
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
export async function readRecordingBytes(path: string): Promise<Uint8Array> {
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
export function deleteLocalRecording(wavPath: string): Promise<void> {
  return invoke('delete_recording', { wavPath })
}

/**
 * Shares a speech with the squad.
 *
 * @param client - The Supabase client.
 * @param sessionId - The session. Names the object, so one speech is one file however many times
 *   it is shared.
 * @param teamId - The team to share with. There is no upload without one — the storage policies
 *   read the team out of the object's path, so a recording with no team in front of it is
 *   readable by nobody and deletable by nobody.
 * @param wavPath - The local recording to encode and send.
 * @returns The object key, already written to the session row.
 * @throws If the encode fails, or the upload is refused — which is what a team this identity is
 *   not in comes back as.
 */
export async function shareRecording(
  client: SupabaseClient,
  sessionId: string,
  teamId: string,
  wavPath: string,
): Promise<string> {
  await ensureSignedIn(client)
  const encoded = await prepareRecording(wavPath)
  const bytes = await readRecordingBytes(encoded.opusPath)
  const objectKey = recordingObjectKey(teamId, sessionId)

  await uploadRecording(client, objectKey, bytes)
  // Written only after the upload lands. A session row claiming a recording that is not in the
  // bucket sends every teammate to a download that fails.
  await setSessionRecordingObject(sessionId, objectKey)
  return objectKey
}

/**
 * Takes a shared recording back down.
 *
 * The row is cleared even when the object is already gone, because the two failures a stale
 * `recording_object_path` causes are worse than an orphaned object: a teammate clicking a
 * recording that is not there, and `delete_team` refusing to run for a file nobody can see.
 *
 * @param client - The Supabase client.
 * @param sessionId - The session.
 * @param objectKey - The key from the session row.
 * @throws If the delete fails for a reason other than the object being absent.
 */
export async function unshareRecording(
  client: SupabaseClient,
  sessionId: string,
  objectKey: string,
): Promise<void> {
  await deleteRemoteRecording(client, objectKey)
  await setSessionRecordingObject(sessionId, null)
}

/**
 * Fetches a teammate's recording for playback.
 *
 * @param client - The Supabase client.
 * @param objectKey - From the team session listing.
 * @returns The `.opus` bytes.
 * @throws If it is missing or not shared with this identity — deliberately the same message,
 *   because the storage policy answers both with "Object not found" and confirming which would
 *   tell an outsider the file exists.
 */
export function fetchSharedRecording(
  client: SupabaseClient,
  objectKey: string,
): Promise<Uint8Array> {
  return downloadRecording(client, objectKey)
}
