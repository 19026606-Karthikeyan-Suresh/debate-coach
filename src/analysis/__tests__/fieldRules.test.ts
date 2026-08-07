/**
 * The five rules that judge one field at a time.
 *
 * Every rule here has a false-positive case, and those are the tests that matter. A rule that
 * fires on good writing gets the whole panel closed within a week, and then the nine rules that
 * were right go with it.
 */

import { describe, expect, it } from 'vitest'

import { CAUSAL_CONNECTIVES } from '../lexicons.ts'
import { ASSERTION_WITHOUT_MECHANISM_RULE } from '../rules/assertionWithoutMechanism.ts'
import { CAUSAL_CHAIN_RULE, measureCausalChain } from '../rules/causalChain.ts'
import { HEDGE_AND_FILLER_RULE } from '../rules/hedgeAndFiller.ts'
import { MAX_SENTENCE_WORDS, SENTENCE_LENGTH_RULE } from '../rules/sentenceLength.ts'
import { VAGUENESS_RULE } from '../rules/vagueness.ts'
import { analyse, analyseRow, blankCase, caseWithSubstantive, withField } from './harness.ts'

describe('causalChain', () => {
  it('scores a bare assertion at depth 0', () => {
    expect(measureCausalChain('Fake news is a serious harm.', CAUSAL_CONNECTIVES).depth).toBe(0)
  })

  it('counts linked steps across a sentence boundary', () => {
    const passage =
      'Moderation queues are ranked by reported volume, which means a post nobody reports ' +
      'is never seen. That leaves the highest-reach accounts unchecked, because reach and ' +
      'report rate move in opposite directions.'
    expect(measureCausalChain(passage, CAUSAL_CONNECTIVES).depth).toBe(2)
  })

  it('does not chain two connectives three sentences apart', () => {
    // Two unrelated one-step claims in one field is not a two-step argument.
    const passage =
      'Trust falls because retractions travel slowly. An unrelated point. Another one. ' +
      'A different claim. Advertisers leave because the platform looks unsafe.'
    expect(measureCausalChain(passage, CAUSAL_CONNECTIVES).depth).toBe(1)
  })

  it('does not chain a connective restated with nothing in between', () => {
    expect(
      measureCausalChain('It fails because it is bad, because it is bad.', CAUSAL_CONNECTIVES).depth,
    ).toBe(1)
  })

  it('spans the sentences the chain runs through', () => {
    const passage = 'Reports are ranked, which means unreported posts stay up.'
    const measured = measureCausalChain(passage, CAUSAL_CONNECTIVES)
    expect(passage.slice(measured.span?.start, measured.span?.end)).toBe(passage)
  })

  it('calls out a bare assertion in a core row', () => {
    const findings = analyseRow(CAUSAL_CHAIN_RULE, 'whyBad', 'Fake news is a serious harm.')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('critical')
    expect(findings[0]?.fieldPath).toBe('substantives.sub-1.whyBad')
  })

  it('warns at one step', () => {
    const findings = analyseRow(
      CAUSAL_CHAIN_RULE,
      'whyBad',
      'Trust collapses because a retraction reaches a tenth of the original audience.',
    )
    expect(findings[0]?.severity).toBe('warn')
  })

  it('says nothing about a two-step chain', () => {
    const findings = analyseRow(
      CAUSAL_CHAIN_RULE,
      'whyBad',
      'Queues are ranked by reports, which means unreported posts stay up. ' +
        'The largest accounts are therefore never reviewed at all.',
    )
    expect(findings).toEqual([])
  })

  it('accepts a mechanism stated as "by" plus a gerund, which is how policy rows are written', () => {
    const findings = analyseRow(
      CAUSAL_CHAIN_RULE,
      'howThisSolves',
      'This reduces the spread of misinformation by warning users before they post.',
    )
    expect(findings).toEqual([])
  })

  it('leaves non-core rows alone', () => {
    // "Example" is a narrative. Demanding a causal chain from it would flag every good example.
    expect(analyseRow(CAUSAL_CHAIN_RULE, 'example', 'A scam ring in Manila ran this in 2019.')).toEqual(
      [],
    )
  })

  it('leaves an empty row alone — that belongs to the completeness meter', () => {
    expect(analyseRow(CAUSAL_CHAIN_RULE, 'whyBad', '   ')).toEqual([])
  })
})

