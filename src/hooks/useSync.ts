/**
 * Sign-in, teams, and the drain — held in one place so the Library does not have to sequence them.
 *
 * Everything here starts by asking whether there is a project at all. On a build with no `.env`
 * the hook settles into `isConfigured: false` and never touches the network, which is the state
 * a fresh clone is in and is not an error to report.
 */

import { useCallback, useEffect, useState } from 'react'

import { runSync, type SyncOutcome } from '../sync/engine.ts'
import { SETTING_KEYS, readSetting, writeSetting } from '../sync/store.ts'
import {
  createTeam as createRemoteTeam,
  deleteTeam as deleteRemoteTeam,
  ensureSignedIn,
  getSupabase,
  joinTeam as joinRemoteTeam,
  leaveTeam as leaveRemoteTeam,
  myTeams,
  rotateInviteCode as rotateRemoteCode,
  type TeamMembership,
} from '../sync/supabase.ts'

/** Whether the credential store can keep a session across launches. */
export interface IdentityStatus {
  readonly hasSession: boolean
  readonly backend: string
  readonly persistent: boolean
  readonly error: string | null
}

/** Everything the team panel and the team library need. */
export interface SyncState {
  /** False when this build has no Supabase project. Nothing else here does anything. */
  readonly isConfigured: boolean
  /** True while a sign-in, a team call or a drain is in flight. */
  readonly isBusy: boolean
  readonly userId: string | null
  readonly teams: readonly TeamMembership[]
  readonly activeTeamId: string | null
  readonly displayName: string
  readonly lastOutcome: SyncOutcome | null
  /** The last failure, or null. Cleared at the start of every action. */
  readonly error: string | null
  /** Re-reads teams and settings from the project and the local database. */
  readonly refresh: () => Promise<void>
  /** Drains the queue. */
  readonly sync: () => Promise<void>
  readonly setActiveTeam: (teamId: string | null) => Promise<void>
  readonly setDisplayName: (name: string) => Promise<void>
  /** Creates a team and returns its invite code, which is shown once and never again. */
  readonly createTeam: (name: string) => Promise<string | null>
  readonly joinTeam: (inviteCode: string) => Promise<boolean>
  /** Issues a new code, invalidating the old one. Returns it, or null if the call failed. */
  readonly rotateInviteCode: (teamId: string) => Promise<string | null>
  readonly leaveTeam: (teamId: string) => Promise<void>
  /**
   * Deletes a team outright. Admins only, and irreversible.
   *
   * Returns how many shared cases stopped being shared, or null if the call failed — the two are
   * different things to say, and zero is a real answer.
   */
  readonly deleteTeam: (teamId: string) => Promise<number | null>
}

/**
 * Owns the team layer's state for one screen.
 *
 * @returns See {@link SyncState}. Safe to call on a build with no project: every action becomes
 *   a no-op rather than a rejected promise.
 */
