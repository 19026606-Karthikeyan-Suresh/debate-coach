/**
 * The underline segments.
 *
 * One invariant matters above all the others and is asserted in almost every case here: the
 * segment texts must concatenate back to the input exactly. The editor stacks these behind the
 * real textarea, so a dropped or duplicated character shifts every word after it and visibly
 * tears the underlay away from the text it is supposed to be under.
 */

import { describe, expect, it } from 'vitest'

import { buildHighlightSegments } from '../highlight.ts'
import type { Finding, Severity } from '../types.ts'

/** Builds a finding covering one span. Only the fields the segment builder reads are real. */
function spanning(start: number, end: number, severity: Severity = 'warn'): Finding {
  return {
    fieldPath: 'substantives.sub-1.whyBad',
    rule: 'vagueness',
    severity,
    span: { start, end },
    message: '',
    socraticPrompt: '',
  }
}

/** Concatenated segment text, which must always equal the input. */
function rejoin(text: string, findings: readonly Finding[]): string {
  return buildHighlightSegments(text, findings)
    .map((segment) => segment.text)
    .join('')
}

describe('buildHighlightSegments', () => {
  const text = 'Many people are harmed by this.'

  it('returns nothing for empty text', () => {
    expect(buildHighlightSegments('', [spanning(0, 4)])).toEqual([])
  })

  it('returns one plain segment when nothing is flagged', () => {
    expect(buildHighlightSegments(text, [])).toEqual([{ text, severity: null }])
  })

  it('splits into plain and underlined runs', () => {
    expect(buildHighlightSegments(text, [spanning(0, 4)])).toEqual([
      { text: 'Many', severity: 'warn' },
      { text: ' people are harmed by this.', severity: null },
    ])
  })

  it('always rebuilds the input exactly', () => {
    expect(rejoin(text, [spanning(0, 4), spanning(5, 11, 'info')])).toBe(text)
    expect(rejoin(text, [spanning(0, text.length)])).toBe(text)
    expect(rejoin(text, [spanning(3, 8), spanning(6, 12)])).toBe(text)
  })

  it('gives an overlap to the stronger severity', () => {
    const segments = buildHighlightSegments(text, [
      spanning(0, 11, 'info'),
      spanning(5, 11, 'critical'),
    ])
    expect(segments).toEqual([
      { text: 'Many ', severity: 'info' },
      { text: 'people', severity: 'critical' },
      { text: ' are harmed by this.', severity: null },
    ])
  })

  it('does not care which order the findings arrive in', () => {
    const weakFirst = buildHighlightSegments(text, [spanning(0, 11, 'info'), spanning(5, 11, 'critical')])
    const strongFirst = buildHighlightSegments(text, [spanning(5, 11, 'critical'), spanning(0, 11, 'info')])
    expect(weakFirst).toEqual(strongFirst)
  })

  it('ignores findings that cover nothing', () => {
    const noSpan: Finding = { ...spanning(0, 4), span: null }
    expect(buildHighlightSegments(text, [noSpan])).toEqual([{ text, severity: null }])
  })

  it('clamps a span the debater has since typed past', () => {
    // Analysis is debounced, so a finding is always a few hundred milliseconds behind the text.
    // Trusting a stale offset would tear the underlay off the textarea.
    const shortened = 'Many'
    expect(rejoin(shortened, [spanning(0, 400)])).toBe(shortened)
    expect(buildHighlightSegments(shortened, [spanning(0, 400)])).toEqual([
      { text: 'Many', severity: 'warn' },
    ])
  })

  it('drops a span that now starts past the end of the text', () => {
    expect(buildHighlightSegments('Many', [spanning(90, 100)])).toEqual([
      { text: 'Many', severity: null },
    ])
  })
})
