/**
 * The speech clock, as a pure function of elapsed seconds.
 *
 * A debate clock is not a countdown with a beep at the end. It has four moments a speaker has to
 * feel without looking down — the table opens to points of information at 1:00, closes at 6:00,
 * time is called at 7:00, and the chair stops taking the speech after grace — and each of them is
 * signalled by a knock on the desk rather than by a number. The timer's job is to reproduce that,
 * which is why {@link signalsBetween} is edge-triggered: a knock happens once, at the moment it
 * is crossed, and a knock that fires twice is worse than one that does not fire at all.
 *
 * Everything here is derived from the elapsed time and the format. No state, no interval, no
 * `Date.now` — the hook owns the clock and this owns what the clock means.
 */

import type { Format, SpeakerRole } from '../formats/index.ts'

/**
 * Seconds a speaker may run over before the chair stops counting.
 *
 * Fifteen is the WSDC and BP convention: time is called at the limit, the speaker finishes the
 * sentence, and matter after grace is not weighed. Not configurable per format because both
 * supported formats use it and a second number nobody sets is a second number to keep right.
 */
export const GRACE_SECONDS = 15

/** Warning before time is called. Long enough to land a conclusion, short enough not to rush one. */
export const FINAL_WARNING_SECONDS = 30

/** The clock a speech is run against. */
export interface SpeechLimits {
  /** Full length of this speech. A reply is shorter than a substantive. */
  readonly speechSeconds: number
  /**
   * `[opens, closes]` in seconds from the start. A reply takes no points of information, so
   * both entries are zero and the window never opens.
   */
  readonly poiWindowSeconds: readonly [number, number]
  /** Overrun tolerated before the speech is over. See {@link GRACE_SECONDS}. */
  readonly graceSeconds: number
}

/** Where in the speech the clock is. */
export type SpeechPhase =
  /** Before the POI window — protected time, no points may be offered. */
  | 'protected-opening'
  /** The POI window. */
  | 'open'
  /** After the window and before time — protected again. */
  | 'protected-closing'
  /** Past the limit, inside grace. */
  | 'overtime'
  /** Past grace. Nothing said here counts. */
  | 'finished'

/** What a moment in the speech has just crossed. */
export type SpeechSignalKind = 'poi-open' | 'poi-close' | 'final-warning' | 'time' | 'grace-over'

/** One knock, warning, or call. */
export interface SpeechSignal {
  readonly kind: SpeechSignalKind
  /** Exact second it belongs to, not the second it was noticed at. */
  readonly atSeconds: number
  /** What to show, phrased the way a chair would say it. */
  readonly label: string
}

/** Everything the timer UI needs for one frame. */
export interface SpeechClock {
  readonly elapsedSeconds: number
  /** Time to the limit. Floors at zero; overrun is reported separately, not as a negative. */
  readonly remainingSeconds: number
  /** Seconds past the limit, or zero. */
  readonly overrunSeconds: number
  readonly phase: SpeechPhase
  readonly isPoiAllowed: boolean
  /** 0 to 1 across the speech, clamped past the limit so the bar cannot overflow its track. */
  readonly elapsedFraction: number
  /** `[start, end]` as 0-to-1 fractions, for shading the POI window on the bar. */
  readonly poiWindowFraction: readonly [number, number]
}

/**
 * Builds the clock for the speech a seat actually gives.
 *
 * @param format - Supplies the substantive length and the POI window.
 * @param role - Only consulted for the reply; a role that cannot give one makes `isReply` moot.
 * @param isReply - True for the reply speech. A reply is shorter and takes no points, so passing
 *   this for a role whose `canGiveReply` is false produces a clock nobody can deliver against —
 *   the caller checks that, not this.
 * @returns The limits to run the timer with.
 */
export function buildSpeechLimits(
  format: Format,
  role: SpeakerRole,
  isReply: boolean,
): SpeechLimits {
  const wantsReply = isReply && role.canGiveReply && format.replySeconds !== null
  if (wantsReply && format.replySeconds !== null) {
    return {
      speechSeconds: format.replySeconds,
      poiWindowSeconds: [0, 0],
      graceSeconds: GRACE_SECONDS,
    }
  }
  return {
    speechSeconds: format.speechSeconds,
    poiWindowSeconds: format.poiWindowSeconds,
    graceSeconds: GRACE_SECONDS,
  }
}

/** Whether the POI window is a real window rather than a reply's closed one. */
function hasPoiWindow(limits: SpeechLimits): boolean {
  const [opens, closes] = limits.poiWindowSeconds
  return closes > opens
}

