/**
 * The translation between a local row and a Postgres row.
 *
 * There is barely any, and that is deliberate — `src-tauri/src/db.rs` names its columns after
 * the Postgres schema so sync stays a copy. What is left is the handful of places the two
 * genuinely differ, and every one of them is a decision rather than a type conversion:
 *
 * - **The local database has no identity.** One install, one debater, so `owner_id`, `user_id`
 *   and `team_id` are not stored locally at all; they are stamped on at push time from whoever
 *   is signed in and whichever team is active.
 * - **The local `recording_path` is never pushed.** It is `C:\Users\<name>\AppData\...\speech.wav`,
 *   which is a path on one machine and a person's name on the wire. The column in Postgres holds
 *   a storage object key instead, and phase 10 keeps that key in its own local column so there is
 *   nothing here that could send the wrong one.
 * - **`report` has no column to go to.** Phase 6 split a speech in two by what may leave the
 *   machine; the transcript stays.
 *
 * Every function here is pure, which is what lets the shapes be pinned without a project.
 */

import type { FormatId, Side } from '../formats/index.ts'
import type { SessionSummary } from '../db/index.ts'
import type { SpeechComment } from '../speech/comments.ts'
import type { Case, Visibility } from '../types/case.ts'
import { hydrateCase } from '../types/createCase.ts'

/** A `public.cases` row, exactly as PostgREST accepts it. */
export interface RemoteCaseRow {
  readonly id: string
  readonly team_id: string | null
  readonly owner_id: string
  readonly motion: string
  readonly format: FormatId
  readonly side: Side
  readonly position: string
  readonly doc: Case
  readonly visibility: Visibility
  readonly created_at: string
  readonly updated_at: string
}

/**
 * Prepares a case for upload.
 *
 * **Every case is pushed, whatever its visibility.** Supabase is a replication target, so a
 * private case is still backed up — `visibility` decides who else may read it, and the policy
 * that enforces that is `cases_select`. It is also what keeps a session's `case_id` foreign key
 * resolvable: a session whose case had been withheld could not be pushed at all.
 *
 * @param caseFile - The local case. Its `id` is the primary key on both sides.
 * @param ownerId - The signed-in `auth.uid()`. Passing anyone else's produces a row the insert
 *   policy rejects rather than a row belonging to them.
 * @param teamId - The active team, or null when this install has not joined one. Null forces
 *   `visibility` to private: a case shared with a team you are not in is shared with nobody, and
 *   storing the optimistic value would be a claim the row cannot support.
 * @returns The row to upsert.
 */
export function caseToRemoteRow(
  caseFile: Case,
  ownerId: string,
  teamId: string | null,
): RemoteCaseRow {
  return {
    id: caseFile.id,
    team_id: teamId,
    owner_id: ownerId,
    motion: caseFile.prep.motion,
    format: caseFile.format,
    side: caseFile.side,
    position: caseFile.position,
    doc: caseFile,
    visibility: teamId === null ? 'private' : caseFile.visibility,
    created_at: caseFile.createdAt,
    updated_at: caseFile.updatedAt,
  }
}

/**
 * Turns a downloaded row back into a case.
 *
 * @param row - A row from `public.cases`. Goes through `hydrateCase`, so a document written by
 *   an older build of the app opens with the missing blocks empty rather than undefined.
 * @returns The case as the editor expects it.
 */
export function remoteRowToCase(row: RemoteCaseRow): Case {
  return hydrateCase(row.doc)
}

/** A `public.sessions` row. */
export interface RemoteSessionRow {
  readonly id: string
  readonly team_id: string | null
  readonly user_id: string
  readonly case_id: string | null
  readonly format: FormatId
  readonly role: string
  readonly duration_s: number
  readonly metrics: unknown
  readonly recording_path: string | null
  readonly created_at: string
}

