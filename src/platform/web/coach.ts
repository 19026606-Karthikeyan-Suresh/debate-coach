/**
 * Layer B in a browser — not yet wired, and saying so rather than failing oddly.
 *
 * The security property is the same one the desktop holds and is the whole reason this is not a
 * direct call to Anthropic: **the key must never reach the webview.** On the desktop the Rust
 * process holds it. Here it will be a serverless function, `/api/coach`, which also has to do two
 * things the Rust command never had to — verify the caller's Supabase token, because a public URL
 * with a key behind it is an open proxy, and rate-limit per `auth.uid()`, because anonymous
 * sign-up is unlimited by design.
 *
 * Until that exists, `readCoachStatus` reports no key with a reason the panel prints verbatim.
 * That path is already exercised: it is what a desktop build with no `ANTHROPIC_API_KEY` does, and
 * the panel renders it without the Prep screen noticing.
 */

import type { CoachPlatform, CoachReply, CoachStatus } from '../types.ts'

/** What the panel shows until the function is deployed. */
const UNAVAILABLE: CoachStatus = {
  hasKey: false,
  source: '',
  envVar: 'ANTHROPIC_API_KEY',
  model: '',
  error: 'Coaching is not available in the web app yet.',
}

/**
 * Reads whether Layer B can run.
 *
 * @returns Unavailable, always, for now. Never rejects — the panel has to render either way and an
 *   unhandled rejection in the right rail would take the Prep screen with it.
 */
async function readCoachStatus(): Promise<CoachStatus> {
  return await Promise.resolve(UNAVAILABLE)
}

/**
 * Runs one coaching call.
 *
 * @param prompt - Ignored.
 * @returns Never. `readCoachStatus` reporting no key is what stops the panel offering the button,
 *   so reaching this is a bug rather than a state a user can get into.
 */
function requestCoach(prompt: unknown): Promise<CoachReply> {
  void prompt
  return Promise.reject(new Error(UNAVAILABLE.error ?? 'unavailable'))
}

/** No key here, and deliberately no way to put one here. */
export const coach: CoachPlatform = {
  readCoachStatus,
  requestCoach,
}
