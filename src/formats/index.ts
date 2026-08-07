/**
 * Format registry — Asian Parliamentary and British Parliamentary presets.
 *
 * Timings drive the speech timer and the POI shading; `blocks` drives which parts of
 * the case template a given speaker is asked to fill. Everything downstream reads
 * format data from here rather than hardcoding "7 minutes" or "whip".
 */

/**
 * A section of the case template, matching the headings in `reference/template-blank.docx`.
 *
 * `prep` and `setup` are shared by the whole team; the rest map to one docx block each.
 */
export type BlockId =
  | 'prep'
  | 'setup'
  | 'definition'
  | 'policy'
  | 'substantives'
  | 'policyRebuttal'
  | 'rebuttals'
  | 'opposingRebuttals'
  | 'clashes'
  | 'extension'

/** Which bench a speaker sits on. Drives whose arguments a rebuttal block refers to. */
export type Side = 'gov' | 'opp'

/**
 * One speaking position in a format.
 */
export interface SpeakerRole {
  /** Stable key stored on the case row. Never renamed — old cases resolve their role by this. */
  readonly id: string
  /** Display name as debaters say it out loud, e.g. "Deputy Prime Minister". */
  readonly label: string
  /** Short form used in tight UI, e.g. "DPM". */
  readonly shortLabel: string
  readonly side: Side
  /**
   * Team key. AP has one team per side; BP has two, so this separates OG from CG.
   * Empty string is not valid — every role belongs to a team.
   */
  readonly team: string
  /** Template blocks this speaker is expected to fill. Drives the completeness meter. */
  readonly blocks: readonly BlockId[]
  /** True where the format lets this speaker deliver the reply. Always false when `replySeconds` is null. */
  readonly canGiveReply: boolean
}

/**
 * A debate format preset.
 */
export interface Format {
  readonly id: FormatId
  readonly label: string
  /** Substantive speech length. Both supported formats use 7 minutes. */
  readonly speechSeconds: number
  /** Reply speech length, or null where the format has no reply (BP). */
  readonly replySeconds: number | null
  /**
   * Absolute window during which POIs may be offered, as `[earliest, latest]` seconds
   * from the start of the speech. Time outside it is protected. Stored absolute rather
   * than as protected durations because the timer shades this range directly.
   */
  readonly poiWindowSeconds: readonly [number, number]
  /** Prep time before the round. BP gives 15 minutes; AP typically 30. */
  readonly prepSeconds: number
  readonly roles: readonly SpeakerRole[]
}

/** Format keys. Persisted on the case row, so treat as a stable enum. */
export type FormatId = 'AP' | 'BP'

// Both formats run 7-minute substantives with POIs open from 1:00 to 6:00 — the first
// and last minute are protected. Shared so the two presets cannot drift apart.
const SPEECH_SECONDS = 7 * 60
const POI_WINDOW_SECONDS = [60, 360] as const

// Every first speaker defines and, if proposing, lays out the policy.
const FIRST_SPEAKER_BLOCKS: readonly BlockId[] = [
  'prep',
  'setup',
  'definition',
  'policy',
  'substantives',
  'policyRebuttal',
]

// Second speakers rebut and carry the last substantive.
const SECOND_SPEAKER_BLOCKS: readonly BlockId[] = ['prep', 'setup', 'rebuttals', 'substantives']

// Whips do not bring new material; they run the opposing-team rebuttals and the clash script.
const WHIP_BLOCKS: readonly BlockId[] = ['prep', 'setup', 'opposingRebuttals', 'clashes']

/**
 * Asian Parliamentary: three speakers a side plus a reply.
 *
 * The reply is delivered by the first or second speaker — never the whip — which is why
 * `canGiveReply` is false on the whip roles.
 */
export const AP_FORMAT: Format = {
  id: 'AP',
  label: 'Asian Parliamentary',
  speechSeconds: SPEECH_SECONDS,
  replySeconds: 4 * 60,
  poiWindowSeconds: POI_WINDOW_SECONDS,
  prepSeconds: 30 * 60,
  roles: [
    {
      id: 'ap-pm',
      label: 'Prime Minister',
      shortLabel: 'PM',
      side: 'gov',
      team: 'gov',
      blocks: FIRST_SPEAKER_BLOCKS,
      canGiveReply: true,
    },
    {
      id: 'ap-dpm',
      label: 'Deputy Prime Minister',
      shortLabel: 'DPM',
      side: 'gov',
      team: 'gov',
      blocks: SECOND_SPEAKER_BLOCKS,
      canGiveReply: true,
    },
    {
      id: 'ap-gov-whip',
      label: 'Government Whip',
      shortLabel: 'Gov Whip',
      side: 'gov',
      team: 'gov',
      blocks: WHIP_BLOCKS,
      canGiveReply: false,
    },
    {
      id: 'ap-lo',
      label: 'Leader of Opposition',
      shortLabel: 'LO',
      side: 'opp',
      team: 'opp',
      blocks: FIRST_SPEAKER_BLOCKS,
      canGiveReply: true,
    },
    {
      id: 'ap-dlo',
      label: 'Deputy Leader of Opposition',
      shortLabel: 'DLO',
      side: 'opp',
      team: 'opp',
      blocks: SECOND_SPEAKER_BLOCKS,
      canGiveReply: true,
    },
    {
      id: 'ap-opp-whip',
      label: 'Opposition Whip',
      shortLabel: 'Opp Whip',
      side: 'opp',
      team: 'opp',
      blocks: WHIP_BLOCKS,
      canGiveReply: false,
    },
  ],
}

