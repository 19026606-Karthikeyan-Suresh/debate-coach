/**
 * The editable-field registry.
 *
 * One declarative entry per field the case builder renders. Labels are imported from the
 * `*_LABELS` records in `src/types/case.ts` rather than retyped, so the template-fidelity
 * guarantee holds through the UI for free — a label cannot drift here without failing the
 * test that diffs those records against the real `.docx`.
 *
 * Hints are ours, not the template's. Each says what a *good* answer does, in one line, and
 * exists because the template's questions are terse enough to answer badly in good faith
 * ("Why is the problem so bad?" invites an adjective, not an impact).
 *
 * The Speaker 3 script slots have no `*_LABELS` record because the template writes them as
 * prose rather than table rows; their labels are the sentence with its blank left in, and
 * `fields.test.ts` checks each fragment still appears in the docx.
 */

import type { Side } from '../formats/index.ts'
import {
  CASE_DIVISION_LABELS,
  DEFINITION_LABELS,
  EXTENSION_LABELS,
  FIVE_W1H_LABELS,
  OPPOSING_REBUTTAL_LABELS,
  POLICY_LABELS,
  POLICY_REBUTTAL_LABELS,
  PREP_LABELS,
  REBUTTAL_LABELS,
  SETUP_LABELS,
  SUBSTANTIVE_LABELS,
} from '../types/case.ts'
import type {
  CaseDivision,
  DefinitionBlock,
  ExtensionBlock,
  FiveW1H,
  OpposingRebuttalFieldKey,
  OurArgumentEngagement,
  OverlapEngagement,
  PolicyBlock,
  PolicyRebuttalBlock,
  RebuttalFieldKey,
  RefusedBranch,
  RespondedBranch,
  SetupBlock,
  SubstantiveFieldKey,
  TheirArgumentEngagement,
} from '../types/case.ts'

/**
 * One editable row.
 *
 * `TKey` is narrowed to the owning block's keys so a registry entry cannot name a field that
 * does not exist; the arrays below are all typed against their block.
 */
export interface FieldSpec<TKey extends string = string> {
  /** Property name on the block. Also the last segment of the field's addressable path. */
  readonly key: TKey
  /** The template's question, verbatim. Rendered as the field's label. */
  readonly label: string
  /** One line on what a good answer does. Rendered under the label, never as placeholder text. */
  readonly hint: string
  /** Textarea height. 1 renders a single-line input — use it only where the answer is a name. */
  readonly rows: number
}

/**
 * Builds one registry entry.
 *
 * @param key - Property name on the block; the array's element type rejects an unknown one.
 * @param label - Template question. Pass the `*_LABELS` constant, never a retyped string.
 * @param hint - What a good answer does. One line.
 * @param rows - Textarea height. Defaults to 3, which fits about two sentences.
 */
function field<TKey extends string>(
  key: TKey,
  label: string,
  hint: string,
  rows = 3,
): FieldSpec<TKey> {
  return { key, label, hint, rows }
}

// ---------------------------------------------------------------------------
// Prep sheet
// ---------------------------------------------------------------------------

/** Prep sheet text fields. `needsMechanism` and `pois` are excluded — neither is a text box. */
export const PREP_FIELDS: readonly FieldSpec<'motion' | 'actorsSplit' | 'scratch'>[] = [
  field(
    'motion',
    PREP_LABELS.motion,
    'Verbatim, including the qualifiers. Every link-back is checked against these words.',
    2,
  ),
  field(
    'actorsSplit',
    PREP_LABELS.actorsSplit,
    'Main actor versus sub-actor. Whoever you name here has to show up in the substantives.',
    2,
  ),
  field(
    'scratch',
    PREP_LABELS.scratch,
    'Anything with nowhere to go yet. Better here than lost.',
    4,
  ),
]

/** The 5W1H sub-prompts, in the order the filled example writes them. */
export const FIVE_W1H_FIELDS: readonly FieldSpec<keyof FiveW1H>[] = [
  field(
    'who',
    FIVE_W1H_LABELS.who,
    'Name the group precisely — "gig drivers in tier-2 cities", not "workers".',
    2,
  ),
  field('what', FIVE_W1H_LABELS.what, 'The harm as it happens now, not as it is described.', 2),
  field(
    'where',
    FIVE_W1H_LABELS.where,
    'Jurisdiction and context. A motion true in one country is often false in another.',
    2,
  ),
  field(
    'when',
    FIVE_W1H_LABELS.when,
    'Happening now, or projected? Judges weigh those very differently.',
    2,
  ),
  field('why', FIVE_W1H_LABELS.why, 'The cause. Whatever you write here becomes your mechanism.', 2),
  field('how', FIVE_W1H_LABELS.how, 'The route by which the harm actually reaches those people.', 2),
]

