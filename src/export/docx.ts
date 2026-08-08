/**
 * The case as a `.docx`, in the template's own layout.
 *
 * **The rows come from `buildSections`, not from the `Case`.** Third time that decision has paid
 * — the analyzer made it, then the compiler — and it buys the same things here: the left column
 * is the template's question verbatim, because `fields.ts` imports those from the `*_LABELS`
 * records that `template-fidelity.test.ts` diffs against the real `.docx`. A label cannot drift
 * in this export without failing a test that never mentions exporting. The Prop/Opp swap and the
 * "(OR)" fork resolution come for free with it.
 *
 * **Every block, in template order, whatever seat the case is assigned to.** The editor is
 * role-scoped and this is not, because a `.docx` is what gets printed and handed to the rest of
 * the team — a whip's export that silently omits DEFINITION is not the template. Empty rows are
 * kept for the same reason: the blank form is exactly what someone filling the rest of it needs.
 *
 * What is *structurally* absent is still absent. A case that answered "no" to the mechanism
 * question has no POLICY table, an AP case has no EXTENSION, and a block with no items — no
 * rebuttals written yet — contributes no heading. That is the case saying the block does not
 * exist, which is a different statement from a blank row.
 */

import type { BlockId, SpeakerRole } from '../formats/index.ts'
import { getFormat, getRole } from '../formats/index.ts'
import { buildSections } from '../case/sections.ts'
import type { CaseSection } from '../case/sections.ts'
import { formatClock } from '../case/time.ts'
import type { Case, Preempt } from '../types/case.ts'
import { buildDocx, paragraph, table, type TableRow } from './ooxml.ts'
import type { SpeechSheet } from './speechSheet.ts'

/**
 * Every block, in the order the template prints them.
 *
 * Deliberately not assembled from the format registry's roles: those lists are what one seat
 * fills, and unioning them would put the blocks in whichever order the first role happened to
 * list them. This order is the docx's — DEFINITION, POLICY, SUBSTANTIVE STRUCTURE, POLICY
 * REBUTTAL, REBUTTAL, OPPOSING TEAM REBUTTALS — with EXTENSION last because it has no counterpart
 * in the template at all.
 */
export const FULL_TEMPLATE_BLOCKS: readonly BlockId[] = [
  'prep',
  'setup',
  'definition',
  'policy',
  'substantives',
  'policyRebuttal',
  'rebuttals',
  'opposingRebuttals',
  'clashes',
  'extension',
]

/**
 * A pseudo-seat that fills the whole template.
 *
 * `buildSections` projects against a role, so exporting everything means handing it a role that
 * is asked for everything. Its `side` is the case's own, which is what drives the Prop/Opp swap;
 * nothing else on it is read.
 *
 * @param caseFile - The case being exported. Only `side` is used.
 * @returns A role that no format registry contains and nothing may persist — passing this id to
 *   `getRole` finds nothing, which is the point: it is not a seat anybody speaks from.
 */
export function fullTemplateRole(caseFile: Case): SpeakerRole {
  return {
    id: 'export-full-template',
    label: 'Full template',
    shortLabel: 'All',
    side: caseFile.side,
    team: caseFile.side,
    blocks: FULL_TEMPLATE_BLOCKS,
    canGiveReply: false,
  }
}

/** Bench name as a debater would say it, for the document's meta line. */
function sideLabel(caseFile: Case): string {
  return caseFile.side === 'gov' ? 'Government' : 'Opposition'
}

/**
 * The line under the title: format, bench, seat, and when this was exported.
 *
 * An unassigned or stale position is named as such rather than omitted. A case switched from AP
 * to BP keeps its old role id until someone reassigns it, and a printout that quietly drops the
 * seat is how that goes unnoticed until the round.
 */
function metaLine(caseFile: Case, exportedOn: string): string {
  const format = getFormat(caseFile.format)
  const role = getRole(caseFile.format, caseFile.position)
  const seat = role ? role.label : 'no position assigned'
  return `${format.label} · ${sideLabel(caseFile)} · ${seat} · exported ${exportedOn}`
}

/**
 * Headings for each section, disambiguated only where they need to be.
 *
 * Repeatable blocks all carry the same template heading — three substantives are three
 * "SUBSTANTIVE STRUCTURE" tables — so those get the nav label appended. A block that appears once
 * keeps the template's heading untouched.
 */
function headingsFor(sections: readonly CaseSection[]): readonly string[] {
  const titleCounts = new Map<string, number>()
  for (const section of sections) {
    titleCounts.set(section.title, (titleCounts.get(section.title) ?? 0) + 1)
  }
  return sections.map((section) =>
    (titleCounts.get(section.title) ?? 0) > 1 ? `${section.title} — ${section.navLabel}` : section.title,
  )
}

