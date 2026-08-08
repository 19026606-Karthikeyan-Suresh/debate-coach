/**
 * File names suggested to the save dialog.
 *
 * Imports `export/index.ts`, the one module in this folder that talks to Tauri. That is
 * deliberate as well as convenient: the plugin modules only touch `window` when a call is made,
 * so this also pins that the export module graph loads outside the shell — which is what the
 * whole `verify.tsx` way of driving the UI depends on.
 */

import { describe, expect, it } from 'vitest'

import { localDateStamp, suggestFileName } from '../index.ts'
import { createEmptyCase } from '../../types/createCase.ts'
import { setFieldByPath } from '../../case/update.ts'
import type { Case } from '../../types/case.ts'

/** A case whose only content is the motion. */
function withMotion(motion: string): Case {
  return setFieldByPath(createEmptyCase('AP', 'gov', 'ap-pm'), 'prep.motion', motion)
}

describe('suggestFileName', () => {
  it('names the file after the motion', () => {
    expect(suggestFileName(withMotion('THW ban fake news'), 'docx')).toBe('THW ban fake news.docx')
  })

  it('falls back rather than suggesting a nameless file', () => {
    // A save dialog opened with an empty name shows no name at all and reads as broken.
    expect(suggestFileName(withMotion(''), 'dbcase')).toBe('debate-case.dbcase')
    expect(suggestFileName(withMotion('   '), 'dbcase')).toBe('debate-case.dbcase')
  })

  it('replaces the characters Windows will not accept in a name', () => {
    const motion = 'THW ban A/B "tests" <in schools>: why?'
    expect(suggestFileName(withMotion(motion), 'docx')).toBe(
      'THW ban A B tests in schools why.docx',
    )
  })

  it('falls back when the motion is nothing but forbidden characters', () => {
    expect(suggestFileName(withMotion('///'), 'docx')).toBe('debate-case.docx')
  })

  it('never ends the name in a dot or a space', () => {
    // Both are legal to create on Windows and impossible to open afterwards.
    expect(suggestFileName(withMotion('THW abolish it.'), 'docx')).toBe('THW abolish it.docx')
  })

  it('shortens a motion long enough to be a paragraph', () => {
    const long = `THW ${'very '.repeat(40)}long motion`
    const suggested = suggestFileName(withMotion(long), 'docx')
    expect(suggested.length).toBeLessThanOrEqual(85)
    expect(suggested.endsWith('.docx')).toBe(true)
  })

  it('keeps the motion’s own punctuation where the filesystem allows it', () => {
    expect(suggestFileName(withMotion('THBT Prop’s case (PROP) fails'), 'docx')).toBe(
      'THBT Prop’s case (PROP) fails.docx',
    )
  })
})

describe('localDateStamp', () => {
  it('names the local date, not the UTC one', () => {
    // Built from local parts, so this reads the same whatever zone the machine is in. The bug it
    // exists for was found by opening a real export at 01:03 and reading "exported 2026-08-08".
    const justAfterMidnight = new Date(2026, 7, 9, 0, 3)
    expect(localDateStamp(justAfterMidnight)).toBe('2026-08-09')
  })

  it('zero-pads a single-digit month and day', () => {
    expect(localDateStamp(new Date(2026, 0, 5, 13, 0))).toBe('2026-01-05')
  })

  it('does not roll over late in the evening', () => {
    // `toISOString().slice(0, 10)` returns tomorrow here for anyone west of Greenwich.
    expect(localDateStamp(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
  })
})
