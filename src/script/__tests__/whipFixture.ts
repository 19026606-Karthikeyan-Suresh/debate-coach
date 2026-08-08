/**
 * A filled whip case, for the half of the template that compiles into prose directly.
 *
 * Unlike `src/analysis/__tests__/fixture.ts`, which is a real case copied out of
 * `reference/template-filled-example.docx`, this one is **authored**. It has to be: the filled
 * example is a first speaker's sheet and its THIRD SPEAKER section is blank, so there is no real
 * whip material in the reference at all. What is not authored is the wording around the answers,
 * which is the template's own — that is the thing under test.
 *
 * Same motion as the analyzer fixture, so a reader moving between them stays in one debate.
 *
 * Ids are fixed rather than generated so a test can assert on a segment id and still be readable
 * a year later. Not a `.test.ts` file, so vitest's `include` does not pick it up as a suite.
 */

import type { Side } from '../../formats/index.ts'
import type { Case, Clash } from '../../types/case.ts'
import { FIXTURE_MOTION } from '../../analysis/__tests__/fixture.ts'
import {
  createEngagementResponse,
  createPolicyRebuttalBlock,
  createPrepBlock,
  createSetupBlock,
} from '../../types/createCase.ts'

/** The first clash: one signposted argument, one engagement, the "(OR)" fork on `responded`. */
function buildFirstClash(): Clash {
  return {
    id: 'clash-1',
    title: 'who actually carries the cost of a liability regime',
    handledArguments: [{ id: 'handled-1', side: 'gov', topic: 'chilling effects on lawful speech' }],
    engagements: [
      {
        id: 'engagement-1',
        kind: 'their-argument',
        theirSpeakerPosition: 'their second speech',
        whatTheyTold: 'platforms would delete lawful posts in bulk rather than risk prosecution',
        ourSpeakerPosition: 'second',
        whyNotTrue:
          'the standard we set is knowledge, not strict liability, so a platform that never knew a post was false is never on the hook for it',
        response: {
          ...createEngagementResponse(),
          branch: 'responded',
          responded: {
            theirResponse: 'that knowledge is impossible to prove at the scale platforms run at',
            whyWrong:
              'they already run the detection systems that would prove it, and they run them for copyright every day',
            concededCharacterisation: 'a platform that genuinely cannot tell true from false',
            whyStillFails:
              'that platform is the one our policy leaves alone, so their objection describes a case we do not prosecute',
            furthermore:
              'the cost they describe falls on the largest firms, who are the only ones with the volume to trigger it',
            isExtension: false,
            theirBestCase: 'a few lawful posts come down while the systems are tuned',
            whyBestCaseBad: 'the people who lose those posts are the ones with no other platform',
            ourWorstCase:
              'we prosecute nobody in year one and platforms still build the systems, because the threat is what moves them',
          },
        },
      },
    ],
  }
}

/** The second clash: introduced by name, no engagements yet — the half-prepped state. */
function buildSecondClash(): Clash {
  return {
    id: 'clash-2',
    title: 'whether criminal liability changes anything',
    handledArguments: [{ id: 'handled-2', side: 'opp', topic: 'the deterrence mechanism' }],
    engagements: [],
  }
}

/**
 * Builds a filled whip case.
 *
 * @param side - Bench the whip sits on. `opp` leaves the template's prose alone, since the
 *   document is written from opposition's chair; `gov` is what exercises the Prop/Opp swap.
 * @param position - Role id. Defaults to the BP opposition whip, which is the seat that has
 *   both a clash script and an extension.
 * @returns A fresh case each call, so a test that edits it cannot affect another test.
 */
export function buildWhipCase(side: Side = 'opp', position = 'bp-ow'): Case {
  return {
    id: 'whip-fixture',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    format: 'BP',
    side,
    position,
    visibility: 'private',

    prep: { ...createPrepBlock(), motion: FIXTURE_MOTION },
    setup: {
      ...createSetupBlock(),
      stance: 'We stand against making platforms criminally liable for what their users post.',
      characterisation:
        'Platforms are not publishers. They are infrastructure, and infrastructure is held to a duty of care, not to a duty of truth.',
      burdens: 'We have to show you that the harm survives the policy, and that the policy adds harms of its own.',
    },
    definition: { meaning: '', whyImportant: '', effectOnCommunity: '', example: '' },
    policy: null,
    substantives: [],
    policyRebuttal: createPolicyRebuttalBlock(),
    rebuttals: [],

    opposingRebuttals: [
      {
        id: 'exchange-1',
        whatTheySaidInFirst: 'that platforms already have the tools and simply choose not to use them',
        ourResponse: 'that the tools they mean are copyright filters, which match files rather than claims',
        didTheyRespond: 'no, they repeated the first speech instead',
        ourCounterResponse: '',
        whyOursIsBetter:
          'ours is the only side of this exchange that named the mechanism, and a dropped mechanism is a dropped argument',
        anotherReasonWeWon:
          'even taking their tools at face value, nothing in this debate showed a platform that could tell a false claim from a contested one',
      },
    ],

    clashes: [buildFirstClash(), buildSecondClash()],
    extension: {
      statement: 'The cost of this policy lands on the smallest platforms, not the largest.',
      whyNew: 'The opening half argued about accuracy and never once asked who can afford compliance.',
      whyItMatters: 'A policy that entrenches the incumbents makes the misinformation problem worse, not better.',
    },
  }
}
