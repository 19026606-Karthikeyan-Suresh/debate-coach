/**
 * Renders one section: its fields, plus the controls that change the section's shape.
 *
 * Fields come from `buildSections` and are rendered generically. Everything bespoke here is
 * structural — add a substantive, answer the mechanism question, pick which side of the
 * "(OR)" fork the whip will actually say — because none of those are text boxes.
 */

import type { BlockId, SpeakerRole } from '../formats/index.ts'
import { requiresExtension } from '../formats/index.ts'
import type { CaseSection } from '../case/sections.ts'
import { ENGAGEMENT_KIND_LABELS } from '../case/sections.ts'
import type { Case, ClashEngagement, MechanismDecision } from '../types/case.ts'
import { PREP_LABELS } from '../types/case.ts'
import {
  addClash,
  addEngagement,
  addHandledArgument,
  addOpposingRebuttal,
  addPointOfInformation,
  addRebuttal,
  addSubstantive,
  removeClash,
  removeEngagement,
  removeOpposingRebuttal,
  removePointOfInformation,
  removeRebuttal,
  removeSubstantive,
  setEngagementBranch,
  setEngagementIsExtension,
  setFieldByPath,
  setNeedsMechanism,
} from '../case/update.ts'
import { TemplateTable } from './TemplateTable.tsx'

/** Path of the mechanism question, which gets a tri-state instead of a text box. */
const MECHANISM_PATH = 'prep.needsMechanism'

/** Props for {@link SectionView}. */
export interface SectionViewProps {
  readonly section: CaseSection
  readonly caseFile: Case
  readonly role: SpeakerRole
  /** Applies an edit against the newest document. */
  readonly update: (mutate: (current: Case) => Case) => void
}

/** Add/remove wording for each repeatable block, so the buttons name the real thing. */
const REPEATABLE_NOUNS: Partial<Record<BlockId, string>> = {
  substantives: 'substantive',
  rebuttals: 'rebuttal',
  opposingRebuttals: 'exchange',
  clashes: 'clash',
}

/**
 * Renders the section currently open in the editor.
 *
 * @param props - See {@link SectionViewProps}.
 * @param props.section - The section to render.
 * @param props.caseFile - The whole case, needed for structural state the fields do not carry.
 * @param props.role - The seat, which decides whether extension controls appear.
 * @param props.update - Applies an edit against the newest document.
 * @returns The section.
 */
export function SectionView({
  section,
  caseFile,
  role,
  update,
}: SectionViewProps): React.JSX.Element {
  const onChange = (path: string, value: string): void => {
    update((current) => setFieldByPath(current, path, value))
  }

  const itemId = section.id.split('.')[1] ?? ''
  const noun = REPEATABLE_NOUNS[section.blockId]

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{section.navLabel}</h2>
          <p className="section-heading mt-0.5">{section.title}</p>
        </div>
        {noun && (
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              className="btn"
              onClick={() => {
                update((current) => addBlockItem(current, section.blockId))
              }}
            >
              Add {noun}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                update((current) => removeBlockItem(current, section.blockId, itemId))
              }}
            >
              Delete
            </button>
          </div>
        )}
      </header>

      {section.groups.map((group) => {
        const engagement = findEngagement(caseFile, section.id, group.sourceId)

        return (
          <div key={group.id} className="panel flex flex-col gap-4 p-4">
            <TemplateTable
              group={group}
              onChange={onChange}
              skipPaths={[MECHANISM_PATH]}
              controls={
                <GroupControls
                  section={section}
                  group={group}
                  engagement={engagement}
                  role={role}
                  update={update}
                />
              }
            />

            {group.fields.some((field) => field.path === MECHANISM_PATH) && (
              <MechanismChoice
                decision={caseFile.prep.needsMechanism}
                onSelect={(decision) => {
                  update((current) => setNeedsMechanism(current, decision))
                }}
              />
            )}
          </div>
        )
      })}

      <SectionFooter section={section} update={update} />
    </div>
  )
}

/**
 * Controls that belong to one group rather than the whole section: removing a POI, and the
 * branch, extension, and delete controls on a clash engagement.
 */
