/**
 * Signing in, linking an email to that identity, and the one way this layer reports a failure.
 *
 * Split out of `supabase.ts` when the web shell landed, and the split is structural rather than
 * tidying: `supabase.ts` reads the client out of `@platform`, so anything in `platform/` that
 * imported it would close a loop. Everything here takes a client as an argument and imports
 * nothing from the platform, which is what makes it safe for both sides to use.
 *
 * **Sign-in is anonymous and permanent.** It buys a real, stable `auth.uid()` — so an edit is
 * attributable, a recording belongs to somebody, and presence works — while onboarding a squad
 * before a tournament stays "type this code". The cost is that the app cannot verify who anyone
 * actually is, which is why an invite code can be rotated and an admin can revoke a member.
 *
 * # Signing in twice is worse than not signing in at all
 *
 * On the desktop this was called once, from the team panel. In a browser the database *is*
 * Supabase, so every read and every write goes through it — and the Library's first paint fires
 * several at once. Two callers that both find no session both call `signInAnonymously`, and the
 * project cheerfully creates **two users**. The second one wins the session store, and every case
 * written under the first becomes invisible: `cases_select` is `owner_id = auth.uid()` and the
 * uid changed. The rows are still there and nothing reports an error.
 *
 * So {@link ensureSignedIn} is single-flight per client, and where the browser has Web Locks it
 * also re-checks inside one, for the same race across two tabs opened together.
 */

import type { SupabaseClient, User } from '@supabase/supabase-js'

/** Names the cross-tab lock. Only ever held while an identity is being created. */
const SIGN_IN_LOCK = 'debate-coach-anonymous-sign-in'

/**
 * Sign-ins in flight, one per client.
 *
 * A `WeakMap` rather than a module-level promise so two clients — which only ever happens in a
 * test — cannot answer for each other. The entry is removed when the attempt settles, so nothing
 * here caches a uid: a later call re-reads the session, which is what makes signing out and
 * signing in as somebody else work.
 */
const inFlight = new WeakMap<SupabaseClient, Promise<string>>()

/**
 * Turns a PostgREST error into something worth showing.
 *
 * @param action - What was being attempted, in the words the user would use.
 * @param message - The server's own text, kept verbatim — a policy refusal and a dead network
 *   need different things from the reader and only the raw message distinguishes them.
 * @throws Always. The return type is `never` so callers need no fallthrough.
 */
export function fail(action: string, message: string): never {
  throw new Error(`${action}: ${message}`)
}

/**
 * The signed-in user, read from the stored session.
 *
 * The session rather than `getUser()`, which is a network round trip — this is on the boot path
 * and on every database call behind it. The cost is that it reflects the last write to the
 * session store, which `updateUser` performs, so a linked email shows up without a refetch.
 */
async function sessionUser(client: SupabaseClient): Promise<User | null> {
  const stored = await client.auth.getSession()
  return stored.data.session?.user ?? null
}

/** Runs `create` under a cross-tab lock where there is one, and plainly where there is not. */
async function whileHoldingLock(create: () => Promise<string>): Promise<string> {
  // Absent in non-secure contexts, in older webviews, and under vitest's node environment.
  // Falling through is exactly the single-tab behaviour, so this is never worse than not trying.
  const runtime = globalThis.navigator as Navigator | undefined
  if (!runtime?.locks) {
    return await create()
  }
  return await runtime.locks.request(SIGN_IN_LOCK, create)
}

