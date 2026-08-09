/**
 * `supabase/apply-all.sql` is generated, so it can go stale.
 *
 * It exists because setting a project up means pasting the schema into the dashboard's SQL
 * editor, and four pastes in the right order is four chances to get it wrong. The cost of that
 * convenience is a second copy of the schema in the repo, and a second copy that drifts is worse
 * than no copy: it ships an old schema into a fresh project, and the app then fails somewhere
 * else entirely.
 *
 * Two things are checked. That the file still contains every migration, in order — which is the
 * drift check — and that it survives being **run twice**, which is what actually happens when
 * somebody re-pastes it. `CREATE POLICY` has no `IF NOT EXISTS`, and that second run is what
 * caught it.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

import { SUPABASE_STUB } from './pgHarness.ts'

const SUPABASE_DIRECTORY = fileURLToPath(new URL('../../../supabase', import.meta.url))
const MIGRATIONS_DIRECTORY = join(SUPABASE_DIRECTORY, 'migrations')

const migrationNames = readdirSync(MIGRATIONS_DIRECTORY)
  .filter((name) => name.endsWith('.sql'))
  .sort()

const applyAll = readFileSync(join(SUPABASE_DIRECTORY, 'apply-all.sql'), 'utf8')

let database: PGlite | null = null

afterAll(async () => {
  await database?.close()
})

describe('apply-all.sql', () => {
  it('contains every migration verbatim', () => {
    for (const name of migrationNames) {
      const migration = readFileSync(join(MIGRATIONS_DIRECTORY, name), 'utf8')
      // Verbatim, not "roughly": a hand-edit to one copy is exactly the drift this catches.
      expect(applyAll, `${name} is missing or altered in apply-all.sql`).toContain(migration)
    }
  })

  it('keeps them in filename order', () => {
    const offsets = migrationNames.map((name) =>
      applyAll.indexOf(readFileSync(join(MIGRATIONS_DIRECTORY, name), 'utf8')),
    )
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right))
  })

  it('names every migration it was built from', () => {
    // The banner comments are what a reader uses to find their place in a 34 000-character paste.
    for (const name of migrationNames) {
      expect(applyAll).toContain(name)
    }
  })

  it('applies to a fresh database, and again to the same one', async () => {
    database = await new PGlite({ extensions: { pgcrypto } })
    await database.exec(SUPABASE_STUB)

    await expect(database.exec(applyAll)).resolves.toBeDefined()
    // Re-pasting is what someone does when they are not sure the first run took.
    await expect(database.exec(applyAll)).resolves.toBeDefined()

    const tables = await database.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    )
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'cases',
      'comments',
      'motions',
      'sessions',
      'team_members',
      'teams',
    ])
  }, 120_000)
})
