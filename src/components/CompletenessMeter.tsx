/**
 * How much of this seat's case is filled in.
 */

import type { CaseCompleteness } from '../case/completeness.ts'

/** Props for {@link CompletenessMeter}. */
export interface CompletenessMeterProps {
  readonly completeness: CaseCompleteness
}

/**
 * Renders the overall fill bar and count.
 *
 * Shows raw counts alongside the percentage because "23 of 41" tells a debater how much
 * typing is left, which a percentage does not.
 *
 * @param props - See {@link CompletenessMeterProps}.
 * @param props.completeness - Measurement for the seat currently being prepped.
 * @returns The meter.
 */
export function CompletenessMeter({ completeness }: CompletenessMeterProps): React.JSX.Element {
  const percent = Math.round(completeness.ratio * 100)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="section-heading">Filled</span>
        <span className="text-sm tabular-nums text-neutral-600 dark:text-neutral-300">
          {completeness.filled} / {completeness.total}
        </span>
      </div>
      <div
        className="meter-track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Case completeness"
      >
        <div
          className="h-full rounded-full bg-neutral-900 transition-[width] dark:bg-neutral-100"
          style={{ width: `${String(percent)}%` }}
        />
      </div>
    </div>
  )
}
