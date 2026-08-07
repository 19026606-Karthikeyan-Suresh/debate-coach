/**
 * The five rules that read a whole substantive, or several at once.
 *
 * These are the rules a whip must never see, so each one is also checked against a seat with no
 * substantive block: a whip told their impact axes are thin has been told about a table they do
 * not fill.
 */

import { describe, expect, it } from 'vitest'

import { COMPARATIVE_WEIGHING_RULE } from '../rules/comparativeWeighing.ts'
import { IMPACT_AXES_RULE } from '../rules/impactAxes.ts'
import { LINK_BACK_RULE } from '../rules/linkBack.ts'
import { STAKEHOLDER_COVERAGE_RULE } from '../rules/stakeholderCoverage.ts'
import { OVERLAP_THRESHOLD, SUB_OVERLAP_RULE } from '../rules/subOverlap.ts'
import { contentWords, jaccard, withoutWords } from '../text.ts'
import type { Case } from '../../types/case.ts'
import { buildFilledExampleCase, FIXTURE_MOTION } from './fixture.ts'
import {
  analyse,
  caseWithSubstantive,
  caseWithSubstantives,
  contextFor,
  WHIP,
  withField,
} from './harness.ts'
import type { SubstantiveRows } from './harness.ts'

/**
 * A substantive on ground genuinely separate from the reference case's two, written on the same
 * motion by the same hand. It is the control for `subOverlap` and it must never be flagged.
 */
const CHILLING_EFFECT_SUBSTANTIVE = {
  oneSentence: 'Criminal liability makes platforms over-remove lawful speech',
  problem:
    'A platform facing prison for a missed post will delete anything a court might later call ' +
    'misleading. Journalists reporting on an unfolding election, doctors correcting an official ' +
    'statement, and satirists all get caught in the same filter.',
  whyBad:
    'Over-removal silences the voices least able to appeal it. A newsroom has lawyers; a nurse ' +
    'posting a correction at midnight does not. Within one election cycle the accounts that ' +
    'survive are the ones that never said anything contestable.',
  whyExists:
    'The incentive is asymmetric. A platform that leaves one bad post up faces a prosecution; ' +
    'a platform that removes ten good ones faces a complaint form.',
  howSolve:
    'Liability should attach to a failure to act on a notified post within a fixed window, ' +
    'rather than to the existence of the post.',
  howThisSolves:
    'Tying the penalty to a notice window means a platform is judged on what it did after being ' +
    'told, which removes the reason to pre-emptively delete anything contestable.',
  counterfactual:
    'Without the notice window, the cheapest compliance strategy is deletion, and the speech ' +
    'that disappears first is the speech nobody is paid to defend.',
}

describe('impactAxes', () => {
  const oneAxisOnly = {
    whyBad:
      'Millions of readers see the original post and only a handful ever see the correction, ' +
      'so the false version is the one that sticks in the public record for good.',
  }

  it('names the axes a substantive never argues', () => {
    const findings = analyse(IMPACT_AXES_RULE, caseWithSubstantive(oneAxisOnly))
    expect(findings.map((finding) => finding.message)).toEqual([
      'Sub 1 never argues probability.',
      'Sub 1 never argues timeframe.',
    ])
  })

  it('says nothing when all four axes are argued', () => {
    expect(
      analyse(
        IMPACT_AXES_RULE,
        caseWithSubstantive({
          whyBad:
            'Millions of readers see the post and a handful see the correction. This is not a ' +
            'rare failure; it is the likely outcome of any ranked queue. Reputational damage of ' +
            'this kind is irrecoverable, and it lands within days of the post going up.',
        }),
      ),
    ).toEqual([])
  })

  it('holds off while the row is still being typed', () => {
    // Four findings against a half-written sentence teaches the debater to close the panel.
    expect(analyse(IMPACT_AXES_RULE, caseWithSubstantive({ whyBad: 'It hurts people.' }))).toEqual([])
  })

  it('reads the neighbouring impact rows, not just "why is it so bad"', () => {
    const findings = analyse(
      IMPACT_AXES_RULE,
      caseWithSubstantive({
        ...oneAxisOnly,
        counterfactual:
          'Without the policy this is the likely outcome within a year, on every platform ' +
          'that ranks its moderation queue by report volume rather than by reach.',
      }),
    )
    expect(findings).toEqual([])
  })

  it('anchors on the impact row so the finding lands where the answer belongs', () => {
    const findings = analyse(IMPACT_AXES_RULE, caseWithSubstantive(oneAxisOnly))
    expect(findings[0]?.fieldPath).toBe('substantives.sub-1.whyBad')
  })

  it('stays silent for a seat with no substantives', () => {
    expect(analyse(IMPACT_AXES_RULE, buildFilledExampleCase(), WHIP)).toEqual([])
  })
})

