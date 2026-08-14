/**
 * SQLite access — the local source of truth on the desktop.
 *
 * The whole filled template lives in `cases.doc` as JSON. Columns beside it (`motion`, `format`,
 * `side`, `position`, `updated_at`) are denormalised copies used for listing and search;
 * `saveCase` rewrites them from the document so they cannot drift.
 *
 * This holds the sync queue too, which phase 9 kept in `sync/store.ts`. They are one file now
 * because they are one database and one transaction boundary: a case is not saved unless it is
 * also marked dirty, and splitting that across the seam would let a shell implement half of it.
 * The pure half of the old module — the backoff, the due check, the key prefixes — stayed behind,
 * because none of it touches a database.
 *
 * Nothing here is reachable in a browser build; the alias in `vite.config.ts` sees to that.
 */

import type { FormatId, Side } from '../../formats/index.ts'
import type { SpeechComment } from '../../speech/comments.ts'
import type { SessionMetrics } from '../../speech/metrics.ts'
import type { SpeechReport } from '../../speech/report.ts'
import { ROOM_LINK_PREFIX, SETTING_KEYS } from '../../sync/keys.ts'
import type { TeamCaseSummary } from '../../sync/rows.ts'
import type { Case, Visibility } from '../../types/case.ts'
import { hydrateCase } from '../../types/createCase.ts'
import type {
  CaseSummary,
  DatabasePlatform,
  QueueEntry,
  SessionSummary,
  SyncOperation,
  SyncTable,
} from '../types.ts'
import { getDatabase } from './connection.ts'

/** Shape of a `cases` row as the SQL plugin returns it. */
interface CaseRow {
  id: string
  motion: string
  format: FormatId
  side: Side
  position: string
  visibility: Visibility
  updated_at: string
  doc: string
}

/**
 * Inserts or updates a case.
 *
 * Writes `updatedAt` from the passed document rather than from the clock, so a case restored
 * from a `.dbcase` file or pulled from sync keeps its real modification time.
 *
 * @param caseFile - The case to persist. Its `id` is the primary key; passing an id that
 *   already exists overwrites that row wholesale rather than merging.
 */
async function saveCase(caseFile: Case): Promise<void> {
  const database = await getDatabase()
  await database.execute(
    `INSERT INTO cases (id, motion, format, side, position, doc, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO UPDATE SET
       motion = excluded.motion,
       format = excluded.format,
       side = excluded.side,
       position = excluded.position,
       doc = excluded.doc,
       visibility = excluded.visibility,
       updated_at = excluded.updated_at`,
    [
      caseFile.id,
      caseFile.prep.motion,
      caseFile.format,
      caseFile.side,
      caseFile.position,
      JSON.stringify(caseFile),
      caseFile.visibility,
      caseFile.createdAt,
      caseFile.updatedAt,
    ],
  )
  // Queued whether or not a project is configured. The queue is a set of dirty rows, so a case
  // edited all week is one entry — and turning the team layer on mid-season then pushes the
  // season rather than only what happens next.
  await enqueueChange('cases', caseFile.id, 'upsert')
}

/**
 * Loads one case.
 *
 * Runs the document through `hydrateCase`, so a row written before a block existed opens
 * with that block empty rather than undefined.
 *
 * @param caseId - Primary key. An unknown id returns null rather than throwing, because the
 *   common cause is a stale link to a case deleted on another machine.
 * @returns The parsed case, or null if no row matches.
 */
async function loadCase(caseId: string): Promise<Case | null> {
  const database = await getDatabase()
  const rows = await database.select<CaseRow[]>('SELECT doc FROM cases WHERE id = $1', [caseId])
  const row = rows[0]
  return row ? hydrateCase(JSON.parse(row.doc)) : null
}

/**
 * Lists cases newest-first for the library screen.
 *
 * @param limit - Maximum rows. Defaults to 100; the library paginates rather than loading a
 *   season's worth of cases into memory.
 * @returns Summaries only — call `loadCase` for the document.
 */
