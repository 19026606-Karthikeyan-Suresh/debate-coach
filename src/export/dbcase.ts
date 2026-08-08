/**
 * `.dbcase` — the whole case, losslessly, as JSON.
 *
 * The `.docx` is for people; this is for the app. It exists because phase 9's sync does not yet,
 * so a case moves between two installs — or off a laptop before a tournament — by being written
 * to a file and read back. Once sync lands this stays, because a backup that does not need a
 * server is worth having whatever else works.
 *
 * **Importing never overwrites.** A file whose case id is already on this machine is imported as
 * a copy with a fresh id, and the caller is told which happened. The alternative is a re-import
 * silently replacing work done since the export, which is the one failure a backup format must
 * not have. A file whose id is *not* here is restored exactly — same id, same `createdAt`, same
 * `updatedAt` — which is why `saveCase` takes the timestamp off the document rather than the
 * clock.
 */

import type { Case } from '../types/case.ts'
import { hydrateCase, newId } from '../types/createCase.ts'

/** Tag every `.dbcase` carries, so a JSON file that is not one is rejected by name. */
export const DBCASE_KIND = 'debate-coach-case'

/**
 * Format version.
 *
 * Bumped only when the envelope changes. The `Case` inside it is versioned by `hydrateCase`,
 * which fills in blocks a document predates — so adding a field to the data model is not a
 * reason to touch this.
 */
export const DBCASE_VERSION = 1

/** The file's top level. `case` is the document; everything beside it is about the file. */
export interface DbcaseFile {
  readonly kind: typeof DBCASE_KIND
  readonly version: number
  /** ISO 8601, for the human reading the file rather than for the importer. */
  readonly exportedAt: string
  readonly case: Case
}

/**
 * Serialises a case.
 *
 * @param caseFile - The case to write. Written as-is: an unfinished case exports and re-imports
 *   unfinished, which is the point of a backup taken mid-prep.
 * @param exportedAt - ISO timestamp to stamp the file with. Passed in rather than read from the
 *   clock so a test can assert the exact bytes.
 * @returns Pretty-printed JSON with a trailing newline — this is a file people put in a shared
 *   folder and occasionally diff.
 */
export function buildDbcase(caseFile: Case, exportedAt: string): string {
  const payload: DbcaseFile = {
    kind: DBCASE_KIND,
    version: DBCASE_VERSION,
    exportedAt,
    case: caseFile,
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** Whether an imported case landed as itself or as a copy beside one already here. */
export type ImportOutcome = 'restored' | 'copied'

/** What an import produced, and which of the two things it was. */
export interface DbcaseImport {
  /** Ready to hand to `saveCase`. Already through `hydrateCase`. */
  readonly caseFile: Case
  /**
   * `restored` when the id was not already on this machine and the case came back exactly as it
   * left; `copied` when it was, and this is a new case with a fresh id.
   */
  readonly outcome: ImportOutcome
}

/**
 * Parses a `.dbcase`.
 *
 * @param text - The file's contents. Anything that is not this format throws with a message
 *   meant for the debater — "not a Debate Coach case file" rather than a JSON parser's offset.
 * @param existingIds - Case ids already stored locally. Pass the whole library; an id found here
 *   turns a restore into a copy. Passing an empty list makes every import a restore, which will
 *   overwrite an existing row on save.
 * @param importedAt - ISO timestamp. Stamped on a copy's `updatedAt` so it sorts to the top of
 *   the library, where the person who just imported it is looking. A restore keeps its own.
 * @returns The case and which outcome it was.
 * @throws If the text is not JSON, is not a `.dbcase`, or was written by a newer version.
 */
export function readDbcase(
  text: string,
  existingIds: readonly string[],
  importedAt: string,
): DbcaseImport {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON, so it is not a Debate Coach case file.')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('That file is not a Debate Coach case file.')
  }
  const envelope = parsed as Partial<DbcaseFile>
  if (envelope.kind !== DBCASE_KIND) {
    throw new Error('That file is not a Debate Coach case file.')
  }
  if (typeof envelope.version !== 'number' || !Number.isInteger(envelope.version)) {
    throw new Error('That case file does not say which version it is.')
  }
  if (envelope.version > DBCASE_VERSION) {
    throw new Error(
      `That case file was written by a newer version of Debate Coach (format ${String(envelope.version)}).`,
    )
  }

  // `hydrateCase` throws on anything that is not an object, which is the right failure for an
  // envelope whose `case` key is missing or holds a string.
  const restored = hydrateCase(envelope.case)
  if (!existingIds.includes(restored.id)) {
    return { caseFile: restored, outcome: 'restored' }
  }

  // A copy keeps `createdAt` — it is the same prep, written on the same day — but takes a new
  // id and a fresh `updatedAt`, because it is a new row and the library sorts on that.
  return {
    caseFile: { ...restored, id: newId(), updatedAt: importedAt },
    outcome: 'copied',
  }
}
