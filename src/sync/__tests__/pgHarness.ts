/**
 * Runs the shipped migrations against a real PostgreSQL, so the RLS policies can be *proved*.
 *
 * PGlite is Postgres 18 compiled to WebAssembly: real roles, real row-level security, real
 * `SECURITY DEFINER`, real pgcrypto. That matters because an RLS policy cannot be unit-tested
 * against a mock — the whole question is what the database does when a second identity asks, and
 * the answer comes out of the planner. It reads the files in `supabase/migrations/` verbatim, so
 * what is under test is what gets deployed rather than a copy of it.
 *
 * **The stub below is only what Supabase supplies and PGlite does not.** `auth.uid()` is copied
 * from Supabase's own definition, including its fallback between the two GUCs PostgREST has used;
 * `storage.foldername` from theirs. Nothing here weakens a policy — if the stub were wrong in
 * that direction the cross-team tests would pass by accident, which is why each one has a
 * matching assertion that the *permitted* read still returns its row.
 *
 * Not a `.test.ts` file, so vitest's `include` does not pick it up as a suite.
 */

import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url))

/**
 * The parts of a Supabase project that exist before any migration runs.
 *
 * Two roles, the `auth` schema with the user table everything references, and enough of
 * `storage` for the bucket policies to be creatable and testable. `authenticated` is the role an
 * anonymous sign-in lands in — `anon` is the unauthenticated caller, and it is here so the
 * migrations' `revoke ... from anon` has something to revoke from.
 */
const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;

create schema if not exists auth;
create table auth.users (
    id    uuid primary key,
    email text
);

-- Supabase's own definition, fallback included: PostgREST has set the claim under both names.
create or replace function auth.uid() returns uuid
language sql stable
as $$
    select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid;
$$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create schema if not exists storage;

create table storage.buckets (
    id     text primary key,
    name   text not null,
    public boolean not null default false
);

create table storage.objects (
    id         uuid primary key default gen_random_uuid(),
    bucket_id  text not null references storage.buckets(id),
    name       text not null,
    owner_id   text,
    created_at timestamptz not null default now(),
    unique (bucket_id, name)
);

alter table storage.objects enable row level security;

-- Every path segment except the last, which is Supabase's own behaviour: for
-- 'team/session.opus' this is {team}.
create or replace function storage.foldername(name text) returns text[]
language sql immutable
as $$
    select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)];
$$;

grant usage on schema storage to anon, authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;
`

/** A running database, with the migrations applied and an identity that can be swapped. */
export interface PgHarness {
  /**
   * Runs a statement as whoever is currently signed in.
   *
   * @param sql - One statement. Parameters are `$1`-style.
   * @param params - Bound values.
   * @returns The rows, typed as the caller asserts.
   */
  query: <TRow>(sql: string, params?: unknown[]) => Promise<TRow[]>
  /**
   * Signs in as a user, or out.
   *
   * @param userId - The `auth.uid()` to present. Null becomes the `anon` role with no claim,
   *   which is what an unauthenticated PostgREST request looks like.
   */
  asUser: (userId: string | null) => Promise<void>
  /** Drops back to the superuser, bypassing RLS. Use only to arrange fixtures. */
  asPostgres: () => Promise<void>
  close: () => Promise<void>
}

/**
 * Boots Postgres, applies the stub and then every migration in filename order.
 *
 * @returns The harness, already migrated and signed out. Call `asUser` before asserting
 *   anything — a query run as the superuser bypasses every policy and proves nothing.
 * @throws If a migration fails, with the filename in the message. A migration that does not
 *   apply here does not apply on Supabase either.
 */
export async function startHarness(): Promise<PgHarness> {
  const database = await new PGlite({ extensions: { pgcrypto } })
  await database.exec(SUPABASE_STUB)

  for (const fileName of readdirSync(MIGRATIONS_DIRECTORY).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIRECTORY, fileName), 'utf8')
    try {
      await database.exec(sql)
    } catch (migrationError) {
      const reason = migrationError instanceof Error ? migrationError.message : String(migrationError)
      throw new Error(`migration ${fileName} failed: ${reason}`, { cause: migrationError })
    }
  }

  return {
    query: async <TRow>(sql: string, params: unknown[] = []): Promise<TRow[]> => {
      const result = await database.query<TRow>(sql, params)
      return result.rows
    },

    // The claim is set before switching role rather than after: a custom GUC is unambiguously
    // settable by the superuser, and it survives the role change.
    asUser: async (userId: string | null): Promise<void> => {
      await database.exec('reset role')
      await database.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', userId ?? ''])
      await database.exec(`set role ${userId === null ? 'anon' : 'authenticated'}`)
    },

    asPostgres: async (): Promise<void> => {
      await database.exec('reset role')
      await database.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', ''])
    },

    close: async (): Promise<void> => {
      await database.close()
    },
  }
}

/**
 * Runs an operation and returns the error message it raised, or null if it succeeded.
 *
 * RLS denies three different ways and a test that only checks one of them passes for the wrong
 * reason: a withheld grant is "permission denied", a failed `with check` is "violates row-level
 * security policy", and a failed `using` clause on a read is simply no rows. This covers the two
 * that raise; the third is asserted by counting rows.
 *
 * @param operation - The query to attempt.
 * @returns The message, or null when nothing was raised.
 */
export async function errorFrom(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation()
    return null
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught)
  }
}
