/**
 * Red-teaming the Socratic guard.
 *
 * Every rejection case below is paired with an acceptance case that looks like it, because a
 * guard that eats honest questions is worse than no guard at all: it makes the panel look broken,
 * and a debater who stops reading the panel has lost the feature entirely.
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_ATTACK_CHARACTERS,
  MAX_QUESTION_CHARACTERS,
  checkAttack,
  checkQuestion,
  guard,
} from '../validate.ts'

describe('checkQuestion', () => {
  it('keeps the question a judge would actually ask', () => {
    expect(checkQuestion('What makes you think the platform acts at all?')).toBeNull()
    expect(checkQuestion('Who is worse off in your world than in theirs?')).toBeNull()
    expect(
      checkQuestion('Why does a fine change the behaviour of a company that already budgets for them?'),
    ).toBeNull()
  })

  it('rejects a statement wearing a question mark', () => {
    // The single most common way an argument arrives: a suggestion, punctuated as a question.
    expect(checkQuestion('Have you considered that platforms only act under regulatory pressure?')).toBe(
      'a suggestion with a question mark on it',
    )
  })

  it('rejects an instruction to the debater', () => {
    expect(checkQuestion('You should explain why the regulator would enforce this?')).toBe(
      'tells the debater what to do',
    )
    expect(checkQuestion('You need to name a country where this happened?')).toBe(
      'tells the debater what to do',
    )
  })

  it('rejects a scripted line', () => {
    expect(checkQuestion('Try saying that the harm is irreversible?')).toBe(
      'scripts a line for the debater',
    )
    expect(checkQuestion('Respond by pointing at the Cambridge Analytica case?')).toBe(
      'scripts a line for the debater',
    )
    expect(checkQuestion('Your answer should cover the counterfactual?')).toBe(
      'scripts a line for the debater',
    )
  })

  it('rejects a question that answers itself', () => {
    expect(checkQuestion('The answer is that platforms are the only chokepoint, right?')).toBe(
      'answers its own question',
    )
    expect(checkQuestion("Here's how the mechanism could work — does that hold?")).toBe(
      'answers its own question',
    )
  })

  it('rejects first-person advocacy', () => {
    expect(checkQuestion('I would argue the impact is overstated — is it?')).toBe(
      'argues in the first person',
    )
    expect(checkQuestion("We'd say the counterfactual is unproven, would you agree?")).toBe(
      'argues in the first person',
    )
  })

  /**
   * "You" on its own is fine — a judge says it constantly. Only the instruction forms are barred,
   * and this is the case that keeps the pattern from being widened into uselessness.
   */
  it('does not reject the ordinary second person', () => {
    expect(checkQuestion('Why should the house believe you over the status quo?')).toBeNull()
    expect(checkQuestion('What do you do when the platform simply pays the fine?')).toBeNull()
  })

  it('rejects prose that has stopped being a question', () => {
    const essay = `Why does this matter to the motion${' and to the wider community'.repeat(12)}?`
    expect(essay.length).toBeGreaterThan(MAX_QUESTION_CHARACTERS)
    expect(checkQuestion(essay)).toContain('longer than a question')
  })

  it('rejects anything that is not interrogative', () => {
    expect(checkQuestion('The mechanism does not explain who enforces it.')).toBe(
      'not phrased as a question',
    )
    expect(checkQuestion('   ')).toBe('empty')
  })
})

describe('checkAttack', () => {
  it('keeps a line the other bench would say out loud', () => {
    expect(
      checkAttack(
        'Their whole case assumes a regulator that has never once fined a platform, so nothing changes on the ground.',
      ),
    ).toBeNull()
  })

  /** An attack is prose, so the interrogative rule cannot apply — only voice and length do. */
  it('does not require an attack to be a question', () => {
    expect(checkAttack('Platforms will over-remove, and the speech that goes first is the dissent.')).toBeNull()
  })

  it('rejects an attack that comes with its own rebuttal', () => {
    expect(
      checkAttack('They will say the harm is speculative — you should answer with the Myanmar case.'),
    ).toBe('tells the debater what to do')
  })

  it('rejects a speech', () => {
    const speech = `Their mechanism fails${' because the regulator is captured'.repeat(20)}.`
    expect(speech.length).toBeGreaterThan(MAX_ATTACK_CHARACTERS)
    expect(checkAttack(speech)).toContain('longer than a line an opponent would say')
  })
})

describe('guard', () => {
  it('keeps the survivors in order and reports every casualty', () => {
    const questions = [
      'Who enforces this?',
      'You should name a jurisdiction?',
      'What happens in the year before the fine lands?',
    ]
    const { kept, rejected } = guard(questions, (question) => question, checkQuestion)

    expect(kept).toEqual([questions[0], questions[2]])
    expect(rejected).toEqual([
      { text: questions[1], reason: 'tells the debater what to do' },
    ])
  })

  /**
   * A number where a question should be means the schema constraint did not hold. Coercing it
   * would render `42` as a judge's question; rejecting it says so.
   */
  it('rejects an item whose text is not text', () => {
    const { kept, rejected } = guard([42], (entry) => entry, checkQuestion)
    expect(kept).toEqual([])
    expect(rejected).toEqual([{ text: '42', reason: 'not text' }])
  })
})
