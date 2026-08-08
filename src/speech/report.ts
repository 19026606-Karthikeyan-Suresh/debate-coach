/**
 * What the speech was, once it is over.
 *
 * The report is the payoff for every provenance decision made upstream. `ScriptToken.fieldPath`
 * has been carried through the compiler, the edit layer and the aligner for exactly this moment:
 * a skipped word here is not "word 412 of the speech", it is "the second half of your Sub 2
 * mechanism row, which you have now failed to say out loud twice". That is a note a debater can
 * act on in prep; a word index is not.
 *
 * **Skips are grouped into runs, and a run never crosses a field.** Sixteen consecutive red words
 * are one dropped clause, not sixteen problems, and the report says so. But two adjacent clauses
 * from different rows stay separate however contiguous they were in the script, because the whole
 * point is which row to go and fix.
 *
 * **Nothing here decides what happened.** `align.ts` classified the tokens, `metrics.ts` put a
 * clock on them, `fillers.ts` found the filler; this module groups, attributes and totals. It is
 * pure, and it produces one plain object that serialises straight into `sessions.report`.
 */

import type { FormatId } from '../formats/index.ts'
import type { CompiledScript, ScriptSegment, ScriptToken } from '../script/types.ts'
import { estimateSeconds } from '../script/types.ts'
import type { AlignmentState } from './align.ts'
import { skipRate } from './align.ts'
import type { FillerKind } from './fillers.ts'
import { countFillers, findFillers } from './fillers.ts'
import type { FillerCount } from './fillers.ts'
import type { Pause, SessionMetrics, SpeechTimeline } from './metrics.ts'
import { secondsAtWord, summariseSession, wordAtOffset } from './metrics.ts'
import type { PacePoint } from './metrics.ts'
import { pacePoints } from './metrics.ts'
import type { TranscriptionSourceId } from './recognition.ts'

/** A run of script words that were not said. */
export interface SkippedRun {
  readonly segmentId: string
  readonly sectionId: string
  /** Section heading, so the run can be shown without a second lookup. */
  readonly heading: string
  /** The case row it came from, or null where it was the template's own prose. */
  readonly fieldPath: string | null
  /**
   * The row's label as the editor shows it, or null.
   *
   * Copied in rather than looked up on read: a report is opened months later, against a case that
   * has been rewritten or deleted, and "the row that used to be at this path" is not a thing that
   * can be resolved then.
   */
  readonly fieldLabel: string | null
  /** The words as written, spacing and punctuation intact. */
  readonly text: string
  readonly wordCount: number
  /** Index of the first script token in the run, for linking back to the teleprompter. */
  readonly firstIndex: number
}

/** A run of words that were said and are not in the script. */
export interface ImprovisedRun {
  readonly text: string
  readonly wordCount: number
  /** Script position it was heard at. */
  readonly beforeScriptIndex: number
  readonly heading: string
  /**
   * The row it would be saved into, or null when there is no sensible one.
   *
   * The token it was heard at, or the nearest one behind it in the same segment that came from a
   * field. A guess, and named as one in the UI — the debater confirms before anything is written
   * back into the case.
   */
  readonly fieldPath: string | null
  /** That row's label as the editor shows it, or null. */
  readonly fieldLabel: string | null
  /** Null when the transcript carries no timings. */
  readonly atSeconds: number | null
}

/** One filler, with a time on it where there is one. */
export interface ReportedFiller {
  readonly phrase: string
  readonly text: string
  readonly kind: FillerKind
  readonly atSeconds: number | null
}

/** How one section of the speech went. */
export interface SectionReport {
  readonly sectionId: string
  readonly heading: string
  readonly scriptWords: number
  readonly spokenWords: number
  readonly skippedWords: number
  /** What the script said this section would take, at `SPEAKING_WORDS_PER_MINUTE`. */
  readonly plannedSeconds: number
  /** What it actually took, or null when untimed or never reached. */
  readonly actualSeconds: number | null
  readonly skippedRuns: readonly SkippedRun[]
}

