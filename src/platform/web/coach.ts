/**
 * Layer B in a browser — a fetch to the serverless function that holds the key.
 *
 * **The key is not reachable from here, and that is the whole design.** On the desktop the Rust
 * process holds it; on the web `api/coach.ts` does. This module knows the URL and nothing else,
 * which is why a `VITE_`-prefixed key would defeat the entire arrangement — Vite would inline it
 * into this bundle and publish it on the open web.
 *
 * Everything that decides *what* is asked and whether the answer is Socratic stays in the browser:
 * `prompts.ts`, `schema.ts`, `parse.ts` and `validate.ts` are unchanged, still red-teamed by
 * vitest with no key and no network in the loop. The function is a courier.
 */

import { getSupabase } from '../../sync/supabase.ts'
import { ensureSignedIn } from '../../sync/identity.ts'
import type { CoachPrompt } from '../../coach/types.ts'
import type { CoachPlatform, CoachReply, CoachStatus } from '../types.ts'

/** Where the function is mounted. Same origin, so no CORS and no second host to configure. */
const COACH_ENDPOINT = '/api/coach'

/** What the panel shows when the deployment has no function or no key behind it. */
const UNAVAILABLE: CoachStatus = {
  hasKey: false,
  source: '',
  envVar: 'ANTHROPIC_API_KEY',
  model: '',
  error: 'Coaching is not available on this deployment.',
}

/**
 * The caller's access token, which the function checks against the project.
 *
 * @returns The bearer token.
 * @throws If the build has no Supabase project. Coaching needs an attributable identity — a
 *   public URL with an Anthropic key behind it and no caller check is an open proxy.
 */
async function accessToken(): Promise<string> {
  const client = getSupabase()
  if (!client) {
    throw new Error('Coaching needs a signed-in account, and this build has no project.')
  }
  await ensureSignedIn(client)
  const { data } = await client.auth.getSession()
  const token = data.session?.access_token
  if (token === undefined) {
    throw new Error('Coaching needs a signed-in account.')
  }
  return token
}

/**
 * Reads whether Layer B can run.
 *
 * @returns The status. Never rejects — the panel has to render either way, and an unhandled
 *   rejection in the right rail would take the Prep screen with it.
 */
async function readCoachStatus(): Promise<CoachStatus> {
  try {
    const response = await fetch(COACH_ENDPOINT, { method: 'GET' })
    if (!response.ok) {
      return UNAVAILABLE
    }
    return (await response.json()) as CoachStatus
  } catch {
    // No function deployed, or offline. Both are "not available", which is what it says.
    return UNAVAILABLE
  }
}

/**
 * Runs one coaching call.
 *
 * @param prompt - From `prompts.ts`. Sent whole, including `task`, so the function's own logs can
 *   tell an audit from an attack run without reading the debater's words.
 * @returns The raw reply, for `parse.ts` to check and guard.
 * @throws With the function's own message. The categories are the desktop's — a missing key, a
 *   refused key, a rate limit, a refusal, a truncated reply, no network — because each one calls
 *   for something different from the debater and "coaching failed" says none of it.
 */
async function requestCoach(prompt: CoachPrompt): Promise<CoachReply> {
  const response = await fetch(COACH_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${await accessToken()}`,
    },
    body: JSON.stringify(prompt),
  })

  const body: unknown = await response.json()
  // The function answers a refusal or a truncated reply with 200 and a failure body, because
  // neither is an HTTP-level error — the request worked and the answer is unusable.
  if (!response.ok || (body as { kind?: string }).kind !== undefined) {
    const message = (body as { message?: string }).message ?? 'Coaching failed.'
    throw new Error(message)
  }
  return body as CoachReply
}

/** The key lives in the function, and there is deliberately no way to put one here. */
export const coach: CoachPlatform = {
  readCoachStatus,
  requestCoach,
}
