/**
 * The Socratic guard — the half of the constraint a schema cannot express.
 *
 * A schema can guarantee that a reply has a field called `question` and nothing called `answer`.
 * It cannot stop the string in that field being "Have you considered that platforms only act
 * under regulatory pressure, so the mechanism needs a fine attached?" — which is an argument with
 * a question mark stapled to the front of it, and is exactly the failure this file exists for.
 *
 * Two tests, both cheap and both blunt on purpose:
 *
 * 1. **Length.** A judge's question is one sentence. Past a couple of hundred characters the
 *    model has stopped asking and started explaining, whatever the words are.
 * 2. **Voice.** A fixed list of phrasings that only appear when the model is writing the
 *    debater's case for them — second-person instructions, first-person advocacy, and the
 *    suggestion-in-question-clothing form.
 *
 * Rejected items are dropped and **reported**, not silently deleted. A guard that quietly
 * removes two of three attacks is indistinguishable from a model that only had one, and the
 * difference is the whole reason to trust the panel.
 */

import type { CoachRejection } from './types.ts'

/**
 * Longest a question may be.
 *
 * Measured against the questions Layer A already writes — the longest `socraticPrompt` in
 * `src/analysis/rules/` is comfortably under half this. The cap is set well above them so it
 * catches explanation rather than a wordy but honest question.
 */
export const MAX_QUESTION_CHARACTERS = 220

/**
 * Longest an opposition line may be.
 *
 * Wider than a question because an attack has to carry its own reasoning — "your mechanism
 * assumes X, and X has never happened" is two clauses before it says anything. Still a cap: past
 * this it is a speech, and a speech is not something the debater can answer in a row of a table.
 */
export const MAX_ATTACK_CHARACTERS = 300

/**
 * Phrasings that mean the model has stopped asking.
 *
 * Each is a shape rather than a topic, so they do not need updating when the motions change.
 * Every one of them is pinned by a test with both a rejected and an accepted example, because a
 * guard that eats honest questions is worse than no guard — it makes the feature look broken and
 * teaches the debater to stop reading the panel.
 */
const COACHING_VOICE: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  {
    // "you should say", "you need to explain" — an instruction, not a question.
    pattern: /\byou (?:should|must|need to|ought to|have to|could|might want to)\b/i,
    reason: 'tells the debater what to do',
  },
  {
    // The suggestion wearing a question mark. The single most common way an argument arrives.
    pattern: /\bhave you (?:considered|thought about|tried)\b/i,
    reason: 'a suggestion with a question mark on it',
  },
  {
    pattern: /\b(?:try|consider|suggest)\s+(?:saying|arguing|adding|framing|explaining|noting)\b/i,
    reason: 'scripts a line for the debater',
  },
  {
    pattern: /\b(?:respond|answer|reply|rebut|counter)\s+(?:by|with|that)\b/i,
    reason: 'scripts a line for the debater',
  },
  {
    pattern: /\byour (?:answer|response|rebuttal|reply)\s+(?:should|could|would|needs|must)\b/i,
    reason: 'scripts a line for the debater',
  },
  {
    pattern: /\b(?:the answer is|the key is that|the point is that)\b/i,
    reason: 'answers its own question',
  },
  {
    pattern: /\bhere(?:'s| is) (?:how|why|what|the)\b/i,
    reason: 'answers its own question',
  },
  {
    pattern: /\b(?:i|we)(?:'d| would| will)? (?:argue|say|suggest|recommend|point out)\b/i,
    reason: 'argues in the first person',
  },
]

/**
 * Checks one question.
 *
 * @param text - The question as the model wrote it. Whitespace-only counts as empty.
 * @returns The reason it was rejected, or null when it passes.
 */
export function checkQuestion(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return 'empty'
  }
  if (trimmed.length > MAX_QUESTION_CHARACTERS) {
    return `longer than a question (${String(trimmed.length)} characters)`
  }
  // A question that is not interrogative is a statement, and a statement here is an argument.
  // Cheap, structural, and impossible to satisfy accidentally while writing prose.
  if (!trimmed.endsWith('?')) {
    return 'not phrased as a question'
  }
  return checkVoice(trimmed)
}

/**
 * Checks one opposition line.
 *
 * The voice rules apply unchanged: an attack that says "you should answer this by…" has stopped
 * being the other side's argument and started being the debater's.
 *
 * @param text - The attack as the model wrote it.
 * @returns The reason it was rejected, or null when it passes.
 */
export function checkAttack(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return 'empty'
  }
  if (trimmed.length > MAX_ATTACK_CHARACTERS) {
    return `longer than a line an opponent would say (${String(trimmed.length)} characters)`
  }
  return checkVoice(trimmed)
}

/** Runs the shared voice rules, returning the first reason that matches. */
function checkVoice(text: string): string | null {
  for (const rule of COACHING_VOICE) {
    if (rule.pattern.test(text)) {
      return rule.reason
    }
  }
  return null
}

/** What survived the guard, and what did not. */
export interface Guarded<TItem> {
  readonly kept: readonly TItem[]
  readonly rejected: readonly CoachRejection[]
}

/**
 * Runs a check over a list, keeping what passes.
 *
 * @param items - Everything the model returned for one field.
 * @param textOf - Pulls the string to check out of an item. An item whose text is not a string
 *   is rejected rather than coerced — a number where a question should be means the reply did
 *   not match the schema, and rendering `[object Object]` would hide that.
 * @param check - Either {@link checkQuestion} or {@link checkAttack}.
 * @returns The survivors in their original order, plus one rejection per casualty.
 */
export function guard<TItem>(
  items: readonly TItem[],
  textOf: (item: TItem) => unknown,
  check: (text: string) => string | null,
): Guarded<TItem> {
  const kept: TItem[] = []
  const rejected: CoachRejection[] = []

  for (const item of items) {
    const text = textOf(item)
    if (typeof text !== 'string') {
      rejected.push({ text: String(text), reason: 'not text' })
      continue
    }
    const reason = check(text)
    if (reason === null) {
      kept.push(item)
    } else {
      rejected.push({ text, reason })
    }
  }

  return { kept, rejected }
}
