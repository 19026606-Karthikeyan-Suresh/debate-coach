import { useState } from 'react'

import { CaseEditor } from './components/CaseEditor.tsx'
import { IdentityGate } from './components/IdentityGate.tsx'
import { Library } from './components/Library.tsx'
import { SessionHistory } from './components/speech/SessionHistory.tsx'
import { SpeechView } from './components/speech/SpeechView.tsx'
import { useIdentity } from './hooks/useIdentity.ts'

/**
 * App shell.
 *
 * Four screens now: the library, Prep, Speak, and Review — the last of which only became worth
 * having once phase 6 gave it something to list.
 *
 * Deliberately not a router. A desktop shell has no URL to deep-link into, and the two case
 * screens are mutually exclusive: leaving Prep unmounts the editor, which flushes its pending
 * autosave before Speak compiles the case it is about to read.
 *
 * The identity check is above all four. It settles during render on the desktop, where nothing
 * has to be signed in to, and holds one frame where a case cannot exist without an account —
 * see {@link IdentityGate}.
 *
 * @returns Whichever screen is open.
 */
export function App(): React.JSX.Element {
  // Case id being worked on, or null for the library.
  const [openCaseId, setOpenCaseId] = useState<string | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isReviewing, setIsReviewing] = useState(false)
  const identity = useIdentity()

  if (identity.status !== 'ready') {
    return (
      <div className="app-surface h-full">
        <IdentityGate identity={identity} />
      </div>
    )
  }

  if (isReviewing) {
    return (
      <div className="app-surface h-full">
        <SessionHistory
          onClose={() => {
            setIsReviewing(false)
          }}
        />
      </div>
    )
  }

  if (openCaseId === null) {
    return (
      <div className="app-surface h-full">
        <Library
          identity={identity}
          onOpen={setOpenCaseId}
          onReview={() => {
            setIsReviewing(true)
          }}
        />
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
