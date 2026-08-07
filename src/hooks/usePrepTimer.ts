/**
 * Countdown for the prep window — 15 minutes in BP, 30 in AP.
 *
 * Counts against a wall-clock deadline rather than by decrementing on each tick. Interval
 * callbacks in a background window are throttled hard, and a decrementing timer would quietly
 * report more prep time left than the room actually has.
 *
 * The deadline is state rather than a ref, so the remaining time is derived during render
 * instead of being written by the interval. The interval's only job is to move `now` forward.
 */

import { useCallback, useEffect, useState } from 'react'

/** How often the display refreshes. Sub-second so the seconds digit never visibly skips. */
const TICK_MS = 250

/** A running prep countdown. */
export interface PrepTimer {
  /** Whole seconds left. Floors at zero — overrun is not shown as a negative clock. */
  readonly remainingSeconds: number
  readonly isRunning: boolean
  /** True once the countdown has reached zero. Stays true until `reset`. */
  readonly hasExpired: boolean
  /** Starts, or resumes from where a pause left it. No-op while running or expired. */
  readonly start: () => void
  /** Freezes the clock. No-op while already paused. */
  readonly pause: () => void
  /** Stops and returns to the format's full prep time. */
  readonly reset: () => void
}

/**
 * Runs the prep countdown.
 *
 * @param prepSeconds - The format's prep window. Changing it — because the case was switched
 *   from BP to AP — resets the clock rather than rescaling it, since the two are different
 *   rounds, not the same round measured differently.
 * @returns The timer state and its controls.
 */
export function usePrepTimer(prepSeconds: number): PrepTimer {
  // Seconds left as of the last pause. While the clock runs, `deadline` is authoritative and
  // this holds the value the run started from.
  const [pausedSeconds, setPausedSeconds] = useState(prepSeconds)
  // Epoch milliseconds the countdown ends at, or null while paused.
  const [deadline, setDeadline] = useState<number | null>(null)
  // Moved forward by the interval; the only thing a tick changes.
  const [now, setNow] = useState(() => Date.now())

  // A changed prep window means a different round, so the clock resets rather than rescaling.
  // Done during render, not in an effect: an effect would show the old format's clock for one
  // frame, and a debater glancing at 30:00 on a 15-minute BP prep is exactly the wrong error.
  const [lastPrepSeconds, setLastPrepSeconds] = useState(prepSeconds)
  if (lastPrepSeconds !== prepSeconds) {
    setLastPrepSeconds(prepSeconds)
    setPausedSeconds(prepSeconds)
    setDeadline(null)
  }

  const remainingSeconds =
    deadline === null ? pausedSeconds : Math.max(0, Math.ceil((deadline - now) / 1000))

  useEffect(() => {
    if (deadline === null) {
      return
    }

    const tick = (): void => {
      const currentNow = Date.now()
      setNow(currentNow)
      // Stop at zero rather than running the interval forever against a deadline in the past.
      if (currentNow >= deadline) {
        setPausedSeconds(0)
        setDeadline(null)
      }
    }

    const handle = window.setInterval(tick, TICK_MS)
    return () => {
      window.clearInterval(handle)
    }
  }, [deadline])

  // These run from click handlers, so they read state straight out of the closure rather than
  // through an updater — an updater that also called `setNow` would be a side effect inside
  // one, which StrictMode runs twice.
  const start = useCallback((): void => {
    if (deadline !== null || pausedSeconds <= 0) {
      return
    }
    const startedAt = Date.now()
    setNow(startedAt)
    setDeadline(startedAt + pausedSeconds * 1000)
  }, [deadline, pausedSeconds])

  const pause = useCallback((): void => {
    if (deadline === null) {
      return
    }
    setPausedSeconds(remainingSeconds)
    setDeadline(null)
  }, [deadline, remainingSeconds])

  const reset = useCallback((): void => {
    setDeadline(null)
    setPausedSeconds(prepSeconds)
  }, [prepSeconds])

  return {
    remainingSeconds,
    isRunning: deadline !== null,
    hasExpired: remainingSeconds === 0,
    start,
    pause,
    reset,
  }
}
