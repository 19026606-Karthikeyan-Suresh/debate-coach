/**
 * The local half of sync: what is dirty, what is cached, and what this install remembers.
 *
 * Three tables, all added by migration 3. `sync_queue` is a **set of dirty rows**, not a log —
 * a unique index on `(table_name, row_id)` means a case edited forty times on a train is one
 * entry, and the document is re-read from SQLite when the entry drains, so what uploads is the
 * final text rather than forty versions of it.
 *
 * The backoff is pure and exported, because "when is this row due" is the part that decides
 * whether a flaky connection produces one retry a minute or a tight loop against a server that
 * is already refusing.
 */

import { getDatabase } from '../db/connection.ts'
import type { TeamCaseSummary } from './rows.ts'

/**
 * Tables that replicate. Nothing else has a Postgres counterpart worth queueing.
 *
 * The order they are declared in is the order they drain in, and it is a foreign-key order:
 * `sessions.case_id` references `cases`, and `comments.session_id` references `sessions`.
 */
export type SyncTable = 'cases' | 'sessions' | 'comments'

/** What happened locally. A delete supersedes an upsert for the same row. */
export type SyncOperation = 'upsert' | 'delete'

/** One dirty row waiting to go up. */
export interface QueueEntry {
  readonly id: number
  readonly table: SyncTable
  readonly rowId: string
  readonly operation: SyncOperation
  /** Failed pushes so far. Drives {@link backoffSeconds} and the give-up point. */
  readonly attempts: number
  /** ISO 8601. Rewritten on each failure, so it is "last tried" as much as "first queued". */
  readonly queuedAt: string
  readonly lastError: string | null
}

/**
 * Attempts after which a row stops being retried.
 *
 * Twelve failures at the capped interval is most of a day. Past that the cause is not a bad
 * connection — it is a row Postgres will never accept — and a queue that keeps trying hides it
 * behind "syncing…" forever instead of saying so.
 */
export const MAX_SYNC_ATTEMPTS = 12

/** Longest wait between retries. Five minutes; a tournament day is not a batch job. */
const MAX_BACKOFF_SECONDS = 300

/**
 * How long to wait before retrying a row.
 *
 * @param attempts - Failures so far. Zero means never tried, which is due immediately.
 * @returns Seconds, doubling from five and capped. Negative or non-finite input is treated as
 *   zero rather than producing a wait in the past.
 */
export function backoffSeconds(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts <= 0) {
    return 0
  }
  return Math.min(5 * 2 ** (attempts - 1), MAX_BACKOFF_SECONDS)
}

/**
 * Whether an entry may be tried now.
 *
 * @param entry - The queued row.
 * @param now - Current time, passed in so a test does not wait five minutes.
 * @returns False while it is backing off, and false forever once it has passed
 *   {@link MAX_SYNC_ATTEMPTS} — at which point it is reported rather than retried.
 */
