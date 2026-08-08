/**
 * What the compiler must produce, pinned against two real cases.
 *
 * The first is the analyzer's regression fixture — a genuine, half-filled first speaker's sheet
 * — because the interesting question is not "does a complete case compile" but "does an ordinary
 * one". The second is a whip, which is where the template stops being a questionnaire and starts
 * being prose.
 *
 * The invariants at the bottom are the ones phase 5 depends on: contiguous token indices,
 * offsets that slice back out of the segment, and no field text the debater did not type.
 */

import { describe, expect, it } from 'vitest'

import { buildFilledExampleCase } from '../../analysis/__tests__/fixture.ts'
import { buildSections, flattenFields } from '../../case/sections.ts'
import { setFieldByPath } from '../../case/update.ts'
import {
  addEngagement,
  ensureRequiredBlocks,
  setEngagementBranch,
  setEngagementIsExtension,
} from '../../case/update.ts'
import { FORMATS, getRole } from '../../formats/index.ts'
import type { FormatId, SpeakerRole } from '../../formats/index.ts'
import type { Case } from '../../types/case.ts'
import { createEmptyCase } from '../../types/createCase.ts'
import { compileScript } from '../compile.ts'
import type { CompiledScript } from '../types.ts'
import { buildWhipCase } from './whipFixture.ts'

/** Looks a role up and fails loudly, so a typo'd role id is not a silently empty script. */
function role(formatId: FormatId, roleId: string): SpeakerRole {
  const found = getRole(formatId, roleId)
  if (!found) {
    throw new Error(`No such role: ${formatId}/${roleId}`)
  }
  return found
}

/** The one segment with a given id, or a readable failure. */
function segment(script: CompiledScript, segmentId: string): string {
  const found = script.segments.find((item) => item.id === segmentId)
  if (!found) {
    throw new Error(`No segment ${segmentId}; have ${script.segments.map((item) => item.id).join(', ')}`)
  }
  return found.text
}

describe('a real half-filled first speaker compiles into a speech', () => {
  const caseFile = buildFilledExampleCase()
  const script = compileScript(caseFile, role('AP', 'ap-pm'))

  it('emits the blocks that have text and skips the ones that do not', () => {
    // CASE SET-UP and POLICY REBUTTAL are printed but unanswered in the example, and sub 3
    // belongs to the second speaker. None of them should produce an empty heading.
    expect(script.segments.map((item) => item.id)).toEqual([
      'definition#body',
      'policy#body',
      'substantives.sub-1#body',
      'substantives.sub-2#body',
    ])
  })

  it('signposts each substantive by its position', () => {
    expect(segment(script, 'substantives.sub-1#body')).toContain(
      'My first substantive is that Fake news causes irreparable damage.',
    )
    expect(segment(script, 'substantives.sub-2#body')).toContain('My second substantive is that')
  })

  it('never emits a signpost with nothing behind it', () => {
    // Sub 2's "How does this solve the problem?" is blank in the example, so its line is gone
    // rather than standing there as a lead-in to silence.
    expect(segment(script, 'substantives.sub-2#body')).not.toContain('And here is how that solves it')
    expect(segment(script, 'substantives.sub-1#body')).toContain('And here is how that solves it.')
  })

  it('names the rows that blocked a line', () => {
    const blocked = script.gaps.map((gap) => gap.fieldPath)
    expect(blocked).toContain('substantives.sub-2.howThisSolves')
    expect(blocked).toContain('substantives.sub-1.example')
    expect(blocked).toContain('substantives.sub-1.link')
    expect(blocked).toContain('substantives.sub-2.link')
  })

  it('reports each blocked row once, with the label the editor shows', () => {
    const paths = script.gaps.map((gap) => gap.fieldPath)
    expect(new Set(paths).size).toBe(paths.length)
    expect(script.gaps.find((gap) => gap.fieldPath === 'substantives.sub-1.link')?.label).toBe(
      'Link ( close up the sub)',
    )
  })

  it('estimates a length worth acting on', () => {
    expect(script.wordCount).toBeGreaterThan(900)
    expect(script.estimatedSeconds).toBe(Math.round((script.wordCount / 160) * 60))

    // The number that makes the estimate worth having: definition, policy and two substantives
    // already eat most of a seven-minute speech, and CASE SET-UP is still unwritten. A debater
    // who only sees a completeness meter finds that out on the day.
    expect(script.estimatedSeconds).toBeGreaterThan(FORMATS.AP.speechSeconds * 0.9)
    expect(script.estimatedSeconds).toBeLessThan(FORMATS.AP.speechSeconds)
  })
})

