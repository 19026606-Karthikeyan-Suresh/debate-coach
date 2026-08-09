/**
 * Coach comments on one speech, from whichever side of the round trip this install is on.
 *
 * **The two directions are not symmetrical, and pretending they were would cost a foreign key.**
 * Comments on *your own* speech are cached in SQLite: the session row is here, the coach's advice
 * should still be readable on the train home, and a pull replaces the remote ones while leaving
 * anything typed here and not yet drained alone. Comments on a *teammate's* speech are not cached
 * at all — their session has no local row for `comments.session_id` to reference, and inventing a
 * stub session so a coach's own note has somewhere to live would put a speech in their history
 * that they never gave.
 *
 * So a coach comments online, and the debater reads it offline. That is the way round it needs to
 * work: the coach is at a laptop with the recording open, and the debater is the one who wants the
 * note next week.
 */

import { useCallback, useEffect, useState } from 'react'

import {
  deleteComment,
  listComments,
  replaceRemoteComments,
  saveComment,
} from '../db/index.ts'
import { normalisedCommentBody, sortComments, type SpeechComment } from '../speech/comments.ts'
import { runSync } from '../sync/engine.ts'
import { commentToRemoteRow } from '../sync/rows.ts'
import {
  deleteRemoteComment,
  fetchComments,
  fetchTeamRoster,
  getSupabase,
  pushComment,
} from '../sync/supabase.ts'

/** Whose speech is being commented on. */
export interface CommentScope {
  readonly sessionId: string
  /** True for a speech this install recorded, which is the one that has a local session row. */
  readonly isOwnSession: boolean
  /** The active team, or null. Without one there is nobody to sync with. */
  readonly teamId: string | null
  /** This install's `auth.uid()`, or null when it has not signed in. */
  readonly userId: string | null
  /** How this debater appears to teammates. Stored on the comment so it survives going offline. */
  readonly displayName: string
}

/** The comment thread and what can be done to it. */
export interface CommentThread {
  readonly comments: readonly SpeechComment[]
  /** True while a fetch or a push is in flight. */
  readonly isBusy: boolean
  /**
   * The last failure, or null.
   *
   * A failed *refresh* on your own speech is a caveat rather than an error: the cached comments
   * are still on screen and still true, they are just not necessarily current.
   */
  readonly error: string | null
  /** True when what is on screen came from SQLite rather than from the project just now. */
  readonly isCached: boolean
  /** Adds a note. Rejects a body of whitespace, as the database would. */
  readonly add: (atSeconds: number, body: string) => Promise<void>
  /** Removes one. Only the author's own; a policy refuses the rest and so does the UI. */
  readonly remove: (commentId: string) => Promise<void>
  readonly refresh: () => Promise<void>
}

/** Reads a thrown value as a sentence. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A fresh id. `randomUUID` needs a secure context, which a Tauri webview is. */
function newCommentId(): string {
  return crypto.randomUUID()
}

/**
 * Loads and edits the comments on one speech.
 *
 * @param scope - Whose speech, and who this install is. See {@link CommentScope}.
 * @returns See {@link CommentThread}. On a build with no project the thread still works for your
 *   own speeches — the notes are local, and there is simply nobody to send them to.
 */
