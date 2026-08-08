/**
 * Layer B in the right rail, under the depth panel it deliberately does not replace.
 *
 * Three states, and the first one is the default: **no key**. Everything above this panel works
 * without one and keeps working if the network dies mid-prep, so the empty state says what the
 * feature adds rather than nagging for a key.
 *
 * Nothing here writes to the case on its own. An attack becomes a `Preempt` and a POI becomes a
 * row in the template's list only when the debater presses the button beside it — the same rule
 * phase 6 settled for improvisations, and for the same reason: a guess does not get to edit a
 * case unasked.
 */

import { useState } from 'react'

import { AXIS_SCORE_LABELS, DEPTH_AXIS_DESCRIPTIONS, DEPTH_AXIS_LABELS } from '../coach/index.ts'
import type {
  AttackResult,
  AuditResult,
  AxisScore,
  CoachOutcome,
  DepthAxis,
  PoiResult,
} from '../coach/index.ts'
import type { SpeakerRole } from '../formats/index.ts'
import { addPointOfInformation, addPreempt } from '../case/update.ts'
import type { CoachController } from '../hooks/useCoach.ts'
import type { Case } from '../types/case.ts'

/** Props for {@link CoachPanel}. */
export interface CoachPanelProps {
  readonly caseFile: Case
  readonly role: SpeakerRole
  /**
   * The section open in the editor. `audit` and `attack` act on whichever substantive it is, so
   * they are disabled on every other section rather than silently picking one.
   */
  readonly activeSectionId: string
  readonly coach: CoachController
  /** Applies an edit against the newest document. */
  readonly update: (mutate: (current: Case) => Case) => void
}

/** Id of the substantive the open section belongs to, or null when it is not one. */
function openSubstantiveId(activeSectionId: string): string | null {
  return activeSectionId.startsWith('substantives.')
    ? (activeSectionId.split('.')[1] ?? null)
    : null
}

/**
 * Renders the coach panel.
 *
 * @param props - See {@link CoachPanelProps}.
 * @param props.caseFile - The case being prepped.
 * @param props.role - The seat, which decides how much of the case a call sees.
 * @param props.activeSectionId - The open section, which decides what `audit` and `attack` act on.
 * @param props.coach - State and callbacks from `useCoach`.
 * @param props.update - Applies an edit against the newest document.
 * @returns The panel.
 */
export function CoachPanel({
  caseFile,
  role,
  activeSectionId,
  coach,
  update,
}: CoachPanelProps): React.JSX.Element {
  const { status, run } = coach
  const substantiveId = openSubstantiveId(activeSectionId)
  const isBusy = run.phase === 'running'

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="section-heading">Coach</span>
        <span className="truncate text-xs text-neutral-400 dark:text-neutral-500">
          {status?.model ?? ''}
        </span>
      </div>

      {status === null ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">Checking…</p>
      ) : status.hasKey ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="btn"
              disabled={isBusy || substantiveId === null}
              onClick={() => {
                if (substantiveId) {
                  coach.audit(caseFile, role, substantiveId)
                }
              }}
            >
              Audit sub
            </button>
            <button
              type="button"
              className="btn"
              disabled={isBusy || substantiveId === null}
              onClick={() => {
                if (substantiveId) {
                  coach.attack(caseFile, role, substantiveId)
                }
              }}
            >
              Find attacks
            </button>
            <button
              type="button"
              className="btn"
              disabled={isBusy}
              onClick={() => {
                coach.pois(caseFile, role)
              }}
            >
              Predict POIs
            </button>
          </div>

          {substantiveId === null && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Open a substantive to audit or attack one.
            </p>
          )}

          <RunView coach={coach} caseFile={caseFile} update={update} />

          <KeyFooter coach={coach} backend={status.backend} persistent={status.persistent} />
        </>
      ) : (
        <KeyForm coach={coach} storeError={status.error} backend={status.backend} />
      )}
    </div>
  )
}

