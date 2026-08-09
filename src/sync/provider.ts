/**
 * The two wires a co-prep room can run over.
 *
 * Both are thin by design. Everything that decides what a room *does* — the join handshake,
 * batching, presence, dropping our own echo — is in `src/collab/session.ts` and is proved by
 * running two whole sessions over an array. What is left here is moving a string, which is the
 * only part that can differ between a Supabase channel and a socket in the Rust shell.
 *
 * **Realtime channels are private.** Without `private: true` a broadcast channel is reachable by
 * anyone holding the anon key, which ships inside the client — so a case room would be a public
 * feed of a squad's prep, keystroke by keystroke, to anyone who guessed a case id. With it, every
 * join is checked against the policy in migration 6, which resolves to the same predicate
 * `cases_select` uses. That is the phase 9 standard applied to a channel instead of a table.
 */

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { CollabLink, LinkHandlers } from '../collab/session.ts'
import type { CollabMessage } from '../collab/protocol.ts'

/** Broadcast event every room message rides on. One event, four message kinds inside it. */
const BROADCAST_EVENT = 'y'

/** Tauri event the Rust relay delivers frames on. Must match `lan.rs`. */
const LAN_EVENT = 'collab://lan'

/** Tauri event the Rust reader uses to report the wire going down under it. */
const LAN_STATUS_EVENT = 'collab://lan-status'

/**
 * Opens a room over Supabase Realtime.
 *
 * @param client - A signed-in client. The channel is private, so the socket must be carrying this
 *   identity's token before it subscribes — which is what the `setAuth` call below is for.
 * @param topic - From `roomTopic`. A topic that is not `case:<uuid>` is refused by the policy
 *   rather than joined, and comes back as a channel error.
 * @returns The link, not yet open.
 */
export function createRealtimeLink(client: SupabaseClient, topic: string): CollabLink {
  let channel: RealtimeChannel | null = null

  return {
    transport: 'realtime',

    open: async (handlers: LinkHandlers): Promise<void> => {
      handlers.onStatus('connecting', null)
      // A private channel is authorised from the token on the *socket*, not from the one the
      // REST calls use. Without this the join is refused as an anonymous one even though every
      // query on the same client works.
      await client.realtime.setAuth()

      channel = client.channel(topic, {
        config: {
          private: true,
          // Our own frames come back to us otherwise, and the session would then have to filter
          // by sender for a case that need never arise on this transport.
          broadcast: { self: false },
        },
      })

      channel.on('broadcast', { event: BROADCAST_EVENT }, (frame) => {
        handlers.onMessage((frame as { payload?: unknown }).payload)
      })

      channel.subscribe((status, error) => {
        switch (status) {
          case 'SUBSCRIBED':
            handlers.onStatus('connected', null)
            return
          case 'CHANNEL_ERROR':
            // The server's own words for this are "Unauthorized: You do not have permissions to
            // read from this Channel topic: case:<uuid>", which is accurate and tells a debater
            // nothing they can act on. The ordinary cause is the policy refusing the room — a
            // case that is not shared, or one this identity cannot read — and the fix is the
            // visibility switch two panels up. So the sentence that names the fix comes first
            // and the server's message follows it, because the *other* cause is a project that
            // has never had migration 6 applied and that is only diagnosable from the raw text.
            handlers.onStatus(
              'error',
              `That room would not open. The case has to be shared with a team you are in.${
                error?.message === undefined ? '' : ` (${error.message})`
              }`,
            )
            return
          case 'TIMED_OUT':
            handlers.onStatus('error', 'the room did not answer in time')
            return
          case 'CLOSED':
            handlers.onStatus('idle', null)
        }
      })
    },

    send: (message: CollabMessage): void => {
      // Fire and forget. `send` returns a promise that resolves on the socket write, and
      // awaiting it on a keystroke would put the editor behind the network.
      void channel?.send({ type: 'broadcast', event: BROADCAST_EVENT, payload: message })
    },

    close: async (): Promise<void> => {
      if (channel) {
        await client.removeChannel(channel)
        channel = null
      }
    },
  }
}

/** Where a LAN room is: this install's own relay, or somebody else's. */
export interface LanRoom {
  /** True when this install runs the relay. It still joins over loopback like everyone else. */
  readonly isHosting: boolean
  /** `host:port`. For a host, its own loopback address. */
  readonly address: string
}

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
export async function findOrHostLanRoom(roomId: string): Promise<LanRoom> {
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
 * Opens a room over the LAN relay in the Rust shell.
 *
 * @param address - `host:port`, from {@link findOrHostLanRoom} or typed in by somebody whose
 *   network blocks broadcast.
 * @returns The link, not yet open.
 */
export function createLanLink(address: string): CollabLink {
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
