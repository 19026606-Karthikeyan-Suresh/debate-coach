/**
 * Loads one case and keeps SQLite behind it.
 *
 * Autosave is debounced rather than per-keystroke: a case is one JSON blob, so every write
 * rewrites the whole document, and doing that on each character during a 15-minute prep is a
 * lot of disk for no benefit. The tradeoff is that the last few hundred milliseconds of typing
 * are unwritten at any moment, which is why the flush on close is not optional.
 *
 * The debounce is the save effect's own cleanup: each new document cancels the timer armed for
 * the previous one, so a burst of typing collapses to a single write with no timer bookkeeping.
 * "Unsaved" is likewise derived — the loaded document not being the last one written — rather
 * than tracked as a flag that could fall out of step with reality.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { getRole } from '../formats/index.ts'
import { loadCase, saveCase } from '../db/index.ts'
import type { Case } from '../types/case.ts'
import { ensureRequiredBlocks } from '../case/update.ts'

/** Milliseconds of quiet before an edit is written. Long enough to coalesce a typed sentence. */
const AUTOSAVE_DELAY_MS = 700

/** What the save indicator shows. Writing in progress is reported as `hasUnsavedChanges`. */
export type SaveStatus = 'loading' | 'ready' | 'error'

/** A loaded case plus the handle for editing it. */
export interface CaseStore {
  /** Null until the first load resolves, and after a load that failed. */
  readonly caseFile: Case | null
  readonly status: SaveStatus
  /** Populated only when `status` is `error`. */
  readonly error: string | null
  /** True while an edit is waiting on the debounce or mid-write. */
  readonly hasUnsavedChanges: boolean
  /**
   * Applies an edit.
   *
   * The mutator runs against the newest document, so it is safe to call from a handler bound
   * in an earlier render. Returning the same object it was given is treated as no edit at all.
   */
  readonly update: (mutate: (current: Case) => Case) => void
}

/**
 * Opens a case for editing.
 *
 * @param caseId - Row to load. Changing it blanks the document and loads the new one, after
 *   flushing any pending write for the old one, so switching cases never drops an edit.
 * @returns The store.
 */
export function useCaseStore(caseId: string): CaseStore {
  const [caseFile, setCaseFile] = useState<Case | null>(null)
  // The document as last written. Identity comparison against `caseFile` is what "saved" means.
  const [lastSaved, setLastSaved] = useState<Case | null>(null)
  const [status, setStatus] = useState<SaveStatus>('loading')
  const [error, setError] = useState<string | null>(null)

  // Switching cases blanks the document during render rather than in an effect. Doing it in an
  // effect would paint one frame of the previous case's text under the new id.
  const [loadedCaseId, setLoadedCaseId] = useState(caseId)
  if (loadedCaseId !== caseId) {
    setLoadedCaseId(caseId)
    setCaseFile(null)
    setLastSaved(null)
    setStatus('loading')
    setError(null)
  }

  const hasUnsavedChanges = caseFile !== null && caseFile !== lastSaved

  const update = useCallback((mutate: (current: Case) => Case): void => {
    setCaseFile((current) => (current ? mutate(current) : current))
  }, [])

  // Load, then seed whatever the seat needs an empty item of — a whip opening a case with no
  // clash should land on one they can type into, not on an empty screen. Seeding happens here
  // rather than in its own effect so the row is read once; the only other place a seat changes
  // is `setSeat`, which seeds for itself.
  //
  // `lastSaved` is set to the document as it came off disk. When seeding changed nothing the
  // two are the same object and no write is scheduled; when it did, they differ and the save
  // effect below persists the seeded blocks.
  //
  // `isStale` drops a response for a case the user already navigated away from.
  useEffect(() => {
    let isStale = false

    loadCase(caseId)
      .then((loaded) => {
        if (isStale) {
          return
        }
        if (!loaded) {
          setError(`No case with id ${caseId}`)
          setStatus('error')
          return
        }
        const role = getRole(loaded.format, loaded.position)
        setCaseFile(role ? ensureRequiredBlocks(loaded, role) : loaded)
        setLastSaved(loaded)
        setError(null)
        setStatus('ready')
      })
      .catch((loadError: unknown) => {
        if (!isStale) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
          setStatus('error')
        }
      })

    return () => {
      isStale = true
    }
  }, [caseId])

  // Debounced write. Re-arming is automatic: a new `caseFile` re-runs this effect, whose
  // cleanup clears the timer the previous document armed.
  useEffect(() => {
    if (caseFile === null || caseFile === lastSaved) {
      return
    }

    const handle = window.setTimeout(() => {
      saveCase(caseFile)
        .then(() => {
          setLastSaved(caseFile)
          setError(null)
          setStatus('ready')
        })
        .catch((saveError: unknown) => {
          setError(saveError instanceof Error ? saveError.message : String(saveError))
          setStatus('error')
        })
    }, AUTOSAVE_DELAY_MS)

    return () => {
      window.clearTimeout(handle)
    }
  }, [caseFile, lastSaved])

  // Mirrors of the two states, so the flush below can read them from a cleanup that must not
  // re-run on every keystroke.
  const latestCaseRef = useRef<Case | null>(null)
  const lastSavedRef = useRef<Case | null>(null)
  useEffect(() => {
    latestCaseRef.current = caseFile
    lastSavedRef.current = lastSaved
  }, [caseFile, lastSaved])

  // Flush on close or on a case switch. Without this the last keystrokes before leaving a case
  // are lost, which is the one kind of data loss a prep tool cannot have. React runs cleanups
  // before the next render's effects, so the mirrors still hold the outgoing case here.
  useEffect(() => {
    return () => {
      const pending = latestCaseRef.current
      if (pending && pending !== lastSavedRef.current) {
        void saveCase(pending)
      }
    }
  }, [caseId])

  return { caseFile, status, error, hasUnsavedChanges, update }
}
