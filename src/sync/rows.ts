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
 * - **`recording_path` is never pushed.** Locally it is `C:\Users\<name>\AppData\...\speech.wav`,
 *   which is a path on one machine and a person's name on the wire. The column in Postgres holds
 *   a storage object key, which phase 10 writes when it uploads the Opus copy.
 * - **`report` has no column to go to.** Phase 6 split a speech in two by what may leave the
 *   machine; the transcript stays.
 *
 * Every function here is pure, which is what lets the shapes be pinned without a project.
 */

import type { FormatId, Side } from '../formats/index.ts'
import type { SessionSummary } from '../db/index.ts'
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
    // Phase 10's job, when there is an Opus copy in the bucket for it to name.
    recording_path: null,
    created_at: session.createdAt,
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
