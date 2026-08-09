/**
 * The shared case document — a `Yjs.Doc` shaped exactly like the app's own field paths.
 *
 * Three top-level shared types, all flat maps keyed by path:
 *
 * ```
 * fields   Yjs.Map<Yjs.Text>          substantives.<uuid>.whyBad  -> the prose
 * scalars  Yjs.Map<string>          clashes.<uuid>.engagements.<uuid>.branch -> 'responded'
 * lists    Yjs.Map<Yjs.Array<string>> substantives -> [uuid, uuid, uuid]
 * ```
 *
 * **Flat, not nested.** Mirroring the `Case` object's nesting into nested `Yjs.Map`s is the obvious
 * shape and buys nothing: every repeatable block is already keyed by a uuid rather than an index,
 * so a path is stable under reordering without the tree, and a flat map is one lookup instead of
 * five. What the nesting *would* cost is real — deleting a substantive would mean walking a
 * subtree, and every read would have to defend against a missing intermediate node.
 *
 * **The editor is not rewritten.** `setFieldByPath` still produces a whole new `Case` on every
 * keystroke and every reader downstream still gets a plain object. This module sits underneath as
 * the merge engine: {@link applyCaseToDoc} reduces one immutable edit to the smallest set of CRDT
 * operations, and {@link caseFromDoc} projects back. That is what "Yjs from day one" was supposed
 * to buy and did not, and it turns out not to need the rewrite it was insurance against.
 */

import * as Yjs from 'yjs'

import type { Case } from '../types/case.ts'
import type { CaseIdentity, CaseLeaf, ShapeSource } from './shape.ts'
import { buildCase, walkCase } from './shape.ts'
import { diffText } from './textDiff.ts'

/** Name of the `Yjs.Map` holding every prose row as a `Yjs.Text`. */
const FIELDS = 'fields'

/** Name of the `Yjs.Map` holding every choice. */
const SCALARS = 'scalars'

/** Name of the `Yjs.Map` holding one `Yjs.Array` of ids per repeatable collection. */
const LISTS = 'lists'

/**
 * Transaction origin for everything this module writes on behalf of a local edit.
 *
 * The update listener that broadcasts to peers checks it: an update applied *from* a peer must
 * not be sent straight back, and without an origin tag there is nothing to tell the two apart.
 */
export const LOCAL_ORIGIN = 'local-edit'

/**
 * Transaction origin used when applying an update received from a peer.
 *
 * Exported because the provider tags its own `Yjs.applyUpdate` with it and the React layer reads
 * it to decide whether a change came from this keyboard.
 */
export const REMOTE_ORIGIN = 'remote-peer'

/** The prose map of a document. */
function fieldsOf(doc: Yjs.Doc): Yjs.Map<Yjs.Text> {
  return doc.getMap<Yjs.Text>(FIELDS)
}

/** The scalar map of a document. */
function scalarsOf(doc: Yjs.Doc): Yjs.Map<string> {
  return doc.getMap<string>(SCALARS)
}

/** The collection map of a document. */
function listsOf(doc: Yjs.Doc): Yjs.Map<Yjs.Array<string>> {
  return doc.getMap<Yjs.Array<string>>(LISTS)
}

/**
 * Reads a document through the projection's interface.
 *
 * @param doc - The shared document.
 * @returns A source over its three maps. Every address it does not hold reads as null.
 */
export function docSource(doc: Yjs.Doc): ShapeSource {
  const fields = fieldsOf(doc)
  const scalars = scalarsOf(doc)
  const lists = listsOf(doc)
  return {
    text: (path) => fields.get(path)?.toString() ?? null,
    scalar: (path) => scalars.get(path) ?? null,
    list: (path) => lists.get(path)?.toArray() ?? null,
  }
}

/**
 * Projects the shared document into a plain case.
 *
 * @param doc - The shared document.
 * @param identity - This install's own id, timestamps, seat and visibility. Never a peer's.
 * @returns The case, ready for the analyzer, the compiler and the editor.
 */
export function caseFromDoc(doc: Yjs.Doc, identity: CaseIdentity): Case {
  return buildCase(docSource(doc), identity)
}

/**
 * Whether a document has ever been written to.
 *
 * @param doc - The shared document.
 * @returns True when all three maps are empty. The provider uses it to decide whether the room
 *   needs seeding, which **only the host may do** — two peers seeding one empty room produce two
 *   of every substantive, each with its own uuid, and the CRDT is right to keep both.
 */
export function isDocEmpty(doc: Yjs.Doc): boolean {
  return fieldsOf(doc).size === 0 && scalarsOf(doc).size === 0 && listsOf(doc).size === 0
}

/** Writes a leaf that did not exist before this edit. */
function createLeaf(doc: Yjs.Doc, leaf: CaseLeaf): void {
  if (leaf.kind === 'scalar') {
    scalarsOf(doc).set(leaf.path, leaf.value)
    return
  }

  const fields = fieldsOf(doc)
  if (fields.has(leaf.path)) {
    // A peer created the same path concurrently — two people adding a substantive cannot, since
    // the ids are uuids, but a re-seed or a replayed update can. Theirs stands; ours would
    // replace a live `Yjs.Text` with a detached one and orphan every edit already made in it.
    return
  }
  const created = new Yjs.Text()
  // Set before insert: a `Yjs.Text` only accepts content once it is integrated into a document,
  // and the string passed to `new Yjs.Text(value)` is applied on integration rather than now.
  fields.set(leaf.path, created)
  if (leaf.value.length > 0) {
    created.insert(0, leaf.value)
  }
}

