/**
 * Who else is in the room, and which row they are in.
 *
 * Presence is a heartbeat rather than a connection state, and it is tracked here rather than by
 * the transport. Supabase Realtime has a presence feature that would do half of this for free —
 * but only half, because the LAN fallback has no Supabase in it, and a room where the list of
 * people works differently depending on the wire is a room with two bugs to find. One
 * implementation over one message type serves both, and it is pure, so it can be tested at the
 * second rather than at the minute.
 *
 * The heartbeat also carries something a socket-level presence never could: the field path the
 * peer's caret is in. That is what makes the panel useful during prep — not "Sam is online" but
 * "Sam is writing Sub 2's mechanism", which is how a squad avoids two people on one row.
 */

/** One other person in the room. */
export interface CollabPeer {
  /** Their `auth.uid()`, or its LAN stand-in. Stable for as long as their install is. */
  readonly userId: string
  /** As they set it in the team panel. Empty when they never did. */
  readonly displayName: string
  /** Role id from the format registry — their seat, which is theirs and not shared. */
  readonly seat: string
  /** Field path their caret is in, or null. */
  readonly fieldPath: string | null
  /** When their last heartbeat arrived, in `Date.now()` milliseconds. */
  readonly lastSeen: number
}

/**
 * How often to announce ourselves.
 *
 * Well under {@link PEER_TIMEOUT_MS} so one dropped frame does not make somebody vanish from the
 * panel while they are sitting there typing.
 */
export const HEARTBEAT_MS = 5_000

/** Silence after which a peer is treated as gone. Three missed heartbeats. */
export const PEER_TIMEOUT_MS = 16_000

/** Tracks the room's roster from heartbeats. */
export interface PresenceTracker {
  /** Records a heartbeat. Returns true when the visible roster changed. */
  readonly seen: (peer: Omit<CollabPeer, 'lastSeen'>, now: number) => boolean
  /** Records an explicit departure. Returns true when somebody was actually removed. */
  readonly left: (userId: string) => boolean
  /** Drops peers whose heartbeat has lapsed. Returns true when anyone was dropped. */
  readonly expire: (now: number) => boolean
  /** The roster, by display name then id so the panel does not reorder itself. */
  readonly peers: () => readonly CollabPeer[]
  /** Forgets everybody — on disconnect, so a rejoin does not show a stale room. */
  readonly clear: () => void
}

/** True when two roster entries differ in anything the panel draws. */
function isVisiblyDifferent(before: CollabPeer | undefined, after: Omit<CollabPeer, 'lastSeen'>): boolean {
  return (
    before === undefined ||
    before.displayName !== after.displayName ||
    before.seat !== after.seat ||
    before.fieldPath !== after.fieldPath
  )
}

/**
 * Builds an empty tracker.
 *
 * @returns The tracker. Every mutator returns whether the *visible* roster changed, so a
 *   heartbeat that says nothing new does not re-render the editor every five seconds.
 */
export function createPresenceTracker(): PresenceTracker {
  const roster = new Map<string, CollabPeer>()

  return {
    seen: (peer, now) => {
      const changed = isVisiblyDifferent(roster.get(peer.userId), peer)
      roster.set(peer.userId, { ...peer, lastSeen: now })
      return changed
    },

    left: (userId) => roster.delete(userId),

    expire: (now) => {
      let dropped = false
      for (const [userId, peer] of roster) {
        if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
          roster.delete(userId)
          dropped = true
        }
      }
      return dropped
    },

    peers: () =>
      [...roster.values()].sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) || left.userId.localeCompare(right.userId),
      ),

    clear: () => {
      roster.clear()
    },
  }
}

/**
 * Groups the roster by the field each peer is in.
 *
 * @param peers - The roster.
 * @returns Field path to the peers in it. A path with two names in it is the thing the panel
 *   exists to show: two people are about to overwrite each other's sentence.
 */
export function peersByField(peers: readonly CollabPeer[]): ReadonlyMap<string, readonly CollabPeer[]> {
  const grouped = new Map<string, CollabPeer[]>()
  for (const peer of peers) {
    if (peer.fieldPath === null) {
      continue
    }
    const existing = grouped.get(peer.fieldPath)
    if (existing) {
      existing.push(peer)
    } else {
      grouped.set(peer.fieldPath, [peer])
    }
  }
  return grouped
}
