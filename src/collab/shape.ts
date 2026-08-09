/**
 * The case, flattened to the addresses the rest of the app already uses.
 *
 * Phase 2 gave every editable row a path string (`substantives.<uuid>.whyBad`), phase 3 addressed
 * findings with it, phase 4 stamped it on every script token. This module says that the same
 * string is the CRDT's key, so the shared document needs no second addressing scheme and a
 * remote edit lands on exactly the row a local one would.
 *
 * A case flattens into three kinds of thing, and the split is by **what merging means**:
 *
 *   * **text** — a row somebody types prose into. Two people editing one row at once must both
 *     keep their words, so these become `Y.Text` and merge character by character.
 *   * **scalar** — a choice, not prose: the seat's side, the "(OR)" branch, whether a block
 *     exists at all. Last writer wins is the *correct* answer here; two people cannot half-pick
 *     a branch.
 *   * **list** — which substantives exist and in what order. An ordered set of ids, so two
 *     people adding a substantive at once end up with two substantives rather than one.
 *
 * Nothing here imports Yjs. `walkCase` and `buildCase` are inverses over plain data, which is
 * what lets the projection be tested without a document at all.
 *
 * **What is deliberately absent from the shared document**: `id`, `createdAt`, `updatedAt`,
 * `position` and `visibility`. See {@link CaseIdentity}.
 */

import type { FormatId, Side } from '../formats/index.ts'
import type {
  Case,
  Clash,
  ClashEngagement,
  EngagementResponse,
  MechanismDecision,
  Preempt,
  Visibility,
} from '../types/case.ts'
import {
  CASE_DIVISION_LABELS,
  DEFINITION_LABELS,
  EXTENSION_LABELS,
  FIVE_W1H_LABELS,
  OPPOSING_REBUTTAL_LABELS,
  POLICY_LABELS,
  POLICY_REBUTTAL_LABELS,
  REBUTTAL_LABELS,
  SUBSTANTIVE_LABELS,
} from '../types/case.ts'
import {
  createClash,
  createDefinitionBlock,
  createEngagementResponse,
  createExtensionBlock,
  createOpposingRebuttalBlock,
  createOurArgumentEngagement,
  createOverlapEngagement,
  createPointOfInformation,
  createPolicyBlock,
  createPolicyRebuttalBlock,
  createPreempt,
  createPrepBlock,
  createRebuttalBlock,
  createSetupBlock,
  createSubstantive,
  createTheirArgumentEngagement,
} from '../types/createCase.ts'

/**
 * Whether a leaf merges as prose or as a choice.
 *
 * `text` becomes a `Y.Text`; `scalar` becomes one entry in a `Y.Map`.
 */
export type LeafKind = 'text' | 'scalar'

/** One addressable value in a case. */
export interface CaseLeaf {
  /** The `setFieldByPath` path, or — for the handful of values that control structure rather
   *  than content — a path in the same style. See {@link walkCase} for the full list. */
  readonly path: string
  readonly kind: LeafKind
  /** Always a string. Booleans are `'true'` / `'false'` so one map holds every scalar. */
  readonly value: string
}

/** One repeatable collection, as the ids it currently holds, in order. */
export interface CaseList {
  /** The collection's path — `substantives`, `clashes.<uuid>.engagements`, and so on. */
  readonly path: string
  readonly ids: readonly string[]
}

/** A case, flattened. */
export interface CaseShape {
  readonly leaves: readonly CaseLeaf[]
  readonly lists: readonly CaseList[]
}

/**
 * The five things about a case that are **not** shared, supplied when projecting back.
 *
 * Each is a fact about one install's copy rather than about the round being prepped, and putting
 * any of them in the CRDT breaks something:
 *
 *   * `id` / `createdAt` — every participant keeps their own row. A guest's copy is theirs to
 *     export and theirs to push; `cases_update` grants the owner alone, so a shared id would
 *     give four people one row that three of them cannot write.
 *   * `updatedAt` — a last-writer-wins timestamp that every keystroke on both sides rewrites
 *     conveys nothing, and the sync queue compares it against *this* install's server row.
 *   * `position` — **the seat is the point.** A PM and a DPM co-prepping one round are filling
 *     different blocks of the same content; sharing the seat would move one of them.
 *   * `visibility` — who may read your row is your decision about your row.
 */
export interface CaseIdentity {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly position: string
  readonly visibility: Visibility
}

