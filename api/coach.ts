/**
 * Layer B on the web — the serverless half of the proxy.
 *
 * This is the counterpart of `src-tauri/src/coach.rs`, and it holds the same one thing: **the API
 * key**. The desktop keeps it in the Rust process; here it is a Vercel environment variable that
 * only this function can read. Nothing about the request shape or the reply's meaning lives here —
 * that is `src/coach/wire.ts`, in `src/` so vitest can pin it, and `src/coach/parse.ts` and
 * `validate.ts`, which run in the browser where they always did.
 *
 * **Never `VITE_ANTHROPIC_API_KEY`.** Vite inlines anything so prefixed into the frontend bundle,
 * which would publish the key on the open web — the exact opposite of the property this file
 * exists to hold.
 *
 * # Two things the Rust command never had to do
 *
 * A desktop command is reachable by the person at the keyboard. A URL is reachable by everyone, so
 * this function is an open Anthropic proxy unless it is neither anonymous nor unmetered:
 *
 *   * **Verify the caller.** The bearer token is checked against the Supabase project before any
 *     request goes out. No token, no call.
 *   * **Meter them.** Anonymous sign-up is unlimited by design, so "signed in" is a low bar —
 *     anyone can mint an identity. `claim_coach_call` caps how many calls one identity gets in a
 *     day, and it claims the slot *before* the request rather than counting after it.
 */

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

import type { CoachPrompt } from '../src/coach/types.ts'
import type { CoachFailure, MessagesResponse } from '../src/coach/wire.ts'
import {
  buildCoachBody,
  COACH_FALLBACK_BETA,
  COACH_MODEL,
  mentionsFallback,
  parseCoachReply,
} from '../src/coach/wire.ts'

/**
 * How long Vercel lets this run.
 *
 * High effort on a long substantive is minutes, not seconds — the request the debater cares about
 * is the slow one. **This is the number most likely to need changing**: plans cap it differently,
 * and a cap below the real p99 turns a working call into a timeout the panel cannot explain.
 */
export const maxDuration = 300

/** The variable the key is read from. No `VITE_` prefix, and that is load-bearing. */
const KEY_ENV = 'ANTHROPIC_API_KEY'

/**
 * Calls one identity gets per UTC day.
 *
 * A prep session is a handful of audits and a couple of attack runs, so this is generous for a
 * debater and useless to somebody mining the key. Overridable, because the right number depends
 * on how many people share the deployment.
 */
const DEFAULT_DAILY_LIMIT = 50

/** Reads the first of several environment names that is actually set. */
function readEnv(...names: readonly string[]): string {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value.trim().length > 0) {
      return value.trim()
    }
  }
  return ''
}

/** JSON response with no caching — a coaching reply is never the same twice. */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** A failure, in the shape `platform/web/coach.ts` turns into a thrown message. */
function failureResponse(failure: CoachFailure, status: number): Response {
  return jsonResponse(failure, status)
}

/**
 * Checks the caller's Supabase token and returns their `auth.uid()`.
 *
 * Verified against the project rather than decoded locally: a JWT's payload is readable by
 * anyone holding it and signed by a key this function does not have, so "parse the sub claim"
 * would accept a token somebody wrote themselves.
 *
 * @param request - The incoming request, whose `Authorization` header carries the bearer token.
 * @returns The user id and a client carrying their token, or null when the token is missing,
 *   malformed, expired, or from another project.
 */
async function verifyCaller(
  request: Request,
): Promise<{ userId: string; token: string } | null> {
  const header = request.headers.get('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (token.length === 0) {
    return null
  }

  const url = readEnv('SUPABASE_URL', 'VITE_SUPABASE_URL')
  const anonKey = readEnv('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')
  if (url.length === 0 || anonKey.length === 0) {
    return null
  }

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) {
    return null
  }
  return { userId: data.user.id, token }
}

/** What the daily cap said. */
interface Allowance {
  readonly allowed: boolean
  readonly calls: number
  readonly limitPerDay: number
}

/**
 * Claims one call against the caller's daily allowance.
 *
 * Runs as the caller so `auth.uid()` resolves inside the function — no service-role key is
 * involved, which keeps the count unforgeable without introducing a second secret that could
 * bypass every policy in the project if it leaked.
 *
 * @param token - The caller's verified access token.
 * @returns The allowance. A project without migration 8 applied comes back as allowed with a zero
 *   count, because refusing every call over a missing table would take Layer B down entirely for
 *   a deployment that is otherwise fine — the cap is a safeguard, not the feature.
 */
async function claimCall(token: string): Promise<Allowance> {
  const url = readEnv('SUPABASE_URL', 'VITE_SUPABASE_URL')
  const anonKey = readEnv('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')
  const limit = Number.parseInt(readEnv('COACH_DAILY_LIMIT'), 10)
  const dailyLimit = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_DAILY_LIMIT

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const { data, error } = await supabase.rpc('claim_coach_call', { daily_limit: dailyLimit })
  if (error) {
    console.warn('coach rate limit unavailable', error.message)
    return { allowed: true, calls: 0, limitPerDay: dailyLimit }
  }
  const row = (data as { allowed: boolean; calls: number; limit_per_day: number }[] | null)?.[0]
  return {
    allowed: row?.allowed ?? true,
    calls: row?.calls ?? 0,
    limitPerDay: row?.limit_per_day ?? dailyLimit,
  }
}

