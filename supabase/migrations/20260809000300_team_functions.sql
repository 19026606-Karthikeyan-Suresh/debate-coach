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
