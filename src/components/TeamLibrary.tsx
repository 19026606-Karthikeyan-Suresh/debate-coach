/**
 * The squad's shared cases — browse, search, take a copy.
 *
 * Importing rather than opening is the whole design: `cases_update` grants the owner and nobody
 * else, so a teammate's case arrives here as a copy with a fresh id. That is also how a squad
 * actually uses one — you find last season's prep on this motion and adapt it.
 */

import { useCallback, useEffect, useState } from 'react'

import { browseTeamLibrary, importTeamCase } from '../sync/library.ts'
import type { TeamCaseSummary } from '../sync/rows.ts'
import { findLocalCaseForRoom, writeRoomLink } from '../sync/store.ts'
import { getSupabase } from '../sync/supabase.ts'

/** Props for {@link TeamLibrary}. */
export interface TeamLibraryProps {
  readonly teamId: string
  /** This install's uid, so the debater's own cases are not listed back to them. */
  readonly userId: string | null
  /** Opens a case in the editor, once it has been copied in. */
  readonly onOpen: (caseId: string) => void
  /** Tells the parent to re-list its own cases — the copy has just landed in them. */
  readonly onImported: () => void
}

/**
 * Renders the team library.
 *
 * @param props - See {@link TeamLibraryProps}.
 * @param props.teamId - Team whose shared cases to list.
 * @param props.userId - This install's uid.
 * @param props.onOpen - Called with the new local case id after an import.
 * @param props.onImported - Called after an import so the parent can refresh.
 * @returns The section.
 */
export function TeamLibrary({
  teamId,
  userId,
  onOpen,
  onImported,
}: TeamLibraryProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<readonly TeamCaseSummary[]>([])
  const [isLive, setIsLive] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  // Re-runs on every keystroke of the query, debounced by the effect's own cleanup rather than
  // by a timer in a ref — `react-hooks` v7 forbids touching a ref during render, and the
  // cleanup already runs at exactly the right moment.
  useEffect(() => {
    let isStale = false
    const timer = window.setTimeout(() => {
      browseTeamLibrary(getSupabase(), teamId, userId ?? '', query)
        .then((listing) => {
          if (isStale) {
            return
          }
          setEntries(listing.entries)
          setIsLive(listing.isLive)
          setNotice(listing.error)
        })
        // `browseTeamLibrary` catches its own network failure and falls back to the cache, so
        // reaching here means the *cache* read failed — SQLite unopenable. Without this the
        // section renders empty and blames the team for having shared nothing.
        .catch((cacheError: unknown) => {
          if (!isStale) {
            setNotice(cacheError instanceof Error ? cacheError.message : String(cacheError))
          }
        })
    }, 300)
    return () => {
      isStale = true
      window.clearTimeout(timer)
    }
  }, [teamId, userId, query])

  /**
   * Copies a teammate's case in, and optionally links the copy to their co-prep room.
   *
   * The copy is the same one "Copy to mine" makes — a fresh id, because `cases_update` grants the
   * owner alone and four people cannot share one row. What co-prep adds is a note of *whose* room
   * the copy belongs to, so the editor joins theirs rather than opening one of its own that
   * nobody else is in.
   */
  const handleImport = useCallback(
    async (caseId: string, forCoPrep: boolean): Promise<void> => {
      const client = getSupabase()
      if (!client) {
        return
      }
      setIsBusy(true)
      try {
        // A second press must not make a second copy: the debater would then have two
        // half-written local cases and no way to tell which one the room is feeding.
        const existing = forCoPrep ? await findLocalCaseForRoom(caseId) : null
        const localId = existing ?? (await importTeamCase(client, caseId, new Date().toISOString())).id
        if (forCoPrep) {
          await writeRoomLink(localId, caseId)
        }
        onImported()
        onOpen(localId)
      } catch (importError) {
        setNotice(importError instanceof Error ? importError.message : String(importError))
      } finally {
        setIsBusy(false)
      }
    },
    [onOpen, onImported],
  )

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="section-heading">Team library ({entries.length})</h2>
        <span className="text-xs text-neutral-400 dark:text-neutral-500">
          {/* Not decoration: the two searches look for different things, and a cached search
              that finds nothing looks exactly like an empty library. */}
          {isLive ? 'searching every word in the case' : 'offline — searching motions only'}
        </span>
      </div>

      <input
        className="field-input mt-0"
        value={query}
        placeholder="Search the squad's cases"
        onChange={(event) => {
          setQuery(event.target.value)
        }}
      />

      {notice !== null && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{notice}</p>
      )}

      {entries.length === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {query.trim().length > 0
            ? 'Nothing matches that.'
            : 'Nobody has shared a case with this team yet.'}
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <li key={entry.id} className="panel flex items-center gap-3 p-3">
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium dark:bg-neutral-800">
              {entry.format}
            </span>
            <span className="flex-1 text-sm">{entry.motion.trim() || 'Untitled case'}</span>
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              {entry.ownerName || 'a teammate'}
            </span>
            <button
              type="button"
              className="btn"
              disabled={isBusy}
              onClick={() => {
                void handleImport(entry.id, false)
              }}
            >
              Copy to mine
            </button>
            {/* Same copy, plus a link back to the owner's room. Separate buttons because taking
                last season's prep to adapt and sitting down to write this round together are
                different things, and the second one puts your keystrokes on somebody's screen. */}
            <button
              type="button"
              className="btn"
              disabled={isBusy}
              onClick={() => {
                void handleImport(entry.id, true)
              }}
            >
              Co-prep
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
