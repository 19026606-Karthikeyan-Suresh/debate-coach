/**
 * Completeness scoring and the prep-timer nudge.
 *
 * The scoring only means anything if it is scoped to the seat, so the sharpest test here is
 * that two roles measure the *same* case differently.
 */

import { describe, expect, it } from 'vitest'

import { getRole } from '../../formats/index.ts'
import { createEmptyCase } from '../../types/createCase.ts'
import { measureCase, phraseNudge } from '../completeness.ts'
import { ensureRequiredBlocks, setFieldByPath } from '../update.ts'

const primeMinister = getRole('AP', 'ap-pm')
const whip = getRole('AP', 'ap-gov-whip')
if (!primeMinister || !whip) {
  throw new Error('AP is missing a role the tests need')
}

const emptyCase = ensureRequiredBlocks(createEmptyCase('AP', 'gov', 'ap-pm'), primeMinister)

describe('measureCase', () => {
  it('scores an untouched case at zero', () => {
    const measured = measureCase(emptyCase, primeMinister)
    expect(measured.filled).toBe(0)
    expect(measured.ratio).toBe(0)
  })

  it('counts a field only once it holds real text', () => {
    const spaced = setFieldByPath(emptyCase, 'prep.motion', '   ')
    expect(measureCase(spaced, primeMinister).filled).toBe(0)

    const written = setFieldByPath(emptyCase, 'prep.motion', 'THW ban political advertising')
    expect(measureCase(written, primeMinister).filled).toBe(1)
  })

  it('measures the same case differently for two seats', () => {
    const asFirstSpeaker = measureCase(emptyCase, primeMinister)
    const asWhip = measureCase(emptyCase, whip)

    // Not just different numbers — the whip is not asked for the substantive tables at all.
    expect(asWhip.total).not.toBe(asFirstSpeaker.total)
    expect(asWhip.sections.map((section) => section.sectionId)).not.toContain('definition')
  })

  it('reports per-section progress', () => {
    const written = setFieldByPath(emptyCase, 'definition.meaning', 'Advertising means...')
    const definition = measureCase(written, primeMinister).sections.find(
      (section) => section.sectionId === 'definition',
    )

    expect(definition?.filled).toBe(1)
    expect(definition?.total).toBe(4)
    expect(definition?.ratio).toBeCloseTo(0.25)
  })
})

describe('nextGap', () => {
  it('points at the first hole in document order', () => {
    // Document order is deliberate: the template's order is the order to prep in, so the
    // topmost blank is the next thing to write, not the "most important" blank.
    expect(measureCase(emptyCase, primeMinister).nextGap?.field.path).toBe('prep.motion')
  })

  it('moves on as fields get filled', () => {
    const written = setFieldByPath(emptyCase, 'prep.motion', 'THW ban political advertising')
    expect(measureCase(written, primeMinister).nextGap?.field.path).toBe('prep.actorsSplit')
  })

  it('names the section so the nudge can say where to go', () => {
    const gap = measureCase(emptyCase, primeMinister).nextGap
    expect(gap?.navLabel).toBe('Prep')
  })
})

describe('phraseNudge', () => {
  const measured = measureCase(emptyCase, primeMinister)

  it('leads with the time left', () => {
    expect(phraseNudge(measured, 240)).toBe('4 min left — Prep — Motion:')
  })

  it('rounds up, so it never promises more time than there is', () => {
    expect(phraseNudge(measured, 200)).toMatch(/^4 min left/)
  })

  it('drops the clause once prep has run out', () => {
    expect(phraseNudge(measured, 0)).toBe('Prep — Motion:')
    expect(phraseNudge(measured, -30)).toBe('Prep — Motion:')
  })

  it('returns null when there is nothing left to fill', () => {
    const nothingLeft = { ...measured, nextGap: null }
    expect(phraseNudge(nothingLeft, 240)).toBeNull()
  })
})
