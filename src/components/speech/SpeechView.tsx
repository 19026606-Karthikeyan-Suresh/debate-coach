/**
 * The Speak screen.
 *
 * Everything on it is derived: the script is compiled from the case, the clock comes from the
 * format, and the colours come from the aligner. Nothing here is authored content, which is the
 * whole payoff of the compiler landing before the speech UI — this screen is a view over three
 * pure modules and a microphone.
 *
 * The one editorial decision it makes is what to show **before** the record button is pressed:
 * the script's length against the clock, and the lines that cannot be said yet because a field
 * is blank. Those are the two things worth knowing while there is still time to fix them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { getFormat, getRole } from '../../formats/index.ts'
import { formatClock } from '../../case/time.ts'
import { useCaseStore } from '../../hooks/useCaseStore.ts'
import { useSpeechSession } from '../../hooks/useSpeechSession.ts'
import { useSpeechTimer } from '../../hooks/useSpeechTimer.ts'
import { compileScript } from '../../script/compile.ts'
import type { CompiledScript } from '../../script/types.ts'
import type { SpeechLimits } from '../../speech/timer.ts'
import { buildSpeechLimits, scriptHeadroom } from '../../speech/timer.ts'
import { LiveTranscript } from './LiveTranscript.tsx'
import { SpeechTimer } from './SpeechTimer.tsx'
import { Teleprompter } from './Teleprompter.tsx'

/** Props for {@link SpeechView}. */
export interface SpeechViewProps {
  readonly caseId: string
  /** Back to the Prep screen. */
  readonly onClose: () => void
}

/**
 * Runs one speech against one case.
 *
 * @param props - See {@link SpeechViewProps}.
 * @param props.caseId - Case to deliver. Loaded read-only; nothing on this screen edits it.
 * @param props.onClose - Returns to Prep. Stopping the recording first is this screen's job,
 *   not the caller's.
 * @returns The Speak screen.
 */
export function SpeechView({ caseId, onClose }: SpeechViewProps): React.JSX.Element {
  // A reply is a different speech with a different clock, so it is chosen before standing up
  // rather than inferred. Ignored for seats that cannot give one.
  const [isReply, setIsReply] = useState(false)

  // Names the WAV. Generated once per screen; phase 6 writes the matching `sessions` row.
  const [sessionId] = useState(() => crypto.randomUUID())

  const store = useCaseStore(caseId)
  const { caseFile } = store
  const format = caseFile ? getFormat(caseFile.format) : null
  const role = caseFile ? getRole(caseFile.format, caseFile.position) : undefined

  const script = useMemo(
    () => (caseFile && role ? compileScript(caseFile, role) : null),
    [caseFile, role],
  )

  // Both memoized because the hooks below depend on their identity: a new array every render
  // would reset the alignment, and a new limits object would restart the timer's interval.
  const scriptWords = useMemo(
    () => script?.tokens.map((token) => token.text) ?? [],
    [script],
  )
  const limits = useMemo(
    () => (format && role ? buildSpeechLimits(format, role, isReply) : null),
    [format, role, isReply],
  )

  return limits && script ? (
    <SpeechStage
      script={script}
      scriptWords={scriptWords}
      limits={limits}
      sessionId={sessionId}
      isReply={isReply}
      canGiveReply={role?.canGiveReply === true && format?.replySeconds !== null}
      onReplyChange={setIsReply}
      onClose={onClose}
    />
  ) : (
    <div className="flex h-full flex-col items-start gap-3 p-8">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        {store.status === 'loading'
          ? 'Opening case…'
          : (store.error ?? 'Pick a speaking position before delivering this case.')}
      </p>
      <button type="button" className="btn" onClick={onClose}>
        ← Prep
      </button>
    </div>
  )
}

