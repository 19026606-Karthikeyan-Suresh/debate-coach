/**
 * Storage for the browser shell: Postgres is the source of truth, reached over PostgREST.
 *
 * The desktop is local-first — SQLite is the truth and Supabase is a replication target it pushes
 * to on a queue. There is no local database here, so that inverts: a write goes straight up, and
 * **the queue methods below are inert rather than absent**. `sync/engine.ts` drains whatever
 * `queuedChanges` returns, so an empty queue makes the drain a no-op with no branch in the engine
 * and no second code path to keep working.
 *
 * Three things follow from Postgres being the truth, and all three are visible in this file:
 *
 *   * **Sign-in has to happen before any write.** `cases.owner_id` is `not null references
 *     auth.users`, so there is no such thing as an unattributed case here. Every method that
 *     writes goes through `session()`, which signs in anonymously if it has to.
 *   * **A session cannot be saved before its case.** `sessions.case_id` is a foreign key, and an
 *     unsaved case comes back as `23503` rather than as a missing link, so the reference is
 *     dropped instead of the row.
 *   * **Settings are not in Postgres.** Which team is active, the prep length for a format, which
 *     room a case is linked to — these are facts about *this browser*, not about the account, and
 *     a second device should not inherit them. `localStorage`, same as the session.
 */

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'

import type { SpeechComment } from '../../speech/comments.ts'
import type { SessionMetrics } from '../../speech/metrics.ts'
import type { SpeechReport } from '../../speech/report.ts'
import { ensureSignedIn, fail } from '../../sync/identity.ts'
import { ROOM_LINK_PREFIX, SETTING_KEYS } from '../../sync/keys.ts'
import {
  caseToRemoteRow,
  remoteRowToCase,
  type RemoteCaseRow,
  type TeamCaseSummary,
} from '../../sync/rows.ts'
import type { Case } from '../../types/case.ts'
import { hydrateCase } from '../../types/createCase.ts'
import type {
  CaseSummary,
  DatabasePlatform,
  QueueEntry,
  SessionSummary,
} from '../types.ts'
import { auth } from './auth.ts'

/** Who is asking, and on whose behalf. Resolved once per call rather than cached. */
interface Session {
  readonly client: SupabaseClient
  readonly userId: string
  /** The active team, or null. Stamped on new rows so teammates can see them. */
  readonly teamId: string | null
}

/**
 * The client, the signed-in id, and the active team.
 *
 * @returns Everything a write needs.
 * @throws If the build has no project, or the project refuses anonymous sign-in. Both are
 *   configuration rather than code, and both messages say which.
 */
async function session(): Promise<Session> {
  const client = auth.getClient()
  if (!client) {
    fail(
      'no storage configured',
      'this build has no Supabase project, so there is nowhere to keep a case',
    )
  }
  const userId = await ensureSignedIn(client)
  return { client, userId, teamId: readLocal(SETTING_KEYS.activeTeamId) }
}

