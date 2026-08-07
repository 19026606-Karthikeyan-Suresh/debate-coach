/**
 * Renders any block's rows as labelled fields.
 *
 * Takes resolved fields rather than a block plus a spec list, so there is exactly one place
 * that decides what a block contains — `buildSections`. A table that rendered its own idea of
 * the field list could show a row the completeness meter was not counting.
 */

import type { Finding } from '../analysis/index.ts'
import type { FieldGroup } from '../case/sections.ts'
import { FieldEditor } from './FieldEditor.tsx'

/** No findings, shared so a clean field does not allocate an array per render. */
const NO_FINDINGS: readonly Finding[] = []

/** Props for {@link TemplateTable}. */
export interface TemplateTableProps {
  readonly group: FieldGroup
  /** Called with a field path and its new value on every keystroke. */
  readonly onChange: (path: string, value: string) => void
  /** Every field's findings, keyed by path. Fields with none are simply absent from it. */
  readonly findingsByPath: ReadonlyMap<string, readonly Finding[]>
  /** Rendered to the right of the group heading — delete buttons, branch pickers. */
  readonly controls?: React.ReactNode
  /** Paths to leave out, for fields the caller renders with a bespoke control. */
  readonly skipPaths?: readonly string[]
}

/**
 * Renders one group of fields.
 *
 * @param props - See {@link TemplateTableProps}.
 * @param props.group - The group to render.
 * @param props.onChange - Keystroke handler, called with a field path and its new value.
 * @param props.findingsByPath - Analyzer findings, keyed by field path.
 * @param props.controls - Structural controls for this group, shown beside its heading.
 * @param props.skipPaths - Fields the caller renders itself with a bespoke control.
 * @returns The group, or just its controls when every field was skipped.
 */
export function TemplateTable({
  group,
  onChange,
  findingsByPath,
  controls,
  skipPaths,
}: TemplateTableProps): React.JSX.Element {
  const fields = skipPaths
    ? group.fields.filter((field) => !skipPaths.includes(field.path))
    : group.fields

  return (
    <section className="flex flex-col gap-4">
      {(group.heading || controls) && (
        <div className="flex items-center justify-between gap-3">
          <h3 className="section-heading">{group.heading}</h3>
          {controls && <div className="flex items-center gap-1.5">{controls}</div>}
        </div>
      )}
      {fields.map((field) => (
        <FieldEditor
          key={field.path}
          field={field}
          onChange={onChange}
          findings={findingsByPath.get(field.path) ?? NO_FINDINGS}
        />
      ))}
    </section>
  )
}