/** Text rows of the prep sheet. `needsMechanism` is a scalar and `pois` is a list. */
const PREP_TEXT_KEYS = ['motion', 'actorsSplit', 'scratch'] as const

/** Text rows of CASE SET-UP. `caseDivision` is a nested group, handled separately. */
const SETUP_TEXT_KEYS = [
  'characterisation',
  'burdens',
  'policy',
  'stance',
  'oppositionRebuttals',
] as const

/** Text rows of a POI. */
const POI_TEXT_KEYS = ['text', 'response'] as const

/** Text rows of a preempt. `source` is a scalar. */
const PREEMPT_TEXT_KEYS = ['attack', 'response'] as const

/** Text rows of the "they refused to respond" branch. */
const REFUSED_TEXT_KEYS = ['whyBad', 'alternativeScenario'] as const

/** Text rows of the "(OR)" branch. `isExtension` is a scalar. */
const RESPONDED_TEXT_KEYS = [
  'theirResponse',
  'whyWrong',
  'concededCharacterisation',
  'whyStillFails',
  'furthermore',
  'theirBestCase',
  'whyBestCaseBad',
  'ourWorstCase',
] as const

/**
 * Text rows of each engagement kind, keyed by the `kind` tag.
 *
 * Listed rather than derived because `kind` is what decides the shape, and a projection that
 * guessed the keys off whatever the object happened to carry would silently drop a row the
 * moment a kind gained one.
 */
const ENGAGEMENT_TEXT_KEYS: Readonly<Record<ClashEngagement['kind'], readonly string[]>> = {
  'their-argument': ['theirSpeakerPosition', 'whatTheyTold', 'ourSpeakerPosition', 'whyNotTrue'],
  'our-argument': ['ourSpeakerPosition', 'whatWeTold', 'theirResponse', 'whyWrong'],
  overlap: [
    'theirArgumentTopic',
    'ourArgumentTopic',
    'whatPropTold',
    'ourRebuttal',
    'ourSubstantive',
    'whyCharacterisationFails',
    'theirResponse',
    'whyInsufficient',
    'evenIfCharacterisation',
    'furtherHurts',
    'furtherHurtsWhy',
    'theirBestCase',
    'theirBestCaseWhy',
    'whyStillBad',
    'ourWorstCase',
    'pointThatStands',
  ],
}

/** Reads the keys of a `*_LABELS` record as the path fragments they name. */
function labelKeys(labels: Readonly<Record<string, string>>): readonly string[] {
  return Object.keys(labels)
}

/** Collects leaves and lists while walking. Mutable so the walk stays readable. */
interface ShapeBuilder {
  readonly leaves: CaseLeaf[]
  readonly lists: CaseList[]
}

/** Records one text leaf. */
function pushText(into: ShapeBuilder, path: string, value: string): void {
  into.leaves.push({ path, kind: 'text', value })
}

/** Records one scalar leaf. */
function pushScalar(into: ShapeBuilder, path: string, value: string): void {
  into.leaves.push({ path, kind: 'scalar', value })
}

/** Records every text row of a flat block, taking the key set from its label record. */
function pushBlock(into: ShapeBuilder, prefix: string, keys: readonly string[], block: object): void {
  const values = block as Record<string, unknown>
  for (const key of keys) {
    pushText(into, `${prefix}.${key}`, String(values[key] ?? ''))
  }
}

/** Records a repeatable collection's id order. */
function pushList(into: ShapeBuilder, path: string, items: readonly { readonly id: string }[]): void {
  into.lists.push({ path, ids: items.map((item) => item.id) })
}

/**
 * Flattens one clash — its title, its signposted arguments, and its engagements.
 *
 * Split out because the clash script nests three levels deep and the main walk is already the
 * longest function in the file.
 */
