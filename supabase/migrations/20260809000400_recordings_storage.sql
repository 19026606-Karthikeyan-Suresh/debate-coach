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
