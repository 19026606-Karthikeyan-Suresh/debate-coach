-- What stands between the Anthropic key and a bill.
--
-- On the desktop the key sits in the Rust process and the only caller is the person at the
-- keyboard. On the web it sits in a serverless function behind a public URL, and anonymous
-- sign-up is unlimited by design — so "verify the caller" is necessary and nowhere near
-- sufficient. Anyone can mint an identity; what they cannot do is mint an unlimited number of
-- coaching calls under one.
--
-- A daily counter per `auth.uid()`, claimed atomically before the request goes out.

create table if not exists public.coach_usage (
    user_id     uuid not null references auth.users(id) on delete cascade,
    -- UTC rather than the caller's day. A client-supplied date is a client-supplied reset button.
    usage_date  date not null default ((now() at time zone 'utc')::date),
    calls       integer not null default 0 check (calls >= 0),
    updated_at  timestamptz not null default now(),
    primary key (user_id, usage_date)
);

alter table public.coach_usage enable row level security;

-- Read-only to the caller, and not writable at all. Supabase grants `authenticated` everything on
-- a new table in `public`, so the revoke comes first — without it the cap is a number the person
-- being capped may edit. `claim_coach_call` below is the only writer, and it is SECURITY DEFINER
-- precisely so the grant can stay withheld.
revoke all on public.coach_usage from anon, authenticated;
grant select on public.coach_usage to authenticated;

drop policy if exists coach_usage_select on public.coach_usage;
create policy coach_usage_select on public.coach_usage
    for select to authenticated
    using (user_id = (select auth.uid()));

-- Claims one coaching call against today's allowance.
--
-- SECURITY DEFINER with an empty `search_path` and fully-qualified names, which is the phase 9
-- rule rather than a flourish: a definer function that resolves an unqualified name through the
-- caller's `search_path` runs whatever the caller put there.
--
-- The whole check-and-increment is one statement. Two calls arriving together must not both read
-- the same count and both decide they are under the cap — `on conflict do update` makes the read
-- and the write a single atomic row operation, and the `where` clause is what refuses rather than
-- a branch around it.
create or replace function public.claim_coach_call(daily_limit integer)
returns table (allowed boolean, calls integer, limit_per_day integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller uuid := (select auth.uid());
    today date := ((now() at time zone 'utc')::date);
    claimed integer;
begin
    if caller is null then
        raise exception 'not signed in';
    end if;
    if daily_limit is null or daily_limit < 1 then
        raise exception 'daily_limit must be at least 1';
    end if;

    insert into public.coach_usage as usage (user_id, usage_date, calls, updated_at)
    values (caller, today, 1, now())
    on conflict (user_id, usage_date) do update
        set calls = usage.calls + 1, updated_at = now()
        where usage.calls < daily_limit
    returning usage.calls into claimed;

    if claimed is null then
        -- The `where` refused the update, so no row came back. The caller is at the cap; report
        -- the count they already have rather than a bare denial, so the panel can say how many.
        return query
            select false,
                   coalesce((select usage.calls from public.coach_usage as usage
                             where usage.user_id = caller and usage.usage_date = today), 0),
                   daily_limit;
        return;
    end if;

    return query select true, claimed, daily_limit;
end;
$$;

revoke all on function public.claim_coach_call(integer) from public, anon;
grant execute on function public.claim_coach_call(integer) to authenticated;
