/**
 * The team panel: sign-in status, which team is active, and the invite code.
 *
 * Three states worth distinguishing and the panel shows all three, because they call for
 * different things: no project configured in this build, a project but no team joined, and a
 * team. The first is not a failure — it is what a clone without an `.env` looks like, and
 * saying "sync failed" about it would send someone looking for a network problem.
 */

import { useCallback, useState } from 'react'

import type { SyncState } from '../hooks/useSync.ts'

/** Props for {@link TeamSetup}. */
export interface TeamSetupProps {
  readonly sync: SyncState
}

/** Reports what the last drain did, in the terms the debater cares about. */
function SyncSummary({ sync }: { sync: SyncState }): React.JSX.Element {
  const outcome = sync.lastOutcome
  if (!outcome || outcome.isDisabled) {
    return <span className="text-neutral-500 dark:text-neutral-400">Not synced yet.</span>
  }

  const parts: string[] = []
  if (outcome.pushed > 0) {
    parts.push(`${String(outcome.pushed)} uploaded`)
  }
  if (outcome.failed > 0) {
    parts.push(`${String(outcome.failed)} failed`)
  }
  if (outcome.waiting > 0) {
    parts.push(`${String(outcome.waiting)} retrying later`)
  }
  // Counted separately from `failed`, and phrased differently, because retrying will not fix it.
  if (outcome.givenUp > 0) {
    parts.push(`${String(outcome.givenUp)} stuck`)
  }

  return (
    <span
      className={
        outcome.givenUp > 0
          ? 'text-red-700 dark:text-red-400'
          : 'text-neutral-500 dark:text-neutral-400'
      }
    >
      {parts.length > 0 ? parts.join(' · ') : 'Everything is up to date.'}
    </span>
  )
}

/**
 * Renders the team controls.
 *
 * @param props - See {@link TeamSetupProps}.
 * @param props.sync - State from `useSync`, owned by the screen so it survives this panel
 *   re-rendering.
 * @returns The panel.
 */
export function TeamSetup({ sync }: TeamSetupProps): React.JSX.Element {
  const [inviteCode, setInviteCode] = useState('')
  const [teamName, setTeamName] = useState('')
  // A code returned by create or rotate. Held here because it is shown once and cannot be read
  // back — no client is granted the column it was hashed into.
  const [issuedCode, setIssuedCode] = useState<string | null>(null)

  const activeTeam = sync.teams.find((team) => team.teamId === sync.activeTeamId) ?? null

  const handleJoin = useCallback(async (): Promise<void> => {
    if (await sync.joinTeam(inviteCode)) {
      setInviteCode('')
    }
  }, [sync, inviteCode])

  const handleCreate = useCallback(async (): Promise<void> => {
    const code = await sync.createTeam(teamName)
    if (code !== null) {
      setIssuedCode(code)
      setTeamName('')
    }
  }, [sync, teamName])

  if (!sync.isConfigured) {
    return (
      <section className="panel flex flex-col gap-1 p-4">
        <h2 className="section-heading">Team</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          This build has no Supabase project, so cases stay on this machine. Everything else works
          exactly the same. Add <code>VITE_SUPABASE_URL</code> and{' '}
          <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env</code> and rebuild to turn the team
          layer on.
        </p>
      </section>
    )
  }

  return (
    <section className="panel flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="section-heading">Team</h2>
        <button
          type="button"
          className="btn"
          disabled={sync.isBusy}
          onClick={() => {
            void sync.sync()
          }}
        >
          {sync.isBusy ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      <p className="text-xs">
        <SyncSummary sync={sync} />
      </p>

      <label className="flex flex-col gap-1 text-sm">
        Your name in the squad
        <input
          className="field-input mt-0"
          value={sync.displayName}
          placeholder="How teammates see you"
          onChange={(event) => {
            void sync.setDisplayName(event.target.value)
          }}
        />
      </label>

      {sync.teams.length > 0 && (
        <label className="flex flex-col gap-1 text-sm">
          Active team
          <select
            className="field-input mt-0"
            value={sync.activeTeamId ?? ''}
            onChange={(event) => {
              void sync.setActiveTeam(event.target.value === '' ? null : event.target.value)
            }}
          >
            <option value="">None — keep everything private</option>
            {sync.teams.map((team) => (
              <option key={team.teamId} value={team.teamId}>
                {team.name} ({team.role})
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Join with an invite code
          <input
            className="field-input mt-0"
            value={inviteCode}
            placeholder="ABCD-EFGH"
            onChange={(event) => {
              setInviteCode(event.target.value)
            }}
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={sync.isBusy || inviteCode.trim().length === 0}
          onClick={() => {
            void handleJoin()
          }}
        >
          Join
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Or start a new team
          <input
            className="field-input mt-0"
            value={teamName}
            placeholder="Northside"
            onChange={(event) => {
              setTeamName(event.target.value)
            }}
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={sync.isBusy || teamName.trim().length === 0}
          onClick={() => {
            void handleCreate()
          }}
        >
          Create
        </button>
      </div>

      {activeTeam && activeTeam.role === 'admin' && (
        <button
          type="button"
          className="btn self-start"
          disabled={sync.isBusy}
          onClick={() => {
            void sync.rotateInviteCode(activeTeam.teamId).then((code) => {
              if (code !== null) {
                setIssuedCode(code)
              }
            })
          }}
        >
          New invite code for {activeTeam.name}
        </button>
      )}

      {issuedCode !== null && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p className="font-medium">Invite code: {issuedCode}</p>
          <p className="mt-1 text-xs">
            Write this down now. Only a hash of it is stored and no one can read it back — if it
            is lost, or it ends up somewhere it should not, issue a new one and the old stops
            working.
          </p>
          <button
            type="button"
            className="btn mt-2"
            onClick={() => {
              setIssuedCode(null)
            }}
          >
            Got it
          </button>
        </div>
      )}

      {activeTeam && (
        <button
          type="button"
          className="btn btn-danger self-start"
          disabled={sync.isBusy}
          onClick={() => {
            void sync.leaveTeam(activeTeam.teamId)
          }}
        >
          Leave {activeTeam.name}
        </button>
      )}

      {sync.error !== null && (
        <p className="text-sm text-red-700 dark:text-red-400">{sync.error}</p>
      )}
    </section>
  )
}
