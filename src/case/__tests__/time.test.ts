/** Clock formatting. */

import { describe, expect, it } from 'vitest'

import { formatClock } from '../time.ts'

describe('formatClock', () => {
  it('pads seconds but not minutes', () => {
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(600)).toBe('10:00')
  })

  it('adds an hours field only when there is one', () => {
    expect(formatClock(1800)).toBe('30:00')
    expect(formatClock(3661)).toBe('1:01:01')
  })

  it('floors partial seconds rather than rounding up past the limit', () => {
    expect(formatClock(59.9)).toBe('0:59')
  })

  it('shows zero rather than a negative clock once prep has run out', () => {
    expect(formatClock(-30)).toBe('0:00')
  })
})
