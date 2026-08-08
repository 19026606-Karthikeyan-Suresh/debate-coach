/**
 * Deciding when two words are the same word.
 *
 * This is the module the whole skip-detection feature rests on, and it is worth being blunt
 * about why: **without it the feature cries wolf and stops being used.** A speaker who says
 * every word of their script still gets a transcript full of "their" for "there", "16" for
 * "sixteen", "miss information" for "misinformation", and a dropped "the" every other line. An
 * aligner comparing raw strings reports all of that as skipped words, and after one speech the
 * debater learns to ignore the red — at which point a real skip is invisible too.
 *
 * So a comparison happens on three tiers, and the aligner scores them differently:
 *
 * - **exact** — the canonical forms agree, possibly through a variant ("16" ↔ "sixteen",
 *   "two" ↔ "to"). As good as a match gets.
 * - **near** — the sound keys agree. This is what absorbs ASR error, and it is deliberately
 *   worth less than exact so the DP prefers a real match wherever one is available nearby.
 * - **none** — different words.
 *
 * Runs are compared rather than single tokens, because the commonest transcription errors split
 * one word into two or run two into one. One written word said as several, or several run
 * together as one, is a match; that is the whole reason `matchRuns` takes arrays.
 */

/** How well two runs of words agree. */
export type MatchTier = 'exact' | 'near' | 'none'

/** One word, reduced to the forms a comparison can be made on. */
export interface NormalizedToken {
  /** As written or as transcribed. Never used for comparison, only for showing the debater. */
  readonly text: string
  /** Lowercase letters and digits only; apostrophes and hyphens are dropped, not split on. */
  readonly key: string
  /**
   * Other canonical forms this word may legitimately be transcribed as.
   *
   * Always contains `key`. Holds numeral spellings and the handful of homophone groups the
   * sound key gets wrong. Compared against a whole run's joined key, which is how "2016" is
   * matched against a transcript that says "twenty sixteen".
   */
  readonly variants: ReadonlySet<string>
  /** Metaphone key, or `''` for a token with no letters — a bare numeral has no sound to match. */
  readonly sound: string
}

// Below this many characters a sound key collides on too much to trust: metaphone maps "of" and
// "off" together, and every two-letter word in the language is one consonant. Short words are
// matched exactly or through a homophone group, never by sound.
const MIN_SOUND_LENGTH = 3

/**
 * Homophone groups metaphone does not catch.
 *
 * Almost every English homophone falls out of the sound key for free — their/there/they're,
 * your/you're, here/hear, no/know, right/write, weak/week all collapse without help. What does
 * not are the pairs where one member starts with a sounded consonant the other lacks, and in
 * practice that is a short list of number words and one-syllable function words. Each group is
 * folded to its first member and every member carries the whole group as variants.
 */
const HOMOPHONE_GROUPS: readonly (readonly string[])[] = [
  ['to', 'too', 'two'],
  ['one', 'won'],
  ['ate', 'eight'],
  ['whole', 'hole'],
  ['our', 'hour'],
  ['wear', 'where', 'ware'],
  // "know" reduces to the same sound as "no", but two letters is under the length a sound key
  // is trusted at, so the pair has to be named rather than derived.
  ['no', 'know'],
  ['new', 'knew'],
]

/** Every homophone group member, mapped to the whole group. */
const HOMOPHONES: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  HOMOPHONE_GROUPS.flatMap((group) => group.map((word) => [word, new Set(group)] as const)),
)

const UNITS: readonly string[] = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen',
]
const TENS: readonly string[] = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
]

/** Ordinal spellings that are not just the cardinal plus "th". */
const IRREGULAR_ORDINALS: Readonly<Record<string, string>> = {
  one: 'first',
  two: 'second',
  three: 'third',
  five: 'fifth',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
}

/**
 * Spells a whole number the way it is said, with no separators.
 *
 * @param value - A non-negative integer. Anything above 999 or below 0 returns `''`, because
 *   beyond that the spellings multiply ("two thousand sixteen", "twenty sixteen") and a wrong
 *   guess is worse than no variant at all — `spokenVariants` handles years separately.
 * @returns The spelling with spaces removed, e.g. `sixteen`, `fortytwo`, `twohundredthree`.
 */