function walkClash(into: ShapeBuilder, clash: Clash): void {
  const clashPath = `clashes.${clash.id}`
  pushText(into, `${clashPath}.title`, clash.title)

  pushList(into, `${clashPath}.handledArguments`, clash.handledArguments)
  for (const handled of clash.handledArguments) {
    pushText(into, `${clashPath}.handledArguments.${handled.id}.topic`, handled.topic)
    pushScalar(into, `${clashPath}.handledArguments.${handled.id}.side`, handled.side)
  }

  pushList(into, `${clashPath}.engagements`, clash.engagements)
  for (const engagement of clash.engagements) {
    const engagementPath = `${clashPath}.engagements.${engagement.id}`
    // The kind decides which rows exist, so it has to be in the document rather than inferred:
    // a peer receiving an engagement it cannot type cannot render it.
    pushScalar(into, `${engagementPath}.kind`, engagement.kind)
    pushBlock(into, engagementPath, ENGAGEMENT_TEXT_KEYS[engagement.kind] ?? [], engagement)

    if (engagement.kind === 'overlap') {
      continue
    }
    const response = engagement.response
    pushScalar(into, `${engagementPath}.branch`, response.branch)
    pushScalar(into, `${engagementPath}.isExtension`, String(response.responded.isExtension))
    pushBlock(into, `${engagementPath}.refused`, REFUSED_TEXT_KEYS, response.refused)
    pushBlock(into, `${engagementPath}.responded`, RESPONDED_TEXT_KEYS, response.responded)
  }
}

/**
 * Flattens a case into the leaves and lists the shared document holds.
 *
 * Everything named in {@link CaseIdentity} is skipped — it is not part of the round.
 *
 * @param caseFile - The case to flatten. Blocks that are structurally absent (`policy` after a
 *   "no" to the mechanism question, `extension` outside a BP closing half) contribute a presence
 *   scalar and no rows, because "this table does not exist" is a different statement from
 *   "nobody has filled it in" and the two must survive the round trip separately.
 * @returns Every addressable value, in document order.
 */
export function walkCase(caseFile: Case): CaseShape {
  const into: ShapeBuilder = { leaves: [], lists: [] }

  // The round, not the seat: both benches of one motion are debating the same format and this
  // case is argued from one side. `position` is per-install and is not here.
  pushScalar(into, 'format', caseFile.format)
  pushScalar(into, 'side', caseFile.side)

  pushBlock(into, 'prep', PREP_TEXT_KEYS, caseFile.prep)
  pushScalar(into, 'prep.needsMechanism', caseFile.prep.needsMechanism)
  pushBlock(into, 'prep.fiveW1H', labelKeys(FIVE_W1H_LABELS), caseFile.prep.fiveW1H)
  pushList(into, 'prep.pois', caseFile.prep.pois)
  for (const poi of caseFile.prep.pois) {
    pushBlock(into, `prep.pois.${poi.id}`, POI_TEXT_KEYS, poi)
  }

  pushBlock(into, 'setup', SETUP_TEXT_KEYS, caseFile.setup)
  pushBlock(into, 'setup.caseDivision', labelKeys(CASE_DIVISION_LABELS), caseFile.setup.caseDivision)

  pushBlock(into, 'definition', labelKeys(DEFINITION_LABELS), caseFile.definition)

  pushScalar(into, 'policy', caseFile.policy === null ? 'absent' : 'present')
  if (caseFile.policy !== null) {
    pushBlock(into, 'policy', labelKeys(POLICY_LABELS), caseFile.policy)
  }

  pushBlock(into, 'policyRebuttal', labelKeys(POLICY_REBUTTAL_LABELS), caseFile.policyRebuttal)

  pushList(into, 'substantives', caseFile.substantives)
  for (const substantive of caseFile.substantives) {
    const path = `substantives.${substantive.id}`
    pushBlock(into, path, labelKeys(SUBSTANTIVE_LABELS), substantive)
    pushList(into, `${path}.preempts`, substantive.preempts)
    for (const preempt of substantive.preempts) {
      pushBlock(into, `${path}.preempts.${preempt.id}`, PREEMPT_TEXT_KEYS, preempt)
      pushScalar(into, `${path}.preempts.${preempt.id}.source`, preempt.source)
    }
  }

  pushList(into, 'rebuttals', caseFile.rebuttals)
  for (const rebuttal of caseFile.rebuttals) {
    pushBlock(into, `rebuttals.${rebuttal.id}`, labelKeys(REBUTTAL_LABELS), rebuttal)
  }

  pushList(into, 'opposingRebuttals', caseFile.opposingRebuttals)
  for (const opposing of caseFile.opposingRebuttals) {
    pushBlock(into, `opposingRebuttals.${opposing.id}`, labelKeys(OPPOSING_REBUTTAL_LABELS), opposing)
  }

  pushList(into, 'clashes', caseFile.clashes)
  for (const clash of caseFile.clashes) {
    walkClash(into, clash)
  }

  pushScalar(into, 'extension', caseFile.extension === null ? 'absent' : 'present')
  if (caseFile.extension !== null) {
    pushBlock(into, 'extension', labelKeys(EXTENSION_LABELS), caseFile.extension)
  }

  return into
}

