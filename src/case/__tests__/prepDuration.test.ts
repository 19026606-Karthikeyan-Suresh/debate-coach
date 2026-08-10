import { describe, expect, it } from 'vitest'

import {
  clampPrepMinutes,
  MAX_PREP_MINUTES,
  MIN_PREP_MINUTES,
  parsePrepOverride,
  prepSecondsFromDraft,
} from '../prepDuration.ts'

describe('clampPrepMinutes', () => {
  it('keeps a sensible length', () => {
    expect(clampPrepMinutes(15)).toBe(15)
    expect(clampPrepMinutes(30)).toBe(30)
  })

  it('holds the bounds', () => {
    expect(clampPrepMinutes(0)).toBe(MIN_PREP_MINUTES)
    expect(clampPrepMinutes(-5)).toBe(MIN_PREP_MINUTES)
    // The typo this exists for: an extra zero on 15 gives a clock that never turns red.
    expect(clampPrepMinutes(150)).toBe(150)
    expect(clampPrepMinutes(1500)).toBe(MAX_PREP_MINUTES)
  })

  it('floors a fraction rather than starting the clock at 14:30', () => {
    expect(clampPrepMinutes(14.5)).toBe(14)
  })

  it('treats nonsense as the minimum rather than propagating NaN into a deadline', () => {
    expect(clampPrepMinutes(Number.NaN)).toBe(MIN_PREP_MINUTES)
    expect(clampPrepMinutes(Number.POSITIVE_INFINITY)).toBe(MIN_PREP_MINUTES)
  })
})

describe('parsePrepOverride', () => {
  it('reads a stored length as seconds', () => {
    expect(parsePrepOverride('20')).toBe(20 * 60)
  })

  it('falls back to the format default rather than to an expired clock', () => {
    // The important case: a corrupt or empty row must not read as zero seconds, which would
    // open the editor with prep already over.
    for (const stored of [null, '', '   ', 'twenty', '0', '-3']) {
      expect(parsePrepOverride(stored)).toBeNull()
    }
  })

  it('clamps a stored value that is out of range', () => {
    expect(parsePrepOverride('9999')).toBe(MAX_PREP_MINUTES * 60)
  })
})

describe('prepSecondsFromDraft', () => {
  it('accepts a plain number of minutes', () => {
    expect(prepSecondsFromDraft('7')).toBe(7 * 60)
    expect(prepSecondsFromDraft(' 25 ')).toBe(25 * 60)
  })

  it('refuses a half-typed or non-numeric draft', () => {
    // Returned as null so the caller leaves the running clock alone; treating an empty box as
    // zero would expire prep the moment somebody selected the digits to retype them.
    for (const draft of ['', '  ', 'abc', '1.5', '-4', '12m']) {
      expect(prepSecondsFromDraft(draft)).toBeNull()
    }
  })
})
