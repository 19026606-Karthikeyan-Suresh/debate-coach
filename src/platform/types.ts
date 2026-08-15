/**
 * What a shell has to provide, and nothing about how.
 *
 * Two shells implement this: the Tauri desktop app, whose SQLite database and native commands are
 * the original, and the browser, where Supabase is the source of truth and the OS is out of reach.
 * A build picks one through the `@platform` alias in `vite.config.ts`, keyed off `APP_TARGET`.
 *
 * **Conformance is proved by types, not by the alias.** Each implementation module exports a typed
 * const — `export const database: DatabasePlatform = { ... }` — so both directories are checked
 * against this file on every `tsc --noEmit` whatever the alias currently points at. That matters:
 * the alias only decides what gets bundled, so without the annotation the unselected shell would
 * rot silently until somebody built it.
 *
 * Nothing here is allowed to widen a signature to suit one shell. Where a capability genuinely does
 * not exist — a LAN relay in a browser, a keychain on a web page — it is a flag that the UI reads
 * and says something about, never a method that resolves to nothing and leaves a panel waiting.
 */

import type { SupabaseClient, SupportedStorage } from '@supabase/supabase-js'

import type { CollabLink } from '../collab/session.ts'
import type { CoachPrompt } from '../coach/types.ts'
import type { FormatId, Side } from '../formats/index.ts'
import type { SpeechComment } from '../speech/comments.ts'
import type { Pause, SessionMetrics, TranscriptSegment } from '../speech/metrics.ts'
import type { SpeechReport } from '../speech/report.ts'
import type { SourceChoice } from '../speech/source.ts'
import type { TeamCaseSummary } from '../sync/rows.ts'
import type { Case, Visibility } from '../types/case.ts'

// ---------------------------------------------------------------------------
// Rows the database hands back
// ---------------------------------------------------------------------------

/** One row of the case list — enough to render the library without parsing every document. */
export interface CaseSummary {
  readonly id: string
  readonly motion: string
  readonly format: FormatId
  readonly side: Side
  readonly position: string
  readonly visibility: Visibility
  readonly updatedAt: string
}

/**
 * One delivered speech, as the history list needs it.
 *
 * The numbers come from the session's stored metrics; the detail behind them is only read when a
 * report is actually opened. A season of sessions is a season of transcripts, and the Review screen
 * should not load them all to draw a chart.
 */
export interface SessionSummary {
  readonly id: string
  /** Null once the case has been deleted. The report still opens; it carries its own copy. */
  readonly caseId: string | null
  /**
   * The case's motion **as it stands now**, so a session is found by the debate it belongs to.
   * Empty when the case is gone — the report's own copy is what survives that.
   */
  readonly motion: string
  readonly format: FormatId
  readonly role: string
  readonly durationSeconds: number
  readonly metrics: SessionMetrics
  /** The local WAV. Null on any source that records nothing, and always null in a browser. */
  readonly recordingPath: string | null
  /**
   * Key inside the `recordings` storage bucket, once the debater has shared this speech.
   *
   * Null is the ordinary state and means "not uploaded", never "upload failed" — a recording goes
   * up when it is asked for, not because a report was generated.
   */
  readonly recordingObjectPath: string | null
  readonly createdAt: string
}

// ---------------------------------------------------------------------------
// The sync queue
// ---------------------------------------------------------------------------

/**
 * Tables that replicate. Nothing else has a Postgres counterpart worth queueing.
 *
 * The order they are declared in is the order they drain in, and it is a foreign-key order:
 * `sessions.case_id` references `cases`, and `comments.session_id` references `sessions`.
 */
export type SyncTable = 'cases' | 'sessions' | 'comments'

/** What happened locally. A delete supersedes an upsert for the same row. */
export type SyncOperation = 'upsert' | 'delete'

