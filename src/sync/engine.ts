/**
 * Draining the queue: the one place the local database and the project actually meet.
 *
 * **Cases go up before sessions, always.** `sessions.case_id` is a foreign key, so a speech
 * pushed ahead of the case it was given from is rejected by Postgres — and the queue is ordered
 * by when a row was touched, which says nothing about that. The order is fixed here instead, and
 * a session whose case is not going up in this run has its link dropped rather than the whole
 * row lost.
 *
 * **A failure is per row, not per run.** One case Postgres refuses must not stop the other
 * thirty-nine; each entry records its own error and backs off on its own schedule, and the run
 * reports how many of each. A single `catch` around the loop would turn one bad row into a
 * permanently broken sync with one message to explain it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import { listSessions, loadCase } from '../db/index.ts'
import { caseToRemoteRow, sessionToRemoteRow } from './rows.ts'
import {
  MAX_SYNC_ATTEMPTS,
  backfillQueue,
  caseExistsLocally,
  clearQueued,
  isDue,
  queuedChanges,
  readSetting,
  recordQueueFailure,
  SETTING_KEYS,
  writeSetting,
  type QueueEntry,
} from './store.ts'
import {
  deleteRemoteRow,
  ensureSignedIn,
  getSupabase,
  pushCase,
  pushSession,
} from './supabase.ts'

/** What one drain did. Every count is a different thing to say to the debater. */
export interface SyncOutcome {
  /** True when there is no project configured. Everything else is zero and nothing failed. */
  readonly isDisabled: boolean
  readonly pushed: number
  /** Rows that failed this run and will be retried. */
  readonly failed: number
  /** Rows still backing off from an earlier failure. */
  readonly waiting: number
  /** Rows past {@link MAX_SYNC_ATTEMPTS}. These need a human, not another retry. */
  readonly givenUp: number
  /** A failure of the run itself — no network, sign-in refused — rather than of a row. */
  readonly error: string | null
}

/** Nothing happened because there is nothing to happen against. */
const DISABLED: SyncOutcome = {
  isDisabled: true,
  pushed: 0,
  failed: 0,
  waiting: 0,
  givenUp: 0,
  error: null,
}

/** Cases first. Within a table, oldest first, which is the order they were touched in. */
function drainOrder(entries: readonly QueueEntry[]): QueueEntry[] {
  return [...entries].sort((left, right) => {
    if (left.table !== right.table) {
      return left.table === 'cases' ? -1 : 1
    }
    return left.queuedAt.localeCompare(right.queuedAt)
  })
}

/** Pushes one case, or deletes it. Returns nothing; throwing is how failure is reported. */
async function drainCase(
  client: SupabaseClient,
  entry: QueueEntry,
  userId: string,
  teamId: string | null,
): Promise<void> {
  if (entry.operation === 'delete') {
    await deleteRemoteRow(client, 'cases', entry.rowId)
    return
  }

  const caseFile = await loadCase(entry.rowId)
  // Queued as an edit, gone by the time it drained. The intent that survives is "this row should
  // not be there", which is a delete.
  if (!caseFile) {
    await deleteRemoteRow(client, 'cases', entry.rowId)
    return
  }
  await pushCase(client, caseToRemoteRow(caseFile, userId, teamId))
}

/** Pushes one session's metrics, or deletes it. */
async function drainSession(
  client: SupabaseClient,
  entry: QueueEntry,
  userId: string,
  teamId: string | null,
): Promise<void> {
  if (entry.operation === 'delete') {
    await deleteRemoteRow(client, 'sessions', entry.rowId)
    return
  }

  // `listSessions` is the only reader of the summary shape, and a season of them is a small
  // query — small enough not to be worth a second one that fetches a single row.
  const summaries = await listSessions(500)
  const session = summaries.find((candidate) => candidate.id === entry.rowId)
  if (!session) {
    await deleteRemoteRow(client, 'sessions', entry.rowId)
    return
  }

  const hasCase = await caseExistsLocally(session.caseId)
  if (hasCase && session.caseId !== null) {
    // Pushed again even if it was pushed a moment ago in this same run: an upsert is idempotent,
    // and the alternative is tracking which ids went up and getting the foreign key wrong on the
    // one path that is not covered.
    const caseFile = await loadCase(session.caseId)
    if (caseFile) {
      await pushCase(client, caseToRemoteRow(caseFile, userId, teamId))
    }
  }

  await pushSession(client, sessionToRemoteRow(session, userId, teamId, hasCase))
}

/**
 * Pushes everything that is due.
 *
 * @param now - Current time, passed in so the backoff can be tested without waiting. Defaults to
 *   the clock.
 * @returns What happened, in enough detail for the UI to distinguish "offline", "one row is
 *   broken" and "nothing to do" — which look identical from a boolean.
 */
export async function runSync(now: Date = new Date()): Promise<SyncOutcome> {
  const client = getSupabase()
  if (!client) {
    return DISABLED
  }

  let userId: string
  try {
    userId = await ensureSignedIn(client)
  } catch (signInError) {
    return {
      isDisabled: false,
      pushed: 0,
      failed: 0,
      waiting: 0,
      givenUp: 0,
      error: signInError instanceof Error ? signInError.message : String(signInError),
    }
  }

  // First sign-in on an install that has been used offline: everything already in SQLite is
  // dirty, because nothing ever queued it.
  const knownUserId = await readSetting(SETTING_KEYS.userId)
  if (knownUserId !== userId) {
    await backfillQueue()
    await writeSetting(SETTING_KEYS.userId, userId)
  }

  const teamId = await readSetting(SETTING_KEYS.activeTeamId)
  const entries = await queuedChanges()

  let pushed = 0
  let failed = 0
  let waiting = 0
  let givenUp = 0

  for (const entry of drainOrder(entries)) {
    if (entry.attempts >= MAX_SYNC_ATTEMPTS) {
      givenUp += 1
      continue
    }
    if (!isDue(entry, now)) {
      waiting += 1
      continue
    }

    try {
      if (entry.table === 'cases') {
        await drainCase(client, entry, userId, teamId)
      } else {
        await drainSession(client, entry, userId, teamId)
      }
      await clearQueued(entry.id)
      pushed += 1
    } catch (pushError) {
      const message = pushError instanceof Error ? pushError.message : String(pushError)
      await recordQueueFailure(entry.id, message)
      failed += 1
    }
  }

  return { isDisabled: false, pushed, failed, waiting, givenUp, error: null }
}
