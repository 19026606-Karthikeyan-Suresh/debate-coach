/**
 * SQLite access — the local source of truth.
 *
 * The whole filled template lives in `cases.doc` as JSON. Columns beside it (`motion`,
 * `format`, `side`, `position`, `updated_at`) are denormalised copies used for listing and
 * search; `saveCase` rewrites them from the document so they cannot drift.
 */

import Database from '@tauri-apps/plugin-sql'

import type { FormatId, Side } from '../formats/index.ts'
import type { Case, Visibility } from '../types/case.ts'
import { hydrateCase } from '../types/createCase.ts'

/** Must match `DB_URL` in `src-tauri/src/db.rs`; the Rust side owns the migrations. */
const DB_URL = 'sqlite:debate-coach.db'

// Opening the same URL twice returns two handles to one file, which works but wastes a
// connection per call site. One shared promise keeps it to a single pool.
let databaseHandle: Promise<Database> | null = null

/**
 * Opens the local database, running any pending migrations on first call.
 *
 * @returns The shared connection. Subsequent calls reuse it.
 */
export function getDatabase(): Promise<Database> {
  databaseHandle ??= Database.load(DB_URL)
  return databaseHandle
}

/** One row of the case list — enough to render the library without parsing every document. */
export interface CaseSummary {
  readonly id: string
  readonly motion: string
  readonly format: FormatId
  readonly side: Side
  readonly position: string
  readonly visibility: Visibility
  readonly updatedAt: string
}

/** Shape of a `cases` row as the SQL plugin returns it. */
interface CaseRow {
  id: string
  motion: string
  format: FormatId
  side: Side
  position: string
  visibility: Visibility
  updated_at: string
  doc: string
}

/**
 * Inserts or updates a case.
 *
 * Writes `updatedAt` from the passed document rather than from the clock, so a case restored
 * from a `.dbcase` file or pulled from sync keeps its real modification time.
 *
 * @param caseFile - The case to persist. Its `id` is the primary key; passing an id that
 *   already exists overwrites that row wholesale rather than merging.
 */
export async function saveCase(caseFile: Case): Promise<void> {
  const database = await getDatabase()
  await database.execute(
    `INSERT INTO cases (id, motion, format, side, position, doc, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO UPDATE SET
       motion = excluded.motion,
       format = excluded.format,
       side = excluded.side,
       position = excluded.position,
       doc = excluded.doc,
       visibility = excluded.visibility,
       updated_at = excluded.updated_at`,
    [
      caseFile.id,
      caseFile.prep.motion,
      caseFile.format,
      caseFile.side,
      caseFile.position,
      JSON.stringify(caseFile),
      caseFile.visibility,
      caseFile.createdAt,
      caseFile.updatedAt,
    ],
  )
}

/**
 * Loads one case.
 *
 * Runs the document through `hydrateCase`, so a row written before a block existed opens
 * with that block empty rather than undefined.
 *
 * @param caseId - Primary key. An unknown id returns null rather than throwing, because the
 *   common cause is a stale link to a case deleted on another machine.
 * @returns The parsed case, or null if no row matches.
 */
export async function loadCase(caseId: string): Promise<Case | null> {
  const database = await getDatabase()
  const rows = await database.select<CaseRow[]>('SELECT doc FROM cases WHERE id = $1', [caseId])
  const row = rows[0]
  return row ? hydrateCase(JSON.parse(row.doc)) : null
}

/**
 * Lists cases newest-first for the library screen.
 *
 * @param limit - Maximum rows. Defaults to 100; the library paginates rather than loading a
 *   season's worth of cases into memory.
 * @returns Summaries only — call `loadCase` for the document.
 */
export async function listCases(limit = 100): Promise<CaseSummary[]> {
  const database = await getDatabase()
  const rows = await database.select<CaseRow[]>(
    `SELECT id, motion, format, side, position, visibility, updated_at
     FROM cases ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  )
  return rows.map((row) => ({
    id: row.id,
    motion: row.motion,
    format: row.format,
    side: row.side,
    position: row.position,
    visibility: row.visibility,
    updatedAt: row.updated_at,
  }))
}

/**
 * Deletes a case.
 *
 * @param caseId - Primary key. Deleting an unknown id is a no-op, not an error.
 */
export async function deleteCase(caseId: string): Promise<void> {
  const database = await getDatabase()
  await database.execute('DELETE FROM cases WHERE id = $1', [caseId])
}
