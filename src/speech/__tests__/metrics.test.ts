/**
 * The timeline, and the one invariant everything downstream rests on.
 *
 * A transcript word index means the same thing to the aligner, to the timeline and to the report.
 * If `buildTimeline` splits words even slightly differently from `transcriptWords`, every skipped
 * word gets attributed to the wrong moment and nothing above notices — so that agreement is
 * asserted directly rather than left to be true by inspection.
 */

import { describe, expect, it } from 'vitest'

import type { TranscriptSegment } from '../metrics.ts'
import {
  buildTimeline,
  buildUntimedTimeline,
  pacePoints,
  secondsAtWord,
  summariseSession,
  wordAtOffset,
} from '../metrics.ts'
import { transcriptWords } from '../transcript.ts'

const SEGMENTS: readonly TranscriptSegment[] = [
  { start: 0, end: 4, text: 'My first substantive is that fake news causes damage.' },
  { start: 4, end: 6, text: '  What is the problem?  ' },
  { start: 6, end: 12, text: 'It uproots the life of an organization.' },
]

describe('a timeline built from the review pass', () => {
  const timeline = buildTimeline(SEGMENTS)

  it('joins the segments into the transcript the aligner is run against', () => {
    expect(timeline.transcript).toBe(
      'My first substantive is that fake news causes damage. What is the problem? ' +
        'It uproots the life of an organization.',
    )
  })

  it('splits words exactly the way the aligner does', () => {
    expect(timeline.words.map((word) => word.text)).toEqual([...transcriptWords(timeline.transcript)])
  })

  it('has every word pointing at its own characters', () => {
    for (const word of timeline.words) {
      expect(timeline.transcript.slice(word.start, word.end)).toBe(word.text)
    }
  })

  it('spreads each segment’s words across the seconds that segment covers', () => {
    // "My" opens the first segment, "What" opens the second at 4 s, "It" the third at 6 s.
    expect(secondsAtWord(timeline, 0)).toBe(0)
    expect(secondsAtWord(timeline, 9)).toBe(4)
    expect(secondsAtWord(timeline, 13)).toBe(6)
  })

  it('runs to the end of the last segment', () => {
    expect(timeline.durationSeconds).toBe(12)
    expect(timeline.hasTimings).toBe(true)
  })

  it('drops blank segments rather than emitting an empty word', () => {
    const withBlank = buildTimeline([...SEGMENTS, { start: 12, end: 13, text: '   ' }])
    expect(withBlank.words).toHaveLength(timeline.words.length)
  })

  it('does not run a section backwards on a reversed timestamp', () => {
    const reversed = buildTimeline([{ start: 8, end: 3, text: 'out of order' }])
    for (const word of reversed.words) {
      expect(word.endSeconds ?? 0).toBeGreaterThanOrEqual(word.startSeconds ?? 0)
    }
  })
})

describe('a timeline with no clock behind it', () => {
  const timeline = buildUntimedTimeline('My first substantive is that fake news causes damage.')

  it('still addresses every word', () => {
    expect(timeline.words.map((word) => word.text)).toEqual([...transcriptWords(timeline.transcript)])
    expect(timeline.words[2]?.text).toBe('substantive')
  })

  it('reports no times rather than zeroes', () => {
    expect(timeline.hasTimings).toBe(false)
    expect(timeline.durationSeconds).toBeNull()
    expect(secondsAtWord(timeline, 2)).toBeNull()
  })

  it('is empty for an empty transcript', () => {
    expect(buildUntimedTimeline('').words).toEqual([])
    expect(buildUntimedTimeline('   ').words).toEqual([])
  })
})

describe('finding the word a character offset lands in', () => {
  const timeline = buildUntimedTimeline('one two three')

  it('resolves an offset inside a word', () => {
    expect(wordAtOffset(timeline, 5)?.text).toBe('two')
  })

  it('resolves an offset in the space before a word to that word', () => {
    expect(wordAtOffset(timeline, 3)?.text).toBe('two')
  })

  it('is null past the end', () => {
    expect(wordAtOffset(timeline, 99)).toBeNull()
  })
})

describe('pace across the speech', () => {
  /** Sixty words a minute for a minute, then a hundred and eighty for the next. */
  const paced = buildTimeline([
    { start: 0, end: 60, text: Array.from({ length: 60 }, () => 'word').join(' ') },
    { start: 60, end: 120, text: Array.from({ length: 180 }, () => 'word').join(' ') },
  ])

  it('charts the change rather than the average', () => {
    const points = pacePoints(paced, 60)
    expect(points).toEqual([
      { atSeconds: 0, wordsPerMinute: 60 },
      { atSeconds: 60, wordsPerMinute: 180 },
    ])
  })

  it('drops a trailing bucket too short to mean anything', () => {
    // Two seconds of a twenty-second bucket: three words there is not ninety a minute.
    const trailing = buildTimeline([
      { start: 0, end: 20, text: Array.from({ length: 50 }, () => 'word').join(' ') },
      { start: 20, end: 22, text: 'one two three' },
    ])
    expect(pacePoints(trailing, 20)).toHaveLength(1)
  })

  it('charts nothing at all when there are no timings', () => {
    expect(pacePoints(buildUntimedTimeline('one two three'))).toEqual([])
  })
})

describe('the session row', () => {
  const metrics = summariseSession({
    durationSeconds: 420,
    scriptWords: 1060,
    spokenWords: 1000,
    skippedWords: 60,
    skipRate: 60 / 1060,
    improvisedWords: 12,
    fillerCount: 14,
    pauses: [
      { startSeconds: 60, endSeconds: 63 },
      { startSeconds: 200, endSeconds: 204.5 },
    ],
    source: 'whisper',
    isAccurate: true,
  })

  it('reports pace and filler rate per minute, not per speech', () => {
    expect(metrics.wordsPerMinute).toBe(143)
    expect(metrics.fillersPerMinute).toBe(2)
  })

  it('reports the longest pause, not the total', () => {
    expect(metrics.pauseCount).toBe(2)
    expect(metrics.longestPauseSeconds).toBe(4.5)
  })

  it('does not divide by the first tick of the clock', () => {
    const instant = summariseSession({
      durationSeconds: 0,
      scriptWords: 10,
      spokenWords: 3,
      skippedWords: 0,
      skipRate: 0,
      improvisedWords: 0,
      fillerCount: 2,
      pauses: [],
      source: 'web-speech',
      isAccurate: false,
    })
    expect(instant.wordsPerMinute).toBe(0)
    expect(instant.fillersPerMinute).toBe(0)
    expect(instant.longestPauseSeconds).toBe(0)
  })
})