/** One dirty row waiting to go up. */
export interface QueueEntry {
  readonly id: number
  readonly table: SyncTable
  readonly rowId: string
  readonly operation: SyncOperation
  /** Failed pushes so far. Drives the backoff and the give-up point. */
  readonly attempts: number
  /** ISO 8601. Rewritten on each failure, so it is "last tried" as much as "first queued". */
  readonly queuedAt: string
  readonly lastError: string | null
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Everything the app stores, behind one object.
 *
 * The signatures are the desktop ones unchanged, because the seam was cut underneath a finished
 * app rather than designed alongside one — every call site in `hooks/`, `components/` and `sync/`
 * keeps working through the facades in `db/index.ts` and `sync/store.ts`.
 *
 * The queue methods are the ones that mean different things on either side. On the desktop they
 * are a real table of dirty rows drained by `sync/engine.ts`; where the database *is* the server,
 * a write is already up and they are inert. Inert rather than absent, so `engine.ts` needs no
 * branch: an empty queue drains to nothing on its own.
 */
export interface DatabasePlatform {
  /**
   * Whether a case can exist before anybody has signed in.
   *
   * False on the desktop, where SQLite is the truth and a debater who never joins a squad never
   * touches the network — signing in at launch there would break the local-first promise for a
   * feature they are not using. True where the truth is Postgres: `cases.owner_id` is `not null
   * references auth.users`, so there is no such thing as an unattributed case and the app has to
   * hold the first screen until an identity exists.
   */
  readonly requiresIdentity: boolean
  saveCase(caseFile: Case): Promise<void>
  loadCase(caseId: string): Promise<Case | null>
  listCases(limit?: number): Promise<CaseSummary[]>
  /**
   * Every case id available to this install.
   *
   * Separate from `listCases` because the importer needs *all* of them and that list is paginated:
   * a `.dbcase` restored over case 101 would overwrite it silently.
   */
  listCaseIds(): Promise<string[]>
  deleteCase(caseId: string): Promise<void>

  saveSession(report: SpeechReport, recordingPath: string | null): Promise<void>
  listSessions(limit?: number): Promise<SessionSummary[]>
  setSessionRecordingObject(sessionId: string, objectPath: string | null): Promise<void>
  loadSessionReport(sessionId: string): Promise<SpeechReport | null>
  deleteSession(sessionId: string): Promise<void>

  listComments(sessionId: string): Promise<SpeechComment[]>
  loadComment(commentId: string): Promise<SpeechComment | null>
  /**
   * Writes a comment.
   *
   * `queueForSync` is false when the comment came *from* the project, so a pull does not push the
   * same row straight back.
   */
  saveComment(comment: SpeechComment, queueForSync?: boolean): Promise<void>
  deleteComment(commentId: string): Promise<void>
  replaceRemoteComments(sessionId: string, comments: readonly SpeechComment[]): Promise<void>

  loadScriptEdits(caseId: string): Promise<Record<string, string>>
  saveScriptEdit(caseId: string, segmentId: string, text: string): Promise<void>
  deleteScriptEdit(caseId: string, segmentId: string): Promise<void>

  enqueueChange(table: SyncTable, rowId: string, operation: SyncOperation): Promise<void>
  queuedChanges(limit?: number): Promise<QueueEntry[]>
  clearQueued(entryId: number): Promise<void>
  recordQueueFailure(entryId: number, message: string): Promise<void>
  backfillQueue(): Promise<number>
  caseExistsLocally(caseId: string | null): Promise<boolean>

  readSetting(key: string): Promise<string | null>
  /** Writes one setting, or removes it when the value is null. */
  writeSetting(key: string, value: string | null): Promise<void>

