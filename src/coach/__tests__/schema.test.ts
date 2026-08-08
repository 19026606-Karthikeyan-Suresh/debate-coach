/**
 * The fence, checked by walking it.
 *
 * These assertions are not about JSON Schema being well-formed. They are about the one property
 * that makes Layer B safe to ship: **there is nowhere in a reply to put the debater's argument.**
 * A field called `explanation` or `suggestedResponse` would be a hole, and it would be added by
 * someone acting in good faith who thought it would be useful — which is exactly why the check
 * is a test and not a comment.
 *
 * The second half pins Anthropic's supported subset. `maxLength` and `minItems` are silently
 * dropped from a schema rather than rejected, so a length constraint written here would look
 * enforced and do nothing; both live in `validate.ts` instead, and this test is what stops one
 * drifting back.
 */

import { describe, expect, it } from 'vitest'

import { ATTACK_SCHEMA, AUDIT_SCHEMA, POI_SCHEMA, TASK_SCHEMAS } from '../schema.ts'
import { DEPTH_AXES } from '../types.ts'
import type { JsonSchema } from '../types.ts'

/**
 * The only names a free-text string may have.
 *
 * `question` is the Socratic form. `attack` is the deliberate exception — it is the *other*
 * side's argument, and writing it out is what makes it answerable. Anything else is a hole.
 */
const ALLOWED_TEXT_FIELDS = new Set(['question', 'questions', 'attack'])

/** Keywords Anthropic's structured-output subset does not honour. */
const UNSUPPORTED_KEYWORDS = [
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
]

/** One node of a schema, with the property name it hangs under. */
interface Node {
  readonly name: string
  readonly node: Record<string, unknown>
}

/** Flattens a schema into every object node it contains, depth first. */
function walk(schema: JsonSchema): readonly Node[] {
  const found: Node[] = []

  const visit = (name: string, value: unknown): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return
    }
    const node = value as Record<string, unknown>
    found.push({ name, node })

    const properties = node.properties
    if (typeof properties === 'object' && properties !== null) {
      for (const [key, child] of Object.entries(properties)) {
        visit(key, child)
      }
    }
    // An array's `items` describes the same thing the array is named after, so it inherits the
    // name — that is what makes `questions: { items: { type: 'string' } }` checkable at all.
    visit(name, node.items)
  }

  visit('(root)', schema)
  return found
}

const ALL_SCHEMAS: readonly { readonly label: string; readonly schema: JsonSchema }[] = [
  { label: 'audit', schema: AUDIT_SCHEMA },
  { label: 'attack', schema: ATTACK_SCHEMA },
  { label: 'poi', schema: POI_SCHEMA },
]

describe.each(ALL_SCHEMAS)('$label schema', ({ schema }) => {
  const nodes = walk(schema)

  it('has no free-text field the debater’s argument could be written into', () => {
    const freeText = nodes.filter(
      ({ node }) => node.type === 'string' && !Array.isArray(node.enum),
    )
    expect(freeText.length).toBeGreaterThan(0)
    for (const { name } of freeText) {
      expect(ALLOWED_TEXT_FIELDS).toContain(name)
    }
  })

  it('closes every object', () => {
    for (const { name, node } of nodes) {
      if (node.type !== 'object') {
        continue
      }
      // Without this, the model may add properties the schema never named — which is the same
      // hole as declaring one, arrived at from the other direction.
      expect(node.additionalProperties, `${name} is open`).toBe(false)

      const properties = Object.keys((node.properties ?? {}) as Record<string, unknown>)
      expect(node.required, `${name} has optional properties`).toEqual(properties)
    }
  })

  it('uses only keywords Anthropic honours', () => {
    for (const { name, node } of nodes) {
      for (const keyword of UNSUPPORTED_KEYWORDS) {
        expect(Object.hasOwn(node, keyword), `${name} uses ${keyword}`).toBe(false)
      }
    }
  })
})

/** Walks to a node by key, failing the test where it goes missing rather than at the assertion. */
function at(schema: JsonSchema, ...path: readonly string[]): Record<string, unknown> {
  let node: unknown = schema
  for (const key of path) {
    node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined
    expect(node, `missing at ${path.join('.')}`).toBeTypeOf('object')
  }
  return node as Record<string, unknown>
}

describe('the audit schema', () => {
  it('scores on an enum rather than a range, because ranges are dropped', () => {
    const score = at(AUDIT_SCHEMA, 'properties', 'axes', 'items', 'properties', 'score')
    expect(score.type).toBe('integer')
    expect(score.enum).toEqual([0, 1, 2, 3])
  })

  it('names the same five axes the rest of the app does', () => {
    expect(at(AUDIT_SCHEMA, 'properties', 'sharpest').enum).toEqual([...DEPTH_AXES])
  })
})

describe('the attack schema', () => {
  /**
   * The single most load-bearing assertion in the file. An attack that arrives with its own
   * rebuttal has taught the debater nothing they can say in a round, and a field for it is how
   * that would happen.
   */
  it('has nowhere to put the answer to an attack', () => {
    const properties = at(ATTACK_SCHEMA, 'properties', 'attacks', 'items', 'properties')
    expect(Object.keys(properties).sort()).toEqual(['attack', 'targets'])
  })
})

describe('the POI schema', () => {
  it('carries only questions, matching the template’s two-column list', () => {
    expect(Object.keys(at(POI_SCHEMA, 'properties'))).toEqual(['questions'])
  })
})

describe('the task table', () => {
  it('has a schema for every task, so none can be dispatched unconstrained', () => {
    expect(Object.keys(TASK_SCHEMAS).sort()).toEqual(['attack', 'audit', 'poi'])
  })
})