/**
 * Prepares a delivered speech for upload — the numbers, not the transcript.
 *
 * @param session - The local summary.
 * @param userId - The signed-in `auth.uid()`.
 * @param teamId - The active team, or null. A session with no team is visible only to its owner,
 *   which is what `sessions_select` says.
 * @param hasSyncedCase - Whether the case this speech was given from exists remotely. False
 *   sends a null `case_id`: the foreign key would otherwise reject the whole row, and losing a
 *   session's metrics because its case was deleted is worse than losing the link between them.
 * @returns The row to upsert.
 */
export function sessionToRemoteRow(
  session: SessionSummary,
  userId: string,
  teamId: string | null,
  hasSyncedCase: boolean,
): RemoteSessionRow {
  return {
    id: session.id,
    team_id: teamId,
    user_id: userId,
    case_id: hasSyncedCase ? session.caseId : null,
    format: session.format,
    role: session.role,
    duration_s: session.durationSeconds,
    metrics: session.metrics,
    // The bucket key, never the local WAV path. Null until the debater shares the speech.
    recording_path: session.recordingObjectPath,
    created_at: session.createdAt,
  }
}

/**
 * The key a session's recording lives under in the `recordings` bucket.
 *
 * **The team id is the first path segment because the storage policy has nothing else to read.**
 * `storage.objects` carries a bucket, a name and an owner, so "does this recording belong to a
 * team you are in" is answered out of the path — which makes the path a security boundary rather
 * than a filing convention, and makes this function the one place its shape is decided.
 *
 * @param teamId - The team the speech is being shared with. There is no key without one: a
 *   recording uploaded outside a team is readable by nobody and deletable by nobody, so the
 *   caller is expected to refuse before it gets here.
 * @param sessionId - The session. One recording per speech, so the id is the whole filename.
 * @returns The object key.
 */
export function recordingObjectKey(teamId: string, sessionId: string): string {
  return `${teamId}/${sessionId}.opus`
}

/** A `public.comments` row. */
export interface RemoteCommentRow {
  readonly id: string
  readonly session_id: string
  readonly author_id: string
  readonly t_seconds: number
  readonly body: string
  readonly created_at: string
}

/**
 * Prepares a coach comment for upload.
 *
 * @param comment - The local note.
 * @param userId - The signed-in `auth.uid()`. Used rather than the comment's stored `authorId`,
 *   which is null for anything written before this install first signed in — and a row whose
 *   `author_id` is not the caller is rejected by `comments_insert` rather than filed under
 *   somebody else.
 * @returns The row to upsert.
 */
export function commentToRemoteRow(comment: SpeechComment, userId: string): RemoteCommentRow {
  return {
    id: comment.id,
    session_id: comment.sessionId,
    author_id: comment.authorId ?? userId,
    t_seconds: comment.atSeconds,
    body: comment.body,
    created_at: comment.createdAt,
  }
}

/**
 * Turns a downloaded comment back into a local one.
 *
 * @param row - A row from `public.comments`.
 * @param authorName - The author's display name from the team roster, or '' when they are not on
 *   it — a coach who has left the squad still wrote the note, and dropping their comment to avoid
 *   an empty name would lose the advice.
 * @returns The comment, marked remote so a pull does not queue it straight back up.
 */
export function remoteRowToComment(row: RemoteCommentRow, authorName: string): SpeechComment {
  return {
    id: row.id,
    sessionId: row.session_id,
    authorId: row.author_id,
    authorName,
    atSeconds: row.t_seconds,
    body: row.body,
    createdAt: row.created_at,
    isRemote: true,
  }
}

/** A teammate's speech, as the Review screen lists it. */
export interface TeamSessionSummary {
  readonly id: string
  readonly userId: string
  /** Their display name, or '' when they never set one. */
  readonly ownerName: string
  /** The motion, when the case was shared too. Empty otherwise — a session is not a case. */
  readonly motion: string
  readonly format: FormatId
  readonly role: string
  readonly durationSeconds: number
  /** Key in the `recordings` bucket. Only sessions that have one are listed. */
  readonly recordingPath: string
  readonly createdAt: string
}

