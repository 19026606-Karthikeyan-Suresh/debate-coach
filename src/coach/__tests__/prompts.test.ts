/**
 * What Claude is actually sent, checked against the real filled example.
 *
 * The fixture is the same one the analyzer regresses against — a case a real debater wrote, with
 * real blanks in it — so these assertions are about a prompt someone would really send, not one
 * built to make an assertion pass.
 *
 * Two things matter here and they pull in opposite directions. The prompt must carry enough of
 * the case that a question about it can be specific, and it must carry the template's own wording
 * so a question comes back in the vocabulary the debater is writing in. Both fall out of reading
 * the case through `buildSections`, which is why nothing in `prompts.ts` keeps its own field list.
 */

import { describe, expect, it } from 'vitest'

import { buildFilledExampleCase, FIXTURE_MOTION } from '../../analysis/__tests__/fixture.ts'
import { getRole } from '../../formats/index.ts'
import { SUBSTANTIVE_LABELS } from '../../types/case.ts'
import { ATTACK_SCHEMA, AUDIT_SCHEMA, POI_SCHEMA } from '../schema.ts'
import { buildAttackPrompt, buildAuditPrompt, buildPoiPrompt, systemPromptFor } from '../prompts.ts'

/** The fixture's seat: AP Prime Minister, which runs substantives. */
const ROLE = getRole('AP', 'ap-pm')

if (!ROLE) {
  throw new Error('the fixture seat vanished from the format registry')
}

describe('the system prompt', () => {
  it('states the rule and the reason for it on every task', () => {
    for (const task of ['audit', 'attack', 'poi'] as const) {
      const system = systemPromptFor(task)
      expect(system).toContain('You ask. You do not answer.')
      // The reason, not just the rule. A model given a bare rule finds the edge of it.
      expect(system).toContain('cannot defend under a point of information')
    }
  })

  it('tells the model not to nag about blank rows, which the meter already does', () => {
    expect(systemPromptFor('audit')).toContain('do not ask them to fill it in')
  })

  it('forbids the answer on the two tasks that could smuggle one', () => {
    expect(systemPromptFor('attack')).toContain('Do not write any part of the answer')
    expect(systemPromptFor('poi')).toContain('Do not write the answers')
  })
})

describe('buildAuditPrompt', () => {
  const prompt = buildAuditPrompt(buildFilledExampleCase(), ROLE, 'sub-1')

  it('names the seat and the motion', () => {
    expect(prompt.user).toContain('Asian Parliamentary')
    expect(prompt.user).toContain('Prime Minister')
    expect(prompt.user).toContain(FIXTURE_MOTION)
  })

  it('quotes the template’s own questions as the row labels', () => {
    // Not retyped here either — the same record the editor renders from.
    expect(prompt.user).toContain(SUBSTANTIVE_LABELS.whyBad)
    expect(prompt.user).toContain(SUBSTANTIVE_LABELS.counterfactual)
  })

  it('carries the debater’s text verbatim', () => {
    const substantive = buildFilledExampleCase().substantives[0]
    expect(substantive?.problem).toBeTruthy()
    expect(prompt.user).toContain(substantive?.problem ?? '(missing)')
  })

  it('marks a blank row as blank rather than dropping it', () => {
    // The filled example genuinely leaves rows empty; an absent mechanism is the finding, so the
    // audit has to be able to see it.
    expect(prompt.user).toMatch(/\(blank\)/)
  })

  it('ships the audit schema', () => {
    expect(prompt.task).toBe('audit')
    expect(prompt.schema).toBe(AUDIT_SCHEMA)
  })

  it('refuses a substantive this seat does not have', () => {
    expect(() => buildAuditPrompt(buildFilledExampleCase(), ROLE, 'no-such-sub')).toThrow(
      /No such substantive/,
    )
  })
})

describe('buildAttackPrompt', () => {
  it('ships the attack schema and the substantive', () => {
    const prompt = buildAttackPrompt(buildFilledExampleCase(), ROLE, 'sub-1')
    expect(prompt.task).toBe('attack')
    expect(prompt.schema).toBe(ATTACK_SCHEMA)
    expect(prompt.user).toContain(SUBSTANTIVE_LABELS.oneSentence)
  })

  it('lists attacks already on the substantive so a second run is not the first reworded', () => {
    const caseFile = buildFilledExampleCase()
    const substantive = caseFile.substantives[0]
    if (!substantive) {
      throw new Error('the fixture lost its first substantive')
    }
    substantive.preempts = [
      { id: 'pre-1', attack: 'No regulator has ever acted on this.', response: '', source: 'claude' },
    ]

    const prompt = buildAttackPrompt(caseFile, ROLE, substantive.id)
    expect(prompt.user).toContain('Do not repeat them')
    expect(prompt.user).toContain('No regulator has ever acted on this.')
  })

  it('says nothing about preempts when there are none', () => {
    const prompt = buildAttackPrompt(buildFilledExampleCase(), ROLE, 'sub-1')
    expect(prompt.user).not.toContain('Do not repeat them')
  })
})

describe('buildPoiPrompt', () => {
  const prompt = buildPoiPrompt(buildFilledExampleCase(), ROLE)

  it('reads the whole case, not one substantive', () => {
    const caseFile = buildFilledExampleCase()
    for (const substantive of caseFile.substantives) {
      const oneSentence = substantive.oneSentence.trim()
      if (oneSentence.length > 0) {
        expect(prompt.user).toContain(oneSentence)
      }
    }
  })

  /**
   * The opposite of the audit's rule, and deliberately so: a row the debater never wrote is a row
   * the other bench cannot see, so it cannot be what a POI goes through.
   */
  it('omits blank rows rather than marking them', () => {
    expect(prompt.user).not.toMatch(/\(blank\)/)
  })

  it('ships the POI schema', () => {
    expect(prompt.task).toBe('poi')
    expect(prompt.schema).toBe(POI_SCHEMA)
  })

  it('lists POIs already on the prep sheet', () => {
    const caseFile = buildFilledExampleCase()
    caseFile.prep.pois = [
      { id: 'poi-1', text: 'Who decides what counts as fake?', response: '' },
    ]
    expect(buildPoiPrompt(caseFile, ROLE).user).toContain('Who decides what counts as fake?')
  })
})
