import { useState } from 'react'

import { CaseEditor } from './components/CaseEditor.tsx'
import { Library } from './components/Library.tsx'

/**
 * App shell.
 *
 * Two screens for now: the library and the Prep screen. The mockup's Speak and Review screens
 * arrive with the whisper sidecar in phase 5 — there is nothing to show on either until a
 * script can be compiled, so neither is stubbed here.
 *
 * @returns Whichever screen is open.
 */
export function App(): React.JSX.Element {
  // Case id being edited, or null for the library. Deliberately not a router: there is no
  // URL to deep-link into in a desktop shell, and a second screen does not need one.
  const [openCaseId, setOpenCaseId] = useState<string | null>(null)

  return (
    <div className="app-surface h-full">
      {openCaseId === null ? (
        <Library onOpen={setOpenCaseId} />
      ) : (
        <CaseEditor
          caseId={openCaseId}
          onClose={() => {
            setOpenCaseId(null)
          }}
        />
      )}
    </div>
  )
}