/** Whatever the last call left behind: a spinner, a message, or a result. */
function RunView({
  coach,
  caseFile,
  update,
}: {
  coach: CoachController
  caseFile: Case
  update: (mutate: (current: Case) => Case) => void
}): React.JSX.Element | null {
  const { run } = coach

  if (run.phase === 'running') {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Thinking. High effort takes a while — the prep clock keeps running.
      </p>
    )
  }

  if (run.phase === 'error') {
    return (
      <div className="flex flex-col items-start gap-1">
        <p className="text-xs text-red-700 dark:text-red-400">{run.message}</p>
        <button type="button" className="btn" onClick={coach.dismiss}>
          Dismiss
        </button>
      </div>
    )
  }

  if (run.phase !== 'done' || !run.outcome) {
    return null
  }

  const { outcome } = run
  return (
    <div className="flex flex-col gap-2">
      {outcome.result.kind === 'audit' && <AuditView result={outcome.result} />}
      {outcome.result.kind === 'attack' && (
        <AttackView
          result={outcome.result}
          caseFile={caseFile}
          substantiveId={run.subjectId}
          update={update}
        />
      )}
      {outcome.result.kind === 'poi' && <PoiView result={outcome.result} caseFile={caseFile} update={update} />}

      <Rejections outcome={outcome} />

      <div className="flex items-baseline justify-between gap-2">
        <button
          type="button"
          className="text-xs text-neutral-500 underline underline-offset-2 dark:text-neutral-400"
          onClick={coach.dismiss}
        >
          Clear
        </button>
        <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
          {outcome.inputTokens} in / {outcome.outputTokens} out
        </span>
      </div>
    </div>
  )
}

/** Five axes, scored, each with the question a judge would ask. */
function AuditView({ result }: { result: AuditResult }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {result.axes.map((verdict) => (
        <div key={verdict.axis} className="flex flex-col gap-0.5">
          <span className="flex items-center justify-between gap-2 text-xs font-semibold">
            <span
              className={
                verdict.axis === result.sharpest
                  ? 'text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-600 dark:text-neutral-300'
              }
            >
              {DEPTH_AXIS_LABELS[verdict.axis]}
              {verdict.axis === result.sharpest && ' — start here'}
            </span>
            <ScorePips score={verdict.score} axis={verdict.axis} />
          </span>
          <p className="text-xs leading-snug text-neutral-700 dark:text-neutral-200">
            {verdict.question}
          </p>
        </div>
      ))}
    </div>
  )
}

/**
 * A score as three pips, deliberately in the same neutral as everything else.
 *
 * Red on a 0 would say the row is wrong. It is not — a substantive with no evidence row written
 * four minutes into prep is a substantive four minutes into prep, and the meter above already
 * counts what is blank. The pips encode how far it got and nothing more; the word is in the
 * tooltip beside what the axis means.
 */
function ScorePips({ score, axis }: { score: AxisScore; axis: DepthAxis }): React.JSX.Element {
  return (
    <span
      className="flex shrink-0 items-center gap-0.5"
      title={`${AXIS_SCORE_LABELS[score]} — ${DEPTH_AXIS_DESCRIPTIONS[axis]}`}
    >
      <span className="sr-only">{AXIS_SCORE_LABELS[score]}</span>
      {[1, 2, 3].map((pip) => (
        <span
          key={pip}
          aria-hidden="true"
          className={`size-1.5 rounded-full ${
            pip <= score
              ? 'bg-neutral-700 dark:bg-neutral-200'
              : 'bg-neutral-200 dark:bg-neutral-700'
          }`}
        />
      ))}
    </span>
  )
}

