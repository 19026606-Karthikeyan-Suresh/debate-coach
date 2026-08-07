/**
 * Projects a case into the sections one speaker actually fills.
 *
 * This is the join between three things that would otherwise each grow their own copy of
 * "what fields exist": the editor renders from it, the completeness meter counts it, and from
 * phase 3 the analyzer addresses findings by the `path` on each field. Anything that is not
 * reachable here is not editable, not counted, and not analysable — which is the point.
 *
 * Only the blocks the role is asked to fill appear. A whip never sees the DEFINITION table,
 * so their completeness is not permanently docked for leaving it blank.
 */

import type { BlockId, SpeakerRole } from '../formats/index.ts'
import type {
  Case,
  Clash,
  ClashEngagement,
  MechanismDecision,
  PrepBlock,
} from '../types/case.ts'
import { PREP_LABELS } from '../types/case.ts'
import {
  CASE_DIVISION_FIELDS,
  CLASH_TITLE_FIELD,
  DEFINITION_FIELDS,
  EXTENSION_FIELDS,
  FIVE_W1H_FIELDS,
  HANDLED_ARGUMENT_FIELD,
  OPPOSING_REBUTTAL_FIELDS,
  OUR_ARGUMENT_FIELDS,
  OVERLAP_FIELDS,
  POLICY_FIELDS,
  POLICY_REBUTTAL_FIELDS,
  PREP_FIELDS,
  REBUTTAL_FIELDS,
  REFUSED_BRANCH_FIELDS,
  RESPONDED_BRANCH_FIELDS,
  SETUP_FIELDS,
  SUBSTANTIVE_FIELDS,
  THEIR_ARGUMENT_FIELDS,
  withOpponentName,
  type FieldSpec,
} from './fields.ts'

/**
 * One addressable field, resolved against a real case.
 *
 * `path` is the stable address — `substantives.<id>.whyBad` — and survives reordering,
 * because repeatable blocks are keyed by their id rather than their index.
 */
export interface CaseField {
  readonly path: string
  /** Rendered label, already pointed at the right bench by `withOpponentName`. */
  readonly label: string
  readonly hint: string
  readonly rows: number
  /** Current text. Empty means unfilled; the meter and the nudge both key off that. */
  readonly value: string
}

/**
 * A run of fields under one heading.
 *
 * Simple blocks are a single group with an empty heading. Blocks that repeat something inside
 * themselves — a clash's engagements, the POI list — get one group each.
 */
export interface FieldGroup {
  readonly id: string
  /** Empty on a block that has nothing to sub-divide. */
  readonly heading: string
  /**
   * Id of the underlying item — engagement, POI, handled argument — or `''` for a whole block.
   * Structural controls (delete this engagement, switch its branch) resolve by this rather
   * than by parsing the field paths.
   */
  readonly sourceId: string
  readonly fields: readonly CaseField[]
}

/** One section of the editor, and one entry in the section nav. */
export interface CaseSection {
  /** Stable address of the section, e.g. `substantives.<id>`. Used as the nav key and anchor. */
  readonly id: string
  readonly blockId: BlockId
  /** Short form for the nav rail, e.g. "Sub 2". */
  readonly navLabel: string
  /** The template's own heading, e.g. "SUBSTANTIVE STRUCTURE". */
  readonly title: string
  readonly groups: readonly FieldGroup[]
}

/**
 * Resolves a run of registry specs against a block.
 *
 * @param pathPrefix - Everything before the field key, without a trailing dot.
 * @param specs - Registry entries for this block.
 * @param block - The block holding the values. A key missing from it resolves to `''` rather
 *   than throwing, so a case stored before a field existed still renders.
 * @param side - Bench the case is argued from; drives the Prop/Opp swap on script labels.
 * @returns One resolved field per spec, in registry order.
 */
function resolveFields(
  pathPrefix: string,
  specs: readonly FieldSpec[],
  block: object,
  side: Case['side'],
): readonly CaseField[] {
  // TypeScript gives interfaces no implicit index signature, so every block type would have to
  // be widened at its call site. One cast here instead, guarded by the `typeof` below.
  const values = block as Readonly<Record<string, unknown>>

  return specs.map((spec) => {
    const stored = values[spec.key]
    return {
      path: `${pathPrefix}.${spec.key}`,
      label: withOpponentName(spec.label, side),
      hint: spec.hint,
      rows: spec.rows,
      value: typeof stored === 'string' ? stored : '',
    }
  })
}

/** Wraps a single run of fields as the sole group of a simple block. */
function singleGroup(fields: readonly CaseField[]): readonly FieldGroup[] {
  return [{ id: 'main', heading: '', sourceId: '', fields }]
}

/**
 * Builds the prep sheet's groups: the loose fields, 5W1H, the mechanism decision, then POIs.
 *
 * The mechanism decision is a tri-state rather than text, but it appears here as a field so
 * the meter can nag about it — `undecided` resolves to `''`, which reads as unfilled. `no` is
 * a real answer and counts as filled.
 *
 * @param prep - The prep block to resolve.
 * @param side - Bench the case is argued from.
 * @returns Groups in the order the template asks the questions.
 */
