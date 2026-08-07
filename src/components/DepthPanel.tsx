/**
 * Everything the analyzer found, grouped by the section it is in.
 *
 * The panel's job is triage, not detail — the full message already sits under the field it
 * belongs to. So each entry is one line naming the row and the problem, and clicking it opens
 * that section and puts the caret in the box.
 *
 * Polish notes are collapsed behind a toggle. There are usually more of them than everything
 * else combined, and a list where the first twenty items are "very" weakens the sentence is a
 * list nobody scrolls to the bottom of.
 */

import { useState } from 'react'

import { countBySeverity, findingKey, RULE_TITLES } from '../analysis/index.ts'
import type { Finding, Severity } from '../analysis/index.ts'
import type { CaseField, CaseSection } from '../case/sections.ts'

/** Props for {@link DepthPanel}. */
export interface DepthPanelProps {
  readonly findings: readonly Finding[]
  /** The seat's sections, used to group findings and to name the row each one is about. */
  readonly sections: readonly CaseSection[]
  /** Opens a section and focuses one of its fields. */
  readonly onSelect: (sectionId: string, fieldPath: string) => void
}

/** Dot colour per severity. */
const DOT_CLASSES: Readonly<Record<Severity, string>> = {
  critical: 'bg-red-600 dark:bg-red-500',
  warn: 'bg-amber-500',
  info: 'bg-neutral-400 dark:bg-neutral-600',
}

/** One section's findings, with enough context to render them without another lookup. */
interface FindingGroup {
  readonly sectionId: string
  readonly navLabel: string
  readonly entries: readonly { readonly finding: Finding; readonly field: CaseField }[]
}

/**
 * Buckets findings under the section holding the field they point at.
 *
 * A finding whose field is no longer in the projection is dropped rather than shown unplaceable —
 * that happens for a few hundred milliseconds after deleting a substantive, while the debounced
 * analysis still describes the case as it was.
 */
function groupBySection(
  findings: readonly Finding[],
  sections: readonly CaseSection[],
): readonly FindingGroup[] {
  const owners = new Map<string, { section: CaseSection; field: CaseField }>()
  for (const section of sections) {
    for (const group of section.groups) {
      for (const field of group.fields) {
        owners.set(field.path, { section, field })
      }
    }
  }

  const grouped = new Map<string, FindingGroup>()
  for (const finding of findings) {
    const owner = owners.get(finding.fieldPath)
    if (!owner) {
      continue
    }
    const existing = grouped.get(owner.section.id)
    const entry = { finding, field: owner.field }
    if (existing) {
      grouped.set(owner.section.id, { ...existing, entries: [...existing.entries, entry] })
    } else {
      grouped.set(owner.section.id, {
        sectionId: owner.section.id,
        navLabel: owner.section.navLabel,
        entries: [entry],
      })
    }
  }
  return [...grouped.values()]
}

/**
 * Renders the depth panel.
 *
 * @param props - See {@link DepthPanelProps}.
 * @param props.findings - Findings for the whole seat, already in document order.
 * @param props.sections - The seat's sections, for grouping and for row names.
 * @param props.onSelect - Opens a section and focuses one of its fields.
 * @returns The panel.
 */
export function DepthPanel({ findings, sections, onSelect }: DepthPanelProps): React.JSX.Element {
  const [showsPolish, setShowsPolish] = useState(false)

  const counts = countBySeverity(findings)
  const shown = showsPolish ? findings : findings.filter((finding) => finding.severity !== 'info')
  const groups = groupBySection(shown, sections)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="section-heading">Depth</span>
        <span className="flex items-center gap-2 text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
          <SeverityCount severity="critical" count={counts.critical} />
          <SeverityCount severity="warn" count={counts.warn} />
          <SeverityCount severity="info" count={counts.info} />
        </span>
      </div>

      {findings.length === 0 ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Nothing flagged. The rules stay quiet on empty rows — the meter above counts those.
        </p>
      ) : (
        <>
          {groups.map((group) => (
            <section key={group.sectionId} className="flex flex-col gap-1">
              <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">
                {group.navLabel}
              </h4>
              {group.entries.map(({ finding, field }) => (
                <button
                  key={findingKey(finding)}
                  type="button"
                  onClick={() => {
                    onSelect(group.sectionId, finding.fieldPath)
                  }}
                  className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left
                    hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <span
                    className={`mt-1 size-1.5 shrink-0 rounded-full ${DOT_CLASSES[finding.severity]}`}
                    aria-label={finding.severity}
                  />
                  {/* The message leads, not the rule name. Three of `impactAxes`'s findings can
                      land on one row, and "Impact axes — Why is the problem so bad?" three times
                      over is a list you cannot triage from. */}
                  <span className="min-w-0 text-xs leading-snug">
                    <span className="block text-neutral-900 dark:text-neutral-100">
                      {finding.message}
                    </span>
                    <span
                      className="block truncate text-neutral-500 dark:text-neutral-400"
                      title={`${RULE_TITLES[finding.rule]} — ${field.label}`}
                    >
                      {field.label}
                    </span>
                  </span>
                </button>
              ))}
            </section>
          ))}

          {counts.info > 0 && (
            <button
              type="button"
              className="self-start text-xs text-neutral-500 underline underline-offset-2 dark:text-neutral-400"
              onClick={() => {
                setShowsPolish((current) => !current)
              }}
            >
              {showsPolish ? 'Hide' : 'Show'} {counts.info} polish{' '}
              {counts.info === 1 ? 'note' : 'notes'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** One severity's count, dot and number, hidden entirely at zero. */
function SeverityCount({
  severity,
  count,
}: {
  severity: Severity
  count: number
}): React.JSX.Element | null {
  if (count === 0) {
    return null
  }
  return (
    <span className="flex items-center gap-1">
      <span className={`size-1.5 rounded-full ${DOT_CLASSES[severity]}`} />
      {count}
      <span className="sr-only">{severity}</span>
    </span>
  )
}