  cacheTeamLibrary(teamId: string, entries: readonly TeamCaseSummary[]): Promise<void>
  cachedTeamLibrary(teamId: string, query?: string): Promise<TeamCaseSummary[]>
  findLocalCaseForRoom(roomCaseId: string): Promise<string | null>
}

// ---------------------------------------------------------------------------
// Layer B
// ---------------------------------------------------------------------------

/** Whether Layer B can run, and where its key came from. */
export interface CoachStatus {
  readonly hasKey: boolean
  /** Where the key was read. Empty when there is none. */
  readonly source: string
  /** The variable to set. Read from the shell so the name is not hardcoded in two places. */
  readonly envVar: string
  /** The model every request uses. Read from the shell so it is not hardcoded twice. */
  readonly model: string
  /** Why the key could not be read, when the reason is not simply that there is none. */
  readonly error: string | null
}

/** One reply, before it is parsed. */
export interface CoachReply {
  /** The reply's text block. Schema-constrained JSON, but still a string until `parse.ts`. */
  readonly json: string
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * The Anthropic proxy.
 *
 * **The key never crosses this interface in either direction**, and there is no method that would
 * let it. On the desktop it is read by the Rust process; on the web it lives in a serverless
 * function. That property is the entire reason the call is not made from the browser.
 */
export interface CoachPlatform {
  /**
   * Reads whether a key is present and where it came from.
   *
   * Never rejects — a shell that cannot answer comes back as `hasKey: false` with the reason in
   * `error`, because the panel has to render either way.
   */
  readCoachStatus(): Promise<CoachStatus>
  /** Runs one coaching call. Rejects with a message meant to be shown verbatim. */
  requestCoach(prompt: CoachPrompt): Promise<CoachReply>
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** One entry in a save or open dialog's type list. */
export interface FileFilter {
  readonly name: string
  /** Extensions without the dot. */
  readonly extensions: readonly string[]
}

/**
 * Getting bytes out of the app and text back into it.
 *
 * The seam is deliberately below the four export entry points rather than at them: everything that
 * decides *what* a file contains is a pure function in `src/export/`, and duplicating that
 * composition per shell would be duplicating the only part that is tested.
 */
export interface FilesPlatform {
  /**
   * Asks where to put some bytes, then writes them.
   *
   * @param options - Where to put it and what it is.
   * @param options.suggestedName - Including the extension. A blank name shows a save dialog with
   *   no name in it, which looks broken.
   * @param options.bytes - The file. Built before the dialog opens, so a builder that throws does
   *   so before the user has picked anywhere to put it.
   * @param options.filter - The type to offer. A shell may enforce it; none may widen it.
   * @returns Where it went — a path on the desktop, a file name in a browser, which is all a
   *   download can honestly report. Null when the dialog was cancelled, which is not an error and
   *   must not be reported as one.
   */
  saveBytes(options: {
    readonly suggestedName: string
    readonly bytes: Uint8Array
    readonly filter: FileFilter
  }): Promise<string | null>
  /**
   * Asks for a file and reads it as text.
   *
   * Returns the contents rather than a path because a browser has no path to give, and a caller
   * that received one would have nothing to do with it.
   *
   * @param options - What to offer.
   * @param options.filter - The type to accept. A shell may refuse anything else outright.
   * @returns The file's text, or null when the dialog was cancelled.
   */
  openTextFile(options: { readonly filter: FileFilter }): Promise<string | null>
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

/** The accurate transcript and the timings only a post-speech pass has. */
export interface ReviewTranscript {
  /** Every segment's text, joined by single spaces. */
  readonly text: string
  /** The same words, still carrying the times they were said at. */
  readonly segments: readonly TranscriptSegment[]
}

/**
 * The microphone, the recogniser, and whatever can be learned from a finished recording.
 *
 * `retranscribe` and `findRecordingPauses` are the two capabilities a browser does not have: both
 * need a local decoder over a file, and both are what the review pass is made of. They are
 * declared here anyway so the interface is one shape, and `hasReviewPass` is what the UI branches
 * on — a report that quietly lacks its pause section looks like a bug rather than a platform.
 */
export interface SpeechPlatform {
  /** False where there is no second, accurate transcription pass over the recording. */
  readonly hasReviewPass: boolean
  /**
   * Picks the best available transcription source.
   *
   * @param sessionId - Names the recording, where one is kept.
   * @returns The source and, when it is a fallback, why. Rejects only when nothing can transcribe,
   *   which is the one case the Speak screen genuinely cannot open in.
   */
  createTranscriptionSource(sessionId: string): Promise<SourceChoice>
  /**
   * Re-transcribes a finished recording with the accurate model.
   *
   * @param wavPath - As returned by the source's `stop`.
   * @returns The transcript and the segments the timeline is built from.
   */
  retranscribe(wavPath: string): Promise<ReviewTranscript>
  /**
   * Finds the silences in a finished recording, measured off the samples rather than the
   * transcript.
   *
   * @param wavPath - As returned by the source's `stop`.
   * @param minSeconds - Shortest gap to report. Omit for the default.
   * @returns The pauses in order. Empty for a recording with no speech in it.
   */
  findRecordingPauses(wavPath: string, minSeconds?: number): Promise<Pause[]>
}

/** What an encode produced, and what it saved. */
export interface RecordingEncoding {
  /** Handle to the playable copy — a path on the desktop, the same handle in a browser. */
  readonly opusPath: string
  readonly opusBytes: number
  readonly wavBytes: number
  readonly durationSeconds: number
  /**
   * Extension for the object key, without the dot.
   *
   * Not a constant, because the container is negotiated in a browser: Safari before 18.4 records
   * MP4/AAC where everything else records WebM/Opus. A bucket full of files whose extension
   * disagrees with their bytes is a problem that surfaces at playback, on somebody else's device.
   */
  readonly extension: string
}

/** A recording's bytes, and what container they are actually in. */
export interface RecordedBytes {
  readonly bytes: Uint8Array
  /**
   * Passed straight to a `Blob`. Reported by whoever produced the file rather than guessed from
   * the extension — a mislabelled blob is one Safari refuses for a reason it does not explain.
   */
  readonly mimeType: string
}

/**
 * A speech's audio, on the way to the bucket and back.
 *
 * Separate from {@link SpeechPlatform} because these run long after a speech: a coach opening a
 * recording from March touches all three and none of the capture path.
 *
 * **`handle` is not a path.** It is one on the desktop, where audio is a WAV on disk; in a browser
 * it is a key into an in-memory registry that does not survive a reload. Nothing may parse it.
 */
export interface RecordingPlatform {
  /**
   * False where the recorder already produced a compressed file, so `prepareRecording` reports
   * sizes rather than shrinking anything. The player reads this before offering the two numbers
   * as a saving.
   */
  readonly encodesOnDemand: boolean
  /** Encodes a speech's recording for upload and playback, or reports the copy already made. */
  prepareRecording(handle: string): Promise<RecordingEncoding>
  /** Reads a recording's bytes, for the player and for the upload. */
  readRecordingBytes(handle: string): Promise<RecordedBytes>
  /** Deletes a speech's audio from this machine. */
  deleteLocalRecording(handle: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Co-prep
// ---------------------------------------------------------------------------

/** Where a LAN room is: this install's own relay, or somebody else's. */
export interface LanRoom {
  /** True when this install runs the relay. It still joins over loopback like everyone else. */
  readonly isHosting: boolean
  /** `host:port`. For a host, its own loopback address. */
  readonly address: string
}

/**
 * The transport a co-prep room runs over that is not Supabase.
 *
 * Realtime is not here: it is pure supabase-js and lives in `sync/provider.ts`, where both shells
 * use the same code. What differs is only whether there is a relay in the shell at all.
 */
export interface CollabPlatform {
  /** False where there is no relay to run — a browser, which has no sockets to bind. */
  readonly hasLanTransport: boolean
  /**
   * Finds or starts a LAN room for a case.
   *
   * @param roomId - The host's case id, used as the discovery key.
   * @returns Where the room is.
   */
  findOrHostLanRoom(roomId: string): Promise<LanRoom>
  /**
   * Opens a room over the relay.
   *
   * @param address - `host:port`, from {@link CollabPlatform.findOrHostLanRoom} or typed in by
   *   somebody whose network blocks broadcast.
   * @returns The link, not yet open.
   */
  createLanLink(address: string): CollabLink
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Where the Supabase session is kept between launches.
 *
 * The desktop puts it in the OS credential store, which is encrypted at rest per user. A browser
 * has `localStorage`, which is not — but it is also the only thing there, and supabase-js's own
 * default. `persistsSession` is what the team panel reads before promising that signing in once is
 * enough.
 */
export interface AuthPlatform {
  /**
   * The one Supabase client, or null on a build with no project.
   *
   * **Owned here rather than in `sync/`, and the reason is a cycle.** On the web the database
   * *is* Supabase, so `platform/web/database.ts` needs the client — and reaching it through
   * `sync/supabase.ts` closes a loop, because that module reads its session storage back out of
   * this interface. Pointing the dependency this way, each shell's `auth` module holds the
   * singleton and `sync/supabase.ts` re-exports it.
   *
   * There must be exactly one. Two clients each keep their own auto-refresh timer against the
   * same stored session and race each other writing it back.
   *
   * @returns The shared client. Null is the ordinary state of a clone with no `.env` and must be
   *   treated as "the team layer is off", never reported as a failure.
   */
  getClient(): MaybeSupabaseClient
  /** supabase-js's storage, however this shell holds a secret. */
  sessionStorage(): SupportedStorage
  /** False where a session does not survive a reload, which the UI has to say rather than imply. */
  readonly persistsSession: boolean
  /**
   * Whether supabase-js should read an auth callback out of the address bar.
   *
   * False on the desktop, where there is no address bar and leaving it on makes the library read
   * `window.location` on every construction.
   */
  readonly detectSessionInUrl: boolean
}

/**
 * Everything a shell supplies, as one object.
 *
 * Exists so an implementation directory can be checked whole — `satisfies Platform` on the index
 * catches a module that was added to the interface and forgotten in one of the two shells, which
 * per-module annotations alone would not.
 */
export interface Platform {
  readonly database: DatabasePlatform
  readonly coach: CoachPlatform
  readonly files: FilesPlatform
  readonly speech: SpeechPlatform
  readonly recordings: RecordingPlatform
  readonly collab: CollabPlatform
  readonly auth: AuthPlatform
}

/**
 * A Supabase client, or null on a build with no project.
 *
 * Re-exported here so an implementation module can name it without reaching into `sync/`, which
 * would point the dependency the wrong way.
 */
export type MaybeSupabaseClient = SupabaseClient | null
