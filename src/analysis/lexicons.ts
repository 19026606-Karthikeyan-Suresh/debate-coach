/**
 * The word lists the rules match against.
 *
 * These are the analyzer's actual opinions, so the omissions matter as much as the entries and
 * each one is justified where it sits. The bias throughout is towards **not firing**: a rule
 * that flags good writing gets switched off by its user within a week, and then the rules that
 * were right go with it.
 *
 * Every list is matched whole-word and case-insensitively by `findPhrases`, so a multi-word
 * entry like `as a result` matches across any run of whitespace and a one-word entry like `now`
 * does not match inside `know`.
 */

import type { LexiconEntry } from './text.ts'

/**
 * Markers that a clause explains the one before it.
 *
 * Three families, and all three are needed. Dropping either of the last two turned pages of
 * ordinary policy writing in the reference case into "bare assertion", which is the exact
 * false positive this rule cannot afford:
 *
 * 1. **Connectives** — `because`, `therefore`, `as a result`.
 * 2. **Mechanism verbs** — `reduces`, `forces`, `encourages`. A debater describing how a policy
 *    bites writes "this reduces X", not "this is because X".
 * 3. **`by` plus a gerund** — "solve it *by implementing* Y". The commonest way a mechanism is
 *    stated in this template, and the only entry that has to be a pattern rather than a phrase.
 *
 * `as` is deliberately absent. It is causal often enough to be tempting ("a problem as it
 * uproots a life") and temporal, comparative, or discursive the rest of the time ("as trust was
 * broken", "as much as", "as mentioned above"), and adding it would mean also maintaining a
 * list of the collocations to subtract again. The mechanism verbs cover the same sentences.
 *
 * Bare `so` is absent for the same reason — "so many" and "and so" swamp the causal use.
 */
export const CAUSAL_CONNECTIVES: readonly LexiconEntry[] = [
  'because', 'because of', 'since', 'due to', 'owing to',
  'so that', 'therefore', 'thus', 'hence', 'consequently', 'thereby',
  'as a result', 'as a consequence', 'in turn',
  'which means', 'means that', 'this means',
  'leads to', 'lead to', 'leading to', 'led to',
  'results in', 'result in', 'resulting in', 'resulted in',
  'cause', 'causes', 'caused', 'causing',
  'which is why', 'this is why', 'that is why',
  'translates into', 'stems from', 'rooted in',

  // Mechanism verbs. Three families of exclusion: `makes` and `gets` ("make a post", "get them
  // to"), `helps` (an intention, not a mechanism), and `allow` — which in a debate case is
  // nearly always deontic, as in "we should not allow this", rather than causal.
  'ensure', 'ensures', 'encourage', 'encourages', 'incentivise', 'incentivises',
  'incentivize', 'incentivizes', 'deter', 'deters', 'prevent', 'prevents',
  'reduce', 'reduces', 'increase', 'increases', 'enable', 'enables',
  'force', 'forces', 'drive', 'drives', 'push', 'pushes',
  'trigger', 'triggers', 'worsen', 'worsens', 'undermine', 'undermines',

  // "by implementing", "by warning", "by holding them liable".
  /\bby \p{L}+ing\b/giu,
]

/**
 * Phrasings that pass a judgement without giving a reason.
 *
 * `is clear` and `is obvious` are not here — asserting obviousness is a delivery habit, and
 * `hedgeAndFiller` already owns `clearly` and `obviously`. Flagging it twice would read as two
 * separate problems with one sentence.
 */
export const EVALUATIVE_MARKERS: readonly string[] = [
  'is bad', 'are bad', 'is worse', 'is the worst',
  'is terrible', 'is awful', 'is horrific', 'is disastrous', 'is a disaster',
  'devastating', 'catastrophic', 'horrific',
  'is unacceptable', 'unacceptable', 'is wrong', 'are wrong',
  'is harmful', 'is damaging', 'is dangerous',
  'is a problem', 'is problematic', 'is an issue',
  'is important', 'is crucial', 'is vital', 'is essential', 'is significant',
  'is unjust', 'is unfair', 'is immoral', 'is unethical',
  'is huge', 'is massive', 'is enormous',
]

/**
 * Nouns and quantifiers that name nobody in particular.
 *
 * Flagged only when the sentence holding them has no specificity marker, so "many people — 4.3
 * million in 2023" passes and "many people" alone does not.
 *
 * `harms` is absent: in this template it is nearly always the verb ("this harms lives"), where
 * the vague word is the object, not the verb. `damages` stays, because "many damages" is the
 * noun and the sentences using it as a verb are vague on other grounds anyway.
 */
export const VAGUE_TERMS: readonly string[] = [
  'people', 'society', 'the public', 'communities', 'the community',
  'lives', 'individuals', 'individual', 'citizens', 'everyone', 'everybody',
  'others', 'groups', 'things', 'stuff', 'issues', 'problems', 'damages',
  'many', 'a lot', 'lots of', 'several', 'numerous', 'various', 'countless',
  'a large number', 'a number of', 'certain', 'significant', 'substantial',
]

