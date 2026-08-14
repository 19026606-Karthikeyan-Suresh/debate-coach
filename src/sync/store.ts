/**
 * The local half of sync: what is dirty, what is cached, and what this install remembers.
 *
 * The storage half moved behind the platform seam, because it means different things in the two
 * shells. On the desktop it is three real tables from migration 3, and `sync_queue` is a **set of
 * dirty rows**, not a log — a case edited forty times on a train is one entry, and the document is
 * re-read when the entry drains, so what uploads is the final text rather than forty versions of
 * it. In a browser, where the database *is* the server, a write is already up and the same methods
 * are inert.
 *
 * What stayed is everything that is arithmetic. The backoff decides whether a flaky connection
 * produces one retry a minute or a tight loop against a server that is already refusing, and that
 * answer cannot depend on which shell asked.
 */

import { database } from '@platform'

import type { QueueEntry } from '../platform/types.ts'
import { PREP_MINUTES_PREFIX, ROOM_LINK_PREFIX } from './keys.ts'

export type { QueueEntry, SyncOperation, SyncTable } from '../platform/types.ts'
export { SETTING_KEYS } from './keys.ts'

export const {
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
} = database

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

// ---------------------------------------------------------------------------
// Co-prep room links
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prep length
// ---------------------------------------------------------------------------

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
