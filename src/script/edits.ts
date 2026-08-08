/**
 * Delivery edits — the debater's rewrites, stored apart from the case.
 *
 * A compiled script is a derived artifact: it is rebuilt from the case on every keystroke, so
 * anything written *into* it would be gone by the next debounce. But a script always needs
 * editing — the signposts are generic, the template says "Prop's 2nd/ 3rd speaker" and expects
 * you to pick one, and a sentence that reads fine on the page can be unsayable at speed.
 *
 * So edits live in their own record, keyed by segment id, and are laid over the compiled script
 * afterwards. Re-editing the case recompiles everything and the edits survive, because segment
 * ids are built from case ids rather than from a running count. The one thing that orphans an
 * edit is deleting the substantive or engagement it belonged to, which is what
 * `orphanedEditIds` is for.
 *
 * **An edited segment loses its provenance.** Its tokens all carry `fieldPath: null`, so the
 * report says the skip happened in the segment rather than in a template row. The alternative —
 * matching the rewrite back against the field values it was built from — is a guess dressed up
 * as a fact, and the whole point of `fieldPath` is that it is not a guess.
 */

import { estimateSeconds } from './types.ts'
import type { CompiledScript, ScriptSegment, ScriptToken } from './types.ts'
import { assembleText, tokenizeAssembled } from './lines.ts'

/**
 * Stored rewrites, keyed by `ScriptSegment.id`.
 *
 * A value equal to the compiled text is kept rather than pruned — the debater typed it, and
 * silently dropping it would make the edit reappear as "unedited" the moment the case changes.
 * An empty string is a real edit meaning "do not say this segment".
 */
export type ScriptEdits = Readonly<Record<string, string>>

/**
 * Lays stored edits over a compiled script.
 *
 * @param script - A freshly compiled script. Passing an already-edited one re-tokenizes for no
 *   reason but is otherwise harmless, since an edit replaces text rather than appending to it.
 * @param edits - Rewrites by segment id. Ids that match no segment are ignored, so an edit
 *   belonging to a deleted substantive does not throw — see `orphanedEditIds`.
 * @returns A new script. Token indices are renumbered across the whole speech, so an edit that
 *   shortens one segment shifts every index after it — hold token positions only for as long as
 *   the script object they came from.
 */
export function applyEdits(script: CompiledScript, edits: ScriptEdits): CompiledScript {
  // Nothing to lay over, and recompiling every segment's tokens for that is pure waste — this
  // runs on the same debounce as the compile itself.
  if (Object.keys(edits).length === 0) {
    return script
  }

  const segments: ScriptSegment[] = []
  let tokenCount = 0

  for (const segment of script.segments) {
    const edited = edits[segment.id]
    if (edited === undefined) {
      segments.push(renumber(segment, tokenCount))
      tokenCount += segment.tokens.length
      continue
    }

    const assembled = assembleText([[{ text: edited, fieldPath: null }]])
    if (assembled.text.length === 0) {
      continue
    }
    const tokens = tokenizeAssembled(assembled, segment.id, tokenCount)
    tokenCount += tokens.length
    segments.push({ ...segment, text: assembled.text, tokens, isEdited: true })
  }

  const tokens = segments.flatMap((segment) => [...segment.tokens])
  return {
    segments,
    tokens,
    gaps: script.gaps,
    wordCount: tokens.length,
    estimatedSeconds: estimateSeconds(tokens.length),
  }
}

/** Rewrites a segment's token indices to start at `firstIndex`, leaving everything else alone. */
function renumber(segment: ScriptSegment, firstIndex: number): ScriptSegment {
  if (segment.tokens[0]?.index === firstIndex) {
    return segment
  }
  const tokens: ScriptToken[] = segment.tokens.map((token, offset) => ({
    ...token,
    index: firstIndex + offset,
  }))
  return { ...segment, tokens }
}

/**
 * Finds edits whose segment no longer exists.
 *
 * The case they belonged to was deleted — a substantive removed, an engagement dropped, a
 * "(OR)" fork switched to the other branch. Worth offering to clear rather than leaving to rot,
 * but never cleared automatically: a whip who switches a branch back within the same prep wants
 * their wording still there.
 *
 * @param script - The compiled script to check against. Pass the unedited compile; an edited
 *   one has the same segment ids, so either works.
 * @param edits - Stored rewrites.
 * @returns Segment ids present in `edits` and absent from `script`, in insertion order.
 */
export function orphanedEditIds(script: CompiledScript, edits: ScriptEdits): readonly string[] {
  const live = new Set(script.segments.map((segment) => segment.id))
  return Object.keys(edits).filter((segmentId) => !live.has(segmentId))
}

/**
 * Stores one rewrite.
 *
 * @param edits - The existing record; not modified.
 * @param segmentId - Segment being rewritten.
 * @param text - The new wording. Pass the compiled text to record "reviewed, unchanged"; pass
 *   `''` to drop the segment from delivery. Use `clearEdit` to go back to the compiled version.
 * @returns A new record.
 */
export function setEdit(edits: ScriptEdits, segmentId: string, text: string): ScriptEdits {
  return { ...edits, [segmentId]: text }
}

/**
 * Drops one rewrite, restoring the compiled text.
 *
 * @param edits - The existing record; not modified.
 * @param segmentId - Segment to revert. An id with no edit returns an equal record.
 * @returns A new record.
 */
export function clearEdit(edits: ScriptEdits, segmentId: string): ScriptEdits {
  const { [segmentId]: _dropped, ...rest } = edits
  return rest
}
