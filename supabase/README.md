# Supabase

Eight migrations, applied in filename order. They are plain SQL against a stock Supabase project
and need nothing installed on the machine that runs them.

| File | What it does |
|---|---|
| `20260809000100_schema.sql` | Tables, the immutable search-text walker, generated `tsvector` columns, indexes |
| `20260809000200_rls.sql` | Grants, the membership helpers, and a policy for every table and operation |
| `20260809000300_team_functions.sql` | `create_team`, `join_team`, `rotate_invite_code`, `search_cases` |
| `20260809000400_recordings_storage.sql` | The private `recordings` bucket and its policies |
| `20260809000500_delete_team.sql` | `delete_team`, and the trigger keeping every team an admin |
| `20260809000600_coprep_rooms.sql` | Who may join a live co-prep room, as RLS on `realtime.messages` |
| `20260814000700_web_storage.sql` | `session_reports` and `script_edits` — what SQLite held for a shell that has no SQLite |
| `20260814000800_coach_usage.sql` | `coach_usage` and `claim_coach_call`, the per-identity daily cap on Layer B |

The last two are the web shell's. A browser has no local database, so the two things the desktop
kept only in SQLite need somewhere to live — and a public URL in front of an Anthropic key needs
a meter. Neither changes anything for the desktop build, which still writes both locally and
still reaches Claude through the Rust process.

## Applying them

**The short way:** paste [`apply-all.sql`](apply-all.sql) into the dashboard's SQL editor
(SQL Editor → New query → Run). It is the eight files above concatenated in order, generated
rather than maintained — `src/sync/__tests__/applyAll.test.ts` fails if it drifts from them, and
also checks it survives being run twice. Running it twice is safe.

Or paste each migration in order. Or, with the CLI:

```bash
supabase link --project-ref your-project-ref
```

then

```bash
supabase db push
```

The filenames already carry the timestamp prefix the CLI expects, so `db push` picks them up
without renaming.

Then enable **anonymous sign-ins** under Authentication → Providers. Nothing works without it:
the app never asks for an email, and every identity in the schema is an anonymous
`auth.users` row.

**Migration 6 is what turns co-prep on**, and until it has run no room opens at all. A private
Realtime channel is default-deny, so a project missing it answers every join with
`Unauthorized: You do not have permissions to read from this Channel topic: case:<uuid>` and has
no `can_join_case_room` to call — both measured against a live project before and after applying
it, and the reason the panel prints the server's message after its own. That is the right way
round to fail: forgetting the migration closes co-prep rather than leaving a squad's prep
readable by anyone holding the anon key.

## What is being relied on

- `auth.uid()` and the `authenticated` role. An anonymous sign-in still produces an
  `authenticated` JWT — `anon` is the unauthenticated caller, and the migrations grant it
  nothing anywhere.
- `pgcrypto` in the `extensions` schema, which is where Supabase puts it. Migration 1 creates the
  schema and installs there explicitly rather than trusting `search_path`, because the
  `SECURITY DEFINER` functions run with an empty one and have to name it.
- `realtime.messages` and `realtime.topic()`, both supplied by Supabase. Migration 6 only adds
  policies to that table; it never creates it.
- One trigger, added by migration 5 to keep every team an admin. No scheduled jobs, no edge
  functions.

## Verifying them without a project

`src/sync/__tests__/rls.test.ts` applies these exact files to a real PostgreSQL — PGlite,
Postgres 18 compiled to WebAssembly — with a stub supplying only what Supabase itself provides
(`auth.uid()`, `auth.users`, the two roles, enough of `storage` for the bucket policies, and
`realtime.messages` plus `realtime.topic()` for the co-prep ones). It then runs two teams and
three identities against them and asserts what each one cannot see.

```bash
npx vitest run src/sync
```

An RLS policy cannot be checked by reading it. This is the check.

## The column that is deliberately absent, and the table that replaced it

The local `sessions` table has a `report` column and `public.sessions` does not. `metrics` is a
dozen numbers and syncing it is the point — a squad seeing each other's skip rate and pace.
`report` is the transcript, every skipped clause with the case field it came from, and the
improvisations. That is a recording of somebody speaking, held in text.

`sessions_select` is team-visible by design, which is what makes the history screen a squad tool
— so putting the report beside `metrics` would have shared it with the team by the same policy
that shares the numbers. Migration 7 gives it its own table instead, `session_reports`, resolved
through `sessions.user_id = auth.uid()` with no team branch at all. The split survives; only the
storage moved, and it moved because a browser has no machine to leave it on.

`recording_path` never gained a counterpart either. Locally it is `C:\Users\<name>\...`, which is
a path on one machine and a name on the wire; the bucket key lives in its own column.
