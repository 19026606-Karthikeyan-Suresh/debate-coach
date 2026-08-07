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
  OpposingRebuttalBlock,
  OurArgumentEngagement,
  OverlapEngagement,
  PolicyBlock,
  PolicyRebuttalBlock,
  PrepBlock,
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
  }
}
