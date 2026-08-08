/**
 * The aligner, against the ways a speech actually goes wrong.
 *
 * PLAN's verification list for this phase, made executable: verbatim delivery, a dropped clause,
 * an improvised insertion, homophones, a restarted sentence, a jump between substantives, a
 * chunk of transcript lost outright, and a filler storm. Each asserts the exact set of words
 * classified skipped and improvised, because "roughly right" is not a property this feature can
 * be built on — one false strike-through per speech and the debater stops reading the red.
 */

import { describe, expect, it } from 'vitest'

import type { AlignmentState } from '../align.ts'
import { advanceAlignment, alignSpeech, createAlignment, skipRate, tokensWithStatus } from '../align.ts'

const SCRIPT_TEXT =
  'My first substantive is that fake news causes irreparable damage. ' +
  'What is the problem? Fake news influences the minds of individuals and leads to many damages. ' +
  'Why does that matter? It uproots the life of an organization and the damage is irrecoverable. ' +
  'So let me close this substantive. There is no safe internet without liability.'

/** Splits a passage the way the compiler and the transcript sources both do. */
function words(text: string): readonly string[] {
  return text.split(/\s+/).filter((piece) => piece.length > 0)
}

const SCRIPT = words(SCRIPT_TEXT)

/** The script words the alignment says were never said. */
function skippedWords(state: AlignmentState): readonly string[] {
  return tokensWithStatus(state, 'skipped').map((token) => state.script[token.scriptIndex]?.text ?? '')
}

/** The words the speaker added that are not in the script. */
function addedWords(state: AlignmentState): readonly string[] {
  return state.improvisations.map((item) => item.text)
}

describe('a speech delivered as written', () => {
  const state = alignSpeech(SCRIPT, SCRIPT)

  it('finds nothing skipped and nothing added', () => {
    expect(skippedWords(state)).toEqual([])
    expect(addedWords(state)).toEqual([])
    expect(skipRate(state)).toBe(0)
  })

  it('marks every word spoken and leaves the cursor at the end', () => {
    expect(tokensWithStatus(state, 'spoken')).toHaveLength(SCRIPT.length)
    expect(state.cursor).toBe(SCRIPT.length)
  })
})

describe('a clause the speaker skipped', () => {
  const state = alignSpeech(SCRIPT, words(SCRIPT_TEXT.replace('and leads to many damages. ', '')))

  it('names exactly the words that went missing', () => {
    expect(skippedWords(state)).toEqual(['and', 'leads', 'to', 'many', 'damages.'])
  })

  it('does not invent improvisations to explain it', () => {
    expect(addedWords(state)).toEqual([])
  })

  it('reports the share of what was reached that went unsaid', () => {
    expect(skipRate(state)).toBeCloseTo(5 / SCRIPT.length, 5)
  })
})

describe('a sentence the speaker added', () => {
  const state = alignSpeech(
    SCRIPT,
    words(SCRIPT_TEXT.replace('Why does', 'And I want to stress this. Why does')),
  )

  it('names exactly the words that were not in the script', () => {
    expect(addedWords(state)).toEqual(['And', 'I', 'want', 'to', 'stress', 'this.'])
  })

  it('does not mark anything skipped', () => {
    expect(skippedWords(state)).toEqual([])
  })
})

describe('what the transcriber got wrong', () => {
  // Every substitution here is one whisper makes on ordinary fast delivery.
  const misheard = SCRIPT_TEXT.replace('There is no safe internet', 'their is know safe internet')
    .replace('irreparable damage.', 'irreparable damages.')
    .replace('the minds of individuals', 'the mind of individuals')
  const state = alignSpeech(SCRIPT, words(misheard))

  it('does not call a mis-transcribed word a skipped one', () => {
    expect(skippedWords(state)).toEqual([])
    expect(addedWords(state)).toEqual([])
  })

  it('records that those matches were the weaker kind', () => {
    const near = tokensWithStatus(state, 'spoken').filter((token) => token.tier === 'near')
    expect(near.length).toBeGreaterThan(0)
  })
})

describe('a sentence the speaker restarted', () => {
  const state = alignSpeech(
    SCRIPT,
    words(SCRIPT_TEXT.replace('It uproots the life', 'It uproots the it uproots the life')),
  )

  it('keeps every script word spoken', () => {
    expect(skippedWords(state)).toEqual([])
  })

  it('reports the false start as extra words rather than losing it', () => {
    // Which of the two identical runs is called the extra one is arbitrary and the DP is
    // indifferent between them; what the debater is told either way is "you said three words
    // twice", which is the whole content of the finding.
    expect(addedWords(state).map((word) => word.toLowerCase())).toEqual(['it', 'uproots', 'the'])
  })
})

describe('a chunk of transcript lost outright', () => {
  // The sidecar dropped audio: a whole run of words never arrives.
  const spoken = [...SCRIPT.slice(0, 12), ...SCRIPT.slice(28)]
  const state = alignSpeech(SCRIPT, spoken)

  it('marks the lost run skipped and nothing else', () => {
    expect(skippedWords(state)).toEqual(SCRIPT.slice(12, 28))
    expect(addedWords(state)).toEqual([])
  })
})

describe('a filler storm', () => {
  const filled = SCRIPT.flatMap((word, index) => (index % 4 === 0 ? ['um', word] : [word]))
  const state = alignSpeech(SCRIPT, filled)

  it('leaves the script intact and collects the fillers as additions', () => {
    expect(skippedWords(state)).toEqual([])
    expect(addedWords(state).every((word) => word === 'um')).toBe(true)
    expect(addedWords(state)).toHaveLength(filled.length - SCRIPT.length)
  })
})

