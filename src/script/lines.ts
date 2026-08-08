/**
 * Turning template lines into deliverable text.
 *
 * A **line** is one continuous thought of the template — "In response they told us ___. This
 * argument is wrong because ___." — written as a list of parts: fixed prose, a slot naming the
 * field that fills the blank, or the item's ordinal. It is the unit the compiler emits or drops.
 *
 * **A line is emitted only when every slot in it has text.** Half a line is not deliverable:
 * reading "In response they told us. This argument is wrong because." out loud is worse than
 * saying nothing, and the debater needs to be told which sentence they cannot say, not handed a
 * sentence with a hole in it. The empty fields come back as `missing` and become `ScriptGap`s.
 *
 * The join rules below exist because the template writes its punctuation into the fixed prose
 * while the debater writes theirs into the field. Both are right, and naive concatenation
 * produces "…damage. , their argument fails." on real input.
 */

import type { Side } from '../formats/index.ts'
import { withOpponentName } from '../case/fields.ts'
import type { CaseField } from '../case/sections.ts'
import { tokenize } from '../analysis/text.ts'
import type { ScriptToken } from './types.ts'

/**
 * One piece of a template line.
 *
 * `slot` names a property on the block being rendered — the same key the field registry uses —
 * not a whole path; `LineContext.pathPrefix` supplies the rest.
 */
export type LinePart =
  | { readonly kind: 'fixed'; readonly text: string }
  | { readonly kind: 'slot'; readonly key: string }
  | { readonly kind: 'ordinal' }

/** One line of a template: fixed prose with blanks in it. */
export type LineTemplate = readonly LinePart[]

/**
 * Builds a fixed-prose part.
 *
 * @param text - Template prose, quoted verbatim where the template has any. Punctuation belongs
 *   here rather than being added at join time — the template's own commas are load-bearing.
 * @returns The part.
 */
export function fixed(text: string): LinePart {
  return { kind: 'fixed', text }
}

/**
 * Builds a slot part.
 *
 * @param key - Property name on the block, e.g. `whyBad`. A key the field registry does not
 *   have resolves to nothing and silently drops its line, which is why `skeleton.test.ts`
 *   renders every template against a fully filled case and asserts no slot went unresolved.
 * @returns The part.
 */
export function slot(key: string): LinePart {
  return { kind: 'slot', key }
}

/** The item's position, spelled out — "first", "second". Only meaningful in a repeatable block. */
export const ORDINAL: LinePart = { kind: 'ordinal' }

/** A run of text destined for a segment, tagged with the field it came from. */
export interface ScriptChunk {
  readonly text: string
  /** Case field path, or null for the template's own prose. */
  readonly fieldPath: string | null
}

/**
 * Builds a chunk of the template's own prose.
 *
 * Bypasses the Prop/Opp swap, so use it for words that name a real bench — the "( Prop/ Opp)"
 * slot in the clash signpost is the actual side whose argument it is, not a stand-in for
 * "the other side", and swapping it would point a government whip at themselves.
 *
 * @param text - The prose. Empty strings are dropped at assembly.
 * @returns A chunk with no field provenance.
 */
export function proseChunk(text: string): ScriptChunk {
  return { text, fieldPath: null }
}

/** What a line needs in order to resolve its slots. */
export interface LineContext {
  /** Everything before the slot key on a field path, with no trailing dot. */
  readonly pathPrefix: string
  /** Resolved fields for this seat, from `flattenFields(buildSections(...))`. */
  readonly fieldsByPath: ReadonlyMap<string, CaseField>
  /** Bench we argue from. `gov` swaps "Prop" for "Opp" in the template's prose, never in a field. */
  readonly side: Side
  /** 1-based position of the item, for `ORDINAL`. Pass 1 for a block that does not repeat. */
  readonly ordinal: number
}

/** The outcome of rendering one line. */
export interface RenderedLine {
  /** Chunks in order. Empty when the line was not deliverable. */
  readonly chunks: readonly ScriptChunk[]
  /** Fields the line needs that are blank. Non-empty means `chunks` is empty. */
  readonly missing: readonly CaseField[]
  /**
   * Slot paths with no field behind them at all.
   *
   * Always a bug in a template rather than a gap in a case — the seat is not asked for a field
   * the compiler is trying to say. Reported rather than thrown so one bad line cannot take a
   * whole speech down mid-round.
   */
  readonly unresolved: readonly string[]
}

