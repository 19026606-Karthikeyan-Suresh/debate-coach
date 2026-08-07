/**
 * Field classification.
 *
 * The three cases worth pinning are the three the analyzer would otherwise get wrong: a speaker
 * position judged as prose, an opponent's argument graded for hedges, and the scratch pad graded
 * at all.
 */

import { describe, expect, it } from 'vitest'

import { buildSections, flattenFields } from '../../case/sections.ts'
import type { CaseField } from '../../case/sections.ts'
import { fieldKey, fieldKind, fieldsOfKind, isCoreField, substantiveViews } from '../scope.ts'
import { buildFilledExampleCase } from './fixture.ts'
import { FIRST_SPEAKER, WHIP } from './harness.ts'

const filledExample = buildFilledExampleCase()

/** Looks a field up by path in a seat's projection. */
function fieldAt(path: string, role = FIRST_SPEAKER): CaseField {
  const found = flattenFields(buildSections(filledExample, role)).find(
    (field) => field.path === path,
  )
  if (!found) {
    throw new Error(`No field at ${path}`)
  }
  return found
}

describe('fieldKey', () => {
  it('takes the property name off the end of a path', () => {
    expect(fieldKey('substantives.sub-1.whyBad')).toBe('whyBad')
    expect(fieldKey('clashes.aa.engagements.bb.responded.whyWrong')).toBe('whyWrong')
  })
})

describe('fieldKind', () => {
  it('treats our own reasoning as argument', () => {
    expect(fieldKind(fieldAt('substantives.sub-1.whyBad'))).toBe('argument')
  })

  it('treats the other side’s material as a report', () => {
    // Grading a hedge in "What can Opp say to our policy?" grades the opponent, not the debater.
    expect(fieldKind(fieldAt('policy.whatOppCanSay'))).toBe('report')
  })

  it('treats the actor split and 5W1H as names that must be specific', () => {
    expect(fieldKind(fieldAt('prep.actorsSplit'))).toBe('name')
    expect(fieldKind(fieldAt('prep.fiveW1H.who'))).toBe('name')
  })

  it('skips the motion and the scratch pad', () => {
    expect(fieldKind(fieldAt('prep.motion'))).toBe('skip')
    expect(fieldKind(fieldAt('prep.scratch'))).toBe('skip')
  })

  it('skips a one-row box, which holds a name and never prose', () => {
    expect(fieldKind(fieldAt('setup.caseDivision.sub1'))).toBe('skip')
  })
})

describe('isCoreField', () => {
  it('marks the rows a judge weighs the round on', () => {
    expect(isCoreField(fieldAt('substantives.sub-1.whyBad'))).toBe(true)
    expect(isCoreField(fieldAt('substantives.sub-1.counterfactual'))).toBe(true)
  })

  it('leaves the narrative rows out', () => {
    expect(isCoreField(fieldAt('substantives.sub-1.example'))).toBe(false)
    expect(isCoreField(fieldAt('substantives.sub-1.oneSentence'))).toBe(false)
  })
})

describe('fieldsOfKind', () => {
  const fields = flattenFields(buildSections(filledExample, FIRST_SPEAKER))

  it('drops empty fields, which belong to the completeness meter', () => {
    const selected = fieldsOfKind(fields, ['argument'])
    expect(selected.every((field) => field.value.trim().length > 0)).toBe(true)
    expect(selected.some((field) => field.path === 'substantives.sub-1.link')).toBe(false)
  })

  it('returns only the kinds asked for', () => {
    const named = fieldsOfKind(fields, ['name'])
    expect(named.map((field) => field.path)).toEqual([
      'prep.actorsSplit',
      'prep.fiveW1H.who',
      'prep.fiveW1H.what',
      'prep.fiveW1H.where',
    ])
  })
})

describe('substantiveViews', () => {
  it('regroups each substantive with its rows keyed by template row', () => {
    const views = substantiveViews(buildSections(filledExample, FIRST_SPEAKER))
    expect(views.map((view) => view.navLabel)).toEqual(['Sub 1', 'Sub 2', 'Sub 3'])
    expect(views[0]?.byKey.get('whyBad')?.path).toBe('substantives.sub-1.whyBad')
  })

  it('joins only the written rows into the whole-substantive text', () => {
    const views = substantiveViews(buildSections(filledExample, FIRST_SPEAKER))
    expect(views[2]?.text).toBe('')
    expect(views[0]?.text).toContain('irrecoverable')
  })

  it('is empty for a seat with no substantive block', () => {
    expect(substantiveViews(buildSections(filledExample, WHIP))).toEqual([])
  })
})
