/**
 * Section projection: what each seat is asked to fill, and how those fields are addressed.
 *
 * The role scoping is the part worth guarding. A whip who is docked for an empty DEFINITION
 * table, or a first speaker shown the clash script, is being asked for the wrong thing under
 * time pressure — which is the failure this whole screen exists to prevent.
 */

import { describe, expect, it } from 'vitest'

import { getRole, type SpeakerRole } from '../../formats/index.ts'
import { createEmptyCase } from '../../types/createCase.ts'
import { SUBSTANTIVE_LABELS } from '../../types/case.ts'
import { buildSections, flattenFields } from '../sections.ts'
import { ensureRequiredBlocks, setEngagementBranch, setNeedsMechanism } from '../update.ts'

/**
 * Builds a seeded case for one seat.
 *
 * @param formatId - Format key.
 * @param roleId - Role id within that format. An id from the other format fails the test
 *   rather than silently producing an empty section list.
 * @returns The case and its role, both seeded so repeatable blocks have one item.
 */
function seatedCase(formatId: 'AP' | 'BP', roleId: string): { caseFile: ReturnType<typeof createEmptyCase>; role: SpeakerRole } {
  const role = getRole(formatId, roleId)
  if (!role) {
    throw new Error(`Test asked for a role this format does not have: ${formatId}/${roleId}`)
  }
  const caseFile = ensureRequiredBlocks(createEmptyCase(formatId, role.side, role.id), role)
  return { caseFile, role }
}

describe('sections follow the seat, not the document', () => {
  it('gives a first speaker the definition and policy tables', () => {
    const { caseFile, role } = seatedCase('AP', 'ap-pm')
    const blockIds = buildSections(caseFile, role).map((section) => section.blockId)

    expect(blockIds).toContain('definition')
    expect(blockIds).toContain('policy')
    expect(blockIds).toContain('policyRebuttal')
    expect(blockIds).not.toContain('clashes')
  })

  it('gives a whip the clash script and not the definition table', () => {
    const { caseFile, role } = seatedCase('AP', 'ap-gov-whip')
    const blockIds = buildSections(caseFile, role).map((section) => section.blockId)

    expect(blockIds).toContain('opposingRebuttals')
    expect(blockIds).toContain('clashes')
    expect(blockIds).not.toContain('definition')
    expect(blockIds).not.toContain('substantives')
  })

  it('gives a BP closing member an extension section', () => {
    const { caseFile, role } = seatedCase('BP', 'bp-mg')
    expect(buildSections(caseFile, role).map((section) => section.blockId)).toContain('extension')
  })

  it('withholds the extension section from the opening half', () => {
    const { caseFile, role } = seatedCase('BP', 'bp-pm')
    expect(buildSections(caseFile, role).map((section) => section.blockId)).not.toContain(
      'extension',
    )
  })

  it('drops the policy table once the prep sheet answers "no"', () => {
    const { caseFile, role } = seatedCase('AP', 'ap-pm')
    const withoutPolicy = setNeedsMechanism(caseFile, 'no')

    expect(buildSections(caseFile, role).map((section) => section.id)).toContain('policy')
    expect(buildSections(withoutPolicy, role).map((section) => section.id)).not.toContain('policy')
  })

  it('numbers repeatable sections for the nav', () => {
    const { caseFile, role } = seatedCase('AP', 'ap-pm')
    const navLabels = buildSections(caseFile, role).map((section) => section.navLabel)

    expect(navLabels).toContain('Sub 1')
    expect(navLabels).toContain('Sub 3')
  })
})

describe('field addressing', () => {
  it('gives every field a unique path', () => {
    for (const [formatId, roleIds] of [
      ['AP', ['ap-pm', 'ap-dpm', 'ap-gov-whip']],
      ['BP', ['bp-pm', 'bp-mg', 'bp-gw']],
    ] as const) {
      for (const roleId of roleIds) {
        const { caseFile, role } = seatedCase(formatId, roleId)
        const paths = flattenFields(buildSections(caseFile, role)).map((entry) => entry.path)
        expect(new Set(paths).size).toBe(paths.length)
      }
    }
  })

  it('keys repeatable items by id, so reordering does not orphan a path', () => {
    const { caseFile, role } = seatedCase('AP', 'ap-pm')
    const [firstSub] = caseFile.substantives
    expect(firstSub).toBeDefined()

    const paths = flattenFields(buildSections(caseFile, role)).map((entry) => entry.path)
    expect(paths).toContain(`substantives.${firstSub?.id ?? ''}.whyBad`)
  })
})

describe('script labels point at the real opponent', () => {
  it('leaves an opposition whip reading the template as written', () => {
    const { caseFile, role } = seatedCase('AP', 'ap-opp-whip')
    const labels = flattenFields(buildSections(caseFile, role)).map((entry) => entry.label)

    expect(labels).toContain('Prop told us ___')
  })

  it('flips the bench for a government whip', () => {
    const { caseFile, role } = seatedCase('AP', 'ap-gov-whip')
    const labels = flattenFields(buildSections(caseFile, role)).map((entry) => entry.label)

    expect(labels).toContain('Opp told us ___')
    expect(labels).not.toContain('Prop told us ___')
  })

  it('leaves table questions alone regardless of bench', () => {
    const { caseFile, role } = seatedCase('AP', 'ap-pm')
    const labels = flattenFields(buildSections(caseFile, role)).map((entry) => entry.label)

    expect(labels).toContain(SUBSTANTIVE_LABELS.whyBad)
  })
})

describe('the "(OR)" fork resolves to one branch', () => {
  it('shows the responded branch by default and not the refused one', () => {
    const { caseFile, role } = seatedCase('AP', 'ap-gov-whip')
    const paths = flattenFields(buildSections(caseFile, role)).map((entry) => entry.path)

    expect(paths.some((path) => path.includes('.responded.'))).toBe(true)
    expect(paths.some((path) => path.includes('.refused.'))).toBe(false)
  })

  it('swaps the field set when the whip switches branch', () => {
    const { caseFile, role } = seatedCase('AP', 'ap-gov-whip')
    const [clash] = caseFile.clashes
    const engagement = clash?.engagements[0]
    expect(clash && engagement).toBeTruthy()

    const switched = setEngagementBranch(caseFile, clash?.id ?? '', engagement?.id ?? '', 'refused')
    // Scoped to the switched engagement — the seat's other clash still has its own, and it
    // stays on the responded branch.
    const paths = flattenFields(buildSections(switched, role))
      .map((entry) => entry.path)
      .filter((path) => path.includes(`engagements.${engagement?.id ?? ''}.`))

    expect(paths.some((path) => path.includes('.refused.'))).toBe(true)
    expect(paths.some((path) => path.includes('.responded.'))).toBe(false)
  })
})
