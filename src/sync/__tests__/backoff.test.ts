/**
 * When a failed row is tried again.
 *
 * The pure half of the queue. Everything else in `store.ts` is SQL against the Tauri plugin and
 * is exercised by running the app; this is the part that decides whether a project that is
 * refusing produces one retry every five minutes or a tight loop against it.
 */

import { describe, expect, it } from 'vitest'

import { MAX_SYNC_ATTEMPTS, backoffSeconds, isDue, type QueueEntry } from '../store.ts'

/** A queue entry with the two fields the backoff reads. */
function entry(attempts: number, queuedAt: string): QueueEntry {
  return {
    id: 1,
    table: 'cases',
    rowId: 'cccccccc-0000-4000-8000-000000000001',
    operation: 'upsert',
    attempts,
    queuedAt,
    lastError: null,
  }
}

describe('backoffSeconds', () => {
  it('is immediate for a row that has never been tried', () => {
    expect(backoffSeconds(0)).toBe(0)
  })

  it('doubles from five seconds', () => {
    expect(backoffSeconds(1)).toBe(5)
    expect(backoffSeconds(2)).toBe(10)
    expect(backoffSeconds(3)).toBe(20)
    expect(backoffSeconds(4)).toBe(40)
  })

  it('caps at five minutes', () => {
    // A tournament day is not a batch job; an hour-long wait is indistinguishable from broken.
    expect(backoffSeconds(20)).toBe(300)
    expect(backoffSeconds(MAX_SYNC_ATTEMPTS)).toBe(300)
  })

  it('treats nonsense as immediate rather than as a wait in the past', () => {
    expect(backoffSeconds(-3)).toBe(0)
    expect(backoffSeconds(Number.NaN)).toBe(0)
  })
})

describe('isDue', () => {
  const queuedAt = '2026-08-09T10:00:00.000Z'

  it('lets a fresh entry through immediately', () => {
    expect(isDue(entry(0, queuedAt), new Date(queuedAt))).toBe(true)
  })

  it('holds a failed entry back until its wait is over', () => {
    const failed = entry(3, queuedAt)
    expect(isDue(failed, new Date('2026-08-09T10:00:15.000Z'))).toBe(false)
    expect(isDue(failed, new Date('2026-08-09T10:00:20.000Z'))).toBe(true)
  })

  it('stops retrying once a row has clearly failed for good', () => {
    // Twelve failures at the capped interval is most of a day. Past that the cause is a row
    // Postgres will never accept, and the UI counts it separately so it can say so.
    const stuck = entry(MAX_SYNC_ATTEMPTS, queuedAt)
    expect(isDue(stuck, new Date('2027-01-01T00:00:00.000Z'))).toBe(false)
  })

  it('tries an entry whose timestamp is unreadable', () => {
    // A corrupt `queued_at` should not strand a row forever; retrying it is recoverable and
    // ignoring it is not.
    expect(isDue(entry(1, 'not a date'), new Date(queuedAt))).toBe(true)
  })
})
