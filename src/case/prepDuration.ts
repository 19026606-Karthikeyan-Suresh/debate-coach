/**
 * How long prep actually is, when it is not what the format says.
 *
 * The registry's `prepSeconds` — 30 minutes in AP, 15 in BP — is the rule, and the rule is
 * routinely not what happens: a tournament runs short prep to catch up, a chair grants five more
 * minutes, a squad practises against a deliberately tight clock. So the format supplies the
 * default and this supplies the override.
 *
 * Pure, so the bounds and the parsing are testable without a clock or a database.
 */

/** Shortest prep worth counting. Below a minute the countdown is the whole exercise. */
export const MIN_PREP_MINUTES = 1

/**
 * Longest prep accepted.
 *
 * Three hours is far past any real format and is here to catch a typo — an extra zero on 15
 * turns a prep timer into one that never meaningfully counts down, and the debater finds out by
 * it never turning red.
 */
export const MAX_PREP_MINUTES = 180

/**
 * Clamps a minute count into the accepted range.
 *
 * @param minutes - Candidate length. Fractions are floored: a prep clock that starts at 14:30
 *   because somebody typed 14.5 is a worse surprise than losing thirty seconds.
 * @returns A whole number of minutes within the bounds.
 */
export function clampPrepMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) {
    return MIN_PREP_MINUTES
  }
  return Math.min(MAX_PREP_MINUTES, Math.max(MIN_PREP_MINUTES, Math.floor(minutes)))
}

/**
 * Reads a stored override.
 *
 * @param stored - The settings value, or null when nothing was ever saved. Anything unparseable
 *   is treated as absent rather than as zero — a corrupt row must fall back to the format's own
 *   prep window, not to a clock that is already expired.
 * @returns Seconds, or null to use the format default.
 */
export function parsePrepOverride(stored: string | null): number | null {
  if (stored === null) {
    return null
  }
  const minutes = Number.parseInt(stored.trim(), 10)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null
  }
  return clampPrepMinutes(minutes) * 60
}

/**
 * Turns a draft from the input box into seconds.
 *
 * @param draft - What was typed. Empty, whitespace, or anything non-numeric returns null, which
 *   the caller treats as "leave it alone" rather than as a change to zero.
 * @returns Seconds, or null when the draft is not a length.
 */
export function prepSecondsFromDraft(draft: string): number | null {
  const trimmed = draft.trim()
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
    return null
  }
  return clampPrepMinutes(Number.parseInt(trimmed, 10)) * 60
}
