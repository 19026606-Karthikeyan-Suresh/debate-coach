/**
 * PLAN verification step 12, executed rather than described.
 *
 * Two teams, three identities, and a real Postgres. Every assertion that something is hidden is
 * paired with one that the permitted read still works — a policy that denies everything passes
 * half a security test and fails the product.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { errorFrom, startHarness, type PgHarness } from './pgHarness.ts'

/** Fixed ids, so a failure names something a reader can follow. */
const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const CAROL = '33333333-3333-4333-8333-333333333333'

const NORTHSIDE_CASE = 'aaaaaaaa-0000-4000-8000-000000000001'
const ALICE_PRIVATE_CASE = 'aaaaaaaa-0000-4000-8000-000000000002'
const SOUTHSIDE_CASE = 'bbbbbbbb-0000-4000-8000-000000000001'
const NORTHSIDE_SESSION = 'aaaaaaaa-0000-4000-8000-000000000101'
const SOUTHSIDE_SESSION = 'bbbbbbbb-0000-4000-8000-000000000101'

let harness: PgHarness
let northsideId: string
let southsideId: string
let northsideCode: string

/** Inserts a case as whoever is signed in. */
async function insertCase(
  caseId: string,
  teamId: string | null,
  ownerId: string,
  motion: string,
  visibility: 'private' | 'team',
): Promise<void> {
  await harness.query(
    `insert into public.cases (id, team_id, owner_id, motion, format, side, position, doc, visibility)
     values ($1, $2, $3, $4, 'AP', 'gov', 'ap-pm', $5::jsonb, $6)`,
    [caseId, teamId, ownerId, motion, JSON.stringify({ prep: { motion } }), visibility],
  )
}

beforeAll(async () => {
  harness = await startHarness()

  await harness.asPostgres()
  await harness.query(
    'insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)',
    [ALICE, 'alice@example.test', BOB, 'bob@example.test', CAROL, 'carol@example.test'],
  )

  // Alice makes Northside and Bob joins it with the code she reads out.
  await harness.asUser(ALICE)
  const created = await harness.query<{ team_id: string; invite_code: string }>(
    'select * from public.create_team($1, $2)',
    ['Northside', 'Alice'],
  )
  northsideId = created[0]?.team_id ?? ''
  northsideCode = created[0]?.invite_code ?? ''

  await harness.asUser(BOB)
  await harness.query('select public.join_team($1, $2)', [northsideCode, 'Bob'])

  // Carol makes a team of her own, with no connection to Northside.
  await harness.asUser(CAROL)
  const southside = await harness.query<{ team_id: string }>(
    'select * from public.create_team($1, $2)',
    ['Southside', 'Carol'],
  )
  southsideId = southside[0]?.team_id ?? ''

  await harness.asUser(ALICE)
  await insertCase(NORTHSIDE_CASE, northsideId, ALICE, 'THW hold platforms liable', 'team')
  await insertCase(ALICE_PRIVATE_CASE, northsideId, ALICE, 'THW abolish private schools', 'private')
  await harness.query(
    `insert into public.sessions (id, team_id, user_id, case_id, format, role, duration_s, metrics)
     values ($1, $2, $3, $4, 'AP', 'ap-pm', 400, '{"wordsPerMinute":168}'::jsonb)`,
    [NORTHSIDE_SESSION, northsideId, ALICE, NORTHSIDE_CASE],
  )
  await harness.query(
    'insert into public.motions (team_id, created_by, text, tournament) values ($1, $2, $3, $4)',
    [northsideId, ALICE, 'THW hold platforms liable', 'Northside Open'],
  )

  await harness.asUser(CAROL)
  await insertCase(SOUTHSIDE_CASE, southsideId, CAROL, 'THW ban targeted advertising', 'team')
  await harness.query(
    `insert into public.sessions (id, team_id, user_id, case_id, format, role, duration_s, metrics)
     values ($1, $2, $3, $4, 'BP', 'bp-pm', 420, '{"wordsPerMinute":150}'::jsonb)`,
    [SOUTHSIDE_SESSION, southsideId, CAROL, SOUTHSIDE_CASE],
  )
  await harness.query(
    'insert into public.motions (team_id, created_by, text, tournament) values ($1, $2, $3, $4)',
    [southsideId, CAROL, 'THW ban targeted advertising', 'Southside IV'],
  )
}, 120_000)

