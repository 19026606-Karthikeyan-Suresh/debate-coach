/**
 * Anticipated attacks on one substantive, and the debater's answers to them.
 *
 * Sits under the nine template rows rather than among them, because it is not one of them: the
 * docx has no preempt table, these rows are not counted by the completeness meter, and no
 * analyzer rule fires on them. What they are is the payoff for `attack` — an opposition line
 * written out in the other bench's voice, with an empty box beside it that only the debater can
 * fill.
 *
 * Both boxes are editable, including on an attack Claude wrote. A predicted attack that is
 * slightly wrong is still worth keeping once it is reworded, and locking it would mean deleting
 * and retyping instead.
 */

import type { Substantive } from '../types/case.ts'

/** Props for {@link PreemptList}. */
export interface PreemptListProps {
  readonly substantive: Substantive
  /** Called with a field path and the raw value, exactly like the template rows. */
  readonly onChange: (path: string, value: string) => void
  /** Appends an empty attack for the debater to write themselves. */
  readonly onAdd: () => void
  /** Drops one attack. */
  readonly onRemove: (preemptId: string) => void
}

/**
 * Renders a substantive's preempts.
 *
 * @param props - See {@link PreemptListProps}.
 * @param props.substantive - The substantive whose preempts these are.
 * @param props.onChange - Keystroke handler, called with a field path and the raw value.
 * @param props.onAdd - Appends an empty attack.
 * @param props.onRemove - Drops one attack.
 * @returns The preempt block.
 */
export function PreemptList({
  substantive,
  onChange,
  onAdd,
  onRemove,
}: PreemptListProps): React.JSX.Element {
  const unanswered = substantive.preempts.filter(
    (preempt) => preempt.response.trim().length === 0,
  ).length

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <span className="section-heading">Anticipated attacks</span>
          <p className="field-hint mt-0.5">
            Not part of the template. Nothing here is counted by the meter — an attack is only
            worth having once you have answered it.
          </p>
        </div>
        {unanswered > 0 && (
          <span className="shrink-0 text-xs text-amber-700 dark:text-amber-500">
            {unanswered} unanswered
          </span>
        )}
      </div>

      {substantive.preempts.length === 0 ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Nothing here yet. Write one, or ask the coach for the three the other bench is most
          likely to run.
        </p>
      ) : (
        substantive.preempts.map((preempt, index) => {
          const base = `substantives.${substantive.id}.preempts.${preempt.id}`
          return (
            <div
              key={preempt.id}
              className="flex flex-col gap-2 border-l-2 border-neutral-200 pl-3 dark:border-neutral-700"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="field-label">
                  Attack {index + 1}
                  {preempt.source === 'claude' && (
                    <span className="ml-1.5 rounded bg-neutral-200 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                      Claude
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-danger shrink-0"
                  onClick={() => {
                    onRemove(preempt.id)
                  }}
                >
                  Remove
                </button>
              </div>

              <textarea
                id={`${base}.attack`}
                className="field-input"
                rows={2}
                value={preempt.attack}
                onChange={(event) => {
                  onChange(`${base}.attack`, event.target.value)
                }}
              />

              <div>
                <label className="field-label" htmlFor={`${base}.response`}>
                  Your answer
                </label>
                <span className="field-hint">
                  Fifteen seconds of it. If it needs a paragraph, the substantive above is where
                  the fix belongs.
                </span>
                <textarea
                  id={`${base}.response`}
                  className="field-input"
                  rows={3}
                  value={preempt.response}
                  onChange={(event) => {
                    onChange(`${base}.response`, event.target.value)
                  }}
                />
              </div>
            </div>
          )
        })
      )}

      <button type="button" className="btn self-start" onClick={onAdd}>
        Add attack
      </button>
    </div>
  )
}