// ---------------------------------------------------------------------------
// Case set-up
// ---------------------------------------------------------------------------

/** CASE SET-UP text fields. `caseDivision` has its own array. */
export const SETUP_FIELDS: readonly FieldSpec<Exclude<keyof SetupBlock, 'caseDivision'>>[] = [
  field(
    'characterisation',
    SETUP_LABELS.characterisation,
    'The world as it actually is. Win this and half the clashes follow.',
  ),
  field(
    'burdens',
    SETUP_LABELS.burdens,
    'What you must prove to win. State it before opposition states it for you.',
  ),
  field('policy', SETUP_LABELS.policy, 'One line. The mechanism itself goes in the POLICY table.', 2),
  field('stance', SETUP_LABELS.stance, 'Your side in a sentence. Every speaker says this one.', 2),
  field(
    'oppositionRebuttals',
    SETUP_LABELS.oppositionRebuttals,
    'Opposition’s first speaker rebuts before running their own case — draft it here.',
    4,
  ),
]

/** Case Division rows. Titles only; each substantive gets its own table. */
export const CASE_DIVISION_FIELDS: readonly FieldSpec<keyof CaseDivision>[] = [
  field('speaker1', CASE_DIVISION_LABELS.speaker1, 'Definition, policy, first two substantives.', 1),
  field('speaker2', CASE_DIVISION_LABELS.speaker2, 'Rebuttal first, then the third substantive.', 1),
  field('speaker3', CASE_DIVISION_LABELS.speaker3, 'No new material — clashes only.', 1),
  field('sub1', CASE_DIVISION_LABELS.sub1, 'Title only.', 1),
  field('sub2', CASE_DIVISION_LABELS.sub2, 'Title only. If it restates Sub 1, you have one sub.', 1),
  field('sub3', CASE_DIVISION_LABELS.sub3, 'Title only.', 1),
]

// ---------------------------------------------------------------------------
// Definition and policy
// ---------------------------------------------------------------------------

/** DEFINITION rows, in template order. */
export const DEFINITION_FIELDS: readonly FieldSpec<keyof DefinitionBlock>[] = [
  field(
    'meaning',
    DEFINITION_LABELS.meaning,
    'The contested word only, in terms the other side could not refuse.',
  ),
  field(
    'whyImportant',
    DEFINITION_LABELS.whyImportant,
    'Say what changes in the round if the definition goes the other way.',
  ),
  field(
    'effectOnCommunity',
    DEFINITION_LABELS.effectOnCommunity,
    'Ground it in who it already affects, not in the abstract.',
  ),
  field('example', DEFINITION_LABELS.example, 'One real, checkable case. A hypothetical is not one.'),
]

/** POLICY rows, in template order. */
export const POLICY_FIELDS: readonly FieldSpec<keyof PolicyBlock>[] = [
  field('problem', POLICY_LABELS.problem, 'The status quo harm the policy exists to fix.'),
  field(
    'whyProblemExists',
    POLICY_LABELS.whyProblemExists,
    'The cause, not the symptom. Whatever you name here is what the mechanism must attack.',
  ),
  field(
    'howWeSolve',
    POLICY_LABELS.howWeSolve,
    'Actor, action, funding, enforcement. A policy nobody implements is not a policy.',
    4,
  ),
  field('whatOppCanSay', POLICY_LABELS.whatOppCanSay, 'Their strongest objection, in their words.'),
  field(
    'whyOppDoesNotMatter',
    POLICY_LABELS.whyOppDoesNotMatter,
    'Answer it on their terms. Restating your policy is not an answer.',
  ),
]

// ---------------------------------------------------------------------------
// Substantive — the depth scaffold
// ---------------------------------------------------------------------------

/**
 * SUBSTANTIVE STRUCTURE rows, in template order.
 *
 * The order is the argument itself: problem → impact → cause → solution → causal link →
 * counterfactual → example → link-back. Phase 3's depth rules map onto these keys directly.
 */