// Words for a repeatable block's position. Past ten the numeral is used, because "my eleventh
// substantive" is not a sentence anyone has ever said in a round.
const ORDINAL_WORDS: readonly string[] = [
  'first', 'second', 'third', 'fourth', 'fifth',
  'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
]

/**
 * Spells a 1-based position.
 *
 * @param position - 1-based. Zero or negative returns `'first'`, because an ordinal that reads
 *   as "my zeroth substantive" is a worse failure than an off-by-one.
 * @returns A word up to "tenth", then a numeral with its suffix.
 */
export function ordinalWord(position: number): string {
  const word = ORDINAL_WORDS[Math.max(1, position) - 1]
  if (word) {
    return word
  }
  // 11th, 12th and 13th break the units-digit rule; everything else follows it.
  const teens = position % 100
  if (teens >= 11 && teens <= 13) {
    return `${String(position)}th`
  }
  const suffixes = ['th', 'st', 'nd', 'rd']
  return `${String(position)}${suffixes[position % 10] ?? 'th'}`
}

/**
 * Resolves one line against a case.
 *
 * @param template - The line's parts, in order.
 * @param context - Path prefix, resolved fields, bench, and ordinal.
 * @returns Chunks when every slot is filled; otherwise empty chunks and the blank fields.
 */
export function renderLine(template: LineTemplate, context: LineContext): RenderedLine {
  const chunks: ScriptChunk[] = []
  const missing: CaseField[] = []
  const unresolved: string[] = []

  for (const part of template) {
    switch (part.kind) {
      case 'fixed':
        chunks.push({ text: withOpponentName(part.text, context.side), fieldPath: null })
        break

      case 'ordinal':
        chunks.push({ text: ordinalWord(context.ordinal), fieldPath: null })
        break

      case 'slot': {
        const path = `${context.pathPrefix}.${part.key}`
        const field = context.fieldsByPath.get(path)
        if (!field) {
          unresolved.push(path)
        } else if (field.value.trim().length === 0) {
          missing.push(field)
        } else {
          chunks.push({ text: field.value.trim(), fieldPath: path })
        }
        break
      }
    }
  }

  const deliverable = missing.length === 0 && unresolved.length === 0
  return { chunks: deliverable ? chunks : [], missing, unresolved }
}

// A chunk ending in one of these has closed its sentence.
const TERMINATORS = new Set(['.', '!', '?'])
// A chunk starting with one of these continues the previous sentence.
const JOINERS = new Set([',', ';', ':'])

/** Where one chunk's text ended up in the assembled string. */
export interface TextRun {
  readonly fieldPath: string | null
  readonly start: number
  readonly end: number
}

/** Assembled text plus the field each run of it came from. */
export interface AssembledText {
  readonly text: string
  readonly runs: readonly TextRun[]
}

/** Mutable during assembly: a stripped terminator shortens the run that owned it. */
type MutableRun = { readonly fieldPath: string | null; readonly start: number; end: number }

/**
 * Whether the template's prose picks a sentence back up rather than starting a new one.
 *
 * Lowercase is the whole signal, and it is only trustworthy on the template's own prose: the
 * template splices mid-sentence ("This is bad because ___ is something that happens all the
 * time"), so a debater who ended their answer with a full stop has put one in the middle of the
 * template's sentence. A field starting lowercase says nothing — plenty of answers do.
 */
function continuesSentence(chunk: ScriptChunk, incomingFirst: string): boolean {
  if (JOINERS.has(incomingFirst)) {
    return true
  }
  return chunk.fieldPath === null && /^\p{Ll}/u.test(incomingFirst)
}

