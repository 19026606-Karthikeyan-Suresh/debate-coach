/**
 * Words that name nobody.
 *
 * "Society" is not a stakeholder and "many" is not a number. The rule that makes this usable
 * rather than deafening is the escape hatch: a vague word in a sentence that also contains a
 * number, a date, a percentage, or a named institution is a summary of something specific, and
 * is left alone. "Many people" is flagged; "many people — 40% of drivers in Jakarta" is not.
 *
 * One finding per distinct term per field. A paragraph saying "people" five times has one
 * problem, not five.
 */

import type { CaseField } from '../../case/sections.ts'
import { VAGUE_TERMS } from '../lexicons.ts'
import { fieldKind, fieldsOfKind } from '../scope.ts'
import { findPhrases, hasSpecificityMarker, splitSentences } from '../text.ts'
import type { Sentence } from '../text.ts'
import type { AnalysisRule, Finding, RuleContext, Severity } from '../types.ts'

/** The sentence containing an offset, or null if the offset is past the end. */
function sentenceAt(sentences: readonly Sentence[], offset: number): Sentence | null {
  return sentences.find((sentence) => offset >= sentence.start && offset < sentence.end) ?? null
}

/** Flags the first unqualified use of each vague term in one field. */
function judgeField(field: CaseField): readonly Finding[] {
  // A vague actor split poisons every substantive that leans on it and every cross-field check
  // that reads it, so it is worth interrupting for. Mid-paragraph vagueness is a polish note.
  const severity: Severity = fieldKind(field) === 'name' ? 'warn' : 'info'
  const sentences = splitSentences(field.value)
  const alreadyFlagged = new Set<string>()
  const findings: Finding[] = []

  for (const match of findPhrases(field.value, VAGUE_TERMS)) {
    if (alreadyFlagged.has(match.phrase)) {
      continue
    }
    const sentence = sentenceAt(sentences, match.span.start)
    if (sentence && hasSpecificityMarker(sentence.text)) {
      continue
    }
    alreadyFlagged.add(match.phrase)
    findings.push({
      fieldPath: field.path,
      rule: 'vagueness',
      severity,
      span: match.span,
      message: `"${match.text}" names nobody in particular.`,
      socraticPrompt: 'Which people, how many, and where? Replace it with something checkable.',
    })
  }

  return findings
}

/**
 * Runs the vagueness check.
 *
 * @param context - Rules context. Only `fields` is read.
 * @returns One finding per distinct unqualified vague term per field.
 */
export function runVagueness(context: RuleContext): readonly Finding[] {
  return fieldsOfKind(context.fields, ['argument', 'name']).flatMap(judgeField)
}

/** The vagueness rule. */
export const VAGUENESS_RULE: AnalysisRule = {
  id: 'vagueness',
  title: 'Vague actors',
  run: runVagueness,
}