// Three blocks of distinct words, each long enough that a jump to the third lands well outside
// the default 160-word window — which is the only way the re-anchor pass is reached at all.
const BLOCK_LENGTH = 100
const longScript = ['alpha', 'beta', 'gamma'].flatMap((label) =>
  Array.from({ length: BLOCK_LENGTH }, (_unused, index) => `${label}word${String(index)}`),
)

describe('a speaker who jumps to another substantive', () => {
  const spoken = [...longScript.slice(0, 20), ...longScript.slice(200, 260)]

  it('reports the advance that had to widen its search', () => {
    // `reAnchored` describes one advance, not the speech, so it is read on the advance that
    // jumps. Asserting it on the end state of a replay reads whatever the last chunk did.
    const beforeJump = advanceAlignment(createAlignment(longScript), spoken.slice(0, 20))
    expect(beforeJump.reAnchored).toBe(false)
    expect(advanceAlignment(beforeJump, spoken).reAnchored).toBe(true)
  })

  it('finds them again and marks what they jumped over', () => {
    const state = alignSpeech(longScript, spoken)

    expect(tokensWithStatus(state, 'spoken')).toHaveLength(80)
    expect(tokensWithStatus(state, 'skipped')).toHaveLength(180)
    expect(tokensWithStatus(state, 'pending')).toHaveLength(40)
    expect(state.improvisations).toEqual([])
  })

  it('does not throw away the words said before the jump', () => {
    // The bug this guards: re-running the whole window with a free leading gap is cheaper than
    // keeping real matches, so the opening twenty words come back as improvisation.
    const state = alignSpeech(longScript, spoken)
    const spokenIndices = tokensWithStatus(state, 'spoken').map((token) => token.scriptIndex)
    expect(spokenIndices.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => index),
    )
  })

  it('finds the same answer word by word as it does all at once', () => {
    let streamed = createAlignment(longScript)
    for (let index = 4; index <= spoken.length; index += 4) {
      streamed = advanceAlignment(streamed, spoken.slice(0, index))
    }
    expect(streamed.tokens.map((token) => token.status)).toEqual(
      alignSpeech(longScript, spoken).tokens.map((token) => token.status),
    )
  })
})

describe('mid-speech', () => {
  const state = alignSpeech(SCRIPT, SCRIPT.slice(0, 20))

  it('leaves the script ahead of the speaker pending, not skipped', () => {
    expect(tokensWithStatus(state, 'skipped')).toEqual([])
    expect(tokensWithStatus(state, 'pending')).toHaveLength(SCRIPT.length - 20)
  })

  it('puts the cursor where the speaker has got to', () => {
    expect(state.cursor).toBe(20)
  })

  it('has said nothing at all before the first word arrives', () => {
    const fresh = createAlignment(SCRIPT)
    expect(fresh.cursor).toBe(0)
    expect(tokensWithStatus(fresh, 'pending')).toHaveLength(SCRIPT.length)
    expect(skipRate(fresh)).toBe(0)
  })
})

describe('streaming', () => {
  it('reaches the same answer as one call, whatever the chunk size', () => {
    const oneShot = alignSpeech(SCRIPT, SCRIPT).tokens.map((token) => token.status)
    for (const chunk of [1, 2, 5, 13]) {
      let streamed = createAlignment(SCRIPT)
      for (let index = chunk; index <= SCRIPT.length; index += chunk) {
        streamed = advanceAlignment(streamed, SCRIPT.slice(0, index))
      }
      streamed = advanceAlignment(streamed, SCRIPT)
      expect(streamed.tokens.map((token) => token.status)).toEqual(oneShot)
    }
  })

  it('freezes what it has decided, so the DP does not grow with the speech', () => {
    let state = createAlignment(SCRIPT)
    for (let index = 1; index <= SCRIPT.length; index += 1) {
      state = advanceAlignment(state, SCRIPT.slice(0, index))
    }
    expect(state.anchorScript).toBeGreaterThan(0)
    expect(state.anchorSpoken).toBeGreaterThan(0)
  })

  it('lets a revision of the live tail correct a classification', () => {
    // whisper emits a wrong last word, then fixes it on the next partial. The margin behind the
    // last confident match is exactly what keeps that word revisable.
    const partial = [...SCRIPT.slice(0, 14), 'individual']
    let state = advanceAlignment(createAlignment(SCRIPT), partial)
    const before = state.tokens[14]?.status

    state = advanceAlignment(state, SCRIPT.slice(0, 16))
    expect(state.tokens[14]?.status).toBe('spoken')
    expect(state.tokens[15]?.status).toBe('spoken')
    expect(before).toBeDefined()
  })

  it('does nothing when handed a transcript with no words in it', () => {
    const state = advanceAlignment(createAlignment(SCRIPT), [])
    expect(state.cursor).toBe(0)
    expect(tokensWithStatus(state, 'pending')).toHaveLength(SCRIPT.length)
  })
})

describe('a speaker who abandons the script', () => {
  const offScript = words(
    'I am going to leave my notes entirely and talk about something else for a while now ' +
      'because the debate has moved on and nothing I wrote down is any use to anybody here.',
  )
  const state = alignSpeech(SCRIPT, offScript)

  it('does not force the script onto words that have nothing to do with it', () => {
    // Some function words legitimately match; what must not happen is the script marching
    // forward through material the speaker never touched.
    expect(state.cursor).toBeLessThan(SCRIPT.length / 2)
    expect(state.improvisations.length).toBeGreaterThan(offScript.length / 2)
  })
})
