/**
 * The sign-in guard, against a fake client.
 *
 * A fake rather than a project, because what is being pinned is the *number of calls* this module
 * makes — and a live Supabase would answer a second `signInAnonymously` with a perfectly valid
 * second user, which is the failure rather than a signal of it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import {
  describeSignInRisk,
  ensureSignedIn,
  linkEmail,
  readIdentity,
  signInWithEmail,
} from '../identity.ts'

/** What a fake recorded, so a test can count calls rather than infer them. */
interface FakeCounts {
  /** How many identities the project was asked to create. More than one is the bug. */
  signInCalls: number
  /** The last argument each of the two email calls was given. */
  updateUserArgs: unknown
  otpArgs: unknown
}

/** A fake client and the tally it keeps. */
interface FakeClient {
  readonly client: SupabaseClient
  readonly counts: FakeCounts
}

/**
 * A client with an in-memory session.
 *
 * @param options - How it should behave.
 * @param options.startsSignedIn - Whether a session is already stored, as after a reload.
 * @param options.signInFails - A message to refuse `signInAnonymously` with.
 * @param options.user - Fields to merge into the stored user, for the identity tests.
 * @returns The fake and its counters.
 */
function fakeClient(options: {
  startsSignedIn?: boolean
  signInFails?: string | null
  user?: Record<string, unknown>
} = {}): FakeClient {
  // The session store, which is what a real client keeps in localStorage or the keychain.
  let stored: Record<string, unknown> | null = options.startsSignedIn
    ? { id: 'resumed-user', ...options.user }
    : null

  const counts: FakeCounts = { signInCalls: 0, updateUserArgs: null, otpArgs: null }

  const client = {
    auth: {
      getSession: async () => {
        // A real client's storage read is asynchronous, and the whole race lives in that gap.
        await Promise.resolve()
        return { data: { session: stored === null ? null : { user: stored } } }
      },
      signInAnonymously: async () => {
        counts.signInCalls += 1
        // Read before the await, not after. Naming the user from the counter afterwards makes
        // three concurrent sign-ins all report the last one's id, which hides the failure being
        // tested for behind a fake that is wrong in the same direction.
        const ordinal = counts.signInCalls
        await Promise.resolve()
        if (options.signInFails) {
          return { data: { user: null }, error: { message: options.signInFails } }
        }
        // Each call mints a *different* id, exactly as the project would.
        const created = { id: `anon-${String(ordinal)}`, ...options.user }
        stored = created
        return { data: { user: created }, error: null }
      },
      updateUser: async (attributes: unknown) => {
        counts.updateUserArgs = attributes
        await Promise.resolve()
        return { data: {}, error: null }
      },
      signInWithOtp: async (attributes: unknown) => {
        counts.otpArgs = attributes
        await Promise.resolve()
        return { data: {}, error: null }
      },
    },
  } as unknown as SupabaseClient

  return { client, counts }
}

describe('ensureSignedIn', () => {
  it('creates one identity for callers that arrive together', async () => {
    const fake = fakeClient()

    // The Library's first paint: the case list, the settings read behind it and the team panel
    // all reach the database before any of them has come back.
    const results = await Promise.all([
      ensureSignedIn(fake.client),
      ensureSignedIn(fake.client),
      ensureSignedIn(fake.client),
    ])

    expect(fake.counts.signInCalls).toBe(1)
    expect(new Set(results).size).toBe(1)
  })

  it('resumes a stored session without creating anybody', async () => {
    const fake = fakeClient({ startsSignedIn: true })

    await expect(ensureSignedIn(fake.client)).resolves.toBe('resumed-user')
    expect(fake.counts.signInCalls).toBe(0)
  })

  it('does not create a second identity on a later call', async () => {
    const fake = fakeClient()

    const first = await ensureSignedIn(fake.client)
    const second = await ensureSignedIn(fake.client)

    expect(second).toBe(first)
    expect(fake.counts.signInCalls).toBe(1)
  })

  it('caches nothing when the attempt fails, so a retry retries', async () => {
    const fake = fakeClient({ signInFails: 'anonymous sign-ins are disabled' })

    await expect(ensureSignedIn(fake.client)).rejects.toThrow(/anonymous sign-ins are disabled/)
    // A held-onto rejected promise would make every later call fail with the original message,
    // long after the project setting had been fixed.
    await expect(ensureSignedIn(fake.client)).rejects.toThrow(/anonymous sign-ins are disabled/)
    expect(fake.counts.signInCalls).toBe(2)
  })

  it('names the project setting rather than the code', async () => {
    const fake = fakeClient({ signInFails: 'Anonymous sign-ins are disabled' })
    await expect(ensureSignedIn(fake.client)).rejects.toThrow(/could not sign in/)
  })
})

describe('readIdentity', () => {
  it('is null before anybody has signed in', async () => {
    await expect(readIdentity(fakeClient().client)).resolves.toBeNull()
  })

  it('reads an anonymous identity as having no email', async () => {
    // Supabase gives an anonymous user an empty string here, not a missing field, and `''` would
    // render as a linked account with no address in it.
    const fake = fakeClient({ startsSignedIn: true, user: { email: '' } })

    await expect(readIdentity(fake.client)).resolves.toEqual({
      userId: 'resumed-user',
      email: null,
      pendingEmail: null,
    })
  })

  it('separates a confirmed email from one still in an inbox', async () => {
    const fake = fakeClient({
      startsSignedIn: true,
      user: { email: 'old@example.com', new_email: 'new@example.com' },
    })

    await expect(readIdentity(fake.client)).resolves.toEqual({
      userId: 'resumed-user',
      email: 'old@example.com',
      pendingEmail: 'new@example.com',
    })
  })
})

describe('describeSignInRisk', () => {
  it('never sounds safe when the count is unknown', () => {
    // Null is not zero. A failed count that reassures is the one wording that can talk somebody
    // into orphaning a season.
    const unknown = describeSignInRisk(null)
    expect(unknown).toMatch(/stays with it/)
    expect(unknown).not.toMatch(/nothing here to leave behind/)
  })

  it('says outright when there is nothing to lose', () => {
    expect(describeSignInRisk(0)).toMatch(/nothing here to leave behind/)
  })

  it('names the number and points at the safe option', () => {
    const many = describeSignInRisk(7)
    expect(many).toMatch(/7 cases/)
    expect(many).toMatch(/add an email to this account instead/i)
  })

  it('reads as English for one case', () => {
    const one = describeSignInRisk(1)
    expect(one).toMatch(/1 case\./)
    expect(one).not.toMatch(/1 cases/)
    expect(one).toMatch(/leaves it behind/)
  })
})

describe('the email door', () => {
  it('links an address to the identity already signed in', async () => {
    const fake = fakeClient({ startsSignedIn: true })
    await linkEmail(fake.client, 'debater@example.com')

    // `updateUser` and not `signUp`: the uid has to survive, or every case this browser owns
    // stops being readable by the person who wrote it.
    expect(fake.counts.updateUserArgs).toEqual({ email: 'debater@example.com' })
  })

  it('refuses to create a user when signing back in', async () => {
    const fake = fakeClient()
    await signInWithEmail(fake.client, 'debater@example.com')

    // A typo with `shouldCreateUser` left true signs the debater into a new empty account, which
    // looks exactly like their cases having been deleted.
    expect(fake.counts.otpArgs).toEqual({
      email: 'debater@example.com',
      options: { shouldCreateUser: false },
    })
  })
})
