/**
 * The script compiler — a filled case becomes a speech.
 *
 * This is the hinge the app turns on. The case builder and the speech trainer are not two
 * features that happen to share a database; they are two ends of one pipeline, and this module
 * is the join. Everything after it — teleprompter, aligner, timer, report — reads
 * `CompiledScript` and never looks at a `Case` again.
 *
 * **Values are read through `buildSections`, not off the `Case`.** Same decision phase 3 made
 * for the analyzer, and it buys the same four things: the field list is already scoped to one
 * seat, it already resolves only the chosen side of each "(OR)" fork, its `path` is the string
 * `setFieldByPath` accepts, and its `label` is already pointed at the right bench. Structure —
 * which clashes exist, which engagement kind, which branch — still comes off the `Case`, since
 * the projection flattens exactly that away.
 *
 * **The block walk mirrors `buildSections` on purpose.** Both iterate `role.blocks`, so the
 * script comes out in the order the editor asks the questions, which is the order the template
 * asks them, which is the order the speech is given in. Three orderings that must not drift
 * apart, kept together by being the same loop written twice rather than one loop generalised
 * into something neither half reads well.
 *
 * The prep sheet compiles to nothing. The motion, the 5W1H notes, the POI list and the scratch
 * pad are things a debater reads, not things they say.
 */

import type { SpeakerRole } from '../formats/index.ts'
import { buildSections, ENGAGEMENT_KIND_LABELS, flattenFields } from '../case/sections.ts'
import type { CaseField, CaseSection } from '../case/sections.ts'
import type { Case, Clash, ClashEngagement } from '../types/case.ts'
import type { ScriptChunk } from './lines.ts'
import { assembleText, ordinalWord, proseChunk, renderLine, tokenizeAssembled } from './lines.ts'
import {
  benchName,
  cardinalWord,
  CLASH_NUMBER_WORDS,
  CLASH_PHRASES,
  OVERLAP_LINES,
  OUR_ARGUMENT_LINES,
  REFUSED_BRANCH_LINES,
  respondedBranchLines,
  THEIR_ARGUMENT_LINES,
  type SegmentTemplate,
} from './skeleton.ts'
import {
  CASE_DIVISION_LINES,
  DEFINITION_LINES,
  EXTENSION_LINES,
  OPPOSING_REBUTTAL_LINES,
  POLICY_LINES,
  POLICY_REBUTTAL_LINES,
  REBUTTAL_LINES,
  SETUP_LINES,
  SUBSTANTIVE_LINES,
} from './signposts.ts'
import { estimateSeconds } from './types.ts'
import type { CompiledScript, ScriptGap, ScriptSegment, SegmentKind } from './types.ts'

/** One template rendered against one block. An engagement needs two: its own rows, then its branch. */
interface TemplatePart {
  readonly template: SegmentTemplate
  /** Everything before the slot key on a field path, with no trailing dot. */
  readonly pathPrefix: string
}

/** Identity of a segment, before its text exists. */
interface SegmentSpec {
  readonly id: string
  readonly sectionId: string
  readonly kind: SegmentKind
  /** 1-based position within a repeatable block, for the `ORDINAL` part. */
  readonly ordinal: number
}

/** Accumulates a speech as the block walk runs. */
interface ScriptBuilder {
  readonly caseFile: Case
  readonly fieldsByPath: ReadonlyMap<string, CaseField>
  readonly sectionsById: ReadonlyMap<string, CaseSection>
  readonly segments: ScriptSegment[]
  readonly gaps: ScriptGap[]
  /** Running token total, so the flat token list is contiguous across segments. */
  tokenCount: number
}

/** Nav label of the section a segment belongs to, or '' if the section is not in this seat. */
function headingFor(builder: ScriptBuilder, sectionId: string): string {
  return builder.sectionsById.get(sectionId)?.navLabel ?? ''
}

/**
 * Adds one segment, recording a gap for every field that blocked a line.
 *
 * Gaps are recorded even when the segment ends up with no text at all: the debater needs to
 * know which sentences they cannot say yet, and a segment that vanished entirely is the case
 * where that matters most.
 */
