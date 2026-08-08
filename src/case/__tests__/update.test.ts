/**
 * Path-addressed edits and structural changes.
 *
 * The important test here is `every addressable field round-trips`: it walks every seat in
 * both formats, writes through every path `buildSections` handed out, and asserts the case
 * comes back 100% complete. That covers every branch of the path router at once, and it is
 * what stops a field being rendered but silently unwritable — the failure mode where a
 * debater types into a box and the text is gone when they come back to it.
 */

import { describe, expect, it } from 'vitest'

import { FORMATS, getRole } from '../../formats/index.ts'
import type { Case } from '../../types/case.ts'
import { createEmptyCase } from '../../types/createCase.ts'
import { measureCase } from '../completeness.ts'
import { buildSections, flattenFields } from '../sections.ts'
import {
  addClash,
  addEngagement,
  addHandledArgument,
  addPointOfInformation,
  addPreempt,
  addSubstantive,
  ensureRequiredBlocks,
  removeEngagement,
  removePointOfInformation,
  removePreempt,
  removeSubstantive,
  setEngagementIsExtension,
  setFieldByPath,
  setNeedsMechanism,
  setVisibility,
} from '../update.ts'

/**
 * Writes something into every field a seat is asked to fill.
 *
 * @param caseFile - A seeded case.
 * @param role - The seat whose fields get filled.
 * @returns The case with no blank fields left.
 */
function fillEverything(caseFile: Case, role: Parameters<typeof buildSections>[1]): Case {
  let filled = caseFile
  for (const entry of flattenFields(buildSections(caseFile, role))) {
    // The mechanism question is a tri-state, not free text; anything else would store a
    // decision the UI cannot render back.
    const value = entry.path === 'prep.needsMechanism' ? 'yes' : 'answered'
    filled = setFieldByPath(filled, entry.path, value)
  }
  return filled
}

describe('every addressable field round-trips', () => {
  const seats = Object.values(FORMATS).flatMap((format) =>
    format.roles.map((role) => [format.id, role.id] as const),
  )

  it.each(seats)('%s %s', (formatId, roleId) => {
    const role = getRole(formatId, roleId)
    if (!role) {
      throw new Error(`Missing role ${roleId}`)
    }
    const seeded = ensureRequiredBlocks(createEmptyCase(formatId, role.side, role.id), role)

    expect(measureCase(seeded, role).filled).toBe(0)

    const filled = fillEverything(seeded, role)
    const measured = measureCase(filled, role)

    expect(measured.total).toBeGreaterThan(0)
    expect(measured.filled).toBe(measured.total)
    expect(measured.nextGap).toBeNull()
  })
})

describe('setFieldByPath', () => {
  const role = getRole('AP', 'ap-pm')
  if (!role) {
    throw new Error('AP is missing its PM role')
  }
  const baseCase = ensureRequiredBlocks(createEmptyCase('AP', 'gov', 'ap-pm'), role)

  it('writes a nested prep field', () => {
    const edited = setFieldByPath(baseCase, 'prep.fiveW1H.who', 'gig drivers')
    expect(edited.prep.fiveW1H.who).toBe('gig drivers')
  })

  it('leaves the original untouched', () => {
    setFieldByPath(baseCase, 'prep.motion', 'THW ban X')
    expect(baseCase.prep.motion).toBe('')
  })

  it('stamps updatedAt', () => {
    const edited = setFieldByPath(baseCase, 'prep.motion', 'THW ban X')
    expect(edited.updatedAt >= baseCase.updatedAt).toBe(true)
  })

  it('does not trim mid-typing', () => {
    const edited = setFieldByPath(baseCase, 'prep.motion', 'THW ban ')
    expect(edited.prep.motion).toBe('THW ban ')
  })

  it('throws on a field the block does not have', () => {
    expect(() => setFieldByPath(baseCase, 'prep.notAField', 'x')).toThrow(/No such field/)
  })

  it('throws on an item id that no longer exists', () => {
    expect(() => setFieldByPath(baseCase, 'substantives.gone.whyBad', 'x')).toThrow(/No such item/)
  })

  it('throws on a path it cannot route at all', () => {
    expect(() => setFieldByPath(baseCase, 'nonsense.field', 'x')).toThrow(/Unroutable/)
  })
})

describe('the mechanism question governs the policy table', () => {
  const role = getRole('AP', 'ap-pm')
  if (!role) {
    throw new Error('AP is missing its PM role')
  }
  const baseCase = createEmptyCase('AP', 'gov', 'ap-pm')

  it('drops the policy block on "no"', () => {
    expect(setNeedsMechanism(baseCase, 'no').policy).toBeNull()
  })

  it('starts a clean policy block when the answer flips back', () => {
    const withText = setFieldByPath(baseCase, 'policy.problem', 'old text')
    const restored = setNeedsMechanism(setNeedsMechanism(withText, 'no'), 'yes')

    // Deliberate: text written for a policy the debater then discarded should not reappear.
    expect(restored.policy?.problem).toBe('')
  })

  it('is reachable through the field path, so the tri-state needs no special case', () => {
    expect(setFieldByPath(baseCase, 'prep.needsMechanism', 'no').policy).toBeNull()
  })
})