/**
 * Read side of the shared document, so {@link buildCase} never imports Yjs.
 *
 * Every method returns null for an address the document does not hold. That is the ordinary
 * state of a peer running an older build, and it must read as "empty" rather than as a crash.
 */
export interface ShapeSource {
  /** Text at a path, or null when the document has no such row. */
  text: (path: string) => string | null
  /** Scalar at a path, or null. */
  scalar: (path: string) => string | null
  /** Ids of a collection, in order, or null when the collection has never been written. */
  list: (path: string) => readonly string[] | null
}

/** Reads text, defaulting to empty — every field is present-and-empty by the phase 1 rule. */
function readText(source: ShapeSource, path: string): string {
  return source.text(path) ?? ''
}

/** Reads a collection's ids, defaulting to none. */
function readList(source: ShapeSource, path: string): readonly string[] {
  return source.list(path) ?? []
}

/** Rebuilds a flat block by reading each of its keys. */
function readBlock<TBlock extends object>(
  source: ShapeSource,
  prefix: string,
  empty: TBlock,
  keys: readonly string[],
): TBlock {
  // The empty block supplies the keys the document does not carry — an item's id, a nested list —
  // and the loop below overwrites the ones it does.
  const built: Record<string, unknown> = { ...(empty as Record<string, unknown>) }
  for (const key of keys) {
    built[key] = readText(source, `${prefix}.${key}`)
  }
  return built as TBlock
}

/** Rebuilds the "(OR)" fork of one engagement. */
function readResponse(source: ShapeSource, engagementPath: string): EngagementResponse {
  const empty = createEngagementResponse()
  const branch = source.scalar(`${engagementPath}.branch`)
  return {
    branch: branch === 'refused' ? 'refused' : 'responded',
    refused: readBlock(source, `${engagementPath}.refused`, empty.refused, REFUSED_TEXT_KEYS),
    responded: {
      ...readBlock(source, `${engagementPath}.responded`, empty.responded, RESPONDED_TEXT_KEYS),
      isExtension: source.scalar(`${engagementPath}.isExtension`) === 'true',
    },
  }
}

/** Rebuilds one engagement, whose kind decides which rows it has. */
function readEngagement(source: ShapeSource, clashId: string, engagementId: string): ClashEngagement {
  const path = `clashes.${clashId}.engagements.${engagementId}`
  const kind = source.scalar(`${path}.kind`)

  if (kind === 'overlap') {
    const empty = { ...createOverlapEngagement(), id: engagementId }
    return readBlock(source, path, empty, ENGAGEMENT_TEXT_KEYS.overlap)
  }
  if (kind === 'our-argument') {
    const empty = { ...createOurArgumentEngagement(), id: engagementId }
    return {
      ...readBlock(source, path, empty, ENGAGEMENT_TEXT_KEYS['our-argument']),
      response: readResponse(source, path),
    }
  }
  // An unwritten or unrecognised kind lands here rather than throwing. A peer on a build that
  // gained a fourth kind would otherwise take the whole case down over one engagement.
  const empty = { ...createTheirArgumentEngagement(), id: engagementId }
  return {
    ...readBlock(source, path, empty, ENGAGEMENT_TEXT_KEYS['their-argument']),
    response: readResponse(source, path),
  }
}

/** Rebuilds one clash. */
function readClash(source: ShapeSource, clashId: string): Clash {
  const path = `clashes.${clashId}`
  return {
    ...createClash(),
    id: clashId,
    title: readText(source, `${path}.title`),
    handledArguments: readList(source, `${path}.handledArguments`).map((handledId) => ({
      id: handledId,
      side: (source.scalar(`${path}.handledArguments.${handledId}.side`) ?? 'opp') as Side,
      topic: readText(source, `${path}.handledArguments.${handledId}.topic`),
    })),
    engagements: readList(source, `${path}.engagements`).map((engagementId) =>
      readEngagement(source, clashId, engagementId),
    ),
  }
}

