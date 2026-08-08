/**
 * The clock, the protected-time bar, and the knock.
 *
 * A debate clock is read peripherally — the speaker is looking at the script, not at this — so
 * the three things it has to say are said with position and colour rather than with words: how
 * far along the bar is, whether the shaded stretch has been reached, and whether the whole panel
 * has gone red.
 */

import { formatClock } from '../../case/time.ts'
import type { SpeechClock, SpeechSignal } from '../../speech/timer.ts'

/** Props for {@link SpeechTimer}. */
export interface SpeechTimerProps {
  readonly clock: SpeechClock
  /** The last knock, warning or call. Stays on screen after it fires. */
  readonly lastSignal: SpeechSignal | null
  readonly isRunning: boolean
}

/** What the phase should read as on screen. */
const PHASE_LABELS: Readonly<Record<SpeechClock['phase'], string>> = {
  'protected-opening': 'Protected — no points yet',
  open: 'Points of information open',
  'protected-closing': 'Protected — points closed',
  overtime: 'Overtime, inside grace',
  finished: 'Past grace',
}

/**
 * Renders the speech clock.
 *
 * @param props - See {@link SpeechTimerProps}.
 * @param props.clock - The current reading.
 * @param props.lastSignal - The most recent knock, or null before the first.
 * @param props.isRunning - Dims the panel when the clock is stopped.
 * @returns The timer panel.
 */
export function SpeechTimer({ clock, lastSignal, isRunning }: SpeechTimerProps): React.JSX.Element {
  const isOvertime = clock.overrunSeconds > 0
  const [poiStart, poiEnd] = clock.poiWindowFraction
  const hasPoiWindow = poiEnd > poiStart

  return (
    <div className={`flex flex-col gap-2 ${isRunning ? '' : 'opacity-60'}`}>
      <div className="flex items-baseline justify-between">
        <span className="section-heading">{isOvertime ? 'Over by' : 'Remaining'}</span>
        <span
          className={`text-4xl font-semibold tabular-nums ${
            isOvertime ? 'text-red-600 dark:text-red-400' : ''
          }`}
        >
          {formatClock(isOvertime ? clock.overrunSeconds : clock.remainingSeconds)}
        </span>
      </div>

      {/* The POI window is shaded rather than marked, because what a speaker needs peripherally
          is "am I inside it", not "when does it start". */}
      <div className="relative h-2.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
        {hasPoiWindow ? (
          <div
            className="absolute inset-y-0 bg-neutral-300 dark:bg-neutral-700"
            style={{
              left: `${String(poiStart * 100)}%`,
              width: `${String((poiEnd - poiStart) * 100)}%`,
            }}
          />
        ) : null}
        <div
          className={`absolute inset-y-0 left-0 ${
            isOvertime ? 'bg-red-500' : clock.isPoiAllowed ? 'bg-gov' : 'bg-neutral-900 dark:bg-neutral-100'
          }`}
          style={{ width: `${String(clock.elapsedFraction * 100)}%` }}
        />
      </div>

      <div className="flex items-baseline justify-between text-xs">
        <span className="text-neutral-500 dark:text-neutral-400">{PHASE_LABELS[clock.phase]}</span>
        <span className="tabular-nums text-neutral-400 dark:text-neutral-500">
          {formatClock(clock.elapsedSeconds)}
        </span>
      </div>

      {lastSignal ? (
        <p
          className={`rounded-md px-2 py-1 text-sm font-medium ${
            lastSignal.kind === 'time' || lastSignal.kind === 'grace-over'
              ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
              : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200'
          }`}
        >
          {lastSignal.label} — {formatClock(lastSignal.atSeconds)}
        </p>
      ) : null}
    </div>
  )
}