function buildPrepGroups(prep: PrepBlock, side: Case['side']): readonly FieldGroup[] {
  const decided: MechanismDecision = prep.needsMechanism
  const mechanismField: CaseField = {
    path: 'prep.needsMechanism',
    label: PREP_LABELS.needsMechanism,
    hint: 'Answer it early. A case that needs a mechanism and lacks one loses on the first POI.',
    rows: 1,
    value: decided === 'undecided' ? '' : decided,
  }

  const groups: FieldGroup[] = [
    {
      id: 'prep-main',
      heading: '',
      sourceId: '',
      fields: [
        ...resolveFields('prep', PREP_FIELDS, prep, side),
        mechanismField,
      ],
    },
    {
      id: 'prep-5w1h',
      heading: PREP_LABELS.fiveW1H,
      sourceId: '',
      fields: resolveFields('prep.fiveW1H', FIVE_W1H_FIELDS, prep.fiveW1H, side),
    },
  ]

  // One group per POI. An empty list adds nothing — a case with no POIs listed is not
  // incomplete, but a POI with no prepared response is, which is why both rows count.
  for (const [poiIndex, poi] of prep.pois.entries()) {
    groups.push({
      id: `prep-poi-${poi.id}`,
      heading: `POI ${String(poiIndex + 1)}`,
      sourceId: poi.id,
      fields: [
        {
          path: `prep.pois.${poi.id}.text`,
          label: 'The POI, as they would ask it',
          hint: 'Their sharpest question, not their easiest.',
          rows: 2,
          value: poi.text,
        },
        {
          path: `prep.pois.${poi.id}.response`,
          label: 'Your answer',
          hint: 'Fifteen seconds. If it needs thirty, you have not answered it yet.',
          rows: 2,
          value: poi.response,
        },
      ],
    })
  }

  return groups
}

/**
 * What each of the template's three script skeletons is called.
 *
 * Exported because the clash editor offers these as the "add engagement" choices, and the
 * name the whip picks from should be the name shown on the group they get.
 */
export const ENGAGEMENT_KIND_LABELS: Readonly<Record<ClashEngagement['kind'], string>> = {
  'their-argument': 'Their argument',
  'our-argument': 'Our argument',
  overlap: 'Overlapping arguments',
}

/** Registry array for one engagement kind. */
const ENGAGEMENT_SPECS = {
  'their-argument': THEIR_ARGUMENT_FIELDS,
  'our-argument': OUR_ARGUMENT_FIELDS,
  overlap: OVERLAP_FIELDS,
} as const satisfies Record<ClashEngagement['kind'], readonly FieldSpec[]>

/**
 * Builds the groups for one clash: its title and signposting, then one group per engagement.
 *
 * Only the selected side of each engagement's "(OR)" fork contributes fields. Counting both
 * would mean nobody could ever reach 100%, since the branches are mutually exclusive — you
 * either say "they refused to respond" or you answer what they said.
 *
 * @param clash - The clash to resolve.
 * @param side - Bench the case is argued from.
 * @returns The signposting group followed by one group per engagement, in order.
 */
function buildClashGroups(clash: Clash, side: Case['side']): readonly FieldGroup[] {
  const signpostFields: CaseField[] = [
    {
      path: `clashes.${clash.id}.title`,
      label: withOpponentName(CLASH_TITLE_FIELD.label, side),
      hint: CLASH_TITLE_FIELD.hint,
      rows: CLASH_TITLE_FIELD.rows,
      value: clash.title,
    },
    ...clash.handledArguments.map((handled) => ({
      path: `clashes.${clash.id}.handledArguments.${handled.id}.topic`,
      label: withOpponentName(HANDLED_ARGUMENT_FIELD.label, side),
      hint: HANDLED_ARGUMENT_FIELD.hint,
      rows: HANDLED_ARGUMENT_FIELD.rows,
      value: handled.topic,
    })),
  ]

  const groups: FieldGroup[] = [
    { id: `${clash.id}-signpost`, heading: '', sourceId: '', fields: signpostFields },
  ]

  for (const engagement of clash.engagements) {
    const enginePath = `clashes.${clash.id}.engagements.${engagement.id}`
    const fields = [...resolveFields(enginePath, ENGAGEMENT_SPECS[engagement.kind], engagement, side)]

    // The overlap variant is self-contained prose — it has no "(OR)" fork to resolve.
    if (engagement.kind !== 'overlap') {
      const branch = engagement.response.branch
      fields.push(
        ...(branch === 'refused'
          ? resolveFields(
              `${enginePath}.refused`,
              REFUSED_BRANCH_FIELDS,
              engagement.response.refused,
              side,
            )
          : resolveFields(
              `${enginePath}.responded`,
              RESPONDED_BRANCH_FIELDS,
              engagement.response.responded,
              side,
            )),
      )
    }

    groups.push({
      id: engagement.id,
      heading: ENGAGEMENT_KIND_LABELS[engagement.kind],
      sourceId: engagement.id,
      fields,
    })
  }

  return groups
}