/**
 * A finished speech, whole.
 *
 * Stored as JSON in `sessions.report` and re-opened from the Review screen, so it is deliberately
 * self-contained: the motion and the role label are copied in rather than joined from the case,
 * because the case will have been edited by the time anybody reads this and the report is a record
 * of the speech that was given, not of the case as it now stands.
 */
export interface SpeechReport {
  /** Shape version, checked on load. */
  readonly version: 1
  readonly sessionId: string
  /** ISO 8601, when the speech ended. */
  readonly createdAt: string
  readonly caseId: string
  readonly motion: string
  readonly format: FormatId
  readonly roleId: string
  readonly roleLabel: string
  readonly isReply: boolean
  /** Everything that was heard. The accurate transcript once the re-pass has landed. */
  readonly transcript: string
  readonly metrics: SessionMetrics
  readonly sections: readonly SectionReport[]
  readonly improvisations: readonly ImprovisedRun[]
  readonly fillers: readonly ReportedFiller[]
  readonly fillerCounts: readonly FillerCount[]
  readonly pauses: readonly Pause[]
  readonly pace: readonly PacePoint[]
}

/** Everything {@link buildSpeechReport} needs. */
export interface SpeechReportInput {
  readonly sessionId: string
  readonly caseId: string
  readonly motion: string
  readonly format: FormatId
  readonly roleId: string
  readonly roleLabel: string
  readonly isReply: boolean
  /** The script as delivered, including any delivery edits. */
  readonly script: CompiledScript
  /**
   * The alignment to report on.
   *
   * Must have been advanced against `timeline.transcript`. Passing an alignment against the live
   * transcript together with the review timeline puts every word at the wrong moment, because a
   * `spokenIndex` only means anything against the transcript it was produced from.
   */
  readonly alignment: AlignmentState
  readonly timeline: SpeechTimeline
  /**
   * Row labels by field path, normally from `flattenFields(buildSections(case, role))`.
   *
   * Optional, and a path missing from it reports a null label rather than failing — a report that
   * cannot name a row is still worth reading, and refusing to build one over a stale registry
   * would lose the speech.
   */
  readonly fieldLabels?: Readonly<Record<string, string>>
  /** From `find_recording_pauses`. Empty where there is no recording to measure. */
  readonly pauses: readonly Pause[]
  /** Length of the speech. The recording's duration where there is one, else the clock's. */
  readonly deliveredSeconds: number
  readonly source: TranscriptionSourceId
  /** True once the `small.en` re-pass has landed. See {@link SessionMetrics.isAccurate}. */
  readonly isAccurate: boolean
  /** Overridable so a test can pin the timestamp. Defaults to now. */
  readonly createdAt?: string
}

/** Segments keyed by id, for looking up the text a token indexes into. */
function segmentsById(script: CompiledScript): ReadonlyMap<string, ScriptSegment> {
  return new Map(script.segments.map((segment) => [segment.id, segment]))
}

/**
 * Finds the field a script position belongs to.
 *
 * Template prose carries no `fieldPath`, so a position landing on it walks back through the same
 * segment to the last word the debater actually typed. It never crosses into the previous
 * segment: that would attribute an improvisation to a row the speaker had already finished with.
 */
function fieldPathNear(script: CompiledScript, index: number): string | null {
  const anchor = script.tokens[index] ?? script.tokens.at(-1)
  if (!anchor) {
    return null
  }
  for (let position = anchor.index; position >= 0; position -= 1) {
    const token = script.tokens[position]
    if (!token || token.segmentId !== anchor.segmentId) {
      return null
    }
    if (token.fieldPath !== null) {
      return token.fieldPath
    }
  }
  return null
}

/** Whether two script tokens belong in the same skipped run. */
function continuesRun(previous: ScriptToken, next: ScriptToken): boolean {
  return (
    next.index === previous.index + 1 &&
    next.segmentId === previous.segmentId &&
    next.fieldPath === previous.fieldPath
  )
}

