/**
 * Format and speaking position for a case.
 *
 * The seat decides which parts of the template this case even shows, so it sits at the top of
 * the right rail rather than buried in a settings screen — changing it is a normal thing to do
 * when a team swaps positions during prep.
 */

import type { FormatId, Side } from '../formats/index.ts'
import { FORMATS, getFormat } from '../formats/index.ts'
import type { Case } from '../types/case.ts'

/** Props for {@link SeatPicker}. */
export interface SeatPickerProps {
  readonly caseFile: Case
  /** Called with the whole seat at once, since a role id is only meaningful with its format. */
  readonly onChange: (format: FormatId, side: Side, position: string) => void
}

/**
 * Renders the format and position selectors.
 *
 * Switching format reassigns the position to that format's first role rather than leaving a
 * stale id, because an AP role id on a BP case resolves to nothing and the editor would have
 * no sections to show.
 *
 * @param props - See {@link SeatPickerProps}.
 * @param props.caseFile - Supplies the current seat.
 * @param props.onChange - Called with the whole new seat.
 * @returns The picker.
 */
export function SeatPicker({ caseFile, onChange }: SeatPickerProps): React.JSX.Element {
  const format = getFormat(caseFile.format)

  return (
    <div className="flex flex-col gap-2">
      <span className="section-heading">Seat</span>

      <select
        className="field-input mt-0"
        aria-label="Format"
        value={caseFile.format}
        onChange={(event) => {
          const nextFormat = event.target.value as FormatId
          const firstRole = getFormat(nextFormat).roles[0]
          onChange(nextFormat, firstRole?.side ?? caseFile.side, firstRole?.id ?? '')
        }}
      >
        {Object.values(FORMATS).map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>

      <select
        className="field-input mt-0"
        aria-label="Speaking position"
        value={caseFile.position}
        onChange={(event) => {
          const nextRole = format.roles.find((option) => option.id === event.target.value)
          if (nextRole) {
            onChange(caseFile.format, nextRole.side, nextRole.id)
          }
        }}
      >
        {format.roles.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
