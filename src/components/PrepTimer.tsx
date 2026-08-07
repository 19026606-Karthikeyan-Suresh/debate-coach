/**
 * The prep countdown and its pacing nudge.
 */

import type { CaseCompleteness } from '../case/completeness.ts'
import { phraseNudge } from '../case/completeness.ts'
import { formatClock } from '../case/time.ts'
import type { PrepTimer as PrepTimerState } from '../hooks/usePrepTimer.ts'

/** Below this, the clock turns red. One minute is about one substantive's worth of typing. */
const URGENT_SECONDS = 60

/** Props for {@link PrepTimer}. */
export interface PrepTimerProps {
  readonly timer: PrepTimerState
  /** Drives the nudge — the meter already knows what is still blank. */
  readonly completeness: CaseCompleteness
}

/**
 * Renders the countdown, its controls, and the next thing to fill in.
 *
 * @param props - See {@link PrepTimerProps}.
 * @param props.timer - The running countdown.
 * @param props.completeness - Supplies the next gap the nudge names.
 * @returns The timer panel.
 */
export function PrepTimer({ timer, completeness }: PrepTimerProps): React.JSX.Element {
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
