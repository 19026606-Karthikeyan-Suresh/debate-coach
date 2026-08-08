/**
 * Turning a reply into something the panel can render.
 *
 * `output_config.format` guarantees the JSON matches the schema, and this file does not trust
 * that. Not out of superstition: the guarantee holds for the model's output and says nothing
 * about a fallback model that ran instead, a truncated body, or a schema this repo changed and
 * the API is still serving from its 24-hour compile cache. The cost of checking is a hundred
 * lines; the cost of not checking is `undefined` rendered as a question.
 *
 * Everything here is pure and takes the raw string, so the Socratic guard can be red-teamed in
 * vitest against replies that never came from anywhere.
 */

import { checkAttack, checkQuestion, guard } from './validate.ts'
import type {
  AttackResult,
  AuditResult,
  AxisScore,
  AxisVerdict,
  CoachRejection,
  CoachResult,
  CoachTaskId,
  DepthAxis,
  PoiResult,
} from './types.ts'
import { DEPTH_AXES } from './types.ts'

/** A reply, checked and guarded. */
export interface ParsedReply {
  readonly result: CoachResult
  /** Everything the Socratic guard threw away, in the order it was returned. */
  readonly rejected: readonly CoachRejection[]
}

/** Reads a property off an unknown value without widening it to `any`. */
function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined
}

/** Reads a property that must be an array, giving an empty one when it is not. */
function arrayProperty(value: unknown, key: string): readonly unknown[] {
  const found = property(value, key)
  return Array.isArray(found) ? found : []
}

/** True when the value is one of the five axes. */
function isAxis(value: unknown): value is DepthAxis {
  return typeof value === 'string' && (DEPTH_AXES as readonly string[]).includes(value)
}

/** Coerces a score to the 0–3 scale, clamping rather than rejecting a whole verdict over it. */
function toScore(value: unknown): AxisScore {
  const rounded = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
  return Math.min(3, Math.max(0, rounded)) as AxisScore
}

/**
 * Parses the raw reply text.
 *
 * @param raw - The reply's first text block, verbatim.
 * @returns The parsed object.
 * @throws If the text is not JSON, which means the schema constraint did not hold and nothing
 *   downstream can be trusted either.
 */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Claude replied with something that was not JSON.')
  }
}

/**
 * Parses and guards an `audit` reply.
 *
 * Duplicate axes keep the first verdict and later ones are dropped silently — a repeated axis is
 * the model being redundant rather than saying anything new, and reporting it as a rejection
 * would put a scary note under a perfectly good audit.
 *
 * @param raw - The reply's text block.
 * @returns The five verdicts that survived, and the questions that did not.
 * @throws If the reply is not JSON, or if every question was rejected — an audit with no
 *   questions left is not an audit, and showing five scores with nothing to act on is worse than
 *   saying the call failed.
 */
export function parseAuditReply(raw: string): ParsedReply {
  const payload = parseJson(raw)

  // Shape first, voice second. A verdict whose axis is not one of the five cannot be rendered at
  // all, so it never reaches the guard and is not reported as a Socratic failure — it is not one.
  const shaped = arrayProperty(payload, 'axes').flatMap((entry): AxisVerdict[] => {
    const axis = property(entry, 'axis')
    const question = property(entry, 'question')
    return isAxis(axis) && typeof question === 'string'
      ? [{ axis, score: toScore(property(entry, 'score')), question: question.trim() }]
      : []
  })

  const seen = new Set<DepthAxis>()
  const unique = shaped.filter((verdict) => {
    if (seen.has(verdict.axis)) {
      return false
    }
    seen.add(verdict.axis)
    return true
  })

  const { kept, rejected } = guard(unique, (verdict) => verdict.question, checkQuestion)
  if (kept.length === 0) {
    throw new Error('Nothing in the audit survived the Socratic check.')
  }

  // Rendered in the rubric's order rather than the model's, so two audits of the same substantive
  // are readable side by side.
  const axes = [...kept].sort(
    (left, right) => DEPTH_AXES.indexOf(left.axis) - DEPTH_AXES.indexOf(right.axis),
  )

  const claimed = property(payload, 'sharpest')
  const sharpest =
    isAxis(claimed) && axes.some((verdict) => verdict.axis === claimed)
      ? claimed
      : lowestScoring(axes)

  const result: AuditResult = { kind: 'audit', axes, sharpest }
  return { result, rejected }
}

/** The weakest axis of those that survived — the fallback when `sharpest` was dropped. */
function lowestScoring(axes: readonly AxisVerdict[]): DepthAxis {
  return axes.reduce((weakest, verdict) =>
    verdict.score < weakest.score ? verdict : weakest,
  ).axis
}

/**
 * Parses and guards an `attack` reply.
 *
 * @param raw - The reply's text block.
 * @returns The attacks that survived, and the lines that did not.
 * @throws If the reply is not JSON, or if nothing survived the guard.
 */
export function parseAttackReply(raw: string): ParsedReply {
  const payload = parseJson(raw)

  const shaped = arrayProperty(payload, 'attacks').flatMap((entry) => {
    const attack = property(entry, 'attack')
    if (typeof attack !== 'string') {
      return []
    }
    const targets = property(entry, 'targets')
    // An unrecognised axis costs the reader a label, not the attack itself, so it falls back
    // rather than dropping a line the debater still has to answer.
    return [{ targets: isAxis(targets) ? targets : 'mechanism', attack: attack.trim() }]
  })

  const { kept, rejected } = guard(shaped, (line) => line.attack, checkAttack)
  if (kept.length === 0) {
    throw new Error('Nothing in the attacks survived the Socratic check.')
  }

  const result: AttackResult = { kind: 'attack', attacks: kept }
  return { result, rejected }
}

/**
 * Parses and guards a `poi` reply.
 *
 * @param raw - The reply's text block.
 * @returns The POIs that survived, and the ones that did not.
 * @throws If the reply is not JSON, or if nothing survived the guard.
 */
export function parsePoiReply(raw: string): ParsedReply {
  const payload = parseJson(raw)
  const shaped = arrayProperty(payload, 'questions').map((entry) =>
    typeof entry === 'string' ? entry.trim() : entry,
  )

  const { kept, rejected } = guard(shaped, (question) => question, checkQuestion)
  if (kept.length === 0) {
    throw new Error('Nothing in the POI list survived the Socratic check.')
  }

  // `guard` only keeps items whose text is a string, and here the item *is* the text — the
  // narrowing is a fact the type system cannot see rather than an assumption.
  const questions = kept.filter((entry): entry is string => typeof entry === 'string')
  const result: PoiResult = { kind: 'poi', questions }
  return { result, rejected }
}

/**
 * Parses whichever reply the task asked for.
 *
 * @param task - The task that was run.
 * @param raw - The reply's text block.
 * @returns The parsed, guarded result.
 * @throws Whatever the task's own parser throws.
 */
export function parseReply(task: CoachTaskId, raw: string): ParsedReply {
  switch (task) {
    case 'audit':
      return parseAuditReply(raw)
    case 'attack':
      return parseAttackReply(raw)
    case 'poi':
      return parsePoiReply(raw)
  }
}
