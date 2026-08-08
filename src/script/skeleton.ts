/**
 * The template's Speaker 3 script, as data.
 *
 * The template's third-speaker section is not a table of questions like the rest of the
 * document — it is prose with the blanks left in ("In ___ Prop told us ___. But my ___ speaker
 * told you that this was not true because ___"). That is the observation the whole app turns
 * on: a filled case already *is* a speech for this seat, and this module is where that stops
 * being a claim and becomes text.
 *
 * Every fixed string below is quoted from `reference/template-blank.docx`, and
 * `__tests__/skeleton.test.ts` looks each phrase back up in the real file. It is quoted here
 * rather than imported from `case/fields.ts` because the two want different halves of the same
 * sentence: the registry wants the label a debater types under, this wants the words they say,
 * and the registry's labels stop at the blank they introduce.
 *
 * **Three places the template is followed rather than improved.**
 *
 * "Prop's 2nd/ 3rd speaker" is written with the slash, and a whip reading it out loud picks
 * one. The compiler cannot pick for them — nothing in the data model says which of the other
 * side's speakers answered — so the phrase ships verbatim and `edits.ts` is the escape hatch.
 *
 * "Even if we accept their characterisation of ___. This still does not work because ___"
 * leaves the first half a sentence fragment. The document does it twice, once with the full
 * stop and once without, and a comma would read better than either — but the debater's own
 * sheet says this, and the two have to be the same words.
 *
 * The template writes the second clash with slightly different glue ("First, Prop ___ told us",
 * "Their response is problematic because"). The data model has one engagement shape, so every
 * clash compiles with the first clash's wording.
 */

import type { LinePart, LineTemplate } from './lines.ts'
import { fixed, slot } from './lines.ts'

/** A run of lines that compile into one paragraph. */
export type SegmentTemplate = readonly LineTemplate[]

// ---------------------------------------------------------------------------
// Engagements — the whip taking one argument apart
// ---------------------------------------------------------------------------

/**
 * "In ___ Prop told us ___. But my ___ speaker told you that this was not true because ___."
 *
 * Two lines rather than one: a whip who has noted what the other side said but not yet what
 * our side answered can still deliver the first half.
 */
export const THEIR_ARGUMENT_LINES: SegmentTemplate = [
  [fixed('In'), slot('theirSpeakerPosition'), fixed('Prop told us'), slot('whatTheyTold'), fixed('.')],
  [
    fixed('But my'),
    slot('ourSpeakerPosition'),
    fixed('speaker told you that this was not true because'),
    slot('whyNotTrue'),
    fixed('.'),
  ],
]

/**
 * "What did we tell you? In ___, we told you that ___." then their answer and why it fails.
 *
 * The template's parenthetical on the last row — "(if this was responded before to say that
 * your 2nd responded to it)" — is an instruction to the person filling the sheet, not something
 * anyone says, so it is not in the script.
 */
export const OUR_ARGUMENT_LINES: SegmentTemplate = [
  [
    fixed('What did we tell you? In'),
    slot('ourSpeakerPosition'),
    fixed(', we told you that'),
    slot('whatWeTold'),
    fixed('.'),
  ],
  [
    fixed('Prop’s 2nd/ 3rd speaker responded by telling us'),
    slot('theirResponse'),
    fixed('. This is wrong because'),
    slot('whyWrong'),
    fixed('.'),
  ],
]

/**
 * The "They refused to respond" branch.
 *
 * One line, because the template splices straight through it — the blank sits mid-sentence
 * ("This is bad because ___ is something that happens all the time"), so half of it is not a
 * sentence at all.
 */
export const REFUSED_BRANCH_LINES: SegmentTemplate = [
  [
    fixed('They refused to respond. This is bad because'),
    slot('whyBad'),
    fixed(
      'is something that happens all the time and if Prop cannot prove an alternative scenario to',
    ),
    slot('alternativeScenario'),
    fixed(', their argument fails.'),
  ],
]

