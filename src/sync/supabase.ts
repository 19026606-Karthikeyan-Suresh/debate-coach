/**
 * The Supabase client, the identity it signs in as, and every query that crosses the network.
 *
 * **Nothing here is reachable without a configured project.** `getSupabase` returns null on a
 * build with no `.env`, and every function below either takes a client or throws a message meant
 * to be shown. That is the shape the local-first promise takes in code: the team layer is a
 * branch the rest of the app never has to enter.
 *
 * **Sign-in is anonymous and permanent.** It buys a real, stable `auth.uid()` — so an edit is
 * attributable, a recording belongs to somebody, and presence will work in phase 11 — while
 * onboarding a squad before a tournament stays "type this code". The cost is that the app cannot
 * verify who anyone actually is, which is why an invite code can be rotated and an admin can
 * revoke a member.
 */

import { createClient, type SupabaseClient, type SupportedStorage } from '@supabase/supabase-js'
import { invoke } from '@tauri-apps/api/core'

import type { Case } from '../types/case.ts'
import type { SpeechComment } from '../speech/comments.ts'
import { supabaseConfig } from './config.ts'
import {
  bytesToPgHex,
  pgHexToBytes,
  remoteRowToCase,
  remoteRowToComment,
  remoteRowToTeamCase,
  remoteRowToTeamSession,
  type RemoteCaseRow,
  type RemoteCommentRow,
  type RemoteLibraryRow,
  type RemoteSessionRow,
  type RemoteTeamSessionRow,
  type TeamCaseSummary,
  type TeamSessionSummary,
} from './rows.ts'

/** The bucket recordings live in. Private; every read goes through a policy. */
export const RECORDINGS_BUCKET = 'recordings'

/** Whether the Tauri IPC exists. False in a browser, which is how the UI is driven in dev. */
function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * supabase-js's storage, backed by the OS credential store.
 *
 * The library asks for several keys — the session, and a PKCE verifier during sign-in — so the
 * one credential blob holds a JSON map rather than a bare value. Outside the Tauri shell it
 * degrades to memory, which means a browser dev session signs in again on reload and never
 * writes a refresh token to a file.
 */
function credentialStorage(): SupportedStorage {
  const fallback = new Map<string, string>()

  const readAll = async (): Promise<Record<string, string>> => {
    if (!hasTauri()) {
      return Object.fromEntries(fallback)
    }
    const stored = await invoke<string | null>('sync_session_get')
    if (stored === null || stored.length === 0) {
      return {}
    }
    try {
      return JSON.parse(stored) as Record<string, string>
    } catch {
      // A blob that will not parse is a half-written save. Treating it as empty costs a
      // sign-in; treating it as a session costs an unexplainable auth failure.
      return {}
    }
  }

  const writeAll = async (values: Record<string, string>): Promise<void> => {
    if (!hasTauri()) {
      fallback.clear()
      for (const [key, value] of Object.entries(values)) {
        fallback.set(key, value)
      }
      return
    }
    const hasAny = Object.keys(values).length > 0
    await invoke('sync_session_set', { session: hasAny ? JSON.stringify(values) : '' })
  }

  return {
    getItem: async (key: string) => (await readAll())[key] ?? null,
    setItem: async (key: string, value: string) => {
      await writeAll({ ...(await readAll()), [key]: value })
    },
    removeItem: async (key: string) => {
      const { [key]: _removed, ...rest } = await readAll()
      await writeAll(rest)
    },
  }
}

// One client per process. Two would each keep their own auto-refresh timer against the same
// credential entry and race each other writing it back.
let clientHandle: SupabaseClient | null = null

/**
 * The client, or null when this build has no project.
 *
 * @returns The shared client. Null is the ordinary state of a clone with no `.env` and must be
 *   treated as "the team layer is off", never reported as a failure.
 */