export const SUBSTANTIVE_FIELDS: readonly FieldSpec<SubstantiveFieldKey>[] = [
  field(
    'oneSentence',
    SUBSTANTIVE_LABELS.oneSentence,
    'One line a judge could repeat back. If it needs two, this is two substantives.',
    2,
  ),
  field(
    'problem',
    SUBSTANTIVE_LABELS.problem,
    'Who is harmed and how. A named group beats "society" every time.',
  ),
  field(
    'whyBad',
    SUBSTANTIVE_LABELS.whyBad,
    'The impact: how much, how likely, how reversible, how soon.',
    4,
  ),
  field(
    'whyExists',
    SUBSTANTIVE_LABELS.whyExists,
    'The mechanism. Keep asking "why" until the answer is structural.',
    4,
  ),
  field('howSolve', SUBSTANTIVE_LABELS.howSolve, 'The intervention, tied to the cause above.'),
  field(
    'howThisSolves',
    SUBSTANTIVE_LABELS.howThisSolves,
    'The causal chain, step by step. This is the row a judge actually weighs.',
    4,
  ),
  field(
    'counterfactual',
    SUBSTANTIVE_LABELS.counterfactual,
    'The world without you. Comparative, not descriptive.',
    4,
  ),
  field(
    'example',
    SUBSTANTIVE_LABELS.example,
    'One real case with a source you could name out loud.',
  ),
  field(
    'link',
    SUBSTANTIVE_LABELS.link,
    'Close back to the motion’s words, not to your own sub title.',
  ),
]

// ---------------------------------------------------------------------------
// Rebuttal tables
// ---------------------------------------------------------------------------

/** POLICY REBUTTAL rows, in template order. */
export const POLICY_REBUTTAL_FIELDS: readonly FieldSpec<keyof PolicyRebuttalBlock>[] = [
  field(
    'problem',
    POLICY_REBUTTAL_LABELS.problem,
    'The problem their policy claims to solve. State it fairly.',
  ),
  field(
    'whyProblemExists',
    POLICY_REBUTTAL_LABELS.whyProblemExists,
    'The cause they missed or misread.',
  ),
  field(
    'whyTheirSolutionFails',
    POLICY_REBUTTAL_LABELS.whyTheirSolutionFails,
    'Attack the mechanism, not the intention.',
    4,
  ),
  field(
    'howItWorsensProblem',
    POLICY_REBUTTAL_LABELS.howItWorsensProblem,
    'The harm their policy creates that the status quo does not.',
  ),
]

/** REBUTTAL rows, in template order. One table per opposing substantive. */
export const REBUTTAL_FIELDS: readonly FieldSpec<RebuttalFieldKey>[] = [
  field(
    'theirSubstantive',
    REBUTTAL_LABELS.theirSubstantive,
    'Their argument in their words, strongest version.',
  ),
  field(
    'whyWrong',
    REBUTTAL_LABELS.whyWrong,
    'One reason taken to its end. Three shallow reasons lose to one deep one.',
    4,
  ),
  field(
    'whyCharacterisationWrong',
    REBUTTAL_LABELS.whyCharacterisationWrong,
    'Attack the world they described, not the words they chose.',
  ),
  field('evenIfRight', REBUTTAL_LABELS.evenIfRight, 'Grant it entirely, then beat it anyway.', 4),
  field(
    'ourWorstCase',
    REBUTTAL_LABELS.ourWorstCase,
    'Concede honestly — the weighing only works if this is credible.',
  ),
  field('theirBestCase', REBUTTAL_LABELS.theirBestCase, 'Their best outcome, stated generously.'),
  field(
    'whyOurWorstBeatsTheirBest',
    REBUTTAL_LABELS.whyOurWorstBeatsTheirBest,
    'The comparative. This sentence wins close rounds.',
    4,
  ),
]