/** Signs in for real. Guarded by {@link ensureSignedIn}; never called concurrently by it. */
async function createOrResumeSession(client: SupabaseClient): Promise<string> {
  const current = await sessionUser(client)
  if (current) {
    return current.id
  }

  return await whileHoldingLock(async () => {
    // Another tab may have created the identity while this one waited for the lock, and the
    // point of the lock is that this read happens after that write rather than beside it.
    const afterWaiting = await sessionUser(client)
    if (afterWaiting) {
      return afterWaiting.id
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
  })
}

/**
 * Signs in anonymously, or resumes the stored session.
 *
 * Safe to call from anywhere, any number of times, including several times at once — concurrent
 * callers share one attempt. See this module's header for why that matters more than it looks.
 *
 * @param client - A configured client.
 * @returns This install's `auth.uid()`, stable for as long as the session store keeps the
 *   session — which on the desktop is the OS credential store and in a browser is
 *   `localStorage`, so clearing site data there starts a new identity that owns nothing. Linking
 *   an email is what makes that recoverable.
 * @throws If the project refuses anonymous sign-in. That is a project setting rather than a code
 *   fault, and the message says so.
 */
export function ensureSignedIn(client: SupabaseClient): Promise<string> {
  const existing = inFlight.get(client)
  if (existing) {
    return existing
  }
  // Registered synchronously, before any await: a caller arriving in the same turn has to find
  // this entry, which is the entire mechanism.
  const attempt = createOrResumeSession(client).finally(() => {
    inFlight.delete(client)
  })
  inFlight.set(client, attempt)
  return attempt
}

/** Who this install is signed in as. */
export interface Identity {
  readonly userId: string
  /**
   * The confirmed email, or null while this is still an anonymous identity.
   *
   * Anonymous is the ordinary state and not a lesser one — every policy in the schema is written
   * against `auth.uid()`, which an anonymous user has. The email buys recovery, nothing else.
   */
  readonly email: string | null
  /** Asked for and not yet confirmed. The link is in somebody's inbox. */
  readonly pendingEmail: string | null
}

/**
 * Reads an identity off a user record.
 *
 * Pure, and exported because `onAuthStateChange` hands the session straight to its callback —
 * calling back into the client from inside that callback deadlocks against the auth lock it is
 * already holding, which is a hang rather than an error.
 *
 * @param user - From a session, not from `getUser()`.
 * @returns What the panel shows.
 */
export function identityOfUser(user: User): Identity {
  return {
    userId: user.id,
    // Empty rather than absent is what an anonymous user's email can be, and `''` would render
    // as a linked account with no address in it.
    email: user.email !== undefined && user.email !== '' ? user.email : null,
    pendingEmail: user.new_email ?? null,
  }
}

/**
 * Reads the current identity without signing anyone in.
 *
 * @param client - A configured client.
 * @returns The identity, or null when nobody is signed in yet — which is a state the boot gate
 *   distinguishes from a failure, so it is not an error here either.
 */
export async function readIdentity(client: SupabaseClient): Promise<Identity | null> {
  const user = await sessionUser(client)
  return user ? identityOfUser(user) : null
}

/**
 * Links an email to the identity already signed in.
 *
 * **The uid does not change**, which is the whole point: no row moves, no policy is affected, and
 * every case this browser has written stays owned by the same person. What changes is that there
 * is now a way back in after site data is cleared.
 *
 * @param client - A configured client, already signed in.
 * @param email - Where to send the confirmation. Unconfirmed until the link is clicked, so the
 *   caller must say "check your inbox" rather than "done".
 * @throws If the address is already attached to another identity, or the project has email
 *   sign-in switched off. Both come back as the project's own message.
 */
export async function linkEmail(client: SupabaseClient, email: string): Promise<void> {
  const updated = await client.auth.updateUser({ email })
  if (updated.error) {
    fail('could not add that email', updated.error.message)
  }
}

/**
 * Says what signing in as somebody else would cost.
 *
 * Signing in **replaces** this identity. The cases written under the old one stay owned by it —
 * `cases_select` is `owner_id = auth.uid()` and the uid changed — so they are visible to nobody
 * and deleted by nothing. That is unrecoverable in practice without the old session back, which
 * is exactly what somebody reaching for this button has usually just lost.
 *
 * Pure, and here rather than inside the panel because it is the sentence that stops a debater
 * orphaning a season, and a sentence nothing can test is a sentence that quietly gets it wrong.
 *
 * @param ownedCases - How many cases this identity owns, or null when the count could not be
 *   read. Null is deliberately *not* treated as zero: an unknown count is the one case where the
 *   warning must not sound safe.
 * @returns The sentence to show above the form.
 */
export function describeSignInRisk(ownedCases: number | null): string {
  if (ownedCases === null) {
    return 'Signing in replaces this account with the one that owns the address. Anything written under this account stays with it.'
  }
  if (ownedCases === 0) {
    return 'This account has no cases yet, so there is nothing here to leave behind.'
  }
  const cases = ownedCases === 1 ? '1 case' : `${String(ownedCases)} cases`
  const them = ownedCases === 1 ? 'it' : 'them'
  return `This account has ${cases}. Signing in as somebody else leaves ${them} behind — ${them} stay owned by this account, which you would no longer be. If you meant to keep ${them}, add an email to this account instead.`
}

/**
 * Sends a sign-in link to an email that has already been linked.
 *
 * `shouldCreateUser` is false deliberately. Left true, a typo signs the debater into a brand new
 * empty account that looks exactly like their cases having been deleted — and creates a second
 * identity in the project that nobody will ever claim.
 *
 * @param client - A configured client.
 * @param email - The linked address.
 * @throws If the project refuses, including when no identity has that address.
 */
export async function signInWithEmail(client: SupabaseClient, email: string): Promise<void> {
  const sent = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
  if (sent.error) {
    fail('could not send a sign-in link', sent.error.message)
  }
}
