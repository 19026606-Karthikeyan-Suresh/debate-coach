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
import { recordings } from '@platform'

import { setSessionRecordingObject } from '../db/index.ts'
import { recordingObjectKey } from './rows.ts'
import {
  deleteRemoteRecording,
  downloadRecording,
  ensureSignedIn,
  uploadRecording,
} from './supabase.ts'

export type { RecordingEncoding } from '../platform/types.ts'

/** Encoding, reading and deleting a local recording, from whichever shell is underneath. */
export const { prepareRecording, readRecordingBytes, deleteLocalRecording } = recordings

/**
 * Shares a speech with the squad.
 *
 * @param client - The Supabase client.
 * @param sessionId - The session. Names the object, so one speech is one file however many times
 *   it is shared.
 * @param teamId - The team to share with. There is no upload without one — the storage policies
 *   read the team out of the object's path, so a recording with no team in front of it is
 *   readable by nobody and deletable by nobody.
 * @param handle - The recording, as the session row addresses it: a WAV path on the desktop, a
 *   key into this tab's registry in a browser. Not parsed on either side.
 * @returns The object key, already written to the session row.
 * @throws If the encode fails, or the upload is refused — which is what a team this identity is
 *   not in comes back as. In a browser it also throws when the handle no longer resolves, which
 *   is what a reload since the speech looks like.
 */
export async function shareRecording(
  client: SupabaseClient,
  sessionId: string,
  teamId: string,
  handle: string,
): Promise<string> {
  await ensureSignedIn(client)
  const encoded = await prepareRecording(handle)
  const read = await readRecordingBytes(encoded.opusPath)
  const bytes = read.bytes
  // The extension comes from what was actually produced, not from a constant: the desktop always
  // writes Opus, a browser writes WebM or — on Safari before 18.4 — MP4.
  const objectKey = recordingObjectKey(teamId, sessionId, encoded.extension)

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
