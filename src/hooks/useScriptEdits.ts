/**
 * The debater's delivery rewrites for one case.
 *
 * Written through to SQLite immediately rather than debounced like the case autosave. A rewrite
 * is one deliberate act ending in a button press, not a stream of keystrokes — the textarea holds
 * the draft, and only committing it reaches this hook. Debouncing here would buy nothing and add
 * a window in which closing the Speak screen loses a line somebody just rewrote.
 */

import { useCallback, useEffect, useState } from 'react'

import { deleteScriptEdit, loadScriptEdits, saveScriptEdit } from '../db/index.ts'
import { clearEdit, setEdit, type ScriptEdits } from '../script/edits.ts'

/** Stored rewrites plus the two ways to change them. */
export interface ScriptEditStore {
  readonly edits: ScriptEdits
  /** True until the first load resolves; the script renders uneditable rather than unedited. */
  readonly isLoading: boolean
  /** The last write that failed, or null. A rewrite that did not save must not look saved. */
  readonly error: string | null
  /**
   * Records a rewrite. Pass `''` to drop the segment from delivery entirely.
   */
  readonly write: (segmentId: string, text: string) => void
  /** Restores the compiled wording for one segment. */
  readonly revert: (segmentId: string) => void
}

/**
 * Loads and stores the rewrites for one case.
 *
 * @param caseId - Case being delivered. Changing it reloads; edits are per case, and showing one
 *   case's rewrites over another's script would silently rewrite the wrong speech.
 * @returns See {@link ScriptEditStore}.
 */
export function useScriptEdits(caseId: string): ScriptEditStore {
  const [edits, setEdits] = useState<ScriptEdits>({})
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Blanked during render on a case switch, for the reason `useCaseStore` blanks the document:
  // an effect would paint one frame of the previous case's rewrites over this case's script.
  const [loadedCaseId, setLoadedCaseId] = useState(caseId)
  if (loadedCaseId !== caseId) {
    setLoadedCaseId(caseId)
    setEdits({})
    setIsLoading(true)
    setError(null)
  }

  useEffect(() => {
    let isStale = false
    loadScriptEdits(caseId)
      .then((stored) => {
        if (!isStale) {
          setEdits(stored)
          setIsLoading(false)
        }
      })
      .catch((loadError: unknown) => {
        if (!isStale) {
          // Reported rather than swallowed: an empty record and a failed read look identical on
          // screen, and one of them means the rewrites are still there and simply not shown.
          setError(loadError instanceof Error ? loadError.message : String(loadError))
          setIsLoading(false)
        }
      })
    return () => {
      isStale = true
    }
  }, [caseId])

  const write = useCallback(
    (segmentId: string, text: string): void => {
      // State first, disk second: the editor is a text box and must not wait on SQLite between
      // a click and the line changing. A failed write surfaces in `error` rather than reverting
      // what is on screen, because silently undoing somebody's rewrite is the worse failure.
      setEdits((current) => setEdit(current, segmentId, text))
      setError(null)
      saveScriptEdit(caseId, segmentId, text).catch((writeError: unknown) => {
        setError(writeError instanceof Error ? writeError.message : String(writeError))
      })
    },
    [caseId],
  )

  const revert = useCallback(
    (segmentId: string): void => {
      setEdits((current) => clearEdit(current, segmentId))
      setError(null)
      deleteScriptEdit(caseId, segmentId).catch((writeError: unknown) => {
        setError(writeError instanceof Error ? writeError.message : String(writeError))
      })
    },
    [caseId],
  )

  return { edits, isLoading, error, write, revert }
}
