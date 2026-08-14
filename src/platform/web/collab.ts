/**
 * Co-prep in a browser: Supabase Realtime, and nothing else.
 *
 * The Realtime half is not here — it is `createRealtimeLink` in `sync/provider.ts`, pure
 * supabase-js, and both shells run the same code. What this file says is that the *other* half
 * does not exist.
 *
 * The LAN fallback is a UDP discovery broadcast and a TCP relay in the Rust shell. A browser can
 * bind neither, and there is no substitute: WebRTC needs signalling that already exists, which is
 * exactly what a room with no internet does not have. So `hasLanTransport` is false and the panel
 * offers one transport rather than two, one of which would always fail.
 *
 * A room here therefore needs the internet — and migration 6, which is what makes a private
 * channel joinable at all.
 */

import type { CollabLink } from '../../collab/session.ts'
import type { CollabPlatform, LanRoom } from '../types.ts'

/** What both LAN entry points say when something calls them anyway. */
const NO_RELAY = 'There is no local-network room in a browser. Co-prep here goes over the internet.'

/**
 * Finds or starts a LAN room.
 *
 * @param roomId - Ignored.
 * @returns Never. Guarded by `hasLanTransport`, so reaching this is a bug rather than a
 *   configuration — the message says what is true rather than what to try instead.
 */
function findOrHostLanRoom(roomId: string): Promise<LanRoom> {
  void roomId
  return Promise.reject(new Error(NO_RELAY))
}

/**
 * Opens a room over the relay.
 *
 * @param address - Ignored.
 * @returns Never; throws for the same reason as {@link findOrHostLanRoom}.
 */
function createLanLink(address: string): CollabLink {
  void address
  throw new Error(NO_RELAY)
}

/** Realtime only. */
export const collab: CollabPlatform = {
  hasLanTransport: false,
  findOrHostLanRoom,
  createLanLink,
}