/**
 * Renders a substantive's preempts.
 *
 * The one place this export reaches outside `buildSections`, and the reason is the reason they
 * sit outside it: preempts are not template rows, so they are not projected, not counted by the
 * completeness meter and not analysed. They are still prep — the answers to the three attacks
 * Layer B predicted — and an export that drops them throws away the highest-leverage work in the
 * app because of where it happens to be stored.
 */
function preemptRows(preempts: readonly Preempt[]): readonly TableRow[] {
  const rows: TableRow[] = []
  for (const preempt of preempts) {
    // A preempt with neither half written is a row someone added and never used. It carries no
    // information onto paper, unlike an empty template row, which is a question still to answer.
    if (preempt.attack.trim().length === 0 && preempt.response.trim().length === 0) {
      continue
    }
    const source = preempt.source === 'claude' ? ' (Claude)' : ''
    rows.push({ label: `Anticipated attack${source}`, value: preempt.attack })
    rows.push({ label: 'My answer', value: preempt.response })
  }
  return rows
}

/**
 * Builds the whole case as a Word document.
 *
 * @param caseFile - The case to export. Empty fields become empty rows rather than being skipped
 *   — see the module docstring for why an unfilled row is worth printing and an absent block
 *   is not.
 * @param exportedOn - Date for the meta line, already formatted for display. Passed in formatted
 *   rather than as an ISO timestamp for two reasons: it keeps this function deterministic and
 *   free of the machine's time zone, and slicing a UTC ISO string prints yesterday's date to
 *   anyone exporting after their local midnight.
 * @returns The `.docx` bytes, ready to write to disk.
 */
export function buildCaseDocx(caseFile: Case, exportedOn: string): Uint8Array {
  const sections = buildSections(caseFile, fullTemplateRole(caseFile))
  const headings = headingsFor(sections)
  const substantivesById = new Map(caseFile.substantives.map((sub) => [sub.id, sub]))

  const blocks: string[] = [
    paragraph(caseFile.prep.motion.trim() || 'Untitled case', 'Title'),
    paragraph(metaLine(caseFile, exportedOn), 'Meta'),
  ]

  for (const [index, section] of sections.entries()) {
    blocks.push(paragraph(headings[index] ?? section.title, 'Heading1'))

    for (const group of section.groups) {
      if (group.heading.length > 0) {
        blocks.push(paragraph(group.heading, 'Heading2'))
      }
      blocks.push(
        table(group.fields.map((field) => ({ label: field.label, value: field.value }))),
      )
    }

    // `section.id` for a substantive is `substantives.<uuid>`; the id after the dot is the one
    // the preempts hang off.
    const substantive = substantivesById.get(section.id.slice('substantives.'.length))
    if (section.blockId === 'substantives' && substantive) {
      const rows = preemptRows(substantive.preempts)
      if (rows.length > 0) {
        blocks.push(paragraph('Preempts', 'Heading2'))
        blocks.push(table(rows))
      }
    }
  }

  return buildDocx(blocks.join(''))
}

/**
 * Writes a speech sheet as a Word document.
 *
 * The sheet's other output is the browser's print dialog, which is also how it becomes a PDF.
 * This exists beside it because printing depends on the webview offering a print path at all,
 * and a script you cannot get off the machine on the morning of a round is not a backup.
 *
 * @param sheet - A sheet from `buildSpeechSheet`. Its gaps are printed under the script; a sheet
 *   with gaps is the normal mid-prep state, not an error to suppress.
 * @param exportedOn - Date for the meta line, already formatted. See {@link buildCaseDocx}.
 * @returns The `.docx` bytes.
 */
export function buildSpeechSheetDocx(sheet: SpeechSheet, exportedOn: string): Uint8Array {
  const length = `${String(sheet.wordCount)} words · about ${formatClock(sheet.estimatedSeconds)} of ${formatClock(sheet.speechSeconds)}`
  const blocks: string[] = [
    paragraph(sheet.motion, 'Title'),
    paragraph(`${sheet.meta} · exported ${exportedOn}`, 'Meta'),
    paragraph(sheet.isOverLength ? `${length} — over the slot` : length, 'Meta'),
  ]

  for (const section of sheet.sections) {
    blocks.push(paragraph(section.heading, 'Heading1'))
    for (const text of section.paragraphs) {
      blocks.push(paragraph(text))
    }
  }

  if (sheet.gaps.length > 0) {
    blocks.push(paragraph('Lines you cannot say yet', 'Heading1'))
    // A blank right-hand column on purpose: printed mid-prep, this is where the answer gets
    // written by hand, and the label is already the template's own question.
    blocks.push(table(sheet.gaps.map((gap) => ({ label: gap.label, value: '' }))))
  }

  return buildDocx(blocks.join(''))
}
