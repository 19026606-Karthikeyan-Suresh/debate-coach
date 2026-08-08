/**
 * The report — what the speech was, once it is over.
 *
 * Ordered by what a debater does next, not by what was easiest to compute. The skipped rows come
 * first because they are the only part that sends you back into the case; the numbers come second
 * because they are what you compare next week; the transcript comes last because you only read it
 * when you disbelieve something above it.
 *
 * **Every number says which pass produced it.** The live `base.en` report is on screen within a
 * second of sitting down and the `small.en` one replaces it minutes later, and they do not agree —
 * filler counts especially, since the better model transcribes more of them. A report that quietly
 * changed its numbers under the reader would be worse than one that took longer to appear.
 *
 * Renders a stored report and a live one through the same props, so the Review screen and the
 * Speak screen show the same thing. `onSaveToField` is what differs: only the Speak screen has the
 * case open to write an improvisation back into.
 */

import { formatClock } from '../../case/time.ts'
import type { SpeechReport as Report, SectionReport, SkippedRun } from '../../speech/report.ts'

/** Props for {@link SpeechReport}. */
export interface SpeechReportProps {
  readonly report: Report
  /** True while the accurate pass is still running behind this one. */
  readonly isReviewing: boolean
  /** A caveat to show above the report, or null. */
  readonly error: string | null
  /**
   * Saves an improvised run into a case row, or null where the case is not open for editing.
   *
   * The report never writes to the case on its own — an improvisation is a guess about which row
   * the words belonged to, and a guess does not get to edit a case unasked.
   */
  readonly onSaveToField: ((fieldPath: string, text: string) => void) | null
}

/** One labelled number. `tone` is a colour class, or '' for the default. */
function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: string
}): React.JSX.Element {
  return (
    <div className="panel flex flex-col p-3">
      <span className={`text-xl font-semibold tabular-nums ${tone}`}>{value}</span>
      <span className="text-[0.65rem] tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
        {label}
      </span>
    </div>
  )
}

/**
 * Pace across the speech, as a filled area.
 *
 * Plain SVG with no animation and no transition: this encodes where the speaker was, and the
 * phase 5 note applies — anything needing a painted frame to reach its final state is a bug here.
 */
