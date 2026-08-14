-- Debate Coach — the whole team-layer schema, in one paste.
--
-- GENERATED. Do not edit: change a file in supabase/migrations/ and regenerate, which
-- `npx vitest run src/sync` will otherwise fail on. This is the 7 migrations concatenated
-- in filename order and is exactly equivalent to applying them one at a time; the split exists
-- only so `supabase db push` can track them.
--
-- To use: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Then enable anonymous sign-ins: Authentication -> Sign In / Up -> Anonymous sign-ins.
--
-- Safe to run twice. Every statement is IF NOT EXISTS, CREATE OR REPLACE, an idempotent grant,
-- or a policy preceded by DROP POLICY IF EXISTS.

-- ==========================================================================
-- 20260809000100_schema.sql
-- ==========================================================================

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

-- ==========================================================================
-- 20260809000200_rls.sql
-- ==========================================================================

-- Row-level security. Every table, every operation.
--
-- **The membership check has to be a SECURITY DEFINER function, not a subquery.** A policy on
-- `team_members` that selects from `team_members` recurses, and Postgres reports it as
-- "infinite recursion detected in policy" the first time anyone reads the table — not at
-- migration time. `is_team_member` runs as its owner, so the read inside it is not itself
-- filtered, and the recursion never starts.
--
-- **Grants are revoked before they are given.** Supabase's default privileges already grant the
-- `authenticated` role everything on new tables in `public`, so a policy is the second lock on a
-- door that is otherwise open. Revoking first is also the only way to withhold one column:
-- `teams.invite_code_hash` is deliberately outside the column grant below, so a member selecting
-- `*` gets a permission error rather than a bcrypt hash they can attack at their leisure.
--
-- The `anon` role is granted nothing anywhere. Anonymous *sign-in* still produces an
-- `authenticated` JWT — `anon` is the unauthenticated caller, and this app never is one.

grant usage on schema public to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Membership helpers
-- ---------------------------------------------------------------------------

