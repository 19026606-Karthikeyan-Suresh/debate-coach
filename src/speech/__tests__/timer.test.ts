/**
 * The speech clock.
 *
 * Two things are worth pinning. Every signal fires exactly once however the clock is sampled —
 * a knock repeating on each tick is the failure mode that makes a timer unusable in a round.
 * And a reply speech is not a short substantive: it is four minutes with no points of
 * information at all, so the window must never open in one.
 */

import { describe, expect, it } from 'vitest'

import { AP_FORMAT, BP_FORMAT, getRole } from '../../formats/index.ts'
import type { SpeechLimits, SpeechSignalKind } from '../timer.ts'
import {
  buildSpeechLimits,
  GRACE_SECONDS,
  readSpeechClock,
  scriptHeadroom,
  signalsBetween,
} from '../timer.ts'

const PRIME_MINISTER = getRole('AP', 'ap-pm')
const GOV_WHIP = getRole('AP', 'ap-gov-whip')

if (!PRIME_MINISTER || !GOV_WHIP) {
  throw new Error('The AP format lost a role the timer tests are written against.')
}

const SUBSTANTIVE = buildSpeechLimits(AP_FORMAT, PRIME_MINISTER, false)
const REPLY = buildSpeechLimits(AP_FORMAT, PRIME_MINISTER, true)

/** Signal kinds crossed in an interval, in order. */
function kinds(from: number, to: number, limits: SpeechLimits): readonly SpeechSignalKind[] {
  return signalsBetween(from, to, limits).map((signal) => signal.kind)
}

describe('a seven-minute substantive', () => {
  it('protects the first minute and the last', () => {
    expect(readSpeechClock(30, SUBSTANTIVE).phase).toBe('protected-opening')
    expect(readSpeechClock(200, SUBSTANTIVE).phase).toBe('open')
    expect(readSpeechClock(380, SUBSTANTIVE).phase).toBe('protected-closing')
  })

  it('opens the window on the knock, not a second after it', () => {
    expect(readSpeechClock(59, SUBSTANTIVE).isPoiAllowed).toBe(false)
    expect(readSpeechClock(60, SUBSTANTIVE).isPoiAllowed).toBe(true)
    expect(readSpeechClock(360, SUBSTANTIVE).isPoiAllowed).toBe(true)
    expect(readSpeechClock(361, SUBSTANTIVE).isPoiAllowed).toBe(false)
  })

  it('counts overrun separately rather than as a negative clock', () => {
    const overtime = readSpeechClock(7 * 60 + 8, SUBSTANTIVE)
    expect(overtime.remainingSeconds).toBe(0)
    expect(overtime.overrunSeconds).toBe(8)
    expect(overtime.phase).toBe('overtime')
  })

  it('is finished once grace has run out', () => {
    expect(readSpeechClock(7 * 60 + GRACE_SECONDS, SUBSTANTIVE).phase).toBe('overtime')
    expect(readSpeechClock(7 * 60 + GRACE_SECONDS + 1, SUBSTANTIVE).phase).toBe('finished')
  })

  it('keeps the bar inside its track past time', () => {
    expect(readSpeechClock(600, SUBSTANTIVE).elapsedFraction).toBe(1)
    expect(readSpeechClock(-5, SUBSTANTIVE).elapsedFraction).toBe(0)
  })

  it('shades the window where the knocks are', () => {
    const [start, end] = readSpeechClock(0, SUBSTANTIVE).poiWindowFraction
    expect(start).toBeCloseTo(60 / 420, 5)
    expect(end).toBeCloseTo(360 / 420, 5)
  })
})

describe('the knocks', () => {
  it('fires each one exactly once across the whole speech, second by second', () => {
    const seen: SpeechSignalKind[] = []
    for (let second = 1; second <= 8 * 60; second += 1) {
      seen.push(...kinds(second - 1, second, SUBSTANTIVE))
    }
    expect(seen).toEqual(['poi-open', 'poi-close', 'final-warning', 'time', 'grace-over'])
  })

  it('fires each one exactly once when the clock jumps', () => {
    // A throttled interval in a background window catches up in one step. Every signal it
    // skipped over still has to arrive, and none of them twice.
    const seen = [...kinds(0, 200, SUBSTANTIVE), ...kinds(200, 8 * 60, SUBSTANTIVE)]
    expect(seen).toEqual(['poi-open', 'poi-close', 'final-warning', 'time', 'grace-over'])
  })

  it('is half-open, so a signal on the boundary is not delivered twice', () => {
    expect(kinds(0, 60, SUBSTANTIVE)).toEqual(['poi-open'])
    expect(kinds(60, 120, SUBSTANTIVE)).toEqual([])
  })

  it('says nothing when the clock has been reset', () => {
    expect(kinds(300, 0, SUBSTANTIVE)).toEqual([])
    expect(kinds(100, 100, SUBSTANTIVE)).toEqual([])
  })

  it('puts the thirty-second warning half a minute before time', () => {
    const warning = signalsBetween(0, 8 * 60, SUBSTANTIVE).find(
      (signal) => signal.kind === 'final-warning',
    )
    expect(warning?.atSeconds).toBe(7 * 60 - 30)
  })
})

describe('a reply speech', () => {
  it('is four minutes and takes no points', () => {
    expect(REPLY.speechSeconds).toBe(4 * 60)
    expect(readSpeechClock(120, REPLY).isPoiAllowed).toBe(false)
    expect(readSpeechClock(120, REPLY).phase).toBe('protected-closing')
    expect(readSpeechClock(0, REPLY).poiWindowFraction).toEqual([0, 0])
  })

  it('knocks only for the warning, time, and grace', () => {
    expect(kinds(0, 6 * 60, REPLY)).toEqual(['final-warning', 'time', 'grace-over'])
  })

  it('is the full speech for a seat that cannot give the reply', () => {
    // The whip never replies, so asking for one has to yield a whip's seven minutes rather than
    // a four-minute clock they would run out of at their third substantive.
    expect(buildSpeechLimits(AP_FORMAT, GOV_WHIP, true).speechSeconds).toBe(7 * 60)
  })

  it('is the full speech in a format with no reply at all', () => {
    const bpPrimeMinister = getRole('BP', 'bp-pm')
    expect(bpPrimeMinister).toBeDefined()
    if (bpPrimeMinister) {
      expect(buildSpeechLimits(BP_FORMAT, bpPrimeMinister, true).speechSeconds).toBe(7 * 60)
    }
  })
})

describe('script headroom', () => {
  it('is what is left of the clock after the script', () => {
    expect(scriptHeadroom(398, SUBSTANTIVE)).toBe(22)
  })

  it('goes negative when the script does not fit', () => {
    expect(scriptHeadroom(500, SUBSTANTIVE)).toBe(-80)
  })
})