// The "Furthermore" paragraph is the one line the template writes two ways. A BP closing whip
// says the second version, and it is the same field either way — which is why the data model
// carries a flag on the branch rather than a second field nobody would remember to fill.
const FURTHERMORE_LINE: LineTemplate = [
  fixed('Furthermore, their argument does not make sense because'),
  slot('furthermore'),
  fixed('.'),
]
const FURTHERMORE_EXTENSION_LINE: LineTemplate = [
  fixed('Furthermore, their argument is tenuous, and this is my extension because'),
  slot('furthermore'),
  fixed('.'),
]

// Everything before the "Furthermore" fork.
const RESPONDED_OPENING_LINES: SegmentTemplate = [
  [
    fixed('In response they told us'),
    slot('theirResponse'),
    fixed('. This argument is wrong because'),
    slot('whyWrong'),
    fixed('.'),
  ],
  [
    fixed('Even if we accept their characterisation of'),
    slot('concededCharacterisation'),
    fixed('. This still does not work because'),
    slot('whyStillFails'),
    fixed('.'),
  ],
]

// The best-case/worst-case weighing that closes every engagement, split so a whip who has
// written the comparative but not the concession still gets the comparative.
const RESPONDED_CLOSING_LINES: SegmentTemplate = [
  [
    fixed(
      'We think that even if their argument is true in their best case, it still pales to our ' +
        'worst case scenario. This is what happens in prop’s best case:',
    ),
    slot('theirBestCase'),
    fixed('. This is bad because'),
    slot('whyBestCaseBad'),
    fixed('.'),
  ],
  [
    fixed('In our worst case, this does not happen because'),
    slot('ourWorstCase'),
    fixed('. Therefore, prop’s argument fails.'),
  ],
]

/**
 * The "(OR)" branch where the other side did answer — the common case.
 *
 * @param isExtension - Whether this engagement carries the BP extension. True swaps the
 *   "Furthermore" line for the template's extension wording; passing it on an AP case produces
 *   a whip claiming an extension in a format that has none.
 * @returns The branch's lines, in delivery order.
 */
export function respondedBranchLines(isExtension: boolean): SegmentTemplate {
  return [
    ...RESPONDED_OPENING_LINES,
    isExtension ? FURTHERMORE_EXTENSION_LINE : FURTHERMORE_LINE,
    ...RESPONDED_CLOSING_LINES,
  ]
}

/**
 * The "IF THE ARGUMENTS OVERLAP, SAY THIS" variant.
 *
 * Self-contained: it has no "(OR)" fork, because it already covers both what they said and how
 * they answered. Note the straight apostrophes from "prop's characterisation" onwards — the
 * overlap section is the one place the template does not use Word's curly ones, and normalising
 * them would break the docx lookup.
 */
export const OVERLAP_LINES: SegmentTemplate = [
  [
    fixed('Prop’s argument on'),
    slot('theirArgumentTopic'),
    fixed('overlap with our argument on'),
    slot('ourArgumentTopic'),
    fixed('. I will be dealing with them together.'),
  ],
  [fixed('So prop told you'), slot('whatPropTold'), fixed('.')],
  [fixed('We told you in our rebuttal'), slot('ourRebuttal'), fixed('.')],
  [fixed('We furthered this in our substantive by telling you'), slot('ourSubstantive'), fixed('.')],
  [
    fixed("The reason why prop's characterisation does not work is because"),
    slot('whyCharacterisationFails'),
    fixed('.'),
  ],
  [
    fixed('Prop tried to respond by telling you'),
    slot('theirResponse'),
    fixed('. That was insufficient because'),
    slot('whyInsufficient'),
    fixed('.'),
  ],
  [
    fixed("Even if we use their characterisation, Prop's argument doesn't work because"),
    slot('evenIfCharacterisation'),
    fixed('.'),
  ],
  [
    fixed("Furthermore, Prop's argument further hurts"),
    slot('furtherHurts'),
    fixed('because'),
    slot('furtherHurtsWhy'),
    fixed('.'),
  ],
  [
    fixed('Their best case scenario is'),
    slot('theirBestCase'),
    fixed('because'),
    slot('theirBestCaseWhy'),
    fixed('.'),
  ],
  [fixed('This is still bad because'), slot('whyStillBad'), fixed('.')],
  [
    fixed('Our worst case scenario does not have this situation because'),
    slot('ourWorstCase'),
    fixed('. Therefore, Prop’s world is definitely worse.'),
  ],
  [fixed('Our point on'), slot('pointThatStands'), fixed('stands.')],
]