-- Whether the caller belongs to a team.
--
-- `search_path = ''` because a SECURITY DEFINER function that resolves unqualified names can be
-- hijacked by anyone who can create a table in a schema earlier on the caller's path. Everything
-- below is therefore schema-qualified.
create or replace function public.is_team_member(check_team_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
    select exists (
        select 1
        from public.team_members
        where team_members.team_id = check_team_id
          and team_members.user_id = (select auth.uid())
    );
$$;

-- Whether the caller administers a team. Admins revoke members and rotate the invite code.
create or replace function public.is_team_admin(check_team_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
    select exists (
        select 1
        from public.team_members
        where team_members.team_id = check_team_id
          and team_members.user_id = (select auth.uid())
          and team_members.role = 'admin'
    );
$$;

grant execute on function public.is_team_member(uuid) to authenticated;
grant execute on function public.is_team_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- teams
-- ---------------------------------------------------------------------------

alter table public.teams enable row level security;

revoke all on public.teams from anon, authenticated;
-- No `invite_code_hash`, and no insert, update or delete: a team is created by `create_team` and
-- its code changed by `rotate_invite_code`, both of which check what they need to.
grant select (id, name, invite_rotated_at, created_at) on public.teams to authenticated;

drop policy if exists teams_select_own on public.teams;
create policy teams_select_own on public.teams
    for select to authenticated
    using (public.is_team_member(id));

-- ---------------------------------------------------------------------------
-- team_members
-- ---------------------------------------------------------------------------

alter table public.team_members enable row level security;

revoke all on public.team_members from anon, authenticated;
-- Insert is withheld on purpose. The only way into a team is `join_team`, which is what
-- validates the invite code; an insert policy here would be a way in without one.
grant select, update, delete on public.team_members to authenticated;

drop policy if exists team_members_select_teammates on public.team_members;
create policy team_members_select_teammates on public.team_members
    for select to authenticated
    using (public.is_team_member(team_id));

-- Your own display name, or an admin changing anyone's role.
drop policy if exists team_members_update on public.team_members;
create policy team_members_update on public.team_members
    for update to authenticated
    using (user_id = (select auth.uid()) or public.is_team_admin(team_id))
    with check (user_id = (select auth.uid()) or public.is_team_admin(team_id));

-- Leaving, or an admin revoking someone.
drop policy if exists team_members_delete on public.team_members;
create policy team_members_delete on public.team_members
    for delete to authenticated
    using (user_id = (select auth.uid()) or public.is_team_admin(team_id));

-- ---------------------------------------------------------------------------
-- cases
-- ---------------------------------------------------------------------------

alter table public.cases enable row level security;

revoke all on public.cases from anon, authenticated;
grant select, insert, update, delete on public.cases to authenticated;

-- `visibility = 'private'` is the escape hatch the architecture promises: prep you do not want
-- the squad reading stays yours even inside a team.
drop policy if exists cases_select on public.cases;
create policy cases_select on public.cases
    for select to authenticated
    using (
        owner_id = (select auth.uid())
        or (visibility = 'team' and public.is_team_member(team_id))
    );

drop policy if exists cases_insert on public.cases;
create policy cases_insert on public.cases
    for insert to authenticated
    with check (
        owner_id = (select auth.uid())
        and (team_id is null or public.is_team_member(team_id))
    );

-- Only the owner edits, including a coach. A teammate silently rewriting your case an hour
-- before a round is a worse failure than having to ask them for the change.
drop policy if exists cases_update on public.cases;
create policy cases_update on public.cases
    for update to authenticated
    using (owner_id = (select auth.uid()))
    with check (
        owner_id = (select auth.uid())
        and (team_id is null or public.is_team_member(team_id))
    );

drop policy if exists cases_delete on public.cases;
create policy cases_delete on public.cases
    for delete to authenticated
    using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- motions
-- ---------------------------------------------------------------------------

alter table public.motions enable row level security;

revoke all on public.motions from anon, authenticated;
grant select, insert, update, delete on public.motions to authenticated;

drop policy if exists motions_select on public.motions;
create policy motions_select on public.motions
    for select to authenticated
    using (public.is_team_member(team_id));

drop policy if exists motions_insert on public.motions;
create policy motions_insert on public.motions
    for insert to authenticated
    with check (public.is_team_member(team_id) and created_by = (select auth.uid()));

drop policy if exists motions_update on public.motions;
create policy motions_update on public.motions
    for update to authenticated
    using (created_by = (select auth.uid()) or public.is_team_admin(team_id))
    with check (public.is_team_member(team_id));

drop policy if exists motions_delete on public.motions;
create policy motions_delete on public.motions
    for delete to authenticated
    using (created_by = (select auth.uid()) or public.is_team_admin(team_id));

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------

alter table public.sessions enable row level security;

revoke all on public.sessions from anon, authenticated;
grant select, insert, update, delete on public.sessions to authenticated;

-- Teammates see each other's numbers, which is what makes the history screen a squad tool. A
-- session with no `team_id` was recorded outside a team and stays private to its owner.
drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions
    for select to authenticated
    using (
        user_id = (select auth.uid())
        or (team_id is not null and public.is_team_member(team_id))
    );

drop policy if exists sessions_insert on public.sessions;
create policy sessions_insert on public.sessions
    for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and (team_id is null or public.is_team_member(team_id))
    );

drop policy if exists sessions_update on public.sessions;
create policy sessions_update on public.sessions
    for update to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

drop policy if exists sessions_delete on public.sessions;
create policy sessions_delete on public.sessions
    for delete to authenticated
    using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- comments
-- ---------------------------------------------------------------------------

alter table public.comments enable row level security;

revoke all on public.comments from anon, authenticated;
grant select, insert, update, delete on public.comments to authenticated;

-- No helper function here, and that is the point: the subquery reads `sessions`, whose own RLS
-- applies to it, so "a comment you may read" resolves to "a comment on a session you may read"
-- without restating either rule. A SECURITY DEFINER helper would bypass sessions' policy and
-- have to reimplement it.
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments
    for select to authenticated
    using (exists (select 1 from public.sessions where sessions.id = comments.session_id));

drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments
    for insert to authenticated
    with check (
        author_id = (select auth.uid())
        and exists (select 1 from public.sessions where sessions.id = comments.session_id)
    );

drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments
    for update to authenticated
    using (author_id = (select auth.uid()))
    with check (author_id = (select auth.uid()));

drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments
    for delete to authenticated
    using (author_id = (select auth.uid()));

-- ==========================================================================
-- 20260809000300_team_functions.sql
-- ==========================================================================

-- Creating a team, joining one, and rotating the code that lets people in.
--
-- All three are SECURITY DEFINER, because all three do something no RLS policy can express:
-- they read or write `teams.invite_code_hash`, which no client is granted a single column of.
-- The check each one skips is replaced by an explicit check in its body — read those first.
--
-- **Every function here revokes EXECUTE from PUBLIC.** Postgres grants it by default, and a
-- SECURITY DEFINER function callable by an unauthenticated caller is the whole attack. The
-- `auth.uid() is null` guards are the second lock; the grant is the first.
--
-- All bodies run with `search_path = ''`, so every name is schema-qualified. Without it, anyone
-- who can create a function in a schema earlier on the caller's path can shadow one of these
-- calls and have it run as the definer.

-- ---------------------------------------------------------------------------
-- Invite codes
-- ---------------------------------------------------------------------------

-- Generates an invite code in the form `ABCD-EFGH`.
--
-- The alphabet drops 0/O, 1/I/L and U: this gets read off a phone screen across a prep room and
-- typed by someone with four minutes left, so a character pair nobody can tell apart costs more
-- than the two bits it buys. 31^8 is 8.5e11 codes, and every guess costs a bcrypt round.
create or replace function public.generate_invite_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
    alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
    raw bytea := extensions.gen_random_bytes(8);
    code text := '';
    offset_index integer;
begin
    for offset_index in 0..7 loop
        code := code || substr(alphabet, 1 + (get_byte(raw, offset_index) % length(alphabet)), 1);
    end loop;
    return substr(code, 1, 4) || '-' || substr(code, 5, 4);
end;
$$;

revoke execute on function public.generate_invite_code() from public;

-- Puts a typed code into the canonical form the hash was taken of.
--
-- People type invite codes in lowercase, with spaces, or with the hyphen missing. All three are
-- the same code, and a join that fails on punctuation is a join that gets abandoned.
create or replace function public.normalise_invite_code(raw_code text)
returns text
language sql
immutable
set search_path = ''
as $$
    select case
        when length(regexp_replace(upper(coalesce(raw_code, '')), '[^A-Z0-9]', '', 'g')) = 8
        then substr(regexp_replace(upper(raw_code), '[^A-Z0-9]', '', 'g'), 1, 4)
             || '-'
             || substr(regexp_replace(upper(raw_code), '[^A-Z0-9]', '', 'g'), 5, 4)
        else null
    end;
$$;

-- ---------------------------------------------------------------------------
-- create_team
-- ---------------------------------------------------------------------------

-- Creates a team and makes the caller its first admin.
--
-- Returns the plaintext invite code, and this is the only moment it exists in readable form
-- anywhere — only the bcrypt hash is stored, and no client is granted that column. Losing it
-- means rotating rather than recovering.
create or replace function public.create_team(team_name text, display_name text default '')
returns table (team_id uuid, invite_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller uuid := (select auth.uid());
    fresh_code text;
    fresh_id uuid;
begin
    if caller is null then
        raise exception 'not signed in' using errcode = '42501';
    end if;
    if length(trim(coalesce(team_name, ''))) = 0 then
        raise exception 'a team needs a name' using errcode = '22023';
    end if;

    fresh_code := public.generate_invite_code();

    insert into public.teams (name, invite_code_hash)
    values (trim(team_name), extensions.crypt(fresh_code, extensions.gen_salt('bf', 10)))
    returning id into fresh_id;

    insert into public.team_members (team_id, user_id, display_name, role)
    values (fresh_id, caller, trim(coalesce(display_name, '')), 'admin');

    return query select fresh_id, fresh_code;
end;
$$;

revoke execute on function public.create_team(text, text) from public;
grant execute on function public.create_team(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- join_team
-- ---------------------------------------------------------------------------

-- Joins the team an invite code belongs to.
--
-- **Every team has to be tried.** bcrypt salts per row, so the stored hash is not a lookup key
-- and there is nothing to index. At squad scale that is a few dozen hashes on an operation each
-- person performs once; if this ever becomes a shared instance with thousands of teams it wants
-- a public, non-secret lookup prefix on the code rather than a cheaper hash.
--
-- Rejoining a team you are already in succeeds and updates your display name, rather than
-- failing on the primary key — someone re-entering the code has not done anything wrong.
create or replace function public.join_team(invite_code text, display_name text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller uuid := (select auth.uid());
    canonical text;
    matched_id uuid;
    candidate record;
begin
    if caller is null then
        raise exception 'not signed in' using errcode = '42501';
    end if;

    canonical := public.normalise_invite_code(invite_code);
    if canonical is null then
        raise exception 'that is not an invite code' using errcode = '22023';
    end if;

    for candidate in select id, invite_code_hash from public.teams loop
        if candidate.invite_code_hash = extensions.crypt(canonical, candidate.invite_code_hash) then
            matched_id := candidate.id;
            exit;
        end if;
    end loop;

    -- Deliberately the same message as a malformed code: distinguishing "no such team" from
    -- "wrong code" tells someone probing which half of the guess was right.
    if matched_id is null then
        raise exception 'that invite code does not match a team' using errcode = '22023';
    end if;

    insert into public.team_members (team_id, user_id, display_name)
    values (matched_id, caller, trim(coalesce(display_name, '')))
    on conflict (team_id, user_id)
        do update set display_name = excluded.display_name;

    return matched_id;
end;
$$;

revoke execute on function public.join_team(text, text) from public;
grant execute on function public.join_team(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- rotate_invite_code
-- ---------------------------------------------------------------------------

-- Replaces a team's invite code, admin only.
--
-- The remedy for a leaked code, which the architecture assumes will happen: a code gets
-- photographed on a whiteboard or forwarded out of a group chat, and until it is rotated anyone
-- holding it is in the team. Returns the new code once, like `create_team`.
create or replace function public.rotate_invite_code(target_team_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    fresh_code text;
begin
    if not public.is_team_admin(target_team_id) then
        raise exception 'only an admin can rotate the invite code' using errcode = '42501';
    end if;

    fresh_code := public.generate_invite_code();
    update public.teams
       set invite_code_hash = extensions.crypt(fresh_code, extensions.gen_salt('bf', 10)),
           invite_rotated_at = now()
     where teams.id = target_team_id;

    return fresh_code;
end;
$$;

revoke execute on function public.rotate_invite_code(uuid) from public;
grant execute on function public.rotate_invite_code(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Library search
-- ---------------------------------------------------------------------------

-- Full-text search across the cases the caller may read.
--
-- A function rather than a PostgREST filter because `websearch_to_tsquery` turns what someone
-- types — quoted phrases, `or`, a leading minus — into a query, and the alternative is building
-- tsquery syntax in the client from a text box. Not SECURITY DEFINER: it runs as the caller, so
-- `cases`' own policy decides what comes back and this adds no rule of its own.
create or replace function public.search_cases(query text, max_rows integer default 50)
returns table (
    id uuid,
    team_id uuid,
    owner_id uuid,
    motion text,
    format text,
    side text,
    "position" text,
    visibility text,
    updated_at timestamptz,
    rank real
)
language sql
stable
set search_path = ''
as $$
    select cases.id, cases.team_id, cases.owner_id, cases.motion, cases.format, cases.side,
           cases.position, cases.visibility, cases.updated_at,
           ts_rank(cases.search, websearch_to_tsquery('english', query)) as rank
    from public.cases
    where query is not null
      and length(trim(query)) > 0
      and cases.search @@ websearch_to_tsquery('english', query)
    order by rank desc, cases.updated_at desc
    limit least(greatest(coalesce(max_rows, 50), 1), 200);
$$;

revoke execute on function public.search_cases(text, integer) from public;
grant execute on function public.search_cases(text, integer) to authenticated;

-- ==========================================================================
-- 20260809000400_recordings_storage.sql
-- ==========================================================================

-- The `recordings` bucket, and who may put things in it or take them out.
--
-- Objects are named `<team_id>/<session_id>.opus`. The team id is in the path because a storage
-- policy has nothing else to go on: `storage.objects` carries a bucket, a name and an owner, and
-- the only way to ask "does this recording belong to a team you are in" is to read it out of the
-- path. That makes the path a security boundary, which is why `storage_team_id` below refuses to
-- guess at a segment that is not a uuid.
--
-- Private bucket. A public one would serve every recording to anyone holding the URL, and these
-- are recordings of a named person speaking.

insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;

-- The team id an object's path claims, or null if it does not claim one.
--
-- `(storage.foldername(name))[1]::uuid` is the obvious expression and it throws rather than
-- denying: an upload named `whatever/x.opus` raises a cast error out of a policy, which
-- PostgREST reports as a 500 and nothing records as an access denial. This returns null instead,
-- and null fails every membership check below.
create or replace function public.storage_team_id(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
    select case
        when (storage.foldername(object_name))[1]
             ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then ((storage.foldername(object_name))[1])::uuid
        else null
    end;
$$;

grant execute on function public.storage_team_id(text) to authenticated;

-- Uploading. The team in the path has to be one you are in, and the object has to be yours.
drop policy if exists recordings_insert on storage.objects;
create policy recordings_insert on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'recordings'
        and public.is_team_member(public.storage_team_id(name))
        and owner_id = (select auth.uid())::text
    );

-- Listening. Any teammate, which is the point of uploading it — a coach cannot leave a comment
-- at 4:12 on a recording they cannot play.
drop policy if exists recordings_select on storage.objects;
create policy recordings_select on storage.objects
    for select to authenticated
    using (
        bucket_id = 'recordings'
        and public.is_team_member(public.storage_team_id(name))
    );

-- Replacing and removing stay with whoever recorded it. A teammate deleting your speech is not
-- a squad feature.
drop policy if exists recordings_update on storage.objects;
create policy recordings_update on storage.objects
    for update to authenticated
    using (bucket_id = 'recordings' and owner_id = (select auth.uid())::text)
    with check (bucket_id = 'recordings' and owner_id = (select auth.uid())::text);

drop policy if exists recordings_delete on storage.objects;
create policy recordings_delete on storage.objects
    for delete to authenticated
    using (bucket_id = 'recordings' and owner_id = (select auth.uid())::text);

-- ==========================================================================
-- 20260809000500_delete_team.sql
-- ==========================================================================

-- Deleting a team.
--
-- The counterpart `create_team` never had. Without it a team whose last member leaves is an
-- unreachable row: there is no delete grant on `teams` and no function, so nothing can ever
-- remove it. Found by verifying phase 9 against a real project, which left three behind.
--
-- **Explicit and admin-only, rather than automatic when the last member leaves.** A squad of one
-- between tournaments is a normal state, and a team that evaporates because everyone happened to
-- leave for a week takes its invite code with it — everyone has to be re-invited to a new one.
-- Deleting is rare and destructive, so it is a thing somebody decides.
--
-- A separate migration rather than an edit to `20260809000300_team_functions.sql`, because that
-- file has been applied and `supabase db push` tracks what it has run. It also has to come after
-- the storage migration: the guard below reads `storage.objects`.

-- Removes a team, detaching what belongs to people rather than to the team.
--
-- What goes: the team row, its membership rows (cascade), and its motions (cascade) — a motion
-- list is squad property and there is nobody left to own it.
--
-- What stays: cases and sessions, which belong to the debaters who wrote them. Their `team_id`
-- becomes null by the foreign key. Cases that were shared are additionally set back to `private`
-- in the same call: a case marked "shared with the squad" whose squad no longer exists is shared
-- with nobody, and leaving the flag set stores a claim the row cannot support. This is the same
-- correction `caseToRemoteRow` makes on the way up when there is no active team.
--
-- Recordings are refused rather than orphaned. An object under `<team_id>/` whose team is gone
-- fails every storage policy, so nobody can play it and nobody can delete it — the file is stuck
-- in the bucket for good. Nothing uploads recordings yet, so this cannot fire today; it is here
-- so that when phase 10 does, the order is forced rather than discovered.
create or replace function public.delete_team(target_team_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    detached integer;
begin
    if not public.is_team_admin(target_team_id) then
        raise exception 'only an admin can delete a team' using errcode = '42501';
    end if;

    if exists (
        select 1 from storage.objects
        where storage.objects.bucket_id = 'recordings'
          and public.storage_team_id(storage.objects.name) = target_team_id
    ) then
        raise exception 'delete this team''s recordings before deleting the team'
            using errcode = '2BP01';
    end if;

    -- Before the delete, while `team_id` still points at this team.
    update public.cases
       set visibility = 'private'
     where cases.team_id = target_team_id
       and cases.visibility = 'team';
    get diagnostics detached = row_count;

    delete from public.teams where teams.id = target_team_id;

    return detached;
end;
$$;

revoke execute on function public.delete_team(uuid) from public;
grant execute on function public.delete_team(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Keeping a team reachable
-- ---------------------------------------------------------------------------

-- Refuses the delete that would leave a team with no admin.
--
-- `delete_team` above is admin-only, and `is_team_admin` reads a membership row — so a team whose
-- last admin has *left* cannot be deleted by anybody, ever. Adding the delete function without
-- this trigger fixes the hole and leaves the button next to it still digging one: Leave and
-- Delete sit side by side in the same panel.
--
-- The invariant is therefore "every team has at least one admin", enforced on the way out rather
-- than repaired afterwards. Handing over is possible — `team_members_update` lets an admin change
-- anyone's role — so this is never a trap, only a prompt.
--
-- The `teams` check is the escape hatch that makes `delete_team` work at all: deleting the team
-- cascades into these rows, and by the time this trigger runs the parent is already gone within
-- the transaction. Without it, deleting a team would raise the very error this exists to give.
create or replace function public.prevent_last_admin_leaving()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if old.role <> 'admin' then
        return old;
    end if;

    if not exists (select 1 from public.teams where teams.id = old.team_id) then
        return old;
    end if;

    if exists (
        select 1
        from public.team_members
        where team_members.team_id = old.team_id
          and team_members.user_id <> old.user_id
          and team_members.role = 'admin'
    ) then
        return old;
    end if;

    raise exception 'you are the last admin of this team — make someone else an admin, or delete the team'
        using errcode = '2BP01';
end;
$$;

create or replace trigger team_members_keep_an_admin
    before delete on public.team_members
    for each row execute function public.prevent_last_admin_leaving();

-- ==========================================================================
-- 20260809000600_coprep_rooms.sql
-- ==========================================================================

-- Who may join a live co-prep room.
--
-- A Realtime broadcast channel is **public by default**: any client holding the anon key can
-- subscribe to any topic, and the anon key ships inside the app. A room named after a case would
-- therefore be a live feed of a squad's prep — every keystroke, as it is typed — to anyone who
-- guessed a case id. `private: true` on the channel turns that off and routes the join through
-- row-level security on `realtime.messages`, which is what this migration writes.
--
-- **The predicate is deliberately `cases_select`'s, not `cases_update`'s.** Reading a case and
-- co-prepping it are the same permission: a teammate who can open your shared case in the
-- library can sit in the room for it. Writing the *row* stays owner-only, and that is not a
-- contradiction — the room is a shared document, the row is one person's copy of it, and the
-- owner's install is what persists the snapshot. This is the answer phase 9 deferred when it
-- wrote "two writers on one document is phase 11's problem and Yjs is its answer, not a second
-- write policy".
--
-- A consequence worth stating plainly, because it is the first thing anyone hits: **a private
-- case has no room.** Only its owner can join, so co-prep on it is a room of one. The panel says
-- so and offers the visibility switch, rather than reporting a channel error.
--
-- `realtime.messages` is created and RLS-enabled by Supabase itself, so this migration only adds
-- policies to it. The test harness stubs the same two objects Supabase supplies — the table and
-- `realtime.topic()` — exactly as it already stubs `storage`.

-- The case a room's topic names, or null if it does not name one.
--
-- `substring(...)::uuid` on a loose pattern is the trap `storage_team_id` already documents: a
-- topic of `case:------------------------------------` matches "36 characters of hex and dash"
-- and then raises a cast error *out of a policy*, which PostgREST reports as a 500 and nothing
-- records as an access denial. The pattern below is the uuid layout itself, so anything it
-- matches is castable and anything it does not returns null — and null joins to no case.
create or replace function public.room_case_id(topic text)
returns uuid
language sql
immutable
set search_path = ''
as $$
    select case
        when topic ~ '^case:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then (substring(topic from 6))::uuid
        else null
    end;
$$;

grant execute on function public.room_case_id(text) to authenticated;

-- Whether the caller may be in the room for a topic.
--
-- SECURITY DEFINER for the reason `is_team_member` is: it reads `public.cases`, and a policy on
-- `realtime.messages` that did so directly would be filtered by `cases_select` — which is the
-- same answer here, but only by coincidence, and relying on a coincidence in an access check is
-- how the next change to `cases_select` silently opens or closes every room.
create or replace function public.can_join_case_room(topic text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
    select exists (
        select 1
        from public.cases
        where cases.id = public.room_case_id(topic)
          and (
              cases.owner_id = (select auth.uid())
              or (cases.visibility = 'team' and public.is_team_member(cases.team_id))
          )
    );
$$;

grant execute on function public.can_join_case_room(text) to authenticated;

-- Receiving. `realtime.topic()` is the channel the caller is asking about.
drop policy if exists realtime_case_room_read on realtime.messages;
create policy realtime_case_room_read on realtime.messages
    for select to authenticated
    using (public.can_join_case_room(realtime.topic()));

-- Sending. Same predicate: in a room, or not in it. There is no read-only seat, because a
-- teammate who can see the document can already copy it, and a co-prep room with silent
-- observers is a worse thing to have built than one without them.
drop policy if exists realtime_case_room_write on realtime.messages;
create policy realtime_case_room_write on realtime.messages
    for insert to authenticated
    with check (public.can_join_case_room(realtime.topic()));

-- ==========================================================================
-- 20260814000700_web_storage.sql
-- ==========================================================================

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
