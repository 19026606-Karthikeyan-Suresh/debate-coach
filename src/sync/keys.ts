/**
 * Setting keys, kept apart from the code that reads them.
 *
 * Split out when the platform seam landed. `sync/store.ts` is now a facade over
 * `platform.database`, and the desktop implementation writes `libraryPulledAt` itself when it
 * caches a listing — so a key that lived in `store.ts` would make the implementation import its
 * own facade and close a runtime cycle. Constants only, imported by both ends.
 */

/** Setting keys. Strings rather than an enum so a stored value survives a rename here. */
export const SETTING_KEYS = {
  /** `auth.uid()` this install signed in as. */
  userId: 'sync.user_id',
  /** Team whose library is shown and whose id is stamped on pushed rows. */
  activeTeamId: 'sync.active_team_id',
  /** Display name sent with `join_team`. */
  displayName: 'sync.display_name',
  /** ISO 8601 of the last successful library pull. */
  libraryPulledAt: 'sync.library_pulled_at',
} as const

/**
 * Prefix for "this local case is a copy of that room's case".
 *
 * A settings key rather than a column, because it is a fact about *this install's* copy and not
 * about the case document — the same reasoning that keeps `position` and `visibility` out of the
 * shared document. The host needs no entry: the room's id is its own case id.
 */
export const ROOM_LINK_PREFIX = 'coprep.room.'

/**
 * Prefix for a per-format prep-length override, in whole minutes.
 *
 * Per format rather than per case, and a setting rather than a column on the case, because the
 * length belongs to the round the debater is sitting in and not to the document they are writing.
 * A tournament running short prep runs it short for every case that day; putting it in the case
 * would mean setting it again on the next one — and would put it in the co-prep CRDT and the
 * `.dbcase` export, neither of which is anything to do with a clock on this laptop.
 */
export const PREP_MINUTES_PREFIX = 'prep.minutes.'
