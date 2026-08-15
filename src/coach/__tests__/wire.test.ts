/**
 * The wire shape, pinned.
 *
 * Every constant here is otherwise only ever checked by a live call — and a live call needs a key,
 * which is exactly what CI and a fresh clone do not have. These are the same assertions
 * `src-tauri/src/coach.rs`'s test module makes about the Rust proxy, so the two shells cannot
 * drift apart without one of the two suites failing.
 */

import { describe, expect, it } from 'vitest'

import type { CoachPrompt } from '../types.ts'
import {
  buildCoachBody,
  COACH_EFFORT,
  COACH_MAX_TOKENS,
  COACH_MODEL,
  mentionsFallback,
  parseCoachReply,
  PARAMETERS_OPUS_5_REJECTS,
} from '../wire.ts'

/** A prompt with the smallest schema that is still an object. */
function samplePrompt(): CoachPrompt {
  return {
    task: 'audit',
    system: 'system text',
    user: 'user text',
    schema: { type: 'object', properties: {}, additionalProperties: false },
  }
}

describe('the request body', () => {
  it('pins the model and the reasoning budget', () => {
    const body = buildCoachBody(samplePrompt(), true)
    expect(body.model).toBe('claude-opus-5')
    expect(body.max_tokens).toBe(16_000)
    expect(body.output_config.effort).toBe('high')
    // Guards the constants themselves, not just this one call.
    expect(COACH_MODEL).toBe('claude-opus-5')
    expect(COACH_MAX_TOKENS).toBe(16_000)
    expect(COACH_EFFORT).toBe('high')
  })

  it('always carries a schema', () => {
    const body = buildCoachBody(samplePrompt(), true)
    expect(body.output_config.format.type).toBe('json_schema')
    expect(typeof body.output_config.format.schema).toBe('object')
  })

  it('omits every parameter Opus 5 rejects', () => {
    // Sampling parameters and `budget_tokens` thinking were removed on Opus 4.7; sending any of
    // them is a 400 rather than a value that is quietly ignored.
    const body = buildCoachBody(samplePrompt(), true) as unknown as Record<string, unknown>
    for (const removed of PARAMETERS_OPUS_5_REJECTS) {
      expect(body[removed], `${removed} must not be sent`).toBeUndefined()
    }
  })

  it('makes fallbacks opt-in and droppable', () => {
    // The parameter and the beta header are a pair, so the retry has to be able to drop both.
    expect(buildCoachBody(samplePrompt(), true).fallbacks).toBe('default')
    expect(buildCoachBody(samplePrompt(), false).fallbacks).toBeUndefined()
  })

  it('sends the prompt as one user turn and never as a prefill', () => {
    // A trailing assistant turn is a 400 on Opus 5, and it is the obvious way somebody would try
    // to force the JSON shape if they did not know `output_config.format` existed.
    const body = buildCoachBody(samplePrompt(), true)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.role).toBe('user')
  })
})

describe('reading the reply', () => {
  it('does not read a refusal as content', () => {
    const failed = parseCoachReply({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      content: [],
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.failure.kind).toBe('refused')
      expect(failed.failure.message).toContain('cyber')
    }
  })

  it('skips thinking blocks to reach the json', () => {
    // Thinking is on by default on Opus 5, so the first block is not the answer.
    const parsed = parseCoachReply({
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', text: '' },
        { type: 'text', text: '{"questions":[]}' },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.reply.json).toBe('{"questions":[]}')
      expect(parsed.reply.inputTokens).toBe(12)
      expect(parsed.reply.outputTokens).toBe(3)
    }
  })

  it('refuses a truncated reply rather than parsing it', () => {
    const failed = parseCoachReply({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"questions":[' }],
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.failure.kind).toBe('unusable')
    }
  })

  it('refuses a reply with no text block at all', () => {
    const failed = parseCoachReply({ stop_reason: 'end_turn', content: [] })
    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.failure.kind).toBe('unusable')
    }
  })
})

describe('the fallback retry', () => {
  it('only fires on a fallback complaint', () => {
    expect(mentionsFallback('fallbacks: unsupported beta')).toBe(true)
    expect(mentionsFallback('max_tokens: must be greater than 0')).toBe(false)
  })
})
