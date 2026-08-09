import { describe, expect, it } from 'vitest'

import {
  activeCommentAt,
  clampToRecording,
  commentMarkers,
  COMMENT_DWELL_SECONDS,
  normalisedCommentBody,
  sortComments,
  type SpeechComment,
} from '../comments.ts'

/** Builds a comment, with everything the test does not care about filled in. */
function comment(atSeconds: number, overrides: Partial<SpeechComment> = {}): SpeechComment {
  return {
    id: overrides.id ?? `c-${String(atSeconds)}`,
    sessionId: 'session-1',
    authorId: 'coach',
    authorName: 'Coach',
    atSeconds,
    body: 'no mechanism here',
    createdAt: '2026-08-09T10:00:00.000Z',
    isRemote: true,
    ...overrides,
  }
}

describe('sortComments', () => {
  it('orders by timestamp, earliest first', () => {
    const sorted = sortComments([comment(252), comment(9), comment(70)])
    expect(sorted.map((entry) => entry.atSeconds)).toEqual([9, 70, 252])
  })

  it('breaks a tie by when it was written, not by array order', () => {
    const later = comment(60, { id: 'later', createdAt: '2026-08-09T11:00:00.000Z' })
    const earlier = comment(60, { id: 'earlier', createdAt: '2026-08-09T09:00:00.000Z' })
    expect(sortComments([later, earlier]).map((entry) => entry.id)).toEqual(['earlier', 'later'])
  })

  it('does not mutate its input', () => {
    const input = [comment(30), comment(10)]
    sortComments(input)
    expect(input.map((entry) => entry.atSeconds)).toEqual([30, 10])
  })
})

describe('activeCommentAt', () => {
  const notes = [comment(10, { id: 'a' }), comment(30, { id: 'b' }), comment(33, { id: 'c' })]

  it('has nothing before the first comment', () => {
    expect(activeCommentAt(notes, 4)).toBeNull()
  })

  it('surfaces a comment the moment playback reaches it', () => {
    expect(activeCommentAt(notes, 10)?.id).toBe('a')
  })

  it('lets it go once playback has moved on', () => {
    expect(activeCommentAt(notes, 10 + COMMENT_DWELL_SECONDS + 0.1)).toBeNull()
  })

  it('prefers the nearer of two overlapping comments', () => {
    // 30 and 33 are both live at 34. The one that starts nearest the audio is the one to show.
    expect(activeCommentAt(notes, 34)?.id).toBe('c')
  })
})

describe('commentMarkers', () => {
  it('places a comment proportionally along the bar', () => {
    const markers = commentMarkers([comment(105)], 420)
    expect(markers[0]?.position).toBeCloseTo(0.25, 5)
  })

  it('returns nothing when the recording has no length yet', () => {
    // Before metadata loads a bar has no positions on it, and drawing every marker at zero would
    // claim every note was left in the first second.
    expect(commentMarkers([comment(105)], 0)).toEqual([])
    expect(commentMarkers([comment(105)], Number.NaN)).toEqual([])
  })

  it('clamps a comment left past the end of the audio', () => {
    expect(commentMarkers([comment(500)], 420)[0]?.position).toBe(1)
  })
})

describe('clampToRecording', () => {
  it('keeps an ordinary timestamp', () => {
    expect(clampToRecording(252.4, 420)).toBe(252.4)
  })

  it('turns the NaN an unloaded audio element reports into zero', () => {
    // Storing NaN seconds is a note that can never be found again.
    expect(clampToRecording(Number.NaN, 420)).toBe(0)
    expect(clampToRecording(-1, 420)).toBe(0)
  })

  it('caps at the end of the recording', () => {
    expect(clampToRecording(430, 420)).toBe(420)
  })

  it('leaves a timestamp alone when the duration is not known', () => {
    expect(clampToRecording(12, 0)).toBe(12)
  })
})

describe('normalisedCommentBody', () => {
  it('trims what was typed', () => {
    expect(normalisedCommentBody('  slow down here \n')).toBe('slow down here')
  })

  it('refuses a comment of whitespace, as the database would', () => {
    // Postgres has `check (length(trim(body)) > 0)`. Without this the rejection arrives at drain
    // time, hours later, on a machine nobody is looking at.
    expect(normalisedCommentBody('   ')).toBeNull()
    expect(normalisedCommentBody('')).toBeNull()
  })
})
