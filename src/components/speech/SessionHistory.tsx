/**
 * The Review screen — every speech given, and whether they are getting better.
 *
 * A single session tells a debater what they skipped. Twenty tell them whether skipping is a habit
 * they are fixing, which is the only question worth a screen of its own. So the trends are the top
 * of this screen and the list is under them.
 *
 * **Live and reviewed numbers are charted separately.** `base.en` and `small.en` do not count
 * fillers the same way, so plotting one against the other draws a trend out of the model rather
 * than the speaker. A session with no accurate re-pass is drawn hollow and left out of the trend.
 */

import { useCallback, useEffect, useState } from 'react'

import { formatClock } from '../../case/time.ts'
import { deleteSession, listSessions, loadSessionReport } from '../../db/index.ts'
import type { SessionSummary } from '../../db/index.ts'
import type { SpeechReport as Report } from '../../speech/report.ts'
import { SpeechReport } from './SpeechReport.tsx'

/** Props for {@link SessionHistory}. */
export interface SessionHistoryProps {
  /** Back to the library. */
  readonly onClose: () => void
}

/** One number tracked across sessions, and how to read it off a session. */
interface Trend {
  readonly id: string
  readonly label: string
  /** Pulls the number out of a session's metrics. */
  readonly read: (session: SessionSummary) => number
  /** Formats one value for the axis labels. */
  readonly format: (value: number) => string
  /**
   * Which direction is an improvement, or null when neither is.
   *
   * Null is not a cop-out for pace: 200 words a minute is a debater the judge has stopped
   * following and 120 is one who will not finish, so colouring an increase green would be
   * advice, and wrong advice. The number is shown and the reader decides.
   */
  readonly betterWhen: 'lower' | 'higher' | null
}

const TRENDS: readonly Trend[] = [
  {
    id: 'skipRate',
    label: 'skip rate',
    read: (session) => Math.round(session.metrics.skipRate * 100),
    format: (value) => `${String(value)}%`,
    betterWhen: 'lower',
  },
  {
    id: 'fillers',
    label: 'fillers / min',
    read: (session) => session.metrics.fillersPerMinute,
    format: (value) => value.toFixed(1),
    betterWhen: 'lower',
  },
  {
    id: 'pace',
    label: 'words / min',
    read: (session) => session.metrics.wordsPerMinute,
    format: (value) => String(value),
    betterWhen: null,
  },
]

/**
 * A trend line over the comparable sessions.
 *
 * Points are oldest-first left to right, which is the opposite of the list below it — a chart that
 * ran newest-first would read as improvement when it was decline.
 */
function TrendChart({
  trend,
  values,
}: {
  trend: Trend
  values: readonly number[]
}): React.JSX.Element {
  const width = 100
  const height = 24
  const highest = Math.max(...values, 1)
  const step = values.length > 1 ? width / (values.length - 1) : width

  const line = values
    .map((value, index) => {
      const across = index * step
      const up = height - (value / highest) * height
      return `${index === 0 ? 'M' : 'L'}${across.toFixed(1)},${up.toFixed(1)}`
    })
    .join(' ')

  const latest = values.at(-1) ?? 0
  const previous = values.at(-2) ?? latest
  const isBetter = trend.betterWhen === 'lower' ? latest < previous : latest > previous

  // Grey when neither direction is an improvement, so the colour never states an opinion the
  // number does not support.
  const deltaTone =
    trend.betterWhen === null
      ? 'text-neutral-500 dark:text-neutral-400'
      : isBetter
        ? 'text-green-700 dark:text-green-400'
        : 'text-red-700 dark:text-red-400'

  return (
    <div className="panel flex flex-col gap-1 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-lg font-semibold tabular-nums">{trend.format(latest)}</span>
        {values.length > 1 && latest !== previous ? (
          <span className={`text-xs tabular-nums ${deltaTone}`}>
            {latest > previous ? '↑' : '↓'} {trend.format(Math.abs(latest - previous))}
          </span>
        ) : null}
      </div>
      <span className="text-[0.65rem] tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
        {trend.label}
      </span>
      {values.length > 1 ? (
        <svg
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          preserveAspectRatio="none"
          className="mt-1 h-10 w-full"
          role="img"
          aria-label={`${trend.label} across ${String(values.length)} sessions`}
        >
          <path
            d={line}
            fill="none"
            strokeWidth={1.5}
            className="stroke-neutral-900 dark:stroke-neutral-100"
          />
        </svg>
      ) : null}
    </div>
  )
}

