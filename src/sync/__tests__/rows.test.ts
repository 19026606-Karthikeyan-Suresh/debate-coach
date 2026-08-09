/**
 * What a local row becomes on the way up, and what it deliberately loses.
 *
 * Three of these assertions are privacy rules rather than mapping rules, and they are the reason
 * this module exists as a pure function instead of being inlined into the push.
 */

import { describe, expect, it } from 'vitest'

import { buildFilledExampleCase } from '../../analysis/__tests__/fixture.ts'
import type { SessionSummary } from '../../db/index.ts'
import type { SpeechComment } from '../../speech/comments.ts'
import { summariseSession } from '../../speech/metrics.ts'
import {
  caseToRemoteRow,
  commentToRemoteRow,
  recordingObjectKey,
  remoteRowToCase,
  remoteRowToComment,
  remoteRowToTeamCase,
  remoteRowToTeamSession,
  sessionToRemoteRow,
} from '../rows.ts'

const ALICE = '11111111-1111-4111-8111-111111111111'
const TEAM = 'aaaaaaaa-0000-4000-8000-00000000aaaa'

/**
 * A session as `listSessions` returns it, including a local recording path.
 *
 * @param overrides - Fields to change. Used to give the session a shared recording without
 *   restating the whole row.
 */
function buildSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'ssssssss-0000-4000-8000-000000000001',
    caseId: 'filled-example',
    motion: 'THW hold platforms liable',
    format: 'AP',
    role: 'ap-pm',
    durationSeconds: 402,
    // Built by the real summariser rather than hand-written, so a field added to `SessionMetrics`
    // shows up here as a compile error instead of as a row that uploads with a hole in it.
    metrics: summariseSession({
      durationSeconds: 402,
      scriptWords: 992,
      spokenWords: 980,
      skippedWords: 12,
      skipRate: 0.012,
      improvisedWords: 30,
      fillerCount: 9,
      pauses: [{ startSeconds: 30, endSeconds: 33 }],
      source: 'whisper',
      isAccurate: true,
    }),
    recordingPath: 'C:\\Users\\karti\\AppData\\Roaming\\com.kartixc.debatecoach\\speech.wav',
    recordingObjectPath: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  }
}

describe('caseToRemoteRow', () => {
  it('stamps the identity the local database does not hold', () => {
    const row = caseToRemoteRow(buildFilledExampleCase(), ALICE, TEAM)
    expect(row.owner_id).toBe(ALICE)
    expect(row.team_id).toBe(TEAM)
  })

  it('copies the motion out of the document so the listing does not have to parse it', () => {
    const row = caseToRemoteRow(buildFilledExampleCase(), ALICE, TEAM)
    expect(row.motion).toBe(buildFilledExampleCase().prep.motion)
  })

  it('keeps the timestamps the case already had', () => {
    const caseFile = buildFilledExampleCase()
    const row = caseToRemoteRow(caseFile, ALICE, TEAM)
    expect(row.created_at).toBe(caseFile.createdAt)
    expect(row.updated_at).toBe(caseFile.updatedAt)
  })

  it('pushes a private case too', () => {
    // Supabase is a replication target, so a private case is still backed up — and a session's
    // `case_id` foreign key would not resolve if withheld cases were skipped.
    const caseFile = { ...buildFilledExampleCase(), visibility: 'private' as const }
    expect(caseToRemoteRow(caseFile, ALICE, TEAM).visibility).toBe('private')
  })

  it('refuses to claim a case is shared when there is no team to share it with', () => {
    const caseFile = { ...buildFilledExampleCase(), visibility: 'team' as const }
    const row = caseToRemoteRow(caseFile, ALICE, null)
    expect(row.team_id).toBeNull()
    expect(row.visibility).toBe('private')
  })

  it('round-trips through the download path', () => {
    const original = buildFilledExampleCase()
    const row = caseToRemoteRow(original, ALICE, TEAM)
    expect(remoteRowToCase(row)).toEqual(original)
  })

  it('fills in a block a stored document predates', () => {
    const row = caseToRemoteRow(buildFilledExampleCase(), ALICE, TEAM)
    const older = { ...row, doc: { id: 'old', prep: { motion: 'THW do it' } } } as typeof row
    const restored = remoteRowToCase(older)
    expect(restored.prep.motion).toBe('THW do it')
    expect(restored.definition.meaning).toBe('')
  })
})