describe('repeatable blocks', () => {
  const baseCase = createEmptyCase('AP', 'gov', 'ap-pm')

  it('adds and removes a substantive', () => {
    const added = addSubstantive(baseCase)
    expect(added.substantives).toHaveLength(baseCase.substantives.length + 1)

    const lastId = added.substantives[added.substantives.length - 1]?.id ?? ''
    expect(removeSubstantive(added, lastId).substantives).toHaveLength(
      baseCase.substantives.length,
    )
  })

  it('treats removing something already gone as a no-op', () => {
    expect(removeSubstantive(baseCase, 'never-existed').substantives).toHaveLength(
      baseCase.substantives.length,
    )
  })

  it('adds and removes a POI', () => {
    const added = addPointOfInformation(baseCase)
    expect(added.prep.pois).toHaveLength(1)
    expect(removePointOfInformation(added, added.prep.pois[0]?.id ?? '').prep.pois).toHaveLength(0)
  })

  it('adds an engagement of the requested kind', () => {
    const withClash = addClash(baseCase)
    const clashId = withClash.clashes[withClash.clashes.length - 1]?.id ?? ''
    const added = addEngagement(withClash, clashId, 'overlap')
    const clash = added.clashes.find((item) => item.id === clashId)

    expect(clash?.engagements.at(-1)?.kind).toBe('overlap')
  })

  it('removes an engagement without disturbing its clash', () => {
    const withClash = addClash(baseCase)
    const clashId = withClash.clashes[withClash.clashes.length - 1]?.id ?? ''
    const added = addEngagement(withClash, clashId, 'our-argument')
    const engagementId = added.clashes.find((item) => item.id === clashId)?.engagements[0]?.id ?? ''
    const removed = removeEngagement(added, clashId, engagementId)

    expect(removed.clashes.find((item) => item.id === clashId)?.engagements).toHaveLength(0)
    expect(removed.clashes).toHaveLength(withClash.clashes.length)
  })

  it('throws when the clash an engagement was added to is gone', () => {
    expect(() => addEngagement(baseCase, 'gone', 'overlap')).toThrow(/No such item/)
  })

  it('adds a signposted argument on the requested bench', () => {
    const withClash = addClash(baseCase)
    const clashId = withClash.clashes[withClash.clashes.length - 1]?.id ?? ''
    const added = addHandledArgument(withClash, clashId, 'opp')

    expect(added.clashes.find((item) => item.id === clashId)?.handledArguments[0]?.side).toBe('opp')
  })
})

describe('extension flag', () => {
  const role = getRole('BP', 'bp-gw')
  if (!role) {
    throw new Error('BP is missing its government whip role')
  }
  const baseCase = ensureRequiredBlocks(createEmptyCase('BP', 'gov', 'bp-gw'), role)

  it('marks the engagement that carries the extension', () => {
    const clashId = baseCase.clashes[0]?.id ?? ''
    const engagementId = baseCase.clashes[0]?.engagements[0]?.id ?? ''
    const flagged = setEngagementIsExtension(baseCase, clashId, engagementId, true)
    const engagement = flagged.clashes[0]?.engagements[0]

    expect(engagement?.kind === 'overlap' ? null : engagement?.response.responded.isExtension).toBe(
      true,
    )
  })

  it('refuses on an overlap engagement, which has no such paragraph', () => {
    const clashId = baseCase.clashes[0]?.id ?? ''
    const withOverlap = addEngagement(baseCase, clashId, 'overlap')
    const overlapId = withOverlap.clashes[0]?.engagements.at(-1)?.id ?? ''

    expect(() => setEngagementIsExtension(withOverlap, clashId, overlapId, true)).toThrow(
      /no extension flag/,
    )
  })
})

describe('ensureRequiredBlocks', () => {
  it('seeds a whip a clash they can start typing into', () => {
    const role = getRole('AP', 'ap-gov-whip')
    if (!role) {
      throw new Error('AP is missing its government whip role')
    }
    const seeded = ensureRequiredBlocks(createEmptyCase('AP', 'gov', 'ap-gov-whip'), role)

    expect(seeded.opposingRebuttals.length).toBeGreaterThan(0)
    expect(seeded.clashes[0]?.engagements.length).toBeGreaterThan(0)
    expect(seeded.clashes[0]?.handledArguments.length).toBeGreaterThan(0)
  })

  it('points a whip’s first signposted argument at the other bench', () => {
    const role = getRole('AP', 'ap-gov-whip')
    if (!role) {
      throw new Error('AP is missing its government whip role')
    }
    const seeded = ensureRequiredBlocks(createEmptyCase('AP', 'gov', 'ap-gov-whip'), role)
    expect(seeded.clashes[0]?.handledArguments[0]?.side).toBe('opp')
  })

  it('gives a BP closing seat an extension block and an opening seat none', () => {
    const closing = getRole('BP', 'bp-mg')
    const opening = getRole('BP', 'bp-pm')
    if (!closing || !opening) {
      throw new Error('BP is missing a role')
    }

    expect(ensureRequiredBlocks(createEmptyCase('BP', 'gov', 'bp-mg'), closing).extension).not.toBe(
      null,
    )
    expect(ensureRequiredBlocks(createEmptyCase('BP', 'gov', 'bp-pm'), opening).extension).toBeNull()
  })

  it('returns the same object when nothing was missing, so opening a case is not an edit', () => {
    const role = getRole('AP', 'ap-pm')
    if (!role) {
      throw new Error('AP is missing its PM role')
    }
    const seeded = ensureRequiredBlocks(createEmptyCase('AP', 'gov', 'ap-pm'), role)
    expect(ensureRequiredBlocks(seeded, role)).toBe(seeded)
  })
})