/**
 * Collects the runs of script words that were never said.
 *
 * Walks the alignment in script order and closes a run whenever the next skipped word is not the
 * immediate continuation of the current one — a different segment, a different row, or a word
 * that was spoken in between.
 */
function collectSkippedRuns(
  script: CompiledScript,
  alignment: AlignmentState,
  segments: ReadonlyMap<string, ScriptSegment>,
  labels: Readonly<Record<string, string>>,
): readonly SkippedRun[] {
  const runs: SkippedRun[] = []
  let current: ScriptToken[] = []

  const flush = (): void => {
    const first = current[0]
    const last = current.at(-1)
    const segment = first ? segments.get(first.segmentId) : undefined
    if (first && last && segment) {
      runs.push({
        segmentId: segment.id,
        sectionId: segment.sectionId,
        heading: segment.heading,
        fieldPath: first.fieldPath,
        fieldLabel: first.fieldPath === null ? null : (labels[first.fieldPath] ?? null),
        text: segment.text.slice(first.start, last.end),
        wordCount: current.length,
        firstIndex: first.index,
      })
    }
    current = []
  }

  for (const aligned of alignment.tokens) {
    const token = script.tokens[aligned.scriptIndex]
    if (!token || aligned.status !== 'skipped') {
      flush()
      continue
    }
    const previous = current.at(-1)
    if (previous && !continuesRun(previous, token)) {
      flush()
    }
    current.push(token)
  }
  flush()

  return runs
}

/**
 * Collects improvisations into the runs they were said in.
 *
 * A run is consecutive transcript words heard at the same script position — one aside, not eleven
 * separate ones. Anything shorter than a run is still reported: a single word inserted mid-clause
 * is usually a filler the aligner could not match, and hiding it would leave the improvised word
 * count unexplained.
 */
function collectImprovisedRuns(
  script: CompiledScript,
  alignment: AlignmentState,
  timeline: SpeechTimeline,
  segments: ReadonlyMap<string, ScriptSegment>,
  labels: Readonly<Record<string, string>>,
): readonly ImprovisedRun[] {
  const runs: ImprovisedRun[] = []
  // Words of the run being built, and the two positions that define it.
  let words: string[] = []
  let firstSpokenIndex = 0
  let beforeScriptIndex = 0

  const flush = (): void => {
    if (words.length === 0) {
      return
    }
    const segment = segments.get(script.tokens[beforeScriptIndex]?.segmentId ?? '')
    const fieldPath = fieldPathNear(script, beforeScriptIndex)
    runs.push({
      text: words.join(' '),
      wordCount: words.length,
      beforeScriptIndex,
      heading: segment?.heading ?? '',
      fieldPath,
      fieldLabel: fieldPath === null ? null : (labels[fieldPath] ?? null),
      atSeconds: secondsAtWord(timeline, firstSpokenIndex),
    })
    words = []
  }

  let previousSpokenIndex = -2
  for (const improvisation of alignment.improvisations) {
    const isContinuation =
      improvisation.spokenIndex === previousSpokenIndex + 1 &&
      improvisation.beforeScriptIndex === beforeScriptIndex
    if (!isContinuation) {
      flush()
      firstSpokenIndex = improvisation.spokenIndex
      beforeScriptIndex = improvisation.beforeScriptIndex
    }
    words.push(improvisation.text)
    previousSpokenIndex = improvisation.spokenIndex
  }
  flush()

  return runs
}

/** Accumulates one section's counts while the segments of it are walked. */
interface SectionTally {
  sectionId: string
  heading: string
  scriptWords: number
  spokenWords: number
  skippedWords: number
  /** Earliest and latest moment a word of this section was said, or null. */
  from: number | null
  to: number | null
}

/**
 * Builds the per-section table: what was planned, what was said, what was dropped.
 *
 * Sections come out in delivery order because the compiler emits segments in it. `actualSeconds`
 * spans the first to the last word actually spoken in the section, so a section the speaker never
 * reached has null rather than zero — those are different facts and the UI shows them differently.
 */
