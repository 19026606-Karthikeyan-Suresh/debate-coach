/**
 * The speech clock, running.
 *
 * Same shape as `usePrepTimer` and for the same reason: elapsed time is measured against a
 * wall-clock start rather than accumulated a tick at a time, because a throttled interval in a
 * background window would otherwise quietly report a shorter speech than the one being given.
 * Here it matters more — a prep timer that drifts costs a minute of writing, a speech timer that
 * drifts means being called on time thirty seconds after you thought you had.
 *
 * The knocks come out of `signalsBetween`, which is edge-triggered, so the interval's job is
 * only to say where the clock has got to. Which signals that crossed is `timer.ts`'s decision.
 */

import { useCallback, useEffect, useState } from 'react'

import type { SpeechClock, SpeechLimits, SpeechSignal } from '../speech/timer.ts'
import { readSpeechClock, signalsBetween } from '../speech/timer.ts'

/** Refresh rate. Sub-second so the seconds digit never visibly skips one. */
const TICK_MS = 200

/** A running speech clock. */
export interface SpeechTimer {
  readonly clock: SpeechClock
  readonly isRunning: boolean
  /**
   * The most recent knock, warning or call, or null before the first.
   *
   * Kept after it fires rather than cleared, because the banner it drives should stay up: a
   * speaker who glanced away at 6:00 still needs to know points have closed.
   */
  readonly lastSignal: SpeechSignal | null
  /** Starts from zero. No-op while already running. */
  readonly start: () => void
  /** Freezes the clock where it is. The elapsed time stays readable for the report. */
  readonly stop: () => void
  /** Back to zero, stopped, with no signal showing. */
  readonly reset: () => void
}

/**
 * Runs the speech clock.
 *
 * @param limits - The speech being given. **Must be referentially stable** — memoize it in the
 *   caller. A new object every render restarts the interval, which does not lose time but does
 *   reset the edge detection, and a knock crossed in the same frame would be missed.
 * @returns The clock and its controls.
 */
export function useSpeechTimer(limits: SpeechLimits): SpeechTimer {
  // Epoch milliseconds the speech started at, or null when stopped.
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [lastSignal, setLastSignal] = useState<SpeechSignal | null>(null)

  // The previous reading lives in the effect's own closure rather than in a ref: the interval is
  // the only thing that reads or writes it, it is not render state, and a ref would be one more
  // thing to keep in step with a restart.
  useEffect(() => {
    if (startedAt === null) {
      return
    }

    let previousElapsed = (Date.now() - startedAt) / 1000
    const handle = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000
      const crossed = signalsBetween(previousElapsed, elapsed, limits)
      previousElapsed = elapsed

      setElapsedSeconds(elapsed)
      const latest = crossed.at(-1)
      if (latest) {
        setLastSignal(latest)
      }
    }, TICK_MS)

    return () => {
      window.clearInterval(handle)
    }
  }, [startedAt, limits])

  const start = useCallback((): void => {
    setStartedAt((current) => current ?? Date.now())
  }, [])

  const stop = useCallback((): void => {
    setStartedAt(null)
  }, [])

  const reset = useCallback((): void => {
    setStartedAt(null)
    setElapsedSeconds(0)
    setLastSignal(null)
  }, [])

  return {
    clock: readSpeechClock(elapsedSeconds, limits),
    isRunning: startedAt !== null,
    lastSignal,
    start,
    stop,
    reset,
  }
}