/** Everything below needs a script and a clock, so it is split out rather than guarded inline. */
function SpeechStage({
  script,
  scriptWords,
  limits,
  sessionId,
  isReply,
  canGiveReply,
  onReplyChange,
  onClose,
}: {
  script: CompiledScript
  scriptWords: readonly string[]
  limits: SpeechLimits
  sessionId: string
  isReply: boolean
  canGiveReply: boolean
  onReplyChange: (isReply: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const timer = useSpeechTimer(limits)
  const session = useSpeechSession(scriptWords, sessionId)

  const isLive = session.status === 'recording' || session.status === 'stopping'
  const headroom = scriptHeadroom(script.estimatedSeconds, limits)

  // The clock and the microphone start together and stop together. Two buttons for one action
  // is two chances to stand up with the timer running and nothing recording.
  const toggle = useCallback((): void => {
    if (isLive) {
      session.stop()
      timer.stop()
    } else {
      timer.reset()
      session.start()
      timer.start()
    }
  }, [isLive, session, timer])

  // Space is the only key a hand on the desk can find without looking, and the teleprompter has
  // no text input to steal it. Bound on the window so it works wherever focus happens to be.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat) {
        return
      }
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [toggle])

  return (
    <div className="grid h-full grid-cols-[1fr_20rem] overflow-hidden">
      <main className="relative overflow-y-auto">
        <Teleprompter script={script} alignment={session.alignment} isLive={isLive} />
      </main>

      <aside className="flex flex-col gap-5 overflow-y-auto border-l border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex gap-1.5">
          <button type="button" className="btn" onClick={onClose} disabled={isLive}>
            ← Prep
          </button>
          <button
            type="button"
            className={`btn flex-1 justify-center ${isLive ? 'btn-danger' : 'btn-primary'}`}
            onClick={toggle}
            disabled={session.status === 'starting' || session.status === 'stopping'}
          >
            {session.status === 'starting'
              ? 'Opening mic…'
              : session.status === 'stopping'
                ? 'Finishing…'
                : isLive
                  ? 'Stop'
                  : 'Record'}
          </button>
        </div>

        <SpeechTimer clock={timer.clock} lastSignal={timer.lastSignal} isRunning={timer.isRunning} />

        {canGiveReply ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isReply}
              disabled={isLive}
              onChange={(event) => {
                onReplyChange(event.target.checked)
              }}
            />
            Reply speech
          </label>
        ) : null}

        {/* Length against the clock, before the microphone opens. The one number worth acting
            on while there is still time to cut a line. */}
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between">
            <span className="section-heading">Script</span>
            <span className="tabular-nums">
              {script.wordCount} words · {formatClock(script.estimatedSeconds)}
            </span>
          </div>
          <p
            className={
              headroom < 0
                ? 'text-xs text-red-700 dark:text-red-400'
                : 'text-xs text-neutral-500 dark:text-neutral-400'
            }
          >
            {headroom < 0
              ? `${formatClock(-headroom)} longer than the speech. Cut something.`
              : `${formatClock(headroom)} spare, before points of information.`}
          </p>
        </div>

        {script.gaps.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="section-heading">Cannot say yet</span>
            <ul className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
              {script.gaps.slice(0, 6).map((gap) => (
                <li key={gap.fieldPath}>{gap.label}</li>
              ))}
            </ul>
            {script.gaps.length > 6 ? (
              <span className="text-xs text-neutral-400 dark:text-neutral-500">
                and {script.gaps.length - 6} more.
              </span>
            ) : null}
          </div>
        ) : null}

        <LiveTranscript
          transcript={session.transcript}
          alignment={session.alignment}
          audioSeconds={session.audioSeconds}
          elapsedSeconds={timer.clock.elapsedSeconds}
        />

        {session.fallbackReason ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Using {session.sourceLabel}: {session.fallbackReason} Nothing is being recorded, so
            there is no accurate re-pass afterwards.
          </p>
        ) : session.sourceLabel ? (
          <p className="text-xs text-neutral-400 dark:text-neutral-500">{session.sourceLabel}</p>
        ) : null}

        {session.error ? (
          <p className="text-xs text-red-700 dark:text-red-400">{session.error}</p>
        ) : null}

        {session.recording ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Recorded {formatClock(session.recording.durationSeconds)}. The report lands in phase 6.
          </p>
        ) : null}

        <p className="mt-auto text-xs text-neutral-400 dark:text-neutral-500">
          Space starts and stops the speech.
        </p>
      </aside>
    </div>
  )
}
