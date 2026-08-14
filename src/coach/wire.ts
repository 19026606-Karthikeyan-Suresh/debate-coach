/**
 * The shape of the Anthropic request, and how to read what comes back.
 *
 * This is the port of `build_body` and `parse_reply` in `src-tauri/src/coach.rs`, and it exists
 * as its own module for the reason those are constants in Rust rather than three copies in the
 * caller: **the invariants on the wire are the same for all three tasks**, and every one of them
 * is only ever checked by a live call unless a test pins it. `cargo test` pins the Rust side;
 * `wire.test.ts` pins this one.
 *
 * It lives under `src/` rather than beside the function in `api/` because that is where vitest
 * looks — `test.include` is `src/**`, so a shape defined in `api/` would be a shape nothing
 * checks. **The key is not here and must never be**: this module is importable by the frontend
 * bundle, and the whole reason the request is made from a serverless function is that the key is
 * not. Nothing below reads an environment variable.
 */

import type { CoachPrompt, JsonSchema } from './types.ts'

/** The model. Thinking is on by default on Opus 5, so no `thinking` parameter is sent. */
export const COACH_MODEL = 'claude-opus-5'

/**
 * Output ceiling, covering thinking as well as the reply.
 *
 * The replies here are a few hundred tokens of JSON; the headroom is for the thinking in front of
 * them. `max_tokens` caps the two together, so sizing this to the reply alone truncates mid-JSON.
 */
export const COACH_MAX_TOKENS = 16_000

/** Reasoning depth. The whole point of Layer B is the question Layer A's regexes cannot ask. */
export const COACH_EFFORT = 'high'

/**
 * Opts into server-side refusal fallbacks.
 *
 * Opus 5's safety classifiers can decline a request outright; with this the API re-runs it on
 * Anthropic's recommended fallback instead of handing back a refusal. `"default"` rather than a
 * named model, because the right substitute depends on *why* the request was declined — and a
 * pinned name is a migration owed the next time it is deprecated.
 *
 * This header gates the `"default"` scalar form specifically. The array form is a different,
 * earlier header, and pairing either with the other form is a 400.
 */
export const COACH_FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/**
 * Parameters Opus 5 rejects outright.
 *
 * Sampling parameters were removed on Opus 4.7 and `thinking` with a `budget_tokens` on the same
 * release; sending any of them is a 400 rather than a value that is ignored. Exported so the test
 * asserts against the same list the body is built from.
 */
export const PARAMETERS_OPUS_5_REJECTS = ['temperature', 'top_p', 'top_k', 'thinking'] as const

/** One coaching request, as the Messages API takes it. */
export interface CoachRequestBody {
  readonly model: string
  readonly max_tokens: number
  readonly system: string
  readonly messages: readonly { readonly role: 'user'; readonly content: string }[]
  readonly output_config: {
    readonly effort: string
    readonly format: { readonly type: 'json_schema'; readonly schema: JsonSchema }
  }
  /** Present only when the account can use the beta; see {@link COACH_FALLBACK_BETA}. */
  readonly fallbacks?: 'default'
}

/**
 * Builds the request body.
 *
 * @param prompt - From `prompts.ts`. Its `task` is not sent — the wire shape is identical for all
 *   three, and the schema is what makes them differ.
 * @param withFallbacks - False on the retry after a 400 complaining about the beta. The parameter
 *   and the beta header are a pair; sending one without the other is itself a 400, so this must
 *   match what the caller puts in the header.
 * @returns The body. Carries no sampling parameters and no `thinking` — see
 *   {@link PARAMETERS_OPUS_5_REJECTS}.
 */
export function buildCoachBody(prompt: CoachPrompt, withFallbacks: boolean): CoachRequestBody {
  const body: CoachRequestBody = {
    model: COACH_MODEL,
    max_tokens: COACH_MAX_TOKENS,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    output_config: {
      effort: COACH_EFFORT,
      // The structural half of the Socratic constraint. The schema has no free-prose field for
      // Claude to write the debater's argument into, so it cannot, whatever the prompt says.
      format: { type: 'json_schema', schema: prompt.schema },
    },
  }
  return withFallbacks ? { ...body, fallbacks: 'default' } : body
}

/**
 * Whether a 400 looks like the account cannot use the refusal-fallback beta.
 *
 * Betas are enabled per organisation, and an account without this one gets a 400 rather than
 * having the parameter ignored — which would take Layer B down entirely over an optional
 * robustness feature. Matching on message text is fragile by nature; the cost of a false positive
 * is one retry that fails the same way, which is why it is safe to be loose.
 *
 * @param message - Anthropic's `error.message`.
 * @returns True when the request should be retried without the beta.
 */
export function mentionsFallback(message: string): boolean {
  const lowered = message.toLowerCase()
  return lowered.includes('fallback') || lowered.includes(COACH_FALLBACK_BETA)
}

/** Why a call could not produce a usable reply. Each one means something different to do. */
export type CoachFailureKind =
  | 'no-key'
  | 'network'
  | 'unauthorized'
  | 'rate-limited'
  | 'overloaded'
  | 'api'
  | 'refused'
  | 'unusable'

/** A failure, in the terms the panel shows. */
export interface CoachFailure {
  readonly kind: CoachFailureKind
  readonly message: string
  /** Seconds to wait, on a rate limit that carried one. */
  readonly retryAfterSeconds?: number
}

/** The parsed reply, before `parse.ts` checks it against the schema. */
export interface CoachReplyPayload {
  readonly json: string
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
}

/** The bits of a Messages response this reads. Structural, so a test can build one by hand. */
export interface MessagesResponse {
  readonly model?: string
  readonly stop_reason?: string | null
  readonly stop_details?: { readonly category?: string | null } | null
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number }
}

/**
 * Reads a 200 response, or says why it cannot be used.
 *
 * Three things a naive reader gets wrong, and all three are pinned by tests:
 *
 * - **A refusal is a successful HTTP 200 with nothing usable in it.** `stop_reason` has to be
 *   checked *before* `content` — code that indexes `content[0]` unconditionally throws on a
 *   refusal, or worse reads a partial as an answer.
 * - **The first content block is not the text block.** Thinking runs in front of the reply, so
 *   the JSON is found by looking for `type === 'text'` rather than by position.
 * - **A reply cut off at `max_tokens` is truncated JSON**, which parses as a syntax error
 *   somewhere unhelpful. It is refused here, where the reason is still known.
 *
 * @param response - The decoded response body.
 * @returns The reply, or the failure. Never throws — the caller turns either into a status.
 */
export function parseCoachReply(
  response: MessagesResponse,
): { ok: true; reply: CoachReplyPayload } | { ok: false; failure: CoachFailure } {
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category
    return {
      ok: false,
      failure: {
        kind: 'refused',
        message: category
          ? `Claude declined this request (${category}). Rewording the argument usually clears it.`
          : 'Claude declined this request. Rewording the argument usually clears it.',
      },
    }
  }

  if (response.stop_reason === 'max_tokens') {
    return {
      ok: false,
      failure: {
        kind: 'unusable',
        message: 'The reply was cut off before it was complete. Try a shorter substantive.',
      },
    }
  }

  const text = (response.content ?? []).find((block) => block.type === 'text')?.text
  if (text === undefined || text.trim().length === 0) {
    return {
      ok: false,
      failure: { kind: 'unusable', message: 'Claude returned nothing to read.' },
    }
  }

  return {
    ok: true,
    reply: {
      json: text,
      model: response.model ?? COACH_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
  }
}
