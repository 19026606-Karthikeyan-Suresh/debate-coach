-- What the browser shell needs that the desktop kept locally.
--
-- On the desktop, SQLite is the source of truth and Supabase is a replication target, so two
-- kinds of row never had to leave: a speech's full report, and the debater's delivery rewrites.
-- In a browser there is no local database to be the truth, so both need a home here — and both
-- need a policy narrower than the one on the table they hang off.

-- ---------------------------------------------------------------------------
-- Speech reports
-- ---------------------------------------------------------------------------

-- **Deliberately its own table rather than a column on `sessions`.**
--
-- `sessions_select` is team-visible on purpose: teammates see each other's numbers, and that is
-- what makes the history screen a squad tool. But `metrics` is a dozen numbers and `report` is
-- the transcript, every clause the debater failed to say, and every filler they used. Phase 6
-- split those two by what leaves the machine; adding a `report` column to `sessions` would undo
-- that split silently, by inheriting a policy written for the numbers.
--
-- So the report gets a table whose policy resolves to the *owner* of the session and stops there.
create table if not exists public.session_reports (
    session_id  uuid primary key references public.sessions(id) on delete cascade,
    report      jsonb not null,
    created_at  timestamptz not null default now()
);

alter table public.session_reports enable row level security;

-- Supabase grants `authenticated` everything on a new table in `public`, so the revoke comes
-- first. Without it the grant below is decoration and the table is readable by every signed-in
-- identity that guesses a session id.
revoke all on public.session_reports from anon, authenticated;
grant select, insert, update, delete on public.session_reports to authenticated;

-- The subquery reads `sessions`, whose own RLS applies to it — which is safe in this direction.
-- RLS on the inner table can only ever *narrow* what the subquery sees, and narrowing cannot
-- grant. The `user_id` check is what makes this owner-only: `exists (select 1 from sessions
-- where id = session_id)` alone would be true for a teammate, because a teammate may read the
-- session row. That is the right rule for `comments` and the wrong one here.
drop policy if exists session_reports_select on public.session_reports;
create policy session_reports_select on public.session_reports
    for select to authenticated
    using (
        exists (
            select 1 from public.sessions
            where sessions.id = session_reports.session_id
              and sessions.user_id = (select auth.uid())
        )
    );

drop policy if exists session_reports_insert on public.session_reports;
create policy session_reports_insert on public.session_reports
    for insert to authenticated
    with check (
        exists (
            select 1 from public.sessions
            where sessions.id = session_reports.session_id
              and sessions.user_id = (select auth.uid())
        )
    );

-- A report is written twice for one speech — the live pass the moment the speaker sits down, and
-- the accurate one when the re-transcription lands — so the update policy is not optional.
drop policy if exists session_reports_update on public.session_reports;
create policy session_reports_update on public.session_reports
    for update to authenticated
    using (
        exists (
            select 1 from public.sessions
            where sessions.id = session_reports.session_id
              and sessions.user_id = (select auth.uid())
        )
    )
    with check (
        exists (
            select 1 from public.sessions
            where sessions.id = session_reports.session_id
              and sessions.user_id = (select auth.uid())
        )
    );

drop policy if exists session_reports_delete on public.session_reports;
create policy session_reports_delete on public.session_reports
    for delete to authenticated
    using (
        exists (
            select 1 from public.sessions
            where sessions.id = session_reports.session_id
              and sessions.user_id = (select auth.uid())
        )
    );

-- ---------------------------------------------------------------------------
-- Delivery rewrites
-- ---------------------------------------------------------------------------

-- Mirrors the local `script_edits` table in `src-tauri/src/db.rs`, and for the same reason it is
-- a table rather than a blob on the case: a compiled script is *derived* and is rebuilt from the
-- case on every keystroke, so anything written into the case would be gone by the next debounce.
-- These are the debater's own words and outlive every recompile.
--
-- Empty `text` is meaningful and must not be confused with an absent row: it is the debater
-- saying "do not deliver this segment at all".
create table if not exists public.script_edits (
    case_id     uuid not null references public.cases(id) on delete cascade,
    segment_id  text not null,
    text        text not null,
    updated_at  timestamptz not null default now(),
    primary key (case_id, segment_id)
);

alter table public.script_edits enable row level security;

revoke all on public.script_edits from anon, authenticated;
grant select, insert, update, delete on public.script_edits to authenticated;

-- Owner-only, matching `cases_update` rather than `cases_select`. A teammate may *read* a shared
-- case and take a copy of it, but how somebody else intends to say their own words out loud is
-- not part of what sharing a case offers — and a rewrite is addressed by a segment id derived
-- from the case, so it would apply cleanly to their copy and silently change it.
drop policy if exists script_edits_all on public.script_edits;
create policy script_edits_all on public.script_edits
    for all to authenticated
    using (
        exists (
            select 1 from public.cases
            where cases.id = script_edits.case_id
              and cases.owner_id = (select auth.uid())
        )
    )
    with check (
        exists (
            select 1 from public.cases
            where cases.id = script_edits.case_id
              and cases.owner_id = (select auth.uid())
        )
    );
