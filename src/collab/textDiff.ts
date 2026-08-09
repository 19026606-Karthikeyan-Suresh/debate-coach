/**
 * The smallest single-splice edit that turns one string into another.
 *
 * This is the piece that makes co-prep worth having. The editor hands the store a whole new
 * field value on every keystroke, and writing that value into the CRDT wholesale — delete all,
 * insert all — makes every keystroke a conflict with the entire field: two people typing in one
 * row would each obliterate the other's sentence and Yjs would merge two obliterations. Reducing
 * the change to "at index 34, remove 0, insert 'a'" is what lets the CRDT do its job.
 *
 * One splice rather than a real diff algorithm, deliberately. A textarea edit *is* one splice —
 * typing, pasting, selecting and replacing, backspace — so the common-prefix/common-suffix
 * reduction is exact for everything the UI can produce. The one case it is merely safe rather
 * than minimal is a programmatic rewrite that changes both ends at once, which nothing here does.
 */

/** Where a string changed, in UTF-16 code units — the units `Y.Text` indexes in. */
export interface TextSplice {
  /** Index the change starts at. */
  readonly at: number
  /** How many units to remove. */
  readonly remove: number
  /** What to insert in their place. */
  readonly insert: string
}

/** True for the first unit of a surrogate pair. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

/** True for the second unit of a surrogate pair. */
function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

/**
 * Reduces a whole-value replacement to one splice.
 *
 * Boundaries are pulled back off the middle of a surrogate pair. Two strings differing by one
 * emoji share a code unit with their neighbours often enough that an unguarded prefix scan will
 * eventually stop between the halves of one, and half a surrogate written into a `Y.Text` is a
 * lone unpaired unit that renders as a replacement character on every peer, permanently.
 *
 * @param before - The current value.
 * @param after - The value to reach.
 * @returns The splice, or null when the two are already equal — callers use null to skip the
 *   write entirely, which is what keeps an unchanged field from producing an update.
 */
export function diffText(before: string, after: string): TextSplice | null {
  if (before === after) {
    return null
  }

  const shorter = Math.min(before.length, after.length)

  // Longest shared head, then longest shared tail that does not run back into the head.
  let prefix = 0
  while (prefix < shorter && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < shorter - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1
  }

  // Both boundaries step back off the middle of a surrogate pair. Each step only ever grows the
  // replaced middle — `prefix + suffix` can shrink but never exceed `shorter` — so the result
  // stays correct while becoming less minimal, and neither guard can undo the other.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) {
    prefix -= 1
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) {
    suffix -= 1
  }

  return {
    at: prefix,
    remove: before.length - prefix - suffix,
    insert: after.slice(prefix, after.length - suffix),
  }
}
