/**
 * Words that make a claim sound less certain than it is.
 *
 * The lowest-severity rule in the set, and it earns its place at the point where the case
 * becomes a speech: everything flagged here is a word that will be said out loud, and "basically"
 * costs the same second as the clause it displaced.
 *
 * One finding per distinct term per field — a field with four "very"s has one habit, not four.
 */

import type { CaseField } from '../../case/sections.ts'
import { HEDGE_TERMS } from '../lexicons.ts'
import type { HedgeTerm } from '../lexicons.ts'
import { fieldsOfKind } from '../scope.ts'
import { findPhrases, tokenize } from '../text.ts'
import type { TextSpan } from '../text.ts'
import type { AnalysisRule, Finding, RuleContext } from '../types.ts'

/**
 * Whether a match is the hedge or the word's other, legitimate sense.
 *
 * Only `just` needs this today, but it needs it badly: "a just war" and "the just outcome" are
 * the adjective, and flagging those in a debate case would be embarrassing.
 */
function isHedgeUse(passage: string, term: HedgeTerm, span: TextSpan): boolean {
  const before = tokenize(passage.slice(0, span.start)).at(-1)?.normalized ?? ''
  const after = tokenize(passage.slice(span.end)).at(0)?.normalized ?? ''
  return !term.notPrecededBy.includes(before) && !term.notFollowedBy.includes(after)
}

/** Flags the first genuine use of each hedge in one field. */
function judgeField(field: CaseField): readonly Finding[] {
  return HEDGE_TERMS.flatMap((term): Finding[] => {
    const match = findPhrases(field.value, [term.phrase]).find((candidate) =>
      isHedgeUse(field.value, term, candidate.span),
    )
    if (!match) {
      return []
    }

    return [
      {
        fieldPath: field.path,
        rule: 'hedgeAndFiller',
        severity: 'info',
        span: match.span,
        message: `"${match.text}" weakens the sentence without adding to it.`,
        socraticPrompt: 'Read the sentence without it. Did anything you meant get lost?',
      },
    ]
  })
}

/**
 * Runs the hedge check.
 *
 * @param context - Rules context. Only `fields` is read.
 * @returns One finding per distinct hedge per field.
 */
export function runHedgeAndFiller(context: RuleContext): readonly Finding[] {
  return fieldsOfKind(context.fields, ['argument']).flatMap(judgeField)
}

/** The hedge-and-filler rule. */
export const HEDGE_AND_FILLER_RULE: AnalysisRule = {
  id: 'hedgeAndFiller',
  title: 'Hedges and filler',
  run: runHedgeAndFiller,
}
