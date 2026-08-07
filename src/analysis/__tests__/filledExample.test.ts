/**
 * The regression fixture — a real filled case, with real defects.
 *
 * `reference/template-filled-example.docx` is a case a debater actually wrote and handed over.
 * The defects asserted below are the ones a coach reading it would name, listed in `PLAN.md`
 * before any of these rules existed. That order matters: the rules were written to catch what a
 * human already found in this document, not tuned afterwards until the numbers looked good.
 *
 * The last two tests are the ones that stop this file rotting into a rubber stamp — they pin
 * what the analyzer must **not** say, which is where a heuristic set actually fails.
 */

import { describe, expect, it } from 'vitest'

import { measureCase } from '../../case/completeness.ts'
import { buildSections, flattenFields } from '../../case/sections.ts'
import { setFieldByPath } from '../../case/update.ts'
import { countBySeverity, findingKey, groupFindingsByPath, runAnalysis } from '../index.ts'
import { SEVERITY_ORDER } from '../types.ts'
import type { Finding, RuleId } from '../types.ts'
import { buildFilledExampleCase } from './fixture.ts'
import { FIRST_SPEAKER, WHIP } from './harness.ts'

const filledExample = buildFilledExampleCase()
const findings = runAnalysis(filledExample, FIRST_SPEAKER)

/** Findings of one rule pointing at one field. */
function at(rule: RuleId, fieldPath: string): readonly Finding[] {
  return findings.filter((finding) => finding.rule === rule && finding.fieldPath === fieldPath)
}

describe('the defects a coach found in the filled example', () => {
  it('catches that Sub 2 is Sub 1 restated', () => {
    const overlap = at('subOverlap', 'substantives.sub-2.oneSentence')
    expect(overlap).toHaveLength(1)
    expect(overlap[0]?.message).toBe('Sub 2 shares most of its vocabulary with Sub 1.')
  })

  it('catches "damages lives", "individuals in society", and "many damages"', () => {
    const flagged = findings
      .filter((finding) => finding.rule === 'vagueness')
      .map((finding) => `${finding.fieldPath}:${finding.message}`)

    expect(flagged).toContain('prep.fiveW1H.what:"lives" names nobody in particular.')
    expect(flagged).toContain('prep.actorsSplit:"Individuals" names nobody in particular.')
    expect(flagged).toContain('prep.actorsSplit:"society" names nobody in particular.')
    expect(flagged).toContain('substantives.sub-1.problem:"many" names nobody in particular.')
    expect(flagged).toContain('substantives.sub-1.problem:"damages" names nobody in particular.')
  })

  it('catches that Sub 1 argues size and permanence but never likelihood or timing', () => {
    const axes = at('impactAxes', 'substantives.sub-1.whyBad').map((finding) => finding.message)
    expect(axes).toEqual(['Sub 1 never argues probability.', 'Sub 1 never argues timeframe.'])
  })

  it('catches that Sub 2 drops the stakeholder the prep sheet named', () => {
    const dropped = at('stakeholderCoverage', 'substantives.sub-2.oneSentence')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.message).toContain('Individuals in society')
  })

  it('catches the one row that gives no underlying cause at all', () => {
    // "Why does the problem exist?" is answered with a restatement of the harm and an anecdote.
    // It is the only critical in the whole document, which is the right count for this case.
    const criticals = findings.filter((finding) => finding.severity === 'critical')
    expect(criticals.map((finding) => finding.fieldPath)).toEqual([
      'substantives.sub-1.whyExists',
    ])
    expect(criticals[0]?.rule).toBe('causalChain')
  })
})

describe('what the analyzer deliberately stays quiet about', () => {
  it('says nothing about the three blank rows, which the completeness meter already owns', () => {
    const blankPaths = [
      'substantives.sub-2.howThisSolves',
      'substantives.sub-1.example',
      'substantives.sub-1.link',
      'substantives.sub-2.example',
      'substantives.sub-2.link',
    ]
    for (const path of blankPaths) {
      expect(findings.filter((finding) => finding.fieldPath === path)).toEqual([])
    }

    // ...and the meter does own them.
    const measured = measureCase(filledExample, FIRST_SPEAKER)
    expect(measured.filled).toBeLessThan(measured.total)
  })

  it('does not call a described mechanism a bare assertion', () => {
    // Both of these rows state a mechanism without ever using the word "because" — one with
    // "by implementing", one with "reduces ... by warning". Reading them as unreasoned was the
    // first thing this rule got wrong, so it stays pinned.
    expect(at('causalChain', 'policy.howWeSolve')[0]?.severity).not.toBe('critical')
    expect(at('causalChain', 'substantives.sub-1.howThisSolves')).toEqual([])
  })

  it('never fires on a field the seat does not fill', () => {
    const whipFindings = runAnalysis(filledExample, WHIP)
    expect(
      whipFindings.filter((finding) => finding.fieldPath.startsWith('substantives.')),
    ).toEqual([])
    expect(whipFindings.filter((finding) => finding.fieldPath.startsWith('definition.'))).toEqual([])
    // The prep sheet is shared by the whole team, so the vague actor split still reaches them.
    expect(whipFindings.some((finding) => finding.fieldPath === 'prep.actorsSplit')).toBe(true)
  })

  it('keeps the interrupting severities rare enough to be worth reading', () => {
    // A panel where everything is urgent is a panel nobody opens. The exact numbers here are
    // less important than the shape: a handful of things to act on, the rest available on ask.
    const counts = countBySeverity(findings)
    expect(counts.critical).toBeLessThanOrEqual(2)
    expect(counts.critical + counts.warn).toBeLessThan(counts.info + counts.warn + counts.critical)
  })
})

describe('finding addresses', () => {
  it('points every finding at a field the editor can actually route to', () => {
    // The contract the depth panel is built on: a finding's path is the same string
    // `buildSections` handed out and `setFieldByPath` accepts, so clicking one lands on a real
    // box and writing to it does not throw.
    const editable = new Set(
      flattenFields(buildSections(filledExample, FIRST_SPEAKER)).map((field) => field.path),
    )
    for (const path of groupFindingsByPath(findings).keys()) {
      expect(editable.has(path)).toBe(true)
      expect(() => setFieldByPath(filledExample, path, 'rewritten')).not.toThrow()
    }
  })

  it('gives every finding of a pass a distinct key', () => {
    // Not a cosmetic concern: two findings sharing a key drop one of them from the rendered
    // list. `impactAxes` is the one that bites — it emits several spanless findings on the same
    // field, so rule plus path is not enough to tell them apart.
    const keys = findings.map(findingKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('orders findings down the page, worst first within a field', () => {
    const prepIndex = findings.findIndex((finding) => finding.fieldPath.startsWith('prep.'))
    const subIndex = findings.findIndex((finding) => finding.fieldPath.startsWith('substantives.'))
    expect(prepIndex).toBeLessThan(subIndex)

    for (const bucket of groupFindingsByPath(findings).values()) {
      const ranks = bucket.map((finding) => SEVERITY_ORDER[finding.severity])
      expect(ranks).toEqual([...ranks].sort((left, right) => left - right))
    }
  })
})
