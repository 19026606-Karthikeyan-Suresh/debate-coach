/**
 * Case data model — a 1:1 mirror of `reference/template-blank.docx`.
 *
 * Every block below corresponds to one heading or table in that file, and every field to
 * one row. The `*_LABELS` records hold the template's question text **verbatim**, including
 * its typos and spacing ("Link ( close up the sub)"), because the UI renders those strings
 * directly and `src/types/__tests__/template-fidelity.test.ts` diffs them against the docx.
 * Fix a label here and the test fails — change the template first, or not at all.
 *
 * Field keys are stable ids: analyzer findings, teleprompter positions, and CRDT updates all
 * address fields by `blockId.fieldKey`, so renaming a key orphans saved findings.
 */

import type { FormatId, Side } from '../formats/index.ts'

/** Who may read a case. `private` keeps it on this install and out of team sync. */
export type Visibility = 'private' | 'team'

/**
 * The template's "Do I need a mechanism/policy? Yes/No" prompt.
 *
 * `undecided` is the initial state — distinct from `no`, because the completeness meter
 * nags about an unanswered question but not about a deliberate no.
 */
export type MechanismDecision = 'yes' | 'no' | 'undecided'

// ---------------------------------------------------------------------------
// Prep sheet — the loose paragraphs before CASE SET-UP
// ---------------------------------------------------------------------------

/**
 * The 5W1H breakdown.
 *
 * The blank template gives a bare "5W1H:" line; the filled example expands it into these six
 * prompts, and `stakeholderCoverage` in the analyzer needs `who` addressable on its own to
 * check that named actors actually appear in the substantives.
 */
export interface FiveW1H {
  /** "Who is affected?" */
  who: string
  /** "What happened, what is the problem" */
  what: string
  /** "Where" */
  where: string
  /** "When" */
  when: string
  /** "Why" */
  why: string
  /** "How" */
  how: string
}

/** Verbatim prompts for {@link FiveW1H}, as written in the filled example. */
export const FIVE_W1H_LABELS: Readonly<Record<keyof FiveW1H, string>> = {
  who: 'Who is affected?',
  what: 'What happened, what is the problem',
  where: 'Where',
  when: 'When',
  why: 'Why',
  how: 'How',
}

/** One entry in the template's "LIST OF POIS:". */
export interface PointOfInformation {
  readonly id: string
  /** The POI as it would be asked out loud. */
  text: string
  /** My prepared answer. Empty is normal during prep — the meter counts it as an open POI. */
  response: string
}

/**
 * The prep sheet — everything above CASE SET-UP in the template.
 */
export interface PrepBlock {
  /** "Motion:" */
  motion: string
  /** "Actors split:" — main actor vs sub-actor, free text as the template has it. */
  actorsSplit: string
  fiveW1H: FiveW1H
  /** "Do I need a mechanism/policy? Yes/No" */
  needsMechanism: MechanismDecision
  /** "List all your thoughts that don't fit into the categories here:" */
  scratch: string
  /** "LIST OF POIS:" */
  pois: PointOfInformation[]
}

/** Verbatim prompts for {@link PrepBlock}'s scalar fields. */
export const PREP_LABELS = {
  motion: 'Motion:',
  actorsSplit: 'Actors split:',
  fiveW1H: '5W1H:',
  needsMechanism: 'Do I need a mechanism/policy? Yes/No',
  scratch: 'List all your thoughts that don’t fit into the categories here:',
  pois: 'LIST OF POIS:',
} as const

// ---------------------------------------------------------------------------
// CASE SET-UP
// ---------------------------------------------------------------------------

/**
 * The template's "Case Division" sub-list: what each speaker does, then which substantive
 * sits where. Kept as free text because the template's lines are bare labels with a colon.
 */
export interface CaseDivision {
  /** "S1:" */
  speaker1: string
  /** "S2:" */
  speaker2: string
  /** "S3:" */
  speaker3: string
  /** "Sub 1:" — first speaker's first substantive. */
  sub1: string
  /** "Sub 2:" — first speaker's second substantive. */
  sub2: string
  /** "Sub 3:" — listed under the template's "2nd Speaker" sub-heading. */
  sub3: string
}

