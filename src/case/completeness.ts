/**
 * How much of the case this seat is actually responsible for is filled in.
 *
 * Scoped to the role, never to the whole document: a whip who has left DEFINITION blank has
 * not left anything blank, because the first speaker owns that table. A meter that punished
 * them for it would be one more thing to ignore.
 *
 * The prep timer reads `findNextGap` for its nudges, which is the reason this counts fields in
 * document order rather than by importance — the template's order *is* the prep order, so the
 * first hole going down the page is the one to fill next.
 */

import type { SpeakerRole } from '../formats/index.ts'
import type { Case } from '../types/case.ts'
import type { CaseField, CaseSection } from './sections.ts'
import { buildSections } from './sections.ts'

/** Fill state of one section. */
export interface SectionCompleteness {
  readonly sectionId: string
  readonly navLabel: string
  readonly filled: number
  readonly total: number
  /** 0 to 1. A section with no fields at all scores 1 rather than dividing by zero. */
  readonly ratio: number
}

/** The first unfilled field, with enough context to name it in a sentence. */
export interface CaseGap {
  readonly sectionId: string
  readonly navLabel: string
  readonly field: CaseField
}

/** Fill state of everything this seat owns. */
export interface CaseCompleteness {
  readonly sections: readonly SectionCompleteness[]
  readonly filled: number
  readonly total: number
  readonly ratio: number
  /** Null once nothing is left blank. */
  readonly nextGap: CaseGap | null
}

/**
 * Whether a field counts as answered.
 *
 * Whitespace does not count — a field holding a stray space or a newline from a paste is
 * blank as far as the debater is concerned.
 *
 * @param field - The field to test.
 * @returns True when there is real text in it.
 */
export function isFilled(field: CaseField): boolean {
  return field.value.trim().length > 0
}

/**
 * Measures how much of a seat's case is filled in.
 *
 * @param caseFile - The case to measure.
 * @param role - The seat. Blocks outside this role's responsibility are not counted at all,
 *   so switching roles changes the score without any text changing.
 * @returns Per-section counts, the overall ratio, and the first gap in document order.
 */
export function measureCase(caseFile: Case, role: SpeakerRole): CaseCompleteness {
  return measureSections(buildSections(caseFile, role))
}

/**
 * Measures already-built sections.
 *
 * Split out from `measureCase` so the editor, which has sections in hand for rendering, does
 * not rebuild them on every keystroke just to move the meter.
 *
 * @param sections - Sections from `buildSections`.
 * @returns The same shape `measureCase` returns.
 */
export function measureSections(sections: readonly CaseSection[]): CaseCompleteness {
  const perSection: SectionCompleteness[] = []
  let filledTotal = 0
  let fieldTotal = 0
  let nextGap: CaseGap | null = null

  for (const section of sections) {
    let sectionFilled = 0
    let sectionTotal = 0

    for (const group of section.groups) {
      for (const field of group.fields) {
        sectionTotal += 1
        if (isFilled(field)) {
          sectionFilled += 1
        } else {
          nextGap ??= { sectionId: section.id, navLabel: section.navLabel, field }
        }
      }
    }

    perSection.push({
      sectionId: section.id,
      navLabel: section.navLabel,
      filled: sectionFilled,
      total: sectionTotal,
      ratio: sectionTotal === 0 ? 1 : sectionFilled / sectionTotal,
    })
    filledTotal += sectionFilled
    fieldTotal += sectionTotal
  }

  return {
    sections: perSection,
    filled: filledTotal,
    total: fieldTotal,
    ratio: fieldTotal === 0 ? 1 : filledTotal / fieldTotal,
    nextGap,
  }
}

/**
 * Phrases the next gap as a pacing nudge.
 *
 * @param completeness - A measurement from `measureCase`.
 * @param remainingSeconds - Prep time left. Negative or zero drops the time clause rather than
 *   printing "-2 min left", which is what an overrunning timer would otherwise produce.
 * @returns A single line for the timer panel, or null when nothing is left blank.
 */
export function phraseNudge(
  completeness: CaseCompleteness,
  remainingSeconds: number,
): string | null {
  const gap = completeness.nextGap
  if (!gap) {
    return null
  }

  const where = `${gap.navLabel} — ${gap.field.label}`
  if (remainingSeconds <= 0) {
    return where
  }
  // Rounded up: with 3:20 left, "3 min left" reads as less time than there is, and under-
  // promising time is the safe direction during prep.
  const minutesLeft = Math.ceil(remainingSeconds / 60)
  return `${String(minutesLeft)} min left — ${where}`
}
