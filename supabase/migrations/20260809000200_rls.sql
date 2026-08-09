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
