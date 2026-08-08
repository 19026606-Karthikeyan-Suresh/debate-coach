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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getFormat, getRole } from '../../formats/index.ts'
import type { SpeakerRole } from '../../formats/index.ts'
import { buildSections, flattenFields } from '../../case/sections.ts'
import { formatClock } from '../../case/time.ts'
import { setFieldByPath } from '../../case/update.ts'
import { useCaseStore } from '../../hooks/useCaseStore.ts'
import { useSpeechReview } from '../../hooks/useSpeechReview.ts'
import { useSpeechSession } from '../../hooks/useSpeechSession.ts'
import { useSpeechTimer } from '../../hooks/useSpeechTimer.ts'
import { compileScript } from '../../script/compile.ts'
import type { CompiledScript } from '../../script/types.ts'
import type { SpeechLimits } from '../../speech/timer.ts'
import { buildSpeechLimits, scriptHeadroom } from '../../speech/timer.ts'
import type { Case } from '../../types/case.ts'
import { LiveTranscript } from './LiveTranscript.tsx'
import { SpeechReport } from './SpeechReport.tsx'
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

  return limits && script && caseFile && role ? (
    <SpeechStage
      caseFile={caseFile}
      role={role}
      script={script}
      scriptWords={scriptWords}
      limits={limits}
      isReply={isReply}
      canGiveReply={role.canGiveReply && format?.replySeconds !== null}
      onReplyChange={setIsReply}
      onUpdateCase={store.update}
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
  caseFile,
  role,
  script,
  scriptWords,
  limits,
  isReply,
  canGiveReply,
  onReplyChange,
  onUpdateCase,
  onClose,
}: {
  caseFile: Case
  role: SpeakerRole
  script: CompiledScript
  scriptWords: readonly string[]
  limits: SpeechLimits
  isReply: boolean
  canGiveReply: boolean
  onReplyChange: (isReply: boolean) => void
  onUpdateCase: (mutate: (current: Case) => Case) => void
  onClose: () => void
}): React.JSX.Element {
  const timer = useSpeechTimer(limits)
  const session = useSpeechSession(scriptWords)
  const review = useSpeechReview()

  // False while the report is up, so the speaker can read the script back without losing it.
  const [isShowingScript, setIsShowingScript] = useState(true)

  const isLive = session.status === 'recording' || session.status === 'stopping'
  const headroom = scriptHeadroom(script.estimatedSeconds, limits)

  // Row labels by path, copied into the report so it can still name a row after the case has been
  // rewritten — which it will have been, by the time anyone opens the report from the library.
  const fieldLabels = useMemo(() => {
    const labels: Record<string, string> = {}
    for (const field of flattenFields(buildSections(caseFile, role))) {
      labels[field.path] = field.label
    }
    return labels
  }, [caseFile, role])

  // The clock and the microphone start together and stop together. Two buttons for one action
  // is two chances to stand up with the timer running and nothing recording.
  const toggle = useCallback((): void => {
    if (isLive) {
      session.stop()
      timer.stop()
    } else {
      review.clear()
      setIsShowingScript(true)
      timer.reset()
      session.start()
      timer.start()
    }
  }, [isLive, review, session, timer])

  // The speech that has already been sent for review, so a re-render cannot send it twice.
  const reviewedSessionRef = useRef<string | null>(null)

  // Reads this render's transcript and alignment rather than a callback's captured ones: by the
  // time the component renders with `finished`, the final flush's transcript has been committed
  // too, and a callback fired from inside `stop`'s promise would still be holding the old one.
  useEffect(() => {
    if (session.status !== 'finished' || session.sessionId === null) {
      return
    }
    if (reviewedSessionRef.current === session.sessionId) {
      return
    }
    reviewedSessionRef.current = session.sessionId

    review.begin({
      sessionId: session.sessionId,
      caseId: caseFile.id,
      motion: caseFile.prep.motion,
      format: caseFile.format,
      roleId: role.id,
      roleLabel: role.label,
      isReply,
      script,
      fieldLabels,
      alignment: session.alignment,
      transcript: session.transcript,
      recording: session.recording,
      source: session.sourceId ?? 'web-speech',
      // The recording is the honest length; the clock keeps running while the mic is closing.
      deliveredSeconds: session.recording?.durationSeconds ?? timer.clock.elapsedSeconds,
    })
    setIsShowingScript(false)
  }, [session, review, caseFile, role, isReply, script, fieldLabels, timer.clock.elapsedSeconds])

  // Appends an improvised run to the row it was heard in. Appended rather than replacing, because
  // the row already holds something the debater wrote and this is an addition to it.
  const saveToField = useCallback(
    (fieldPath: string, text: string): void => {
      onUpdateCase((current) => {
        const existing =
          flattenFields(buildSections(current, role)).find((field) => field.path === fieldPath)
            ?.value ?? ''
        return setFieldByPath(current, fieldPath, existing.trim() ? `${existing.trim()} ${text}` : text)
      })
    },
    [onUpdateCase, role],
  )

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

  const canShowReport = review.report !== null

  return (
    <div className="grid h-full grid-cols-[1fr_20rem] overflow-hidden">
      <main className="relative overflow-y-auto">
        {canShowReport && !isShowingScript && review.report ? (
          <SpeechReport
            report={review.report}
            isReviewing={review.status === 'reviewing'}
            error={review.error}
            onSaveToField={saveToField}
          />
        ) : (
          <Teleprompter script={script} alignment={session.alignment} isLive={isLive} />
        )}
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

        {canShowReport ? (
          <button
            type="button"
            className="btn justify-center"
            onClick={() => {
              setIsShowingScript((current) => !current)
            }}
          >
            {isShowingScript ? 'Show the report' : 'Back to the script'}
          </button>
        ) : null}

        {review.status === 'building' ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Building the report…</p>
        ) : review.status === 'reviewing' ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Re-transcribing with small.en. The report is up now and its numbers will change when
            this lands.
          </p>
        ) : null}

        {review.error !== null ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">{review.error}</p>
        ) : null}

        <p className="mt-auto text-xs text-neutral-400 dark:text-neutral-500">
          Space starts and stops the speech.
        </p>
      </aside>
    </div>
  )
}