/** Verbatim labels for {@link CaseDivision}. */
export const CASE_DIVISION_LABELS: Readonly<Record<keyof CaseDivision, string>> = {
  speaker1: 'S1:',
  speaker2: 'S2:',
  speaker3: 'S3:',
  sub1: 'Sub 1:',
  sub2: 'Sub 2:',
  sub3: 'Sub 3:',
}

/**
 * CASE SET-UP.
 *
 * Note `oppositionRebuttals`: the template lists "Rebuttals (if opp 1)" between Stance and
 * Case Division — the first opposition speaker rebuts before running their own case, so this
 * is a distinct field from the REBUTTAL table further down.
 */
export interface SetupBlock {
  /** "characterisation" — lowercase in the template. */
  characterisation: string
  /** "Burdens" */
  burdens: string
  /** "Policy" */
  policy: string
  /** "Stance" */
  stance: string
  /** "Rebuttals (if opp 1)" */
  oppositionRebuttals: string
  caseDivision: CaseDivision
}

/** Verbatim labels for {@link SetupBlock}'s scalar fields. */
export const SETUP_LABELS = {
  characterisation: 'characterisation',
  burdens: 'Burdens',
  policy: 'Policy',
  stance: 'Stance',
  oppositionRebuttals: 'Rebuttals (if opp 1)',
  caseDivision: 'Case Division',
} as const

// ---------------------------------------------------------------------------
// DEFINITION — table 0, 4 rows
// ---------------------------------------------------------------------------

/** DEFINITION table. One per case; the first speaker fills it. */
export interface DefinitionBlock {
  meaning: string
  whyImportant: string
  effectOnCommunity: string
  example: string
}

/** Verbatim row labels for {@link DefinitionBlock}, in template order. */
export const DEFINITION_LABELS: Readonly<Record<keyof DefinitionBlock, string>> = {
  meaning: 'What does the phrase/ word mean?',
  whyImportant: 'Why is the phrase/ word important in the debate?',
  effectOnCommunity: 'How has the phrase/ word affected the wider community?',
  example: 'Example',
}

// ---------------------------------------------------------------------------
// POLICY — table 1, 5 rows
// ---------------------------------------------------------------------------

/** POLICY table. Null on a case that answered "no" to the mechanism question. */
export interface PolicyBlock {
  problem: string
  whyProblemExists: string
  howWeSolve: string
  whatOppCanSay: string
  whyOppDoesNotMatter: string
}

/** Verbatim row labels for {@link PolicyBlock}, in template order. */
export const POLICY_LABELS: Readonly<Record<keyof PolicyBlock, string>> = {
  problem: 'What is the Problem?',
  whyProblemExists: 'Why does the Problem Exist?',
  howWeSolve: 'How do we solve the problem?',
  whatOppCanSay: 'What can Opp say to our policy?',
  whyOppDoesNotMatter: 'Why does what Opp say no matter?',
}

// ---------------------------------------------------------------------------
// SUBSTANTIVE STRUCTURE — table 2, 9 rows
// ---------------------------------------------------------------------------

/**
 * An opposition attack on one substantive, plus my prepared answer.
 *
 * Not in the docx — this is the `attack` feature's output surface (phase 7). Kept on the
 * substantive so a preempt travels with the argument it defends.
 *
 * Deliberately outside `buildSections`, and therefore outside both the analyzer and the
 * completeness meter. Counting an unanswered Claude attack against completeness would mean
 * asking for help lowers your score, and firing an analyzer rule on an empty `response` would
 * break Layer A's own rule that no heuristic ever fires on an empty field. The coach panel
 * counts the unanswered ones instead.
 */
export interface Preempt {
  readonly id: string
  /** The attack, phrased as an opponent would say it. */
  attack: string
  /** My answer. Empty means the attack is unanswered; the coach panel counts those. */
  response: string
  /** Where the attack came from. Offline heuristics cannot generate these. */
  source: 'claude' | 'manual'
}

/**
 * One substantive — the template's 9-row SUBSTANTIVE STRUCTURE table.
 *
 * The row order is the argument-quality scaffold the depth rubric is built on:
 * problem → impact → underlying cause → solution → causal link → counterfactual → example → link-back.
 */
export interface Substantive {
  readonly id: string
  oneSentence: string
  problem: string
  whyBad: string
  whyExists: string
  howSolve: string
  howThisSolves: string
  counterfactual: string
  example: string
  link: string
  preempts: Preempt[]
}

