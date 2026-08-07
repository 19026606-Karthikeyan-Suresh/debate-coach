/**
 * Clock formatting shared by the prep timer and, from phase 5, the speech timer.
 */

/**
 * Renders a duration as `M:SS`, or `H:MM:SS` past an hour.
 *
 * @param totalSeconds - Seconds to render. Negative values render as `0:00` rather than
 *   `-1:-30`; a timer that has run out shows zero, and overrun is displayed separately.
 * @returns The clock string, zero-padded past the first colon.
 */
export function formatClock(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const seconds = clamped % 60
  const paddedSeconds = String(seconds).padStart(2, '0')

  if (hours > 0) {
    return `${String(hours)}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
  }
  return `${String(minutes)}:${paddedSeconds}`
}