/**
 * Projects the shared document back into a plain `Case`.
 *
 * The inverse of {@link walkCase}, and deliberately structured as "build the scaffold from the
 * lists, then read every leaf the scaffold implies" — so the two directions cannot disagree
 * about which paths exist.
 *
 * @param source - The document. Missing addresses read as empty rather than failing: a peer on
 *   an older build is a normal thing to be in a room with.
 * @param identity - The five local facts. Pass this install's own values; taking them off a
 *   peer's document is exactly the bug {@link CaseIdentity} exists to prevent.
 * @returns A complete case, valid for the analyzer, the compiler and the export path.
 */
export function buildCase(source: ShapeSource, identity: CaseIdentity): Case {
  const emptyPrep = createPrepBlock()
  const emptySetup = createSetupBlock()

  const needsMechanism = (source.scalar('prep.needsMechanism') ?? 'undecided') as MechanismDecision

  return {
    id: identity.id,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    position: identity.position,
    visibility: identity.visibility,
    format: (source.scalar('format') ?? 'AP') as FormatId,
    side: (source.scalar('side') ?? 'gov') as Side,

    prep: {
      ...readBlock(source, 'prep', emptyPrep, PREP_TEXT_KEYS),
      needsMechanism,
      fiveW1H: readBlock(source, 'prep.fiveW1H', emptyPrep.fiveW1H, labelKeys(FIVE_W1H_LABELS)),
      pois: readList(source, 'prep.pois').map((poiId) => ({
        ...readBlock(source, `prep.pois.${poiId}`, createPointOfInformation(), POI_TEXT_KEYS),
        id: poiId,
      })),
    },

    setup: {
      ...readBlock(source, 'setup', emptySetup, SETUP_TEXT_KEYS),
      caseDivision: readBlock(
        source,
        'setup.caseDivision',
        emptySetup.caseDivision,
        labelKeys(CASE_DIVISION_LABELS),
      ),
    },

    definition: readBlock(
      source,
      'definition',
      createDefinitionBlock(),
      labelKeys(DEFINITION_LABELS),
    ),

    // Absent by default: a document with no presence scalar has never been seeded, and a POLICY
    // table nobody asked for is a section the editor renders and the meter counts.
    policy:
      source.scalar('policy') === 'present'
        ? readBlock(source, 'policy', createPolicyBlock(), labelKeys(POLICY_LABELS))
        : null,

    policyRebuttal: readBlock(
      source,
      'policyRebuttal',
      createPolicyRebuttalBlock(),
      labelKeys(POLICY_REBUTTAL_LABELS),
    ),

    substantives: readList(source, 'substantives').map((substantiveId) => {
      const path = `substantives.${substantiveId}`
      return {
        ...readBlock(source, path, createSubstantive(), labelKeys(SUBSTANTIVE_LABELS)),
        id: substantiveId,
        preempts: readList(source, `${path}.preempts`).map((preemptId) => ({
          ...readBlock(source, `${path}.preempts.${preemptId}`, createPreempt(), PREEMPT_TEXT_KEYS),
          id: preemptId,
          source: (source.scalar(`${path}.preempts.${preemptId}.source`) ??
            'manual') as Preempt['source'],
        })),
      }
    }),

    rebuttals: readList(source, 'rebuttals').map((rebuttalId) => ({
      ...readBlock(source, `rebuttals.${rebuttalId}`, createRebuttalBlock(), labelKeys(REBUTTAL_LABELS)),
      id: rebuttalId,
    })),

    opposingRebuttals: readList(source, 'opposingRebuttals').map((opposingId) => ({
      ...readBlock(
        source,
        `opposingRebuttals.${opposingId}`,
        createOpposingRebuttalBlock(),
        labelKeys(OPPOSING_REBUTTAL_LABELS),
      ),
      id: opposingId,
    })),

    clashes: readList(source, 'clashes').map((clashId) => readClash(source, clashId)),

    extension:
      source.scalar('extension') === 'present'
        ? readBlock(source, 'extension', createExtensionBlock(), labelKeys(EXTENSION_LABELS))
        : null,
  }
}

/**
 * Pulls the local-only fields off a case.
 *
 * @param caseFile - The case whose identity to keep.
 * @returns The five values {@link buildCase} needs supplying.
 */
export function identityOf(caseFile: Case): CaseIdentity {
  return {
    id: caseFile.id,
    createdAt: caseFile.createdAt,
    updatedAt: caseFile.updatedAt,
    position: caseFile.position,
    visibility: caseFile.visibility,
  }
}