// Closing-half speakers must add material the opening half did not run. The template's
// Speaker 3 script already says "this is my extension because ___", so the extension
// block is the same clash builder with one extra required field.
const CLOSING_MEMBER_BLOCKS: readonly BlockId[] = [
  'prep',
  'setup',
  'rebuttals',
  'substantives',
  'extension',
]
const CLOSING_WHIP_BLOCKS: readonly BlockId[] = [
  'prep',
  'setup',
  'opposingRebuttals',
  'clashes',
  'extension',
]

/**
 * British Parliamentary: four teams of two, no reply speech.
 *
 * Closing-half roles (CG, CO) carry `extension` in their blocks; opening-half roles do not.
 */
export const BP_FORMAT: Format = {
  id: 'BP',
  label: 'British Parliamentary',
  speechSeconds: SPEECH_SECONDS,
  replySeconds: null,
  poiWindowSeconds: POI_WINDOW_SECONDS,
  prepSeconds: 15 * 60,
  roles: [
    {
      id: 'bp-pm',
      label: 'Prime Minister',
      shortLabel: 'PM',
      side: 'gov',
      team: 'og',
      blocks: FIRST_SPEAKER_BLOCKS,
      canGiveReply: false,
    },
    {
      id: 'bp-dpm',
      label: 'Deputy Prime Minister',
      shortLabel: 'DPM',
      side: 'gov',
      team: 'og',
      blocks: SECOND_SPEAKER_BLOCKS,
      canGiveReply: false,
    },
    {
      id: 'bp-lo',
      label: 'Leader of Opposition',
      shortLabel: 'LO',
      side: 'opp',
      team: 'oo',
      blocks: FIRST_SPEAKER_BLOCKS,
      canGiveReply: false,
    },
    {
      id: 'bp-dlo',
      label: 'Deputy Leader of Opposition',
      shortLabel: 'DLO',
      side: 'opp',
      team: 'oo',
      blocks: SECOND_SPEAKER_BLOCKS,
      canGiveReply: false,
    },
    {
      id: 'bp-mg',
      label: 'Member for Government',
      shortLabel: 'MG',
      side: 'gov',
      team: 'cg',
      blocks: CLOSING_MEMBER_BLOCKS,
      canGiveReply: false,
    },
    {
      id: 'bp-gw',
      label: 'Government Whip',
      shortLabel: 'GW',
      side: 'gov',
      team: 'cg',
      blocks: CLOSING_WHIP_BLOCKS,
      canGiveReply: false,
    },
    {
      id: 'bp-mo',
      label: 'Member for Opposition',
      shortLabel: 'MO',
      side: 'opp',
      team: 'co',
      blocks: CLOSING_MEMBER_BLOCKS,
      canGiveReply: false,
    },
    {
      id: 'bp-ow',
      label: 'Opposition Whip',
      shortLabel: 'OW',
      side: 'opp',
      team: 'co',
      blocks: CLOSING_WHIP_BLOCKS,
      canGiveReply: false,
    },
  ],
}

/** Every supported format, keyed by id. */
export const FORMATS: Readonly<Record<FormatId, Format>> = {
  AP: AP_FORMAT,
  BP: BP_FORMAT,
}

/**
 * Looks up a format preset.
 *
 * @param formatId - Format key from the case row. An unknown key throws rather than
 *   defaulting to AP, because silently coaching someone in the wrong format is worse
 *   than a crash on a corrupt row.
 * @returns The matching preset.
 * @throws If `formatId` is not a registered format.
 */
export function getFormat(formatId: FormatId): Format {
  const format = FORMATS[formatId]
  if (!format) {
    throw new Error(`Unknown format: ${formatId}`)
  }
  return format
}

/**
 * Looks up one speaking position within a format.
 *
 * @param formatId - Format key; an unknown key throws via `getFormat`.
 * @param roleId - Role key as stored on the case. A role belonging to a different format
 *   returns undefined rather than throwing, so the UI can prompt for reassignment when a
 *   case is switched from AP to BP.
 * @returns The role, or undefined if this format has no such role.
 */
export function getRole(formatId: FormatId, roleId: string): SpeakerRole | undefined {
  return getFormat(formatId).roles.find((role) => role.id === roleId)
}

/**
 * Whether a point of information may be offered at a given moment.
 *
 * @param format - Format supplying the POI window.
 * @param elapsedSeconds - Seconds since the speech started. Values past the speech length
 *   return false; there is no POI window in overtime.
 * @returns True only strictly inside the window — the knock at exactly 1:00 opens it.
 */
export function isPoiAllowed(format: Format, elapsedSeconds: number): boolean {
  const [earliest, latest] = format.poiWindowSeconds
  return elapsedSeconds >= earliest && elapsedSeconds <= latest
}

/**
 * Whether a speaker must produce an extension.
 *
 * @param role - Role to test. Opening-half and AP roles are always false.
 * @returns True for BP closing-half roles.
 */
export function requiresExtension(role: SpeakerRole): boolean {
  return role.blocks.includes('extension')
}