/** Keys of {@link Substantive} that map to a docx row, in template order. */
export type SubstantiveFieldKey = Exclude<keyof Substantive, 'id' | 'preempts'>

/** Verbatim row labels for {@link Substantive}, in template order. */
export const SUBSTANTIVE_LABELS: Readonly<Record<SubstantiveFieldKey, string>> = {
  oneSentence: 'Summarise your sub in 1 sentence',
  problem: 'What is the problem?',
  whyBad: 'Why is the problem so bad?',
  whyExists: 'Why does the problem exist?/ What makes the problem so bad? (underlying cause)',
  howSolve: 'How do you want to solve the problem?',
  howThisSolves: 'How does this solve the problem?',
  counterfactual: 'What happens without your solution? How will the problem become worse?',
  example: 'Example',
  link: 'Link ( close up the sub)',
}

// ---------------------------------------------------------------------------
// POLICY REBUTTAL — table 3, 4 rows
// ---------------------------------------------------------------------------

/** POLICY REBUTTAL table. The filled example heads it "POLICY REBUTTAL (IF OPP)". */
export interface PolicyRebuttalBlock {
  problem: string
  whyProblemExists: string
  whyTheirSolutionFails: string
  howItWorsensProblem: string
}

/** Verbatim row labels for {@link PolicyRebuttalBlock}, in template order. */
export const POLICY_REBUTTAL_LABELS: Readonly<Record<keyof PolicyRebuttalBlock, string>> = {
  problem: 'What is the problem?',
  whyProblemExists: 'Why does the problem exist?',
  whyTheirSolutionFails: 'Why does Prop’s way of solving the problem suck?',
  howItWorsensProblem: 'How does it make the problem worse?',
}

// ---------------------------------------------------------------------------
// REBUTTAL — table 4, 7 rows
// ---------------------------------------------------------------------------

/** One REBUTTAL table — a second speaker's answer to one opposing substantive. */
export interface RebuttalBlock {
  readonly id: string
  theirSubstantive: string
  whyWrong: string
  whyCharacterisationWrong: string
  evenIfRight: string
  ourWorstCase: string
  theirBestCase: string
  whyOurWorstBeatsTheirBest: string
}

/** Keys of {@link RebuttalBlock} that map to a docx row. */
export type RebuttalFieldKey = Exclude<keyof RebuttalBlock, 'id'>

/** Verbatim row labels for {@link RebuttalBlock}, in template order. */
export const REBUTTAL_LABELS: Readonly<Record<RebuttalFieldKey, string>> = {
  theirSubstantive: 'What was the substantive which the other side ran?',
  whyWrong: 'Why was what they said wrong?',
  whyCharacterisationWrong: 'Why was their characterisation wrong?',
  evenIfRight:
    'Even if we assumed that their characterisation/ substantive was kinda right, why are they still wrong?',
  ourWorstCase: 'What is your worst case scenario?',
  theirBestCase: 'What is the other side’s best case scenario?',
  whyOurWorstBeatsTheirBest: 'Why is your worst case better than their best case?',
}

// ---------------------------------------------------------------------------
// OPPOSING TEAM REBUTTALS — table 5, 6 rows
// ---------------------------------------------------------------------------

/**
 * One OPPOSING TEAM REBUTTALS table — the whip auditing how an exchange actually went.
 *
 * Row 2 is truncated in the template ("Did they") and is left verbatim; it asks whether the
 * other side responded at all.
 */
export interface OpposingRebuttalBlock {
  readonly id: string
  whatTheySaidInFirst: string
  ourResponse: string
  didTheyRespond: string
  ourCounterResponse: string
  whyOursIsBetter: string
  anotherReasonWeWon: string
}

/** Keys of {@link OpposingRebuttalBlock} that map to a docx row. */
export type OpposingRebuttalFieldKey = Exclude<keyof OpposingRebuttalBlock, 'id'>

/** Verbatim row labels for {@link OpposingRebuttalBlock}, in template order. */
export const OPPOSING_REBUTTAL_LABELS: Readonly<Record<OpposingRebuttalFieldKey, string>> = {
  whatTheySaidInFirst: 'What did THEY say in 1st?',
  ourResponse: 'What did you say in response?',
  didTheyRespond: 'Did they (if no, tell me why they lost the debate)',
  ourCounterResponse: 'If yes, what was your response?',
  whyOursIsBetter: 'Why is your response better than their response?',
  anotherReasonWeWon: 'Give me another reason why you won',
}