afterAll(async () => {
  await harness.close()
})

describe('the migrations themselves', () => {
  it('apply to a real Postgres', async () => {
    await harness.asPostgres()
    const tables = await harness.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    )
    expect(tables.map((row) => row.tablename)).toEqual([
      'cases',
      'comments',
      'motions',
      'sessions',
      'team_members',
      'teams',
    ])
  })

  it('leave row-level security on every table', async () => {
    await harness.asPostgres()
    const unprotected = await harness.query<{ tablename: string }>(
      `select tablename from pg_tables
       where schemaname = 'public' and rowsecurity = false
       order by tablename`,
    )
    // A table added later without `enable row level security` is readable by every signed-in
    // user of the project, and nothing else in the migration says so.
    expect(unprotected).toEqual([])
  })
})

describe('joining a team', () => {
  it('makes the creator an admin', async () => {
    await harness.asUser(ALICE)
    const rows = await harness.query<{ role: string }>(
      'select role from public.team_members where team_id = $1 and user_id = $2',
      [northsideId, ALICE],
    )
    expect(rows[0]?.role).toBe('admin')
  })

  it('adds the joiner as a plain member', async () => {
    await harness.asUser(BOB)
    const rows = await harness.query<{ role: string; display_name: string }>(
      'select role, display_name from public.team_members where team_id = $1 and user_id = $2',
      [northsideId, BOB],
    )
    expect(rows[0]).toEqual({ role: 'member', display_name: 'Bob' })
  })

  it('accepts the code as anyone would actually type it', async () => {
    // Lowercase, spaces, no hyphen. A join that fails on punctuation is a join that gets given up
    // on with four minutes of prep left.
    await harness.asUser(CAROL)
    const messy = ` ${northsideCode.replace('-', ' ').toLowerCase()} `
    const joined = await harness.query<{ join_team: string }>('select public.join_team($1, $2)', [
      messy,
      'Carol',
    ])
    expect(joined[0]?.join_team).toBe(northsideId)

    // Undo it — the rest of the suite needs Carol outside Northside.
    await harness.query('delete from public.team_members where team_id = $1 and user_id = $2', [
      northsideId,
      CAROL,
    ])
  })

  it('refuses a code that matches no team', async () => {
    await harness.asUser(CAROL)
    const message = await errorFrom(() =>
      harness.query('select public.join_team($1, $2)', ['ZZZZ-ZZZZ', 'Carol']),
    )
    expect(message).toContain('does not match a team')
  })

  it('refuses a code of the wrong shape without saying which half was wrong', async () => {
    await harness.asUser(CAROL)
    const message = await errorFrom(() =>
      harness.query('select public.join_team($1, $2)', ['nope', 'Carol']),
    )
    expect(message).toContain('not an invite code')
  })

  it('refuses to run for a caller who is not signed in', async () => {
    await harness.asUser(null)
    const message = await errorFrom(() =>
      harness.query('select public.join_team($1, $2)', [northsideCode, 'Nobody']),
    )
    // The grant is the first lock and it is the one that fires: `anon` cannot execute it at all.
    expect(message).toMatch(/permission denied|not signed in/)
  })
})

describe('the invite code itself', () => {
  it('is not readable by a member', async () => {
    await harness.asUser(ALICE)
    const message = await errorFrom(() =>
      harness.query('select invite_code_hash from public.teams where id = $1', [northsideId]),
    )
    // Column-level grant, not a policy: an admin who can read the bcrypt hash can attack an
    // eight-character code offline at their leisure.
    expect(message).toContain('permission denied')
  })

  it('does not come back in a select *', async () => {
    await harness.asUser(ALICE)
    const message = await errorFrom(() =>
      harness.query('select * from public.teams where id = $1', [northsideId]),
    )
    expect(message).toContain('permission denied')
  })

  it('leaves the rest of the team row readable', async () => {
    await harness.asUser(ALICE)
    const rows = await harness.query<{ name: string }>(
      'select id, name, created_at from public.teams where id = $1',
      [northsideId],
    )
    expect(rows[0]?.name).toBe('Northside')
  })
})

