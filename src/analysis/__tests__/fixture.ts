/**
 * The filled example, as a `Case`.
 *
 * Every string below is copied verbatim out of `reference/template-filled-example.docx` — a real
 * case a real debater wrote on social-media liability, not text invented to make rules fire. It
 * is the analyzer's regression fixture precisely because it is ordinary work: two substantives
 * that are one argument, actors named as "individuals in society", an impact argued on size and
 * permanence but never on likelihood, and three rows left blank.
 *
 * Ids are fixed rather than generated so a test can assert `substantives.sub-1.whyBad` and be
 * read a year later without running anything.
 *
 * Not a `.test.ts` file, so vitest's `include` does not pick it up as a suite.
 */

import type { Case } from '../../types/case.ts'
import {
  createOpposingRebuttalBlock,
  createPolicyRebuttalBlock,
  createRebuttalBlock,
  createSetupBlock,
  createSubstantive,
} from '../../types/createCase.ts'

/** The motion, as written on the prep sheet including its "(PROP)" annotation. */
export const FIXTURE_MOTION =
  'THW hold social media companies criminally liable for the spread of fake news using their platform (PROP)'

/**
 * Builds the filled example as an AP first-speaker case.
 *
 * @returns A fresh case each call, so a test that edits it cannot affect another test.
 */
export function buildFilledExampleCase(): Case {
  return {
    id: 'filled-example',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    format: 'AP',
    side: 'gov',
    position: 'ap-pm',
    visibility: 'private',

    prep: {
      motion: FIXTURE_MOTION,
      actorsSplit: 'Social media companies (main actor)\nIndividuals in society (sub - actor)',
      fiveW1H: {
        who: 'Social Media Companies\nIndividuals whom fake news targets',
        what:
          'Fake news\n' +
          'Damages lives: causes distress, ruins reputations, lead to issues with the law (defamation etc)\n' +
          'Currently social media companies review reports made and take down posts using their judgement',
        where: 'Online',
        // The prep sheet writes "When - NIL"; nothing was answered for when, why, or how.
        when: '',
        why: '',
        how: '',
      },
      needsMechanism: 'yes',
      scratch: '',
      pois: [],
    },

    // CASE SET-UP is printed in the example but left unanswered.
    setup: createSetupBlock(),

    definition: {
      meaning: 'Fake news',
      whyImportant: 'Fake news is news that is spread either knowingly or unknowingly by people',
      effectOnCommunity:
        'The spread of fake news has resulted in both legal and non-legal issues. It is in essence misinformation that leads to harm',
      example:
        'An example of this would be scams, which spread misinformation to gain access to their target’s money, bank accounts or even their personal information.',
    },

    policy: {
      problem:
        'The problem with social media companies is that they only take down posts that have been reported by other users.',
      whyProblemExists:
        'This problem exists as social media companies do not feel the need to take down posts, as it keeps traffic up and encourages more users to use their applications.',
      howWeSolve:
        'We can solve this problem by implementing a policy to have social media companies take proactive action using AI to identify posts that are likely misinformation, inform the user of such and have a dedicated team to review and take fake news posts down',
      whatOppCanSay:
        'This is not an invasion of user privacy as the posts that are posted will only be reviewed by a team to ensure that the fake news is not spread if it is detected by the AI and the user does not take down the post after being informed that their post may contain fake news',
      whyOppDoesNotMatter:
        'This policy would ensure that social media companies have a stake in ensuring misinformation is not spread on their platform, so that we can hold them criminally liable if they do not comply with the law',
    },

    substantives: [
      {
        id: 'sub-1',
        oneSentence: 'Fake news causes irreparable damage',
        problem:
          'Fake news can influence the minds of individuals of a spun up story that leads to many damages. Examples of such damage include reputational damage, monetary damage, and could even result in the loss of life',
        whyBad:
          'This is a problem as it uproots an individual or organizations life. The spread of fake news can cause reputational damage that is always irrecoverable. Once someone posts an article or post, the information is in the minds of the people who read it. It can bring down competitors, break down relationships and no amount of apologies or concessions will fix what was done as trust was broken.',
        whyExists:
          'Misinformation can even harm the lives of others. There are literal stories on the internet of how teenagers kill themselves over a post that is simply untrue',
        howSolve:
          'Making social media companies criminally liable will hang an axe over their heads, and finally get them to start taking the spread of rampant misinformation on their platforms seriously. Social media companies should implement web crawlers on their platforms to read through information posted publicly by accounts and have them verify information that is deemed to be fake. They would finally invest money into building algorithms that can read the message of a post and check a fake news rating. This rating should be available to users before they even make a post, so that they are aware that they might be committing an act of misinformation, if they post it. The social media platform should then have their team review the post and decide whether it is fake news and remove it immediately if it is.',
        howThisSolves:
          'This solves the problem as it gets social media companies to be proactive and reduces the spread of misinformation by warning users in advance that their posts may contain fake news that will be reviewed by a team.',
        counterfactual:
          'Without this solution, the world will still remain the same as it is, barely a fraction of posts will be taken down by the platforms when reported by people and it will all but cause damage that is irrecoverable.',
        example: '',
        link: '',
        preempts: [],
      },
      {
        id: 'sub-2',
        oneSentence: 'Allowing fake news to spread on a platform is supporting it',
        problem:
          'As mentioned in my first sub, fake news is misinformation. Allowing the spread is to be complicit, no matter what the reason is. There is a reason why the law judges someone based on adlerian psychology which is the study of goals people have and not freudian psychology which is the study of reasons for why people commit actions.',
        whyBad:
          'The goal of social media companies is clear, they want to generate more traffic. More traffic, means more people would frequent their platform, and this would entail more money for the company. If we do not hold social media giants accountable for this spread, we are in turn agreeing that fake news is an acceptable form of news for others. That is okay to manipulate the minds of other people.',
        whyExists:
          'This problem exists purely out of negligence and greed for profit, as having a team to survey the traffic and building algorithms is expensive. Cutting costs by not having this solution is basically saying “we don’t care about you, we only care about money”. Once again to reiterate, this harms lives. The government should therefore implement this law to hold them criminally liable for the spread of fake news.',
        howSolve:
          'Holding them criminally liable will force the hands of companies to come up with measures to solve the issues of the spread of fake news. People’s lives should not be an acceptable loss, money should be. By pushing for this law we stand with reducing the brunt of damage that fake news will cause and saving people',
        howThisSolves: '',
        counterfactual:
          'If we do not hold companies liable, we are just promoting the spread of fake news. We are no better than the perpetrators themselves who purposely do this with ulterior motives. We should not support this cause, and therefore we should hold the giants responsible to ensure we have a safe internet to surf for future generations to come.',
        example: '',
        link: '',
        preempts: [],
      },
      // The third substantive belongs to the second speaker and is blank in the example.
      { ...createSubstantive(), id: 'sub-3' },
    ],

    policyRebuttal: createPolicyRebuttalBlock(),
    rebuttals: [{ ...createRebuttalBlock(), id: 'rebuttal-1' }],
    opposingRebuttals: [{ ...createOpposingRebuttalBlock(), id: 'exchange-1' }],
    clashes: [],
    extension: null,
  }
}