function buildSectionReports(
  script: CompiledScript,
  alignment: AlignmentState,
  timeline: SpeechTimeline,
  runs: readonly SkippedRun[],
): readonly SectionReport[] {
  const tallies = new Map<string, SectionTally>()

  for (const segment of script.segments) {
    const tally = tallies.get(segment.sectionId) ?? {
      sectionId: segment.sectionId,
      heading: segment.heading,
      scriptWords: 0,
      spokenWords: 0,
      skippedWords: 0,
      from: null,
      to: null,
    }
    tallies.set(segment.sectionId, tally)

    for (const token of segment.tokens) {
      tally.scriptWords += 1
      const aligned = alignment.tokens[token.index]
      if (aligned?.status === 'skipped') {
        tally.skippedWords += 1
      } else if (aligned?.status === 'spoken') {
        tally.spokenWords += 1
        const at = secondsAtWord(timeline, aligned.spokenIndex)
        if (at !== null) {
          tally.from = tally.from === null ? at : Math.min(tally.from, at)
          tally.to = tally.to === null ? at : Math.max(tally.to, at)
        }
      }
    }
  }

  return [...tallies.values()].map((tally) => ({
    sectionId: tally.sectionId,
    heading: tally.heading,
    scriptWords: tally.scriptWords,
    spokenWords: tally.spokenWords,
    skippedWords: tally.skippedWords,
    plannedSeconds: estimateSeconds(tally.scriptWords),
    actualSeconds:
      tally.from !== null && tally.to !== null ? Math.round(tally.to - tally.from) : null,
    skippedRuns: runs.filter((run) => run.sectionId === tally.sectionId),
  }))
}

/**
 * Builds the report for one delivered speech.
 *
 * @param input - See {@link SpeechReportInput}. The alignment and the timeline must come from the
 *   same transcript; everything else is copied through.
 * @returns A self-contained report, safe to `JSON.stringify` into the session row.
 */
export function buildSpeechReport(input: SpeechReportInput): SpeechReport {
  const segments = segmentsById(input.script)
  const labels = input.fieldLabels ?? {}
  const skippedRuns = collectSkippedRuns(input.script, input.alignment, segments, labels)
  const sections = buildSectionReports(input.script, input.alignment, input.timeline, skippedRuns)
  const improvisations = collectImprovisedRuns(
    input.script,
    input.alignment,
    input.timeline,
    segments,
    labels,
  )

  // A filler's span is a character offset; the word it lands in is what carries the clock.
  const hits = findFillers(input.timeline.transcript)
  const fillers: readonly ReportedFiller[] = hits.map((hit) => ({
    phrase: hit.phrase,
    text: hit.text,
    kind: hit.kind,
    atSeconds: wordAtOffset(input.timeline, hit.span.start)?.startSeconds ?? null,
  }))

  const skippedWords = sections.reduce((total, section) => total + section.skippedWords, 0)
  const improvisedWords = improvisations.reduce((total, run) => total + run.wordCount, 0)

  return {
    version: 1,
    sessionId: input.sessionId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    caseId: input.caseId,
    motion: input.motion,
    format: input.format,
    roleId: input.roleId,
    roleLabel: input.roleLabel,
    isReply: input.isReply,
    transcript: input.timeline.transcript,
    metrics: summariseSession({
      durationSeconds: input.deliveredSeconds,
      scriptWords: input.script.wordCount,
      spokenWords: input.timeline.words.length,
      skippedWords,
      skipRate: skipRate(input.alignment),
      improvisedWords,
      fillerCount: fillers.length,
      pauses: input.pauses,
      source: input.source,
      isAccurate: input.isAccurate,
    }),
    sections,
    improvisations,
    fillers,
    fillerCounts: countFillers(hits),
    pauses: [...input.pauses],
    pace: pacePoints(input.timeline),
  }
}