/**
 * Applies the change one keystroke made, at the position it made it.
 *
 * **Not** a diff between the document and the new value. Those two differ whenever a peer's edit
 * has landed since this one was composed, and reconciling against the document would delete the
 * peer's words as though the local user had selected over them. Sending the local splice instead
 * is what a real Yjs binding does, and it is what leaves the merge to the CRDT — which is the
 * only thing that can do it correctly.
 */
function spliceLeaf(doc: Yjs.Doc, path: string, before: string, after: string): void {
  const target = fieldsOf(doc).get(path)
  if (!target) {
    // Deleted by a peer while this edit was being composed. Recreating it would resurrect a row
    // somebody has just removed, which is the one thing a stale snapshot must not do.
    return
  }
  const splice = diffText(before, after)
  if (splice === null) {
    return
  }
  // Clamped against the live length for the diverged case: the indices come from the text this
  // user was looking at, which a concurrent delete can have made shorter.
  const at = Math.min(splice.at, target.length)
  const remove = Math.min(splice.remove, target.length - at)
  if (remove > 0) {
    target.delete(at, remove)
  }
  if (splice.insert.length > 0) {
    target.insert(at, splice.insert)
  }
}

/**
 * Applies this edit's additions and removals to one collection.
 *
 * Only the delta, for the same reason {@link spliceLeaf} sends only the splice: an id the local
 * case does not have may be one a peer just added rather than one to delete, and an id it does
 * have may be one a peer just removed rather than one to restore.
 */
function writeList(
  doc: Yjs.Doc,
  path: string,
  before: readonly string[],
  after: readonly string[],
): void {
  const lists = listsOf(doc)
  let array = lists.get(path)
  if (!array) {
    array = new Yjs.Array<string>()
    lists.set(path, array)
  }

  const wanted = new Set(after)
  const had = new Set(before)

  // Backwards, so each delete leaves the indices below it untouched.
  for (let index = array.length - 1; index >= 0; index -= 1) {
    const id = array.get(index)
    if (had.has(id) && !wanted.has(id)) {
      array.delete(index, 1)
    }
  }

  const present = new Set(array.toArray())
  for (const [index, id] of after.entries()) {
    if (!had.has(id) && !present.has(id)) {
      // Clamped: a concurrent delete can leave the array shorter than the position this id holds
      // in the local case, and `insert` past the end throws.
      array.insert(Math.min(index, array.length), [id])
      present.add(id)
    }
  }
}

/**
 * Writes a whole case into an empty document.
 *
 * @param doc - The shared document. Seeding a document that already has content duplicates every
 *   repeatable block, so callers check {@link isDocEmpty} first — the provider does.
 * @param caseFile - The case to seed from. Its identity fields are ignored; see `CaseIdentity`.
 */
export function seedDoc(doc: Yjs.Doc, caseFile: Case): void {
  const shape = walkCase(caseFile)
  doc.transact(() => {
    for (const list of shape.lists) {
      writeList(doc, list.path, [], list.ids)
    }
    for (const leaf of shape.leaves) {
      createLeaf(doc, leaf)
    }
  }, LOCAL_ORIGIN)
}

/**
 * Applies one immutable edit to the shared document.
 *
 * The whole edit is one transaction, so peers receive one update rather than one per row — which
 * matters against Realtime's message rate limit, and matters more for correctness: half an edit
 * arriving on its own is a case with a substantive in its list and no rows behind it.
 *
 * @param doc - The shared document.
 * @param before - The case as it was. Used only to find what to delete; every write is diffed
 *   against the document's live value, so passing a stale `before` costs a redundant comparison
 *   rather than a lost remote edit.
 * @param after - The case as it now is.
 */
export function applyCaseToDoc(doc: Yjs.Doc, before: Case, after: Case): void {
  const previous = walkCase(before)
  const next = walkCase(after)

  const wasLeaf = new Map(previous.leaves.map((leaf) => [leaf.path, leaf]))
  const wasList = new Map(previous.lists.map((list) => [list.path, list.ids]))
  const isLeaf = new Set(next.leaves.map((leaf) => leaf.path))
  const isList = new Set(next.lists.map((list) => list.path))

  doc.transact(() => {
    // Paths that existed and no longer do — a deleted substantive, or the POLICY table after a
    // "no" to the mechanism question. Without this the document grows for the whole of prep and
    // a late joiner is sent rows for blocks nobody can see.
    for (const leaf of previous.leaves) {
      if (!isLeaf.has(leaf.path)) {
        fieldsOf(doc).delete(leaf.path)
        scalarsOf(doc).delete(leaf.path)
      }
    }
    for (const list of previous.lists) {
      if (!isList.has(list.path)) {
        listsOf(doc).delete(list.path)
      }
    }

    for (const list of next.lists) {
      writeList(doc, list.path, wasList.get(list.path) ?? [], list.ids)
    }

    for (const leaf of next.leaves) {
      const had = wasLeaf.get(leaf.path)
      if (!had) {
        createLeaf(doc, leaf)
        continue
      }
      if (had.value === leaf.value) {
        // Untouched by this edit. Writing it anyway would push a stale local value over a
        // peer's change to the same row — for a scalar, silently and every keystroke.
        continue
      }
      if (leaf.kind === 'scalar') {
        scalarsOf(doc).set(leaf.path, leaf.value)
      } else {
        spliceLeaf(doc, leaf.path, had.value, leaf.value)
      }
    }
  }, LOCAL_ORIGIN)
}
