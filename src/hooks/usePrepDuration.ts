/**
 * The prep length in force, and the way to change it.
 *
 * Sits between the format registry (which knows the rule) and `usePrepTimer` (which counts down
 * whatever it is handed). The override is stored per format and per install, so a tournament
 * running short prep is set once rather than on every case.
 *
 * The default is returned immediately and the stored override replaces it when the read
 * resolves. That ordering matters: the alternative is rendering no clock until SQLite answers,
 * and a prep screen that opens with a blank timer looks broken in exactly the seconds somebody
 * is trying to start one.
 */

import { useCallback, useEffect, useState } from 'react'

import { clampPrepMinutes, parsePrepOverride } from '../case/prepDuration.ts'
import { readPrepMinutes, writePrepMinutes } from '../sync/store.ts'

/** The prep length, where it came from, and how to set it. */
export interface PrepDuration {
  /** What the timer should count down. Never null — the format's default stands in. */
  readonly seconds: number
  /** True when this is the debater's own length rather than the format's. */
  readonly isOverridden: boolean
  /** The format's own prep window, for the "back to default" affordance. */
  readonly defaultSeconds: number
  /** Sets a new length in seconds, clamped and persisted. */
  readonly setSeconds: (seconds: number) => void
  /** Forgets the override and goes back to the format's window. */
  readonly clear: () => void
}

/**
 * Resolves the prep length for one format.
 *
 * @param formatId - `AP` or `BP`. Changing it loads that format's own override, because the two
 *   are different rounds with different rules.
 * @param defaultSeconds - The format's prep window, used until an override loads and whenever
 *   there is none.
 * @returns See {@link PrepDuration}.
 */
export function usePrepDuration(formatId: string, defaultSeconds: number): PrepDuration {
  const [override, setOverride] = useState<number | null>(null)

  // Blanked during render on a format switch rather than in an effect, so the AP clock is never
  // painted for one frame with a BP override on it.
  const [loadedFormatId, setLoadedFormatId] = useState(formatId)
  if (loadedFormatId !== formatId) {
    setLoadedFormatId(formatId)
    setOverride(null)
  }

  useEffect(() => {
    let isStale = false
    readPrepMinutes(formatId)
      .then((stored) => {
        if (!isStale) {
          setOverride(parsePrepOverride(stored))
        }
      })
      // A settings read that fails leaves the format default in place, which is the correct
      // clock rather than a degraded one — so there is nothing worth reporting.
      .catch(() => {})
    return () => {
      isStale = true
    }
  }, [formatId])

  const setSeconds = useCallback(
    (seconds: number): void => {
      const minutes = clampPrepMinutes(seconds / 60)
      setOverride(minutes * 60)
      void writePrepMinutes(formatId, minutes).catch(() => {})
    },
    [formatId],
  )

  const clear = useCallback((): void => {
    setOverride(null)
    void writePrepMinutes(formatId, null).catch(() => {})
  }, [formatId])

  return {
    seconds: override ?? defaultSeconds,
    isOverridden: override !== null && override !== defaultSeconds,
    defaultSeconds,
    setSeconds,
    clear,
  }
}
