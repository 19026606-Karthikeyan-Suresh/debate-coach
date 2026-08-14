/**
 * The two wires a co-prep room can run over.
 *
 * Realtime is here in full because it is pure supabase-js and both shells run the same code. The
 * LAN half is re-exported from `@platform`, because a browser has no sockets to bind — and
 * `hasLanTransport` is what the panel reads rather than offering an option that always fails.
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
import { collab } from '@platform'

import type { CollabLink, LinkHandlers } from '../collab/session.ts'
import type { CollabMessage } from '../collab/protocol.ts'

export type { LanRoom } from '../platform/types.ts'

/**
 * The LAN half, from whichever shell is underneath.
 *
 * `hasLanTransport` is false in a browser, which has no sockets to bind — so a web build offers
 * Realtime alone rather than a second option that always fails.
 */
export const { hasLanTransport, findOrHostLanRoom, createLanLink } = collab

/** Broadcast event every room message rides on. One event, four message kinds inside it. */
const BROADCAST_EVENT = 'y'

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