export function isDue(entry: QueueEntry, now: Date): boolean {
  if (entry.attempts >= MAX_SYNC_ATTEMPTS) {
    return false
  }
  const queuedAt = new Date(entry.queuedAt).getTime()
  if (Number.isNaN(queuedAt)) {
    return true
  }
  return now.getTime() >= queuedAt + backoffSeconds(entry.attempts) * 1000
}

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
export async function enqueueChange(
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
 * @returns Entries oldest first, including ones that are backing off — {@link isDue} filters,
 *   so the caller can also count what is waiting.
 */
export async function queuedChanges(limit = 200): Promise<QueueEntry[]> {
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
export async function clearQueued(entryId: number): Promise<void> {
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
export async function recordQueueFailure(entryId: number, message: string): Promise<void> {
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
export async function backfillQueue(): Promise<number> {
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
export async function caseExistsLocally(caseId: string | null): Promise<boolean> {
  if (caseId === null) {
    return false
  }
  const database = await getDatabase()
  const rows = await database.select<{ id: string }[]>('SELECT id FROM cases WHERE id = $1', [
    caseId,
  ])
  return rows.length > 0
}

/** Setting keys. Strings rather than an enum so a stored value survives a rename here. */
export const SETTING_KEYS = {
  /** `auth.uid()` this install signed in as. */
  userId: 'sync.user_id',
  /** Team whose library is shown and whose id is stamped on pushed rows. */
  activeTeamId: 'sync.active_team_id',
  /** Display name sent with `join_team`. */
  displayName: 'sync.display_name',
  /** ISO 8601 of the last successful library pull. */
  libraryPulledAt: 'sync.library_pulled_at',
} as const

/**
 * Reads one setting.
 *
 * @param key - One of {@link SETTING_KEYS}.
 * @returns The stored value, or null when it has never been written.
 */
export async function readSetting(key: string): Promise<string | null> {
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
 * @param key - One of {@link SETTING_KEYS}.
 * @param value - The value, or null to remove it. Null rather than `''` for "no active team",
 *   because an empty string is a value someone could mistake for a team id.
 */
export async function writeSetting(key: string, value: string | null): Promise<void> {
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
export async function cacheTeamLibrary(
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
export async function cachedTeamLibrary(
  teamId: string,
  query = '',
): Promise<TeamCaseSummary[]> {
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

// ---------------------------------------------------------------------------
// Co-prep room links
// ---------------------------------------------------------------------------

/**
 * Prefix for "this local case is a copy of that room's case".
 *
 * A settings key rather than a column, because it is a fact about *this install's* copy and not
 * about the case document — the same reasoning that keeps `position` and `visibility` out of the
 * shared document. The host needs no entry: the room's id is its own case id.
 */
const ROOM_LINK_PREFIX = 'coprep.room.'

/**
 * Which room a local case is joined to.
 *
 * @param localCaseId - The case as it exists on this install.
 * @returns The **host's** case id, or null when this install owns the case and is therefore the
 *   host of its room.
 */
export async function readRoomLink(localCaseId: string): Promise<string | null> {
  return readSetting(`${ROOM_LINK_PREFIX}${localCaseId}`)
}

/**
 * Records, or clears, which room a local case belongs to.
 *
 * @param localCaseId - The local copy.
 * @param roomCaseId - The host's case id, or null to forget the link.
 */
export async function writeRoomLink(
  localCaseId: string,
  roomCaseId: string | null,
): Promise<void> {
  await writeSetting(`${ROOM_LINK_PREFIX}${localCaseId}`, roomCaseId)
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
export async function findLocalCaseForRoom(roomCaseId: string): Promise<string | null> {
  const database = await getDatabase()
  const rows = await database.select<{ key: string }[]>(
    "SELECT key FROM app_settings WHERE key LIKE $1 AND value = $2",
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

// ---------------------------------------------------------------------------
// Prep length
// ---------------------------------------------------------------------------

/**
 * Prefix for a per-format prep-length override, in whole minutes.
 *
 * Per format rather than per case, and a setting rather than a column on the case, because the
 * length belongs to the round the debater is sitting in and not to the document they are
 * writing. A tournament running short prep runs it short for every case that day; putting it in
 * the case would mean setting it again on the next one — and would put it in the co-prep CRDT
 * and the `.dbcase` export, neither of which is anything to do with a clock on this laptop.
 */
const PREP_MINUTES_PREFIX = 'prep.minutes.'

/**
 * Reads the prep length this install uses for a format.
 *
 * @param formatId - `AP` or `BP`.
 * @returns The stored minutes as text, or null to use the format's own default.
 */
export async function readPrepMinutes(formatId: string): Promise<string | null> {
  return readSetting(`${PREP_MINUTES_PREFIX}${formatId}`)
}

/**
 * Stores, or clears, the prep length for a format.
 *
 * @param formatId - `AP` or `BP`.
 * @param minutes - Whole minutes, or null to go back to the format's default.
 */
export async function writePrepMinutes(formatId: string, minutes: number | null): Promise<void> {
  await writeSetting(
    `${PREP_MINUTES_PREFIX}${formatId}`,
    minutes === null ? null : String(minutes),
  )
}