export function getSupabase(): SupabaseClient | null {
  if (clientHandle) {
    return clientHandle
  }
  const config = supabaseConfig()
  if (!config) {
    return null
  }
  clientHandle = createClient(config.url, config.anonKey, {
    auth: {
      storage: credentialStorage(),
      persistSession: true,
      autoRefreshToken: true,
      // No URL to parse in a desktop shell, and leaving it on makes supabase-js read
      // `window.location` on every construction.
      detectSessionInUrl: false,
    },
  })
  return clientHandle
}

/** Turns a PostgREST error into something worth showing. */
function fail(action: string, message: string): never {
  throw new Error(`${action}: ${message}`)
}

/**
 * Signs in anonymously, or resumes the stored session.
 *
 * @param client - The client from {@link getSupabase}.
 * @returns This install's `auth.uid()`, stable across launches for as long as the credential
 *   store keeps the session.
 * @throws If the project refuses anonymous sign-in. That is a project setting rather than a
 *   code fault, and the message says so.
 */
export async function ensureSignedIn(client: SupabaseClient): Promise<string> {
  const existing = await client.auth.getSession()
  const current = existing.data.session?.user.id
  if (current) {
    return current
  }

  const created = await client.auth.signInAnonymously()
  if (created.error) {
    fail('could not sign in', created.error.message)
  }
  const userId = created.data.user?.id
  if (!userId) {
    fail('could not sign in', 'the project returned no user')
  }
  return userId
}

/** One team this install belongs to. */
export interface TeamMembership {
  readonly teamId: string
  readonly name: string
  readonly role: 'member' | 'coach' | 'admin'
  readonly displayName: string
}

/** Row shape of the membership query, with the team name embedded. */
interface MembershipRow {
  team_id: string
  role: TeamMembership['role']
  display_name: string
  teams: { name: string } | { name: string }[] | null
}

/**
 * Lists the teams this identity is in.
 *
 * @param client - The client.
 * @returns Memberships, in join order. Empty is normal — most installs are in one team or none.
 * @throws If the query fails.
 */
export async function myTeams(client: SupabaseClient): Promise<TeamMembership[]> {
  const userId = await ensureSignedIn(client)
  const { data, error } = await client
    .from('team_members')
    .select('team_id, role, display_name, teams(name)')
    .eq('user_id', userId)
    .order('joined_at')

  if (error) {
    fail('could not list your teams', error.message)
  }

  return (data as MembershipRow[]).map((row) => {
    // PostgREST embeds a to-one relation as an object, but returns an array when its schema
    // cache cannot prove the cardinality. Both shapes appear against the same schema depending
    // on when the cache was last reloaded.
    const team = Array.isArray(row.teams) ? row.teams[0] : row.teams
    return {
      teamId: row.team_id,
      name: team?.name ?? 'Unnamed team',
      role: row.role,
      displayName: row.display_name,
    }
  })
}

/**
 * Creates a team and returns its invite code.
 *
 * @param client - The client.
 * @param name - Team name. Blank is refused by the function, not here.
 * @param displayName - How this debater appears to teammates.
 * @returns The new team's id and its plaintext invite code. **The code is shown once**: only a
 *   bcrypt hash is stored, and no client is granted that column, so losing it means rotating.
 * @throws If the call fails.
 */
export async function createTeam(
  client: SupabaseClient,
  name: string,
  displayName: string,
): Promise<{ teamId: string; inviteCode: string }> {
  await ensureSignedIn(client)
  const { data, error } = await client.rpc('create_team', {
    team_name: name,
    display_name: displayName,
  })
  if (error) {
    fail('could not create the team', error.message)
  }
  const row = (data as { team_id: string; invite_code: string }[] | null)?.[0]
  if (!row) {
    fail('could not create the team', 'the project returned no team')
  }
  return { teamId: row.team_id, inviteCode: row.invite_code }
}

/**
 * Joins a team with an invite code.
 *
 * @param client - The client.
 * @param inviteCode - As typed. Case, spacing and the hyphen are all normalised server-side, so
 *   there is nothing to clean up here.
 * @param displayName - How this debater appears to teammates.
 * @returns The team's id.
 * @throws With the function's own message when the code matches no team — deliberately the same
 *   message as a malformed code, so a probe learns nothing from which one it got.
 */