function pushSegment(
  builder: ScriptBuilder,
  spec: SegmentSpec,
  heading: string,
  lines: readonly (readonly ScriptChunk[])[],
  missing: readonly CaseField[],
): void {
  for (const field of missing) {
    builder.gaps.push({
      fieldPath: field.path,
      label: field.label,
      sectionId: spec.sectionId,
      segmentId: spec.id,
    })
  }

  const assembled = assembleText(lines)
  if (assembled.text.length === 0) {
    return
  }

  const tokens = tokenizeAssembled(assembled, spec.id, builder.tokenCount)
  builder.tokenCount += tokens.length
  builder.segments.push({
    id: spec.id,
    sectionId: spec.sectionId,
    kind: spec.kind,
    heading,
    text: assembled.text,
    tokens,
    isEdited: false,
  })
}

/**
 * Renders one or more templates into a single segment.
 *
 * A slot that resolves to no field at all is a bug in a template rather than a gap in a case —
 * the compiler is trying to say a row this seat is not asked for. Its line drops silently here
 * and `skeleton.test.ts` is what catches it, because taking a speech down mid-round over a
 * mistyped key is the worse failure.
 */
function emitSegment(
  builder: ScriptBuilder,
  spec: SegmentSpec,
  parts: readonly TemplatePart[],
  heading = headingFor(builder, spec.sectionId),
): void {
  const lines: ScriptChunk[][] = []
  const missing: CaseField[] = []

  for (const part of parts) {
    for (const line of part.template) {
      const rendered = renderLine(line, {
        pathPrefix: part.pathPrefix,
        fieldsByPath: builder.fieldsByPath,
        side: builder.caseFile.side,
        ordinal: spec.ordinal,
      })
      if (rendered.chunks.length > 0) {
        lines.push([...rendered.chunks])
      }
      missing.push(...rendered.missing)
    }
  }

  pushSegment(builder, spec, heading, lines, missing)
}

/** Shorthand for the common case: one template over one block. */
function emitBlock(
  builder: ScriptBuilder,
  spec: SegmentSpec,
  template: SegmentTemplate,
  pathPrefix: string,
): void {
  emitSegment(builder, spec, [{ template, pathPrefix }])
}

/** The lines for one engagement: its own rows, then whichever side of the "(OR)" fork is live. */
function engagementParts(engagement: ClashEngagement, pathPrefix: string): readonly TemplatePart[] {
  if (engagement.kind === 'overlap') {
    return [{ template: OVERLAP_LINES, pathPrefix }]
  }

  const own = engagement.kind === 'their-argument' ? THEIR_ARGUMENT_LINES : OUR_ARGUMENT_LINES
  const branch = engagement.response.branch
  return [
    { template: own, pathPrefix },
    branch === 'refused'
      ? { template: REFUSED_BRANCH_LINES, pathPrefix: `${pathPrefix}.refused` }
      : {
          template: respondedBranchLines(engagement.response.responded.isExtension),
          pathPrefix: `${pathPrefix}.responded`,
        },
  ]
}

/**
 * Emits "I have two clashes for the house. One ___ and Two ___."
 *
 * Two lines, and only the second can drop: the count is a fact about the case, while the titles
 * are fields. A whip who has decided they have two clashes but not yet named them still opens
 * the section, which is also how it sounds in a real round.
 */
function emitClashOpening(builder: ScriptBuilder, clashes: readonly Clash[], spec: SegmentSpec): void {
  const lines: ScriptChunk[][] = [
    [
      proseChunk('I have'),
      proseChunk(cardinalWord(clashes.length)),
      proseChunk(clashes.length === 1 ? 'clash' : 'clashes'),
      proseChunk(CLASH_PHRASES.clashCountTail),
    ],
  ]

  // The enumeration is one sentence, so a single unnamed clash drops all of it rather than
  // leaving the house waiting for a "Two" that never comes.
  const titleChunks: ScriptChunk[] = []
  const missing: CaseField[] = []
  for (const [index, clash] of clashes.entries()) {
    const path = `clashes.${clash.id}.title`
    const field = builder.fieldsByPath.get(path)
    if (!field || field.value.trim().length === 0) {
      if (field) {
        missing.push(field)
      }
      continue
    }
    if (index > 0) {
      titleChunks.push(proseChunk(index === clashes.length - 1 ? 'and' : ','))
    }
    titleChunks.push(proseChunk(CLASH_NUMBER_WORDS[index] ?? String(index + 1)))
    titleChunks.push({ text: field.value.trim(), fieldPath: path })
  }

  if (missing.length === 0 && titleChunks.length > 0) {
    lines.push([...titleChunks, proseChunk('.')])
  }

  pushSegment(builder, spec, headingFor(builder, spec.sectionId), lines, missing)
}