describe('preempts', () => {
  /** A seeded AP first-speaker case, which always has exactly one substantive to hang them off. */
  function seededCase(): Case {
    const role = getRole('AP', 'ap-pm')
    if (!role) {
      throw new Error('AP is missing its PM role')
    }
    return ensureRequiredBlocks(createEmptyCase('AP', 'gov', 'ap-pm'), role)
  }

  it('stores the attack and leaves the answer blank whoever wrote it', () => {
    const baseCase = seededCase()
    const substantiveId = baseCase.substantives[0]?.id ?? ''
    const added = addPreempt(baseCase, substantiveId, 'No regulator has ever acted.', 'claude')
    const preempt = added.substantives[0]?.preempts[0]

    expect(preempt?.attack).toBe('No regulator has ever acted.')
    // Answering it is the exercise; an attack that arrives answered has taught nothing.
    expect(preempt?.response).toBe('')
    expect(preempt?.source).toBe('claude')
  })

  it('routes a preempt path through setFieldByPath like any other field', () => {
    const baseCase = seededCase()
    const substantiveId = baseCase.substantives[0]?.id ?? ''
    const added = addPreempt(baseCase, substantiveId, 'Your actor cannot act.', 'claude')
    const preemptId = added.substantives[0]?.preempts[0]?.id ?? ''

    const answered = setFieldByPath(
      added,
      `substantives.${substantiveId}.preempts.${preemptId}.response`,
      'It acts because the fine exceeds the ad revenue.',
    )
    expect(answered.substantives[0]?.preempts[0]?.response).toBe(
      'It acts because the fine exceeds the ad revenue.',
    )
  })

  it('refuses a preempt path that does not resolve, rather than writing nothing', () => {
    const baseCase = seededCase()
    const substantiveId = baseCase.substantives[0]?.id ?? ''
    expect(() =>
      setFieldByPath(baseCase, `substantives.${substantiveId}.preempts.gone.response`, 'x'),
    ).toThrow(/No such item/)
  })

  /**
   * Preempts are not in `buildSections`, so they must not reach the meter either — asking Claude
   * for three attacks would otherwise drop a finished case from 100% to 70%.
   */
  it('does not count against completeness', () => {
    const role = getRole('AP', 'ap-pm')
    if (!role) {
      throw new Error('AP is missing its PM role')
    }
    const filled = fillEverything(seededCase(), role)
    const substantiveId = filled.substantives[0]?.id ?? ''
    const withAttack = addPreempt(filled, substantiveId, 'Your actor cannot act.', 'claude')

    expect(measureCase(withAttack, role).ratio).toBe(1)
    expect(measureCase(withAttack, role).total).toBe(measureCase(filled, role).total)
  })

  it('drops one attack and leaves the rest', () => {
    const baseCase = seededCase()
    const substantiveId = baseCase.substantives[0]?.id ?? ''
    const two = addPreempt(
      addPreempt(baseCase, substantiveId, 'First.', 'claude'),
      substantiveId,
      'Second.',
      'manual',
    )
    const firstId = two.substantives[0]?.preempts[0]?.id ?? ''

    const remaining = removePreempt(two, substantiveId, firstId).substantives[0]?.preempts
    expect(remaining?.map((preempt) => preempt.attack)).toEqual(['Second.'])
  })
})

describe('predicted POIs', () => {
  it('files the question and leaves the response for the debater', () => {
    const added = addPointOfInformation(
      createEmptyCase('AP', 'gov', 'ap-pm'),
      'Who decides what counts as fake?',
    )
    expect(added.prep.pois[0]?.text).toBe('Who decides what counts as fake?')
    expect(added.prep.pois[0]?.response).toBe('')
  })

  it('still adds an empty row for the editor’s own button', () => {
    expect(addPointOfInformation(createEmptyCase('AP', 'gov', 'ap-pm')).prep.pois[0]?.text).toBe('')
  })
})

describe('case settings', () => {
  it('changes visibility without touching the document', () => {
    const baseCase = createEmptyCase('AP', 'gov', 'ap-pm')
    const shared = setVisibility(baseCase, 'team')

    expect(shared.visibility).toBe('team')
    expect(shared.prep).toEqual(baseCase.prep)
  })
})