function GroupControls({
  section,
  group,
  engagement,
  role,
  update,
}: {
  section: CaseSection
  group: CaseSection['groups'][number]
  engagement: ClashEngagement | null
  role: SpeakerRole
  update: (mutate: (current: Case) => Case) => void
}): React.JSX.Element | null {
  const clashId = section.id.split('.')[1] ?? ''

  if (section.blockId === 'prep' && group.sourceId) {
    return (
      <button
        type="button"
        className="btn btn-danger"
        onClick={() => {
          update((current) => removePointOfInformation(current, group.sourceId))
        }}
      >
        Remove
      </button>
    )
  }

  if (!engagement) {
    return null
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {engagement.kind !== 'overlap' && (
        <>
          {/* The template's "(OR)": either they ignored the argument or they answered it.
              Only the chosen branch is rendered, counted, and later compiled. */}
          <div className="flex overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700">
            {(['responded', 'refused'] as const).map((branch) => (
              <button
                key={branch}
                type="button"
                onClick={() => {
                  update((current) =>
                    setEngagementBranch(current, clashId, engagement.id, branch),
                  )
                }}
                className={`px-2 py-1 text-xs font-medium ${
                  engagement.response.branch === branch
                    ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                    : 'bg-transparent text-neutral-600 dark:text-neutral-300'
                }`}
              >
                {branch === 'responded' ? 'They answered' : 'They refused'}
              </button>
            ))}
          </div>

          {/* Only closing-half seats have an extension to place. */}
          {requiresExtension(role) && (
            <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={engagement.response.responded.isExtension}
                onChange={(event) => {
                  update((current) =>
                    setEngagementIsExtension(
                      current,
                      clashId,
                      engagement.id,
                      event.target.checked,
                    ),
                  )
                }}
              />
              Carries the extension
            </label>
          )}
        </>
      )}

      <button
        type="button"
        className="btn btn-danger"
        onClick={() => {
          update((current) => removeEngagement(current, clashId, engagement.id))
        }}
      >
        Remove
      </button>
    </div>
  )
}

/**
 * Buttons that append something to the section: a POI, a signposted argument, an engagement.
 * Renders nothing for a section with nothing to append.
 */
function SectionFooter({
  section,
  update,
}: {
  section: CaseSection
  update: (mutate: (current: Case) => Case) => void
}): React.JSX.Element | null {
  if (section.blockId === 'prep') {
    return (
      <button
        type="button"
        className="btn self-start"
        onClick={() => {
          update(addPointOfInformation)
        }}
      >
        Add POI
      </button>
    )
  }

  if (section.blockId !== 'clashes') {
    return null
  }

  const clashId = section.id.split('.')[1] ?? ''

  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        type="button"
        className="btn"
        onClick={() => {
          update((current) =>
            addHandledArgument(current, clashId, current.side === 'gov' ? 'opp' : 'gov'),
          )
        }}
      >
        Add signposted argument
      </button>
      {(Object.keys(ENGAGEMENT_KIND_LABELS) as ClashEngagement['kind'][]).map((kind) => (
        <button
          key={kind}
          type="button"
          className="btn"
          onClick={() => {
            update((current) => addEngagement(current, clashId, kind))
          }}
        >
          Add: {ENGAGEMENT_KIND_LABELS[kind].toLowerCase()}
        </button>
      ))}
    </div>
  )
}

/** The template's Yes/No mechanism question. `undecided` is shown as neither, not as "No". */
function MechanismChoice({
  decision,
  onSelect,
}: {
  decision: MechanismDecision
  onSelect: (decision: MechanismDecision) => void
}): React.JSX.Element {
  return (
    <div>
      <span className="field-label">{PREP_LABELS.needsMechanism}</span>
      <span className="field-hint">
        Answer it early. A case that needs a mechanism and lacks one loses on the first POI.
      </span>
      <div className="mt-1.5 flex gap-1.5">
        {(['yes', 'no'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              onSelect(decision === option ? 'undecided' : option)
            }}
            className={`btn ${decision === option ? 'btn-primary' : ''}`}
          >
            {option === 'yes' ? 'Yes' : 'No'}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Finds the engagement a clash group renders, if it renders one.
 *
 * @param caseFile - The case being edited.
 * @param sectionId - Section id, which carries the clash id.
 * @param sourceId - The group's source id, empty for the signposting group.
 * @returns The engagement, or null when the group is not one.
 */
function findEngagement(
  caseFile: Case,
  sectionId: string,
  sourceId: string,
): ClashEngagement | null {
  if (!sourceId || !sectionId.startsWith('clashes.')) {
    return null
  }
  const clashId = sectionId.split('.')[1] ?? ''
  const clash = caseFile.clashes.find((item) => item.id === clashId)
  return clash?.engagements.find((item) => item.id === sourceId) ?? null
}

/**
 * Appends an item to whichever repeatable block the section belongs to.
 *
 * @param caseFile - The case being edited.
 * @param blockId - Block to append to. A non-repeatable block returns the case unchanged.
 * @returns The updated case.
 */
function addBlockItem(caseFile: Case, blockId: BlockId): Case {
  switch (blockId) {
    case 'substantives':
      return addSubstantive(caseFile)
    case 'rebuttals':
      return addRebuttal(caseFile)
    case 'opposingRebuttals':
      return addOpposingRebuttal(caseFile)
    case 'clashes':
      return addClash(caseFile)
    default:
      return caseFile
  }
}

/**
 * Drops one item from a repeatable block.
 *
 * @param caseFile - The case being edited.
 * @param blockId - Block the item belongs to.
 * @param itemId - Item to drop. An unknown id is a no-op.
 * @returns The updated case.
 */
function removeBlockItem(caseFile: Case, blockId: BlockId, itemId: string): Case {
  switch (blockId) {
    case 'substantives':
      return removeSubstantive(caseFile, itemId)
    case 'rebuttals':
      return removeRebuttal(caseFile, itemId)
    case 'opposingRebuttals':
      return removeOpposingRebuttal(caseFile, itemId)
    case 'clashes':
      return removeClash(caseFile, itemId)
    default:
      return caseFile
  }
}