describe('comparativeWeighing', () => {
  it('flags a substantive that only ever describes one world', () => {
    const findings = analyse(
      COMPARATIVE_WEIGHING_RULE,
      caseWithSubstantive({
        whyBad:
          'Readers see the original post and the correction never reaches them. Trust in the ' +
          'reporting collapses, and the account that posted it keeps its audience intact ' +
          'while the newsroom it targeted spends a fortnight answering for something it ' +
          'never printed.',
        whyExists:
          'Ranked queues surface whatever is already travelling, and a correction never travels.',
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('warn')
  })

  it('accepts weighing written anywhere in the substantive', () => {
    expect(
      analyse(COMPARATIVE_WEIGHING_RULE, caseWithSubstantive(CHILLING_EFFECT_SUBSTANTIVE)),
    ).toEqual([])
  })

  it('holds off on a substantive that is barely started', () => {
    expect(
      analyse(COMPARATIVE_WEIGHING_RULE, caseWithSubstantive({ whyBad: 'Trust collapses.' })),
    ).toEqual([])
  })
})

describe('stakeholderCoverage', () => {
  const withActors = (rows: SubstantiveRows): Case =>
    withField(
      caseWithSubstantive(rows, 'THW ban ranked moderation queues'),
      'prep.actorsSplit',
      'Platform moderation staff (main actor)\nElection journalists (sub - actor)',
    )

  it('flags a substantive that never mentions an actor named in prep', () => {
    const findings = analyse(
      STAKEHOLDER_COVERAGE_RULE,
      withActors({ whyBad: 'Ranked queues surface whatever is already travelling.' }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('Election journalists')
  })

  it('accepts a substantive that mentions any distinctive word of the actor', () => {
    // "Election journalists" is covered by "journalists". Requiring the whole phrase would flag
    // every substantive that named the group in slightly different words.
    expect(
      analyse(
        STAKEHOLDER_COVERAGE_RULE,
        withActors({
          whyBad: 'Moderation staff clear the queue by volume, and journalists lose the appeal.',
        }),
      ),
    ).toEqual([])
  })

  it('ignores an actor whose whole name is inside the motion', () => {
    // On a motion about social media companies, every substantive is about social media
    // companies. That is the motion's subject, not a stakeholder the case might drop.
    const findings = analyse(
      STAKEHOLDER_COVERAGE_RULE,
      withField(
        caseWithSubstantive(
          { whyBad: 'Ranked queues surface whatever is already travelling in the feed.' },
          'THW ban ranked moderation queues',
        ),
        'prep.actorsSplit',
        'Moderation queues (main actor)',
      ),
    )
    expect(findings).toEqual([])
  })

  it('says nothing when no actors were named', () => {
    expect(
      analyse(STAKEHOLDER_COVERAGE_RULE, caseWithSubstantive({ whyBad: 'Trust collapses.' })),
    ).toEqual([])
  })
})

describe('subOverlap', () => {
  const filledExample = buildFilledExampleCase()

  /** Jaccard between two substantives of a case, motion vocabulary already subtracted. */
  function similarity(caseFile: Case, left: number, right: number): number {
    const context = contextFor(caseFile)
    const words = context.substantives.map((substantive) =>
      withoutWords(contentWords(substantive.text), context.motionWords),
    )
    return jaccard(words[left] ?? new Set(), words[right] ?? new Set())
  }

  it('separates a real restatement from separate ground by a clear margin', () => {
    // The two numbers the threshold sits between. If a lexicon or stemming change collapses
    // this gap, it fails here rather than silently degrading the rule.
    const restated = similarity(filledExample, 0, 1)
    const separate = similarity(
      caseWithSubstantives(
        [filledExample.substantives[0] ?? {}, CHILLING_EFFECT_SUBSTANTIVE],
        FIXTURE_MOTION,
      ),
      0,
      1,
    )

    expect(restated).toBeGreaterThan(OVERLAP_THRESHOLD)
    expect(separate).toBeLessThan(OVERLAP_THRESHOLD)
    expect(restated / separate).toBeGreaterThan(2)
  })

  it('flags the later of two substantives that are one argument', () => {
    const findings = analyse(SUB_OVERLAP_RULE, filledExample)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.fieldPath).toBe('substantives.sub-2.oneSentence')
    expect(findings[0]?.message).toContain('Sub 2')
    expect(findings[0]?.message).toContain('Sub 1')
  })

  it('says nothing about two substantives on separate ground', () => {
    expect(
      analyse(
        SUB_OVERLAP_RULE,
        caseWithSubstantives(
          [filledExample.substantives[0] ?? {}, CHILLING_EFFECT_SUBSTANTIVE],
          FIXTURE_MOTION,
        ),
      ),
    ).toEqual([])
  })

  it('says nothing about two barely-started substantives', () => {
    // Sharing four words out of six is not evidence of anything.
    expect(
      analyse(
        SUB_OVERLAP_RULE,
        caseWithSubstantives([{ whyBad: 'Trust collapses' }, { whyBad: 'Trust collapses' }]),
      ),
    ).toEqual([])
  })
})

describe('linkBack', () => {
  const motion = 'THW hold social media companies criminally liable for the spread of fake news'

  it('flags a close-up that never touches the motion', () => {
    const findings = analyse(
      LINK_BACK_RULE,
      caseWithSubstantive({ link: 'And that is why our side wins this clash.' }, motion),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.fieldPath).toBe('substantives.sub-1.link')
  })

  it('accepts a close-up that lands on the motion’s words', () => {
    expect(
      analyse(
        LINK_BACK_RULE,
        caseWithSubstantive(
          { link: 'That is why social media companies must be held criminally liable.' },
          motion,
        ),
      ),
    ).toEqual([])
  })

  it('stays silent before a motion has been typed', () => {
    expect(analyse(LINK_BACK_RULE, caseWithSubstantive({ link: 'We win this clash.' }))).toEqual([])
  })

  it('leaves an unwritten close-up to the completeness meter', () => {
    expect(analyse(LINK_BACK_RULE, caseWithSubstantive({ link: '' }, motion))).toEqual([])
  })
})
