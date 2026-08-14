/**
 * The case list, and the new-case flow.
 *
 * Local cases only. Phase 9 adds the team library alongside this, searched server-side when
 * online and against the SQLite cache when not — which is why the list is already a summary
 * query rather than a full document read.
 */

import { useCallback, useEffect, useState } from 'react'

import type { FormatId } from '../formats/index.ts'
import { FORMATS, getFormat } from '../formats/index.ts'
import { deleteCase, listCaseIds, listCases, saveCase, type CaseSummary } from '../db/index.ts'
import { importCaseFile } from '../export/index.ts'
import { useSync } from '../hooks/useSync.ts'
import { createEmptyCase } from '../types/createCase.ts'
import { TeamLibrary } from './TeamLibrary.tsx'
import { TeamSetup } from './TeamSetup.tsx'

/** Props for {@link Library}. */
export interface LibraryProps {
  /** Opens a case in the editor. */
  readonly onOpen: (caseId: string) => void
  /** Opens the session history. */
  readonly onReview: () => void
}

/**
 * Renders the local case list.
 *
 * @param props - See {@link LibraryProps}.
 * @param props.onOpen - Called with the id of the case to open.
 * @param props.onReview - Called to open the Review screen.
 * @returns The library screen.
 */
export function Library({ onOpen, onReview }: LibraryProps): React.JSX.Element {
  const [cases, setCases] = useState<CaseSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  // What the last import did. Which of the two outcomes it was is the whole point of saying so:
  // "restored" replaced nothing, "copied" means the original is still in the list above it.
  const [notice, setNotice] = useState<string | null>(null)
  // Held by the screen rather than by the panel, so a sign-in survives the panel re-rendering
  // and the team library can read the same active team the panel is setting.
  const sync = useSync()
  const [newFormat, setNewFormat] = useState<FormatId>('AP')
  const [newRoleId, setNewRoleId] = useState<string>(FORMATS.AP.roles[0]?.id ?? '')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setCases(await listCases())
      setError(null)
    } catch (listError) {
      setError(listError instanceof Error ? listError.message : String(listError))
    }
  }, [])

  // Initial load. Written out rather than calling `refresh` so the state updates sit visibly
  // inside the promise callback; `isStale` drops a response that lands after unmount.
  useEffect(() => {
    let isStale = false
    listCases()
      .then((rows) => {
        if (!isStale) {
          setCases(rows)
          setError(null)
        }
      })
      .catch((listError: unknown) => {
        if (!isStale) {
          setError(listError instanceof Error ? listError.message : String(listError))
        }
      })
    return () => {
      isStale = true
    }
  }, [])

  const handleCreate = useCallback(async (): Promise<void> => {
    const role = getFormat(newFormat).roles.find((option) => option.id === newRoleId)
    if (!role) {
      return
    }
    try {
      const draft = createEmptyCase(newFormat, role.side, role.id)
      await saveCase(draft)
      onOpen(draft.id)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
    }
  }, [newFormat, newRoleId, onOpen])

  const handleImport = useCallback(async (): Promise<void> => {
    setError(null)
    setNotice(null)
    try {
      // Every id, not the paginated list — see `listCaseIds` for why that distinction matters.
      const imported = await importCaseFile(await listCaseIds())
      if (!imported) {
        return
      }
      await saveCase(imported.caseFile)
      await refresh()
      setNotice(
        imported.outcome === 'restored'
          ? 'Case restored from file.'
          : 'That case is already here, so it was imported as a copy.',
      )
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError))
    }
  }, [refresh])

  const handleDelete = useCallback(
    async (caseId: string): Promise<void> => {
      try {
        await deleteCase(caseId)
        await refresh()
      } catch (removeError) {
        setError(removeError instanceof Error ? removeError.message : String(removeError))
      }
    },
    [refresh],
  )

  return (
    <main className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto overscroll-contain p-4 sm:p-8">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Debate Coach</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {/* Was "nothing leaves it yet" until phase 9, and saying that once it is no longer
                true is worse than saying nothing. */}
            {sync.activeTeamId === null
              ? 'Cases are stored on this machine. Nothing leaves it.'
              : 'Stored on this machine, and shared with your team when you mark a case shared.'}
          </p>
        </div>
        <button type="button" className="btn" onClick={onReview}>
          Review speeches
        </button>
      </header>

      <section className="panel flex flex-wrap items-end gap-2 p-4">
        <label className="flex flex-col gap-1 text-sm">
          Format
          <select
            className="field-input mt-0"
            value={newFormat}
            onChange={(event) => {
              const chosen = event.target.value as FormatId
              setNewFormat(chosen)
              // The old role id belongs to the other format and would resolve to nothing.
              setNewRoleId(getFormat(chosen).roles[0]?.id ?? '')
            }}
          >
            {Object.values(FORMATS).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Position
          <select
            className="field-input mt-0"
            value={newRoleId}
            onChange={(event) => {
              setNewRoleId(event.target.value)
            }}
          >
            {getFormat(newFormat).roles.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            void handleCreate()
          }}
        >
          New case
        </button>

        <button
          type="button"
          className="btn"
          onClick={() => {
            void handleImport()
          }}
        >
          Import .dbcase
        </button>
      </section>

      {notice && (
        <p className="text-sm text-neutral-600 dark:text-neutral-300">{notice}</p>
      )}

      {error && (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <TeamSetup sync={sync} />

      <section className="flex flex-col gap-2">
        <h2 className="section-heading">My cases ({cases.length})</h2>
        {cases.length === 0 && !error && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No cases yet. Make one above.
          </p>
        )}
        <ul className="flex flex-col gap-1.5">
          {cases.map((summary) => (
            <li key={summary.id} className="panel flex items-center gap-3 p-3">
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                  summary.side === 'gov'
                    ? 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200'
                    : 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200'
                }`}
              >
                {summary.format}
              </span>
              <button
                type="button"
                className="flex-1 text-left text-sm hover:underline"
                onClick={() => {
                  onOpen(summary.id)
                }}
              >
                {summary.motion.trim() || 'Untitled case'}
              </button>
              <span className="text-xs text-neutral-400 dark:text-neutral-500">
                {summary.updatedAt.slice(0, 16).replace('T', ' ')}
              </span>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  void handleDelete(summary.id)
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>

      {sync.activeTeamId !== null && (
        <TeamLibrary
          teamId={sync.activeTeamId}
          userId={sync.userId}
          onOpen={onOpen}
          onImported={() => {
            void refresh()
          }}
        />
      )}
    </main>
  )
}
