/**
 * The Prep screen — the section rail, the open section, and the timer.
 *
 * Keyboard-first, because this is used during a 15-minute prep with one hand on a laptop:
 * Tab walks the fields in template order, Ctrl+Enter moves to the next section, and
 * Ctrl+Shift+Enter goes back. Nothing here needs the mouse.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { groupFindingsByPath } from '../analysis/index.ts'
import { getFormat, getRole } from '../formats/index.ts'
import { measureSections } from '../case/completeness.ts'
import { buildSections, flattenFields } from '../case/sections.ts'
import { setSeat, setVisibility } from '../case/update.ts'
import { useAnalysis } from '../hooks/useAnalysis.ts'
import type { SaveStatus } from '../hooks/useCaseStore.ts'
import { useCaseStore } from '../hooks/useCaseStore.ts'
import { isCoachEnabled } from '../coach/index.ts'
import { useCoach } from '../hooks/useCoach.ts'
import { useCoPrep } from '../hooks/useCoPrep.ts'
import { usePrepDuration } from '../hooks/usePrepDuration.ts'
import { usePrepTimer } from '../hooks/usePrepTimer.ts'
import { CoachPanel } from './CoachPanel.tsx'
import { CoPrepPanel } from './CoPrepPanel.tsx'
import { CompletenessMeter } from './CompletenessMeter.tsx'
import { DepthPanel } from './DepthPanel.tsx'
import { ExportPanel } from './ExportPanel.tsx'
import { MotionBar } from './MotionBar.tsx'
import { PrepTimer } from './PrepTimer.tsx'
import { SectionNav } from './SectionNav.tsx'
import { SectionView } from './SectionView.tsx'
import { SeatPicker } from './SeatPicker.tsx'

/** Props for {@link CaseEditor}. */
export interface CaseEditorProps {
  readonly caseId: string
  /** Returns to the library. The store flushes its pending write on the way out. */
  readonly onClose: () => void
  /** Opens the Speak screen. Same flush applies — Speak recompiles from what was written. */
  readonly onSpeak: () => void
}

/**
 * Renders the case builder for one case.
 *
 * @param props - See {@link CaseEditorProps}.
 * @param props.caseId - Row to open.
 * @param props.onClose - Returns to the library.
 * @param props.onSpeak - Opens the Speak screen.
 * @returns The Prep screen.
 */
