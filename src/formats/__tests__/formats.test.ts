/**
 * Format registry invariants.
 *
 * These are the rules a debater would notice being wrong within one round — speech length,
 * who may reply, when POIs open, and which seats owe an extension.
 */

import { describe, expect, it } from 'vitest'

import {
  AP_FORMAT,
  BP_FORMAT,
  FORMATS,
  getFormat,
  getRole,
  isPoiAllowed,
  requiresExtension,
  type Format,
} from '../index.ts'

const allFormats: Format[] = Object.values(FORMATS)

describe('shared invariants', () => {
  it.each(allFormats)('$id runs 7-minute substantives', (format) => {
    expect(format.speechSeconds).toBe(420)
  })

  it.each(allFormats)('$id opens POIs from 1:00 to 6:00', (format) => {
    expect(format.poiWindowSeconds).toEqual([60, 360])
  })

  it.each(allFormats)('$id gives every role a unique id', (format) => {
    const ids = format.roles.map((role) => role.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(allFormats)('$id splits roles evenly between benches', (format) => {
    const government = format.roles.filter((role) => role.side === 'gov')
    const opposition = format.roles.filter((role) => role.side === 'opp')
    expect(government).toHaveLength(opposition.length)
  })
})

describe('Asian Parliamentary', () => {
  it('seats three speakers a side', () => {
    expect(AP_FORMAT.roles).toHaveLength(6)
  })

  it('has a 4-minute reply', () => {
    expect(AP_FORMAT.replySeconds).toBe(240)
  })

  it('lets the first two speakers reply but never the whip', () => {
    const repliers = AP_FORMAT.roles.filter((role) => role.canGiveReply).map((role) => role.id)
    expect(repliers).toEqual(['ap-pm', 'ap-dpm', 'ap-lo', 'ap-dlo'])
  })

  it('asks nobody for an extension', () => {
    expect(AP_FORMAT.roles.filter(requiresExtension)).toHaveLength(0)
  })

  it('gives 30 minutes of prep', () => {
    expect(AP_FORMAT.prepSeconds).toBe(30 * 60)
  })
})

describe('British Parliamentary', () => {
  it('seats four teams of two', () => {
    expect(BP_FORMAT.roles).toHaveLength(8)
    const teams = new Set(BP_FORMAT.roles.map((role) => role.team))
    expect([...teams].sort()).toEqual(['cg', 'co', 'og', 'oo'])
  })

  it('has no reply speech', () => {
    expect(BP_FORMAT.replySeconds).toBeNull()
    expect(BP_FORMAT.roles.some((role) => role.canGiveReply)).toBe(false)
  })

  it('requires an extension from the closing half only', () => {
    const withExtension = BP_FORMAT.roles.filter(requiresExtension).map((role) => role.id)
    expect(withExtension).toEqual(['bp-mg', 'bp-gw', 'bp-mo', 'bp-ow'])
  })

  it('gives 15 minutes of prep', () => {
    expect(BP_FORMAT.prepSeconds).toBe(15 * 60)
  })
})

describe('lookups', () => {
  it('throws on an unknown format rather than defaulting', () => {
    // Silently coaching someone in the wrong format is worse than a crash.
    expect(() => getFormat('WSDC' as 'AP')).toThrow(/Unknown format/)
  })

  it('returns undefined for a role from another format', () => {
    expect(getRole('BP', 'ap-gov-whip')).toBeUndefined()
    expect(getRole('AP', 'ap-gov-whip')?.shortLabel).toBe('Gov Whip')
  })
})

describe('POI window', () => {
  it.each([
    [0, false],
    [59, false],
    [60, true],
    [200, true],
    [360, true],
    [361, false],
    [420, false],
  ])('at %i seconds -> %s', (elapsedSeconds, expected) => {
    expect(isPoiAllowed(AP_FORMAT, elapsedSeconds)).toBe(expected)
  })
})
