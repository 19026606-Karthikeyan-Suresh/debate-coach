/**
 * What Claude is actually sent.
 *
 * The case is described through `buildSections`/`flattenFields`, the same projection the analyzer
 * and the script compiler read, for the same three reasons: it is already scoped to one seat, it
 * resolves only the chosen side of each "(OR)" fork, and its labels are the template's own
 * questions already pointed at the right bench by `withOpponentName`. So the model sees the case
 * the way the debater sees it, phrased in the words their coach's template uses, and nothing here
 * has to keep a second list of what a field is called.
 *
 * # The system prompt says why, not just what
 *
 * "Only ask questions" on its own is a rule to be lawyered around, and a model told a rule
 * without its reason will find the edge of it. The reason is short and it is true: an argument
 * the debater did not build is one they cannot defend under a POI. It is in the prompt.
 *
 * Blank rows are named as blank rather than omitted, and the prompt says what to do about them —
 * *not* "tell them to fill it in", because the completeness meter already does that and saying
 * it twice is how a panel becomes noise. That is the same rule Layer A follows.
 */

import type { SpeakerRole } from '../formats/index.ts'
import { getFormat } from '../formats/index.ts'
import type { CaseField } from '../case/sections.ts'
import { buildSections, flattenFields } from '../case/sections.ts'
import type { Case } from '../types/case.ts'
import { ATTACK_SCHEMA, AUDIT_SCHEMA, POI_SCHEMA } from './schema.ts'
import { AXIS_SCORE_LABELS, DEPTH_AXES, DEPTH_AXIS_DESCRIPTIONS } from './types.ts'
import type { CoachPrompt, CoachTaskId } from './types.ts'

/** Blocks the POI task reads. A whip's clash script is not what the other bench asks about. */
const POI_BLOCKS: readonly string[] = ['prep', 'setup', 'definition', 'policy', 'substantives', 'extension']

/**
 * The rule, and the reason for it.
 *
 * Sent on every task. Deliberately short: the schema is what actually stops a paragraph of
 * advice, and a long prompt arguing with the model about it would only add tokens to every call.
 */
const SOCRATIC_CORE = `You are a judge on a competitive parliamentary debate, helping one debater prepare their case before the round. The formats are Asian Parliamentary and British Parliamentary.

You ask. You do not answer. Every question you write must be one a judge would say out loud in the round, and it must not carry its own answer — not as a hint, not as an example, not in the "have you considered that X?" form. "What makes you think the platform acts at all?" is a question. "Have you considered that platforms only act under regulatory pressure?" is an argument with a question mark on it.

The reason is not politeness. An argument the debater did not build is one they cannot defend under a point of information, and a case assembled out of someone else's reasoning falls over the first time a judge pushes on it. Your job is to find the hole. Filling it is theirs.

Write one sentence per question, under 200 characters, in the voice of someone speaking rather than writing. No preambles, no summaries, no advice. A row marked (blank) is one the debater has not written yet; their own completeness meter already tells them that, so do not ask them to fill it in — ask the question its absence leaves unanswered.`

/** The task-specific half of the system prompt. */
const TASK_RULES: Readonly<Record<CoachTaskId, string>> = {
  audit: `Score this substantive on five axes and ask one question about each.

${DEPTH_AXES.map((axis) => `- ${axis}: ${DEPTH_AXIS_DESCRIPTIONS[axis]}`).join('\n')}

Scores: ${Object.entries(AXIS_SCORE_LABELS)
    .map(([score, label]) => `${score} ${label.toLowerCase()}`)
    .join(', ')}. Score what is on the page, not what the debater probably meant. Then name the one axis whose question they should answer first.`,

  attack: `Write the three strongest responses the opposing bench would give to this substantive, each phrased the way they would actually say it in the round — their voice, not yours, and not a description of their argument.

Do not write any part of the answer to them. The debater answers each one themselves; that is the exercise. An attack that comes with its own rebuttal is worth nothing to them.

Pick attacks that go through different axes where you can. Three lines that all say "your impact is speculative" is one attack written out three times.`,

  poi: `Write the points of information the opposing bench is most likely to offer against this case.

A POI is asked out loud in about fifteen seconds, so keep each to one sentence someone could say while standing up. Aim for the ones that are hard to answer rather than the ones that are easy to ask — a POI the debater can bat away has already done its damage to the person who offered it, not to them.

Do not write the answers. The debater fills those in themselves, in the template's own POI table.`,
}

/**
 * Renders fields as the model should read them.
 *
 * @param fields - Fields to describe, in document order.
 * @param keepsBlanks - When true, an empty row is listed as `(blank)`; when false it is dropped.
 *   The audit needs the blanks — an absent mechanism is the finding — while the POI task does
 *   not, because a row the debater never wrote is a row the other bench cannot see.
 * @returns One `- label: value` line per field, newlines inside a value indented so a multi-line
 *   answer cannot be misread as the start of the next row.
 */
function describeFields(fields: readonly CaseField[], keepsBlanks: boolean): string {
  const lines: string[] = []
  for (const field of fields) {
    const value = field.value.trim()
    if (value.length === 0) {
      if (keepsBlanks) {
        lines.push(`- ${field.label} (blank)`)
      }
      continue
    }
    lines.push(`- ${field.label}: ${value.replace(/\n/g, '\n  ')}`)
  }
  return lines.join('\n')
}