export async function joinTeam(
  client: SupabaseClient,
  inviteCode: string,
  displayName: string,
): Promise<string> {
  await ensureSignedIn(client)
  const { data, error } = await client.rpc('join_team', {
    invite_code: inviteCode,
    display_name: displayName,
  })
  if (error) {
    fail('could not join', error.message)
  }
  return data as string
}

/**
 * Issues a new invite code, invalidating the old one. Admins only.
 *
 * @param client - The client.
 * @param teamId - Team to rotate.
 * @returns The new code, shown once.
 * @throws If the caller is not an admin of that team.
 */
export async function rotateInviteCode(client: SupabaseClient, teamId: string): Promise<string> {
  const { data, error } = await client.rpc('rotate_invite_code', { target_team_id: teamId })
  if (error) {
    fail('could not rotate the code', error.message)
  }
  return data as string
}

/**
 * Leaves a team.
 *
 * @param client - The client.
 * @param teamId - Team to leave. Cases already pushed keep their `team_id`; what changes is that
 *   this identity stops being able to read them.
 * @throws If the delete fails.
 */
export async function leaveTeam(client: SupabaseClient, teamId: string): Promise<void> {
  const userId = await ensureSignedIn(client)
  const { error } = await client
    .from('team_members')
    .delete()
    .eq('team_id', teamId)
    .eq('user_id', userId)
  if (error) {
    fail('could not leave the team', error.message)
  }
}

/**
 * Deletes a team. Admins only.
 *
 * Cases and sessions survive — they belong to whoever wrote them — and any case that was shared
 * with this team is set back to private, because shared with a squad that no longer exists is
 * shared with nobody.
 *
 * @param client - The client.
 * @param teamId - Team to delete.
 * @returns How many of the caller's shared cases stopped being shared, so the panel can say so
 *   rather than leaving them to discover it.
 * @throws If the caller is not an admin, or if the team still has recordings in storage — those
 *   would become unreachable, and the function refuses rather than orphaning them.
 */
export async function deleteTeam(client: SupabaseClient, teamId: string): Promise<number> {
  const { data, error } = await client.rpc('delete_team', { target_team_id: teamId })
  if (error) {
    fail('could not delete the team', error.message)
  }
  return typeof data === 'number' ? data : 0
}

/**
 * Uploads one case.
 *
 * @param client - The client.
 * @param row - From `caseToRemoteRow`.
 * @throws If the upsert is rejected. A row whose `owner_id` is not the caller comes back as an
 *   RLS violation rather than silently landing.
 */
export async function pushCase(client: SupabaseClient, row: RemoteCaseRow): Promise<void> {
  const { error } = await client.from('cases').upsert(row, { onConflict: 'id' })
  if (error) {
    fail('could not upload a case', error.message)
  }
}

/**
 * Uploads one session's metrics.
 *
 * @param client - The client.
 * @param row - From `sessionToRemoteRow`.
 * @throws If the upsert is rejected.
 */
export async function pushSession(client: SupabaseClient, row: RemoteSessionRow): Promise<void> {
  const { error } = await client.from('sessions').upsert(row, { onConflict: 'id' })
  if (error) {
    fail('could not upload a session', error.message)
  }
}

/**
 * Deletes a row that was deleted locally.
 *
 * @param client - The client.
 * @param table - `cases`, `sessions` or `comments`.
 * @param rowId - Primary key. Deleting a row that is not there succeeds — RLS makes "not yours"
 *   and "not there" the same answer, and both mean the intent is already satisfied.
 * @throws If the delete errors for any other reason.
 */
export async function deleteRemoteRow(
  client: SupabaseClient,
  table: 'cases' | 'sessions' | 'comments',
  rowId: string,
): Promise<void> {
  const { error } = await client.from(table).delete().eq('id', rowId)
  if (error) {
    fail(`could not delete from ${table}`, error.message)
  }
}

