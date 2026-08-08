/**
 * The speech sheet on screen, and the same thing on paper.
 *
 * Portalled to `document.body` rather than rendered inside the editor's grid, for one reason:
 * printing. A print stylesheet that has to reach up through a three-column layout to hide
 * everything except one nested panel is a pile of `:not()` selectors that break the first time
 * the layout moves. As a sibling of `#root` it is one rule — see `@media print` in `styles.css`.
 */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { formatClock } from '../case/time.ts'
import type { SpeechSheet } from '../export/speechSheet.ts'

/** Props for {@link SpeechSheetView}. */
export interface SpeechSheetViewProps {
  readonly sheet: SpeechSheet
  /** Closes the sheet and returns to the editor. */
  readonly onClose: () => void
  /** Saves the sheet as a `.docx`. Exists because printing depends on the webview offering it. */
  readonly onSaveDocx: () => void
}

/**
 * Renders the compiled speech as a printable page.
 *
 * @param props - See {@link SpeechSheetViewProps}.
 * @param props.sheet - The sheet to show.
 * @param props.onClose - Closes the sheet.
 * @param props.onSaveDocx - Saves it as a Word document.
 * @returns The sheet, portalled outside the app's own tree.
 */
export function SpeechSheetView({
  sheet,
  onClose,
  onSaveDocx,
}: SpeechSheetViewProps): React.JSX.Element {
  // Marks the app behind this as hidden *when printing only*. Removed on unmount so a print
  // started after the sheet is closed still prints the app.
  useEffect(() => {
    document.body.classList.add('sheet-open')
    return () => {
      document.body.classList.remove('sheet-open')
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const length = `${String(sheet.wordCount)} words · about ${formatClock(sheet.estimatedSeconds)} of ${formatClock(sheet.speechSeconds)}`

  return createPortal(
    <div className="print-root fixed inset-0 z-50 overflow-y-auto bg-white text-neutral-900">
      <div className="no-print sticky top-0 flex items-center gap-2 border-b border-neutral-200 bg-white/95 px-6 py-3">
        <button type="button" className="btn" onClick={onClose}>
          ← Back
        </button>
        <span className="text-sm text-neutral-500">Speech sheet</span>
        <div className="ml-auto flex gap-2">
          <button type="button" className="btn" onClick={onSaveDocx}>
            Save as .docx
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              window.print()
            }}
          >
            Print / PDF
          </button>
        </div>
      </div>

      <article className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-2xl leading-tight font-semibold">{sheet.motion}</h1>
        <p className="mt-1 text-sm text-neutral-500">{sheet.meta}</p>
        <p className={`text-sm ${sheet.isOverLength ? 'text-red-700' : 'text-neutral-500'}`}>
          {length}
          {sheet.isOverLength ? ' — over the slot' : ''}
        </p>

        {sheet.sections.length === 0 && (
          <p className="mt-6 text-sm text-neutral-600">
            Nothing compiles yet. Every line this speech needs is still empty — see the list
            below.
          </p>
        )}

        {sheet.sections.map((section) => (
          <section key={section.id} className="mt-6">
            <h2 className="sheet-heading text-xs font-semibold tracking-widest text-neutral-500 uppercase">
              {section.heading}
            </h2>
            {section.paragraphs.map((text, index) => (
              <p
                // Two segments under one heading can hold identical text — an engagement whose
                // fields repeat across clashes — so the index is the only key that separates
                // them. Nothing reorders inside a section, so it is stable in practice.
                key={`${section.id}-${String(index)}`}
                className="sheet-paragraph mt-2 leading-relaxed"
              >
                {text}
              </p>
            ))}
          </section>
        ))}

        {sheet.gaps.length > 0 && (
          <section className="mt-10 border-t border-neutral-300 pt-4">
            <h2 className="sheet-heading text-xs font-semibold tracking-widest text-neutral-500 uppercase">
              Lines you cannot say yet ({sheet.gaps.length})
            </h2>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {sheet.gaps.map((gap) => (
                <li key={gap.fieldPath} className="leading-snug">
                  {gap.label}
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
    </div>,
    document.body,
  )
}