/**
 * Concatenates rendered lines into one paragraph of speech.
 *
 * Lines are separated by a newline and joined by nothing else — each one is a whole thought of
 * the template, and a teleprompter showing a substantive as a single unbroken block is a
 * teleprompter nobody can find their place in. Punctuation is never fixed up across a line
 * boundary, only within one.
 *
 * Inside a line there are four boundary cases, every one of which shows up on ordinary input
 * because the template punctuates its prose and the debater punctuates their answers:
 *
 *   1. Field closes a sentence the template was still in the middle of — "…irrecoverable." then
 *      ", their argument fails.", or "…young users." then "because". The field's terminator is
 *      dropped; the template's sentence was there first.
 *   2. Both sides terminate — "…damage." then ". But my second speaker…". The incoming duplicate
 *      goes, not the outgoing one, so the sentence break stays where the template put it.
 *   3. Prose opens with punctuation — no space before it, or the script reads "…damage ."
 *   4. Everything else — one space.
 *
 * @param lines - Chunks grouped by line, in delivery order. Blank chunks and lines that come out
 *   empty are dropped, so a caller never has to filter before calling.
 * @returns The paragraph, and where each surviving chunk landed in it.
 */
export function assembleText(lines: readonly (readonly ScriptChunk[])[]): AssembledText {
  let text = ''
  const runs: MutableRun[] = []

  for (const line of lines) {
    // Only true once this line has put something in `text`; until then there is no boundary to
    // resolve, and an empty line must not leave a stray newline behind.
    let lineStarted = false

    for (const chunk of line) {
      let piece = chunk.text.trim()
      if (piece.length === 0) {
        continue
      }

      if (!lineStarted) {
        if (text.length > 0) {
          text += '\n'
        }
        lineStarted = true
      } else {
        const previousLast = text[text.length - 1] ?? ''
        const incomingFirst = piece[0] ?? ''
        const previousClosed = TERMINATORS.has(previousLast)

        if (previousClosed && continuesSentence(chunk, incomingFirst)) {
          text = text.slice(0, -1)
          // The stripped character belonged to the run before this one; leaving its recorded end
          // past the string would hand a token an offset outside the text.
          const previousRun = runs[runs.length - 1]
          if (previousRun && previousRun.end > text.length) {
            previousRun.end = text.length
          }
          if (!JOINERS.has(incomingFirst)) {
            text += ' '
          }
        } else if (previousClosed && TERMINATORS.has(incomingFirst)) {
          piece = piece.slice(1).trimStart()
          if (piece.length === 0) {
            continue
          }
          text += ' '
        } else if (!JOINERS.has(incomingFirst) && !TERMINATORS.has(incomingFirst)) {
          text += ' '
        }
      }

      const start = text.length
      text += piece
      runs.push({ fieldPath: chunk.fieldPath, start, end: text.length })
    }
  }

  return { text, runs }
}

/**
 * Splits an assembled paragraph into tokens that remember where their words came from.
 *
 * Uses the analyzer's own tokenizer rather than a second one, so the word a finding underlines
 * and the word the aligner marks as skipped are the same word. A token never straddles two
 * runs: the only chunk boundary with no space at it is one where the incoming chunk starts with
 * punctuation, and punctuation is not part of a token.
 *
 * @param assembled - Text and runs from `assembleText`.
 * @param segmentId - Segment the tokens belong to; copied onto each of them.
 * @param firstIndex - Index of the first token in the whole speech, so the flat token list is
 *   contiguous across segments. Pass the running total, not zero.
 * @returns Tokens in order.
 */
export function tokenizeAssembled(
  assembled: AssembledText,
  segmentId: string,
  firstIndex: number,
): readonly ScriptToken[] {
  // Runs are in ascending order and never overlap, so one forward-only cursor covers the scan.
  let runCursor = 0

  return tokenize(assembled.text).map((token, offset) => {
    while (
      runCursor < assembled.runs.length - 1 &&
      (assembled.runs[runCursor]?.end ?? 0) <= token.start
    ) {
      runCursor += 1
    }
    const run = assembled.runs[runCursor]
    const insideRun = run && token.start >= run.start && token.start < run.end

    return {
      index: firstIndex + offset,
      text: token.text,
      start: token.start,
      end: token.end,
      segmentId,
      fieldPath: insideRun ? run.fieldPath : null,
    }
  })
}
