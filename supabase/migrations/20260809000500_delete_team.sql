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
