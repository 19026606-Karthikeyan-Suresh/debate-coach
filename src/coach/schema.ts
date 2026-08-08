/**
 * The structural half of the Socratic constraint.
 *
 * A prompt asking Claude not to write the debater's argument is a request. A schema with nowhere
 * to put one is a fence. Every string-valued property below is either a question, an opposition
 * line, or a member of a fixed enum — there is no `explanation`, no `suggestion`, no `summary`,
 * and nothing named `answer`. `__tests__/schema.test.ts` walks these objects and fails if one
 * appears, which is what stops the fence quietly rotting the next time a field looks useful.
 *
 * # What Anthropic's schema subset does and does not take
 *
 * Supported: object, array, the scalar types, `enum`, `const`, `additionalProperties: false`,
 * and `required`. **Not** supported: `minLength`/`maxLength`, `minimum`/`maximum`, `pattern`,
 * `minItems`/`maxItems`. So the 0–3 score is an `enum` of integers rather than a range, and both
 * the length cap and the item counts are enforced in `validate.ts` after the reply lands. That
 * split is worth remembering: the schema says what shape, the validator says how much.
 */

import type { JsonSchema } from './types.ts'
import { DEPTH_AXES } from './types.ts'

/** Axis names as a schema enum. Spread so the two lists cannot drift apart. */
const AXIS_ENUM = [...DEPTH_AXES]

/**
 * `audit` — five scored axes and the one to fix first.
 *
 * The only prose Claude may write is `question`, one per axis. There is deliberately no field
 * for what is wrong: the score says how far the row got and the question says what a judge would
 * push on, and a third field explaining both would be where the argument arrived.
 */
export const AUDIT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    axes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          axis: { type: 'string', enum: AXIS_ENUM },
          score: {
            type: 'integer',
            enum: [0, 1, 2, 3],
            description:
              '0 absent, 1 asserted with no reasoning, 2 argued, 3 argued and weighed against the other side.',
          },
          question: {
            type: 'string',
            description:
              'One sentence a judge would ask out loud about this axis. It must not contain or imply its own answer.',
          },
        },
        required: ['axis', 'score', 'question'],
        additionalProperties: false,
      },
    },
    sharpest: {
      type: 'string',
      enum: AXIS_ENUM,
      description: 'The axis whose question the debater should answer first.',
    },
  },
  required: ['axes', 'sharpest'],
  additionalProperties: false,
}

/**
 * `attack` — the opposition's three strongest responses.
 *
 * `attack` is the one string in this file that is not a question, and it is the exception that
 * proves the rule: it is the *other side's* argument. There is no field beside it for how to
 * beat it, because that is the whole exercise — the line goes into `Preempt.attack` and the
 * debater writes `Preempt.response` themselves.
 */
export const ATTACK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    attacks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          targets: {
            type: 'string',
            enum: AXIS_ENUM,
            description: 'Which axis of the substantive this attack goes through.',
          },
          attack: {
            type: 'string',
            description:
              'The response as the opposing bench would say it in the round. Do not include any way of answering it.',
          },
        },
        required: ['targets', 'attack'],
        additionalProperties: false,
      },
    },
  },
  required: ['attacks'],
  additionalProperties: false,
}

/**
 * `poi` — questions for the template's POI list.
 *
 * A bare array of strings, because the template's POI table has exactly two columns and the
 * second one is the debater's answer. Anything Claude might put in a third column has nowhere
 * to go, which is the point.
 */
export const POI_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'string',
        description:
          'One POI as the opposing bench would ask it out loud, in fifteen seconds or less.',
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
}

/** Schema per task, so a task cannot be dispatched without one. */
export const TASK_SCHEMAS = {
  audit: AUDIT_SCHEMA,
  attack: ATTACK_SCHEMA,
  poi: POI_SCHEMA,
} as const
