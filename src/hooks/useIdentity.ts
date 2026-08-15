/**
 * Who this install is, resolved before the first screen renders.
 *
 * **This exists because of a foreign key, not because of a login screen.** Where the truth is
 * Postgres, `cases.owner_id` is `not null references auth.users`, so a case cannot exist before
 * an `auth.uid()` does — and a Library that renders first shows an empty list and a refusal from
 * the first write, which reads as "my cases are gone". So the app holds one frame instead, and
 * `database.requiresIdentity` is what decides whether it has to.
 *
 * The desktop does not. SQLite belongs to whoever is at the keyboard, and a debater who never
 * joins a squad should never see a network call at launch — signing in there to satisfy a
 * constraint that only exists in the other shell would break the local-first promise for a
 * feature they are not using. It still *reads* an identity when there is one, so the panel can
 * say which account a linked email is on.
 *
 * The email half is here rather than in `useSync` for the same reason: it is about this install's
 * identity, which teams are downstream of. One instance lives at the app root and is passed down,
 * because "check your inbox" is state and two copies of it disagree.
 */

import { useCallback, useEffect, useState } from 'react'

import { auth } from '@platform'
import { requiresIdentity } from '../db/index.ts'
import {
  ensureSignedIn,
  identityOfUser,
  linkEmail as linkRemoteEmail,
  readIdentity,
  signInWithEmail,
  type Identity,
} from '../sync/identity.ts'
import { getSupabase } from '../sync/supabase.ts'

/** How far the boot check has got. */
export type IdentityStatus =
  /** Signing in, or resuming. The only state that holds the first screen back. */
  | 'checking'
  /** There is an identity, or none is needed. */
  | 'ready'
  /** This build needs a project and has none. Configuration, not failure. */
  | 'unconfigured'
  /** Sign-in was refused. Retryable, and the message says by what. */
  | 'error'

/** The identity, and the two things that can be done to it. */
export interface IdentitySession {
  readonly status: IdentityStatus
  /** Null before sign-in, and on a desktop build that has never joined a squad. */
  readonly identity: Identity | null
  /** True while an email call is in flight. Never true for the boot check — `status` says that. */
  readonly isBusy: boolean
  /** The last failure, or null. */
  readonly error: string | null
  /** What just happened and what to do next, e.g. where a confirmation link went. */
  readonly notice: string | null
  /** Runs the boot check again, for an `error`. */
  readonly retry: () => void
  /** Links an email to this identity, keeping the uid. Returns whether the request was sent. */
  readonly linkEmail: (email: string) => Promise<boolean>
  /** Sends a sign-in link to an already-linked address. */
  readonly sendSignInLink: (email: string) => Promise<boolean>
  /** Drops a notice once it has been read. */
  readonly clearNotice: () => void
}

/** Reads a thrown value as a sentence. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Where an emailed link should land.
 *
 * The origin this tab is actually on, not a constant — a preview deployment and a dev server have
 * to get their own link back, or every one of them sends the debater to production. Undefined
 * where the shell has no address bar to receive a callback in, which `detectSessionInUrl` already
 * states; Supabase then falls back to the project's Site URL, which is right for that case.
 *
 * The origin must be on the project's redirect allow-list. One that is not still *sends* the
 * link — it is refused on arrival, which is the confusing way round and is why the allow-list is
 * step one of the deploy runbook rather than a footnote.
 */
function authRedirectTarget(): string | undefined {
  return auth.detectSessionInUrl ? window.location.origin : undefined
}

/**
 * Resolves this install's identity.
 *
 * @returns See {@link IdentitySession}. One instance per app; calling it twice gives two copies
 *   of the notice state, which then disagree about whether a link has been sent.
 */
export function useIdentity(): IdentitySession {
  // Both are constants for the life of the process, so the first status is computed during render
  // rather than corrected by an effect — a gate that flashes "checking" on the desktop, where
  // nothing is being checked, is a frame of the wrong screen.
  const client = getSupabase()
  const [status, setStatus] = useState<IdentityStatus>(() => {
    if (!requiresIdentity) {
      return 'ready'
    }
    return client === null ? 'unconfigured' : 'checking'
  })

  const [identity, setIdentity] = useState<Identity | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Bumped by `retry`. The only thing that re-runs the boot check.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!client) {
      return
    }
    let isStale = false
    void (async () => {
      try {
        if (requiresIdentity) {
          await ensureSignedIn(client)
        }
        const who = await readIdentity(client)
        if (!isStale) {
          setIdentity(who)
          setError(null)
          setStatus('ready')
        }
      } catch (bootError) {
        if (!isStale) {
          setError(messageOf(bootError))
          // Only where a case cannot be written without one. On the desktop a refused sign-in
          // costs the team panel and nothing else, and blocking the Library over it would take
          // an offline debater's own cases away.
          if (requiresIdentity) {
            setStatus('error')
          }
        }
      }
    })()
    return () => {
      isStale = true
    }
  }, [client, attempt])

  // Confirming an email link in another tab, or arriving back on the magic-link callback, changes
  // the identity under a screen that is already open. The session comes in on the callback, so
  // nothing here calls back into the client — doing that from inside this handler deadlocks
  // against the auth lock it is already holding, which shows up as a hang rather than an error.
  useEffect(() => {
    if (!client) {
      return
    }
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      setIdentity(session ? identityOfUser(session.user) : null)
    })
    return () => {
      data.subscription.unsubscribe()
    }
  }, [client])

  const retry = useCallback((): void => {
    setStatus(requiresIdentity ? 'checking' : 'ready')
    setError(null)
    setAttempt((previous) => previous + 1)
  }, [])

  /** Runs one email call with the busy flag and one place to catch. */
  const runEmailCall = useCallback(
    async (call: () => Promise<void>, said: string): Promise<boolean> => {
      setIsBusy(true)
      setError(null)
      setNotice(null)
      try {
        await call()
        setNotice(said)
        return true
      } catch (callError) {
        setError(messageOf(callError))
        return false
      } finally {
        setIsBusy(false)
      }
    },
    [],
  )

  const linkEmail = useCallback(
    async (email: string): Promise<boolean> => {
      if (!client) {
        return false
      }
      const sent = await runEmailCall(
        async () => {
          await linkRemoteEmail(client, email, authRedirectTarget())
        },
        `Confirm it from the link sent to ${email}. Nothing changes until you do — this is still the same account either way.`,
      )
      if (sent) {
        // `updateUser` writes the pending address into the stored session, so the panel can say
        // which one is waiting without a second round trip.
        setIdentity(await readIdentity(client))
      }
      return sent
    },
    [client, runEmailCall],
  )

  const sendSignInLink = useCallback(
    async (email: string): Promise<boolean> =>
      client === null
        ? false
        : await runEmailCall(
            async () => {
              await signInWithEmail(client, email, authRedirectTarget())
            },
            `A sign-in link is on its way to ${email}. Open it in this browser.`,
          ),
    [client, runEmailCall],
  )

  const clearNotice = useCallback((): void => {
    setNotice(null)
  }, [])

  return {
    status,
    identity,
    isBusy,
    error,
    notice,
    retry,
    linkEmail,
    sendSignInLink,
    clearNotice,
  }
}