/** Looks up display names for a team, so a library listing can say whose case it is. */
async function memberNames(
  client: SupabaseClient,
  teamId: string,
): Promise<ReadonlyMap<string, string>> {
  const { data, error } = await client
    .from('team_members')
    .select('user_id, display_name')
    .eq('team_id', teamId)
  if (error) {
    fail('could not read the team roster', error.message)
  }
  return new Map(
    (data as { user_id: string; display_name: string }[]).map((row) => [
      row.user_id,
      row.display_name,
    ]),
  )
}

/**
 * Lists the cases a team has shared.
 *
 * Only what RLS already permits — `visibility = 'team'` is in the query for clarity, but the
 * policy is what enforces it, and a teammate's private case is not returned even if this filter
 * were dropped.
 *
 * @param client - The client.
 * @param teamId - Team to list.
 * @param excludeOwnerId - Usually this install's own uid, so the debater's own cases are not
 *   listed twice; pass null to include everyone.
 * @returns Summaries, most recently updated first.
 * @throws If the query fails.
 */
export async function fetchTeamLibrary(
  client: SupabaseClient,
  teamId: string,
  excludeOwnerId: string | null,
): Promise<TeamCaseSummary[]> {
  let query = client
    .from('cases')
    .select('id, team_id, owner_id, motion, format, side, position, updated_at')
    .eq('team_id', teamId)
    .eq('visibility', 'team')
    .order('updated_at', { ascending: false })
    .limit(200)

  if (excludeOwnerId !== null) {
    query = query.neq('owner_id', excludeOwnerId)
  }

  const { data, error } = await query
  if (error) {
    fail('could not read the team library', error.message)
  }

  const names = await memberNames(client, teamId)
  return (data as RemoteLibraryRow[]).map((row) =>
    remoteRowToTeamCase(row, names.get(row.owner_id) ?? ''),
  )
}

/**
 * Full-text search across every case the caller may read.
 *
 * Server-side, over the generated `tsvector`, so it reaches the text inside a case rather than
 * only its motion line. The offline path in `store.ts` cannot do that and the UI says so.
 *
 * @param client - The client.
 * @param teamId - Team whose roster supplies the names.
 * @param query - What the debater typed. Passed to `websearch_to_tsquery`, so quoted phrases and
 *   a leading minus work the way they do in a search box.
 * @returns Matches, best first.
 * @throws If the call fails.
 */
export async function searchRemoteCases(
  client: SupabaseClient,
  teamId: string,
  query: string,
): Promise<TeamCaseSummary[]> {
  const { data, error } = await client.rpc('search_cases', { query, max_rows: 50 })
  if (error) {
    fail('could not search the library', error.message)
  }
  const names = await memberNames(client, teamId)
  return (data as RemoteLibraryRow[]).map((row) =>
    remoteRowToTeamCase(row, names.get(row.owner_id) ?? ''),
  )
}

/**
 * Uploads a speech's Opus copy.
 *
 * `upsert` is on: re-sharing a speech replaces the object rather than failing, which is what
 * somebody who re-recorded expects. The insert policy checks the team in the path and that the
 * owner is the caller, so a key built for another team comes back as a policy violation rather
 * than landing somewhere a teammate can read.
 *
 * @param client - The client.
 * @param objectKey - From `recordingObjectKey`. The first segment must be a team this identity is
 *   in; anything else is refused by the policy, including a key with no uuid in it at all.
 * @param bytes - The `.opus` file, whole. Not streamed: a seven-minute speech is about 1.2 MB,
 *   which is one request.
 * @throws If the upload is rejected.
 */
export async function uploadRecording(
  client: SupabaseClient,
  objectKey: string,
  bytes: Uint8Array,
): Promise<void> {
  const { error } = await client.storage
    .from(RECORDINGS_BUCKET)
    .upload(objectKey, new Blob([bytes as BlobPart], { type: 'audio/ogg' }), {
      contentType: 'audio/ogg',
      upsert: true,
    })
  if (error) {
    fail('could not upload the recording', error.message)
  }
}

