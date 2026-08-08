/**
 * The filler lexicon, and the words it must leave alone.
 *
 * Every entry gets a false-positive test, which is the convention phase 3 settled: a list that
 * flags real speech gets ignored within a week, and then the entries that were right go with it.
 * `like` carries most of the risk here and most of the tests.
 */

import { describe, expect, it } from 'vitest'

import { countFillers, findFillers } from '../fillers.ts'

/** The lexicon entries that matched, in order. */
function phrases(transcript: string): readonly string[] {
  return findFillers(transcript).map((hit) => hit.phrase)
}

describe('the sounds that stand in for a word', () => {
  it('finds them however whisper spelled them', () => {
    expect(phrases('Um, my first substantive is, uh, liability. Erm, the mechanism is clear.')).toEqual(
      ['um', 'uh', 'erm'],
    )
  })

  it('does not match inside a longer word', () => {
    // "umbrella" holds "um", "further" holds "er", "ahead" holds "ah".
    expect(phrases('The umbrella of further harm lies ahead of us.')).toEqual([])
  })

  it('reports the word as transcribed, not as it is listed', () => {
    const hits = findFillers('Um, so, the point stands.')
    expect(hits[0]?.text).toBe('Um')
    expect(hits[0]?.phrase).toBe('um')
  })
})

describe('the words that carry no load', () => {
  it('finds the discourse markers', () => {
    expect(
      phrases('This is, basically, the harm. You know, the government literally cannot deny it.'),
    ).toEqual(['basically', 'you know', 'literally'])
  })

  it('leaves "you know" alone when it is a verb with an object', () => {
    expect(phrases('You know that the platform profits from this.')).toEqual([])
    expect(phrases('You know the answer already.')).toEqual([])
  })

  it('leaves "I mean" alone when it introduces what was meant', () => {
    expect(phrases('I mean that the harm is irreversible.')).toEqual([])
  })

  it('counts "I mean" when it is a reset', () => {
    expect(phrases('The harm is huge, I mean, nobody can undo it.')).toEqual(['i mean'])
  })
})

describe('"like", which is the hard one', () => {
  it('counts it when the transcript sets it off with commas', () => {
    expect(phrases('So, like, the platform has every incentive to keep it up.')).toEqual(['like'])
  })

  it('leaves the comparative alone', () => {
    expect(phrases('Platforms like Facebook profit from outrage.')).toEqual([])
  })

  it('leaves the verb alone', () => {
    expect(phrases('It looks like the policy failed and voters would like an answer.')).toEqual([])
  })

  it('leaves a simile alone even next to a filler it should catch', () => {
    expect(phrases('It spreads, um, like wildfire across the platform.')).toEqual(['um'])
  })
})

describe('deliberate omissions', () => {
  it('never flags "so", which is causal far more often than it is filler', () => {
    expect(phrases('So the policy works, so that nobody is harmed, and so many are protected.')).toEqual(
      [],
    )
  })

  it('never flags "right", which in a debate is nearly always a noun', () => {
    expect(phrases('The right to speak is not the right to be amplified, right?')).toEqual([])
  })

  it('never flags "actually", which is usually doing contrastive work', () => {
    expect(phrases('What actually happens is that the platform actually profits.')).toEqual([])
  })
})

describe('overlapping matches', () => {
  it('reports one hit per stretch of words, longest first', () => {
    const hits = findFillers('It is, kind of, the same thing.')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.phrase).toBe('kind of')
  })

  it('returns hits in transcript order whatever order the lexicon is in', () => {
    const hits = findFillers('Basically the harm is, um, permanent and, you know, total.')
    expect(hits.map((hit) => hit.phrase)).toEqual(['basically', 'um', 'you know'])
    expect(hits.map((hit) => hit.span.start)).toEqual([...hits.map((hit) => hit.span.start)].sort(
      (left, right) => left - right,
    ))
  })
})

describe('counting', () => {
  const hits = findFillers('Um, um, and, um, basically the point is, you know, unanswered.')

  it('groups by the word that was said, commonest first', () => {
    expect(countFillers(hits)).toEqual([
      { phrase: 'um', kind: 'disfluency', count: 3 },
      { phrase: 'basically', kind: 'crutch', count: 1 },
      { phrase: 'you know', kind: 'crutch', count: 1 },
    ])
  })

  it('counts nothing in a clean delivery', () => {
    expect(countFillers(findFillers('The mechanism is liability and the impact is deterrence.'))).toEqual(
      [],
    )
  })
})