/**
 * Emits one clash's signpost: which arguments it covers, and whose they are.
 *
 * Assembled here rather than declared as a template because both the number of clashes and the
 * number of arguments in one are properties of the case, and both get said out loud. The
 * template only writes this sentence for the first clash; it is emitted for every clash that
 * names any arguments, because a house that has heard three clashes signposted once has heard
 * it once.
 */
function emitClashSignpost(
  builder: ScriptBuilder,
  clash: Clash,
  index: number,
  spec: SegmentSpec,
): void {
  const lines: ScriptChunk[][] = []
  const missing: CaseField[] = []

  // "Moving on to my second clash on ___." The first clash was already named in the opener.
  if (index > 0) {
    const titlePath = `clashes.${clash.id}.title`
    const titleField = builder.fieldsByPath.get(titlePath)
    if (titleField && titleField.value.trim().length > 0) {
      lines.push([
        proseChunk(CLASH_PHRASES.laterClashLead),
        proseChunk(ordinalWord(spec.ordinal)),
        proseChunk(CLASH_PHRASES.laterClashTail),
        { text: titleField.value.trim(), fieldPath: titlePath },
        proseChunk('.'),
      ])
    } else if (titleField) {
      missing.push(titleField)
    }
  }

  // "…I will be dealing with Prop argument on X; Opp argument on Y; and Prop argument on Z."
  const handledChunks: ScriptChunk[] = []
  const handledMissing: CaseField[] = []
  for (const [handledIndex, handled] of clash.handledArguments.entries()) {
    const path = `clashes.${clash.id}.handledArguments.${handled.id}.topic`
    const field = builder.fieldsByPath.get(path)
    if (!field || field.value.trim().length === 0) {
      if (field) {
        handledMissing.push(field)
      }
      continue
    }
    if (handledIndex > 0) {
      handledChunks.push(
        proseChunk(handledIndex === clash.handledArguments.length - 1 ? '; and' : ';'),
      )
    }
    handledChunks.push(
      proseChunk(benchName(handled.side)),
      proseChunk(CLASH_PHRASES.argumentOn),
      { text: field.value.trim(), fieldPath: path },
    )
  }

  if (handledChunks.length > 0 && handledMissing.length === 0) {
    const signpost: ScriptChunk[] =
      index === 0
        ? [
            proseChunk(CLASH_PHRASES.firstClashLead),
            proseChunk(ordinalWord(spec.ordinal)),
            proseChunk(CLASH_PHRASES.firstClashTail),
          ]
        : []
    lines.push([
      ...signpost,
      proseChunk(CLASH_PHRASES.dealingWith),
      ...handledChunks,
      proseChunk('.'),
    ])
  }
  missing.push(...handledMissing)

  pushSegment(builder, spec, headingFor(builder, spec.sectionId), lines, missing)
}

/** Emits the clash opener, then per clash its signpost and one segment per engagement. */
function emitClashes(builder: ScriptBuilder): void {
  const clashes = builder.caseFile.clashes
  if (clashes.length === 0) {
    return
  }

  const firstSectionId = `clashes.${clashes[0]?.id ?? ''}`
  emitClashOpening(builder, clashes, {
    id: `${firstSectionId}#opening`,
    sectionId: firstSectionId,
    kind: 'clash',
    ordinal: 1,
  })

  for (const [index, clash] of clashes.entries()) {
    const sectionId = `clashes.${clash.id}`
    emitClashSignpost(builder, clash, index, {
      id: `${sectionId}#signpost`,
      sectionId,
      kind: 'clash',
      ordinal: index + 1,
    })

    const heading = headingFor(builder, sectionId)
    for (const engagement of clash.engagements) {
      const pathPrefix = `${sectionId}.engagements.${engagement.id}`
      emitSegment(
        builder,
        {
          id: `${sectionId}#engagement.${engagement.id}`,
          sectionId,
          kind: 'engagement',
          ordinal: index + 1,
        },
        engagementParts(engagement, pathPrefix),
        `${heading} — ${ENGAGEMENT_KIND_LABELS[engagement.kind]}`,
      )
    }
  }
}

/**
 * Compiles one seat's case into the speech they will give.
 *
 * @param caseFile - The case to compile. Blank fields do not produce blank sentences — the line
 *   that needed them is dropped and reported in `gaps`, so a half-filled case yields a short
 *   script rather than an undeliverable one.
 * @param role - The seat. Drives which blocks are compiled and in what order, so passing the
 *   wrong one produces a speech made of somebody else's material.
 * @returns Segments in delivery order, the flat token list, and every field that blocked a line.
 */
