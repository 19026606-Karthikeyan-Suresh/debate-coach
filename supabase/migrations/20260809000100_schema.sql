-- Team layer: the tables Supabase holds, mirroring the local SQLite schema in
-- `src-tauri/src/db.rs` column for column so sync is a row copy rather than a translation.
--
-- Three differences from that file, all deliberate:
--
--   * ids are `uuid` rather than `text`. SQLite has no uuid type; Postgres does, and
--     `auth.users(id)` is a uuid, so anything referencing a user has to be one.
--   * `doc` is `jsonb` rather than `TEXT`, which is what makes the search column below possible.
--   * **`sessions.report` is not here at all.** Phase 6 split one speech across two columns by
--     what leaves the machine: `metrics` is a dozen numbers and is the point of syncing a
--     session, while `report` is the transcript and every clause the debater failed to say. That
--     is a recording of somebody speaking, held in text. It stays on their laptop.

-- pgcrypto is pinned to the `extensions` schema rather than left to search_path. Supabase
-- pre-installs it there, so on a real project this is a no-op — but the SECURITY DEFINER
-- functions in migration 3 run with `search_path = ''` and have to name the schema, and a
-- pgcrypto that landed in `public` instead would make `extensions.crypt` an unknown function
-- at the moment somebody tries to join a team.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Teams and membership
-- ---------------------------------------------------------------------------

create table if not exists public.teams (
    id                  uuid primary key default gen_random_uuid(),
    name                text not null check (length(trim(name)) > 0),
    -- bcrypt, written only by `create_team` and `rotate_invite_code`. No client ever reads it:
    -- the column grant in the RLS migration omits it, so even a team member selecting `*` gets
    -- a permission error rather than a hash to attack offline.
    invite_code_hash    text not null,
    invite_rotated_at   timestamptz not null default now(),
    created_at          timestamptz not null default now()
);

create table if not exists public.team_members (
    team_id             uuid not null references public.teams(id) on delete cascade,
    user_id             uuid not null references auth.users(id) on delete cascade,
    display_name        text not null default '',
    role                text not null default 'member' check (role in ('member', 'coach', 'admin')),
    joined_at           timestamptz not null default now(),
    primary key (team_id, user_id)
);

create index if not exists idx_team_members_user on public.team_members(user_id);

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------

-- Flattens a case document to its text, for the search column.
--
-- `to_tsvector(doc::text)` is the one-liner and it is wrong: every field key in the template
-- becomes a search term, so "example" and "problem" match every case ever written. This walks
-- the document and keeps only the leaves a debater typed.
--
-- Must be IMMUTABLE to be usable in a generated column. It is: same jsonb in, same text out.
--
-- Written as an explicit stack rather than a recursive CTE. The CTE version needs one lateral
-- for objects and another for arrays, and a `left join lateral ... on jsonb_typeof(...) = 'array'`
-- does *not* stop the function running on the rows the condition excludes — the join evaluates
-- first and filters after, so `jsonb_each` gets handed an array and the whole insert fails with
-- "cannot extract elements from an object". A recursive CTE also permits only one recursive
-- reference, which rules out the obvious two-branch fix.
create or replace function public.case_search_text(document jsonb)
returns text
language plpgsql
immutable
parallel safe
as $$
declare
    -- Containers still to walk. Depth-first; a case document is a handful of levels deep.
    pending jsonb[] := array[document];
    current jsonb;
    child jsonb;
    collected text[] := '{}';
begin
    while array_length(pending, 1) > 0 loop
        current := pending[array_length(pending, 1)];
        pending := pending[1:array_length(pending, 1) - 1];

        case jsonb_typeof(current)
            when 'object' then
                for child in select value from jsonb_each(current) loop
                    pending := pending || child;
                end loop;
            when 'array' then
                for child in select value from jsonb_array_elements(current) loop
                    pending := pending || child;
                end loop;
            when 'string' then
                -- `#>> '{}'` unwraps the JSON string; `::text` would keep its quotes.
                collected := collected || (current #>> '{}');
            else
                null;
        end case;
    end loop;

    return array_to_string(collected, ' ');
end;
$$;

create table if not exists public.cases (
    id                  uuid primary key,
    team_id             uuid references public.teams(id) on delete set null,
    owner_id            uuid not null references auth.users(id) on delete cascade,
    motion              text not null default '',
    format              text not null check (format in ('AP', 'BP')),
    side                text not null check (side in ('gov', 'opp')),
    position            text not null default '',
    doc                 jsonb not null,
    -- The Yjs update blob. Null until a case has been opened in a co-prep room; the column
    -- exists now so phase 11 does not migrate live data.
    ydoc_state          bytea,
    visibility          text not null default 'private' check (visibility in ('private', 'team')),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    search              tsvector generated always as (
                            to_tsvector('english', motion || ' ' || public.case_search_text(doc))
                        ) stored
);

create index if not exists idx_cases_search on public.cases using gin(search);
create index if not exists idx_cases_team on public.cases(team_id, updated_at desc);
create index if not exists idx_cases_owner on public.cases(owner_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Motions
-- ---------------------------------------------------------------------------

-- `created_by` is not in the original schema sketch and has to be: without it there is no way to
-- write a delete policy narrower than "any member may delete anything the squad has collected".
create table if not exists public.motions (
    id                  uuid primary key default gen_random_uuid(),
    team_id             uuid not null references public.teams(id) on delete cascade,
    created_by          uuid not null references auth.users(id) on delete cascade,
    text                text not null check (length(trim(text)) > 0),
    tournament          text,
    motion_date         date,
    source              text,
    created_at          timestamptz not null default now(),
    search              tsvector generated always as (
                            to_tsvector('english', text || ' ' || coalesce(tournament, ''))
                        ) stored
);

create index if not exists idx_motions_search on public.motions using gin(search);
create index if not exists idx_motions_team on public.motions(team_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Sessions and coach comments
-- ---------------------------------------------------------------------------

create table if not exists public.sessions (
    id                  uuid primary key,
    team_id             uuid references public.teams(id) on delete set null,
    user_id             uuid not null references auth.users(id) on delete cascade,
    case_id             uuid references public.cases(id) on delete set null,
    format              text not null check (format in ('AP', 'BP')),
    role                text not null default '',
    duration_s          integer not null default 0,
    metrics             jsonb not null default '{}'::jsonb,
    -- Path inside the `recordings` storage bucket, not a local path. The local WAV never leaves
    -- the machine that recorded it; what is uploaded is the Opus copy.
    recording_path      text,
    created_at          timestamptz not null default now()
);

create index if not exists idx_sessions_team on public.sessions(team_id, created_at desc);
create index if not exists idx_sessions_user on public.sessions(user_id, created_at desc);

create table if not exists public.comments (
    id                  uuid primary key default gen_random_uuid(),
    session_id          uuid not null references public.sessions(id) on delete cascade,
    author_id           uuid not null references auth.users(id) on delete cascade,
    -- Seconds into the recording. This is the whole point of uploading one: a coach scrubs to
    -- 4:12 and leaves a note there.
    t_seconds           real not null check (t_seconds >= 0),
    body                text not null check (length(trim(body)) > 0),
    created_at          timestamptz not null default now()
);

create index if not exists idx_comments_session on public.comments(session_id, t_seconds);
