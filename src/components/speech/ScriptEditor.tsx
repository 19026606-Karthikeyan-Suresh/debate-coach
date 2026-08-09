/**
 * Rewriting the compiled speech, line by line.
 *
 * **A separate pane rather than an editable teleprompter.** The teleprompter renders each segment
 * by slicing `segment.text` at every token's `start`/`end`, and a verification pass pins that its
 * rendered text is character-identical to the compiled text — which is what proves the token
 * offsets the aligner indexes into. Putting a textarea inside that would put a caret, a scroll
 * position and a re-render in the middle of the one thing on the Speak screen that has to stay
 * exact. Editing is therefore a mode you switch into, and the teleprompter is untouched.
 *
 * Each segment shows the compiled wording underneath the box while it differs, because the whole
 * reason to rewrite a line is that the generated one reads badly — and comparing the two is the
 * judgement being made.
 */

import { useState } from 'react'

import { formatClock } from '../../case/time.ts'
import type { ScriptEdits } from '../../script/edits.ts'
import { orphanedEditIds } from '../../script/edits.ts'
import type { CompiledScript, ScriptSegment } from '../../script/types.ts'

/** Props for {@link ScriptEditor}. */
export interface ScriptEditorProps {
  /** The script **before** edits are applied — the compiled wording is what a revert restores. */
  readonly compiled: CompiledScript
  /** The script with edits applied, for the length the debater will actually deliver. */
  readonly delivered: CompiledScript
  readonly edits: ScriptEdits
  readonly onWrite: (segmentId: string, text: string) => void
  readonly onRevert: (segmentId: string) => void
  /** Surfaced from the store: a rewrite that did not save must not look saved. */
  readonly error: string | null
}

/** One segment: its own draft, committed on blur or on the button. */
function SegmentRow({
  segment,
  edited,
  onWrite,
  onRevert,
}: {
  segment: ScriptSegment
  edited: string | undefined
  onWrite: (segmentId: string, text: string) => void
  onRevert: (segmentId: string) => void
}): React.JSX.Element {
  // The draft is local so typing does not write to disk on every keystroke. Seeded from the
  // stored edit when there is one, otherwise from the compiled wording.
  const [draft, setDraft] = useState(edited ?? segment.text)

  // A recompile can change `segment.text` under an unedited row — the debater went back to Prep
  // and rewrote the field. Reset during render via a last-seen value rather than in an effect.
  const [seenText, setSeenText] = useState(segment.text)
  const [seenEdit, setSeenEdit] = useState(edited)
  if (seenText !== segment.text || seenEdit !== edited) {
    setSeenText(segment.text)
    setSeenEdit(edited)
    setDraft(edited ?? segment.text)
  }

  const isEdited = edited !== undefined
  const isDropped = isEdited && edited.trim().length === 0
  const isDirty = draft !== (edited ?? segment.text)

  return (
    <li className="panel flex flex-col gap-1.5 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-neutral-400 dark:text-neutral-500">{segment.sectionId}</span>
        {isDropped ? (
          <span className="text-xs text-amber-700 dark:text-amber-400">not being said</span>
        ) : isEdited ? (
          <span className="text-xs text-neutral-500 dark:text-neutral-400">rewritten</span>
        ) : null}
      </div>

      <textarea
        className="field-input mt-0"
        rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 70)))}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        onBlur={() => {
          if (isDirty) {
            onWrite(segment.id, draft)
          }
        }}
      />

      {/* The generated line, while it differs — the comparison is the judgement being made. */}
      {isEdited && !isDropped && (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          Compiled: {segment.text}
        </p>
      )}

      <div className="flex gap-1.5">
        <button
          type="button"
          className="btn"
          disabled={!isDirty}
          onClick={() => {
            onWrite(segment.id, draft)
          }}
        >
          Save
        </button>
        <button
          type="button"
          className="btn"
          disabled={!isEdited}
          onClick={() => {
            onRevert(segment.id)
          }}
        >
          Revert
        </button>
        {/* An empty edit is how the compiler's own record says "do not deliver this". Useful for
            a line the template generates that this speech does not need. */}
        <button
          type="button"
          className="btn ml-auto"
          disabled={isDropped}
          onClick={() => {
            onWrite(segment.id, '')
          }}
        >
          Don’t say this
        </button>
      </div>
    </li>
  )
}

/**
 * Renders the editable script.
 *
 * @param props - See {@link ScriptEditorProps}.
 * @param props.compiled - The script before edits; what Revert restores to.
 * @param props.delivered - The script after edits; the length shown is this one's.
 * @param props.edits - Stored rewrites by segment id.
 * @param props.onWrite - Commits a rewrite.
 * @param props.onRevert - Restores the compiled wording.
 * @param props.error - The last failed write, or null.
 * @returns The editor pane.
 */
export function ScriptEditor({
  compiled,
  delivered,
  edits,
  onWrite,
  onRevert,
  error,
}: ScriptEditorProps): React.JSX.Element {
  // Edits whose segment is gone — the substantive was deleted, or the "(OR)" fork switched.
  // Never cleared automatically: a whip who switches a branch back within one prep wants their
  // wording still there. Offered instead.
  const orphaned = orphanedEditIds(compiled, edits)

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="section-heading">Script</h2>
        <span className="text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
          {delivered.wordCount} words · {formatClock(delivered.estimatedSeconds)}
          {delivered.wordCount === compiled.wordCount
            ? ''
            : ` · was ${formatClock(compiled.estimatedSeconds)}`}
        </span>
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Rewrites are kept apart from the case, so editing a field in Prep recompiles everything
        around them and leaves them alone. An edited line loses its link back to the template row
        it came from, so the report will name the line rather than the row.
      </p>

      {error !== null && (
        <p className="text-xs text-red-700 dark:text-red-400">Not saved: {error}</p>
      )}

      {orphaned.length > 0 && (
        <div className="panel flex items-center gap-3 p-3">
          <span className="flex-1 text-xs text-neutral-600 dark:text-neutral-300">
            {orphaned.length} rewrite{orphaned.length === 1 ? '' : 's'} belong to lines this case
            no longer has.
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              for (const segmentId of orphaned) {
                onRevert(segmentId)
              }
            }}
          >
            Clear them
          </button>
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {compiled.segments.map((segment) => (
          <SegmentRow
            key={segment.id}
            segment={segment}
            edited={edits[segment.id]}
            onWrite={onWrite}
            onRevert={onRevert}
          />
        ))}
      </ul>
    </div>
  )
}
