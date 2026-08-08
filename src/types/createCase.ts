/**
 * Factories for empty template blocks.
 *
 * Every field starts as `''` rather than undefined so the analyzer, the completeness meter,
 * and the Yjs projection never have to distinguish "not filled" from "not present" — an
 * absent key would read as 0% complete on a block the format never asked for.
 */

import type { FormatId, Side } from '../formats/index.ts'
import { getFormat } from '../formats/index.ts'
import type {
  Case,
  Clash,
  ClashEngagement,
  DefinitionBlock,
  EngagementResponse,
  ExtensionBlock,
  HandledArgument,
  OpposingRebuttalBlock,
  OurArgumentEngagement,
  OverlapEngagement,
  PolicyBlock,
  PointOfInformation,
  PolicyRebuttalBlock,
  PrepBlock,
  Preempt,
  RebuttalBlock,
  SetupBlock,
  Substantive,
  TheirArgumentEngagement,
} from './case.ts'

/**
 * Generates a stable id for a case or a repeatable block.
 *
 * Uses `crypto.randomUUID`, which WebView2 and Node 24 both provide. Ids are never derived
 * from content — two identically worded substantives must stay separately addressable.
 *
 * @returns A fresh UUID v4.
 */
export function newId(): string {
  return crypto.randomUUID()
}

/** Builds an empty prep sheet. */
export function createPrepBlock(): PrepBlock {
  return {
    motion: '',
    actorsSplit: '',
    fiveW1H: { who: '', what: '', where: '', when: '', why: '', how: '' },
    needsMechanism: 'undecided',
    scratch: '',
    pois: [],
  }
}

/** Builds an empty CASE SET-UP block. */
export function createSetupBlock(): SetupBlock {
  return {
    characterisation: '',
    burdens: '',
    policy: '',
    stance: '',
    oppositionRebuttals: '',
    caseDivision: { speaker1: '', speaker2: '', speaker3: '', sub1: '', sub2: '', sub3: '' },
  }
}

/** Builds an empty DEFINITION block. */
export function createDefinitionBlock(): DefinitionBlock {
  return { meaning: '', whyImportant: '', effectOnCommunity: '', example: '' }
}

/** Builds an empty POLICY block. */
export function createPolicyBlock(): PolicyBlock {
  return {
    problem: '',
    whyProblemExists: '',
    howWeSolve: '',
    whatOppCanSay: '',
    whyOppDoesNotMatter: '',
  }
}

/** Builds an empty substantive with a fresh id. */
export function createSubstantive(): Substantive {
  return {
    id: newId(),
    oneSentence: '',
    problem: '',
    whyBad: '',
    whyExists: '',
    howSolve: '',
    howThisSolves: '',
    counterfactual: '',
    example: '',
    link: '',
    preempts: [],
  }
}

/** Builds an unanswered point of information with a fresh id. */
export function createPointOfInformation(): PointOfInformation {
  return { id: newId(), text: '', response: '' }
}

/**
 * Builds an empty preempt with a fresh id.
 *
 * @param source - Who produced the attack. Defaults to `manual`; only phase 7's `attack` call
 *   passes `claude`, and the substantive's preempt list tags those so an attack the debater did
 *   not think of is not later mistaken for one they did.
 */
export function createPreempt(source: Preempt['source'] = 'manual'): Preempt {
  return { id: newId(), attack: '', response: '', source }
}

/** Builds an empty extension block. Only BP closing-half seats ever get one. */
export function createExtensionBlock(): ExtensionBlock {
  return { statement: '', whyNew: '', whyItMatters: '' }
}

/** Builds an empty POLICY REBUTTAL block. */
export function createPolicyRebuttalBlock(): PolicyRebuttalBlock {
  return { problem: '', whyProblemExists: '', whyTheirSolutionFails: '', howItWorsensProblem: '' }
}

/** Builds an empty REBUTTAL block with a fresh id. */
export function createRebuttalBlock(): RebuttalBlock {
  return {
    id: newId(),
    theirSubstantive: '',
    whyWrong: '',
    whyCharacterisationWrong: '',
    evenIfRight: '',
    ourWorstCase: '',
    theirBestCase: '',
    whyOurWorstBeatsTheirBest: '',
  }
}

/** Builds an empty OPPOSING TEAM REBUTTALS block with a fresh id. */
export function createOpposingRebuttalBlock(): OpposingRebuttalBlock {
  return {
    id: newId(),
    whatTheySaidInFirst: '',
    ourResponse: '',
    didTheyRespond: '',
    ourCounterResponse: '',
    whyOursIsBetter: '',
    anotherReasonWeWon: '',
  }
}

/**
 * Builds the "(OR)" fork with both branches empty.
 *
 * Defaults to `responded`, which is the common case — an opponent ignoring an argument
 * outright is the exception the whip gets to punish.
 */
export function createEngagementResponse(): EngagementResponse {
  return {
    branch: 'responded',
    refused: { whyBad: '', alternativeScenario: '' },
    responded: {
      theirResponse: '',
      whyWrong: '',
      concededCharacterisation: '',
      whyStillFails: '',
      furthermore: '',
      isExtension: false,
      theirBestCase: '',
      whyBestCaseBad: '',
      ourWorstCase: '',
    },
  }
}

/** Builds an empty engagement against an argument the other side ran. */
export function createTheirArgumentEngagement(): TheirArgumentEngagement {
  return {
    id: newId(),
    kind: 'their-argument',
    theirSpeakerPosition: '',
    whatTheyTold: '',
    ourSpeakerPosition: '',
    whyNotTrue: '',
    response: createEngagementResponse(),
  }
}