async function listCases(limit = 100): Promise<CaseSummary[]> {
  const database = await getDatabase()
  const rows = await database.select<CaseRow[]>(
    `SELECT id, motion, format, side, position, visibility, updated_at
     FROM cases ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  )
  return rows.map((row) => ({
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
 * Every case id on this machine.
 *
 * Separate from {@link listCases} because the importer needs *all* of them and that list is
 * paginated: a `.dbcase` restored over case 101 would overwrite it silently, which is the one
 * failure the import path is built to avoid. Ids only, so a season of cases is still one small
 * query.
 *
 * @returns Ids in no particular order.
 */
async function listCaseIds(): Promise<string[]> {
  const database = await getDatabase()
  const rows = await database.select<{ id: string }[]>('SELECT id FROM cases')
  return rows.map((row) => row.id)
}

/**
 * Deletes a case.
 *
 * @param caseId - Primary key. Deleting an unknown id is a no-op, not an error.
 */
async function deleteCase(caseId: string): Promise<void> {
  const database = await getDatabase()
  await database.execute('DELETE FROM cases WHERE id = $1', [caseId])
  await enqueueChange('cases', caseId, 'delete')
}

/** Shape of the joined `sessions` row as the SQL plugin returns it. */
interface SessionRow {
  id: string
  case_id: string | null
  motion: string | null
  format: FormatId
  role: string
  duration_s: number
  metrics: string
  recording_path: string | null
  recording_object_path: string | null
  created_at: string
  report: string | null
}

/**
 * Writes a session, or overwrites the one already there.
 *
 * Called twice for one speech and that is the design: the live report is stored the moment the
 * speaker sits down, so a crash during the `small.en` re-pass costs the accurate numbers rather
 * than the session, and the accurate report replaces it in the same row when it lands.
 *
 * @param report - The report to store. Its `sessionId` is the primary key and everything else on
 *   the row is derived from it, so two reports with the same id are the same speech by
 *   definition — pass a fresh id for a fresh speech or the earlier one is lost.
 * @param recordingPath - Local WAV, or null on the browser fallback which records nothing.
 */
async function saveSession(report: SpeechReport, recordingPath: string | null): Promise<void> {
  const database = await getDatabase()
  await database.execute(
    `INSERT INTO sessions (id, case_id, format, role, duration_s, metrics, recording_path,
                           created_at, report)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO UPDATE SET
       duration_s = excluded.duration_s,
       metrics = excluded.metrics,
       recording_path = excluded.recording_path,
       report = excluded.report`,
    [
      report.sessionId,
      report.caseId,
      report.format,
      report.roleId,
      report.metrics.durationSeconds,
      JSON.stringify(report.metrics),
      recordingPath,
      report.createdAt,
      JSON.stringify(report),
    ],
  )
  // Called twice per speech — live then review — and both land on one queue entry, so the row
  // that actually uploads is the `small.en` one whenever the re-pass finished before the drain.
  await enqueueChange('sessions', report.sessionId, 'upsert')
}

/**
 * Lists sessions newest-first for the Review screen.
 *
 * @param limit - Maximum rows. Defaults to 100.
 * @returns Summaries only. A row whose `metrics` cannot be parsed is dropped rather than
 *   returned half-built — it predates the current shape, and charting it would compare a number
 *   against one that means something else.
 */
async function listSessions(limit = 100): Promise<SessionSummary[]> {
  const database = await getDatabase()
  const rows = await database.select<SessionRow[]>(
    `SELECT sessions.id, sessions.case_id, sessions.format, sessions.role, sessions.duration_s,
            sessions.metrics, sessions.recording_path, sessions.recording_object_path,
            sessions.created_at, cases.motion
     FROM sessions LEFT JOIN cases ON cases.id = sessions.case_id
     ORDER BY sessions.created_at DESC LIMIT $1`,
    [limit],
  )

  return rows.flatMap((row) => {
    const metrics = parseMetrics(row.metrics)
    return metrics
      ? [
          {
            id: row.id,
            caseId: row.case_id,
            motion: row.motion ?? '',
            format: row.format,
            role: row.role,
            durationSeconds: row.duration_s,
            metrics,
            recordingPath: row.recording_path,
            recordingObjectPath: row.recording_object_path,
            createdAt: row.created_at,
          },
        ]
      : []
  })
}

/**
 * Records that a speech's audio is now in the bucket.
 *
 * Written as its own statement rather than through {@link saveSession}, which rewrites the row
 * from a report: the upload happens minutes or days after the report was built, and re-deriving
 * every other column from a stale report to change one of them is how a session loses its
 * accurate numbers.
 *
 * @param sessionId - Primary key. An unknown id is a no-op.
 * @param objectPath - The storage key, or null to record that the recording is no longer up there.
 */
async function setSessionRecordingObject(
  sessionId: string,
  objectPath: string | null,
): Promise<void> {
  const database = await getDatabase()
  await database.execute('UPDATE sessions SET recording_object_path = $2 WHERE id = $1', [
    sessionId,
    objectPath,
  ])
  await enqueueChange('sessions', sessionId, 'upsert')
}

/** Parses a stored metrics blob, or null when it is missing or not the current shape. */
function parseMetrics(stored: string): SessionMetrics | null {
  try {
    const parsed = JSON.parse(stored) as Partial<SessionMetrics>
    return parsed.version === 1 ? (parsed as SessionMetrics) : null
  } catch {
    return null
  }
}

/**
 * Loads one stored report.
 *
 * @param sessionId - Primary key.
 * @returns The report, or null when the row is unknown, has no report stored, or holds one from
 *   an older shape. The last case is why {@link SpeechReport.version} exists: rendering a report
 *   whose fields have moved is worse than saying it cannot be opened.
 */
async function loadSessionReport(sessionId: string): Promise<SpeechReport | null> {
  const database = await getDatabase()
  const rows = await database.select<SessionRow[]>('SELECT report FROM sessions WHERE id = $1', [
    sessionId,
  ])
  const stored = rows[0]?.report
  if (!stored) {
    return null
  }
  try {
    const parsed = JSON.parse(stored) as Partial<SpeechReport>
    return parsed.version === 1 ? (parsed as SpeechReport) : null
  } catch {
    return null
  }
}

/**
 * Deletes a session.
 *
 * Leaves the audio on disk. Removing a recording is a separate, louder action than tidying a list,
 * and a file deleted from under a coach's comment is not recoverable — `deleteRecording` in
 * `opus.rs` is the one that takes the files, and the Review screen asks before calling it.
 *
 * @param sessionId - Primary key. Deleting an unknown id is a no-op, not an error.
 */
async function deleteSession(sessionId: string): Promise<void> {
  const database = await getDatabase()
  await database.execute('DELETE FROM sessions WHERE id = $1', [sessionId])
  await enqueueChange('sessions', sessionId, 'delete')
}

/** Shape of a `comments` row as the SQL plugin returns it. */
interface CommentRow {
  id: string
  session_id: string
  author_id: string | null
  author_name: string
  t_seconds: number
  body: string
  created_at: string
  is_remote: number
}

/** Turns a stored row into a comment. */
function rowToComment(row: CommentRow): SpeechComment {
  return {
    id: row.id,
    sessionId: row.session_id,
    authorId: row.author_id,
    authorName: row.author_name,
    atSeconds: row.t_seconds,
    body: row.body,
    createdAt: row.created_at,
    isRemote: row.is_remote !== 0,
  }
}

/**
 * Every comment on one speech.
 *
 * @param sessionId - The session. An unknown id returns an empty list, which is also what a
 *   speech nobody has commented on returns — the two are the same thing to show.
 * @returns Comments earliest first.
 */
async function listComments(sessionId: string): Promise<SpeechComment[]> {
  const database = await getDatabase()
  const rows = await database.select<CommentRow[]>(
    `SELECT id, session_id, author_id, author_name, t_seconds, body, created_at, is_remote
     FROM comments WHERE session_id = $1 ORDER BY t_seconds, created_at`,
    [sessionId],
  )
  return rows.map(rowToComment)
}

/**
 * Loads one comment.
 *
 * Separate from {@link listComments} because the drain addresses a single row by id and has no
 * session to list against — the queue holds `(table, row_id)` and nothing else.
 *
 * @param commentId - Primary key.
 * @returns The comment, or null when it has been deleted since it was queued.
 */
async function loadComment(commentId: string): Promise<SpeechComment | null> {
  const database = await getDatabase()
  const rows = await database.select<CommentRow[]>(
    `SELECT id, session_id, author_id, author_name, t_seconds, body, created_at, is_remote
     FROM comments WHERE id = $1`,
    [commentId],
  )
  const row = rows[0]
  return row ? rowToComment(row) : null
}

/**
 * Writes a comment, or overwrites the one already there.
 *
 * @param comment - The note. Its `id` is the primary key, so re-saving one edits it rather than
 *   adding a second.
 * @param queueForSync - False when the comment came *from* the project, so a pull does not push
 *   the same row straight back. Defaults to true, which is what a comment typed here wants.
 */
async function saveComment(comment: SpeechComment, queueForSync = true): Promise<void> {
  const database = await getDatabase()
  await database.execute(
    `INSERT INTO comments (id, session_id, author_id, author_name, t_seconds, body, created_at,
                           is_remote)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(id) DO UPDATE SET
       author_name = excluded.author_name,
       t_seconds = excluded.t_seconds,
       body = excluded.body,
       is_remote = excluded.is_remote`,
    [
      comment.id,
      comment.sessionId,
      comment.authorId,
      comment.authorName,
      comment.atSeconds,
      comment.body,
      comment.createdAt,
      comment.isRemote ? 1 : 0,
    ],
  )
  if (queueForSync) {
    await enqueueChange('comments', comment.id, 'upsert')
  }
}

/**
 * Deletes a comment.
 *
 * @param commentId - Primary key. Deleting an unknown id is a no-op.
 */
async function deleteComment(commentId: string): Promise<void> {
  const database = await getDatabase()
  await database.execute('DELETE FROM comments WHERE id = $1', [commentId])
  await enqueueChange('comments', commentId, 'delete')
}

/**
 * Replaces the comments a session has, from the project.
 *
 * Replaces rather than merges, for the same reason `cacheTeamLibrary` does: a comment a coach
 * deleted has to disappear here too, and merging leaves it on screen forever. **Only remote
 * comments are cleared** — a note typed on this machine that has not drained yet is not gone, it
 * is pending, and dropping it would lose it silently.
 *
 * @param sessionId - The session these belong to.
 * @param comments - The full current list from Postgres.
 */
async function replaceRemoteComments(
  sessionId: string,
  comments: readonly SpeechComment[],
): Promise<void> {
  const database = await getDatabase()
  await database.execute('DELETE FROM comments WHERE session_id = $1 AND is_remote = 1', [
    sessionId,
  ])
  for (const comment of comments) {
    await saveComment({ ...comment, isRemote: true }, false)
  }
}

// ---------------------------------------------------------------------------
// Delivery rewrites
// ---------------------------------------------------------------------------

/**
 * Reads every rewrite stored for one case.
 *
 * @param caseId - The case whose script is being delivered.
 * @returns Segment id to replacement text. Empty is the ordinary state — most speeches are
 *   delivered as compiled. An empty *string* against a live id is a real edit meaning "do not
 *   say this segment", which is why the record holds it rather than pruning it.
 */
async function loadScriptEdits(caseId: string): Promise<Record<string, string>> {
  const database = await getDatabase()
  const rows = await database.select<{ segment_id: string; text: string }[]>(
    'SELECT segment_id, text FROM script_edits WHERE case_id = $1',
    [caseId],
  )
  return Object.fromEntries(rows.map((row) => [row.segment_id, row.text]))
}

/**
 * Stores one rewrite.
 *
 * @param caseId - The case being delivered.
 * @param segmentId - From `ScriptSegment.id`. Derived from case ids, so it survives a recompile.
 * @param text - The new wording. `''` is stored, not treated as a delete — see
 *   {@link loadScriptEdits}. Use {@link deleteScriptEdit} to restore the compiled text.
 */
async function saveScriptEdit(caseId: string, segmentId: string, text: string): Promise<void> {
  const database = await getDatabase()
  await database.execute(
    `INSERT INTO script_edits (case_id, segment_id, text, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT(case_id, segment_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    [caseId, segmentId, text, new Date().toISOString()],
  )
}

/**
 * Drops one rewrite, restoring the compiled wording.
 *
 * @param caseId - The case being delivered.
 * @param segmentId - Segment to revert. An id with no stored edit is a no-op.
 */
async function deleteScriptEdit(caseId: string, segmentId: string): Promise<void> {
  const database = await getDatabase()
  await database.execute('DELETE FROM script_edits WHERE case_id = $1 AND segment_id = $2', [
    caseId,
    segmentId,
  ])
}

// ---------------------------------------------------------------------------
// The sync queue
// ---------------------------------------------------------------------------

/** Shape of a `sync_queue` row as the SQL plugin returns it. */
interface QueueRow {
  id: number
  table_name: SyncTable
  row_id: string
  operation: SyncOperation
  attempts: number
  queued_at: string
  last_error: string | null
}

/**
 * Marks a row as needing to go up.
 *
 * Safe to call when sync is switched off entirely: the queue simply accumulates, and the first
 * drain after a project is configured pushes everything. That is what makes the team layer
 * something you can turn on halfway through a season without losing the season.
 *
 * @param table - Which table the row belongs to.
 * @param rowId - Primary key. Queueing the same row twice replaces the earlier entry rather than
 *   adding a second, and resets the attempt count — a fresh edit deserves a fresh try.
 * @param operation - `delete` if the row is gone locally, otherwise `upsert`.
 */
async function enqueueChange(
  table: SyncTable,
  rowId: string,
  operation: SyncOperation,
): Promise<void> {
  const database = await getDatabase()
  await database.execute(
    `INSERT INTO sync_queue (table_name, row_id, operation, queued_at, attempts)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT(table_name, row_id) DO UPDATE SET
       operation = excluded.operation,
       queued_at = excluded.queued_at,
       attempts = 0,
       last_error = NULL`,
    [table, rowId, operation, new Date().toISOString()],
  )
}

/**
 * Reads the queue.
 *
 * @param limit - Maximum entries. The drain takes a bounded slice so a queue built up over a
 *   week does not hold the app's first sync open for minutes.
 * @returns Entries oldest first, including ones that are backing off — `isDue` filters, so the
 *   caller can also count what is waiting.
 */
async function queuedChanges(limit = 200): Promise<QueueEntry[]> {
  const database = await getDatabase()
  const rows = await database.select<QueueRow[]>(
    `SELECT id, table_name, row_id, operation, attempts, queued_at, last_error
     FROM sync_queue ORDER BY queued_at LIMIT $1`,
    [limit],
  )
  return rows.map((row) => ({
    id: row.id,
    table: row.table_name,
    rowId: row.row_id,
    operation: row.operation,
    attempts: row.attempts,
    queuedAt: row.queued_at,
    lastError: row.last_error,
  }))
}

/**
 * Removes an entry that went up successfully.
 *
 * @param entryId - The queue row's own id, not the case or session id.
 */
async function clearQueued(entryId: number): Promise<void> {
  const database = await getDatabase()
  await database.execute('DELETE FROM sync_queue WHERE id = $1', [entryId])
}

/**
 * Records a failed push.
 *
 * @param entryId - The queue row's id.
 * @param message - What went wrong. Kept so the UI can say why rather than "sync failed", and
 *   so a row that has given up can be explained after the fact.
 */
async function recordQueueFailure(entryId: number, message: string): Promise<void> {
  const database = await getDatabase()
  await database.execute(
    `UPDATE sync_queue
     SET attempts = attempts + 1, last_error = $2, queued_at = $3
     WHERE id = $1`,
    [entryId, message.slice(0, 500), new Date().toISOString()],
  )
}

/**
 * Queues every local case, session and comment that is not already queued.
 *
 * Run once, the first time an install signs in. Without it, turning the team layer on after a
 * season of local work uploads only what changes *next*: the queue records edits, and nothing
 * ever edited the forty cases already sitting in SQLite. `ON CONFLICT DO NOTHING` means a row
 * with a pending edit keeps its own entry rather than having its attempt count reset.
 *
 * **Recordings are not backfilled, and nothing here uploads one.** The queue carries rows, and a
 * row is a few hundred bytes; an audio file is a person speaking and goes up when they ask. A
 * first sign-in that pushed a season of speeches over tournament wifi would be both a surprise
 * and a bandwidth bill.
 *
 * @returns How many rows were added, so the first sync can say what it is doing.
 */
async function backfillQueue(): Promise<number> {
  const database = await getDatabase()
  const queuedAt = new Date().toISOString()
  let added = 0
  for (const table of ['cases', 'sessions', 'comments'] as const) {
    // Comments pulled from the project are already up there; queueing them would push every one
    // straight back on the first drain after a sign-in.
    const filter = table === 'comments' ? 'WHERE is_remote = 0' : ''
    const result = await database.execute(
      `INSERT INTO sync_queue (table_name, row_id, operation, queued_at, attempts)
       SELECT '${table}', id, 'upsert', $1, 0 FROM ${table} ${filter}
       ON CONFLICT(table_name, row_id) DO NOTHING`,
      [queuedAt],
    )
    added += result.rowsAffected
  }
  return added
}

/**
 * Whether a case exists locally.
 *
 * Used before pushing a session: `sessions.case_id` is a foreign key, and a session whose case
 * was deleted would take the whole row down with it rather than losing one link.
 *
 * @param caseId - The case to look for, or null.
 * @returns False for null, so the caller does not have to special-case a session with no case.
 */
async function caseExistsLocally(caseId: string | null): Promise<boolean> {
  if (caseId === null) {
    return false
  }
  const database = await getDatabase()
  const rows = await database.select<{ id: string }[]>('SELECT id FROM cases WHERE id = $1', [
    caseId,
  ])
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// Settings and the cached team listing
// ---------------------------------------------------------------------------

/**
 * Reads one setting.
 *
 * @param key - One of `SETTING_KEYS`, or a prefixed key.
 * @returns The stored value, or null when it has never been written.
 */
async function readSetting(key: string): Promise<string | null> {
  const database = await getDatabase()
  const rows = await database.select<{ value: string }[]>(
    'SELECT value FROM app_settings WHERE key = $1',
    [key],
  )
  return rows[0]?.value ?? null
}

/**
 * Writes one setting.
 *
 * @param key - One of `SETTING_KEYS`, or a prefixed key.
 * @param value - The value, or null to remove it. Null rather than `''` for "no active team",
 *   because an empty string is a value someone could mistake for a team id.
 */
async function writeSetting(key: string, value: string | null): Promise<void> {
  const database = await getDatabase()
  if (value === null) {
    await database.execute('DELETE FROM app_settings WHERE key = $1', [key])
    return
  }
  await database.execute(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  )
}

/** Shape of a `team_library` row as the SQL plugin returns it. */
interface LibraryRow {
  id: string
  team_id: string
  owner_id: string
  owner_name: string
  motion: string
  format: TeamCaseSummary['format']
  side: TeamCaseSummary['side']
  position: string
  updated_at: string
}

/**
 * Replaces the cached team listing.
 *
 * Replaces rather than merges, and only for the team passed: a case a teammate deleted or made
 * private has to disappear from the cache, and merging leaves it there forever showing prep
 * nobody can open.
 *
 * @param teamId - Team the listing belongs to.
 * @param entries - The full current listing for that team.
 */
async function cacheTeamLibrary(
  teamId: string,
  entries: readonly TeamCaseSummary[],
): Promise<void> {
  const database = await getDatabase()
  const cachedAt = new Date().toISOString()
  await database.execute('DELETE FROM team_library WHERE team_id = $1', [teamId])
  for (const entry of entries) {
    await database.execute(
      `INSERT INTO team_library
         (id, team_id, owner_id, owner_name, motion, format, side, position, updated_at, cached_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.id,
        entry.teamId,
        entry.ownerId,
        entry.ownerName,
        entry.motion,
        entry.format,
        entry.side,
        entry.position,
        entry.updatedAt,
        cachedAt,
      ],
    )
  }
  await writeSetting(SETTING_KEYS.libraryPulledAt, cachedAt)
}

/**
 * Reads the cached team listing — the offline half of library search.
 *
 * A `LIKE` over motions rather than the Postgres full-text index. That is a real difference and
 * the UI says which one it used: offline you are searching the motion line, online you are
 * searching everything anyone wrote in the case.
 *
 * @param teamId - Team to list.
 * @param query - Optional substring of the motion, case-insensitive. Empty lists everything.
 * @returns Entries, most recently updated first.
 */
async function cachedTeamLibrary(teamId: string, query = ''): Promise<TeamCaseSummary[]> {
  const database = await getDatabase()
  const trimmed = query.trim()
  const rows = await database.select<LibraryRow[]>(
    `SELECT id, team_id, owner_id, owner_name, motion, format, side, position, updated_at
     FROM team_library
     WHERE team_id = $1 AND ($2 = '' OR motion LIKE '%' || $2 || '%' COLLATE NOCASE)
     ORDER BY updated_at DESC`,
    [teamId, trimmed],
  )
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    motion: row.motion,
    format: row.format,
    side: row.side,
    position: row.position,
    updatedAt: row.updated_at,
  }))
}

/**
 * Finds the copy this install already made of a room's case.
 *
 * Without this, pressing "co-prep" twice on the same shared case makes a second copy and puts the
 * debater in the room with two half-written local cases and no way to tell which is which.
 *
 * @param roomCaseId - The host's case id.
 * @returns The local case id, or null when nothing has been copied yet.
 */
async function findLocalCaseForRoom(roomCaseId: string): Promise<string | null> {
  const database = await getDatabase()
  const rows = await database.select<{ key: string }[]>(
    'SELECT key FROM app_settings WHERE key LIKE $1 AND value = $2',
    [`${ROOM_LINK_PREFIX}%`, roomCaseId],
  )
  const key = rows[0]?.key
  if (key === undefined) {
    return null
  }
  // The copy can have been deleted since; a link to a case that is gone is not a copy.
  const found = await database.select<{ id: string }[]>('SELECT id FROM cases WHERE id = $1', [
    key.slice(ROOM_LINK_PREFIX.length),
  ])
  return found[0]?.id ?? null
}

/** Local SQLite, with the real sync queue behind it. */
export const database: DatabasePlatform = {
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