export function useComments(scope: CommentScope): CommentThread {
  const { sessionId, isOwnSession, teamId, userId, displayName } = scope

  const [comments, setComments] = useState<readonly SpeechComment[]>([])
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isCached, setIsCached] = useState(false)

  /**
   * Re-reads the thread.
   *
   * For an own session: SQLite first so something is on screen immediately, then the project,
   * then SQLite again now that the pull has replaced the remote rows. For a teammate's: the
   * project only, because there is nowhere local for them to go.
   */
  const refresh = useCallback(async (): Promise<void> => {
    setIsBusy(true)
    try {
      const client = getSupabase()

      if (!isOwnSession) {
        if (!client || teamId === null) {
          setComments([])
          setError('Sign in and pick a team to read the comments on this speech.')
          return
        }
        const roster = await fetchTeamRoster(client, teamId)
        setComments(sortComments(await fetchComments(client, sessionId, roster)))
        setIsCached(false)
        setError(null)
        return
      }

      setComments(await listComments(sessionId))
      setIsCached(true)
      if (!client || teamId === null) {
        setError(null)
        return
      }

      const roster = await fetchTeamRoster(client, teamId)
      await replaceRemoteComments(sessionId, await fetchComments(client, sessionId, roster))
      setComments(await listComments(sessionId))
      setIsCached(false)
      setError(null)
    } catch (refreshError) {
      // Deliberately not clearing what is on screen: cached comments are out of date, not wrong.
      setError(messageOf(refreshError))
    } finally {
      setIsBusy(false)
    }
  }, [sessionId, isOwnSession, teamId])

  // Written inline rather than calling `refresh`, so the state updates sit visibly inside the
  // promise callback and a response landing after the player closes is dropped.
  useEffect(() => {
    let isStale = false
    void (async () => {
      try {
        const client = getSupabase()
        if (isOwnSession) {
          const local = await listComments(sessionId)
          if (isStale) {
            return
          }
          setComments(local)
          setIsCached(true)
        }
        if (!client || teamId === null) {
          if (!isStale && !isOwnSession) {
            setError('Sign in and pick a team to read the comments on this speech.')
          }
          return
        }

        const roster = await fetchTeamRoster(client, teamId)
        const remote = await fetchComments(client, sessionId, roster)
        if (isStale) {
          return
        }
        if (isOwnSession) {
          await replaceRemoteComments(sessionId, remote)
          const merged = await listComments(sessionId)
          if (!isStale) {
            setComments(merged)
          }
        } else {
          setComments(sortComments(remote))
        }
        if (!isStale) {
          setIsCached(false)
          setError(null)
        }
      } catch (loadError) {
        if (!isStale) {
          setError(messageOf(loadError))
        }
      }
    })()
    return () => {
      isStale = true
    }
  }, [sessionId, isOwnSession, teamId])

  const add = useCallback(
    async (atSeconds: number, body: string): Promise<void> => {
      const text = normalisedCommentBody(body)
      if (text === null) {
        return
      }
      setIsBusy(true)
      setError(null)
      try {
        const comment: SpeechComment = {
          id: newCommentId(),
          sessionId,
          authorId: userId,
          authorName: displayName,
          atSeconds,
          body: text,
          createdAt: new Date().toISOString(),
          // False even when this install pulled the thread a second ago: a note written here is
          // pending until it drains, and marking it remote would let the next pull delete it.
          isRemote: false,
        }

        if (isOwnSession) {
          await saveComment(comment)
          setComments(await listComments(sessionId))
          // Pushed through the queue rather than directly, so a note written on a train is still
          // queued and a failure is recorded per row with the rest.
          await runSync()
        } else {
          const client = getSupabase()
          if (!client || userId === null) {
            throw new Error('Sign in before commenting on a teammate’s speech.')
          }
          await pushComment(client, commentToRemoteRow(comment, userId))
          setComments((current) => sortComments([...current, { ...comment, isRemote: true }]))
        }
      } catch (addError) {
        setError(messageOf(addError))
      } finally {
        setIsBusy(false)
      }
    },
    [sessionId, isOwnSession, userId, displayName],
  )

  const remove = useCallback(
    async (commentId: string): Promise<void> => {
      setIsBusy(true)
      setError(null)
      try {
        if (isOwnSession) {
          await deleteComment(commentId)
          setComments(await listComments(sessionId))
          await runSync()
        } else {
          const client = getSupabase()
          if (!client) {
            throw new Error('Sign in before editing comments on a teammate’s speech.')
          }
          await deleteRemoteComment(client, commentId)
          setComments((current) => current.filter((entry) => entry.id !== commentId))
        }
      } catch (removeError) {
        setError(messageOf(removeError))
      } finally {
        setIsBusy(false)
      }
    },
    [sessionId, isOwnSession],
  )

  return { comments, isBusy, error, isCached, add, remove, refresh }
}