describe('sessionToRemoteRow', () => {
  it('never uploads the local recording path', () => {
    // It is a path on one machine, and the middle of it is a person's name. A session with a WAV
    // on disk and nothing in the bucket pushes a null, not the WAV.
    const row = sessionToRemoteRow(buildSession(), ALICE, TEAM, true)
    expect(row.recording_path).toBeNull()
  })

  it('uploads the bucket key once the speech has been shared', () => {
    const shared = buildSession({ recordingObjectPath: `${TEAM}/ssssssss-0000-4000-8000-000000000001.opus` })
    const row = sessionToRemoteRow(shared, ALICE, TEAM, true)
    expect(row.recording_path).toBe(`${TEAM}/ssssssss-0000-4000-8000-000000000001.opus`)
    // Still not the local path, which is the whole reason the two are separate columns.
    expect(row.recording_path).not.toContain('Users')
  })

  it('uploads the metrics and nothing behind them', () => {
    const row = sessionToRemoteRow(buildSession(), ALICE, TEAM, true)
    expect(row.metrics).toEqual(buildSession().metrics)
    // `report` holds the transcript and every clause the debater failed to say. There is no
    // column for it, and the row shape is where that has to be visible.
    expect(Object.keys(row)).not.toContain('report')
  })

  it('drops the case link rather than the whole speech', () => {
    // `sessions.case_id` is a foreign key: a session whose case is not up there takes the row
    // down with it, and the numbers are worth more than the link.
    const row = sessionToRemoteRow(buildSession(), ALICE, TEAM, false)
    expect(row.case_id).toBeNull()
    expect(row.duration_s).toBe(402)
  })

  it('keeps the link when the case is there', () => {
    expect(sessionToRemoteRow(buildSession(), ALICE, TEAM, true).case_id).toBe('filled-example')
  })

  it('stamps the identity and the team', () => {
    const row = sessionToRemoteRow(buildSession(), ALICE, null, true)
    expect(row.user_id).toBe(ALICE)
    expect(row.team_id).toBeNull()
  })
})

describe('remoteRowToTeamCase', () => {
  const row = {
    id: 'cccccccc-0000-4000-8000-000000000001',
    team_id: TEAM,
    owner_id: ALICE,
    motion: 'THW ban targeted advertising',
    format: 'BP' as const,
    side: 'opp' as const,
    position: 'bp-lo',
    updated_at: '2026-08-01T10:00:00.000Z',
  }

  it('names the owner', () => {
    expect(remoteRowToTeamCase(row, 'Alice').ownerName).toBe('Alice')
  })

  it('still lists a case whose owner has no name', () => {
    // A teammate who joined without typing one, or a membership row that did not come back.
    expect(remoteRowToTeamCase(row, '')).toMatchObject({ ownerName: '', motion: row.motion })
  })
})

describe('recordingObjectKey', () => {
  it('puts the team first, because the storage policy reads it out of the path', () => {
    // `storage.objects` carries a bucket, a name and an owner. The only way a policy can ask
    // "is this recording a teammate's" is the first path segment, which makes this a security
    // boundary rather than a filing convention.
    expect(recordingObjectKey(TEAM, 'session-9')).toBe(`${TEAM}/session-9.opus`)
  })
})

describe('commentToRemoteRow', () => {
  const comment: SpeechComment = {
    id: 'dddddddd-0000-4000-8000-000000000001',
    sessionId: 'ssssssss-0000-4000-8000-000000000001',
    authorId: ALICE,
    authorName: 'Alice',
    atSeconds: 252,
    body: 'this rebuttal was rushed',
    createdAt: '2026-08-02T09:00:00.000Z',
    isRemote: false,
  }

  it('keeps the author it already had', () => {
    expect(commentToRemoteRow(comment, 'someone-else').author_id).toBe(ALICE)
  })

  it('stamps the signed-in identity on a note written before this install signed in', () => {
    // `comments_insert` requires `author_id = auth.uid()`. A null here is rejected by the policy,
    // which arrives at drain time as a row that never lands.
    const offline = { ...comment, authorId: null }
    expect(commentToRemoteRow(offline, ALICE).author_id).toBe(ALICE)
  })

  it('sends no display name', () => {
    // The name is denormalised locally so a comment reads offline. Postgres resolves it from the
    // roster, and a second copy on the wire is a second thing that can be wrong.
    expect(Object.keys(commentToRemoteRow(comment, ALICE))).not.toContain('author_name')
  })

  it('round-trips through the download path', () => {
    const round = remoteRowToComment(commentToRemoteRow(comment, ALICE), 'Alice')
    expect(round).toEqual({ ...comment, isRemote: true })
  })

  it('marks a downloaded comment remote so a pull does not push it back', () => {
    expect(remoteRowToComment(commentToRemoteRow(comment, ALICE), '').isRemote).toBe(true)
  })
})

describe('remoteRowToTeamSession', () => {
  const row = {
    id: 'ssssssss-0000-4000-8000-000000000002',
    user_id: ALICE,
    format: 'BP' as const,
    role: 'bp-mg',
    duration_s: 420,
    recording_path: `${TEAM}/ssssssss-0000-4000-8000-000000000002.opus`,
    created_at: '2026-08-02T09:00:00.000Z',
    cases: { motion: 'THW ban targeted advertising' },
  }

  it('reads the motion off the embedded case', () => {
    expect(remoteRowToTeamSession(row, 'Alice').motion).toBe('THW ban targeted advertising')
  })

  it('reads it whichever shape PostgREST returned the embed in', () => {
    // A to-one embed comes back as an object or as a single-element array depending on when the
    // schema cache was last reloaded, not on the schema. `myTeams` carries the same branch.
    const asArray = { ...row, cases: [{ motion: 'THW ban targeted advertising' }] }
    expect(remoteRowToTeamSession(asArray, 'Alice').motion).toBe(row.cases.motion)
  })

  it('lists a speech whose case was never shared', () => {
    // A session is not a case: a debater can share the recording and keep the prep private, and
    // the listing has to survive that rather than dropping the row.
    const noCase = { ...row, cases: null }
    expect(remoteRowToTeamSession(noCase, 'Alice')).toMatchObject({
      motion: '',
      recordingPath: row.recording_path,
    })
  })
})