export function numberToWords(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 999) {
    return ''
  }
  if (value < 20) {
    return UNITS[value] ?? ''
  }
  if (value < 100) {
    return `${TENS[Math.floor(value / 10)] ?? ''}${UNITS[value % 10] === 'zero' ? '' : (UNITS[value % 10] ?? '')}`
  }
  const remainder = value % 100
  return `${UNITS[Math.floor(value / 100)] ?? ''}hundred${remainder === 0 ? '' : numberToWords(remainder)}`
}

/** Turns a cardinal spelling into its ordinal — "twenty" to "twentieth", "three" to "third". */
function toOrdinal(cardinal: string): string {
  for (const [ending, ordinal] of Object.entries(IRREGULAR_ORDINALS)) {
    if (cardinal === ending) {
      return ordinal
    }
    if (cardinal.endsWith(ending)) {
      return `${cardinal.slice(0, -ending.length)}${ordinal}`
    }
  }
  return cardinal.endsWith('y') ? `${cardinal.slice(0, -1)}ieth` : `${cardinal}th`
}

/**
 * Spellings a year is said as.
 *
 * Both halves are produced because both are said: "twenty sixteen" and "two thousand sixteen"
 * are the same year, and which one a debater uses is not predictable from the digits.
 */
function yearVariants(value: number): readonly string[] {
  const century = Math.floor(value / 100)
  const remainder = value % 100
  const paired =
    remainder === 0
      ? `${numberToWords(century)}hundred`
      : `${numberToWords(century)}${remainder < 10 ? 'o' : ''}${numberToWords(remainder)}`
  const thousands =
    value < 2000 ? '' : `twothousand${remainder === 0 ? '' : numberToWords(remainder)}`
  return [paired, thousands].filter((spelling) => spelling.length > 0)
}

/**
 * Every canonical form a word may legitimately be transcribed as.
 *
 * @param key - A canonical key, already lowercased and stripped. Passing raw text produces
 *   variants nothing will ever match, since the comparison side is always canonical.
 * @returns The key plus its equivalents. Always contains `key` itself.
 */
export function spokenVariants(key: string): ReadonlySet<string> {
  const variants = new Set<string>([key])

  for (const word of HOMOPHONES.get(key) ?? []) {
    variants.add(word)
  }

  // "50%" canonicalises to "50percent"; strip the suffix, expand, put it back.
  const percent = key.endsWith('percent') ? 'percent' : ''
  const stem = percent ? key.slice(0, -percent.length) : key

  const ordinalMatch = /^(\d+)(st|nd|rd|th)$/.exec(stem)
  if (ordinalMatch?.[1]) {
    const spelled = numberToWords(Number(ordinalMatch[1]))
    if (spelled) {
      variants.add(toOrdinal(spelled))
    }
    return variants
  }

  if (/^\d+$/.test(stem)) {
    const value = Number(stem)
    const spellings = value >= 1000 && value <= 2999 ? yearVariants(value) : [numberToWords(value)]
    for (const spelling of spellings) {
      if (spelling.length > 0) {
        variants.add(`${spelling}${percent}`)
      }
    }
  }

  return variants
}

// ---------------------------------------------------------------------------
// Metaphone
// ---------------------------------------------------------------------------

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U'])

/** Whether the character at `position` is a vowel; out-of-range positions are not. */
function isVowel(word: string, position: number): boolean {
  return VOWELS.has(word[position] ?? '')
}

// Sound keys are recomputed for every multi-word run the aligner considers, which on a full
// speech is tens of thousands of lookups over a few hundred distinct strings.
const SOUND_CACHE = new Map<string, string>()

/** Memoized {@link metaphone}, for the run comparisons that cannot use a precomputed key. */
function soundOf(word: string): string {
  const cached = SOUND_CACHE.get(word)
  if (cached !== undefined) {
    return cached
  }
  const computed = metaphone(word)
  SOUND_CACHE.set(word, computed)
  return computed
}