describe('assertionWithoutMechanism', () => {
  it('flags a verdict with no reason attached', () => {
    const findings = analyseRow(
      ASSERTION_WITHOUT_MECHANISM_RULE,
      'whyBad',
      'The effect on those families is devastating. We should not allow it.',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('devastating')
  })

  it('accepts a reason in the same sentence', () => {
    expect(
      analyseRow(
        ASSERTION_WITHOUT_MECHANISM_RULE,
        'whyBad',
        'This is devastating because a retraction reaches a tenth of the original audience.',
      ),
    ).toEqual([])
  })

  it('accepts a reason that lands one sentence later', () => {
    // Writing the verdict then explaining it is normal, correct prose. Flagging it would be the
    // single loudest false positive in the set.
    expect(
      analyseRow(
        ASSERTION_WITHOUT_MECHANISM_RULE,
        'whyBad',
        'The effect on those families is devastating. A retraction reaches a tenth of the ' +
          'audience, which means the correction never arrives.',
      ),
    ).toEqual([])
  })

  it('underlines the sentence it is about', () => {
    const text = 'Queues are ranked by reports. This is unacceptable. Nothing follows.'
    const findings = analyse(
      ASSERTION_WITHOUT_MECHANISM_RULE,
      caseWithSubstantive({ whyBad: text }),
    )
    const span = findings[0]?.span
    expect(text.slice(span?.start, span?.end)).toBe('This is unacceptable.')
  })
})

describe('vagueness', () => {
  it('flags a vague noun with nothing concrete in its sentence', () => {
    const findings = analyseRow(VAGUENESS_RULE, 'problem', 'Many people are harmed by this.')
    expect(findings.map((finding) => finding.message)).toEqual([
      '"Many" names nobody in particular.',
      '"people" names nobody in particular.',
    ])
  })

  it('accepts a vague word anchored by a number in the same sentence', () => {
    expect(
      analyseRow(VAGUENESS_RULE, 'problem', 'Many people are harmed — 4300 accounts in 2023.'),
    ).toEqual([])
  })

  it('accepts a vague word anchored by a named place', () => {
    expect(analyseRow(VAGUENESS_RULE, 'problem', 'Many people in Jakarta lose work.')).toEqual([])
  })

  it('does not check the specificity of a later sentence against an earlier vague one', () => {
    const findings = analyseRow(
      VAGUENESS_RULE,
      'problem',
      'Many people are harmed. Jakarta banned it in 2019.',
    )
    expect(findings).toHaveLength(2)
  })

  it('reports each term once however often it is repeated', () => {
    const findings = analyseRow(
      VAGUENESS_RULE,
      'problem',
      'People suffer. People lose work. People give up.',
    )
    expect(findings).toHaveLength(1)
  })

  it('treats a vague actor split as worth interrupting for', () => {
    // The actor split feeds `stakeholderCoverage` and every substantive that leans on it, so a
    // vague answer there costs more than a vague word mid-paragraph.
    const actors = analyse(
      VAGUENESS_RULE,
      withField(blankCase(), 'prep.actorsSplit', 'Individuals in society'),
    )
    expect(actors.map((finding) => finding.severity)).toEqual(['warn', 'warn'])

    const prose = analyseRow(VAGUENESS_RULE, 'problem', 'Individuals in society are harmed.')
    expect(prose.every((finding) => finding.severity === 'info')).toBe(true)
  })

  it('says nothing about the motion, which the debater did not write', () => {
    expect(
      analyse(
        VAGUENESS_RULE,
        withField(blankCase(), 'prep.motion', 'THW ban many things that harm people in society'),
      ),
    ).toEqual([])
  })

  it('says nothing about the scratch pad, which exists to hold half-formed thoughts', () => {
    expect(
      analyse(VAGUENESS_RULE, withField(blankCase(), 'prep.scratch', 'many people, society, stuff')),
    ).toEqual([])
  })
})

describe('hedgeAndFiller', () => {
  it('flags filler', () => {
    const findings = analyseRow(
      HEDGE_AND_FILLER_RULE,
      'whyBad',
      'This is basically the same thing, and it is really very serious.',
    )
    expect(findings.map((finding) => finding.message).sort()).toEqual([
      '"basically" weakens the sentence without adding to it.',
      '"really" weakens the sentence without adding to it.',
      '"very" weakens the sentence without adding to it.',
    ])
  })

  it('leaves "just" alone where it is the adjective', () => {
    // A debate case says "a just war" and "the just outcome" far more often than most writing
    // does, and flagging those would be flatly wrong.
    expect(
      analyseRow(HEDGE_AND_FILLER_RULE, 'whyBad', 'A just war requires a just cause.'),
    ).toEqual([])
  })

  it('still flags "just" where it is filler', () => {
    const findings = analyseRow(HEDGE_AND_FILLER_RULE, 'whyBad', 'We are just promoting the spread.')
    expect(findings).toHaveLength(1)
  })

  it('reports each hedge once per field', () => {
    expect(
      analyseRow(HEDGE_AND_FILLER_RULE, 'whyBad', 'Very serious, very urgent, very real.'),
    ).toHaveLength(1)
  })

  it('is only ever a polish note', () => {
    const findings = analyseRow(HEDGE_AND_FILLER_RULE, 'whyBad', 'This is basically true.')
    expect(findings[0]?.severity).toBe('info')
  })
})

describe('sentenceLength', () => {
  const longSentence = `${Array.from({ length: MAX_SENTENCE_WORDS + 1 }, () => 'word').join(' ')}.`

  it('flags a sentence too long to say without dropping something', () => {
    const findings = analyseRow(SENTENCE_LENGTH_RULE, 'whyBad', longSentence)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain(String(MAX_SENTENCE_WORDS + 1))
  })

  it('accepts a sentence exactly at the limit', () => {
    const atLimit = `${Array.from({ length: MAX_SENTENCE_WORDS }, () => 'word').join(' ')}.`
    expect(analyseRow(SENTENCE_LENGTH_RULE, 'whyBad', atLimit)).toEqual([])
  })

  it('accepts a long field made of short sentences', () => {
    // Length is a delivery problem, not a verbosity problem. Ten short sentences are fine.
    const paragraph = Array.from({ length: 10 }, () => 'This part is short and sayable.').join(' ')
    expect(analyseRow(SENTENCE_LENGTH_RULE, 'whyBad', paragraph)).toEqual([])
  })

  it('checks reported material too, because it gets said out loud as well', () => {
    const findings = analyse(
      SENTENCE_LENGTH_RULE,
      withField(blankCase(), 'policy.whatOppCanSay', longSentence),
    )
    expect(findings).toHaveLength(1)
  })
})