function PaceChart({ points }: { points: readonly { atSeconds: number; wordsPerMinute: number }[] }): React.JSX.Element {
  const width = 100
  const height = 28
  const fastest = Math.max(...points.map((point) => point.wordsPerMinute), 1)
  const step = points.length > 1 ? width / (points.length - 1) : width

  const line = points
    .map((point, index) => {
      const across = index * step
      const up = height - (point.wordsPerMinute / fastest) * height
      return `${index === 0 ? 'M' : 'L'}${across.toFixed(1)},${up.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      className="h-16 w-full"
      role="img"
      aria-label={`Pace across the speech, peaking at ${String(fastest)} words per minute`}
    >
      <path d={`${line} L${width},${height} L0,${height} Z`} className="fill-neutral-200 dark:fill-neutral-800" />
      <path d={line} fill="none" strokeWidth={1.5} className="stroke-neutral-900 dark:stroke-neutral-100" />
    </svg>
  )
}

/** One skipped run, quoted, with the row it came from. */
function SkippedRunItem({
  run,
}: {
  run: SkippedRun
}): React.JSX.Element {
  return (
    <li className="border-l-2 border-red-400 pl-2.5 dark:border-red-700">
      <p className="text-sm text-neutral-700 line-through decoration-red-500/60 dark:text-neutral-300">
        {run.text}
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {run.wordCount} word{run.wordCount === 1 ? '' : 's'}
        {run.fieldLabel !== null
          ? ` · ${run.fieldLabel}`
          : run.fieldPath !== null
            ? ` · ${run.fieldPath}`
            : ' · the template’s own words, not yours'}
      </p>
    </li>
  )
}

/** How long a section took against what the script said it would. */
function SectionRow({ section }: { section: SectionReport }): React.JSX.Element {
  const overrun =
    section.actualSeconds === null ? null : section.actualSeconds - section.plannedSeconds

  return (
    <li className="panel flex flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{section.heading || 'Opening'}</span>
        <span className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          {section.actualSeconds === null
            ? `planned ${formatClock(section.plannedSeconds)}`
            : `${formatClock(section.actualSeconds)} of ${formatClock(section.plannedSeconds)} planned`}
          {overrun !== null && Math.abs(overrun) >= 5
            ? ` · ${overrun > 0 ? '+' : '−'}${formatClock(Math.abs(overrun))}`
            : ''}
        </span>
      </div>

      {section.skippedWords > 0 ? (
        <ul className="flex flex-col gap-2">
          {section.skippedRuns.map((run) => (
            <SkippedRunItem key={`${run.segmentId}-${String(run.firstIndex)}`} run={run} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Every word said. {section.spokenWords} of {section.scriptWords}.
        </p>
      )}
    </li>
  )
}

/**
 * Renders one delivered speech.
 *
 * @param props - See {@link SpeechReportProps}.
 * @param props.report - The report to show. A live one and a stored one render identically.
 * @param props.isReviewing - Whether a more accurate report is still coming.
 * @param props.error - A caveat to show above everything, or null.
 * @param props.onSaveToField - Writes an improvisation into a case row, or null to hide the offer.
 * @returns The report.
 */
export function SpeechReport({
  report,
  isReviewing,
  error,
  onSaveToField,
}: SpeechReportProps): React.JSX.Element {
  const { metrics } = report
  const skippedSections = report.sections.filter((section) => section.skippedWords > 0)

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{report.motion.trim() || 'Untitled case'}</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {report.roleLabel}
          {report.isReply ? ' · reply' : ''} · {formatClock(metrics.durationSeconds)} ·{' '}
          {report.createdAt.slice(0, 16).replace('T', ' ')}
        </p>
      </header>

      {/* Which pass these numbers came from, always, and never as a footnote. */}
      {isReviewing ? (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          These are the live <code>base.en</code> numbers. Re-transcribing with <code>small.en</code>{' '}
          — the report will change when it lands, and the filler count will change most.
        </p>
      ) : metrics.isAccurate ? null : (
        <p className="rounded-md bg-neutral-100 p-3 text-sm text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
          Built from the live transcript
          {metrics.source === 'web-speech'
            ? ' the browser produced. Nothing was recorded, so there are no timings, no pauses, and no accurate re-pass.'
            : '. There was no recording to re-transcribe, so there are no timings or pauses.'}
        </p>
      )}

      {error !== null ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {error}
        </p>
      ) : null}

      <section className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <Stat label="words/min" value={String(metrics.wordsPerMinute)} tone="" />
        <Stat
          label="skipped"
          value={String(metrics.skippedWords)}
          tone={metrics.skippedWords > 0 ? 'text-red-600 dark:text-red-400' : ''}
        />
        <Stat label="skip rate" value={`${String(Math.round(metrics.skipRate * 100))}%`} tone="" />
        <Stat label="improvised" value={String(metrics.improvisedWords)} tone="" />
        <Stat label="fillers" value={String(metrics.fillerCount)} tone="" />
        <Stat label="pauses" value={String(metrics.pauseCount)} tone="" />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="section-heading">
          Skipped {metrics.skippedWords > 0 ? `— ${String(metrics.skippedWords)} words` : ''}
        </h3>
        {skippedSections.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Nothing was skipped. Every word of the script was said.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {skippedSections.map((section) => (
              <SectionRow key={section.sectionId} section={section} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="section-heading">Time per section</h3>
        <ul className="flex flex-col gap-1.5">
          {report.sections.map((section) => (
            <li key={section.sectionId} className="flex items-baseline justify-between gap-3 text-sm">
              <span>{section.heading || 'Opening'}</span>
              <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
                {section.actualSeconds === null ? '—' : formatClock(section.actualSeconds)}
                <span className="text-neutral-400 dark:text-neutral-500">
                  {' '}
                  / {formatClock(section.plannedSeconds)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {report.pace.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="section-heading">Pace</h3>
          <PaceChart points={report.pace} />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Words per minute, in {String(report.pace.length)} blocks across the speech.
          </p>
        </section>
      ) : null}

      {report.improvisations.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="section-heading">Said, but not in the script</h3>
          <ul className="flex flex-col gap-2">
            {report.improvisations.map((run) => (
              <li
                key={`${String(run.beforeScriptIndex)}-${run.text.slice(0, 12)}`}
                className="panel flex flex-col gap-1.5 p-3"
              >
                <p className="text-sm">{run.text}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                  <span>
                    {run.heading || 'Opening'}
                    {run.atSeconds !== null ? ` · ${formatClock(run.atSeconds)}` : ''}
                  </span>
                  {onSaveToField !== null && run.fieldPath !== null ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        onSaveToField(run.fieldPath ?? '', run.text)
                      }}
                    >
                      Add to {run.fieldLabel ?? run.fieldPath}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.fillerCounts.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="section-heading">Fillers</h3>
          <ul className="flex flex-wrap gap-1.5">
            {report.fillerCounts.map((filler) => (
              <li
                key={filler.phrase}
                className="rounded-md bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-900"
              >
                <span className="font-medium">{filler.phrase}</span>
                <span className="text-neutral-500 dark:text-neutral-400"> ×{filler.count}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            A floor, not a total — whisper writes readable text and drops most of the “um”s it
            hears. Compare this number only against sessions transcribed the same way.
          </p>
        </section>
      ) : null}

      {report.pauses.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="section-heading">Pauses over two seconds</h3>
          <ul className="flex flex-wrap gap-1.5">
            {report.pauses.map((pause) => (
              <li
                key={pause.startSeconds}
                className="rounded-md bg-neutral-100 px-2 py-1 text-xs tabular-nums dark:bg-neutral-900"
              >
                {formatClock(pause.startSeconds)}
                <span className="text-neutral-500 dark:text-neutral-400">
                  {' '}
                  · {(pause.endSeconds - pause.startSeconds).toFixed(1)}s
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="section-heading">What was heard</h3>
        <p className="max-h-64 overflow-y-auto rounded-md bg-neutral-100 p-3 text-xs leading-relaxed text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
          {report.transcript || 'Nothing was transcribed.'}
        </p>
      </section>
    </div>
  )
}
