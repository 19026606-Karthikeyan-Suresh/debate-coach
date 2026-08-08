/**
 * What counts as the same word, pinned against the errors whisper actually makes.
 *
 * The negative cases matter as much as the positive ones. A normalizer that matches everything
 * reports no skips at all, which is a feature that always agrees with you and is therefore
 * worthless — so every group below has a list of pairs that must stay apart.
 */

import { describe, expect, it } from 'vitest'

import { matchRuns, metaphone, normalizeToken, numberToWords, spokenVariants } from '../normalize.ts'

/** Tier for two single words. */
function tier(left: string, right: string): string {
  return matchRuns([normalizeToken(left)], [normalizeToken(right)])
}

/** Tier for two runs given as space-separated phrases. */
function runTier(left: string, right: string): string {
  const split = (text: string) => text.split(' ').map(normalizeToken)
  return matchRuns(split(left), split(right))
}

describe('homophones survive transcription', () => {
  it.each([
    ['their', 'there'],
    ['their', "they're"],
    ['your', "you're"],
    ['its', "it's"],
    ['no', 'know'],
    ['right', 'write'],
    ['here', 'hear'],
    ['weak', 'week'],
    ['to', 'two'],
    ['too', 'two'],
    ['one', 'won'],
    ['for', 'four'],
    ['ate', 'eight'],
  ])('%s matches %s', (left, right) => {
    expect(tier(left, right)).not.toBe('none')
  })
})

describe('an inflection is not a skipped word', () => {
  it.each([
    ['damage', 'damages'],
    ['hold', 'holds'],
    ['platform', 'platforms'],
    ['company', 'companies'],
    ['liability', 'liabilities'],
  ])('%s matches %s', (left, right) => {
    expect(tier(left, right)).toBe('near')
  })
})

describe('different words stay different', () => {
  it.each([
    ['damage', 'dance'],
    ['harm', 'arm'],
    ['prop', 'opp'],
    ['in', 'on'],
    ['liable', 'legal'],
    ['spread', 'spending'],
    ['criminally', 'critically'],
    ['platform', 'perform'],
  ])('%s does not match %s', (left, right) => {
    expect(tier(left, right)).toBe('none')
  })
})

describe('one word said as several, and the reverse', () => {
  it.each([
    ['misinformation', 'miss information'],
    ['do not', "don't"],
    ['a lot', 'alot'],
  ])('%s matches %s', (left, right) => {
    expect(runTier(left, right)).not.toBe('none')
  })

  it('does not join two unrelated words into a match', () => {
    expect(runTier('social media', 'criminal liability')).toBe('none')
  })
})

describe('numbers are matched however they are said', () => {
  it.each([
    ['16', 'sixteen'],
    ['42', 'forty two'],
    ['2016', 'twenty sixteen'],
    ['2016', 'two thousand sixteen'],
    ['1st', 'first'],
    ['3rd', 'third'],
    ['20th', 'twentieth'],
    ['50%', 'fifty percent'],
  ])('%s matches %s', (left, right) => {
    expect(runTier(left, right)).toBe('exact')
  })

  it('does not match a different number', () => {
    expect(runTier('16', 'sixty')).toBe('none')
    expect(runTier('2016', 'twenty seventeen')).toBe('none')
  })
})

describe('numberToWords', () => {
  it.each([
    [0, 'zero'],
    [7, 'seven'],
    [13, 'thirteen'],
    [20, 'twenty'],
    [42, 'fortytwo'],
    [90, 'ninety'],
    [100, 'onehundred'],
    [203, 'twohundredthree'],
  ])('%i is %s', (value, spelled) => {
    expect(numberToWords(value)).toBe(spelled)
  })

  it('gives up rather than guess above what it can spell', () => {
    expect(numberToWords(1000)).toBe('')
    expect(numberToWords(-1)).toBe('')
    expect(numberToWords(1.5)).toBe('')
  })
})

describe('spokenVariants', () => {
  it('always contains the key itself', () => {
    expect(spokenVariants('platform').has('platform')).toBe(true)
  })

  it('carries both ways a year is said', () => {
    const variants = spokenVariants('2016')
    expect(variants.has('twentysixteen')).toBe(true)
    expect(variants.has('twothousandsixteen')).toBe(true)
  })
})

describe('metaphone', () => {
  it('drops the letters that are written but not said', () => {
    expect(metaphone('know')).toBe(metaphone('no'))
    expect(metaphone('write')).toBe(metaphone('right'))
  })

  it('has nothing to say about a bare numeral', () => {
    expect(metaphone('2016')).toBe('')
  })

  it('collapses a doubled letter, which is how a split word rejoins', () => {
    expect(metaphone('missinformation')).toBe(metaphone('misinformation'))
  })
})

describe('empty and punctuation-only input', () => {
  it('never matches, including against itself', () => {
    expect(tier('—', '—')).toBe('none')
    expect(tier('', '')).toBe('none')
  })

  it('does not throw on it', () => {
    expect(normalizeToken('—').key).toBe('')
    expect(normalizeToken('—').sound).toBe('')
  })
})