/**
 * Reduces a word to how it sounds.
 *
 * Classic Metaphone rather than Double Metaphone: the second key of the double variant exists to
 * handle names of non-English origin, this app compares ordinary English prose, and 500 lines of
 * transliterated rules is 500 lines nobody will ever be able to review against the transcript
 * that broke. What it must get right is the class of error whisper actually makes — homophones
 * and a doubled or dropped consonant — and the rules below cover those.
 *
 * @param word - A canonical key. Digits and anything else non-alphabetic are ignored, so a bare
 *   numeral returns `''` and never matches by sound.
 * @returns The sound key in upper case, or `''` when the word has no letters.
 */
export function metaphone(word: string): string {
  // Doubles are collapsed before anything else, which is what folds "misinformation" against a
  // transcript that heard "miss information".
  const letters = word
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .replace(/(.)\1+/g, '$1')
  if (letters.length === 0) {
    return ''
  }

  // Silent leading consonants. The written letter is there, the sound is not, so a transcript
  // that spelled it the other way must still match: "know" and "no", "write" and "right".
  let head = letters
  if (/^(AE|GN|KN|PN|WR)/.test(head)) {
    head = head.slice(1)
  } else if (head.startsWith('X')) {
    head = `S${head.slice(1)}`
  } else if (head.startsWith('WH')) {
    head = `W${head.slice(1)}`
  }

  const sound: string[] = []
  for (let position = 0; position < head.length; position += 1) {
    const letter = head[position] ?? ''
    const next = head[position + 1] ?? ''
    const previous = head[position - 1] ?? ''

    // Vowels are only pronounced distinctly at the front; inside a word they are the first
    // thing a fast speaker slurs and the first thing an ASR model gets wrong.
    if (VOWELS.has(letter)) {
      if (position === 0) {
        sound.push(letter)
      }
      continue
    }

    switch (letter) {
      case 'B':
        // "dumb", "comb" — a final B after M is not said.
        if (!(position === head.length - 1 && previous === 'M')) {
          sound.push('B')
        }
        break
      case 'C':
        if (next === 'H' || (next === 'I' && head[position + 2] === 'A')) {
          sound.push('X')
        } else if (next === 'I' || next === 'E' || next === 'Y') {
          sound.push('S')
        } else {
          sound.push('K')
        }
        break
      case 'D':
        if (next === 'G' && 'EYI'.includes(head[position + 2] ?? '')) {
          sound.push('J')
          position += 1
        } else {
          sound.push('T')
        }
        break
      case 'G':
        // "night", "right" — GH before a consonant is silent, and the H has to be consumed with
        // it or "right" keeps an H that "write" never had and the two stop matching.
        if (next === 'H' && !isVowel(head, position + 2)) {
          position += 1
          break
        }
        if (next === 'N') {
          break
        }
        sound.push('EYI'.includes(next) ? 'J' : 'K')
        break
      case 'H':
        // Only sounded when it opens a syllable.
        if (!VOWELS.has(previous) || isVowel(head, position + 1)) {
          sound.push('H')
        }
        break
      case 'K':
        if (previous !== 'C') {
          sound.push('K')
        }
        break
      case 'P':
        sound.push(next === 'H' ? 'F' : 'P')
        break
      case 'Q':
        sound.push('K')
        break
      case 'S':
        sound.push(next === 'H' || (next === 'I' && 'OA'.includes(head[position + 2] ?? '')) ? 'X' : 'S')
        break
      case 'T':
        if (next === 'H') {
          sound.push('0')
          position += 1
        } else if (next === 'I' && 'OA'.includes(head[position + 2] ?? '')) {
          sound.push('X')
        } else if (previous !== 'C') {
          sound.push('T')
        }
        break
      case 'V':
        sound.push('F')
        break
      case 'W':
      case 'Y':
        // A glide only counts when something follows it to glide into.
        if (isVowel(head, position + 1)) {
          sound.push(letter)
        }
        break
      case 'X':
        sound.push('KS')
        break
      case 'Z':
        sound.push('S')
        break
      default:
        sound.push(letter)
    }
  }

  return sound.join('')
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Reduces one word to its comparable forms.
 *
 * @param text - A single word as written or as transcribed. Surrounding punctuation is dropped;
 *   passing a whole phrase produces one token whose key is the phrase run together, which is a
 *   valid thing to want but not what the tokenizer does.
 * @returns The normalized token. A token of pure punctuation has an empty key and matches
 *   nothing, including another empty key.
 */
export function normalizeToken(text: string): NormalizedToken {
  // A percent sign is the one symbol that is read out as a word, so it survives canonicalisation.
  const key = text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/%/g, 'percent')
    .replace(/[^a-z0-9]/g, '')

  return { text, key, variants: spokenVariants(key), sound: metaphone(key) }
}

