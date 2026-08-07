import { useCallback, useEffect, useState } from 'react'

import { FORMATS, type FormatId } from './formats/index.ts'
import { listCases, saveCase, type CaseSummary } from './db/index.ts'
import { createEmptyCase } from './types/createCase.ts'

/**
 * Phase 1 shell.
 *
 * Deliberately not the Case Builder — this screen exists to prove the three things phase 1
 * claims: the window opens, the format registry is populated, and SQLite round-trips a case
 * through the Rust-owned migrations. Phase 2 replaces it with the real Prep screen.
 */
export function App(): React.JSX.Element {
  const [cases, setCases] = useState<CaseSummary[]>([])
  // Null while the first query is in flight; a string once SQLite has actually failed, which
  // in dev almost always means the app is running in a browser tab with no Tauri backend.
  const [databaseError, setDatabaseError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setCases(await listCases())
      setDatabaseError(null)
    } catch (error) {
      setDatabaseError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  // Initial load. State is set from the promise callbacks rather than after an `await` in the
  // effect body, and `isStale` drops a response that lands after unmount.
  useEffect(() => {
    let isStale = false
    listCases()
      .then((rows) => {
        if (!isStale) {
          setCases(rows)
          setDatabaseError(null)
        }
      })
      .catch((error: unknown) => {
        if (!isStale) {
          setDatabaseError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      isStale = true
    }
  }, [])

  const handleCreate = useCallback(
    async (format: FormatId): Promise<void> => {
      const firstRole = FORMATS[format].roles[0]
      if (!firstRole) {
        return
      }
      const draft = createEmptyCase(format, firstRole.side, firstRole.id)
      draft.prep.motion = `Untitled ${format} case`
      try {
        await saveCase(draft)
        await refresh()
      } catch (error) {
        setDatabaseError(error instanceof Error ? error.message : String(error))
      }
    },
    [refresh],
  )

  return (
    <main className="mx-auto flex min-h-full max-w-5xl flex-col gap-8 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Debate Coach</h1>
        <p className="text-sm text-neutral-500">Phase 1 — scaffold, formats, data model.</p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Formats</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.values(FORMATS).map((format) => (
            <article key={format.id} className="rounded-lg border border-neutral-300 p-4">
              <h3 className="font-medium">
                {format.label} <span className="text-neutral-500">({format.id})</span>
              </h3>
              <dl className="mt-2 text-sm text-neutral-600">
                <div className="flex gap-2">
                  <dt>Speech</dt>
                  <dd>{format.speechSeconds / 60} min</dd>
                </div>
                <div className="flex gap-2">
                  <dt>Reply</dt>
                  <dd>{format.replySeconds === null ? 'none' : `${format.replySeconds / 60} min`}</dd>
                </div>
                <div className="flex gap-2">
                  <dt>POIs</dt>
                  <dd>
                    {format.poiWindowSeconds[0] / 60}:00 – {format.poiWindowSeconds[1] / 60}:00
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt>Prep</dt>
                  <dd>{format.prepSeconds / 60} min</dd>
                </div>
              </dl>
              <ul className="mt-3 flex flex-wrap gap-1">
                {format.roles.map((role) => (
                  <li
                    key={role.id}
                    className={`rounded px-2 py-0.5 text-xs ${
                      role.side === 'gov'
                        ? 'bg-blue-100 text-blue-900'
                        : 'bg-orange-100 text-orange-900'
                    }`}
                  >
                    {role.shortLabel}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void handleCreate(format.id)}
                className="mt-4 rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
              >
                New {format.id} case
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Local cases ({cases.length})</h2>
        {databaseError ? (
          <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            SQLite unavailable: {databaseError}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {cases.map((summary) => (
              <li key={summary.id} className="flex gap-3 rounded border border-neutral-200 p-2">
                <span className="font-mono text-xs text-neutral-500">{summary.format}</span>
                <span className="flex-1">{summary.motion}</span>
                <span className="text-neutral-400">{summary.updatedAt.slice(0, 19)}</span>
              </li>
            ))}
            {cases.length === 0 && <li className="text-neutral-500">No cases yet.</li>}
          </ul>
        )}
      </section>
    </main>
  )
}
