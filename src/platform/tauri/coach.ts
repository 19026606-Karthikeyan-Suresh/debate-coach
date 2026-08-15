/**
 * The frontend half of the proxy.
 *
 * Two commands, and the key crosses neither. It is read from `ANTHROPIC_API_KEY` in the shell
 * process and never leaves it — there is no command that accepts one and none that returns one,
 * which is the whole reason the Anthropic call is made from Rust at all.
 *
 * That is also why the variable has no `VITE_` prefix. Vite inlines anything so prefixed into the
 * frontend bundle, which would put the key in this file's neighbourhood and ship it inside the
 * installer.
 *
 * Every function here degrades rather than throws when Tauri is absent. `npm run dev` in a plain
 * browser has no `invoke`, and the Prep screen still has to render — the coach panel just says it
 * is unavailable.
 */

import { invoke } from '@tauri-apps/api/core'

import type { CoachPrompt } from '../../coach/types.ts'
import type { CoachPlatform, CoachReply, CoachStatus } from '../types.ts'

/** What the panel shows when there is no Tauri underneath it. */
const UNAVAILABLE: CoachStatus = {
  hasKey: false,
  source: '',
  envVar: 'ANTHROPIC_API_KEY',
  model: '',
  error: 'The desktop shell is not running, so no key can be read.',
}

/** Best available text for an unknown thrown value. */
function describe(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  return error instanceof Error ? error.message : 'unknown error'
}

/**
 * Reads whether a key is present and where it came from.
 *
 * @returns The status. Never rejects: a missing shell comes back as `hasKey: false` with the
 *   reason in `error`, because the panel has to render either way and an unhandled rejection in
 *   the right rail would take the Prep screen with it.
 */
async function readCoachStatus(): Promise<CoachStatus> {
  try {
    return await invoke<CoachStatus>('coach_status')
  } catch (error) {
    return { ...UNAVAILABLE, error: describe(error) }
  }
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
async function requestCoach(prompt: CoachPrompt): Promise<CoachReply> {
  return await invoke<CoachReply>('run_coach_request', {
    request: { system: prompt.system, user: prompt.user, schema: prompt.schema },
  })
}

/** Anthropic through the Rust shell, which is the only process that sees the key. */
export const coach: CoachPlatform = {
  readCoachStatus,
  requestCoach,
}