/** OPPOSING TEAM REBUTTALS rows, in template order. One table per exchange the whip audits. */
export const OPPOSING_REBUTTAL_FIELDS: readonly FieldSpec<OpposingRebuttalFieldKey>[] = [
  field(
    'whatTheySaidInFirst',
    OPPOSING_REBUTTAL_LABELS.whatTheySaidInFirst,
    'As they said it, with the speaker named.',
  ),
  field(
    'ourResponse',
    OPPOSING_REBUTTAL_LABELS.ourResponse,
    'What we actually said, not what we wish we had said.',
  ),
  field(
    'didTheyRespond',
    OPPOSING_REBUTTAL_LABELS.didTheyRespond,
    'If they dropped it, say so and say what the drop costs them.',
  ),
  field(
    'ourCounterResponse',
    OPPOSING_REBUTTAL_LABELS.ourCounterResponse,
    'Our answer to their answer.',
  ),
  field(
    'whyOursIsBetter',
    OPPOSING_REBUTTAL_LABELS.whyOursIsBetter,
    'Compare the two responses directly.',
    4,
  ),
  field(
    'anotherReasonWeWon',
    OPPOSING_REBUTTAL_LABELS.anotherReasonWeWon,
    'A second, independent reason. Restating the first is not one.',
  ),
]

// ---------------------------------------------------------------------------
// Extension — BP closing half
// ---------------------------------------------------------------------------

/** Extension rows. Authored, not from the template. */
export const EXTENSION_FIELDS: readonly FieldSpec<keyof ExtensionBlock>[] = [
  field(
    'statement',
    EXTENSION_LABELS.statement,
    'One sentence. If the opening half could have said it, it is not an extension.',
    2,
  ),
  field(
    'whyNew',
    EXTENSION_LABELS.whyNew,
    'Name what the opening half left on the table.',
  ),
  field(
    'whyItMatters',
    EXTENSION_LABELS.whyItMatters,
    'New but irrelevant still loses to a good opening half.',
  ),
]

// ---------------------------------------------------------------------------
// Speaker 3 script slots
// ---------------------------------------------------------------------------
//
// Labels below are the template's own sentences with the blank left in as `___`. Two reasons
// they are written out here instead of living in a `*_LABELS` record: the template writes
// them as prose rather than table rows, and phase 4's compiler consumes the same skeletons,
// so the wording is a shared contract rather than a UI string. `fields.test.ts` splits each
// label on `___` and asserts every fragment still appears in the docx.

/** Label for the clash's own title, filled into the template's "One ___ and Two ___" line. */
export const CLASH_TITLE_FIELD: FieldSpec<'title'> = field(
  'title',
  'One ___ and Two ___',
  'Name the clash as the debate actually split, not as your case did.',
  2,
)

/** Label for one slot of "Under my first clash, I will be dealing with ___ argument on ___". */
export const HANDLED_ARGUMENT_FIELD: FieldSpec<'topic'> = field(
  'topic',
  'argument on ___',
  'The argument as the house heard it, in three or four words.',
  1,
)

/** Slots for an engagement that takes down an argument the other side ran. */
export const THEIR_ARGUMENT_FIELDS: readonly FieldSpec<
  Exclude<keyof TheirArgumentEngagement, 'id' | 'kind' | 'response'>
>[] = [
  field(
    'theirSpeakerPosition',
    'In ___ (speaker position)',
    'Which of their speeches it came from — first, second, third.',
    1,
  ),
  field('whatTheyTold', 'Prop told us ___', 'Their argument at its strongest. A caricature loses.'),
  field(
    'ourSpeakerPosition',
    'But my ___ (position) speaker',
    'Which of ours answered it. Credit them rather than re-running it.',
    1,
  ),
  field(
    'whyNotTrue',
    'told you that this was not true because ___',
    'The reason our side already gave. New material here is a whip penalty.',
    4,
  ),
]

/** Slots for an engagement that defends an argument our side ran. */
export const OUR_ARGUMENT_FIELDS: readonly FieldSpec<
  Exclude<keyof OurArgumentEngagement, 'id' | 'kind' | 'response'>
>[] = [
  field(
    'ourSpeakerPosition',
    'What did we tell you? In ___ (speaker position)',
    'Which of our speeches.',
    1,
  ),
  field('whatWeTold', 'we told you that ___', 'Our argument compressed to its strongest line.'),
  field(
    'theirResponse',
    'Prop’s 2nd/ 3rd speaker responded by telling us ___',
    'Their answer as they gave it.',
  ),
  field(
    'whyWrong',
    'This is wrong because ___',
    'If your second speaker already answered this, say so rather than claiming it.',
    4,
  ),
]

/** Slots for the "They refused to respond" branch of the "(OR)" fork. */
export const REFUSED_BRANCH_FIELDS: readonly FieldSpec<keyof RefusedBranch>[] = [
  field(
    'whyBad',
    'They refused to respond. This is bad because ___',
    'Name what the silence concedes.',
    4,
  ),
  field(
    'alternativeScenario',
    'if Prop cannot prove an alternative scenario to ___',
    'The scenario they would have had to disprove.',
  ),
]