describe('two teams cannot see each other', () => {
  it('hides a team row from a non-member', async () => {
    await harness.asUser(CAROL)
    const rows = await harness.query('select id from public.teams where id = $1', [northsideId])
    expect(rows).toEqual([])
  })

  it('hides the other team’s members', async () => {
    await harness.asUser(CAROL)
    const rows = await harness.query('select user_id from public.team_members where team_id = $1', [
      northsideId,
    ])
    expect(rows).toEqual([])
  })

  it('hides cases, and does not hide them from a teammate', async () => {
    await harness.asUser(CAROL)
    expect(await harness.query('select id from public.cases where id = $1', [NORTHSIDE_CASE])).toEqual(
      [],
    )

    await harness.asUser(BOB)
    const visible = await harness.query<{ id: string }>('select id from public.cases where id = $1', [
      NORTHSIDE_CASE,
    ])
    expect(visible[0]?.id).toBe(NORTHSIDE_CASE)
  })

  it('hides sessions, and does not hide them from a teammate', async () => {
    await harness.asUser(CAROL)
    expect(
      await harness.query('select id from public.sessions where id = $1', [NORTHSIDE_SESSION]),
    ).toEqual([])

    await harness.asUser(BOB)
    const visible = await harness.query<{ id: string }>(
      'select id from public.sessions where id = $1',
      [NORTHSIDE_SESSION],
    )
    expect(visible[0]?.id).toBe(NORTHSIDE_SESSION)
  })

  it('hides motions', async () => {
    await harness.asUser(CAROL)
    const rows = await harness.query<{ text: string }>('select text from public.motions')
    expect(rows.map((row) => row.text)).toEqual(['THW ban targeted advertising'])
  })

  it('hides a case even when its id is guessed exactly', async () => {
    // The point of the whole exercise: an id is not a capability.
    await harness.asUser(CAROL)
    const rows = await harness.query(
      'select id, motion, doc from public.cases where id = $1::uuid',
      [NORTHSIDE_CASE],
    )
    expect(rows).toEqual([])
  })

  it('returns nothing at all to an unauthenticated caller', async () => {
    await harness.asUser(null)
    const message = await errorFrom(() => harness.query('select id from public.cases'))
    expect(message).toContain('permission denied')
  })
})

describe('private cases stay private inside a team', () => {
  it('hides a private case from a teammate', async () => {
    await harness.asUser(BOB)
    const rows = await harness.query('select id from public.cases where id = $1', [
      ALICE_PRIVATE_CASE,
    ])
    expect(rows).toEqual([])
  })

  it('leaves it visible to its owner', async () => {
    await harness.asUser(ALICE)
    const rows = await harness.query<{ id: string }>('select id from public.cases where id = $1', [
      ALICE_PRIVATE_CASE,
    ])
    expect(rows[0]?.id).toBe(ALICE_PRIVATE_CASE)
  })

  it('keeps it out of a teammate’s search results', async () => {
    await harness.asUser(BOB)
    const found = await harness.query<{ motion: string }>('select motion from public.search_cases($1)', [
      'private schools',
    ])
    expect(found).toEqual([])
  })
})

describe('what a teammate may not write', () => {
  it('cannot edit someone else’s case', async () => {
    await harness.asUser(BOB)
    await harness.query('update public.cases set motion = $1 where id = $2', [
      'rewritten by Bob',
      NORTHSIDE_CASE,
    ])

    // An update that matches no row under the `using` clause is not an error — it changes
    // nothing, silently. What must not happen is the change landing.
    await harness.asUser(ALICE)
    const rows = await harness.query<{ motion: string }>(
      'select motion from public.cases where id = $1',
      [NORTHSIDE_CASE],
    )
    expect(rows[0]?.motion).toBe('THW hold platforms liable')
  })

  it('cannot delete someone else’s case', async () => {
    await harness.asUser(BOB)
    await harness.query('delete from public.cases where id = $1', [NORTHSIDE_CASE])

    await harness.asUser(ALICE)
    const rows = await harness.query('select id from public.cases where id = $1', [NORTHSIDE_CASE])
    expect(rows).toHaveLength(1)
  })

  it('cannot insert a case owned by somebody else', async () => {
    await harness.asUser(BOB)
    const message = await errorFrom(() =>
      insertCase('cccccccc-0000-4000-8000-000000000001', northsideId, ALICE, 'forged', 'team'),
    )
    expect(message).toContain('row-level security')
  })

  it('cannot insert a case into a team they are not in', async () => {
    await harness.asUser(BOB)
    const message = await errorFrom(() =>
      insertCase('cccccccc-0000-4000-8000-000000000002', southsideId, BOB, 'trespass', 'team'),
    )
    expect(message).toContain('row-level security')
  })

  it('cannot add itself to a team without the code', async () => {
    await harness.asUser(CAROL)
    const message = await errorFrom(() =>
      harness.query('insert into public.team_members (team_id, user_id) values ($1, $2)', [
        northsideId,
        CAROL,
      ]),
    )
    // No insert grant at all on `team_members`: `join_team` is the only door, and it is the
    // thing that checks the code.
    expect(message).toContain('permission denied')
  })
})

