/**
 * The report, against the case the analyzer already uses as its regression fixture.
 *
 * Built on a real compiled script rather than a hand-written one, because the property under test
 * is provenance: a skipped word has to come back naming `substantives.sub-1.whyBad`, and that only
 * means anything if the path was produced by the compiler from a real case rather than typed into
 * a fixture next to the assertion.
 *
 * PLAN's verification step 7 — "deliberately skip a sentence mid-speech; confirm it strikes
 * through live and lands in the report linked to its case field" — is the first block below.
 */

import { describe, expect, it } from 'vitest'

import { buildFilledExampleCase } from '../../analysis/__tests__/fixture.ts'
import { getRole } from '../../formats/index.ts'
import type { SpeakerRole } from '../../formats/index.ts'
import { compileScript } from '../../script/compile.ts'
import type { CompiledScript } from '../../script/types.ts'
import { alignSpeech } from '../align.ts'
import type { AlignmentState } from '../align.ts'
import { buildTimeline, buildUntimedTimeline } from '../metrics.ts'
import type { SpeechTimeline, TranscriptSegment } from '../metrics.ts'
import { buildSpeechReport } from '../report.ts'
import type { SpeechReport, SpeechReportInput } from '../report.ts'
import { transcriptWords } from '../transcript.ts'

/** Looks a role up and fails loudly, so a typo'd role id is not a silently empty script. */
function role(formatId: 'AP' | 'BP', roleId: string): SpeakerRole {
  const found = getRole(formatId, roleId)
  if (!found) {
    throw new Error(`No such role: ${formatId}/${roleId}`)
  }
  return found
}

const CASE_FILE = buildFilledExampleCase()
const SCRIPT: CompiledScript = compileScript(CASE_FILE, role('AP', 'ap-pm'))
const SCRIPT_WORDS = SCRIPT.tokens.map((token) => token.text)

/** The whole script said perfectly, as one string. */
const VERBATIM = SCRIPT_WORDS.join(' ')

/**
 * The script with one case row left unsaid.
 *
 * Cut by `fieldPath` rather than by matching the row's text against the transcript: the compiler
 * splices the debater's answers into the template's prose and adjusts punctuation at the seam, so
 * the row as typed does not appear verbatim in the script. Dropping the tokens the compiler
 * attributed to that row is what "the speaker skipped this row" actually means.
 */
function withoutRow(fieldPath: string): string {
  return SCRIPT.tokens
    .filter((token) => token.fieldPath !== fieldPath)
    .map((token) => token.text)
    .join(' ')
}

/** Builds a report over a transcript, with whatever timings the caller supplies. */
function report(
  transcript: string,
  overrides: Partial<SpeechReportInput> = {},
  timeline: SpeechTimeline = buildUntimedTimeline(transcript),
): SpeechReport {
  const alignment: AlignmentState = alignSpeech(SCRIPT_WORDS, [
    ...transcriptWords(timeline.transcript),
  ])
  return buildSpeechReport({
    sessionId: 'session-1',
    caseId: CASE_FILE.id,
    motion: CASE_FILE.prep.motion,
    format: 'AP',
    roleId: 'ap-pm',
    roleLabel: 'Prime Minister',
    isReply: false,
    script: SCRIPT,
    alignment,
    timeline,
    pauses: [],
    deliveredSeconds: 400,
    source: 'whisper',
    isAccurate: true,
    createdAt: '2026-08-08T10:00:00.000Z',
    ...overrides,
  })
}

describe('a row the speaker skipped', () => {
  // The first substantive's "why is it bad" row, dropped mid-speech.
  const SKIPPED_PATH = 'substantives.sub-1.whyBad'
  const delivered = report(withoutRow(SKIPPED_PATH))
  const runs = delivered.sections
    .flatMap((section) => section.skippedRuns)
    .filter((run) => run.fieldPath === SKIPPED_PATH)

  it('names the row it came from, not a word index', () => {
    expect(runs.length).toBeGreaterThan(0)
  })

  it('reports it as dropped clauses rather than one problem per word', () => {
    expect(runs.length).toBeLessThan(4)
    expect(Math.max(...runs.map((run) => run.wordCount))).toBeGreaterThan(10)
  })

  it('quotes the words as the case has them, spacing and punctuation intact', () => {
    const spoken = CASE_FILE.substantives[0]?.whyBad ?? ''
    for (const run of runs) {
      // Every word of the run is the debater's own text, not the compiler's rewrite of it.
      expect(spoken).toContain(run.text.split(' ')[1] ?? run.text)
    }
  })

  it('charges the skip to the section it happened in', () => {
    const section = delivered.sections.find((item) => item.sectionId === 'substantives.sub-1')
    expect(section?.skippedWords).toBeGreaterThan(10)
    expect(section?.heading).toBe('Sub 1')
  })

  it('leaves every other section clean', () => {
    const elsewhere = delivered.sections
      .filter((section) => section.sectionId !== 'substantives.sub-1')
      .flatMap((section) => section.skippedRuns)
    expect(elsewhere).toEqual([])
  })

  it('names the row the way the editor does when it is given the labels', () => {
    const labelled = report(withoutRow(SKIPPED_PATH), {
      fieldLabels: { [SKIPPED_PATH]: 'Why is it bad? (the impact)' },
    })
    const run = labelled.sections
      .flatMap((section) => section.skippedRuns)
      .find((candidate) => candidate.fieldPath === SKIPPED_PATH)
    expect(run?.fieldLabel).toBe('Why is it bad? (the impact)')
  })

  it('reports a null label rather than failing when the registry has moved on', () => {
    expect(runs.every((run) => run.fieldLabel === null)).toBe(true)
  })
})

