/**
 * Signposts for the speakers the template does not write a script for.
 *
 * The template only writes prose for Speaker 3. Speakers 1 and 2 get tables, so their script
 * has to be generated — and everything here is **authored**, not quoted. No fidelity test pins
 * it, for the same reason none pins `EXTENSION_LABELS`: there is nothing in the document to
 * pin it against.
 *
 * **Lead-in, not splice.** Almost every line here is a whole sentence followed by the field as
 * its own sentence — "Why does that matter? <whyBad>" — rather than the field spliced into the
 * middle of one. Splicing reads better when the field is a clause and collapses when it is not,
 * and nothing promises a clause: the registry's hints ask for reasoning, and a debater writes a
 * paragraph. A lead-in is occasionally terse; a splice is occasionally ungrammatical, and only
 * one of those can be fixed by the debater writing more.
 *
 * The two exceptions splice on purpose, because the field really is a fragment by construction:
 * a substantive's one-sentence summary, and a case division's sub titles.
 *
 * **Nothing here corrects the debater's text.** A field that starts lowercase after a lead-in's
 * question mark stays lowercase. The compiler arranges the words; it does not rewrite them.
 *
 * Signposts are deliberately side-neutral — "the other side", never "Opposition" — because
 * `withOpponentName` only knows how to swap the template's own "Prop", and a phrase that reads
 * backwards from one bench is the exact bug that function exists to prevent.
 */

import type { LineTemplate } from './lines.ts'
import { fixed, ORDINAL, slot } from './lines.ts'
import type { SegmentTemplate } from './skeleton.ts'

/**
 * CASE SET-UP, as the speech opens.
 *
 * `policy` and `oppositionRebuttals` are here rather than in their own segments because both
 * are one-liners in the template. Either being blank silently drops its line, which is what
 * makes this one array work for all six seats: only an opposition first speaker fills
 * "Rebuttals (if opp 1)", and only a proposition seat has a policy to announce.
 */
export const SETUP_LINES: SegmentTemplate = [
  [fixed('Our stance is this.'), slot('stance')],
  [fixed('Here is the world we are actually in.'), slot('characterisation')],
  [fixed('To win this debate, we have to show you the following.'), slot('burdens')],
  [fixed('Our policy is this.'), slot('policy')],
  [
    fixed('Before I get to our own case, let me answer what we have just heard.'),
    slot('oppositionRebuttals'),
  ],
]

/**
 * The case division, announced.
 *
 * Only the substantive titles are said out loud. "S1:", "S2:" and "S3:" are notes to the team
 * about who does what, and reading them to a judge would be reading the prep sheet aloud.
 */
export const CASE_DIVISION_LINES: SegmentTemplate = [
  [fixed('I will be taking'), slot('sub1'), fixed('and'), slot('sub2'), fixed('.')],
  [fixed('My deputy will take'), slot('sub3'), fixed('.')],
]

/** DEFINITION. */
export const DEFINITION_LINES: SegmentTemplate = [
  [fixed('Let me begin with the definition.'), slot('meaning')],
  [fixed('This matters to the debate for the following reason.'), slot('whyImportant')],
  [fixed('You can already see what it has done to the wider community.'), slot('effectOnCommunity')],
  [fixed('Take this example.'), slot('example')],
]

/** POLICY. */
export const POLICY_LINES: SegmentTemplate = [
  [fixed('Here is the problem our policy exists to fix.'), slot('problem')],
  [fixed('It exists for a reason.'), slot('whyProblemExists')],
  [fixed('So here is what we do.'), slot('howWeSolve')],
  [fixed('The other side will say this.'), slot('whatOppCanSay')],
  [fixed('That does not stand, and here is why.'), slot('whyOppDoesNotMatter')],
]

/**
 * SUBSTANTIVE STRUCTURE — the nine rows in the order the template asks them.
 *
 * That order is the argument: problem, impact, cause, solution, causal link, counterfactual,
 * example, link-back. The signposts are the joins a judge listens for, which is why several of
 * them are questions — a judge is going to ask them anyway.
 */
export const SUBSTANTIVE_LINES: SegmentTemplate = [
  [fixed('My'), ORDINAL, fixed('substantive is that'), slot('oneSentence'), fixed('.')],
  [fixed('What is the problem?'), slot('problem')],
  [fixed('Why does that matter?'), slot('whyBad')],
  [fixed('And why does it happen at all?'), slot('whyExists')],
  [fixed('Here is what we do about it.'), slot('howSolve')],
  [fixed('And here is how that solves it.'), slot('howThisSolves')],
  [fixed('Now take us out of the picture.'), slot('counterfactual')],
  [fixed('This is not hypothetical.'), slot('example')],
  [fixed('So let me close this substantive.'), slot('link')],
]

/** POLICY REBUTTAL. */
export const POLICY_REBUTTAL_LINES: SegmentTemplate = [
  [fixed('Let me turn to their policy. Here is the problem they say it solves.'), slot('problem')],
  [fixed('Here is why that problem actually exists.'), slot('whyProblemExists')],
  [fixed('And here is why their way of solving it fails.'), slot('whyTheirSolutionFails')],
  [fixed('Worse, it makes the problem bigger.'), slot('howItWorsensProblem')],
]

/** REBUTTAL — one per opposing substantive being answered. */
export const REBUTTAL_LINES: SegmentTemplate = [
  [
    fixed('My'),
    ORDINAL,
    fixed('piece of rebuttal is to their argument that'),
    slot('theirSubstantive'),
    fixed('.'),
  ],
  [fixed('That is wrong, and here is why.'), slot('whyWrong')],
  [fixed('Their characterisation is wrong too.'), slot('whyCharacterisationWrong')],
  [fixed('But grant them all of it, and they still lose.'), slot('evenIfRight')],
  [fixed('Here is our worst case.'), slot('ourWorstCase')],
  [fixed('And here is their best case.'), slot('theirBestCase')],
  [fixed('Our worst case still beats their best case.'), slot('whyOurWorstBeatsTheirBest')],
]

/** OPPOSING TEAM REBUTTALS — the whip auditing one exchange. */
export const OPPOSING_REBUTTAL_LINES: SegmentTemplate = [
  [fixed('Take the'), ORDINAL, fixed('exchange. They told you this.'), slot('whatTheySaidInFirst')],
  [fixed('We said this in response.'), slot('ourResponse')],
  [fixed('Did they answer it?'), slot('didTheyRespond')],
  [fixed('Our answer to that was this.'), slot('ourCounterResponse')],
  [fixed('Ours is the better response.'), slot('whyOursIsBetter')],
  [fixed('And there is a second, independent reason we win this.'), slot('anotherReasonWeWon')],
]

/** EXTENSION — BP closing half only. */
export const EXTENSION_LINES: SegmentTemplate = [
  [fixed('Here is my extension.'), slot('statement')],
  [fixed('This is new material, and here is why.'), slot('whyNew')],
  [fixed('And here is why it matters to this debate.'), slot('whyItMatters')],
]

/** Every authored template, for the test that renders all of them against a filled case. */
export const AUTHORED_TEMPLATES: readonly LineTemplate[] = [
  ...SETUP_LINES,
  ...CASE_DIVISION_LINES,
  ...DEFINITION_LINES,
  ...POLICY_LINES,
  ...SUBSTANTIVE_LINES,
  ...POLICY_REBUTTAL_LINES,
  ...REBUTTAL_LINES,
  ...OPPOSING_REBUTTAL_LINES,
  ...EXTENSION_LINES,
]
