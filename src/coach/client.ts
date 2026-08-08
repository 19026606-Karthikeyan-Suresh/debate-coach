/**
 * The frontend half of the proxy.
 *
 * Four commands, and the key crosses none of them in the direction that would matter: it goes in
 * on `save_coach_key` and never comes back out. Nothing in the webview can read it, which is the
 * whole reason the Anthropic call is made from Rust at all.
 *
 * Every function here degrades rather than throws when Tauri is absent. `npm run dev` in a plain
 * browser has no `invoke`, and the Prep screen still has to render — the coach panel just says it
 * is unavailable, exactly as it would on a machine whose credential store is broken.
 */

import { invoke } from '@tauri-apps/api/core'

import type { CoachPrompt } from './types.ts'

/** Whether Layer B can run, as `src-tauri/src/coach.rs` reports it. */
export interface CoachStatus {
  readonly hasKey: boolean
  /** Human name of the credential store the key lives in. */
  readonly backend: string
  /** False when that store does not survive a quit — the settings box says so. */
  readonly persistent: boolean
  /** The model every request uses. Read from Rust so it is not hardcoded twice. */
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

/** What the panel shows when there is no Tauri underneath it. */
const UNAVAILABLE: CoachStatus = {
  hasKey: false,
  backend: 'unavailable',
  persistent: false,
  model: '',
  error: 'The desktop shell is not running, so there is nowhere to keep a key.',
}

/**
 * Reads whether a key is saved and where it lives.
 *
 * @returns The status. Never rejects: a broken credential store or a missing shell both come
 *   back as `hasKey: false` with the reason in `error`, because the panel has to render either
 *   way and an unhandled rejection in the right rail would take the Prep screen with it.
 */
export async function readCoachStatus(): Promise<CoachStatus> {
  try {
    return await invoke<CoachStatus>('coach_status')
  } catch (error) {
    return { ...UNAVAILABLE, error: describe(error) }
  }
}

/**
 * Saves an API key.
 *
 * @param key - The key. Trimmed on the Rust side, and refused there if it is blank.
 * @throws If the credential store refuses the write, with the store's own message.
 */
export async function saveCoachKey(key: string): Promise<void> {
  await invoke('save_coach_key', { key })
}

/**
 * Deletes the saved key, turning Layer B back off.
 *
 * @throws If the credential store refuses the delete. Deleting nothing succeeds.
 */
export async function clearCoachKey(): Promise<void> {
  await invoke('clear_coach_key')
}

/**
 * Runs one coaching call.
 *
 * @param prompt - From `prompts.ts`. Its `task` is not sent — the wire shape is identical for
 *   all three, and the schema is what makes them differ.
 * @returns The raw reply, for `parse.ts` to check and guard.
 * @throws With Rust's message, which distinguishes a missing key, a rejected key, a rate limit,
 *   a refusal, and no network — the panel shows it verbatim because each one calls for something
 *   different from the debater.
 */
export async function requestCoach(prompt: CoachPrompt): Promise<CoachReply> {
  return await invoke<CoachReply>('run_coach_request', {
    request: { system: prompt.system, user: prompt.user, schema: prompt.schema },
  })
}

/** Best available text for an unknown thrown value. */
function describe(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  return error instanceof Error ? error.message : 'unknown error'
}