/** A row of the team session query, before the owner's name is attached. */
export interface RemoteTeamSessionRow {
  readonly id: string
  readonly user_id: string
  readonly format: FormatId
  readonly role: string
  readonly duration_s: number
  readonly recording_path: string
  readonly created_at: string
  readonly cases: { motion: string } | { motion: string }[] | null
}

/**
 * Flattens a team session row and names its speaker.
 *
 * @param row - One row from the team session query.
 * @param ownerName - Their display name from the roster, or ''.
 * @returns The summary. The embedded case is read through the same array-tolerant branch
 *   `myTeams` uses: PostgREST returns a to-one embed as an object or as a single-element array
 *   depending on when its schema cache was last reloaded, not on the schema.
 */
export function remoteRowToTeamSession(
  row: RemoteTeamSessionRow,
  ownerName: string,
): TeamSessionSummary {
  const embedded = Array.isArray(row.cases) ? row.cases[0] : row.cases
  return {
    id: row.id,
    userId: row.user_id,
    ownerName,
    motion: embedded?.motion ?? '',
    format: row.format,
    role: row.role,
    durationSeconds: row.duration_s,
    recordingPath: row.recording_path,
    createdAt: row.created_at,
  }
}

/** One entry in the team library — enough to list and search, not the document itself. */
export interface TeamCaseSummary {
  readonly id: string
  readonly teamId: string
  readonly ownerId: string
  /** The teammate's display name, or '' when they never set one. */
  readonly ownerName: string
  readonly motion: string
  readonly format: FormatId
  readonly side: Side
  readonly position: string
  readonly updatedAt: string
}

/** A row of the library listing, before the owner's name is attached. */
export interface RemoteLibraryRow {
  readonly id: string
  readonly team_id: string
  readonly owner_id: string
  readonly motion: string
  readonly format: FormatId
  readonly side: Side
  readonly position: string
  readonly updated_at: string
}

/**
 * Flattens a library row and names its owner.
 *
 * The name is passed in rather than embedded by PostgREST, and it has to be: `cases.owner_id`
 * and `team_members.user_id` both point at `auth.users`, which is not a relationship PostgREST
 * can traverse — there is no foreign key between the two tables for its schema cache to find.
 * The membership list is one extra query and is joined here.
 *
 * @param row - One row from the library query.
 * @param ownerName - The teammate's display name. Empty when they never set one, or when the
 *   membership row is missing — a case with no name beside it is still a case worth listing.
 * @returns The summary.
 */
export function remoteRowToTeamCase(row: RemoteLibraryRow, ownerName: string): TeamCaseSummary {
  return {
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    ownerName,
    motion: row.motion,
    format: row.format,
    side: row.side,
    position: row.position,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// The Yjs snapshot — `cases.ydoc_state`
// ---------------------------------------------------------------------------

/**
 * Encodes a Yjs update for the `bytea` column.
 *
 * PostgREST takes and returns `bytea` as Postgres' hex format — a `\x` marker then two lowercase
 * hex digits per byte — rather than as base64, which is what everything else on the wire uses.
 * Getting this wrong does not fail: it stores the *text* of the base64 and reads back a snapshot
 * Yjs rejects, hours later, on somebody else's machine.
 *
 * @param bytes - From `Y.encodeStateAsUpdate`.
 * @returns The literal to send.
 */
export function bytesToPgHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return `\\x${hex}`
}

/**
 * Decodes what {@link bytesToPgHex} wrote.
 *
 * @param literal - As PostgREST returns it. Null, empty, and anything not in hex format all come
 *   back as null: a snapshot that will not parse means the late joiner waits for a peer, which is
 *   the same state as no snapshot at all and is recoverable.
 * @returns The bytes, or null.
 */
export function pgHexToBytes(literal: string | null): Uint8Array | null {
  if (literal === null || !literal.startsWith('\\x') || literal.length % 2 !== 0) {
    return null
  }
  const digits = literal.slice(2)
  if (digits.length === 0 || !/^[0-9a-fA-F]*$/.test(digits)) {
    return null
  }
  const bytes = new Uint8Array(digits.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