/**
 * Reduces a run of words.
 *
 * @param words - Words in order, already split. Empty entries produce empty tokens rather than
 *   being dropped, so indices still line up with whatever produced the list.
 * @returns One token per word.
 */
export function normalizeTokens(words: readonly string[]): readonly NormalizedToken[] {
  return words.map(normalizeToken)
}

/**
 * Whether two keys differ only by an inflection a listener would not notice.
 *
 * A speaker who says "damage" where the script says "damages" has not skipped a word, and a
 * transcript that drops a final -s off fast speech is the single commonest thing whisper does.
 * Calling either a skip is the noise that makes the whole feature ignorable.
 *
 * Deliberately narrow — plurals and third-person -s only, never a general stemmer. The cost is
 * a "new"/"news" pair scoring `near`; the DP prefers an exact match wherever one is available,
 * and a general stemmer would put "spread"/"spreading" in the same bucket as far worse pairs.
 */
function isInflection(left: string, right: string): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  if (shorter.length < MIN_SOUND_LENGTH) {
    return false
  }
  if (longer === `${shorter}s` || longer === `${shorter}es`) {
    return true
  }
  return shorter.endsWith('y') && longer === `${shorter.slice(0, -1)}ies`
}

/**
 * Decides whether two runs of words are the same words.
 *
 * Runs, not single words, because the two commonest transcription errors are splitting one word
 * into two and running two into one. Comparing joined keys handles both without the aligner
 * needing to know which happened.
 *
 * @param scriptRun - One or more consecutive script tokens. An empty run matches nothing.
 * @param spokenRun - One or more consecutive transcript tokens. An empty run matches nothing.
 * @returns The strongest tier the two runs reach.
 */
export function matchRuns(
  scriptRun: readonly NormalizedToken[],
  spokenRun: readonly NormalizedToken[],
): MatchTier {
  if (scriptRun.length === 0 || spokenRun.length === 0) {
    return 'none'
  }

  const scriptKey = scriptRun.map((token) => token.key).join('')
  const spokenKey = spokenRun.map((token) => token.key).join('')
  if (scriptKey.length === 0 || spokenKey.length === 0) {
    return 'none'
  }
  if (scriptKey === spokenKey) {
    return 'exact'
  }

  // Variants belong to a single word, so they are only consulted against the other side taken
  // whole: "2016" carries "twentysixteen", which is what the two-token run joins to.
  const scriptSingle = scriptRun.length === 1 ? scriptRun[0] : undefined
  const spokenSingle = spokenRun.length === 1 ? spokenRun[0] : undefined
  if (scriptSingle?.variants.has(spokenKey) || spokenSingle?.variants.has(scriptKey)) {
    return 'exact'
  }

  if (scriptKey.length < MIN_SOUND_LENGTH || spokenKey.length < MIN_SOUND_LENGTH) {
    return 'none'
  }
  if (isInflection(scriptKey, spokenKey)) {
    return 'near'
  }

  // The joined run is sounded as one word rather than by concatenating each word's key: a
  // metaphone key keeps a leading vowel, so joining "MS" and "INFRMXN" would leave an I in the
  // middle of "miss information" that "misinformation" does not have, and the two would part.
  const scriptSound = scriptSingle ? scriptSingle.sound : soundOf(scriptKey)
  const spokenSound = spokenSingle ? spokenSingle.sound : soundOf(spokenKey)
  return scriptSound.length > 0 && scriptSound === spokenSound ? 'near' : 'none'
}
