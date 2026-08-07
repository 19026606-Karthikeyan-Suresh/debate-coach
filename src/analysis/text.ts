/**
 * Text primitives every rule is built on.
 *
 * Nothing here knows what a debate is. The rules stay small because sentence splitting, word
 * counting, lexicon matching, and content-word extraction all live here and are tested once.
 *
 * Two things are load-bearing across the whole analyzer:
 *
 * - **Offsets survive.** Sentences, tokens, and phrase matches all carry their index into the
 *   original passage, because a finding underlines a span in the editor rather than restating
 *   the text. Anything that trims or normalises has to adjust the offset with it.
 * - **Apostrophes come in two shapes.** The reference template is Word output and uses curly
 *   ones; a debater typing into the app produces straight ones. A lexicon that matched only one
 *   would silently miss half the real text, so phrase patterns accept either.
 */

/** A half-open range of characters, `[start, end)`, into the field's text. */
export interface TextSpan {
  readonly start: number
  /** Index one past the last character, so `text.slice(start, end)` is the matched run. */
  readonly end: number
}

/** One sentence, with its offsets into the passage it came from. */
export interface Sentence {
  /** The sentence, trimmed. */
  readonly text: string
  readonly start: number
  readonly end: number
}

/** One word, with the normalized form the lexicons and content-word sets are built from. */
export interface Token {
  /** As written, so a capital letter is still visible to the specificity check. */
  readonly text: string
  /** Lowercased, with a curly apostrophe folded to a straight one. */
  readonly normalized: string
  readonly start: number
  readonly end: number
}

/**
 * One lexicon entry.
 *
 * A string is matched whole-word and case-insensitively. A `RegExp` is used as given and **must
 * carry the `g` flag** — `matchAll` throws without it — and exists for the handful of markers
 * that are a construction rather than a phrase, like "by" plus a gerund.
 */
export type LexiconEntry = string | RegExp

/** Where a lexicon entry matched a passage. */
export interface PhraseMatch {
  /** The entry that matched, as a string — a `RegExp` entry reports its source. Stable enough
   *  to deduplicate on, which is what the per-term rules key off. */
  readonly phrase: string
  /** The text as actually written, for quoting back in a message. */
  readonly text: string
  readonly span: TextSpan
}

// A sentence ends at ., ! or ? followed by whitespace or the end of the passage, or at a line
// break. Abbreviations ("etc.", "U.S.") therefore split early. That costs recall in the one
// rule that looks at the *next* sentence and nothing anywhere else, which is why it is not
// worth an abbreviation list that would need maintaining.
const SENTENCE_BOUNDARY = /[.!?]+["'’”)\]]*(?=\s|$)|\n+/g

// A word is letters or digits, optionally with internal apostrophes or hyphens, so "don't" and
// "long-term" stay single tokens rather than becoming three.
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu

/**
 * Words carrying no topical content, dropped before any overlap comparison.
 *
 * Deliberately includes the modal and hedging verbs (`can`, `could`, `will`, `should`): a pair
 * of substantives both written in "this could lead to" register are not thereby about the same
 * thing, and leaving those in inflates every similarity score by the same amount.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'but', 'for', 'not', 'are', 'was', 'were', 'been', 'being', 'have', 'has',
  'had', 'that', 'this', 'these', 'those', 'with', 'from', 'they', 'them', 'their', 'there',
  'then', 'than', 'when', 'where', 'what', 'which', 'who', 'whom', 'whose', 'will', 'would',
  'can', 'could', 'should', 'shall', 'may', 'might', 'must', 'into', 'onto', 'upon', 'over',
  'under', 'about', 'also', 'only', 'even', 'more', 'most', 'much', 'such', 'some', 'any',
  'all', 'each', 'other', 'others', 'our', 'ours', 'your', 'yours', 'his', 'her', 'its',
  'you', 'him', 'she', 'we', 'us', 'it', 'is', 'be', 'do', 'does', 'did', 'done',
  'because', 'therefore', 'however', 'thus', 'hence', 'while', 'whilst', 'though', 'although',
  'here', 'very', 'just', 'like', 'get', 'got', 'make', 'makes', 'made', 'want', 'wants',
  'say', 'says', 'said', 'tell', 'tells', 'told', 'one', 'two', 'three', 'out', 'off', 'own',
])

/**
 * Splits a passage into sentences.
 *
 * @param passage - One field's text. Empty or whitespace-only returns an empty array rather
 *   than one blank sentence, so callers never have to filter.
 * @returns Sentences in order, each trimmed but carrying its offsets into `passage`.
 */
export function splitSentences(passage: string): readonly Sentence[] {
  const sentences: Sentence[] = []
  let cursor = 0

  for (const match of passage.matchAll(SENTENCE_BOUNDARY)) {
    const end = match.index + match[0].length
    pushSentence(sentences, passage, cursor, end)
    cursor = end
  }
  pushSentence(sentences, passage, cursor, passage.length)

  return sentences
}

/** Appends one sentence, trimmed, with its offsets shifted to match the trim. Skips blanks. */
function pushSentence(sentences: Sentence[], passage: string, from: number, to: number): void {
  const raw = passage.slice(from, to)
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return
  }
  const leading = raw.length - raw.trimStart().length
  sentences.push({ text: trimmed, start: from + leading, end: from + leading + trimmed.length })
}