/** Slots for the branch where the other side did answer. The common case. */
export const RESPONDED_BRANCH_FIELDS: readonly FieldSpec<
  Exclude<keyof RespondedBranch, 'isExtension'>
>[] = [
  field('theirResponse', 'In response they told us ___', 'Their response, quoted not paraphrased.'),
  field(
    'whyWrong',
    'This argument is wrong because ___',
    'One reason, driven all the way down.',
    4,
  ),
  field(
    'concededCharacterisation',
    'Even if we accept their characterisation of ___',
    'The part of their world you are granting.',
  ),
  field(
    'whyStillFails',
    'This still does not work because ___',
    'Beat them on the ground you just conceded.',
    4,
  ),
  field(
    'furthermore',
    'Furthermore, their argument does not make sense because ___',
    'An independent reason. In BP closing this is where the extension lands.',
    4,
  ),
  field(
    'theirBestCase',
    'This is what happens in prop’s best case: ___',
    'Their best outcome, granted in full.',
  ),
  field('whyBestCaseBad', 'This is bad because ___', 'Why their best still hurts someone.'),
  field(
    'ourWorstCase',
    'In our worst case, this does not happen because ___',
    'The comparative that closes the engagement.',
    4,
  ),
]

/** Slots for the "IF THE ARGUMENTS OVERLAP, SAY THIS" variant. */
export const OVERLAP_FIELDS: readonly FieldSpec<
  Exclude<keyof OverlapEngagement, 'id' | 'kind'>
>[] = [
  field('theirArgumentTopic', 'Prop’s argument on ___', 'Their side of the overlap.', 1),
  field('ourArgumentTopic', 'overlap with our argument on ___', 'Our side of the same clash.', 1),
  field('whatPropTold', 'So prop told you ___', 'Their argument, stated fairly.'),
  field('ourRebuttal', 'We told you in our rebuttal ___', 'What we said against it at the time.'),
  field(
    'ourSubstantive',
    'We furthered this in our substantive by telling you ___',
    'The constructive material that went beyond the rebuttal.',
  ),
  // The overlap section is the one place the template types straight apostrophes rather than
  // curly ones. Normalising them here would fail the docx check, so they stay as written.
  field(
    'whyCharacterisationFails',
    "The reason why prop's characterisation does not work is because ___",
    'Attack the world, not the wording.',
    4,
  ),
  field('theirResponse', 'Prop tried to respond by telling you ___', 'Their answer, as given.'),
  field('whyInsufficient', 'That was insufficient because ___', 'What their answer left untouched.', 4),
  field(
    'evenIfCharacterisation',
    "Even if we use their characterisation, Prop's argument doesn't work because ___",
    'Grant their frame and win inside it.',
    4,
  ),
  field('furtherHurts', "Furthermore, Prop's argument further hurts ___", 'Who else pays.', 1),
  field('furtherHurtsWhy', 'because ___', 'The mechanism of that further harm.'),
  field('theirBestCase', 'Their best case scenario is ___', 'Stated generously.'),
  field('theirBestCaseWhy', 'because ___', 'Why that is the best they can hope for.'),
  field('whyStillBad', 'This is still bad because ___', 'The harm that survives their best case.', 4),
  field(
    'ourWorstCase',
    'Our worst case scenario does not have this situation because ___',
    'The comparative.',
    4,
  ),
  field('pointThatStands', 'Our point on ___ stands.', 'The clash title, restated as a win.', 1),
]

/**
 * Rewrites a script slot's label for the bench the case is argued from.
 *
 * The template is written from opposition's chair, so its script slots say "Prop" wherever
 * they mean "the other side". Rendered unchanged to a government speaker they read backwards.
 * The stored label stays verbatim — only the rendered copy swaps — so the fidelity test still
 * has something to compare against the docx.
 *
 * @param label - A slot label from this module. Table labels pass through untouched; none of
 *   them name a bench.
 * @param side - The bench *we* are on. `opp` returns the label unchanged, because opposition
 *   really is arguing against Prop.
 * @returns The label with bench names pointed at the actual opponent.
 */
export function withOpponentName(label: string, side: Side): string {
  if (side === 'opp') {
    return label
  }
  return label.replace(/Prop/g, 'Opp').replace(/prop/g, 'opp')
}
