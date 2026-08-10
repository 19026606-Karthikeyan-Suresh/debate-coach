/**
 * Countdown for the prep window — 15 minutes in BP, 30 in AP, or whatever the debater set.
 *
 * Counts against a wall-clock deadline rather than by decrementing on each tick. Interval
 * callbacks in a background window are throttled hard, and a decrementing timer would quietly
 * report more prep time left than the room actually has.
 *
 * The deadline is state rather than a ref, so the remaining time is derived during render
 * instead of being written by the interval. The interval's only job is to move `now` forward.
 *
 * # Changing the length is two different intentions
 *
 * A *format* switch is a different round: the clock resets, because 15 minutes of a BP prep has
 * nothing to do with the 30-minute AP prep it replaced. Editing the *length* mid-round is the
 * opposite — the chair granted five more minutes, or the tournament is running short — and
 * resetting there would throw away the prep already done. So the two are told apart by
 * `roundKey`, and a length change with the same key adjusts the remaining time by the delta.
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
 * @param prepSeconds - The prep window in seconds: the format's default, or the debater's
 *   override. Changing this alone shifts the remaining time by the difference rather than
 *   restarting, because that is what "you have five more minutes" means.
 * @param roundKey - Identifies the round. Changing it resets the clock outright. Pass the format
 *   id; passing a constant would make a BP-to-AP switch silently keep the old clock, and passing
 *   something that changes per render would reset the timer continuously.
 * @returns The timer state and its controls.
 */
export function usePrepTimer(prepSeconds: number, roundKey: string): PrepTimer {
  // Seconds left as of the last pause. While the clock runs, `deadline` is authoritative and
  // this holds the value the run started from.
  const [pausedSeconds, setPausedSeconds] = useState(prepSeconds)
  // Epoch milliseconds the countdown ends at, or null while paused.
  const [deadline, setDeadline] = useState<number | null>(null)
  // Moved forward by the interval; the only thing a tick changes.
  const [now, setNow] = useState(() => Date.now())

  // Both reconciliations run during render, not in an effect: an effect would show the old
  // clock for one frame, and a debater glancing at 30:00 on a 15-minute BP prep is exactly the
  // wrong error to make.
  const [lastRoundKey, setLastRoundKey] = useState(roundKey)
  const [lastPrepSeconds, setLastPrepSeconds] = useState(prepSeconds)

  if (lastRoundKey !== roundKey) {
    // A different round. Everything about the old clock is irrelevant.
    setLastRoundKey(roundKey)
    setLastPrepSeconds(prepSeconds)
    setPausedSeconds(prepSeconds)
    setDeadline(null)
  } else if (lastPrepSeconds !== prepSeconds) {
    // Same round, new length: shift by the difference so prep already spent stays spent.
    // Clamped at zero rather than going negative, because shortening prep below what has
    // already elapsed means prep is over, not that time is owed.
    const delta = (prepSeconds - lastPrepSeconds) * 1000
    setLastPrepSeconds(prepSeconds)
    if (deadline === null) {
      setPausedSeconds((current) => Math.max(0, current + delta / 1000))
    } else {
      setDeadline(Math.max(now, deadline + delta))
    }
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
