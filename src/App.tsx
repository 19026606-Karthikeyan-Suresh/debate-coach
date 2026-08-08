import { useState } from 'react'

import { CaseEditor } from './components/CaseEditor.tsx'
import { Library } from './components/Library.tsx'
import { SpeechView } from './components/speech/SpeechView.tsx'

/**
 * App shell.
 *
 * Three screens, matching the mockup: the library, Prep, and Speak. Review arrives with the
 * report in phase 6 — there is nothing to review until a session has been stored.
 *
 * Deliberately not a router. A desktop shell has no URL to deep-link into, and the two case
 * screens are mutually exclusive: leaving Prep unmounts the editor, which flushes its pending
 * autosave before Speak compiles the case it is about to read.
 *
 * @returns Whichever screen is open.
 */
export function App(): React.JSX.Element {
  // Case id being worked on, or null for the library.
  const [openCaseId, setOpenCaseId] = useState<string | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)

  if (openCaseId === null) {
    return (
      <div className="app-surface h-full">
        <Library onOpen={setOpenCaseId} />
      </div>
    )
  }

  return (
    <div className="app-surface h-full">
      {isSpeaking ? (
        <SpeechView
          caseId={openCaseId}
          onClose={() => {
            setIsSpeaking(false)
          }}
        />
      ) : (
        <CaseEditor
          caseId={openCaseId}
          onClose={() => {
            setOpenCaseId(null)
          }}
          onSpeak={() => {
            setIsSpeaking(true)
          }}
        />
      )}
    </div>
  )
}
