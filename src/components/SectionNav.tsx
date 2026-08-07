/**
 * The section rail — where you are in the case, and how full each part is.
 */

import type { CaseCompleteness } from '../case/completeness.ts'
import type { CaseSection } from '../case/sections.ts'

/** Props for {@link SectionNav}. */
export interface SectionNavProps {
  readonly sections: readonly CaseSection[]
  readonly completeness: CaseCompleteness
  /** Section id currently shown in the editor. */
  readonly activeSectionId: string
  readonly onSelect: (sectionId: string) => void
}

/**
 * Renders one nav entry per section, with its own fill bar.
 *
 * The per-section bars are the point: an overall meter at 70% hides that Sub 3 is empty, and
 * the empty substantive is exactly what a debater needs to see with four minutes left.
 *
 * @param props - See {@link SectionNavProps}.
 * @param props.sections - Sections for this seat, in template order.
 * @param props.completeness - Supplies each section's fill ratio.
 * @param props.activeSectionId - Section currently open in the editor.
 * @param props.onSelect - Called with the section id the user clicked.
 * @returns The rail.
 */
export function SectionNav({
  sections,
  completeness,
  activeSectionId,
  onSelect,
}: SectionNavProps): React.JSX.Element {
  const ratioBySection = new Map(
    completeness.sections.map((section) => [section.sectionId, section.ratio]),
  )

  return (
    <nav className="flex flex-col gap-0.5 overflow-y-auto p-2" aria-label="Case sections">
      {sections.map((section) => {
        const ratio = ratioBySection.get(section.id) ?? 0
        const isActive = section.id === activeSectionId

        return (
          <button
            key={section.id}
            type="button"
            onClick={() => {
              onSelect(section.id)
            }}
            aria-current={isActive ? 'true' : undefined}
            className={`flex flex-col gap-1.5 rounded-md px-2.5 py-2 text-left transition-colors ${
              isActive
                ? 'bg-neutral-200 dark:bg-neutral-800'
                : 'hover:bg-neutral-100 dark:hover:bg-neutral-900'
            }`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{section.navLabel}</span>
              <span className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                {Math.round(ratio * 100)}%
              </span>
            </span>
            <span className="meter-track">
              <span
                className="block h-full rounded-full bg-neutral-500 dark:bg-neutral-400"
                style={{ width: `${String(Math.round(ratio * 100))}%` }}
              />
            </span>
          </button>
        )
      })}
    </nav>
  )
}