export function CaseEditor({ caseId, onClose, onSpeak }: CaseEditorProps): React.JSX.Element {
  // Which section the user asked for. Null means "the first one", which is also the fallback
  // when a chosen section disappears — its substantive was deleted, or the mechanism question
  // turned the policy table off.
  const [pendingSectionId, setPendingSectionId] = useState<string | null>(null)

  const store = useCaseStore(caseId)
  const { caseFile } = store

  // Co-prep wraps the store's `update` rather than replacing it: with no room open it *is* the
  // store's, and with one open every edit goes through the shared document first. The editor
  // below uses `update` unconditionally and never branches on whether a room is running.
  const coPrep = useCoPrep(caseFile, store.update)
  const update = coPrep.update

  const format = caseFile ? getFormat(caseFile.format) : null
  const role = caseFile ? getRole(caseFile.format, caseFile.position) : undefined
  // The format supplies the rule and the debater may override it — a tournament running short
  // prep, or a chair granting five more minutes mid-round. The format id is the round key, so a
  // BP-to-AP switch resets the clock while a length change only shifts it.
  const prepDuration = usePrepDuration(caseFile?.format ?? 'AP', format?.prepSeconds ?? 0)
  const timer = usePrepTimer(prepDuration.seconds, caseFile?.format ?? 'AP')

  const sections = useMemo(
    () => (caseFile && role ? buildSections(caseFile, role) : []),
    [caseFile, role],
  )
  const completeness = useMemo(() => measureSections(sections), [sections])

  const findings = useAnalysis(caseFile, role)
  const findingsByPath = useMemo(() => groupFindingsByPath(findings), [findings])

  // Field paths to the template's own question, so a teammate's position reads as "in 'Why is
  // the problem so bad?'" rather than as a uuid.
  const labelByPath = useMemo(
    () => new Map(flattenFields(sections).map((field) => [field.path, field.label])),
    [sections],
  )
  const labelForPath = useCallback(
    (fieldPath: string): string | null => labelByPath.get(fieldPath) ?? null,
    [labelByPath],
  )

  // Which section holds the motion, so the bar can jump to it. Looked up rather than hardcoded
  // to the prep sheet: the field registry decides where a row lives, and a bar that jumped to a
  // section the motion had moved out of would be worse than one that did nothing.
  const motionSectionId = useMemo(
    () =>
      sections.find((section) =>
        section.groups.some((group) => group.fields.some((field) => field.path === 'prep.motion')),
      )?.id ?? null,
    [sections],
  )

  // Layer B, and whether it is switched on at all. The hook is called unconditionally because
  // hooks must be, but it does nothing when the flag is off — see `coach/config.ts` for why this
  // is a flag rather than "is there an API key lying around".
  const showCoach = isCoachEnabled()
  const coach = useCoach()

  const activeSection =
    sections.find((section) => section.id === pendingSectionId) ?? sections[0] ?? null

  // Opening a section and focusing a field is one action from the depth panel's point of view
  // but two from React's: the field only exists once the new section has rendered. React 19
  // flushes a click's state update synchronously, so a macrotask scheduled here runs after the
  // commit and after the scroll-to-top effect below, which is why the focus wins.
  //
  // A timeout rather than `requestAnimationFrame`: rAF does not fire while the window is not
  // compositing, so a minimised or hidden window would swallow the focus and leave the click
  // looking like it did nothing.
  const revealField = useCallback((sectionId: string, fieldPath: string): void => {
    setPendingSectionId(sectionId)
    window.setTimeout(() => {
      document.getElementById(fieldPath)?.focus()
    }, 0)
  }, [])

  const moveSection = useCallback(
    (offset: number): void => {
      if (!activeSection) {
        return
      }
      const index = sections.findIndex((section) => section.id === activeSection.id)
      const next = sections[index + offset]
      if (next) {
        setPendingSectionId(next.id)
      }
    },
    [activeSection, sections],
  )

  // Ctrl+Enter is bound on the window rather than the section container so it still fires
  // when focus is inside a textarea, which is where it will always be.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !event.ctrlKey) {
        return
      }
      event.preventDefault()
      moveSection(event.shiftKey ? -1 : 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [moveSection])

  // Scroll the newly opened section back to the top; leaving it mid-scroll from the previous
  // section makes it look like the case is missing its first rows.
  useEffect(() => {
    document.getElementById('section-scroll')?.scrollTo({ top: 0 })
  }, [activeSection?.id])

  if (store.status === 'loading') {
    return <p className="p-8 text-sm text-neutral-500">Opening case…</p>
  }

  if (!caseFile || !format) {
    return (
      <div className="flex flex-col items-start gap-3 p-8">
        <p className="text-sm text-red-700 dark:text-red-400">
          {store.error ?? 'This case could not be opened.'}
        </p>
        <button type="button" className="btn" onClick={onClose}>
          Back to library
        </button>
      </div>
    )
  }

  return (
    <div className="grid h-full grid-cols-[13rem_1fr_19rem] overflow-hidden">
      <aside className="flex flex-col overflow-hidden border-r border-neutral-200 dark:border-neutral-800">
        <div className="flex flex-col gap-1.5 border-b border-neutral-200 p-2 dark:border-neutral-800">
          <button type="button" className="btn w-full" onClick={onClose}>
            ← Library
          </button>
          {/* Enabled whatever the completeness meter says: a half-filled case still compiles,
              and seeing which lines are missing on the Speak screen is often what sends someone
              back here to write them. */}
          <button type="button" className="btn btn-primary w-full justify-center" onClick={onSpeak}>
            Speak →
          </button>
        </div>
        <SectionNav
          sections={sections}
          completeness={completeness}
          activeSectionId={activeSection?.id ?? ''}
          onSelect={setPendingSectionId}
        />
      </aside>

      {/* Focus is read off the container rather than wired into `FieldEditor`, because every
          input there already carries `id={field.path}` for the depth panel to focus — so the
          address a teammate needs is on the event, and no field component changes. */}
      <main
        id="section-scroll"
        className="overflow-y-auto p-6"
        onFocusCapture={(event) => {
          const fieldPath = (event.target as HTMLElement).id
          coPrep.setFieldPath(fieldPath === '' ? null : fieldPath)
        }}
        onBlurCapture={(event) => {
          // `focusout` fires before the next `focusin`, so clearing unconditionally makes every
          // Tab between two rows report "nowhere" and then the new row — two presence messages
          // per keypress against a ten-a-second throttle, and a panel that blinks while a
          // teammate walks the template. Only a focus leaving the editor entirely clears it.
          const next = event.relatedTarget
          if (!(next instanceof HTMLElement) || !event.currentTarget.contains(next)) {
            coPrep.setFieldPath(null)
          }
        }}
      >
        {/* Above the section rather than in it: the motion is the sentence every other row has
            to answer to, and it is a prep-sheet field that scrolls out of sight the moment
            somebody opens Sub 2. */}
        <MotionBar
          motion={caseFile.prep.motion}
          onEdit={
            motionSectionId === null
              ? undefined
              : () => {
                  revealField(motionSectionId, 'prep.motion')
                }
          }
        />

        {role && activeSection ? (
          <div className="mx-auto max-w-2xl">
            <SectionView
              section={activeSection}
              caseFile={caseFile}
              role={role}
              findingsByPath={findingsByPath}
              update={update}
            />
            <p className="mt-8 text-xs text-neutral-400 dark:text-neutral-500">
              Ctrl+Enter for the next section, Ctrl+Shift+Enter for the previous.
            </p>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">
            Pick a speaking position to see the parts of the template you fill.
          </p>
        )}
      </main>

      <aside className="flex flex-col gap-5 overflow-y-auto border-l border-neutral-200 p-4 dark:border-neutral-800">
        <SeatPicker
          caseFile={caseFile}
          onChange={(formatId, side, position) => {
            update((current) => setSeat(current, formatId, side, position))
            setPendingSectionId(null)
          }}
        />
        <CompletenessMeter completeness={completeness} />
        <PrepTimer timer={timer} completeness={completeness} duration={prepDuration} />
        <DepthPanel findings={findings} sections={sections} onSelect={revealField} />
        {showCoach && role && (
          <CoachPanel
            caseFile={caseFile}
            role={role}
            activeSectionId={activeSection?.id ?? ''}
            coach={coach}
            update={update}
          />
        )}

        <CoPrepPanel
          coPrep={coPrep}
          caseFile={caseFile}
          roles={format.roles}
          labelForPath={labelForPath}
        />

        <ExportPanel caseFile={caseFile} role={role} />

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={caseFile.visibility === 'team'}
            onChange={(event) => {
              update((current) => setVisibility(current, event.target.checked ? 'team' : 'private'))
            }}
          />
          Share with team
        </label>

        <SaveIndicator
          status={store.status}
          error={store.error}
          hasUnsavedChanges={store.hasUnsavedChanges}
        />
      </aside>
    </div>
  )
}

/** Save state, so it is obvious whether closing the laptop is safe. */
function SaveIndicator({
  status,
  error,
  hasUnsavedChanges,
}: {
  status: SaveStatus
  error: string | null
  hasUnsavedChanges: boolean
}): React.JSX.Element {
  if (status === 'error') {
    return (
      <p className="mt-auto text-xs text-red-700 dark:text-red-400">Not saved: {error}</p>
    )
  }
  return (
    <p className="mt-auto text-xs text-neutral-500 dark:text-neutral-400">
      {hasUnsavedChanges ? 'Saving…' : 'Saved locally'}
    </p>
  )
}
