/**
 * One template row: the question, what a good answer does, the box, and what the analyzer
 * thinks of what is in it.
 *
 * Findings show twice on purpose. The underline says *which words*, which is the only thing the
 * depth panel cannot say; the line under the box says *what is wrong*, which an underline
 * cannot. Neither is redundant with the other.
 */

import { useRef } from 'react'

import { buildHighlightSegments } from '../analysis/highlight.ts'
import { findingKey } from '../analysis/index.ts'
import type { Finding, Severity } from '../analysis/index.ts'
import type { CaseField } from '../case/sections.ts'

/** Props for {@link FieldEditor}. */
export interface FieldEditorProps {
  /** The resolved field. Its `path` doubles as the DOM id, so the nav and depth panel can focus it. */
  readonly field: CaseField
  /** Called on every keystroke with the field's path and the raw value. Not debounced here. */
  readonly onChange: (path: string, value: string) => void
  /** Findings for this field only. An empty array is the normal case and renders nothing extra. */
  readonly findings: readonly Finding[]
}

/** Wavy-underline colour per severity. */
const MARK_CLASSES: Readonly<Record<Severity, string>> = {
  critical: 'depth-mark depth-mark-critical',
  warn: 'depth-mark depth-mark-warn',
  info: 'depth-mark depth-mark-info',
}

/** Message colour per severity, matching the underline. */
const NOTE_CLASSES: Readonly<Record<Severity, string>> = {
  critical: 'text-red-700 dark:text-red-400',
  warn: 'text-amber-700 dark:text-amber-500',
  info: 'text-neutral-500 dark:text-neutral-400',
}

/**
 * Renders one field.
 *
 * Single-line fields get an `<input>` and everything else a `<textarea>`, which matters for more
 * than looks: Enter inside a textarea should break a line, and inside the one-line slots (a
 * speaker position, a clash title) it should not. No rule fires on a one-line field, so only the
 * textarea branch carries the underline layer.
 *
 * @param props - See {@link FieldEditorProps}.
 * @param props.field - The resolved field to render.
 * @param props.onChange - Keystroke handler, called with the field's path and raw value.
 * @param props.findings - Findings for this field.
 * @returns The labelled control.
 */
export function FieldEditor({ field, onChange, findings }: FieldEditorProps): React.JSX.Element {
  // Kept in sync with the textarea's own scroll position, so the underlines stay under their
  // words once the text is taller than the box.
  const underlayRef = useRef<HTMLDivElement>(null)

  const isSingleLine = field.rows <= 1
  const shared = {
    id: field.path,
    value: field.value,
    onChange: (event: { target: { value: string } }) => {
      onChange(field.path, event.target.value)
    },
  }

  return (
    <div>
      <label className="field-label" htmlFor={field.path}>
        {field.label}
      </label>
      <span className="field-hint">{field.hint}</span>

      {isSingleLine ? (
        <input type="text" className="field-input" {...shared} />
      ) : (
        // The underlay is rendered whether or not anything is flagged. Adding it only when a
        // finding arrives would remount the textarea 350 ms into typing and take the caret
        // with it.
        <div className="field-stack">
          <div className="field-underlay" ref={underlayRef} aria-hidden="true">
            {buildHighlightSegments(field.value, findings).map((segment, segmentIndex) =>
              segment.severity ? (
                // Segments are a positional partition of the text, so the index is the identity.
                <mark key={segmentIndex} className={MARK_CLASSES[segment.severity]}>
                  {segment.text}
                </mark>
              ) : (
                <span key={segmentIndex}>{segment.text}</span>
              ),
            )}
          </div>
          <textarea
            className="field-input relative mt-0 bg-transparent"
            rows={field.rows}
            onScroll={(event) => {
              const underlay = underlayRef.current
              if (underlay) {
                underlay.scrollTop = event.currentTarget.scrollTop
              }
            }}
            {...shared}
          />
        </div>
      )}

      {findings.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {findings.map((finding) => (
            <li key={findingKey(finding)} className="text-xs leading-snug">
              <span className={NOTE_CLASSES[finding.severity]}>{finding.message}</span>{' '}
              <span className="text-neutral-500 dark:text-neutral-400">{finding.socraticPrompt}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