/**
 * Reads the clock at one instant.
 *
 * @param elapsedSeconds - Seconds since the speech started. Negative values are treated as zero,
 *   which is what a timer reset mid-render produces.
 * @param limits - The speech being run. A `speechSeconds` of zero would divide by zero building
 *   the bar fractions, so it is floored at one second.
 * @returns The phase, the remaining time, and the fractions the bar is drawn from.
 */
export function readSpeechClock(elapsedSeconds: number, limits: SpeechLimits): SpeechClock {
  const elapsed = Math.max(0, elapsedSeconds)
  const total = Math.max(1, limits.speechSeconds)
  const [opens, closes] = limits.poiWindowSeconds

  const overrunSeconds = Math.max(0, elapsed - total)
  const isPoiAllowed = hasPoiWindow(limits) && elapsed >= opens && elapsed <= closes

  let phase: SpeechPhase
  if (overrunSeconds > limits.graceSeconds) {
    phase = 'finished'
  } else if (overrunSeconds > 0) {
    phase = 'overtime'
  } else if (isPoiAllowed) {
    phase = 'open'
  } else if (elapsed < opens && hasPoiWindow(limits)) {
    phase = 'protected-opening'
  } else {
    phase = 'protected-closing'
  }

  return {
    elapsedSeconds: elapsed,
    remainingSeconds: Math.max(0, total - elapsed),
    overrunSeconds,
    phase,
    isPoiAllowed,
    elapsedFraction: Math.min(1, elapsed / total),
    poiWindowFraction: hasPoiWindow(limits)
      ? [Math.min(1, opens / total), Math.min(1, closes / total)]
      : [0, 0],
  }
}

/** Every signal in a speech, in the order they are crossed. */
function signalsFor(limits: SpeechLimits): readonly SpeechSignal[] {
  const [opens, closes] = limits.poiWindowSeconds
  const signals: SpeechSignal[] = []

  if (hasPoiWindow(limits)) {
    signals.push({ kind: 'poi-open', atSeconds: opens, label: 'Points open' })
    signals.push({ kind: 'poi-close', atSeconds: closes, label: 'Points closed' })
  }

  // A warning at or before the POI window closes would be two knocks on top of each other, and
  // on a short reply it would land before the speech had properly started.
  const warningAt = limits.speechSeconds - FINAL_WARNING_SECONDS
  if (warningAt > closes && warningAt > 0) {
    signals.push({ kind: 'final-warning', atSeconds: warningAt, label: '30 seconds' })
  }

  signals.push({ kind: 'time', atSeconds: limits.speechSeconds, label: 'Time' })
  signals.push({
    kind: 'grace-over',
    atSeconds: limits.speechSeconds + limits.graceSeconds,
    label: 'Grace over',
  })

  return signals.sort((left, right) => left.atSeconds - right.atSeconds)
}

/**
 * Signals crossed between two readings of the clock.
 *
 * Edge-triggered, half-open on the left: a signal at exactly `toSeconds` fires, one at exactly
 * `fromSeconds` does not. That is what stops a knock repeating on every tick — pass the previous
 * elapsed time and the current one, and each signal comes back exactly once however fast the
 * timer ticks or how far it jumps when a throttled interval catches up.
 *
 * @param fromSeconds - Elapsed time at the previous reading. A value above `toSeconds` returns
 *   nothing, because a clock that went backwards was reset and re-firing time is worse than
 *   silence.
 * @param toSeconds - Elapsed time now.
 * @param limits - The speech being run.
 * @returns The signals in the interval, earliest first. Usually empty.
 */
export function signalsBetween(
  fromSeconds: number,
  toSeconds: number,
  limits: SpeechLimits,
): readonly SpeechSignal[] {
  if (toSeconds <= fromSeconds) {
    return []
  }
  return signalsFor(limits).filter(
    (signal) => signal.atSeconds > fromSeconds && signal.atSeconds <= toSeconds,
  )
}

/**
 * How the script's length compares with the clock.
 *
 * The number a debater actually wants before standing up: not "your script is 1060 words" but
 * "that is 22 seconds more than you have".
 *
 * @param estimatedSeconds - From `estimateSeconds` on the compiled script.
 * @param limits - The speech it will be delivered in.
 * @returns Seconds spare, negative when the script is too long.
 */
export function scriptHeadroom(estimatedSeconds: number, limits: SpeechLimits): number {
  return limits.speechSeconds - estimatedSeconds
}
