/**
 * One template row: the question, what a good answer does, and the box.
 */

import type { CaseField } from '../case/sections.ts'

/** Props for {@link FieldEditor}. */
export interface FieldEditorProps {
  /** The resolved field. Its `path` doubles as the DOM id, so the nav can focus it. */
  readonly field: CaseField
  /** Called on every keystroke with the field's path and the raw value. Not debounced here. */
  readonly onChange: (path: string, value: string) => void
}

/**
 * Renders one field.
 *
 * Single-line fields get an `<input>` and everything else a `<textarea>`, which matters for
 * more than looks: Enter inside a textarea should break a line, and inside the one-line slots
 * (a speaker position, a clash title) it should not.
 *
 * @param props - See {@link FieldEditorProps}.
 * @param props.field - The resolved field to render.
 * @param props.onChange - Keystroke handler, called with the field's path and raw value.
 * @returns The labelled control.
 */
export function FieldEditor({ field, onChange }: FieldEditorProps): React.JSX.Element {
  const isSingleLine = field.rows <= 1
  const shared = {
    id: field.path,
    className: 'field-input',
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
        <input type="text" {...shared} />
      ) : (
        <textarea rows={field.rows} {...shared} />
      )}
    </div>
  )
}
