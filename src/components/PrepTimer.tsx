/**
 * The prep countdown and its pacing nudge.
 */

import { useState } from 'react'

import type { CaseCompleteness } from '../case/completeness.ts'
import { phraseNudge } from '../case/completeness.ts'
import { prepSecondsFromDraft } from '../case/prepDuration.ts'
import { formatClock } from '../case/time.ts'
import type { PrepDuration } from '../hooks/usePrepDuration.ts'
import type { PrepTimer as PrepTimerState } from '../hooks/usePrepTimer.ts'

/** Below this, the clock turns red. One minute is about one substantive's worth of typing. */
const URGENT_SECONDS = 60

/** Props for {@link PrepTimer}. */
export interface PrepTimerProps {
  readonly timer: PrepTimerState
  /** Drives the nudge — the meter already knows what is still blank. */
  readonly completeness: CaseCompleteness
  /** The length in force, and the way to change it. */
  readonly duration: PrepDuration
}

/**
 * The length box.
 *
 * Editable while the clock runs, on purpose: "you have five more minutes" is said *during* prep,
 * and a control that only worked beforehand would be useless exactly when it is needed. The
 * timer shifts the remaining time by the difference rather than restarting.
 */
function LengthField({ duration }: { duration: PrepDuration }): React.JSX.Element {
  const minutes = Math.round(duration.seconds / 60)
  const [draft, setDraft] = useState(String(minutes))

  // The box follows the length when it changes elsewhere — a format switch, or "Default" being
  // pressed. Reset during render via a last-seen value rather than in an effect.
  const [seenMinutes, setSeenMinutes] = useState(minutes)
  if (seenMinutes !== minutes) {
    setSeenMinutes(minutes)
    setDraft(String(minutes))
  }

  /** Commits the draft, or puts the box back if it is not a length. */
  const commit = (): void => {
    const seconds = prepSecondsFromDraft(draft)
    if (seconds === null) {
      setDraft(String(minutes))
      return
    }
    duration.setSeconds(seconds)
  }

  return (
    <div className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
      <label htmlFor="prep-length">Length</label>
      <input
        id="prep-length"
        type="number"
        inputMode="numeric"
        min={1}
        max={180}
        className="field-input mt-0 w-16 py-0.5 text-center"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          }
        }}
      />
      <span>min</span>
      {duration.isOverridden && (
        <button
          type="button"
          className="ml-auto underline underline-offset-2"
          onClick={duration.clear}
        >
          Default ({Math.round(duration.defaultSeconds / 60)})
        </button>
      )}
    </div>
  )
}

/**
 * Renders the countdown, its controls, and the next thing to fill in.
 *
 * @param props - See {@link PrepTimerProps}.
 * @param props.timer - The running countdown.
 * @param props.completeness - Supplies the next gap the nudge names.
 * @param props.duration - The length in force, and the way to change it.
 * @returns The timer panel.
 */
export function PrepTimer({ timer, completeness, duration }: PrepTimerProps): React.JSX.Element {
  const nudge = phraseNudge(completeness, timer.remainingSeconds)
  const isUrgent = timer.remainingSeconds <= URGENT_SECONDS

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="section-heading">Prep</span>
        <span
          className={`text-2xl font-semibold tabular-nums ${
            isUrgent ? 'text-red-600 dark:text-red-400' : ''
          }`}
        >
          {formatClock(timer.remainingSeconds)}
        </span>
      </div>

      <div className="flex gap-1.5">
        <button
          type="button"
          className="btn flex-1"
          onClick={timer.isRunning ? timer.pause : timer.start}
          disabled={timer.hasExpired}
        >
          {timer.isRunning ? 'Pause' : 'Start'}
        </button>
        <button type="button" className="btn" onClick={timer.reset}>
          Reset
        </button>
      </div>

      <LengthField duration={duration} />

      {/* The nudge is the timer's whole reason for existing: a clock alone tells you that
          you are running out, not what to spend the last four minutes on. */}
      {nudge ? (
        <p className="text-xs leading-snug text-neutral-600 dark:text-neutral-300">{nudge}</p>
      ) : (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Nothing blank. Go back and deepen the weakest substantive.
        </p>
      )}
    </div>
  )
}
