/**
 * The LAN relay in the Rust shell.
 *
 * Thin by design. Everything that decides what a room *does* — the join handshake, batching,
 * presence, dropping our own echo — is in `src/collab/session.ts` and is proved by running two
 * whole sessions over an array. What is left here is moving a string.
 *
 * The fallback is not `y-webrtc`, and `lan.rs` says why at length: WebRTC needs signalling that
 * already exists, and `y-webrtc` gets it from public servers on the internet, which is exactly
 * what a room with no internet does not have.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { CollabMessage } from '../../collab/protocol.ts'
import type { CollabLink, LinkHandlers } from '../../collab/session.ts'
import type { CollabPlatform, LanRoom } from '../types.ts'

/** Tauri event the Rust relay delivers frames on. Must match `lan.rs`. */
const LAN_EVENT = 'collab://lan'

/** Tauri event the Rust reader uses to report the wire going down under it. */
const LAN_STATUS_EVENT = 'collab://lan-status'

/**
 * Finds or starts a LAN room for a case.
 *
 * Tries discovery first, so the second person into a prep room joins the first rather than
 * starting a second room nobody is in. Only when nobody answers does this install host.
 *
 * @param roomId - The host's case id, used as the discovery key.
 * @returns Where the room is.
 * @throws If no port can be bound and nobody is hosting — which on Windows most often means the
 *   firewall prompt was declined.
 */
async function findOrHostLanRoom(roomId: string): Promise<LanRoom> {
  const found = await invoke<string | null>('lan_discover', { roomId })
  if (found !== null) {
    return { isHosting: false, address: found }
  }
  const port = await invoke<number>('lan_host', { roomId })
  // The host connects to its own relay rather than short-circuiting it. One send path and one
  // receive path for everybody is worth a loopback socket.
  return { isHosting: true, address: `127.0.0.1:${port}` }
}

/**
 * Opens a room over the LAN relay.
 *
 * @param address - `host:port`, from {@link findOrHostLanRoom} or typed in by somebody whose
 *   network blocks broadcast.
 * @returns The link, not yet open.
 */
function createLanLink(address: string): CollabLink {
  let unlistenFrames: UnlistenFn | null = null
  let unlistenStatus: UnlistenFn | null = null

  return {
    transport: 'lan',

    open: async (handlers: LinkHandlers): Promise<void> => {
      handlers.onStatus('connecting', null)
      // Listeners are attached before the connect, so a frame arriving on a fast loopback
      // handshake is not delivered into a room that is not listening yet.
      unlistenFrames = await listen<string>(LAN_EVENT, (event) => {
        handlers.onMessage(event.payload)
      })
      unlistenStatus = await listen<boolean>(LAN_STATUS_EVENT, (event) => {
        if (!event.payload) {
          handlers.onStatus('error', 'the connection to the room dropped')
        }
      })

      try {
        await invoke('lan_connect', { address })
      } catch (error) {
        handlers.onStatus('error', error instanceof Error ? error.message : String(error))
        return
      }
      handlers.onStatus('connected', null)
    },

    send: (message: CollabMessage): void => {
      // Same fire-and-forget rule as Realtime. A failed write means the room is gone, and the
      // reader thread reports that on its own channel.
      void invoke('lan_send', { message: JSON.stringify(message) }).catch(() => {})
    },

    close: async (): Promise<void> => {
      unlistenFrames?.()
      unlistenStatus?.()
      unlistenFrames = null
      unlistenStatus = null
      // Leaves, and stops the relay if this install was hosting it.
      await invoke('lan_leave').catch(() => {})
    },
  }
}

/** A relay in the shell, so a room works with no internet in the building. */
export const collab: CollabPlatform = {
  hasLanTransport: true,
  findOrHostLanRoom,
  createLanLink,
}
