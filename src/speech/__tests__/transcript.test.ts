/**
 * Turning a transcript into words.
 *
 * Small module, one load-bearing property: the split has to produce exactly what the script side
 * produces, or every word in the speech is off by one against the aligner's index.
 */

import { describe, expect, it } from 'vitest'

import { mergeSpeechResults, transcriptWords, wordsPerMinute } from '../transcript.ts'

describe('splitting a transcript', () => {
  it('splits on runs of whitespace of any kind', () => {
    expect(transcriptWords('the  first\tsubstantive\nis')).toEqual([
      'the',
      'first',
      'substantive',
      'is',
    ])
  })

  it('keeps punctuation attached, because normalize.ts owns that decision', () => {
    expect(transcriptWords('damage. What?')).toEqual(['damage.', 'What?'])
  })

  it('gives nothing for nothing, rather than one empty word', () => {
    expect(transcriptWords('')).toEqual([])
    expect(transcriptWords('   \n ')).toEqual([])
  })

  it('agrees with how a script line would be split', () => {
    const line = 'There is no safe internet without liability.'
    expect(transcriptWords(line)).toEqual(line.split(/\s+/).filter((word) => word.length > 0))
  })
})

describe('merging a browser recogniser`s results', () => {
  it('joins settled and interim text in order', () => {
    expect(
      mergeSpeechResults([
        { transcript: 'my first substantive', isFinal: true },
        { transcript: ' is that fake news', isFinal: false },
      ]),
    ).toBe('my first substantive is that fake news')
  })

  it('drops empty alternatives rather than doubling the spaces', () => {
    expect(
      mergeSpeechResults([
        { transcript: 'one', isFinal: true },
        { transcript: '   ', isFinal: false },
        { transcript: 'two', isFinal: false },
      ]),
    ).toBe('one two')
  })

  it('is empty before anything has been heard', () => {
    expect(mergeSpeechResults([])).toBe('')
  })
})

describe('pace', () => {
  it('is words over minutes', () => {
    expect(wordsPerMinute(160, 60)).toBe(160)
    expect(wordsPerMinute(1060, 398)).toBe(160)
  })

  it('does not report thousands of words a minute on the first tick', () => {
    expect(wordsPerMinute(3, 0.4)).toBe(0)
    expect(wordsPerMinute(0, 0)).toBe(0)
  })
})
