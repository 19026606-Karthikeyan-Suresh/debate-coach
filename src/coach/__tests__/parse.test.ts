/**
 * What happens when a reply is not what the schema promised.
 *
 * `output_config.format` guarantees the shape for the model that was asked. It says nothing about
 * a fallback model that ran instead, a body cut off at `max_tokens`, or a schema this repo
 * changed while Anthropic is still serving the previous one out of its compile cache. So every
 * case below is a reply that arrived, parsed as JSON, and was still wrong.
 */

import { describe, expect, it } from 'vitest'

import { parseAttackReply, parseAuditReply, parsePoiReply, parseReply } from '../parse.ts'
import type { AttackResult, AuditResult, PoiResult } from '../types.ts'
import { DEPTH_AXES } from '../types.ts'

/** A well-formed audit: one honest question per axis. */
const GOOD_AUDIT = JSON.stringify({
  axes: [
    { axis: 'impact', score: 2, question: 'How many people are harmed in a year?' },
    { axis: 'mechanism', score: 1, question: 'Who actually takes the post down?' },
    { axis: 'comparative', score: 0, question: 'What does the status quo get right?' },
    { axis: 'evidence', score: 1, question: 'Which platform has ever done this?' },
    { axis: 'linkBack', score: 3, question: 'Why does winning this win the motion?' },
  ],
  sharpest: 'comparative',
})

describe('parseAuditReply', () => {
  it('renders the axes in the rubric’s order, not the model’s', () => {
    const { result } = parseAuditReply(GOOD_AUDIT)
    const audit = result as AuditResult
    expect(audit.axes.map((verdict) => verdict.axis)).toEqual([...DEPTH_AXES])
    expect(audit.sharpest).toBe('comparative')
  })

  it('drops a coaching question and keeps the rest', () => {
    const payload = JSON.stringify({
      axes: [
        { axis: 'impact', score: 2, question: 'How many people are harmed in a year?' },
        { axis: 'mechanism', score: 1, question: 'You should name the enforcing body?' },
      ],
      sharpest: 'mechanism',
    })
    const { result, rejected } = parseAuditReply(payload)
    expect((result as AuditResult).axes.map((verdict) => verdict.axis)).toEqual(['impact'])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBe('tells the debater what to do')
  })

  /**
   * `sharpest` names an axis whose question the guard threw away. Pointing at an axis that is no
   * longer on screen is worse than picking again, so it falls back to the weakest survivor.
   */
  it('re-picks the sharpest axis when the model’s choice was discarded', () => {
    const payload = JSON.stringify({
      axes: [
        { axis: 'impact', score: 3, question: 'How many people are harmed in a year?' },
        { axis: 'mechanism', score: 0, question: 'Who actually takes the post down?' },
        { axis: 'evidence', score: 2, question: 'Try saying the Myanmar case here?' },
      ],
      sharpest: 'evidence',
    })
    const { result } = parseAuditReply(payload)
    expect((result as AuditResult).sharpest).toBe('mechanism')
  })

  it('ignores an axis it does not recognise without calling it a Socratic failure', () => {
    const payload = JSON.stringify({
      axes: [
        { axis: 'vibes', score: 3, question: 'Does this feel right?' },
        { axis: 'impact', score: 1, question: 'Who is worse off, and by how much?' },
      ],
      sharpest: 'impact',
    })
    const { result, rejected } = parseAuditReply(payload)
    expect((result as AuditResult).axes).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  it('keeps the first verdict when an axis is scored twice', () => {
    const payload = JSON.stringify({
      axes: [
        { axis: 'impact', score: 1, question: 'Who is worse off?' },
        { axis: 'impact', score: 3, question: 'How permanent is the harm?' },
      ],
      sharpest: 'impact',
    })
    const { result } = parseAuditReply(payload)
    const audit = result as AuditResult
    expect(audit.axes).toHaveLength(1)
    expect(audit.axes[0]?.score).toBe(1)
  })

  it('clamps a score outside the scale rather than losing the verdict', () => {
    const payload = JSON.stringify({
      axes: [{ axis: 'impact', score: 9, question: 'Who is worse off?' }],
      sharpest: 'impact',
    })
    expect((parseAuditReply(payload).result as AuditResult).axes[0]?.score).toBe(3)
  })

  it('fails rather than showing scores with nothing to act on', () => {
    const payload = JSON.stringify({
      axes: [{ axis: 'impact', score: 1, question: 'You should quantify this?' }],
      sharpest: 'impact',
    })
    expect(() => parseAuditReply(payload)).toThrow(/Socratic/)
  })

  it('fails on a reply that is not JSON', () => {
    expect(() => parseAuditReply('I looked at your substantive and')).toThrow(/not JSON/)
  })
})

describe('parseAttackReply', () => {
  it('keeps the opposition’s lines', () => {
    const payload = JSON.stringify({
      attacks: [
        {
          targets: 'mechanism',
          attack: 'No regulator has ever fined a platform for this, so nothing changes.',
        },
        { targets: 'impact', attack: 'The harm you describe is already illegal under defamation law.' },
      ],
    })
    const { result, rejected } = parseAttackReply(payload)
    expect((result as AttackResult).attacks).toHaveLength(2)
    expect(rejected).toHaveLength(0)
  })

  it('drops a line that came with its own rebuttal', () => {
    const payload = JSON.stringify({
      attacks: [
        { targets: 'impact', attack: 'The harm is speculative — you should cite Myanmar here.' },
        { targets: 'mechanism', attack: 'Platforms will over-remove and the dissent goes first.' },
      ],
    })
    const { result, rejected } = parseAttackReply(payload)
    expect((result as AttackResult).attacks).toHaveLength(1)
    expect(rejected[0]?.reason).toBe('tells the debater what to do')
  })

  it('keeps an attack whose axis label is wrong, because the line still has to be answered', () => {
    const payload = JSON.stringify({
      attacks: [{ targets: 'nonsense', attack: 'Your actor cannot do the thing you need it to do.' }],
    })
    expect((parseAttackReply(payload).result as AttackResult).attacks[0]?.targets).toBe('mechanism')
  })
})

describe('parsePoiReply', () => {
  it('keeps the questions', () => {
    const payload = JSON.stringify({
      questions: ['Who decides what counts as fake?', 'What stops platforms over-removing?'],
    })
    expect((parsePoiReply(payload).result as PoiResult).questions).toHaveLength(2)
  })

  it('drops a POI that is not a question', () => {
    const payload = JSON.stringify({
      questions: ['Your mechanism has no enforcement step.', 'Who pays the fine?'],
    })
    const { result, rejected } = parsePoiReply(payload)
    expect((result as PoiResult).questions).toEqual(['Who pays the fine?'])
    expect(rejected[0]?.reason).toBe('not phrased as a question')
  })
})

describe('parseReply', () => {
  it('routes each task to its own parser', () => {
    expect(parseReply('audit', GOOD_AUDIT).result.kind).toBe('audit')
    expect(
      parseReply('attack', JSON.stringify({ attacks: [{ targets: 'impact', attack: 'It is small.' }] }))
        .result.kind,
    ).toBe('attack')
    expect(parseReply('poi', JSON.stringify({ questions: ['Who pays?'] })).result.kind).toBe('poi')
  })
})
