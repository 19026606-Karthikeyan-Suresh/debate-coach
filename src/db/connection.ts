/**
 * The one SQLite handle.
 *
 * Split out of `db/index.ts` in phase 9 so `sync/store.ts` can open the same database without an
 * import cycle: the queue lives in SQLite and is written by `saveCase`, so `db/index.ts` needs
 * the queue and the queue needs the connection. With the connection here, both point one way.
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
