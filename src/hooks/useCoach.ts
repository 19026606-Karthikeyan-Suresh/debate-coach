/**
 * Layer B's state: is there a key, is a call in flight, and what came back.
 *
 * One call at a time, deliberately. Three concurrent requests against a 15-minute prep clock is
 * three ways to spend money and one panel to show them in, and the second click is almost always
 * impatience rather than intent — so a run that is already going is left alone rather than being
 * cancelled and restarted.
 *
 * The hook holds no case. Every call takes the case and the seat as arguments, so the callbacks
 * keep a stable identity across the keystroke-by-keystroke rerenders of the Prep screen instead
 * of being rebuilt on each one.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { runAttack, runAudit, runPois } from '../coach/index.ts'
import { clearCoachKey, readCoachStatus, saveCoachKey } from '../coach/index.ts'
import type { CoachOutcome, CoachStatus, CoachTaskId } from '../coach/index.ts'
import type { SpeakerRole } from '../formats/index.ts'
import type { Case } from '../types/case.ts'

/** Where a call has got to. */
export type CoachPhase = 'idle' | 'running' | 'done' | 'error'

/** The current call, or the last one to finish. */
export interface CoachRun {
  readonly phase: CoachPhase
  /** Which task, or null when nothing has been run yet. */
  readonly task: CoachTaskId | null
  /**
   * Substantive the call was *about*, captured when it started, or null for a whole-case task.
   *
   * Not read off the open section when the reply lands: a call takes long enough to read another
   * substantive while it runs, and filing three attacks under whichever row happened to be open
   * when they arrived is a silent, plausible-looking corruption of the case.
   */
  readonly subjectId: string | null
  /** The result, on `done`. */
  readonly outcome: CoachOutcome | null
  /** Why it failed, on `error`. Rust's message, verbatim — each failure calls for a different fix. */
  readonly message: string | null
}

/** Everything the coach panel drives. */
export interface CoachController {
  /** Null until the first status read comes back. */
  readonly status: CoachStatus | null
  readonly run: CoachRun
  /** Scores one substantive. Ignored while another call is in flight. */
  readonly audit: (caseFile: Case, role: SpeakerRole, substantiveId: string) => void
  /** Asks for the opposition's three strongest responses. Ignored while a call is in flight. */
  readonly attack: (caseFile: Case, role: SpeakerRole, substantiveId: string) => void
  /** Asks for likely POIs against the whole case. Ignored while a call is in flight. */
  readonly pois: (caseFile: Case, role: SpeakerRole) => void
  /** Clears the last result so the panel goes back to its buttons. */
  readonly dismiss: () => void
  /** Saves a key and refreshes the status. Rejects with the credential store's message. */
  readonly saveKey: (key: string) => Promise<void>
  /** Deletes the key and refreshes the status. */
  readonly forgetKey: () => Promise<void>
}

/** Nothing has been asked for yet. */
const IDLE: CoachRun = {
  phase: 'idle',
  task: null,
  subjectId: null,
  outcome: null,
  message: null,
}

/**
 * Owns the coach panel's state.
 *
 * @returns The controller. Its callbacks are stable, so passing them into a memoised child does
 *   not defeat the memo.
 */
export function useCoach(): CoachController {
  const [status, setStatus] = useState<CoachStatus | null>(null)
  const [run, setRun] = useState<CoachRun>(IDLE)

  // Distinguishes the reply we are waiting for from one belonging to an abandoned call. Written
  // only from callbacks and effects, never during render.
  const runToken = useRef(0)
  const isMounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await readCoachStatus()
    if (isMounted.current) {
      setStatus(next)
    }
  }, [])

  useEffect(() => {
    isMounted.current = true
    void refresh()
    return () => {
      isMounted.current = false
    }
  }, [refresh])

  // Shared by all three tasks: refuse to start a second call, then resolve whichever way the
  // promise goes into one state update. `setState` in a promise callback is fine — it is only
  // the synchronous effect body that react-hooks forbids.
  const start = useCallback(
    (task: CoachTaskId, subjectId: string | null, call: () => Promise<CoachOutcome>): void => {
      setRun((current) => {
        if (current.phase === 'running') {
          return current
        }
        runToken.current += 1
        const token = runToken.current

        call().then(
          (outcome) => {
            if (isMounted.current && runToken.current === token) {
              setRun({ phase: 'done', task, subjectId, outcome, message: null })
            }
          },
          (error: unknown) => {
            if (isMounted.current && runToken.current === token) {
              setRun({
                phase: 'error',
                task,
                subjectId,
                outcome: null,
                message: messageOf(error),
              })
            }
          },
        )

        return { phase: 'running', task, subjectId, outcome: null, message: null }
      })
    },
    [],
  )

  const audit = useCallback(
    (caseFile: Case, role: SpeakerRole, substantiveId: string): void => {
      start('audit', substantiveId, () => runAudit(caseFile, role, substantiveId))
    },
    [start],
  )

  const attack = useCallback(
    (caseFile: Case, role: SpeakerRole, substantiveId: string): void => {
      start('attack', substantiveId, () => runAttack(caseFile, role, substantiveId))
    },
    [start],
  )

  const pois = useCallback(
    (caseFile: Case, role: SpeakerRole): void => {
      start('poi', null, () => runPois(caseFile, role))
    },
    [start],
  )

  const dismiss = useCallback((): void => {
    setRun(IDLE)
  }, [])

  const saveKey = useCallback(
    async (key: string): Promise<void> => {
      await saveCoachKey(key)
      await refresh()
    },
    [refresh],
  )

  const forgetKey = useCallback(async (): Promise<void> => {
    await clearCoachKey()
    setRun(IDLE)
    await refresh()
  }, [refresh])

  return { status, run, audit, attack, pois, dismiss, saveKey, forgetKey }
}

/**
 * Best available text for a rejected promise.
 *
 * Tauri rejects commands with the plain string the Rust side returned, not with an `Error`, so
 * the string branch is the common one rather than the fallback.
 */
function messageOf(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  return error instanceof Error ? error.message : 'The coach call failed.'
}