/** The opposition's lines, each with the button that turns it into a preempt. */
function AttackView({
  result,
  caseFile,
  substantiveId,
  update,
}: {
  result: AttackResult
  caseFile: Case
  substantiveId: string | null
  update: (mutate: (current: Case) => Case) => void
}): React.JSX.Element {
  // The substantive the call was *about*, not the one open now — a reply takes long enough to
  // read another section while it lands.
  const owner = caseFile.substantives.find((item) => item.id === substantiveId)

  return (
    <div className="flex flex-col gap-2">
      {result.attacks.map((line) => {
        const alreadyAdded = owner?.preempts.some((preempt) => preempt.attack === line.attack)
        return (
          <div key={line.attack} className="flex flex-col gap-1">
            <p className="text-xs leading-snug text-neutral-800 dark:text-neutral-100">
              {line.attack}
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                {DEPTH_AXIS_LABELS[line.targets]}
              </span>
              <button
                type="button"
                className="btn"
                disabled={!owner || alreadyAdded}
                onClick={() => {
                  if (owner) {
                    update((current) => addPreempt(current, owner.id, line.attack, 'claude'))
                  }
                }}
              >
                {alreadyAdded ? 'Added' : 'Add to sub'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Predicted POIs, each with the button that files it in the template's list.
 *
 * "Added" is read off the case rather than remembered here. Local state would survive into the
 * next run and mark a question added that this run never filed, and it would also fail to notice
 * the debater deleting the POI again from the prep sheet.
 */
function PoiView({
  result,
  caseFile,
  update,
}: {
  result: PoiResult
  caseFile: Case
  update: (mutate: (current: Case) => Case) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {result.questions.map((question) => {
        const alreadyAdded = caseFile.prep.pois.some((poi) => poi.text === question)
        return (
          <div key={question} className="flex flex-col gap-1">
            <p className="text-xs leading-snug text-neutral-800 dark:text-neutral-100">{question}</p>
            <button
              type="button"
              className="btn self-start"
              disabled={alreadyAdded}
              onClick={() => {
                update((current) => addPointOfInformation(current, question))
              }}
            >
              {alreadyAdded ? 'Added' : 'Add to POI list'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * What the Socratic guard threw away.
 *
 * Shown rather than swallowed: a guard that silently deletes two of three attacks looks exactly
 * like a model that only had one to offer, and the difference is the whole reason to trust
 * anything above it.
 */
function Rejections({ outcome }: { outcome: CoachOutcome }): React.JSX.Element | null {
  if (outcome.rejected.length === 0) {
    return null
  }
  return (
    <p className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">
      {outcome.rejected.length} discarded for coaching rather than asking:{' '}
      {[...new Set(outcome.rejected.map((rejection) => rejection.reason))].join(', ')}.
    </p>
  )
}

/** The empty state: what Layer B adds, and the box for the key that switches it on. */
function KeyForm({
  coach,
  storeError,
  backend,
}: {
  coach: CoachController
  storeError: string | null
  backend: string
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">
        Off. The depth panel above runs offline and always will; Claude adds the question a judge
        would ask, the attacks the other bench is preparing, and the POIs coming your way.
      </p>
      <input
        type="password"
        className="field-input"
        placeholder="Anthropic API key"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
      />
      <button
        type="button"
        className="btn btn-primary self-start"
        disabled={draft.trim().length === 0}
        onClick={() => {
          coach.saveKey(draft).then(
            () => {
              setDraft('')
              setFailure(null)
            },
            (error: unknown) => {
              setFailure(typeof error === 'string' ? error : 'Could not save the key.')
            },
          )
        }}
      >
        Save key
      </button>
      <p className="text-xs text-neutral-400 dark:text-neutral-500">
        Kept in the {backend}. It never reaches this window again — requests are made from the
        Rust side.
      </p>
      {failure && <p className="text-xs text-red-700 dark:text-red-400">{failure}</p>}
      {storeError && <p className="text-xs text-red-700 dark:text-red-400">{storeError}</p>}
    </div>
  )
}

/** Where the key lives, and the way back out. */
function KeyFooter({
  coach,
  backend,
  persistent,
}: {
  coach: CoachController
  backend: string
  persistent: boolean
}): React.JSX.Element {
  return (
    <p className="text-xs text-neutral-400 dark:text-neutral-500">
      Key in the {backend}
      {!persistent && ' — this build has no persistent store, so it is forgotten on quit'}.{' '}
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => {
          void coach.forgetKey()
        }}
      >
        Remove
      </button>
    </p>
  )
}