export function useSync(): SyncState {
  const isConfigured = getSupabase() !== null

  const [isBusy, setIsBusy] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [teams, setTeams] = useState<readonly TeamMembership[]>([])
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null)
  const [displayName, setStoredDisplayName] = useState('')
  const [lastOutcome, setLastOutcome] = useState<SyncOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setIsBusy(true)
    try {
      // The two settings are local, so they load even with the team layer switched off — which
      // is what lets the cached library still be browsed. They are inside the `try` because
      // opening SQLite can fail, and an unhandled rejection here leaves the panel blank with
      // nothing on screen to say why.
      const [storedTeam, storedName] = await Promise.all([
        readSetting(SETTING_KEYS.activeTeamId),
        readSetting(SETTING_KEYS.displayName),
      ])
      setActiveTeamId(storedTeam)
      setStoredDisplayName(storedName ?? '')

      const client = getSupabase()
      if (!client) {
        return
      }
      const signedInAs = await ensureSignedIn(client)
      setUserId(signedInAs)
      const memberships = await myTeams(client)
      setTeams(memberships)
      // A team this install was removed from, or one whose id survived a reinstall. Leaving it
      // selected would stamp every pushed row with a team the policy will reject.
      if (storedTeam !== null && !memberships.some((team) => team.teamId === storedTeam)) {
        await writeSetting(SETTING_KEYS.activeTeamId, null)
        setActiveTeamId(null)
      }
      setError(null)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
    } finally {
      setIsBusy(false)
    }
  }, [])

  // Initial load. Written inline rather than calling `refresh` so the state updates sit visibly
  // inside the promise callback, and so a response landing after unmount is dropped.
  useEffect(() => {
    let isStale = false
    // One `try` around the whole thing, settings included. `Database.load` throws outside the
    // Tauri shell and on a locked or unmigrated file, and a rejection escaping a `void`-ed async
    // IIFE is an unhandled rejection in the console with a blank panel on screen.
    void (async () => {
      try {
        const [storedTeam, storedName] = await Promise.all([
          readSetting(SETTING_KEYS.activeTeamId),
          readSetting(SETTING_KEYS.displayName),
        ])
        if (isStale) {
          return
        }
        setActiveTeamId(storedTeam)
        setStoredDisplayName(storedName ?? '')

        const client = getSupabase()
        if (!client) {
          return
        }
        const signedInAs = await ensureSignedIn(client)
        const memberships = await myTeams(client)
        if (!isStale) {
          setUserId(signedInAs)
          setTeams(memberships)
        }
      } catch (loadError) {
        if (!isStale) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      }
    })()
    return () => {
      isStale = true
    }
  }, [])

  /** Runs an action with the busy flag and one place to catch. */
  const guard = useCallback(async <TResult>(
    action: () => Promise<TResult>,
    fallback: TResult,
  ): Promise<TResult> => {
    setIsBusy(true)
    setError(null)
    try {
      return await action()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
      return fallback
    } finally {
      setIsBusy(false)
    }
  }, [])

  const sync = useCallback(async (): Promise<void> => {
    const outcome = await guard(async () => runSync(), null)
    if (outcome) {
      setLastOutcome(outcome)
      if (outcome.error !== null) {
        setError(outcome.error)
      }
    }
  }, [guard])

  const setActiveTeam = useCallback(async (teamId: string | null): Promise<void> => {
    await writeSetting(SETTING_KEYS.activeTeamId, teamId)
    setActiveTeamId(teamId)
  }, [])

  const setDisplayName = useCallback(async (name: string): Promise<void> => {
    await writeSetting(SETTING_KEYS.displayName, name)
    setStoredDisplayName(name)
  }, [])

  const createTeam = useCallback(
    async (name: string): Promise<string | null> =>
      guard(async () => {
        const client = getSupabase()
        if (!client) {
          return null
        }
        const created = await createRemoteTeam(client, name, displayName)
        // Selected immediately: someone who just made a team is about to share into it, and a
        // case pushed before the selection lands would go up with no team at all.
        await writeSetting(SETTING_KEYS.activeTeamId, created.teamId)
        setActiveTeamId(created.teamId)
        setTeams(await myTeams(client))
        return created.inviteCode
      }, null),
    [guard, displayName],
  )

  const joinTeam = useCallback(
    async (inviteCode: string): Promise<boolean> =>
      guard(async () => {
        const client = getSupabase()
        if (!client) {
          return false
        }
        const teamId = await joinRemoteTeam(client, inviteCode, displayName)
        await writeSetting(SETTING_KEYS.activeTeamId, teamId)
        setActiveTeamId(teamId)
        setTeams(await myTeams(client))
        return true
      }, false),
    [guard, displayName],
  )

  const rotateInviteCode = useCallback(
    async (teamId: string): Promise<string | null> =>
      guard(async () => {
        const client = getSupabase()
        return client ? await rotateRemoteCode(client, teamId) : null
      }, null),
    [guard],
  )

  const leaveTeam = useCallback(
    async (teamId: string): Promise<void> => {
      await guard(async () => {
        const client = getSupabase()
        if (!client) {
          return
        }
        await leaveRemoteTeam(client, teamId)
        setTeams(await myTeams(client))
        if (activeTeamId === teamId) {
          await writeSetting(SETTING_KEYS.activeTeamId, null)
          setActiveTeamId(null)
        }
      }, undefined)
    },
    [guard, activeTeamId],
  )

  const deleteTeam = useCallback(
    async (teamId: string): Promise<number | null> =>
      guard(async () => {
        const client = getSupabase()
        if (!client) {
          return null
        }
        const detached = await deleteRemoteTeam(client, teamId)
        setTeams(await myTeams(client))
        if (activeTeamId === teamId) {
          await writeSetting(SETTING_KEYS.activeTeamId, null)
          setActiveTeamId(null)
        }
        return detached
      }, null),
    [guard, activeTeamId],
  )

  return {
    isConfigured,
    isBusy,
    userId,
    teams,
    activeTeamId,
    displayName,
    lastOutcome,
    error,
    refresh,
    sync,
    setActiveTeam,
    setDisplayName,
    createTeam,
    joinTeam,
    rotateInviteCode,
    leaveTeam,
    deleteTeam,
  }
}