/**
 * Downloads a teammate's recording.
 *
 * @param client - The client.
 * @param objectKey - As stored on the session row.
 * @returns The file's bytes.
 * @throws If the object is missing or this identity may not read it. Those two are deliberately
 *   the same message from the server — a 403 would confirm the file exists — so the error here
 *   says both.
 */
export async function downloadRecording(
  client: SupabaseClient,
  objectKey: string,
): Promise<Uint8Array> {
  const { data, error } = await client.storage.from(RECORDINGS_BUCKET).download(objectKey)
  if (error || !data) {
    fail(
      'could not open that recording',
      error?.message ?? 'it is not there, or not shared with you',
    )
  }
  return new Uint8Array(await data.arrayBuffer())
}

/**
 * Removes a recording from the bucket.
 *
 * Called when a session is deleted. An object under a team nobody can reach fails every storage
 * policy, which makes it unplayable *and* undeletable — and `delete_team` refuses to run while
 * one exists, so an orphan here blocks a squad from ever closing their team.
 *
 * @param client - The client.
 * @param objectKey - The key to remove. Removing one that is not there succeeds.
 * @throws If the delete errors for any other reason.
 */
export async function deleteRemoteRecording(
  client: SupabaseClient,
  objectKey: string,
): Promise<void> {
  const { error } = await client.storage.from(RECORDINGS_BUCKET).remove([objectKey])
  if (error) {
    fail('could not remove the recording', error.message)
  }
}

/**
 * Uploads one coach comment.
 *
 * @param client - The client.
 * @param row - From `commentToRemoteRow`.
 * @throws If the upsert is rejected — which includes commenting on a session this identity cannot
 *   read, since `comments_insert` resolves that through `sessions`' own policy.
 */
export async function pushComment(
  client: SupabaseClient,
  row: RemoteCommentRow,
): Promise<void> {
  const { error } = await client.from('comments').upsert(row, { onConflict: 'id' })
  if (error) {
    fail('could not post a comment', error.message)
  }
}

/**
 * Deletes a comment.
 *
 * @param client - The client.
 * @param commentId - Primary key. One that is not there, or is somebody else's, succeeds — RLS
 *   makes those indistinguishable and both mean the intent is already satisfied.
 * @throws If the delete errors for any other reason.
 */
export async function deleteRemoteComment(
  client: SupabaseClient,
  commentId: string,
): Promise<void> {
  const { error } = await client.from('comments').delete().eq('id', commentId)
  if (error) {
    fail('could not remove a comment', error.message)
  }
}

/**
 * Reads every comment on one speech.
 *
 * @param client - The client.
 * @param sessionId - The session.
 * @param names - Display names by `auth.uid()`, from {@link fetchTeamRoster}. A missing name
 *   leaves the comment unattributed rather than dropping it.
 * @returns The comments, earliest first.
 * @throws If the query fails.
 */
export async function fetchComments(
  client: SupabaseClient,
  sessionId: string,
  names: ReadonlyMap<string, string>,
): Promise<SpeechComment[]> {
  const { data, error } = await client
    .from('comments')
    .select('id, session_id, author_id, t_seconds, body, created_at')
    .eq('session_id', sessionId)
    .order('t_seconds')
  if (error) {
    fail('could not read the comments', error.message)
  }
  return (data as RemoteCommentRow[]).map((row) =>
    remoteRowToComment(row, names.get(row.author_id) ?? ''),
  )
}

/**
 * Display names for a team, by `auth.uid()`.
 *
 * Exported because both the comment list and the team session list need it, and each of them
 * fetching its own copy would be two roster queries to draw one screen.
 *
 * @param client - The client.
 * @param teamId - Team to read.
 * @returns The roster. Empty when this identity is not in that team, which reads the same as a
 *   team with no names set — both leave the UI unattributed rather than broken.
 * @throws If the query fails.
 */
export async function fetchTeamRoster(
  client: SupabaseClient,
  teamId: string,
): Promise<ReadonlyMap<string, string>> {
  return memberNames(client, teamId)
}

