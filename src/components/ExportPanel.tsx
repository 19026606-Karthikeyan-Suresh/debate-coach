/**
 * Getting a case off this machine: Word, `.dbcase`, or the printable speech sheet.
 *
 * Sits in the editor's right rail beside the meters rather than behind a menu, because the
 * moment someone wants this is the moment prep ends and everyone is closing laptops.
 */

import { useCallback, useState } from 'react'

import type { SpeakerRole } from '../formats/index.ts'
import { saveCaseDbcase, saveCaseDocx, saveSpeechSheetDocx } from '../export/index.ts'
import { buildSpeechSheet, type SpeechSheet } from '../export/speechSheet.ts'
import type { Case } from '../types/case.ts'
import { SpeechSheetView } from './SpeechSheetView.tsx'

/** Props for {@link ExportPanel}. */
export interface ExportPanelProps {
  readonly caseFile: Case
  /**
   * The seat being prepped, or undefined when the case's position does not resolve — after a
   * format switch, before reassignment. The two case exports still work; the speech sheet cannot,
   * because there is no seat to compile a speech for.
   */
  readonly role: SpeakerRole | undefined
}

/** What the last export did. Cancelling a dialog leaves this null — that is not an outcome. */
interface ExportMessage {
  readonly isError: boolean
  readonly text: string
}

/** Last path segment, so a rail 19rem wide does not have to show `C:\Users\…`. */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path
}

/**
 * Renders the export buttons and the speech-sheet overlay.
 *
 * @param props - See {@link ExportPanelProps}.
 * @param props.caseFile - The case to export. Read at the moment a button is pressed, so an
 *   export always contains what is on screen.
 * @param props.role - The seat, or undefined when it does not resolve.
 * @returns The panel.
 */
export function ExportPanel({ caseFile, role }: ExportPanelProps): React.JSX.Element {
  const [message, setMessage] = useState<ExportMessage | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  // A snapshot taken when the sheet opens. Non-null is what shows the overlay.
  const [sheet, setSheet] = useState<SpeechSheet | null>(null)

  const runExport = useCallback(
    async (save: () => Promise<string | null>): Promise<void> => {
      setIsBusy(true)
      setMessage(null)
      try {
        const path = await save()
        // Null is a cancelled dialog. Saying "cancelled" would be reporting the user's own
        // decision back to them as a result.
        setMessage(path === null ? null : { isError: false, text: `Saved ${fileNameOf(path)}` })
      } catch (exportError) {
        setMessage({
          isError: true,
          text: exportError instanceof Error ? exportError.message : String(exportError),
        })
      } finally {
        setIsBusy(false)
      }
    },
    [],
  )

  return (
    <div className="flex flex-col gap-1.5">
      <span className="section-heading">Export</span>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className="btn"
          disabled={isBusy}
          onClick={() => {
            void runExport(() => saveCaseDocx(caseFile))
          }}
        >
          Case (.docx)
        </button>
        <button
          type="button"
          className="btn"
          disabled={isBusy}
          onClick={() => {
            void runExport(() => saveCaseDbcase(caseFile))
          }}
        >
          Case (.dbcase)
        </button>
        <button
          type="button"
          className="btn"
          disabled={isBusy || !role}
          onClick={() => {
            if (role) {
              setSheet(buildSpeechSheet(caseFile, role))
            }
          }}
        >
          Speech sheet
        </button>
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {message ? (
          <span className={message.isError ? 'text-red-700 dark:text-red-400' : ''}>
            {message.text}
          </span>
        ) : (
          'The .docx is the whole template; .dbcase restores into another install.'
        )}
      </p>

      {sheet && role && (
        <SpeechSheetView
          sheet={sheet}
          onClose={() => {
            setSheet(null)
          }}
          onSaveDocx={() => {
            void runExport(() => saveSpeechSheetDocx(caseFile, role))
          }}
        />
      )}
    </div>
  )
}