// ---------------------------------------------------------------------------
// EXTENSION — BP closing half only. Not a docx block.
// ---------------------------------------------------------------------------

/**
 * What a BP closing-half team adds that the opening half did not run.
 *
 * The only block with no counterpart in the template — the docx is written for AP, where
 * nobody extends. It exists because the format registry gives CG/CO roles an `extension`
 * block id, so without it those seats have a section the editor cannot render. Labels here
 * are therefore ours, not the template's, and no fidelity test pins them.
 */
export interface ExtensionBlock {
  /** The extension in one sentence. */
  statement: string
  /** Why this is new material rather than the opening half restated. */
  whyNew: string
  /** Why it matters — new but irrelevant still loses to a good opening half. */
  whyItMatters: string
}

/** Labels for {@link ExtensionBlock}. Authored here; the template has no extension section. */
export const EXTENSION_LABELS: Readonly<Record<keyof ExtensionBlock, string>> = {
  statement: 'What is your extension?',
  whyNew: 'Why is this new material?',
  whyItMatters: 'Why does the extension matter to the debate?',
}

// ---------------------------------------------------------------------------
// THIRD SPEAKER — the fill-in-the-blank clash script
// ---------------------------------------------------------------------------

/**
 * Which branch of the template's "(OR)" fork an engagement takes.
 *
 * The script skeleton offers two mutually exclusive continuations after an argument is
 * introduced: the other side ignored it, or they answered it. The compiler emits one.
 */
export type OpponentResponseBranch = 'refused' | 'responded'

/**
 * The "They refused to respond" branch.
 *
 * Template: "They refused to respond. This is bad because ___ is something that happens all
 * the time and if Prop cannot prove an alternative scenario to ___, their argument fails."
 */
export interface RefusedBranch {
  whyBad: string
  alternativeScenario: string
}

/**
 * The "(OR)" branch, where the other side did answer.
 *
 * Covers four template paragraphs: the response and why it is wrong, the even-if concession,
 * the "Furthermore" line, and the best-case/worst-case weighing that closes every engagement.
 */
export interface RespondedBranch {
  /** "In response they told us ___" */
  theirResponse: string
  /** "This argument is wrong because ___" */
  whyWrong: string
  /** "Even if we accept their characterisation of ___" */
  concededCharacterisation: string
  /** "This still does not work because ___" */
  whyStillFails: string
  /** "Furthermore, their argument does not make sense because ___" */
  furthermore: string
  /**
   * True where this engagement carries the BP extension.
   *
   * The template writes the same paragraph two ways — "their argument does not make sense
   * because" and "their argument is tenuous, and this is my extension because" — so the
   * compiler picks the wording from this flag rather than from a separate field.
   */
  isExtension: boolean
  /** "This is what happens in prop's best case: ___" */
  theirBestCase: string
  /** "This is bad because ___" */
  whyBestCaseBad: string
  /** "In our worst case, this does not happen because ___" */
  ourWorstCase: string
}

/** Shared shape of the "(OR)" fork. Exactly one branch is rendered. */
export interface EngagementResponse {
  branch: OpponentResponseBranch
  refused: RefusedBranch
  responded: RespondedBranch
}

/**
 * An engagement where the whip takes down an argument the *other* side ran.
 *
 * Template: "In ___ (speaker position) Prop told us ___. But my ___ speaker told you that
 * this was not true because ___."
 */
export interface TheirArgumentEngagement {
  readonly id: string
  readonly kind: 'their-argument'
  /** "In ___ (speaker position)" — whose speech the argument came from. */
  theirSpeakerPosition: string
  /** "Prop told us ___" */
  whatTheyTold: string
  /** "But my ___ (position) speaker" — the template's first instance hardcodes "first". */
  ourSpeakerPosition: string
  /** "told you that this was not true because ___" */
  whyNotTrue: string
  response: EngagementResponse
}

/**
 * An engagement where the whip defends an argument *our* side ran.
 *
 * Template: "What did we tell you? In ___ (speaker position), we told you that ___." followed
 * by "Prop's 2nd/ 3rd speaker responded by telling us ___. This is wrong because ___."
 */
