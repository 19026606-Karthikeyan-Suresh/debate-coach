/**
 * The team library, online and off.
 *
 * **A teammate's case is browsable, not editable.** `cases_update` grants the owner and nobody
 * else, which is a deliberate rule rather than a limitation to work around: a teammate silently
 * rewriting your case an hour before a round is worse than having to ask. So opening one takes a
 * copy — a fresh id, owned by whoever imported it — exactly as a `.dbcase` does. Two people
 * editing one document is phase 11's problem and Yjs is its answer, not a second write policy.
 *
 * **Offline is a different search, and it says so.** Online, `search_cases` runs over the
 * generated `tsvector` and reaches every word anyone typed into a case. Offline, all that exists
 * is the cached listing, so the query is a substring of the motion. Returning fewer results
 * quietly would make the cache look like an empty library.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import { saveCase } from '../db/index.ts'
import type { Case } from '../types/case.ts'
import { newId } from '../types/createCase.ts'
import { cachedTeamLibrary, cacheTeamLibrary } from './store.ts'
import { fetchRemoteCase, fetchTeamLibrary, searchRemoteCases } from './supabase.ts'
import type { TeamCaseSummary } from './rows.ts'

/** A listing, and where it came from. */
export interface LibraryListing {
  readonly entries: readonly TeamCaseSummary[]
  /** False when this came out of the local cache, which searches motions only. */
  readonly isLive: boolean
  /** Why the live query was not used, when it was tried and failed. */
  readonly error: string | null
}

/**
 * Pulls the team's shared cases and caches them for offline.
 *
 * @param client - The signed-in client.
 * @param teamId - Team to pull.
 * @param userId - This install's uid, so the debater's own cases are not listed twice.
 * @returns The listing, live.
 * @throws If the query fails. Callers that must not fail should use {@link browseTeamLibrary}.
 */
export async function refreshTeamLibrary(
  client: SupabaseClient,
  teamId: string,
  userId: string,
): Promise<readonly TeamCaseSummary[]> {
  const entries = await fetchTeamLibrary(client, teamId, userId)
  await cacheTeamLibrary(teamId, entries)
  return entries
}

/**
 * Lists or searches the team library, falling back to the cache.
 *
 * @param client - The client, or null when the build has no project. Null goes straight to the
 *   cache without an error: an install that never had a project still has whatever it pulled
 *   before the config was removed, and saying "offline" about it would be a guess.
 * @param teamId - Team to browse.
 * @param userId - This install's uid.
 * @param query - Search text. Empty lists everything.
 * @returns The entries and whether they came off the network.
 */
export async function browseTeamLibrary(
  client: SupabaseClient | null,
  teamId: string,
  userId: string,
  query: string,
): Promise<LibraryListing> {
  if (client === null) {
    return { entries: await cachedTeamLibrary(teamId, query), isLive: false, error: null }
  }

  try {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      return { entries: await refreshTeamLibrary(client, teamId, userId), isLive: true, error: null }
    }
    // Search results are not cached: they are a slice of the library chosen by a query, and
    // writing them over the cache would make the offline listing whatever was last searched for.
    const found = await searchRemoteCases(client, teamId, trimmed)
    return { entries: found.filter((entry) => entry.ownerId !== userId), isLive: true, error: null }
  } catch (queryError) {
    const message = queryError instanceof Error ? queryError.message : String(queryError)
    return { entries: await cachedTeamLibrary(teamId, query), isLive: false, error: message }
  }
}

/**
 * Copies a teammate's case into this install.
 *
 * @param client - The signed-in client.
 * @param caseId - The case to copy.
 * @param now - Timestamp for the copy's `updatedAt`, so it sorts to the top of the library where
 *   the person who just imported it is looking.
 * @returns The new local case, already saved and queued for the next push.
 * @throws If the case is gone or this identity may not read it — RLS makes those the same
 *   answer, and the message says the case could not be opened rather than which it was.
 */
export async function importTeamCase(
  client: SupabaseClient,
  caseId: string,
  now: string,
): Promise<Case> {
  const remote = await fetchRemoteCase(client, caseId)
  if (!remote) {
    throw new Error('That case is no longer available.')
  }

  // A new id, not the original: the copy is this debater's, and pushing it under the teammate's
  // id would be rejected by `cases_update` anyway. `createdAt` is kept — it is the same prep,
  // written on the day it was written.
  const copy: Case = {
    ...remote,
    id: newId(),
    updatedAt: now,
    // Somebody else's sharing decision is not this install's to inherit.
    visibility: 'private',
  }
  await saveCase(copy)
  return copy
}
