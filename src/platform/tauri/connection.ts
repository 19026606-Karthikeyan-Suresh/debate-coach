/**
 * The one SQLite handle.
 *
 * Split out of the database module in phase 9 so the sync queue could open the same database
 * without an import cycle; the two ended up in the same file once the platform seam landed, and
 * this stays separate because it is the only line in the desktop shell that names the plugin.
 */

import Database from '@tauri-apps/plugin-sql'

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