/** Builds an empty engagement defending an argument our side ran. */
export function createOurArgumentEngagement(): OurArgumentEngagement {
  return {
    id: newId(),
    kind: 'our-argument',
    ourSpeakerPosition: '',
    whatWeTold: '',
    theirResponse: '',
    whyWrong: '',
    response: createEngagementResponse(),
  }
}

/** Builds an empty overlap engagement — the "IF THE ARGUMENTS OVERLAP" variant. */
export function createOverlapEngagement(): OverlapEngagement {
  return {
    id: newId(),
    kind: 'overlap',
    theirArgumentTopic: '',
    ourArgumentTopic: '',
    whatPropTold: '',
    ourRebuttal: '',
    ourSubstantive: '',
    whyCharacterisationFails: '',
    theirResponse: '',
    whyInsufficient: '',
    evenIfCharacterisation: '',
    furtherHurts: '',
    furtherHurtsWhy: '',
    theirBestCase: '',
    theirBestCaseWhy: '',
    whyStillBad: '',
    ourWorstCase: '',
    pointThatStands: '',
  }
}

/**
 * Builds one slot of a clash's signposting line.
 *
 * @param side - Whose argument this slot handles. The template prints it as "( Prop/ Opp)",
 *   so passing our own side is legal — a whip does defend their own bench's arguments.
 */
export function createHandledArgument(side: Side): HandledArgument {
  return { id: newId(), side, topic: '' }
}

/**
 * Builds an empty clash.
 *
 * @param engagements - Engagements to seed. Defaults to empty; the case builder adds them as
 *   the whip decides what each clash actually covers.
 */
export function createClash(engagements: ClashEngagement[] = []): Clash {
  return { id: newId(), title: '', handledArguments: [], engagements }
}

/**
 * Builds a blank case for a given seat.
 *
 * Seeds two clashes because the template's script opens with "I have two clashes for the
 * house" — a whip who needs a third adds it, but nobody should have to create the first two.
 * The substantive count follows the template's own division: two for the first speaker and
 * one for the second.
 *
 * @param format - Format key. Drives nothing structural here beyond being stored; an unknown
 *   key throws via `getFormat` rather than producing a case no screen can render.
 * @param side - Bench this case is argued from.
 * @param position - Role id from the format registry. Pass `''` to leave the seat unassigned;
 *   an id from another format is stored as-is and the UI prompts for reassignment.
 * @returns A case with every field present and empty.
 */
export function createEmptyCase(format: FormatId, side: Side, position: string): Case {
  getFormat(format)
  const now = new Date().toISOString()

  return {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    format,
    side,
    position,
    visibility: 'private',
    prep: createPrepBlock(),
    setup: createSetupBlock(),
    definition: createDefinitionBlock(),
    policy: createPolicyBlock(),
    substantives: [createSubstantive(), createSubstantive(), createSubstantive()],
    policyRebuttal: createPolicyRebuttalBlock(),
    rebuttals: [],
    opposingRebuttals: [],
    clashes: [createClash(), createClash()],
    extension: null,
  }
}

/**
 * Fills in blocks a stored case is missing.
 *
 * A case is persisted as one JSON blob, so a document written before a block existed parses
 * into a `Case` with that key absent — and `strict` TypeScript will not have caught it,
 * because the parse is a cast. This runs on every load and on every `.dbcase` import.
 *
 * Only absent keys are replaced. A field the user deliberately emptied stays empty, and
 * `policy`/`extension` stay null when they are explicitly null rather than missing.
 *
 * @param stored - Parsed JSON from the `doc` column or an import. Anything that is not an
 *   object throws, because a corrupt row should surface rather than open as a blank case.
 * @returns A case with every block present.
 * @throws If `stored` is null or not an object.
 */
export function hydrateCase(stored: unknown): Case {
  if (typeof stored !== 'object' || stored === null) {
    throw new Error('Stored case is not an object')
  }
  const partial = stored as Partial<Case>
  const now = new Date().toISOString()
  // Spread only merges one level, so the two nested groups are rebuilt explicitly — a stored
  // `fiveW1H` missing `where` would otherwise land as undefined and read as a crash, not a gap.
  const prep = { ...createPrepBlock(), ...partial.prep }
  const setup = { ...createSetupBlock(), ...partial.setup }

  return {
    id: partial.id ?? newId(),
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    format: partial.format ?? 'AP',
    side: partial.side ?? 'gov',
    position: partial.position ?? '',
    visibility: partial.visibility ?? 'private',
    prep: { ...prep, fiveW1H: { ...createPrepBlock().fiveW1H, ...prep.fiveW1H } },
    setup: { ...setup, caseDivision: { ...createSetupBlock().caseDivision, ...setup.caseDivision } },
    definition: { ...createDefinitionBlock(), ...partial.definition },
    // `null` is a real answer here ("no mechanism"), so only `undefined` gets a fresh block.
    policy: partial.policy === undefined ? createPolicyBlock() : partial.policy,
    substantives: partial.substantives ?? [],
    policyRebuttal: { ...createPolicyRebuttalBlock(), ...partial.policyRebuttal },
    rebuttals: partial.rebuttals ?? [],
    opposingRebuttals: partial.opposingRebuttals ?? [],
    clashes: partial.clashes ?? [],
    extension: partial.extension ?? null,
  }
}