/**
 * Projects a case into the sections a given seat fills.
 *
 * Blocks the role is not asked for are omitted entirely rather than rendered empty. Two blocks
 * are also skipped when the case has switched them off: `policy` when the prep sheet answered
 * "no" to the mechanism question, and `extension` outside the BP closing half.
 *
 * @param caseFile - The case to project. Repeatable blocks with no items produce no sections,
 *   so call `ensureRequiredBlocks` first if the editor needs something to type into.
 * @param role - The seat being prepped. Its `blocks` list drives both which sections exist and
 *   what order they come in.
 * @returns Sections in the role's block order, one per item for repeatable blocks.
 */
export function buildSections(caseFile: Case, role: SpeakerRole): readonly CaseSection[] {
  const sections: CaseSection[] = []
  const side = caseFile.side

  for (const blockId of role.blocks) {
    switch (blockId) {
      case 'prep':
        sections.push({
          id: 'prep',
          blockId,
          navLabel: 'Prep',
          title: 'PREP SHEET',
          groups: buildPrepGroups(caseFile.prep, side),
        })
        break

      case 'setup':
        sections.push({
          id: 'setup',
          blockId,
          navLabel: 'Set-up',
          title: 'CASE SET-UP',
          groups: [
            {
              id: 'setup-main',
              heading: '',
              sourceId: '',
              fields: resolveFields('setup', SETUP_FIELDS, caseFile.setup, side),
            },
            {
              id: 'setup-division',
              heading: 'Case Division',
              sourceId: '',
              fields: resolveFields(
                'setup.caseDivision',
                CASE_DIVISION_FIELDS,
                caseFile.setup.caseDivision,
                side,
              ),
            },
          ],
        })
        break

      case 'definition':
        sections.push({
          id: 'definition',
          blockId,
          navLabel: 'Definition',
          title: 'DEFINITION',
          groups: singleGroup(
            resolveFields('definition', DEFINITION_FIELDS, caseFile.definition, side),
          ),
        })
        break

      case 'policy':
        if (caseFile.policy) {
          sections.push({
            id: 'policy',
            blockId,
            navLabel: 'Policy',
            title: 'POLICY',
            groups: singleGroup(resolveFields('policy', POLICY_FIELDS, caseFile.policy, side)),
          })
        }
        break

      case 'substantives':
        for (const [index, substantive] of caseFile.substantives.entries()) {
          sections.push({
            id: `substantives.${substantive.id}`,
            blockId,
            navLabel: `Sub ${String(index + 1)}`,
            title: 'SUBSTANTIVE STRUCTURE',
            groups: singleGroup(
              resolveFields(
                `substantives.${substantive.id}`,
                SUBSTANTIVE_FIELDS,
                substantive,
                side,
              ),
            ),
          })
        }
        break

      case 'policyRebuttal':
        sections.push({
          id: 'policyRebuttal',
          blockId,
          navLabel: 'Policy rebuttal',
          title: 'POLICY REBUTTAL',
          groups: singleGroup(
            resolveFields(
              'policyRebuttal',
              POLICY_REBUTTAL_FIELDS,
              caseFile.policyRebuttal,
              side,
            ),
          ),
        })
        break

      case 'rebuttals':
        for (const [index, rebuttal] of caseFile.rebuttals.entries()) {
          sections.push({
            id: `rebuttals.${rebuttal.id}`,
            blockId,
            navLabel: `Rebuttal ${String(index + 1)}`,
            title: 'REBUTTAL',
            groups: singleGroup(
              resolveFields(`rebuttals.${rebuttal.id}`, REBUTTAL_FIELDS, rebuttal, side),
            ),
          })
        }
        break

      case 'opposingRebuttals':
        for (const [index, opposing] of caseFile.opposingRebuttals.entries()) {
          sections.push({
            id: `opposingRebuttals.${opposing.id}`,
            blockId,
            navLabel: `Exchange ${String(index + 1)}`,
            title: 'OPPOSING TEAM REBUTTALS',
            groups: singleGroup(
              resolveFields(
                `opposingRebuttals.${opposing.id}`,
                OPPOSING_REBUTTAL_FIELDS,
                opposing,
                side,
              ),
            ),
          })
        }
        break

      case 'clashes':
        for (const [index, clash] of caseFile.clashes.entries()) {
          sections.push({
            id: `clashes.${clash.id}`,
            blockId,
            navLabel: `Clash ${String(index + 1)}`,
            title: 'THIRD SPEAKER',
            groups: buildClashGroups(clash, side),
          })
        }
        break

      case 'extension':
        if (caseFile.extension) {
          sections.push({
            id: 'extension',
            blockId,
            navLabel: 'Extension',
            title: 'EXTENSION',
            groups: singleGroup(
              resolveFields('extension', EXTENSION_FIELDS, caseFile.extension, side),
            ),
          })
        }
        break
    }
  }

  return sections
}

/**
 * Flattens sections back to a single ordered field list.
 *
 * @param sections - Sections from `buildSections`.
 * @returns Every field, in document order.
 */
export function flattenFields(sections: readonly CaseSection[]): readonly CaseField[] {
  return sections.flatMap((section) => section.groups.flatMap((group) => group.fields))
}
