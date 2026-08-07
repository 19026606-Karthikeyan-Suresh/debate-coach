/**
 * Turns findings into the runs of text the editor underlines.
 *
 * The editor draws underlines by stacking a transparent copy of the field's text behind the
 * real textarea, so what it needs is not spans but a flat, gap-free partition of the text: every
 * character exactly once, in order, tagged with the severity of the strongest finding covering
 * it. Overlapping spans — a hedge inside an over-long sentence — resolve to the stronger one.
 *
 * The clamp is the part that matters. Analysis is debounced, so a finding is always a few
 * hundred milliseconds behind the text it describes; by the time it renders, the debater may
 * have deleted the words it points at. Trusting the offsets would drop or duplicate characters
 * in the underlay and visibly desynchronise it from the textarea, so they are clamped to the
 * current text and spans that have fallen off the end are discarded.
 */

import { SEVERITY_ORDER } from './types.ts'
import type { Finding, Severity } from './types.ts'

/** One run of text, either plain or underlined at a single severity. */
export interface HighlightSegment {
  readonly text: string
  /** Severity of the strongest finding covering this run, or null where nothing covers it. */
  readonly severity: Severity | null
}

/**
 * Partitions a field's text into plain and underlined runs.
 *
 * @param text - The field's current value — the live one from the textarea, not whatever the
 *   rules saw. Findings are clamped to it.
 * @param findings - Findings for this field. Ones with no span cover nothing and are ignored
 *   here; they still show in the depth panel, which is where whole-field findings belong.
 * @returns Consecutive segments whose texts concatenate back to `text` exactly.
 */
export function buildHighlightSegments(
  text: string,
  findings: readonly Finding[],
): readonly HighlightSegment[] {
  if (text.length === 0) {
    return []
  }

  // Strongest severity covering each character, painted one finding at a time. A character array
  // rather than an interval merge because fields are a few hundred characters and this is
  // obviously correct where an interval merge is obviously fiddly.
  const coverage: (Severity | null)[] = new Array<Severity | null>(text.length).fill(null)
  let hasAnyCoverage = false

  for (const finding of findings) {
    if (!finding.span) {
      continue
    }
    const start = Math.max(0, Math.min(finding.span.start, text.length))
    const end = Math.max(start, Math.min(finding.span.end, text.length))
    for (let offset = start; offset < end; offset += 1) {
      const existing = coverage[offset]
      if (!existing || SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[existing]) {
        coverage[offset] = finding.severity
        hasAnyCoverage = true
      }
    }
  }

  if (!hasAnyCoverage) {
    return [{ text, severity: null }]
  }

  const segments: HighlightSegment[] = []
  let runStart = 0
  for (let offset = 1; offset <= text.length; offset += 1) {
    if (offset < text.length && coverage[offset] === coverage[runStart]) {
      continue
    }
    segments.push({ text: text.slice(runStart, offset), severity: coverage[runStart] ?? null })
    runStart = offset
  }
  return segments
}