describe('coach comments', () => {
  it('let a teammate comment on a session they can see', async () => {
    await harness.asUser(BOB)
    await harness.query(
      'insert into public.comments (session_id, author_id, t_seconds, body) values ($1, $2, $3, $4)',
      [NORTHSIDE_SESSION, BOB, 252, 'The mechanism arrives late here.'],
    )
    const rows = await harness.query<{ body: string }>(
      'select body from public.comments where session_id = $1',
      [NORTHSIDE_SESSION],
    )
    expect(rows[0]?.body).toBe('The mechanism arrives late here.')
  })

  it('hide that comment from the other team', async () => {
    await harness.asUser(CAROL)
    const rows = await harness.query('select id from public.comments')
    expect(rows).toEqual([])
  })

  it('refuse a comment on a session in another team', async () => {
    await harness.asUser(CAROL)
    const message = await errorFrom(() =>
      harness.query(
        'insert into public.comments (session_id, author_id, t_seconds, body) values ($1, $2, $3, $4)',
        [NORTHSIDE_SESSION, CAROL, 10, 'should not land'],
      ),
    )
    expect(message).toContain('row-level security')
  })
})

describe('recordings in storage', () => {
  it('accept an upload under your own team’s folder', async () => {
    await harness.asUser(ALICE)
    await harness.query(
      'insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, $3)',
      ['recordings', `${northsideId}/${NORTHSIDE_SESSION}.opus`, ALICE],
    )
    const rows = await harness.query('select id from storage.objects')
    expect(rows).toHaveLength(1)
  })

  it('let a teammate play it back', async () => {
    await harness.asUser(BOB)
    const rows = await harness.query('select name from storage.objects')
    expect(rows).toHaveLength(1)
  })

  it('hide it from the other team', async () => {
    await harness.asUser(CAROL)
    const rows = await harness.query('select name from storage.objects')
    expect(rows).toEqual([])
  })

  it('refuse an upload into another team’s folder', async () => {
    await harness.asUser(CAROL)
    const message = await errorFrom(() =>
      harness.query('insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, $3)', [
        'recordings',
        `${northsideId}/${SOUTHSIDE_SESSION}.opus`,
        CAROL,
      ]),
    )
    expect(message).toContain('row-level security')
  })

  it('deny rather than error on a path that is not a team id', async () => {
    // `(storage.foldername(name))[1]::uuid` would raise a cast error here, which surfaces as a
    // 500 and is recorded nowhere as an access denial.
    await harness.asUser(ALICE)
    const message = await errorFrom(() =>
      harness.query('insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, $3)', [
        'recordings',
        'not-a-team/whatever.opus',
        ALICE,
      ]),
    )
    expect(message).toContain('row-level security')
    expect(message).not.toContain('invalid input syntax')
  })

  it('refuse a teammate deleting your recording', async () => {
    await harness.asUser(BOB)
    await harness.query('delete from storage.objects')

    await harness.asUser(ALICE)
    expect(await harness.query('select id from storage.objects')).toHaveLength(1)
  })
})

