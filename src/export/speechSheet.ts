/**
 * The speech on paper — the compiled script, laid out to be read from at a lectern.
 *
 * The teleprompter is the primary way this script gets delivered and the sheet is the backup:
 * the laptop dies, the room has no desk, the chair asks you to speak from the front. It is the
 * same `compileScript` output either way, which is the whole reason the compiler landed before
 * any of the screens that read it.
 *
 * Pure and free of JSX so it can be tested under vitest's node environment; the component that
 * renders it and the `.docx` writer that saves it both take a {@link SpeechSheet} and add
 * nothing to it.
 *
 * **Delivery edits are not applied.** `script/edits.ts` exists and nothing writes to it yet, so
 * there is no stored edit to lay over — wiring it in here before there is a UI to produce one
 * would be a code path with no way to reach it.
 */

import { getFormat } from '../formats/index.ts'
import type { SpeakerRole } from '../formats/index.ts'
import { compileScript } from '../script/compile.ts'
import type { ScriptGap } from '../script/types.ts'
import type { Case } from '../types/case.ts'

/** One run of the speech under a single heading. */
export interface SpeechSheetSection {
  /** Id of the first segment in the run. Stable across recompiles, so usable as a React key. */
  readonly id: string
  /** Heading from the compiled segments, e.g. "Sub 2" or "Clash 1 — Their argument". */
  readonly heading: string
  /** One entry per segment, in delivery order. Each is a paragraph as it will be spoken. */
  readonly paragraphs: readonly string[]
}

/** A whole printable speech. */
export interface SpeechSheet {
  /** The motion, or a placeholder when the prep sheet has no motion written yet. */
  readonly motion: string
  /** Format, bench and seat on one line, for under the title. */
  readonly meta: string
  readonly sections: readonly SpeechSheetSection[]
  /**
   * Lines the compiler could not emit. Printed under the script rather than hidden: a sheet that
   * silently omits a third of the speech looks finished, and finding out at the lectern is worse
   * than reading a list of what is missing beforehand.
   */
  readonly gaps: readonly ScriptGap[]
  readonly wordCount: number
  readonly estimatedSeconds: number
  /** The format's slot, to compare the estimate against. */
  readonly speechSeconds: number
  /** True when the script as written runs past the slot. See `SPEAKING_WORDS_PER_MINUTE`. */
  readonly isOverLength: boolean
}

/**
 * Compiles a case into a printable speech.
 *
 * Consecutive segments sharing a heading are merged into one section, because on paper the
 * heading is a signpost the reader's eye uses to find their place and repeating it above every
 * paragraph destroys exactly that.
 *
 * @param caseFile - The case to compile. A half-filled one produces a short script and a long
 *   `gaps` list rather than an error — that is the honest state of the prep and printing it is
 *   the point.
 * @param role - The seat. Drives which blocks compile and in what order; passing another seat's
 *   role produces a sheet made of somebody else's material.
 * @returns The sheet, ready to render or write to a `.docx`.
 */
export function buildSpeechSheet(caseFile: Case, role: SpeakerRole): SpeechSheet {
  const format = getFormat(caseFile.format)
  const script = compileScript(caseFile, role)

  const sections: SpeechSheetSection[] = []
  for (const segment of script.segments) {
    const current = sections.at(-1)
    if (current && current.heading === segment.heading) {
      sections[sections.length - 1] = {
        ...current,
        paragraphs: [...current.paragraphs, segment.text],
      }
      continue
    }
    sections.push({ id: segment.id, heading: segment.heading, paragraphs: [segment.text] })
  }

  const side = caseFile.side === 'gov' ? 'Government' : 'Opposition'

  return {
    motion: caseFile.prep.motion.trim() || 'Untitled case',
    meta: `${format.label} · ${side} · ${role.label}`,
    sections,
    gaps: script.gaps,
    wordCount: script.wordCount,
    estimatedSeconds: script.estimatedSeconds,
    speechSeconds: format.speechSeconds,
    isOverLength: script.estimatedSeconds > format.speechSeconds,
  }
}