/** Raises a PostgREST error as something worth showing, or returns. */
function check(action: string, error: PostgrestError | null): void {
  if (error) {
    fail(action, error.message)
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/**
 * Inserts or updates a case.
 *
 * @param caseFile - The case to persist. `updatedAt` is written from the document rather than the
 *   clock, so a case restored from a `.dbcase` keeps its real modification time.
 */
async function saveCase(caseFile: Case): Promise<void> {
  const { client, userId, teamId } = await session()
  const { error } = await client.from('cases').upsert(caseToRemoteRow(caseFile, userId, teamId))
  check('could not save the case', error)
}

/**
 * Loads one case.
 *
 * @param caseId - Primary key. An unknown id returns null rather than throwing — and so does a
 *   case belonging to somebody else, because `cases_select` answers a forbidden read with no rows
 *   rather than an error.
 * @returns The parsed case, or null.
 */
async function loadCase(caseId: string): Promise<Case | null> {
  const { client } = await session()
  const { data, error } = await client.from('cases').select('doc').eq('id', caseId).maybeSingle()
  check('could not open the case', error)
  const doc = (data as { doc: unknown } | null)?.doc
  return doc === undefined || doc === null ? null : hydrateCase(doc)
}

/** The columns the library list needs, without dragging every document down with it. */
const CASE_SUMMARY_COLUMNS = 'id, motion, format, side, position, visibility, updated_at'

/**
 * Lists this account's own cases, newest first.
 *
 * Filtered to `owner_id` even though `cases_select` would also return teammates' shared cases.
 * The library shows those in a separate panel, and folding them in would offer rows this account
 * cannot edit under a heading that says "my cases".
 *
 * @param limit - Maximum rows.
 * @returns Summaries only.
 */
async function listCases(limit = 100): Promise<CaseSummary[]> {
  const { client, userId } = await session()
  const { data, error } = await client
    .from('cases')
    .select(CASE_SUMMARY_COLUMNS)
    .eq('owner_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit)
  check('could not list cases', error)
  return ((data ?? []) as RemoteCaseRow[]).map((row) => ({
    id: row.id,
    motion: row.motion,
    format: row.format,
    side: row.side,
    position: row.position,
    visibility: row.visibility,
    updatedAt: row.updated_at,
  }))
}

/**
 * Every case id this account owns.
 *
 * @returns Ids in no particular order. Used by the importer, which needs *all* of them: a
 *   `.dbcase` restored over a case that is already here would overwrite it silently.
 */
async function listCaseIds(): Promise<string[]> {
  const { client, userId } = await session()
  const { data, error } = await client.from('cases').select('id').eq('owner_id', userId)
  check('could not list cases', error)
  return ((data ?? []) as { id: string }[]).map((row) => row.id)
}

/**
 * Deletes a case.
 *
 * @param caseId - Primary key. Deleting an unknown id is a no-op, and so is deleting somebody
 *   else's — the policy simply matches no rows.
 */
async function deleteCase(caseId: string): Promise<void> {
  const { client } = await session()
  const { error } = await client.from('cases').delete().eq('id', caseId)
  check('could not delete the case', error)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A `sessions` row with the case's motion embedded, as PostgREST returns the join. */
interface SessionJoinRow {
  id: string
  case_id: string | null
  format: SessionSummary['format']
  role: string
  duration_s: number
  metrics: unknown
  recording_path: string | null
  created_at: string
  cases: { motion: string } | { motion: string }[] | null
}

/** PostgREST returns an embedded row as an object or a single-element array depending on shape. */
function embeddedMotion(embedded: SessionJoinRow['cases']): string {
  if (embedded === null) {
    return ''
  }
  return Array.isArray(embedded) ? (embedded[0]?.motion ?? '') : embedded.motion
}

/** Parses a stored metrics blob, or null when it is not the current shape. */
function parseMetrics(stored: unknown): SessionMetrics | null {
  const parsed = stored as Partial<SessionMetrics> | null
  return parsed?.version === 1 ? (parsed as SessionMetrics) : null
}

/**
 * Writes a session and its report.
 *
 * Two tables, because they have different policies: teammates read `sessions` — that is what the
 * squad history screen is — and only the speaker reads `session_reports`, which holds the
 * transcript. Migration 7 says why at length.
 *
 * Called twice for one speech by design: the live report the moment the speaker sits down, and
 * the accurate one when the re-transcription lands.
 *
 * @param report - The report to store. Its `sessionId` is the primary key on both tables.
 * @param recordingPath - Ignored here. On the desktop it is a local WAV; a browser has no such
 *   path, and the column of that name in Postgres holds the *bucket* key, which is written by
 *   {@link setSessionRecordingObject} once the speech is actually shared.
 */
async function saveSession(report: SpeechReport, recordingPath: string | null): Promise<void> {
  void recordingPath
  const { client, userId, teamId } = await session()

  // The case may never have been saved — a speech given from a case that was deleted, or one
  // still being written. The foreign key would reject the whole row, and losing a speech's
  // numbers because its case is gone is worse than losing the link between them.
  const hasCase = await caseExistsLocally(report.caseId)

  const { error } = await client.from('sessions').upsert({
    id: report.sessionId,
    team_id: teamId,
    user_id: userId,
    case_id: hasCase ? report.caseId : null,
    format: report.format,
    role: report.roleId,
    duration_s: report.metrics.durationSeconds,
    metrics: report.metrics,
    created_at: report.createdAt,
  })
  check('could not save the speech', error)

  const stored = await client
    .from('session_reports')
    .upsert({ session_id: report.sessionId, report })
  check('could not save the report', stored.error)
}

/**
 * Lists this account's speeches, newest first.
 *
 * @param limit - Maximum rows.
 * @returns Summaries. A row whose metrics are from an older shape is dropped rather than
 *   returned half-built — charting it would compare a number against one that means something
 *   else.
 */
async function listSessions(limit = 100): Promise<SessionSummary[]> {
  const { client, userId } = await session()
  const { data, error } = await client
    .from('sessions')
    .select('id, case_id, format, role, duration_s, metrics, recording_path, created_at, cases(motion)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  check('could not list speeches', error)

  return ((data ?? []) as SessionJoinRow[]).flatMap((row) => {
    const metrics = parseMetrics(row.metrics)
    return metrics
      ? [
          {
            id: row.id,
            caseId: row.case_id,
            motion: embeddedMotion(row.cases),
            format: row.format,
            role: row.role,
            durationSeconds: row.duration_s,
            metrics,
            // There is no local file in a browser, and the column of that name holds the bucket
            // key. Two separate fields on this side; one column on that side.
            recordingPath: null,
            recordingObjectPath: row.recording_path,
            createdAt: row.created_at,
          },
        ]
      : []
  })
}

/**
 * Records that a speech's audio is now in the bucket.
 *
 * @param sessionId - Primary key.
 * @param objectPath - The storage key, or null to record that it is no longer up there.
 */
async function setSessionRecordingObject(
  sessionId: string,
  objectPath: string | null,
): Promise<void> {
  const { client } = await session()
  const { error } = await client
    .from('sessions')
    .update({ recording_path: objectPath })
    .eq('id', sessionId)
  check('could not record the upload', error)
}

/**
 * Loads one stored report.
 *
 * @param sessionId - Primary key.
 * @returns The report, or null when there is none, when it belongs to somebody else, or when it
 *   is from an older shape. Rendering a report whose fields have moved is worse than saying it
 *   cannot be opened.
 */
async function loadSessionReport(sessionId: string): Promise<SpeechReport | null> {
  const { client } = await session()
  const { data, error } = await client
    .from('session_reports')
    .select('report')
    .eq('session_id', sessionId)
    .maybeSingle()
  check('could not open the report', error)
  const stored = (data as { report: Partial<SpeechReport> } | null)?.report
  return stored?.version === 1 ? (stored as SpeechReport) : null
}

/**
 * Deletes a session, and its report with it.
 *
 * @param sessionId - Primary key. The report goes too, by `on delete cascade` — there is nothing
 *   for a report to be a report *of* once the session is gone.
 */
async function deleteSession(sessionId: string): Promise<void> {
  const { client } = await session()
  const { error } = await client.from('sessions').delete().eq('id', sessionId)
  check('could not delete the speech', error)
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/** A `comments` row as PostgREST returns it. */
interface CommentJoinRow {
  id: string
  session_id: string
  author_id: string
  t_seconds: number
  body: string
  created_at: string
}

/**
 * Turns a row into a comment.
 *
 * `authorName` is empty and `isRemote` is always true: every comment in a browser came from the
 * project by definition, and the display name lives on `team_members` rather than on the comment.
 * The desktop denormalises it so a note reads offline; here there is no offline to read it in.
 */
function rowToComment(row: CommentJoinRow): SpeechComment {
  return {
    id: row.id,
    sessionId: row.session_id,
    authorId: row.author_id,
    authorName: '',
    atSeconds: row.t_seconds,
    body: row.body,
    createdAt: row.created_at,
    isRemote: true,
  }
}

const COMMENT_COLUMNS = 'id, session_id, author_id, t_seconds, body, created_at'

/**
 * Every comment on one speech.
 *
 * @param sessionId - The session.
 * @returns Comments earliest first. Empty for an unknown session and for one nobody has commented
 *   on, which are the same thing to show.
 */
async function listComments(sessionId: string): Promise<SpeechComment[]> {
  const { client } = await session()
  const { data, error } = await client
    .from('comments')
    .select(COMMENT_COLUMNS)
    .eq('session_id', sessionId)
    .order('t_seconds')
  check('could not load comments', error)
  return ((data ?? []) as CommentJoinRow[]).map(rowToComment)
}

/**
 * Loads one comment.
 *
 * @param commentId - Primary key.
 * @returns The comment, or null when it has been deleted since.
 */
async function loadComment(commentId: string): Promise<SpeechComment | null> {
  const { client } = await session()
  const { data, error } = await client
    .from('comments')
    .select(COMMENT_COLUMNS)
    .eq('id', commentId)
    .maybeSingle()
  check('could not load the comment', error)
  return data === null ? null : rowToComment(data as CommentJoinRow)
}

/**
 * Writes a comment.
 *
 * @param comment - The note. Its `id` is the primary key, so re-saving edits rather than adding.
 * @param queueForSync - False means the comment came *from* the project, which in this shell means
 *   it is already stored — writing it back would be a round trip that changes nothing.
 */
async function saveComment(comment: SpeechComment, queueForSync = true): Promise<void> {
  if (!queueForSync) {
    return
  }
  const { client, userId } = await session()
  const { error } = await client.from('comments').upsert({
    id: comment.id,
    session_id: comment.sessionId,
    author_id: userId,
    t_seconds: comment.atSeconds,
    body: comment.body,
    created_at: comment.createdAt,
  })
  check('could not save the comment', error)
}

/**
 * Deletes a comment.
 *
 * @param commentId - Primary key. Somebody else's is a no-op — the policy matches no rows.
 */
async function deleteComment(commentId: string): Promise<void> {
  const { client } = await session()
  const { error } = await client.from('comments').delete().eq('id', commentId)
  check('could not delete the comment', error)
}

/**
 * Caches a pulled comment list.
 *
 * Nothing to do: this shell reads comments from the project every time, so there is no local copy
 * that could go stale and no pending local note that a replace could destroy.
 */
async function replaceRemoteComments(): Promise<void> {
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Delivery rewrites
// ---------------------------------------------------------------------------

/**
 * Reads every rewrite stored for one case.
 *
 * @param caseId - The case whose script is being delivered.
 * @returns Segment id to replacement text. An empty *string* against a live id is a real edit
 *   meaning "do not say this segment", which is why it is kept rather than pruned.
 */
async function loadScriptEdits(caseId: string): Promise<Record<string, string>> {
  const { client } = await session()
  const { data, error } = await client
    .from('script_edits')
    .select('segment_id, text')
    .eq('case_id', caseId)
  check('could not load the script edits', error)
  return Object.fromEntries(
    ((data ?? []) as { segment_id: string; text: string }[]).map((row) => [row.segment_id, row.text]),
  )
}

/**
 * Stores one rewrite.
 *
 * @param caseId - The case being delivered.
 * @param segmentId - From `ScriptSegment.id`. Derived from case ids, so it survives a recompile.
 * @param text - The new wording. `''` is stored, not treated as a delete.
 */
async function saveScriptEdit(caseId: string, segmentId: string, text: string): Promise<void> {
  const { client } = await session()
  const { error } = await client.from('script_edits').upsert({
    case_id: caseId,
    segment_id: segmentId,
    text,
    updated_at: new Date().toISOString(),
  })
  check('could not save the rewrite', error)
}

/**
 * Drops one rewrite, restoring the compiled wording.
 *
 * @param caseId - The case being delivered.
 * @param segmentId - Segment to revert. An id with no stored edit is a no-op.
 */
async function deleteScriptEdit(caseId: string, segmentId: string): Promise<void> {
  const { client } = await session()
  const { error } = await client
    .from('script_edits')
    .delete()
    .eq('case_id', caseId)
    .eq('segment_id', segmentId)
  check('could not restore the compiled wording', error)
}

// ---------------------------------------------------------------------------
// The queue, which is not a queue here
// ---------------------------------------------------------------------------

/**
 * Marks a row as dirty.
 *
 * Inert. A write in this shell has already reached Postgres by the time this would be called, so
 * there is nothing to push later. Kept rather than removed so `sync/engine.ts` needs no branch:
 * a drain over an empty queue is a no-op on its own.
 */
async function enqueueChange(): Promise<void> {
  await Promise.resolve()
}

/**
 * Reads the queue.
 *
 * @returns Always empty. See {@link enqueueChange}.
 */
async function queuedChanges(): Promise<QueueEntry[]> {
  return await Promise.resolve([])
}

/** Removes a drained entry. Inert; there are none. */
async function clearQueued(): Promise<void> {
  await Promise.resolve()
}

/** Records a failed push. Inert; nothing is pushed. */
async function recordQueueFailure(): Promise<void> {
  await Promise.resolve()
}

/**
 * Queues everything already stored, for a first sign-in.
 *
 * @returns Always 0. On the desktop this is what uploads a season of local work the first time
 *   somebody joins a team; here the season was written to Postgres as it happened.
 */
async function backfillQueue(): Promise<number> {
  return await Promise.resolve(0)
}

/**
 * Whether a case exists and belongs to this account.
 *
 * Still meaningful in this shell, and still for the same reason: `sessions.case_id` is a foreign
 * key, and a session pointing at a case that is not there fails `23503` rather than losing a link.
 *
 * @param caseId - The case to look for, or null.
 * @returns False for null, so callers need no special case for a speech with no case.
 */
async function caseExistsLocally(caseId: string | null): Promise<boolean> {
  if (caseId === null) {
    return false
  }
  const { client, userId } = await session()
  const { data, error } = await client
    .from('cases')
    .select('id')
    .eq('id', caseId)
    .eq('owner_id', userId)
    .maybeSingle()
  check('could not check the case', error)
  return data !== null
}

// ---------------------------------------------------------------------------
// Settings — this browser's, not this account's
// ---------------------------------------------------------------------------

/** Reads a key, tolerating a browser that refuses storage entirely. */
function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Reads one setting.
 *
 * @param key - One of `SETTING_KEYS`, or a prefixed key.
 * @returns The stored value, or null when it has never been written.
 */
async function readSetting(key: string): Promise<string | null> {
  return await Promise.resolve(readLocal(key))
}

/**
 * Writes one setting.
 *
 * @param key - One of `SETTING_KEYS`, or a prefixed key.
 * @param value - The value, or null to remove it. Null rather than `''` for "no active team",
 *   because an empty string is a value someone could mistake for a team id.
 */
async function writeSetting(key: string, value: string | null): Promise<void> {
  await Promise.resolve()
  try {
    if (value === null) {
      window.localStorage.removeItem(key)
    } else {
      window.localStorage.setItem(key, value)
    }
  } catch {
    // Storage refused. The setting is a preference, so losing it costs a re-pick rather than
    // data — and throwing here would take down whatever screen was merely remembering something.
  }
}

/**
 * Caches the team listing for offline search.
 *
 * Inert: there is no offline in a browser, and `sync/library.ts` runs the online `search_cases`
 * path whenever a client exists.
 */
async function cacheTeamLibrary(): Promise<void> {
  await Promise.resolve()
}

/**
 * Reads the cached team listing.
 *
 * @returns Always empty. The UI already says which search it ran, so an empty cached result reads
 *   as "not cached" rather than as an empty library.
 */
async function cachedTeamLibrary(): Promise<TeamCaseSummary[]> {
  return await Promise.resolve([])
}

/**
 * Finds the copy this browser already made of a room's case.
 *
 * Without it, pressing co-prep twice on the same shared case makes a second copy and puts the
 * debater in the room with two half-written cases and no way to tell which is which.
 *
 * @param roomCaseId - The host's case id.
 * @returns The local case id, or null when nothing has been copied yet.
 */
async function findLocalCaseForRoom(roomCaseId: string): Promise<string | null> {
  let linkedCaseId: string | null = null
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(ROOM_LINK_PREFIX) && window.localStorage.getItem(key) === roomCaseId) {
        linkedCaseId = key.slice(ROOM_LINK_PREFIX.length)
        break
      }
    }
  } catch {
    return null
  }
  if (linkedCaseId === null) {
    return null
  }
  // The copy can have been deleted since; a link to a case that is gone is not a copy.
  return (await caseExistsLocally(linkedCaseId)) ? linkedCaseId : null
}

/** Postgres over PostgREST, with settings kept per browser and no queue in front of it. */
export const database: DatabasePlatform = {
  // Every method here goes through `session()`, so this is not a policy the shell chose — it is
  // `cases.owner_id not null references auth.users` restated where the UI can read it.
  requiresIdentity: true,
  saveCase,
  loadCase,
  listCases,
  listCaseIds,
  deleteCase,
  saveSession,
  listSessions,
  setSessionRecordingObject,
  loadSessionReport,
  deleteSession,
  listComments,
  loadComment,
  saveComment,
  deleteComment,
  replaceRemoteComments,
  loadScriptEdits,
  saveScriptEdit,
  deleteScriptEdit,
  enqueueChange,
  queuedChanges,
  clearQueued,
  recordQueueFailure,
  backfillQueue,
  caseExistsLocally,
  readSetting,
  writeSetting,
  cacheTeamLibrary,
  cachedTeamLibrary,
  findLocalCaseForRoom,
}

/** Re-exported so `remoteRowToCase` stays the one place a stored document is hydrated. */
export { remoteRowToCase }