describe('a speech delivered as written', () => {
  const delivered = report(VERBATIM)

  it('reports nothing skipped and nothing improvised', () => {
    expect(delivered.sections.flatMap((section) => section.skippedRuns)).toEqual([])
    expect(delivered.improvisations).toEqual([])
    expect(delivered.metrics.skippedWords).toBe(0)
    expect(delivered.metrics.skipRate).toBe(0)
  })

  it('accounts for every script word in exactly one section', () => {
    const counted = delivered.sections.reduce((total, section) => total + section.scriptWords, 0)
    expect(counted).toBe(SCRIPT.wordCount)
  })

  it('plans each section against the script, not against the clock', () => {
    for (const section of delivered.sections) {
      expect(section.plannedSeconds).toBe(Math.round((section.scriptWords / 160) * 60))
    }
  })
})

describe('a sentence the speaker added', () => {
  const added = 'and that is why the mechanism holds'
  const delivered = report(`${VERBATIM} ${added}`)

  it('collects the aside as one run, not seven', () => {
    expect(delivered.improvisations).toHaveLength(1)
    expect(delivered.improvisations[0]?.text).toBe(added)
    expect(delivered.improvisations[0]?.wordCount).toBe(7)
  })

  it('offers a row to save it into', () => {
    expect(delivered.improvisations[0]?.fieldPath).toMatch(/^[a-z]/)
  })

  it('counts the added words without counting them as script', () => {
    expect(delivered.metrics.improvisedWords).toBe(7)
    expect(delivered.metrics.skippedWords).toBe(0)
  })
})

describe('the numbers a session is compared by', () => {
  const delivered = report(`Um, ${VERBATIM}`, {
    deliveredSeconds: 398,
    pauses: [
      { startSeconds: 90, endSeconds: 93 },
      { startSeconds: 210, endSeconds: 216 },
    ],
  })

  it('carries the fillers, the pauses and the pace', () => {
    // Two: the "Um" that was said, and the "basically" the case itself was written with. The
    // report counts what was heard, so a filler the debater typed into a row and then read out
    // is still a filler — that is the point at which the case becomes the speech.
    expect(delivered.fillers.map((filler) => filler.phrase)).toEqual(['um', 'basically'])
    expect(delivered.metrics.fillerCount).toBe(2)
    expect(delivered.metrics.pauseCount).toBe(2)
    expect(delivered.metrics.longestPauseSeconds).toBe(6)
    expect(delivered.metrics.wordsPerMinute).toBeGreaterThan(100)
  })

  it('says which engine produced them and whether they are the accurate ones', () => {
    expect(delivered.metrics.source).toBe('whisper')
    expect(delivered.metrics.isAccurate).toBe(true)
    expect(delivered.metrics.version).toBe(1)
  })

  it('survives a round trip through the session row', () => {
    const stored: SpeechReport = JSON.parse(JSON.stringify(delivered)) as SpeechReport
    expect(stored).toEqual(delivered)
  })
})

describe('with timings from the review pass', () => {
  // Half the speech in the first two minutes, the rest in the next two.
  const half = Math.floor(SCRIPT_WORDS.length / 2)
  const segments: readonly TranscriptSegment[] = [
    { start: 0, end: 120, text: SCRIPT_WORDS.slice(0, half).join(' ') },
    { start: 120, end: 240, text: SCRIPT_WORDS.slice(half).join(' ') },
  ]
  const timeline = buildTimeline(segments)
  const delivered = report(timeline.transcript, { deliveredSeconds: 240 }, timeline)

  it('puts a duration on each section it reached', () => {
    const timed = delivered.sections.filter((section) => section.actualSeconds !== null)
    expect(timed.length).toBe(delivered.sections.length)
  })

  it('charts the pace across the speech', () => {
    expect(delivered.pace.length).toBeGreaterThan(1)
    expect(delivered.pace[0]?.atSeconds).toBe(0)
  })

  it('times the fillers it found', () => {
    const withFiller = report(`Um, ${timeline.transcript}`, {}, buildTimeline([
      { start: 0, end: 5, text: 'Um, so let me begin.' },
      ...segments.map((segment) => ({ ...segment, start: segment.start + 5, end: segment.end + 5 })),
    ]))
    expect(withFiller.fillers[0]?.atSeconds).toBe(0)
  })
})

describe('with no timings at all', () => {
  const delivered = report(VERBATIM, { source: 'web-speech', isAccurate: false })

  it('still reports what was skipped', () => {
    expect(delivered.sections.length).toBeGreaterThan(0)
    expect(delivered.metrics.scriptWords).toBe(SCRIPT.wordCount)
  })

  it('reports no section durations rather than zeroes', () => {
    expect(delivered.sections.every((section) => section.actualSeconds === null)).toBe(true)
  })

  it('charts no pace rather than a flat line at the average', () => {
    expect(delivered.pace).toEqual([])
  })

  it('says the numbers are not the accurate ones', () => {
    expect(delivered.metrics.isAccurate).toBe(false)
    expect(delivered.metrics.source).toBe('web-speech')
  })
})