/**
 * Splits a passage into words.
 *
 * @param passage - Text to scan. Punctuation and whitespace are dropped, not returned as tokens.
 * @returns Tokens in order, each with both the written and the normalized form.
 */
export function tokenize(passage: string): readonly Token[] {
  return [...passage.matchAll(WORD)].map((match) => ({
    text: match[0],
    normalized: match[0].toLowerCase().replace(/’/g, "'"),
    start: match.index,
    end: match.index + match[0].length,
  }))
}

/**
 * Counts words.
 *
 * @param passage - Text to measure. Numbers count as words; punctuation does not.
 * @returns The word count.
 */
export function wordCount(passage: string): number {
  return tokenize(passage).length
}

/**
 * Folds a plural to its singular so "damage" and "damages" compare equal.
 *
 * Plurals only. `-ing` and `-ed` are deliberately left alone: stripping them collides badly on
 * exactly the vocabulary this app sees — "spread" would become "spr" while "spreading" became
 * "spread", so the two would stop matching each other, which is worse than not stemming at all.
 *
 * @param word - A normalized token. Anything shorter than four characters is returned unchanged.
 * @returns The folded form. Only ever used to build comparison sets, never to display anything.
 */
export function stem(word: string): string {
  if (word.length <= 3) {
    return word
  }
  if (word.endsWith('ies') && word.length > 4) {
    return `${word.slice(0, -3)}y`
  }
  // "business", "bus", "analysis" — a trailing s that is part of the word, not a plural.
  if (/(ss|us|is)$/.test(word)) {
    return word
  }
  if (/(ch|sh|[sxz])es$/.test(word)) {
    return word.slice(0, -2)
  }
  if (word.endsWith('s')) {
    return word.slice(0, -1)
  }
  return word
}

/**
 * Extracts the topical vocabulary of a passage.
 *
 * @param passage - Text to reduce. Case, punctuation, plurals, and stopwords are all discarded,
 *   so two passages saying the same thing in different words still score as different.
 * @returns Stemmed content words, deduplicated.
 */
export function contentWords(passage: string): ReadonlySet<string> {
  const words = new Set<string>()
  for (const token of tokenize(passage)) {
    if (STOPWORDS.has(token.normalized)) {
      continue
    }
    const base = stem(token.normalized)
    if (base.length >= 3 && !STOPWORDS.has(base)) {
      words.add(base)
    }
  }
  return words
}

/**
 * Jaccard similarity — shared words over total distinct words.
 *
 * @param left - One word set.
 * @param right - The other. An empty set on either side scores 0 rather than dividing by zero,
 *   so an unwritten field never looks identical to another unwritten field.
 * @returns 0 for no overlap, 1 for identical vocabularies.
 */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0
  }
  let shared = 0
  for (const word of left) {
    if (right.has(word)) {
      shared += 1
    }
  }
  return shared / (left.size + right.size - shared)
}

/**
 * Removes every word of `subtracted` from `base`.
 *
 * @param base - The set to narrow.
 * @param subtracted - Words to drop. Used to strip the motion's own vocabulary before comparing
 *   two substantives, since every substantive in a round shares the motion's nouns.
 * @returns A new set; neither argument is modified.
 */