describe('deleting a team', () => {
  /** A throwaway team with one admin, one member, a shared case and a session. */
  async function buildDoomedTeam(): Promise<{ teamId: string; caseId: string }> {
    await harness.asUser(CAROL)
    const created = await harness.query<{ team_id: string; invite_code: string }>(
      'select * from public.create_team($1, $2)',
      ['Doomed', 'Carol'],
    )
    const teamId = created[0]?.team_id ?? ''

    await harness.asUser(BOB)
    await harness.query('select public.join_team($1, $2)', [created[0]?.invite_code, 'Bob'])

    await harness.asUser(CAROL)
    const caseId = `dddddddd-0000-4000-8000-${Math.random().toString(16).slice(2, 14)}`
    await insertCase(caseId, teamId, CAROL, 'THW disband', 'team')
    await harness.query(
      'insert into public.motions (team_id, created_by, text) values ($1, $2, $3)',
      [teamId, CAROL, 'THW disband'],
    )
    return { teamId, caseId }
  }

  it('is refused to a member who is not an admin', async () => {
    const { teamId } = await buildDoomedTeam()
    await harness.asUser(BOB)
    const message = await errorFrom(() => harness.query('select public.delete_team($1)', [teamId]))
    expect(message).toContain('only an admin')

    await harness.asUser(CAROL)
    await harness.query('select public.delete_team($1)', [teamId])
  })

  it('is refused to somebody outside the team', async () => {
    const { teamId } = await buildDoomedTeam()
    await harness.asUser(ALICE)
    const message = await errorFrom(() => harness.query('select public.delete_team($1)', [teamId]))
    expect(message).toContain('only an admin')

    await harness.asUser(CAROL)
    await harness.query('select public.delete_team($1)', [teamId])
  })

  it('removes the team, its members and its motions', async () => {
    const { teamId } = await buildDoomedTeam()
    await harness.asUser(CAROL)
    await harness.query('select public.delete_team($1)', [teamId])

    await harness.asPostgres()
    // As the superuser, so this is "the row is gone" rather than "the policy hides it".
    expect(await harness.query('select id from public.teams where id = $1', [teamId])).toEqual([])
    expect(
      await harness.query('select user_id from public.team_members where team_id = $1', [teamId]),
    ).toEqual([])
    expect(await harness.query('select id from public.motions where team_id = $1', [teamId])).toEqual(
      [],
    )
  })

  it('keeps the cases and hands them back to their owner', async () => {
    const { teamId, caseId } = await buildDoomedTeam()
    await harness.asUser(CAROL)
    const detached = await harness.query<{ delete_team: number }>(
      'select public.delete_team($1)',
      [teamId],
    )
    // The count is what the UI tells the admin: this many cases just stopped being shared.
    expect(detached[0]?.delete_team).toBe(1)

    const survivors = await harness.query<{ team_id: string | null; visibility: string }>(
      'select team_id, visibility from public.cases where id = $1',
      [caseId],
    )
    // A case belongs to whoever wrote it, not to the team it was shared with.
    expect(survivors[0]?.team_id).toBeNull()
    // And "shared with a squad that no longer exists" is not a state worth storing.
    expect(survivors[0]?.visibility).toBe('private')
  })

  it('leaves a teammate unable to see what they could see a moment ago', async () => {
    const { teamId, caseId } = await buildDoomedTeam()
    await harness.asUser(BOB)
    expect(await harness.query('select id from public.cases where id = $1', [caseId])).toHaveLength(1)

    await harness.asUser(CAROL)
    await harness.query('select public.delete_team($1)', [teamId])

    await harness.asUser(BOB)
    expect(await harness.query('select id from public.cases where id = $1', [caseId])).toEqual([])
  })

  it('refuses while a recording would be orphaned by it', async () => {
    const { teamId } = await buildDoomedTeam()
    await harness.asUser(CAROL)
    await harness.query(
      'insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, $3)',
      ['recordings', `${teamId}/aaaaaaaa-0000-4000-8000-000000000999.opus`, CAROL],
    )

    // An object under a team that no longer exists fails every storage policy: unplayable and
    // undeletable, stuck in the bucket for good.
    const message = await errorFrom(() => harness.query('select public.delete_team($1)', [teamId]))
    expect(message).toContain('recordings before deleting the team')

    await harness.query('delete from storage.objects where name like $1', [`${teamId}/%`])
    await harness.query('select public.delete_team($1)', [teamId])
  })
})

