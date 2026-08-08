/**
 * Layer B's contract.
 *
 * Three tasks, one rule: **Claude asks, the debater answers.** Layer A can tell you a row has no
 * causal connective in it. It cannot tell you that your mechanism assumes a regulator who has
 * never once acted, because that is not a property of the text. That gap is the whole reason
 * this layer exists, and it is also the reason it has to be fenced — a model that can see the
 * hole can fill it, and an argument the debater did not build is one they cannot defend under a
 * POI.
 *
 * The fence is structural, not a request in a prompt. Every reply is constrained by a JSON schema
 * whose string-valued fields are questions and one deliberate exception, and every string that
 * comes back is run through `guardQuestion` before it reaches the screen. `schema.ts` holds the
 * first half, `validate.ts` the second, and both are pinned by tests that try to get round them.
 *
 * The exception is `attack`. An opposition line is prose and is not a question, and it is also
 * the opposite of writing the debater's argument: it is the other side's. Writing it out is what
 * makes it answerable, and the answer stays the debater's to write in `Preempt.response`.
 */

/** The three things Claude is allowed to be asked for. */
export type CoachTaskId = 'audit' | 'attack' | 'poi'

/**
 * What a judge weighs when a substantive is worth points.
 *
 * These are the five the audit scores and the five an attack can target. They are deliberately
 * an enum rather than free text: naming which axis a question or an attack lands on is useful,
 * and letting the model write a sentence about it is a hole in the fence.
 */
export type DepthAxis = 'mechanism' | 'impact' | 'comparative' | 'evidence' | 'linkBack'

/** Every axis, in the order the audit renders them. */
export const DEPTH_AXES: readonly DepthAxis[] = [
  'mechanism',
  'impact',
  'comparative',
  'evidence',
  'linkBack',
]

/** Short names for the axes, for the panel. */
export const DEPTH_AXIS_LABELS: Readonly<Record<DepthAxis, string>> = {
  mechanism: 'Mechanism',
  impact: 'Impact',
  comparative: 'Comparative',
  evidence: 'Evidence',
  linkBack: 'Link-back',
}

/**
 * One line each on what the axis means, shown under the score.
 *
 * Written here rather than asked of the model: they are the same five sentences every time, and
 * a definition is not a judgement.
 */
export const DEPTH_AXIS_DESCRIPTIONS: Readonly<Record<DepthAxis, string>> = {
  mechanism: 'How the harm actually happens, step by step.',
  impact: 'Who is hurt, how badly, how likely, and how permanently.',
  comparative: 'Why your world beats theirs, not just why yours is good.',
  evidence: 'A named case, number, or institution rather than a plausible story.',
  linkBack: 'Why winning this wins the motion.',
}

/**
 * How well one axis is covered.
 *
 * A four-point scale rather than a percentage, because the distinction that matters is the one
 * between 1 and 2 — asserted versus argued — and a percentage invites arguing about 63 vs 71.
 */
export type AxisScore = 0 | 1 | 2 | 3

/** What each score means, in the panel and in the prompt. */
export const AXIS_SCORE_LABELS: Readonly<Record<AxisScore, string>> = {
  0: 'Absent',
  1: 'Asserted',
  2: 'Argued',
  3: 'Argued and weighed',
}

/** One axis's verdict. */
export interface AxisVerdict {
  readonly axis: DepthAxis
  readonly score: AxisScore
  /** The question a judge would ask about this axis. Never contains its own answer. */
  readonly question: string
}

/** What `audit` returns. */
export interface AuditResult {
  readonly kind: 'audit'
  /** One verdict per axis, in {@link DEPTH_AXES} order. */
  readonly axes: readonly AxisVerdict[]
  /** The axis to fix first. An enum, so it cannot become a paragraph of advice. */
  readonly sharpest: DepthAxis
}

/** One opposition response, phrased as the other bench would say it. */
export interface AttackLine {
  /** Which axis the attack goes through. */
  readonly targets: DepthAxis
  /** The line itself. Not an answer to it — that is the debater's to write. */
  readonly attack: string
}

/** What `attack` returns. */
export interface AttackResult {
  readonly kind: 'attack'
  readonly attacks: readonly AttackLine[]
}

/** What `poi` returns — questions for the template's POI list, and nothing else. */
export interface PoiResult {
  readonly kind: 'poi'
  /** POIs as they would be asked out loud. */
  readonly questions: readonly string[]
}

/** Any task's result, discriminated by `kind`. */
export type CoachResult = AuditResult | AttackResult | PoiResult

/** One string the Socratic guard threw away, and why. */
export interface CoachRejection {
  /** The offending text, so the reason can be checked rather than taken on trust. */
  readonly text: string
  /** Which rule it broke, in the words the panel shows. */
  readonly reason: string
}

/**
 * One completed call.
 *
 * `rejected` is surfaced rather than swallowed. A guard that silently deletes a third of the
 * reply looks identical to a model that only had two things to say, and the difference matters:
 * one is the fence working and the other is Claude having less to offer than it seemed.
 */
export interface CoachOutcome {
  readonly result: CoachResult
  readonly rejected: readonly CoachRejection[]
  /** Model that actually served the reply; differs from the request when a fallback ran. */
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * A JSON Schema, as far as this app cares.
 *
 * Not typed structurally on purpose. Anthropic supports a subset of JSON Schema and the useful
 * check is not "is this a schema" but "does this schema have a hole in it", which is what
 * `schema.test.ts` walks the object to answer.
 */
export type JsonSchema = Readonly<Record<string, unknown>>

/** Everything one call needs, ready for the Rust proxy. */
export interface CoachPrompt {
  readonly task: CoachTaskId
  readonly system: string
  readonly user: string
  readonly schema: JsonSchema
}
