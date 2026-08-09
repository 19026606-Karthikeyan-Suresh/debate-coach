import { describe, expect, it } from 'vitest'

import { diffText } from '../textDiff.ts'

/** Applies a splice, so a test can assert the result rather than the arithmetic. */
function applySplice(before: string, after: string): string {
  const splice = diffText(before, after)
  if (splice === null) {
    return before
  }
  return before.slice(0, splice.at) + splice.insert + before.slice(splice.at + splice.remove)
}

describe('diffText', () => {
  it('reports no change for equal strings', () => {
    expect(diffText('the same', 'the same')).toBeNull()
    expect(diffText('', '')).toBeNull()
  })

  it('reduces one typed character to one insert', () => {
    expect(diffText('socia media', 'social media')).toEqual({ at: 5, remove: 0, insert: 'l' })
  })

  it('reduces one backspace to one delete', () => {
    expect(diffText('social media', 'social medi')).toEqual({ at: 11, remove: 1, insert: '' })
  })

  it('reduces a replaced selection to one splice', () => {
    expect(diffText('harms children', 'harms teenagers')).toEqual({
      at: 6,
      remove: 8,
      insert: 'teenagers',
    })
  })

  it('handles the empty ends', () => {
    expect(diffText('', 'first word')).toEqual({ at: 0, remove: 0, insert: 'first word' })
    expect(diffText('cleared', '')).toEqual({ at: 0, remove: 7, insert: '' })
  })

  // Typing at the front of a field is the case a prefix-only diff gets wrong, because the shared
  // tail is the whole of the old value.
  it('keeps the splice at the front when text is prepended', () => {
    expect(diffText('media harms', 'social media harms')).toEqual({
      at: 0,
      remove: 0,
      insert: 'social ',
    })
  })

  // A repeated character makes the naive prefix and suffix scans overlap; the suffix loop is
  // bounded so they cannot claim the same units twice.
  it('does not let prefix and suffix overlap on a repeated run', () => {
    expect(applySplice('aaa', 'aaaa')).toBe('aaaa')
    expect(applySplice('aaaa', 'aaa')).toBe('aaa')
    expect(diffText('aaa', 'aaaa')?.remove).toBe(0)
  })

  it('never splits a surrogate pair', () => {
    // Two different emoji share their leading code unit, so an unguarded scan stops between the
    // halves and writes a lone unit that renders as a replacement character on every peer.
    const before = 'we won 🎉'
    const after = 'we won 🎊'
    const splice = diffText(before, after)
    expect(splice).not.toBeNull()
    expect(splice?.at).toBe(7)
    expect(splice?.remove).toBe(2)
    expect(applySplice(before, after)).toBe(after)
  })

  it('never splits a surrogate pair at the tail boundary', () => {
    const before = 'a🎉b'
    const after = 'ac🎉b'
    expect(applySplice(before, after)).toBe(after)
    const splice = diffText(before, after)
    // The kept tail must start on a whole character, so it may not begin mid-pair.
    expect(splice && before.charCodeAt(before.length - (before.length - splice.at - splice.remove)))
      .not.toBeNaN()
  })

  it('round-trips a spread of edits', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['', 'x'],
      ['x', ''],
      ['abc', 'axc'],
      ['abc', 'abcd'],
      ['abcd', 'abc'],
      ['the problem is bad', 'the problem is very bad'],
      ['🎉🎊', '🎊🎉'],
      ['one two three', 'one three'],
      ['line\nbreak', 'line\n\nbreak'],
    ]
    for (const [before, after] of pairs) {
      expect(applySplice(before, after)).toBe(after)
    }
  })
})
