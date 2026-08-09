/**
 * SQLite access — the local source of truth.
 *
 * The whole filled template lives in `cases.doc` as JSON. Columns beside it (`motion`,
 * `format`, `side`, `position`, `updated_at`) are denormalised copies used for listing and
 * search; `saveCase` rewrites them from the document so they cannot drift.
 */

import type { FormatId, Side } from '../formats/index.ts'
import type { SpeechComment } from '../speech/comments.ts'
import type { SessionMetrics } from '../speech/metrics.ts'
import type { SpeechReport } from '../speech/report.ts'
import { enqueueChange } from '../sync/store.ts'
import type { Case, Visibility } from '../types/case.ts'
import { hydrateCase } from '../types/createCase.ts'
import { getDatabase } from './connection.ts'

export { getDatabase } from './connection.ts'

/** One row of the case list — enough to render the library without parsing every document. */
export interface CaseSummary {
  readonly id: string
  readonly motion: string
  readonly format: FormatId
  readonly side: Side
  readonly position: string
  readonly visibility: Visibility
  readonly updatedAt: string
}

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
export async function saveCase(caseFile: Case): Promise<void> {
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
export async function loadCase(caseId: string): Promise<Case | null> {
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
export async function listCases(limit = 100): Promise<CaseSummary[]> {
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
export async function listCaseIds(): Promise<string[]> {
  const database = await getDatabase()
  const rows = await database.select<{ id: string }[]>('SELECT id FROM cases')
  return rows.map((row) => row.id)
}

/**
 * Deletes a case.
 *
 * @param caseId - Primary key. Deleting an unknown id is a no-op, not an error.
 */
export async function deleteCase(caseId: string): Promise<void> {
  const database = await getDatabase()
  await database.execute('DELETE FROM cases WHERE id = $1', [caseId])
  await enqueueChange('cases', caseId, 'delete')
}

/**
 * One delivered speech, as the history list needs it.
 *
 * The numbers come from `sessions.metrics`; the detail behind them stays in `sessions.report` and
 * is only read when a report is actually opened. A season of sessions is a season of transcripts,
 * and the Review screen should not load them all to draw a chart.
 */
export interface SessionSummary {
  readonly id: string
  /** Null once the case has been deleted. The report still opens; it carries its own copy. */
  readonly caseId: string | null
  /**
   * The case's motion **as it stands now**, so a session is found by the debate it belongs to.
   * Empty when the case is gone — the report's own copy is what survives that.
   */
  readonly motion: string
  readonly format: FormatId
  readonly role: string
  readonly durationSeconds: number
  readonly metrics: SessionMetrics
  /** The local WAV. Null on the browser fallback, which records nothing. */
  readonly recordingPath: string | null
  /**
   * Key inside the `recordings` storage bucket, once the debater has shared this speech.
   *
   * Null is the ordinary state and means "not uploaded", never "upload failed" — a recording goes
   * up when it is asked for, not because a report was generated.
   */
  readonly recordingObjectPath: string | null
  readonly createdAt: string
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
export async function saveSession(
  report: SpeechReport,
  recordingPath: string | null,
): Promise<void> {
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
export async function listSessions(limit = 100): Promise<SessionSummary[]> {
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
export async function setSessionRecordingObject(
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
export async function loadSessionReport(sessionId: string): Promise<SpeechReport | null> {
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
export async function deleteSession(sessionId: string): Promise<void> {
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
export async function listComments(sessionId: string): Promise<SpeechComment[]> {
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
export async function loadComment(commentId: string): Promise<SpeechComment | null> {
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
export async function saveComment(comment: SpeechComment, queueForSync = true): Promise<void> {
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
export async function deleteComment(commentId: string): Promise<void> {
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
export async function replaceRemoteComments(
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
export async function loadScriptEdits(caseId: string): Promise<Record<string, string>> {
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
export async function saveScriptEdit(
  caseId: string,
  segmentId: string,
  text: string,
): Promise<void> {
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
export async function deleteScriptEdit(caseId: string, segmentId: string): Promise<void> {
  const database = await getDatabase()
  await database.execute('DELETE FROM script_edits WHERE case_id = $1 AND segment_id = $2', [
    caseId,
    segmentId,
  ])
}
