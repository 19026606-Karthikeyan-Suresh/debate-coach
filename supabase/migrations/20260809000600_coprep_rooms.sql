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