export function withoutWords(
  base: ReadonlySet<string>,
  subtracted: ReadonlySet<string>,
): ReadonlySet<string> {
  const narrowed = new Set<string>()
  for (const word of base) {
    if (!subtracted.has(word)) {
      narrowed.add(word)
    }
  }
  return narrowed
}

// Compiled lexicon patterns, keyed by the phrase. The lexicons are module constants scanned on
// every keystroke's worth of debounced analysis, so recompiling them each pass is pure waste.
const PHRASE_PATTERNS = new Map<string, RegExp>()

/** Compiles one lexicon phrase into a whole-word, case-insensitive, apostrophe-tolerant pattern. */
function phrasePattern(phrase: string): RegExp {
  const cached = PHRASE_PATTERNS.get(phrase)
  if (cached) {
    return cached
  }

  // Escape first, then widen: whitespace in the lexicon matches any run of whitespace (Word
  // wraps mid-phrase), and either apostrophe matches either apostrophe.
  const body = phrase
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]"))
    .join('\\s+')
  const leading = /^[\p{L}\p{N}]/u.test(phrase) ? '\\b' : ''
  const trailing = /[\p{L}\p{N}]$/u.test(phrase) ? '\\b' : ''

  const pattern = new RegExp(`${leading}${body}${trailing}`, 'giu')
  PHRASE_PATTERNS.set(phrase, pattern)
  return pattern
}

/**
 * Finds every place any of a lexicon's entries appears.
 *
 * Overlapping matches are collapsed to the longest one starting earliest, so a lexicon holding
 * both "because" and "because of" reports one match against "because of", not two. Every rule
 * that counts matches depends on that — two hits for one connective would double its depth.
 *
 * @param passage - Text to scan.
 * @param entries - Lexicon entries. String entries match case-insensitively and whole-word, so
 *   `now` does not match inside `know`; a `RegExp` entry without the `g` flag throws.
 * @returns Matches in document order, non-overlapping.
 */
export function findPhrases(
  passage: string,
  entries: readonly LexiconEntry[],
): readonly PhraseMatch[] {
  const found: PhraseMatch[] = []
  for (const entry of entries) {
    const pattern = typeof entry === 'string' ? phrasePattern(entry) : entry
    for (const match of passage.matchAll(pattern)) {
      found.push({
        phrase: typeof entry === 'string' ? entry : entry.source,
        text: match[0],
        span: { start: match.index, end: match.index + match[0].length },
      })
    }
  }

  // Earliest first, and among matches starting together the longest first, so the suppression
  // pass below keeps "because of" rather than the "because" nested inside it.
  found.sort((left, right) => {
    if (left.span.start !== right.span.start) {
      return left.span.start - right.span.start
    }
    return right.span.end - left.span.end
  })

  const kept: PhraseMatch[] = []
  let consumedTo = -1
  for (const match of found) {
    if (match.span.start >= consumedTo) {
      kept.push(match)
      consumedTo = match.span.end
    }
  }
  return kept
}

/**
 * Finds the earliest occurrence of any of a lexicon's entries.
 *
 * @param passage - Text to scan.
 * @param entries - Lexicon entries.
 * @returns The earliest match, or null if none of them appear.
 */
export function firstPhrase(
  passage: string,
  entries: readonly LexiconEntry[],
): PhraseMatch | null {
  return findPhrases(passage, entries)[0] ?? null
}

/**
 * Whether any of a lexicon's entries appears.
 *
 * @param passage - Text to scan.
 * @param entries - Lexicon entries.
 * @returns True if at least one appears.
 */
export function containsPhrase(passage: string, entries: readonly LexiconEntry[]): boolean {
  return firstPhrase(passage, entries) !== null
}

/**
 * Whether a sentence contains something concrete enough to anchor a vague word.
 *
 * A number, a percentage, a currency amount, or a proper noun. The proper-noun test skips the
 * first token, because every sentence starts with a capital and that says nothing.
 *
 * @param sentence - One sentence. Passing a whole multi-sentence field makes this far too
 *   permissive — a date in sentence one would excuse a vague claim in sentence five.
 * @returns True when the sentence names something checkable.
 */
export function hasSpecificityMarker(sentence: string): boolean {
  if (/[\d%$£€]/.test(sentence)) {
    return true
  }
  const tokens = tokenize(sentence)
  return tokens
    .slice(1)
    .some((token) => token.text !== 'I' && /^\p{Lu}/u.test(token.text))
}