/** Props for {@link SessionTrends}. */
export interface SessionTrendsProps {
  /** Sessions newest-first, as `listSessions` returns them. */
  readonly sessions: readonly SessionSummary[]
}

/**
 * The trend row across every comparable session.
 *
 * Split out of {@link SessionHistory} because it is the only part of this screen that is a pure
 * function of its data — the rest is a database query and a couple of buttons — which is what
 * makes it drivable without the Tauri shell around it.
 *
 * @param props - See {@link SessionTrendsProps}.
 * @param props.sessions - Sessions newest-first. Reversed here so the charts read left to right
 *   in time; charting them newest-first would show a decline as an improvement.
 * @returns The trends, or nothing when no session has been through the accurate pass.
 */
export function SessionTrends({ sessions }: SessionTrendsProps): React.JSX.Element | null {
  // Only the reviewed sessions are comparable with each other; see the note at the top.
  const comparable = [...sessions].reverse().filter((session) => session.metrics.isAccurate)
  if (comparable.length === 0) {
    return null
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="section-heading">
        Across {comparable.length} reviewed session{comparable.length === 1 ? '' : 's'}
      </h2>
      <div className="grid grid-cols-3 gap-2">
        {TRENDS.map((trend) => (
          <TrendChart key={trend.id} trend={trend} values={comparable.map(trend.read)} />
        ))}
      </div>
    </section>
  )
}

/**
 * Lists every speech given, with the trends across them.
 *
 * @param props - See {@link SessionHistoryProps}.
 * @param props.onClose - Returns to the library.
 * @returns The Review screen.
 */
export function SessionHistory({ onClose }: SessionHistoryProps): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [openReport, setOpenReport] = useState<Report | null>(null)

  useEffect(() => {
    let isStale = false
    listSessions()
      .then((rows) => {
        if (!isStale) {
          setSessions(rows)
          setError(null)
        }
      })
      .catch((listError: unknown) => {
        if (!isStale) {
          setError(listError instanceof Error ? listError.message : String(listError))
        }
      })
    return () => {
      isStale = true
    }
  }, [])

  const handleOpen = useCallback(async (sessionId: string): Promise<void> => {
    try {
      const stored = await loadSessionReport(sessionId)
      setOpenReport(stored)
      setError(stored ? null : 'That session has no report stored, or one this version cannot read.')
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError))
    }
  }, [])

  const handleDelete = useCallback(async (sessionId: string): Promise<void> => {
    try {
      await deleteSession(sessionId)
      setSessions(await listSessions())
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError))
    }
  }, [])

  if (openReport) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <div className="p-4 pb-0">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setOpenReport(null)
            }}
          >
            ← Sessions
          </button>
        </div>
        <SpeechReport report={openReport} isReviewing={false} error={null} onSaveToField={null} />
      </div>
    )
  }

  return (
    <main className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto p-8">
      <header className="flex items-center gap-3">
        <button type="button" className="btn" onClick={onClose}>
          ← Library
        </button>
        <h1 className="text-2xl font-semibold">Review</h1>
      </header>

      {error !== null ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <SessionTrends sessions={sessions} />

      <section className="flex flex-col gap-2">
        <h2 className="section-heading">Sessions ({sessions.length})</h2>
        {sessions.length === 0 && error === null ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No speeches yet. Open a case, press Record on the Speak screen, and the report lands
            here when you sit down.
          </p>
        ) : null}
        <ul className="flex flex-col gap-1.5">
          {sessions.map((session) => (
            <li key={session.id} className="panel flex items-center gap-3 p-3">
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium dark:bg-neutral-800">
                {session.format}
              </span>
              <button
                type="button"
                className="flex-1 text-left text-sm hover:underline"
                onClick={() => {
                  void handleOpen(session.id)
                }}
              >
                {session.motion.trim() || 'Case since deleted'}
              </button>
              <span className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                {formatClock(session.durationSeconds)} ·{' '}
                {Math.round(session.metrics.skipRate * 100)}% skipped
                {session.metrics.isAccurate ? '' : ' · live only'}
              </span>
              <span className="text-xs text-neutral-400 dark:text-neutral-500">
                {session.createdAt.slice(0, 16).replace('T', ' ')}
              </span>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  void handleDelete(session.id)
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
