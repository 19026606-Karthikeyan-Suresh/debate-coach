/**
 * The edit overlay: rewrites survive a recompile, and an edited segment stops pretending to
 * know where its words came from.
 */

import { describe, expect, it } from 'vitest'

import { setFieldByPath } from '../../case/update.ts'
import { getRole } from '../../formats/index.ts'
import type { SpeakerRole } from '../../formats/index.ts'
import { compileScript } from '../compile.ts'
import { applyEdits, clearEdit, orphanedEditIds, setEdit } from '../edits.ts'
import { buildWhipCase } from './whipFixture.ts'

const WHIP: SpeakerRole = getRole('BP', 'bp-ow') as SpeakerRole
const ENGAGEMENT_ID = 'clashes.clash-1#engagement.engagement-1'

describe('applyEdits', () => {
  const script = compileScript(buildWhipCase(), WHIP)

  it('returns the same script when there is nothing to lay over', () => {
    expect(applyEdits(script, {})).toBe(script)
  })

  it('replaces one segment and leaves the rest alone', () => {
    const edited = applyEdits(script, {
      [ENGAGEMENT_ID]: 'They said platforms would over-remove. My deputy already answered that.',
    })
    const target = edited.segments.find((item) => item.id === ENGAGEMENT_ID)

    expect(target?.text).toBe(
      'They said platforms would over-remove. My deputy already answered that.',
    )
    expect(target?.isEdited).toBe(true)
    expect(edited.segments.filter((item) => item.isEdited)).toHaveLength(1)
    expect(edited.segments.map((item) => item.id)).toEqual(script.segments.map((item) => item.id))
  })

  it('drops the provenance rather than guessing at it', () => {
    const edited = applyEdits(script, { [ENGAGEMENT_ID]: 'They said platforms would over-remove.' })
    const target = edited.segments.find((item) => item.id === ENGAGEMENT_ID)
    expect(target?.tokens.every((token) => token.fieldPath === null)).toBe(true)
  })

  it('renumbers every token after the edit', () => {
    const edited = applyEdits(script, { [ENGAGEMENT_ID]: 'One short line.' })
    expect(edited.tokens.map((token) => token.index)).toEqual(
      edited.tokens.map((_token, position) => position),
    )
    expect(edited.wordCount).toBe(edited.tokens.length)
    expect(edited.wordCount).toBeLessThan(script.wordCount)
  })

  it('takes a segment out of delivery when the edit is empty', () => {
    const edited = applyEdits(script, { [ENGAGEMENT_ID]: '' })
    expect(edited.segments.map((item) => item.id)).not.toContain(ENGAGEMENT_ID)
  })

  it('ignores an edit whose segment is gone', () => {
    const edited = applyEdits(script, { 'substantives.nope#body': 'anything' })
    expect(edited.segments.map((item) => item.id)).toEqual(script.segments.map((item) => item.id))
  })

  it('survives an edit to the case it was compiled from', () => {
    // The whole reason segment ids are derived from case ids rather than counted.
    const edits = setEdit({}, ENGAGEMENT_ID, 'My own wording, kept.')
    const recompiled = compileScript(
      setFieldByPath(buildWhipCase(), 'setup.stance', 'A different stance entirely.'),
      WHIP,
    )

    const edited = applyEdits(recompiled, edits)
    expect(edited.segments.find((item) => item.id === ENGAGEMENT_ID)?.text).toBe(
      'My own wording, kept.',
    )
    expect(edited.segments.find((item) => item.id === 'setup#opening')?.text).toContain(
      'A different stance entirely.',
    )
  })
})

describe('orphanedEditIds', () => {
  const script = compileScript(buildWhipCase(), WHIP)

  it('finds nothing when every edit still has a segment', () => {
    expect(orphanedEditIds(script, { [ENGAGEMENT_ID]: 'text' })).toEqual([])
  })

  it('names an edit whose engagement was deleted', () => {
    expect(orphanedEditIds(script, { 'clashes.clash-9#engagement.gone': 'text' })).toEqual([
      'clashes.clash-9#engagement.gone',
    ])
  })
})

describe('setEdit and clearEdit', () => {
  it('do not modify the record they are given', () => {
    const before = setEdit({}, ENGAGEMENT_ID, 'first')
    const after = setEdit(before, 'other#body', 'second')
    expect(Object.keys(before)).toEqual([ENGAGEMENT_ID])
    expect(Object.keys(after)).toHaveLength(2)
  })

  it('restore the compiled text on clear', () => {
    const script = compileScript(buildWhipCase(), WHIP)
    const edits = clearEdit(setEdit({}, ENGAGEMENT_ID, 'rewritten'), ENGAGEMENT_ID)
    expect(applyEdits(script, edits).segments.find((item) => item.id === ENGAGEMENT_ID)?.text).toBe(
      script.segments.find((item) => item.id === ENGAGEMENT_ID)?.text,
    )
  })
})