describe('a team always has an admin', () => {
  it('refuses to let the last admin leave', async () => {
    await harness.asUser(CAROL)
    const created = await harness.query<{ team_id: string }>(
      'select * from public.create_team($1, $2)',
      ['Solo', 'Carol'],
    )
    const teamId = created[0]?.team_id ?? ''

    // Without this, `is_team_admin` finds nobody and the team can never be deleted by anyone —
    // exactly the orphan `delete_team` was added to prevent.
    const message = await errorFrom(() =>
      harness.query('delete from public.team_members where team_id = $1 and user_id = $2', [
        teamId,
        CAROL,
      ]),
    )
    expect(message).toContain('last admin')

    await harness.query('select public.delete_team($1)', [teamId])
  })

  it('lets a plain member leave freely', async () => {
    await harness.asUser(CAROL)
    const created = await harness.query<{ team_id: string; invite_code: string }>(
      'select * from public.create_team($1, $2)',
      ['Pair', 'Carol'],
    )
    const teamId = created[0]?.team_id ?? ''

    await harness.asUser(BOB)
    await harness.query('select public.join_team($1, $2)', [created[0]?.invite_code, 'Bob'])
    await harness.query('delete from public.team_members where team_id = $1 and user_id = $2', [
      teamId,
      BOB,
    ])
    // Asked as Bob, the roster is already empty — leaving revokes the read in the same statement.
    expect(
      await harness.query('select user_id from public.team_members where team_id = $1', [teamId]),
    ).toEqual([])

    await harness.asUser(CAROL)
    expect(
      await harness.query('select user_id from public.team_members where team_id = $1', [teamId]),
    ).toHaveLength(1)
    await harness.query('select public.delete_team($1)', [teamId])
  })

  it('lets an admin leave once they have handed over', async () => {
    await harness.asUser(CAROL)
    const created = await harness.query<{ team_id: string; invite_code: string }>(
      'select * from public.create_team($1, $2)',
      ['Handover', 'Carol'],
    )
    const teamId = created[0]?.team_id ?? ''

    await harness.asUser(BOB)
    await harness.query('select public.join_team($1, $2)', [created[0]?.invite_code, 'Bob'])

    await harness.asUser(CAROL)
    await harness.query(
      "update public.team_members set role = 'admin' where team_id = $1 and user_id = $2",
      [teamId, BOB],
    )
    // The guard is a prompt, not a trap: there is always a way out of it.
    await harness.query('delete from public.team_members where team_id = $1 and user_id = $2', [
      teamId,
      CAROL,
    ])

    await harness.asUser(BOB)
    await harness.query('select public.delete_team($1)', [teamId])
  })

  it('does not block the cascade when the team itself is deleted', async () => {
    // `delete_team` removes the team, which cascades into `team_members` and fires this same
    // trigger on the last admin's own row. Without the "is the team still there" check, deleting
    // a team would raise the error the trigger exists to give.
    await harness.asUser(CAROL)
    const created = await harness.query<{ team_id: string }>(
      'select * from public.create_team($1, $2)',
      ['Cascade', 'Carol'],
    )
    const teamId = created[0]?.team_id ?? ''
    const message = await errorFrom(() => harness.query('select public.delete_team($1)', [teamId]))
    expect(message).toBeNull()

    await harness.asPostgres()
    expect(await harness.query('select id from public.teams where id = $1', [teamId])).toEqual([])
  })
})

describe('rotating the invite code', () => {
  it('is refused to a member who is not an admin', async () => {
    await harness.asUser(BOB)
    const message = await errorFrom(() =>
      harness.query('select public.rotate_invite_code($1)', [northsideId]),
    )
    expect(message).toContain('only an admin')
  })

  it('is refused to somebody outside the team entirely', async () => {
    await harness.asUser(CAROL)
    const message = await errorFrom(() =>
      harness.query('select public.rotate_invite_code($1)', [northsideId]),
    )
    expect(message).toContain('only an admin')
  })

  it('stops the old code working and starts the new one', async () => {
    await harness.asUser(ALICE)
    const rotated = await harness.query<{ rotate_invite_code: string }>(
      'select public.rotate_invite_code($1)',
      [northsideId],
    )
    const freshCode = rotated[0]?.rotate_invite_code ?? ''
    expect(freshCode).not.toBe(northsideCode)

    await harness.asUser(CAROL)
    const staleAttempt = await errorFrom(() =>
      harness.query('select public.join_team($1, $2)', [northsideCode, 'Carol']),
    )
    expect(staleAttempt).toContain('does not match a team')

    const joined = await harness.query<{ join_team: string }>('select public.join_team($1, $2)', [
      freshCode,
      'Carol',
    ])
    expect(joined[0]?.join_team).toBe(northsideId)
  })
})