/** The seat, in one line, so the model knows which speech this case is for. */
function describeSeat(caseFile: Case, role: SpeakerRole): string {
  const format = getFormat(caseFile.format)
  const bench = caseFile.side === 'gov' ? 'Government' : 'Opposition'
  return `Format: ${format.label} — ${role.label} (${bench})`
}

/**
 * Pulls one substantive's fields out of the seat's projection.
 *
 * Reading them through `buildSections` rather than off the `Case` is what keeps the labels the
 * template's own and the ordering the template's own.
 */
function substantiveFields(
  caseFile: Case,
  role: SpeakerRole,
  substantiveId: string,
): readonly CaseField[] {
  const prefix = `substantives.${substantiveId}.`
  return flattenFields(buildSections(caseFile, role)).filter((field) =>
    field.path.startsWith(prefix),
  )
}

/**
 * Builds the `audit` call.
 *
 * @param caseFile - The case being prepped.
 * @param role - The seat. Decides which fields exist at all; passing a seat that does not run
 *   substantives yields an empty row list, which the caller should catch before sending.
 * @param substantiveId - Which substantive to score.
 * @returns The prompt, ready for the proxy.
 * @throws If the substantive is not in this seat's projection — a stale id from a deleted
 *   substantive would otherwise send Claude an empty case and bill for the privilege.
 */
export function buildAuditPrompt(
  caseFile: Case,
  role: SpeakerRole,
  substantiveId: string,
): CoachPrompt {
  const fields = substantiveFields(caseFile, role, substantiveId)
  if (fields.length === 0) {
    throw new Error(`No such substantive in this seat: ${substantiveId}`)
  }

  const user = [
    describeSeat(caseFile, role),
    `Motion: ${caseFile.prep.motion.trim() || '(not written yet)'}`,
    '',
    'The substantive, row by row, exactly as the debater wrote it:',
    describeFields(fields, true),
  ].join('\n')

  return { task: 'audit', system: systemPromptFor('audit'), user, schema: AUDIT_SCHEMA }
}

/**
 * Builds the `attack` call.
 *
 * Existing preempts go into the prompt so a second run produces new material rather than the
 * same three lines reworded. Their responses do not: what the debater has already answered is
 * not information the opposing bench has.
 *
 * @param caseFile - The case being prepped.
 * @param role - The seat.
 * @param substantiveId - Which substantive to attack.
 * @returns The prompt, ready for the proxy.
 * @throws If the substantive is not in this seat's projection.
 */
export function buildAttackPrompt(
  caseFile: Case,
  role: SpeakerRole,
  substantiveId: string,
): CoachPrompt {
  const fields = substantiveFields(caseFile, role, substantiveId)
  if (fields.length === 0) {
    throw new Error(`No such substantive in this seat: ${substantiveId}`)
  }

  const existing = (caseFile.substantives.find((item) => item.id === substantiveId)?.preempts ?? [])
    .map((preempt) => preempt.attack.trim())
    .filter((attack) => attack.length > 0)

  const sections = [
    describeSeat(caseFile, role),
    `Motion: ${caseFile.prep.motion.trim() || '(not written yet)'}`,
    '',
    'The substantive, row by row, exactly as the debater wrote it:',
    describeFields(fields, true),
  ]

  if (existing.length > 0) {
    sections.push(
      '',
      'Attacks already on this substantive. Do not repeat them or reword them:',
      existing.map((attack) => `- ${attack}`).join('\n'),
    )
  }

  return {
    task: 'attack',
    system: systemPromptFor('attack'),
    user: sections.join('\n'),
    schema: ATTACK_SCHEMA,
  }
}

/**
 * Builds the `poi` call.
 *
 * Reads the whole case rather than one substantive, because the other bench does not offer POIs
 * one substantive at a time — the sharpest ones go at the definition or the mechanism.
 *
 * @param caseFile - The case being prepped.
 * @param role - The seat. Only that seat's blocks are described, so a whip is not asked to
 *   defend a definition they never gave.
 * @returns The prompt, ready for the proxy.
 */
export function buildPoiPrompt(caseFile: Case, role: SpeakerRole): CoachPrompt {
  const fields = buildSections(caseFile, role)
    .filter((section) => POI_BLOCKS.includes(section.blockId))
    .flatMap((section) => section.groups.flatMap((group) => group.fields))

  const existing = caseFile.prep.pois
    .map((poi) => poi.text.trim())
    .filter((text) => text.length > 0)

  const sections = [
    describeSeat(caseFile, role),
    `Motion: ${caseFile.prep.motion.trim() || '(not written yet)'}`,
    '',
    'The case as it stands. Blank rows are omitted:',
    describeFields(fields, false),
  ]

  if (existing.length > 0) {
    sections.push(
      '',
      'POIs already on the list. Do not repeat them or reword them:',
      existing.map((poi) => `- ${poi}`).join('\n'),
    )
  }

  return {
    task: 'poi',
    system: systemPromptFor('poi'),
    user: sections.join('\n'),
    schema: POI_SCHEMA,
  }
}

/**
 * Assembles the system prompt for one task.
 *
 * @param task - Which task. Its rule is appended to the shared Socratic core rather than
 *   replacing it, so the constraint cannot be dropped by adding a task.
 * @returns The full system prompt.
 */
export function systemPromptFor(task: CoachTaskId): string {
  return `${SOCRATIC_CORE}\n\n${TASK_RULES[task]}`
}
