/**
 * Signing in, and the one way this layer reports a failure.
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
 */

import type { SupabaseClient } from '@supabase/supabase-js'

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
 * Signs in anonymously, or resumes the stored session.
 *
 * @param client - A configured client.
 * @returns This install's `auth.uid()`, stable for as long as the session store keeps the
 *   session — which on the desktop is the OS credential store and in a browser is
 *   `localStorage`, so clearing site data there starts a new identity that owns nothing.
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
