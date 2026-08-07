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
import { deleteCase, listCases, saveCase, type CaseSummary } from '../db/index.ts'
import { createEmptyCase } from '../types/createCase.ts'

/** Props for {@link Library}. */
export interface LibraryProps {
  /** Opens a case in the editor. */
  readonly onOpen: (caseId: string) => void
}

/**
 * Renders the local case list.
 *
 * @param props - See {@link LibraryProps}.
 * @param props.onOpen - Called with the id of the case to open.
 * @returns The library screen.
 */
export function Library({ onOpen }: LibraryProps): React.JSX.Element {
  const [cases, setCases] = useState<CaseSummary[]>([])
  const [error, setError] = useState<string | null>(null)
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
    <main className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto p-8">
      <header>
        <h1 className="text-2xl font-semibold">Debate Coach</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Cases are stored on this machine. Nothing leaves it yet.
        </p>
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
      </section>

      {error && (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="section-heading">Cases ({cases.length})</h2>
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
    </main>
  )
}