// ---------------------------------------------------------------------------
// Clash signposting — assembled at compile time, not as a fixed line
// ---------------------------------------------------------------------------

/**
 * Glue for the clash opener and signpost.
 *
 * These lines cannot be `LineTemplate`s: the number of clashes and the number of arguments each
 * one handles are both properties of the case, and both are named out loud. The compiler builds
 * the sentences; these are the template's own words in them.
 */
export const CLASH_PHRASES = {
  /** After "I have two clashes" — the count and singular/plural come from the case. */
  clashCountTail: 'for the house.',
  /** Opens the first clash's signpost, before the ordinal. */
  firstClashLead: 'Under my',
  /** Follows the ordinal on the first clash, before the signpost proper. */
  firstClashTail: 'clash,',
  /** Opens every clash after the first, before the ordinal. */
  laterClashLead: 'Moving on to my',
  /** Follows the ordinal on a later clash, before its title. */
  laterClashTail: 'clash on',
  /** Introduces the list of arguments a clash covers. */
  dealingWith: 'I will be dealing with',
  /** Between the "( Prop/ Opp)" side word and the argument's topic. */
  argumentOn: 'argument on',
} as const

/** How the template numbers the clashes in "One ___ and Two ___". */
export const CLASH_NUMBER_WORDS: readonly string[] = [
  'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
]

// Spelled counts for "I have two clashes for the house." Past ten the numeral is used; a whip
// with eleven clashes has a bigger problem than the wording.
const CARDINAL_WORDS: readonly string[] = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
]

/**
 * Spells a count for the clash opener.
 *
 * @param count - How many clashes. Zero returns `'no'`, which keeps "I have no clashes for the
 *   house." grammatical rather than emitting "I have 0 clashes".
 * @returns The word, or the numeral past ten.
 */
export function cardinalWord(count: number): string {
  if (count <= 0) {
    return 'no'
  }
  return CARDINAL_WORDS[count - 1] ?? String(count)
}

/**
 * Names the bench an argument belongs to, for the template's "( Prop/ Opp)" slot.
 *
 * Never passed through `withOpponentName`: this is the side that actually ran the argument, not
 * the template's stand-in for "the other side", and swapping it points a government whip at
 * their own bench.
 *
 * @param side - Whose argument it is, from `HandledArgument.side`.
 * @returns `'Prop'` or `'Opp'`.
 */
export function benchName(side: 'gov' | 'opp'): string {
  return side === 'gov' ? 'Prop' : 'Opp'
}

// ---------------------------------------------------------------------------
// What the fidelity test checks
// ---------------------------------------------------------------------------

/** Every template this module declares, for the checks that walk all of them at once. */
const ALL_TEMPLATES: readonly LineTemplate[] = [
  ...THEIR_ARGUMENT_LINES,
  ...OUR_ARGUMENT_LINES,
  ...REFUSED_BRANCH_LINES,
  ...respondedBranchLines(false),
  FURTHERMORE_EXTENSION_LINE,
  ...OVERLAP_LINES,
]

/** Narrows a part to the fixed variant. */
function isFixed(part: LinePart): part is { kind: 'fixed'; text: string } {
  return part.kind === 'fixed'
}

/**
 * Every string in this module that claims to be the template's own words.
 *
 * `skeleton.test.ts` looks each of these up in the real `.docx`. A phrase reworded to read
 * better fails there, which is the point — the compiler's output has to be the document a
 * debater already knows how to fill in.
 */
export const TEMPLATE_PROSE: readonly string[] = [
  ...ALL_TEMPLATES.flatMap((line) => line.filter(isFixed).map((part) => part.text)),
  ...Object.values(CLASH_PHRASES),
]