/** Reads a prompt off the request body, or null when it is not one. */
function readPrompt(body: unknown): CoachPrompt | null {
  const candidate = body as Partial<CoachPrompt> | null
  if (
    typeof candidate?.system !== 'string' ||
    typeof candidate.user !== 'string' ||
    typeof candidate.schema !== 'object' ||
    candidate.schema === null
  ) {
    return null
  }
  return {
    task: candidate.task ?? 'audit',
    system: candidate.system,
    user: candidate.user,
    schema: candidate.schema,
  }
}

/** Turns an SDK error into the category that says what the debater should do about it. */
function describeError(error: unknown): CoachFailure {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'unauthorized', message: 'The deployment’s Anthropic key was refused.' }
  }
  if (error instanceof Anthropic.RateLimitError) {
    const header = error.headers?.get('retry-after')
    const seconds = header === null || header === undefined ? undefined : Number.parseInt(header, 10)
    return {
      kind: 'rate-limited',
      message: 'Anthropic is rate limiting this key. Wait a moment and try again.',
      ...(seconds !== undefined && Number.isFinite(seconds) ? { retryAfterSeconds: seconds } : {}),
    }
  }
  if (error instanceof Anthropic.InternalServerError) {
    return { kind: 'overloaded', message: 'Anthropic is overloaded. Try again shortly.' }
  }
  // Checked before `APIError`, of which it is a subclass in this SDK.
  if (error instanceof Anthropic.APIConnectionError) {
    return { kind: 'network', message: 'Could not reach Anthropic.' }
  }
  if (error instanceof Anthropic.APIError) {
    return { kind: 'api', message: error.message }
  }
  return { kind: 'api', message: error instanceof Error ? error.message : 'unknown error' }
}

/**
 * Sends one request, once.
 *
 * @param client - The Anthropic client, holding the key.
 * @param prompt - The words and the schema.
 * @param withFallbacks - Whether to opt into server-side refusal fallbacks. The parameter and the
 *   beta header are a pair, so they are set together or not at all — sending one without the
 *   other is itself a 400.
 * @returns The decoded response body.
 * @throws Whatever the SDK throws; {@link describeError} sorts it out.
 */
async function send(
  client: Anthropic,
  prompt: CoachPrompt,
  withFallbacks: boolean,
): Promise<MessagesResponse> {
  const params = {
    ...buildCoachBody(prompt, withFallbacks),
    ...(withFallbacks ? { betas: [COACH_FALLBACK_BETA] } : {}),
  }
  // Cast at the boundary, twice deliberately. `fallbacks` is a beta parameter whose typings lag
  // the API, and the response's `stop_details` likewise — `parseCoachReply` reads both
  // structurally, which is why it takes a shape rather than the SDK's type.
  const response = await client.beta.messages.create(
    params as unknown as Parameters<typeof client.beta.messages.create>[0],
  )
  return response as unknown as MessagesResponse
}

/** Reports whether Layer B can run at all, without revealing anything about the key. */
function statusResponse(): Response {
  const hasKey = readEnv(KEY_ENV).length > 0
  return jsonResponse(
    {
      hasKey,
      source: hasKey ? 'the deployment environment' : '',
      envVar: KEY_ENV,
      model: hasKey ? COACH_MODEL : '',
      error: hasKey ? null : 'This deployment has no Anthropic key configured.',
    },
    200,
  )
}

/**
 * Handles a coaching request.
 *
 * @param request - `GET` reports whether a key is configured; `POST` runs one call.
 * @returns The reply, the status, or a failure the panel prints verbatim.
 */
export default async function handler(request: Request): Promise<Response> {
  if (request.method === 'GET') {
    return statusResponse()
  }
  if (request.method !== 'POST') {
    return failureResponse({ kind: 'api', message: 'Method not allowed.' }, 405)
  }

  const key = readEnv(KEY_ENV)
  if (key.length === 0) {
    return failureResponse(
      { kind: 'no-key', message: 'This deployment has no Anthropic key configured.' },
      503,
    )
  }

  const caller = await verifyCaller(request)
  if (!caller) {
    return failureResponse(
      { kind: 'unauthorized', message: 'Sign in before asking for coaching.' },
      401,
    )
  }

  let prompt: CoachPrompt | null
  try {
    prompt = readPrompt(await request.json())
  } catch {
    prompt = null
  }
  if (!prompt) {
    return failureResponse({ kind: 'api', message: 'That was not a coaching request.' }, 400)
  }

  const allowance = await claimCall(caller.token)
  if (!allowance.allowed) {
    return failureResponse(
      {
        kind: 'rate-limited',
        message: `That is ${String(allowance.limitPerDay)} coaching calls today, which is the daily limit for this deployment. Layer A keeps working.`,
      },
      429,
    )
  }

  const client = new Anthropic({ apiKey: key, maxRetries: 1 })

  try {
    let response: MessagesResponse
    try {
      response = await send(client, prompt, true)
    } catch (error) {
      // Betas are enabled per organisation, and an account without this one gets a 400 rather
      // than having the parameter ignored — which would take Layer B down over an optional
      // robustness feature. Retried once without it; anything else rethrows.
      const failure = describeError(error)
      if (failure.kind !== 'api' || !mentionsFallback(failure.message)) {
        throw error
      }
      response = await send(client, prompt, false)
    }

    const parsed = parseCoachReply(response)
    return parsed.ok ? jsonResponse(parsed.reply, 200) : failureResponse(parsed.failure, 200)
  } catch (error) {
    const failure = describeError(error)
    const status = failure.kind === 'unauthorized' ? 502 : failure.kind === 'rate-limited' ? 429 : 502
    return failureResponse(failure, status)
  }
}
