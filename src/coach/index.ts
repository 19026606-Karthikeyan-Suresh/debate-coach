/**
 * Layer B — Claude as an opt-in coach.
 *
 * Three calls, one shape each: build the prompt from the case, send it through the Rust proxy,
 * parse and guard what comes back. Nothing here holds state and nothing here touches the case —
 * writing an attack into `Preempt` or a POI into the template's list is a separate, deliberate
 * action the debater takes, because a guess does not get to edit a case unasked. That is the same
 * rule phase 6 settled for improvisations, for the same reason.
 *
 * Layer A is not affected by any of this. Every heuristic in `src/analysis/` runs offline, always,
 * whether or not a key is saved — a debater on a tournament wifi that does not work still gets
 * the full depth panel.
 */

import type { SpeakerRole } from '../formats/index.ts'
import type { Case } from '../types/case.ts'
import { requestCoach } from './client.ts'
import { parseReply } from './parse.ts'
import { buildAttackPrompt, buildAuditPrompt, buildPoiPrompt } from './prompts.ts'
import type { CoachOutcome, CoachPrompt } from './types.ts'

/**
 * Sends a prompt and turns the reply into a result.
 *
 * @param prompt - From `prompts.ts`.
 * @returns The parsed result, whatever the guard threw away, and what the call cost.
 * @throws With Rust's message on a transport or API failure, or with the parser's message when
 *   the reply arrived but nothing in it survived the Socratic check.
 */
async function run(prompt: CoachPrompt): Promise<CoachOutcome> {
  const reply = await requestCoach(prompt)
  const { result, rejected } = parseReply(prompt.task, reply.json)
  return {
    result,
    rejected,
    model: reply.model,
    inputTokens: reply.inputTokens,
    outputTokens: reply.outputTokens,
  }
}

/**
 * Scores one substantive on the five axes and asks a question about each.
 *
 * @param caseFile - The case being prepped.
 * @param role - The seat. A seat that does not run substantives has none to audit and the call
 *   throws rather than sending an empty case.
 * @param substantiveId - Which substantive.
 * @returns The audit.
 */
export async function runAudit(
  caseFile: Case,
  role: SpeakerRole,
  substantiveId: string,
): Promise<CoachOutcome> {
  return await run(buildAuditPrompt(caseFile, role, substantiveId))
}

/**
 * Asks for the opposition's strongest responses to one substantive.
 *
 * The highest-leverage call in the app, and the reason `Preempt` exists on the data model.
 *
 * @param caseFile - The case being prepped.
 * @param role - The seat.
 * @param substantiveId - Which substantive.
 * @returns The attacks.
 */
export async function runAttack(
  caseFile: Case,
  role: SpeakerRole,
  substantiveId: string,
): Promise<CoachOutcome> {
  return await run(buildAttackPrompt(caseFile, role, substantiveId))
}

/**
 * Asks for the POIs the other bench is most likely to offer against the whole case.
 *
 * @param caseFile - The case being prepped.
 * @param role - The seat, which decides how much of the case the other bench can see.
 * @returns The POIs.
 */
export async function runPois(caseFile: Case, role: SpeakerRole): Promise<CoachOutcome> {
  return await run(buildPoiPrompt(caseFile, role))
}

export { readCoachStatus } from './client.ts'
export { isCoachEnabled, parseCoachEnabled } from './config.ts'
export type { CoachStatus } from './client.ts'
export { AXIS_SCORE_LABELS, DEPTH_AXES, DEPTH_AXIS_DESCRIPTIONS, DEPTH_AXIS_LABELS } from './types.ts'
export type {
  AttackLine,
  AttackResult,
  AuditResult,
  AxisScore,
  AxisVerdict,
  CoachOutcome,
  CoachRejection,
  CoachResult,
  CoachTaskId,
  DepthAxis,
  PoiResult,
} from './types.ts'