/**
 * Lists the speeches a team has recordings for.
 *
 * Only sessions with a `recording_path`: a teammate's numbers already reach the history screen
 * through sync, and this list exists to answer "which speech can I listen to and comment on".
 *
 * @param client - The client.
 * @param teamId - Team to list.
 * @param excludeUserId - Usually this install's own uid, so a debater's own speeches are not
 *   listed twice; pass null to include everyone.
 * @returns Summaries, most recent first.
 * @throws If the query fails.
 */
export async function fetchTeamSessions(
  client: SupabaseClient,
  teamId: string,
  excludeUserId: string | null,
): Promise<TeamSessionSummary[]> {
  let query = client
    .from('sessions')
    .select('id, user_id, format, role, duration_s, recording_path, created_at, cases(motion)')
    .eq('team_id', teamId)
    .not('recording_path', 'is', null)
    .order('created_at', { ascending: false })
    .limit(100)

  if (excludeUserId !== null) {
    query = query.neq('user_id', excludeUserId)
  }

  const { data, error } = await query
  if (error) {
    fail('could not list the team’s speeches', error.message)
  }

  const names = await memberNames(client, teamId)
  return (data as RemoteTeamSessionRow[]).map((row) =>
    remoteRowToTeamSession(row, names.get(row.user_id) ?? ''),
  )
}

/**
 * Downloads one whole case document.
 *
 * Called when a teammate's case is imported, not when the library is listed: a season of a
 * squad's prep is a lot of JSON to fetch in order to draw a list of motions.
 *
 * @param client - The client.
 * @param caseId - The case to fetch.
 * @returns The case, or null when it is gone or not readable by this identity — RLS makes those
 *   two indistinguishable, which is the point.
 * @throws If the query itself fails.
 */
export async function fetchRemoteCase(
  client: SupabaseClient,
  caseId: string,
): Promise<Case | null> {
  const { data, error } = await client.from('cases').select('*').eq('id', caseId).maybeSingle()
  if (error) {
    fail('could not open that case', error.message)
  }
  return data ? remoteRowToCase(data as RemoteCaseRow) : null
}

/**
 * Stores the room's document so a late joiner needs no peer online.
 *
 * Only the case's owner can write this — `cases_update` grants nobody else — so a guest's
 * install never calls it. That is the right shape rather than a limitation: the owner is the one
 * whose row it is, and a squad where four people race to write one snapshot has four writers on
 * one column for no gain.
 *
 * @param client - The client.
 * @param caseId - The **host's** case id, which is also the room's id.
 * @param state - From `Y.encodeStateAsUpdate`. The whole document, not a delta: a joiner with
 *   nothing has nothing to apply a delta to.
 * @throws If the update is rejected, which for a non-owner is an empty result rather than an
 *   error — so a guest calling this fails silently and correctly.
 */
export async function pushDocState(
  client: SupabaseClient,
  caseId: string,
  state: Uint8Array,
): Promise<void> {
  const { error } = await client
    .from('cases')
    .update({ ydoc_state: bytesToPgHex(state) })
    .eq('id', caseId)
  if (error) {
    fail('could not save the co-prep document', error.message)
  }
}

/**
 * Reads the room's stored document.
 *
 * @param client - The client.
 * @param caseId - The host's case id.
 * @returns The snapshot, or null when there is none, when the case is not readable by this
 *   identity, or when what came back is not a hex literal. All three mean the same thing to the
 *   caller — wait for a peer — and none of them is a failure worth showing.
 * @throws If the query itself fails.
 */
export async function fetchDocState(
  client: SupabaseClient,
  caseId: string,
): Promise<Uint8Array | null> {
  const { data, error } = await client
    .from('cases')
    .select('ydoc_state')
    .eq('id', caseId)
    .maybeSingle()
  if (error) {
    fail('could not open the co-prep document', error.message)
  }
  return pgHexToBytes((data as { ydoc_state: string | null } | null)?.ydoc_state ?? null)
}