describe('a whip compiles the template’s own prose', () => {
  const script = compileScript(buildWhipCase(), role('BP', 'bp-ow'))

  it('opens with the clash count and names both clashes', () => {
    expect(segment(script, 'clashes.clash-1#opening')).toBe(
      'I have two clashes for the house.\n' +
        'One who actually carries the cost of a liability regime and Two whether criminal ' +
        'liability changes anything.',
    )
  })

  it('signposts the first clash and moves on to the second', () => {
    expect(segment(script, 'clashes.clash-1#signpost')).toBe(
      'Under my first clash, I will be dealing with Prop argument on chilling effects on lawful speech.',
    )
    expect(segment(script, 'clashes.clash-2#signpost')).toBe(
      'Moving on to my second clash on whether criminal liability changes anything.\n' +
        'I will be dealing with Opp argument on the deterrence mechanism.',
    )
  })

  it('fills the engagement skeleton straight through', () => {
    const engagement = segment(script, 'clashes.clash-1#engagement.engagement-1')
    expect(engagement.split('\n')[0]).toBe(
      'In their second speech Prop told us platforms would delete lawful posts in bulk rather ' +
        'than risk prosecution.',
    )
    expect(engagement).toContain(
      'But my second speaker told you that this was not true because the standard we set is ' +
        'knowledge, not strict liability,',
    )
    expect(engagement).toContain('In response they told us that knowledge is impossible to prove')
    expect(engagement).toContain('This is what happens in prop’s best case: a few lawful posts')
    expect(engagement).toContain('Therefore, prop’s argument fails.')
  })

  it('heads an engagement with its clash and its skeleton', () => {
    const found = script.segments.find(
      (item) => item.id === 'clashes.clash-1#engagement.engagement-1',
    )
    expect(found?.heading).toBe('Clash 1 — Their argument')
    expect(found?.sectionId).toBe('clashes.clash-1')
  })
})

describe('the bench the case is argued from', () => {
  const govScript = compileScript(buildWhipCase('gov', 'bp-gw'), role('BP', 'bp-gw'))
  const engagement = segment(govScript, 'clashes.clash-1#engagement.engagement-1')

  it('points the template’s "Prop" at the actual opponent', () => {
    expect(engagement).toContain('Opp told us platforms would delete lawful posts')
    expect(engagement).toContain('This is what happens in opp’s best case')
    expect(engagement).not.toContain('Prop told us')
  })

  it('leaves the signpost’s bench name alone, because that one is a real side', () => {
    // "( Prop/ Opp)" is whose argument it is. Swapping it would point a government whip at
    // their own bench.
    expect(segment(govScript, 'clashes.clash-1#signpost')).toContain('Prop argument on chilling')
  })
})

describe('the "(OR)" fork and the extension flag', () => {
  it('says the refused branch when that is the branch selected', () => {
    let caseFile = buildWhipCase()
    caseFile = setEngagementBranch(caseFile, 'clash-1', 'engagement-1', 'refused')
    caseFile = setFieldByPath(
      caseFile,
      'clashes.clash-1.engagements.engagement-1.refused.whyBad',
      'silence on the central mechanism',
    )
    caseFile = setFieldByPath(
      caseFile,
      'clashes.clash-1.engagements.engagement-1.refused.alternativeScenario',
      'a platform that knew and did nothing',
    )

    const script = compileScript(caseFile, role('BP', 'bp-ow'))
    const engagement = segment(script, 'clashes.clash-1#engagement.engagement-1')
    expect(engagement).toContain(
      'They refused to respond. This is bad because silence on the central mechanism is ' +
        'something that happens all the time and if Prop cannot prove an alternative scenario ' +
        'to a platform that knew and did nothing, their argument fails.',
    )
    expect(engagement).not.toContain('In response they told us')
  })

  it('swaps the "Furthermore" wording where the engagement carries the extension', () => {
    const caseFile = setEngagementIsExtension(buildWhipCase(), 'clash-1', 'engagement-1', true)
    const script = compileScript(caseFile, role('BP', 'bp-ow'))
    const engagement = segment(script, 'clashes.clash-1#engagement.engagement-1')
    expect(engagement).toContain('their argument is tenuous, and this is my extension because')
    expect(engagement).not.toContain('their argument does not make sense because')
  })
})