/** One hedge, plus the neighbouring words that mean it is not being used as a hedge. */
export interface HedgeTerm {
  readonly phrase: string
  /** Words that, immediately before the match, make it something other than filler. */
  readonly notPrecededBy: readonly string[]
  /** Words that, immediately after the match, make it something other than filler. */
  readonly notFollowedBy: readonly string[]
}

/** Builds a hedge entry. Both guards default to empty, which is right for almost all of them. */
function hedge(
  phrase: string,
  notPrecededBy: readonly string[] = [],
  notFollowedBy: readonly string[] = [],
): HedgeTerm {
  return { phrase, notPrecededBy, notFollowedBy }
}

/**
 * Words that weaken a sentence without adding to it.
 *
 * `just` carries guards because debate prose uses it as a real adjective more than most writing
 * does — "a just war", "the just outcome" — and flagging those would be flatly wrong.
 */
export const HEDGE_TERMS: readonly HedgeTerm[] = [
  hedge('basically'),
  hedge('essentially'),
  hedge('kind of'),
  hedge('sort of'),
  hedge('pretty much'),
  hedge('somewhat'),
  hedge('quite'),
  hedge('a bit'),
  hedge('very'),
  hedge('really'),
  hedge('actually'),
  hedge('literally'),
  hedge('simply'),
  hedge('honestly'),
  hedge('obviously'),
  hedge('clearly'),
  hedge('definitely'),
  hedge('totally'),
  hedge('arguably'),
  hedge('maybe'),
  hedge('perhaps'),
  hedge('I think'),
  hedge('I feel'),
  hedge('I believe'),
  hedge('you know'),
  hedge(
    'just',
    ['a', 'the', 'more', 'most', 'truly', 'perfectly'],
    ['cause', 'war', 'society', 'world', 'outcome', 'law', 'laws', 'system', 'peace', 'settlement'],
  ),
]

/** Language that compares a world to another world rather than describing one. */
export const COMPARATIVE_MARKERS: readonly string[] = [
  'without', 'status quo', 'even if', 'worse than', 'better than',
  'compared to', 'in comparison', 'otherwise', 'the alternative',
  'best case', 'worst case', 'our world', 'their world', 'pales',
  'if we do not', "if we don't", 'if they do not', 'outweighs', 'on balance',
  'instead of', 'rather than', 'absent this', 'as it stands', 'counterfactual',
]

/** One axis a judge weighs an impact on. */
export interface ImpactAxis {
  readonly id: 'magnitude' | 'probability' | 'reversibility' | 'timeframe'
  /** Name of the axis, used in the finding's message. */
  readonly label: string
  /** The question a judge asks when the axis is missing. Becomes the finding's prompt. */
  readonly question: string
  readonly markers: readonly string[]
}

/**
 * The four axes an impact has to be argued on.
 *
 * The probability list holds no modals. `can`, `could`, `will` and `may` are how every sentence
 * in every case is written; counting them would mark probability answered on any substantive
 * with a verb in it. Probability is argued with `likely`, `risk`, and `inevitable`, or it is not
 * argued. `always` is likewise absent — in practice it is emphasis, not a frequency claim.
 */
export const IMPACT_AXES: readonly ImpactAxis[] = [
  {
    id: 'magnitude',
    label: 'magnitude',
    question: 'How many people does this reach, and how hard does it hit each of them?',
    markers: [
      'many', 'most', 'majority', 'minority', 'a handful', 'few',
      'millions', 'thousands', 'hundreds', 'billions', 'percent',
      'widespread', 'nationwide', 'across the country', 'at scale', 'the scale',
      'vast', 'huge', 'enormous', 'severe', 'disproportionate',
      'loss of life', 'deaths', 'die', 'starve', 'entire',
    ],
  },
  {
    id: 'probability',
    label: 'probability',
    question: 'How often does this actually happen, rather than how bad it is when it does?',
    markers: [
      'likely', 'unlikely', 'probability', 'probable', 'improbable',
      'inevitable', 'inevitably', 'risk', 'risks', 'chance', 'chances',
      'guaranteed', 'certain', 'uncertain', 'rarely', 'seldom', 'odds',
      'in most cases', 'more often than not', 'plausible', 'expected to',
      'tends to', 'on average', 'systematically',
    ],
  },
  {
    id: 'reversibility',
    label: 'reversibility',
    question: 'Can this be undone later, or is the harm permanent once it lands?',
    markers: [
      'irreversible', 'irrecoverable', 'irreparable', 'unrecoverable',
      'permanent', 'permanently', 'lasting', 'for good',
      'cannot be undone', 'never recover', 'no going back',
      'temporary', 'reversible', 'recoverable', 'restore', 'restored', 'undone',
    ],
  },
  {
    id: 'timeframe',
    label: 'timeframe',
    question: 'Is this happening now or projected, and how long until it bites?',
    markers: [
      'now', 'today', 'currently', 'already', 'immediately', 'soon', 'eventually',
      'within', 'overnight', 'over time', 'in the future', 'by then', 'in the meantime',
      'year', 'years', 'decade', 'decades', 'month', 'months', 'week', 'weeks',
      'generation', 'generations', 'long term', 'long-term', 'short term', 'short-term',
    ],
  },
]