export interface OurArgumentEngagement {
  readonly id: string
  readonly kind: 'our-argument'
  /** "In ___ (speaker position), we told you that ___" */
  ourSpeakerPosition: string
  /** What we told the house. */
  whatWeTold: string
  /** "Prop's 2nd/ 3rd speaker responded by telling us ___" */
  theirResponse: string
  /**
   * "This is wrong because ___".
   * The template's parenthetical asks you to note here if your own second speaker already
   * answered it, so the whip does not claim credit for new material.
   */
  whyWrong: string
  response: EngagementResponse
}

/**
 * The "IF THE ARGUMENTS OVERLAP, SAY THIS" variant.
 *
 * Used instead of a their-argument/our-argument pair when both sides ran the same clash, so
 * the whip handles them together rather than twice.
 */
export interface OverlapEngagement {
  readonly id: string
  readonly kind: 'overlap'
  /** "Prop's argument on ___" */
  theirArgumentTopic: string
  /** "overlap with our argument on ___" */
  ourArgumentTopic: string
  /** "So prop told you ___" */
  whatPropTold: string
  /** "We told you in our rebuttal ___" */
  ourRebuttal: string
  /** "We furthered this in our substantive by telling you ___" */
  ourSubstantive: string
  /** "The reason why prop's characterisation does not work is because ___" */
  whyCharacterisationFails: string
  /** "Prop tried to respond by telling you ___" */
  theirResponse: string
  /** "That was insufficient because ___" */
  whyInsufficient: string
  /** "Even if we use their characterisation, Prop's argument doesn't work because ___" */
  evenIfCharacterisation: string
  /** "Furthermore, Prop's argument further hurts ___" */
  furtherHurts: string
  /** "because ___" */
  furtherHurtsWhy: string
  /** "Their best case scenario is ___" */
  theirBestCase: string
  /** "because ___" */
  theirBestCaseWhy: string
  /** "This is still bad because ___" */
  whyStillBad: string
  /** "Our worst case scenario does not have this situation because ___" */
  ourWorstCase: string
  /** "Our point on ___ stands." */
  pointThatStands: string
}

/** One handled argument inside a clash. The `kind` tag picks the script skeleton. */
export type ClashEngagement =
  | TheirArgumentEngagement
  | OurArgumentEngagement
  | OverlapEngagement

/**
 * One argument named in "Under my first clash, I will be dealing with ___ (Prop/ Opp)
 * argument on ___". The template gives three of these slots per clash.
 */
export interface HandledArgument {
  readonly id: string
  /** The "( Prop/ Opp)" slot. */
  side: Side
  /** "argument on ___" */
  topic: string
}

/**
 * One clash. The template's opening line commits to exactly two ("I have two clashes for
 * the house. One ___ and Two ___"), which is why `Case.clashes` defaults to a pair — but the
 * array is not fixed at two, because a whip who needs three should not be blocked by the app.
 */
export interface Clash {
  readonly id: string
  /** The clash title, filled into the "One ___ / Two ___" slot. */
  title: string
  /** The arguments announced in the clash's signposting line. */
  handledArguments: HandledArgument[]
  engagements: ClashEngagement[]
}

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

/**
 * A complete case file.
 *
 * Text fields are plain strings here; the Yjs document holds `Y.Text` for the same paths and
 * projects into this shape for the analyzer, export, and the `doc jsonb` column. Keep this
 * type free of Yjs imports so the analyzer and script compiler stay pure and testable.
 */
export interface Case {
  readonly id: string
  /** ISO 8601. Set once on creation and never rewritten, including by sync. */
  readonly createdAt: string
  /** ISO 8601. Last local edit — the sync queue compares this against the server row. */
  updatedAt: string
  format: FormatId
  side: Side
  /** Role id from the format registry. Invalid after a format switch until reassigned. */
  position: string
  visibility: Visibility

  prep: PrepBlock
  setup: SetupBlock
  definition: DefinitionBlock
  /** Null when the case answered "no" to the mechanism question. */
  policy: PolicyBlock | null
  substantives: Substantive[]
  policyRebuttal: PolicyRebuttalBlock
  /** One per opposing substantive being answered. */
  rebuttals: RebuttalBlock[]
  /** One per exchange the whip audits. */
  opposingRebuttals: OpposingRebuttalBlock[]
  clashes: Clash[]
  /** Null on AP and on BP opening-half seats, which have nothing to extend. */
  extension: ExtensionBlock | null
}
