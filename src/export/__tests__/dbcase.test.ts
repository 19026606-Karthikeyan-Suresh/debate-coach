/**
 * The `.dbcase` round trip, and the rule that a re-import never overwrites.
 */

import { describe, expect, it } from 'vitest'

import { buildFilledExampleCase } from '../../analysis/__tests__/fixture.ts'
import { createEmptyCase } from '../../types/createCase.ts'
import { buildDbcase, DBCASE_KIND, DBCASE_VERSION, readDbcase } from '../dbcase.ts'

const EXPORTED_AT = '2026-08-09T10:30:00.000Z'
const IMPORTED_AT = '2026-08-10T09:00:00.000Z'

describe('buildDbcase', () => {
  it('writes an envelope naming the format', () => {
    const parsed = JSON.parse(buildDbcase(buildFilledExampleCase(), EXPORTED_AT)) as {
      kind: string
      version: number
      exportedAt: string
    }
    expect(parsed.kind).toBe(DBCASE_KIND)
    expect(parsed.version).toBe(DBCASE_VERSION)
    expect(parsed.exportedAt).toBe(EXPORTED_AT)
  })

  it('ends in a newline, because this file gets diffed', () => {
    expect(buildDbcase(createEmptyCase('BP', 'opp', 'bp-ow'), EXPORTED_AT).endsWith('\n')).toBe(true)
  })
})

describe('readDbcase', () => {
  it('restores a case that is not already here, exactly as it left', () => {
    const original = buildFilledExampleCase()
    const imported = readDbcase(buildDbcase(original, EXPORTED_AT), [], IMPORTED_AT)

    expect(imported.outcome).toBe('restored')
    expect(imported.caseFile).toEqual(original)
  })

  it('keeps the timestamps on a restore', () => {
    // `saveCase` writes `updatedAt` off the document rather than the clock precisely so this
    // holds: a case restored from a backup is the case that was backed up, not a new one.
    const original = buildFilledExampleCase()
    const imported = readDbcase(buildDbcase(original, EXPORTED_AT), [], IMPORTED_AT)

    expect(imported.caseFile.createdAt).toBe(original.createdAt)
    expect(imported.caseFile.updatedAt).toBe(original.updatedAt)
  })

  it('imports as a copy when the id is already on this machine', () => {
    const original = buildFilledExampleCase()
    const imported = readDbcase(buildDbcase(original, EXPORTED_AT), [original.id], IMPORTED_AT)

    expect(imported.outcome).toBe('copied')
    expect(imported.caseFile.id).not.toBe(original.id)
    // Everything except the identity is the same case, so the copy is worth having.
    expect(imported.caseFile.prep).toEqual(original.prep)
    expect(imported.caseFile.substantives).toEqual(original.substantives)
  })

  it('sorts a copy to the top of the library and leaves its creation date alone', () => {
    const original = buildFilledExampleCase()
    const imported = readDbcase(buildDbcase(original, EXPORTED_AT), [original.id], IMPORTED_AT)

    expect(imported.caseFile.updatedAt).toBe(IMPORTED_AT)
    expect(imported.caseFile.createdAt).toBe(original.createdAt)
  })

  it('fills in a block written before it existed', () => {
    // The reason import goes through `hydrateCase`: a file exported by an older build parses
    // into a `Case` with a key missing, and `strict` did not catch it because the parse is a cast.
    const envelope = {
      kind: DBCASE_KIND,
      version: DBCASE_VERSION,
      exportedAt: EXPORTED_AT,
      case: { id: 'old', prep: { motion: 'THW do the thing' } },
    }
    const imported = readDbcase(JSON.stringify(envelope), [], IMPORTED_AT)

    expect(imported.caseFile.prep.motion).toBe('THW do the thing')
    expect(imported.caseFile.definition.meaning).toBe('')
    expect(imported.caseFile.clashes).toEqual([])
  })
})

describe('what readDbcase refuses', () => {
  it('refuses text that is not JSON', () => {
    expect(() => readDbcase('not json at all', [], IMPORTED_AT)).toThrow(/not valid JSON/)
  })

  it('refuses JSON that is not a case file', () => {
    expect(() => readDbcase('{"hello":"world"}', [], IMPORTED_AT)).toThrow(
      /not a Debate Coach case file/,
    )
  })

  it('refuses a bare array', () => {
    expect(() => readDbcase('[]', [], IMPORTED_AT)).toThrow(/not a Debate Coach case file/)
  })

  it('refuses a file from a newer version by name', () => {
    const envelope = { kind: DBCASE_KIND, version: DBCASE_VERSION + 1, case: {} }
    // Not "corrupt": the fix is to update the app, and the message has to say which it is.
    expect(() => readDbcase(JSON.stringify(envelope), [], IMPORTED_AT)).toThrow(
      /newer version of Debate Coach/,
    )
  })

  it('refuses an envelope with no version', () => {
    const envelope = { kind: DBCASE_KIND, case: {} }
    expect(() => readDbcase(JSON.stringify(envelope), [], IMPORTED_AT)).toThrow(
      /does not say which version/,
    )
  })

  it('refuses an envelope whose case is not an object', () => {
    const envelope = { kind: DBCASE_KIND, version: DBCASE_VERSION, case: 'nope' }
    expect(() => readDbcase(JSON.stringify(envelope), [], IMPORTED_AT)).toThrow()
  })
})