/**
 * Fills every field a seat is asked for.
 *
 * The value is the path itself, which makes a wrong-prefix bug visible in the compiled text
 * rather than only in a count.
 */
function fillEveryField(caseFile: Case, speaker: SpeakerRole): Case {
  let filled = caseFile
  for (const field of flattenFields(buildSections(caseFile, speaker))) {
    // The mechanism question is a tri-state, not a text box; anything else would drop POLICY.
    filled = setFieldByPath(filled, field.path, field.path === 'prep.needsMechanism' ? 'yes' : field.path)
  }
  return filled
}

describe('a completely filled case leaves nothing unsaid', () => {
  const seats = Object.values(FORMATS).flatMap((format) =>
    format.roles.map((speaker) => [`${format.id} ${speaker.shortLabel}`, format.id, speaker] as const),
  )

  it.each(seats)('%s', (_name, formatId, speaker) => {
    let caseFile = ensureRequiredBlocks(createEmptyCase(formatId, speaker.side, speaker.id), speaker)
    // Cover all three engagement skeletons, not just the one `ensureRequiredBlocks` seeds.
    if (speaker.blocks.includes('clashes')) {
      const clashId = caseFile.clashes[0]?.id ?? ''
      caseFile = addEngagement(caseFile, clashId, 'our-argument')
      caseFile = addEngagement(caseFile, clashId, 'overlap')
    }
    caseFile = fillEveryField(caseFile, speaker)

    const script = compileScript(caseFile, speaker)
    expect(script.gaps).toEqual([])
    expect(script.wordCount).toBeGreaterThan(0)
  })
})

describe('invariants phase 5 reads', () => {
  const scripts = [
    compileScript(buildFilledExampleCase(), role('AP', 'ap-pm')),
    compileScript(buildWhipCase(), role('BP', 'bp-ow')),
  ]

  it.each(scripts.map((script, index) => [index, script] as const))(
    'script %i numbers its tokens contiguously from zero',
    (_index, script) => {
      expect(script.tokens.map((token) => token.index)).toEqual(
        script.tokens.map((_token, position) => position),
      )
      expect(script.wordCount).toBe(script.tokens.length)
    },
  )

  it.each(scripts.map((script, index) => [index, script] as const))(
    'script %i gives every token an offset that slices it back out',
    (_index, script) => {
      for (const item of script.segments) {
        for (const token of item.tokens) {
          expect(item.text.slice(token.start, token.end)).toBe(token.text)
          expect(token.segmentId).toBe(item.id)
        }
      }
    },
  )

  it.each(scripts.map((script, index) => [index, script] as const))(
    'script %i traces every attributed token back to a field that exists',
    (_index, script) => {
      const caseFile = script === scripts[0] ? buildFilledExampleCase() : buildWhipCase()
      const speaker = script === scripts[0] ? role('AP', 'ap-pm') : role('BP', 'bp-ow')
      const known = new Set(flattenFields(buildSections(caseFile, speaker)).map((item) => item.path))

      for (const token of script.tokens) {
        if (token.fieldPath !== null) {
          expect(known).toContain(token.fieldPath)
        }
      }
    },
  )

  it.each(scripts.map((script, index) => [index, script] as const))(
    'script %i leaves no blank left in the text',
    (_index, script) => {
      for (const item of script.segments) {
        expect(item.text).not.toContain('___')
        expect(item.text).not.toMatch(/\s\s/)
        expect(item.text).not.toMatch(/\s[.,;]/)
        expect(item.text.trim()).toBe(item.text)
      }
    },
  )
})

describe('segment ids survive a recompile', () => {
  it('keeps the same ids when an unrelated field changes', () => {
    const before = compileScript(buildWhipCase(), role('BP', 'bp-ow'))
    const edited = setFieldByPath(buildWhipCase(), 'setup.stance', 'A different stance entirely.')
    const after = compileScript(edited, role('BP', 'bp-ow'))

    expect(after.segments.map((item) => item.id)).toEqual(before.segments.map((item) => item.id))
  })
})