export function compileScript(caseFile: Case, role: SpeakerRole): CompiledScript {
  const sections = buildSections(caseFile, role)
  const builder: ScriptBuilder = {
    caseFile,
    fieldsByPath: new Map(flattenFields(sections).map((field) => [field.path, field])),
    sectionsById: new Map(sections.map((section) => [section.id, section])),
    segments: [],
    gaps: [],
    tokenCount: 0,
  }

  for (const blockId of role.blocks) {
    switch (blockId) {
      // Nothing on the prep sheet is spoken.
      case 'prep':
        break

      case 'setup':
        emitBlock(
          builder,
          { id: 'setup#opening', sectionId: 'setup', kind: 'setup', ordinal: 1 },
          SETUP_LINES,
          'setup',
        )
        // Only the speaker who owns the DEFINITION table announces the split; a deputy
        // repeating it is telling the house something it already knows.
        if (role.blocks.includes('definition')) {
          emitBlock(
            builder,
            { id: 'setup#division', sectionId: 'setup', kind: 'setup', ordinal: 1 },
            CASE_DIVISION_LINES,
            'setup.caseDivision',
          )
        }
        break

      case 'definition':
        emitBlock(
          builder,
          { id: 'definition#body', sectionId: 'definition', kind: 'definition', ordinal: 1 },
          DEFINITION_LINES,
          'definition',
        )
        break

      case 'policy':
        if (caseFile.policy) {
          emitBlock(
            builder,
            { id: 'policy#body', sectionId: 'policy', kind: 'policy', ordinal: 1 },
            POLICY_LINES,
            'policy',
          )
        }
        break

      case 'substantives':
        for (const [index, substantive] of caseFile.substantives.entries()) {
          const sectionId = `substantives.${substantive.id}`
          emitBlock(
            builder,
            { id: `${sectionId}#body`, sectionId, kind: 'substantive', ordinal: index + 1 },
            SUBSTANTIVE_LINES,
            sectionId,
          )
        }
        break

      case 'policyRebuttal':
        emitBlock(
          builder,
          {
            id: 'policyRebuttal#body',
            sectionId: 'policyRebuttal',
            kind: 'policyRebuttal',
            ordinal: 1,
          },
          POLICY_REBUTTAL_LINES,
          'policyRebuttal',
        )
        break

      case 'rebuttals':
        for (const [index, rebuttal] of caseFile.rebuttals.entries()) {
          const sectionId = `rebuttals.${rebuttal.id}`
          emitBlock(
            builder,
            { id: `${sectionId}#body`, sectionId, kind: 'rebuttal', ordinal: index + 1 },
            REBUTTAL_LINES,
            sectionId,
          )
        }
        break

      case 'opposingRebuttals':
        for (const [index, opposing] of caseFile.opposingRebuttals.entries()) {
          const sectionId = `opposingRebuttals.${opposing.id}`
          emitBlock(
            builder,
            { id: `${sectionId}#body`, sectionId, kind: 'opposingRebuttal', ordinal: index + 1 },
            OPPOSING_REBUTTAL_LINES,
            sectionId,
          )
        }
        break

      case 'clashes':
        emitClashes(builder)
        break

      case 'extension':
        if (caseFile.extension) {
          emitBlock(
            builder,
            { id: 'extension#body', sectionId: 'extension', kind: 'extension', ordinal: 1 },
            EXTENSION_LINES,
            'extension',
          )
        }
        break
    }
  }

  return finish(builder.segments, builder.gaps)
}

/** Flattens tokens, deduplicates gaps by field, and totals the length. */
function finish(
  segments: readonly ScriptSegment[],
  gaps: readonly ScriptGap[],
): CompiledScript {
  const tokens = segments.flatMap((segment) => [...segment.tokens])
  const seenPaths = new Set<string>()
  const uniqueGaps = gaps.filter((gap) => {
    if (seenPaths.has(gap.fieldPath)) {
      return false
    }
    seenPaths.add(gap.fieldPath)
    return true
  })

  return {
    segments,
    tokens,
    gaps: uniqueGaps,
    wordCount: tokens.length,
    estimatedSeconds: estimateSeconds(tokens.length),
  }
}
