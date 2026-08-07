/**
 * The text primitives.
 *
 * Offsets get their own assertions throughout, because every rule that underlines something
 * depends on them and an off-by-one here would misplace every underline in the editor without
 * failing anything else.
 */

import { describe, expect, it } from 'vitest'

import {
  contentWords,
  findPhrases,
  hasSpecificityMarker,
  jaccard,
  splitSentences,
  stem,
  tokenize,
  withoutWords,
  wordCount,
} from '../text.ts'

describe('splitSentences', () => {
  it('keeps offsets pointing back into the original passage', () => {
    const passage = 'First one. Second one!'
    const sentences = splitSentences(passage)

    expect(sentences.map((sentence) => sentence.text)).toEqual(['First one.', 'Second one!'])
    for (const sentence of sentences) {
      expect(passage.slice(sentence.start, sentence.end)).toBe(sentence.text)
    }
  })

  it('splits on line breaks, which is how the template gets written', () => {
    expect(splitSentences('Social media companies\nIndividuals in society')).toHaveLength(2)
  })

  it('returns nothing for a blank passage', () => {
    expect(splitSentences('   \n  ')).toEqual([])
  })

  it('keeps a trailing fragment with no terminator', () => {
    expect(splitSentences('One. And a fragment').map((one) => one.text)).toEqual([
      'One.',
      'And a fragment',
    ])
  })
})

describe('tokenize', () => {
  it('keeps hyphens and apostrophes inside a word', () => {
    expect(tokenize("long-term don't").map((token) => token.normalized)).toEqual([
      'long-term',
      "don't",
    ])
  })

  it('folds the curly apostrophe Word emits to the straight one a debater types', () => {
    expect(tokenize('don’t').map((token) => token.normalized)).toEqual(["don't"])
  })
})

describe('wordCount', () => {
  it('counts words, not punctuation', () => {
    expect(wordCount('One, two; three.')).toBe(3)
  })
})

describe('stem', () => {
  it('folds plurals so the same noun compares equal', () => {
    expect(stem('damages')).toBe('damage')
    expect(stem('companies')).toBe('company')
    expect(stem('boxes')).toBe('box')
  })

  it('leaves a trailing s that is part of the word', () => {
    expect(stem('business')).toBe('business')
    expect(stem('analysis')).toBe('analysis')
  })

  it('leaves -ing and -ed alone, so "spread" and "spreading" stay comparable', () => {
    // The reason -ed stemming is not done at all: it would map "spread" to "spr" while
    // "spreading" mapped to "spread", and the two would stop matching each other.
    expect(stem('spread')).toBe('spread')
    expect(stem('spreading')).toBe('spreading')
  })
})

describe('contentWords', () => {
  it('drops stopwords and short words', () => {
    expect([...contentWords('The company has a problem')].sort()).toEqual(['company', 'problem'])
  })

  it('folds plurals, so two phrasings of one idea overlap', () => {
    expect(contentWords('social media companies').has('company')).toBe(true)
  })
})

describe('jaccard', () => {
  it('scores identical vocabularies at 1', () => {
    expect(jaccard(new Set(['a1', 'b2']), new Set(['a1', 'b2']))).toBe(1)
  })

  it('scores an empty side at 0 rather than dividing by zero', () => {
    expect(jaccard(new Set(), new Set(['a1']))).toBe(0)
  })

  it('is shared over union', () => {
    expect(jaccard(new Set(['a1', 'b2']), new Set(['b2', 'c3']))).toBeCloseTo(1 / 3)
  })
})

describe('withoutWords', () => {
  it('subtracts without touching either input', () => {
    const base = new Set(['fake', 'news', 'chilling'])
    expect([...withoutWords(base, new Set(['fake', 'news']))]).toEqual(['chilling'])
    expect(base.size).toBe(3)
  })
})

describe('findPhrases', () => {
  it('matches whole words only', () => {
    expect(findPhrases('I know that', ['now'])).toEqual([])
  })

  it('matches across a line break inside a phrase', () => {
    expect(findPhrases('as a\nresult of this', ['as a result'])).toHaveLength(1)
  })

  it('accepts either apostrophe', () => {
    expect(findPhrases('prop’s best case', ["prop's best case"])).toHaveLength(1)
  })

  it('collapses an overlap to the longer entry', () => {
    // "because" is nested inside "because of". Counting both would double the causal depth of
    // every sentence that says "because of".
    const matches = findPhrases('it fails because of cost', ['because', 'because of'])
    expect(matches).toHaveLength(1)
    expect(matches[0]?.text).toBe('because of')
  })

  it('reports offsets that slice back to the matched text', () => {
    const passage = 'this happens because the queue is ranked'
    const match = findPhrases(passage, ['because'])[0]
    expect(match).toBeDefined()
    expect(passage.slice(match?.span.start, match?.span.end)).toBe('because')
  })

  it('accepts a regex entry for a construction rather than a phrase', () => {
    const matches = findPhrases('we fix it by warning users', [/\bby \p{L}+ing\b/giu])
    expect(matches.map((match) => match.text)).toEqual(['by warning'])
  })
})

describe('hasSpecificityMarker', () => {
  it('accepts a number or a percentage', () => {
    expect(hasSpecificityMarker('40% of drivers')).toBe(true)
    expect(hasSpecificityMarker('4300 accounts')).toBe(true)
  })

  it('accepts a name that is not just the sentence-initial capital', () => {
    expect(hasSpecificityMarker('Drivers in Jakarta lose work')).toBe(true)
  })

  it('rejects a sentence whose only capital is its first letter', () => {
    expect(hasSpecificityMarker('Many people are harmed by this')).toBe(false)
  })
})
