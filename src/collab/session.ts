/**
 * One co-prep room, with the wire abstracted away.
 *
 * Everything that makes a room work — the join handshake, batching, the presence heartbeat,
 * dropping our own echo — lives here and knows nothing about Supabase or sockets. A transport is
 * four functions ({@link CollabLink}), which is what makes "the LAN fallback is a provider swap"
 * true rather than aspirational: `session.test.ts` runs two real sessions over an in-memory link
 * and proves the protocol without a network, and the two shipped links are then only responsible
 * for moving a string.
 *
 * **Outgoing updates are batched.** Supabase Realtime's client throttle is ten events a second
 * by default and a debater types faster than that; one update per keystroke would be dropped
 * frames during exactly the burst that matters. Yjs merges updates losslessly, so a flush every
 * {@link BATCH_MS} sends one message per peer per tenth of a second however fast anyone types,
 * and the latency is under what a person notices in a text box.
 */

import * as Yjs from 'yjs'

import { REMOTE_ORIGIN } from './doc.ts'
import {
  base64ToBytes,
  bytesToBase64,
  parseMessage,
  type CollabMessage,
  type CollabTransport,
} from './protocol.ts'
import {
  createPresenceTracker,
  HEARTBEAT_MS,
  type CollabPeer,
} from './presence.ts'

/** How long local edits accumulate before one merged update goes out. */
export const BATCH_MS = 120

/** What the room is doing, as the panel reports it. */
export type CollabStatus = 'idle' | 'connecting' | 'connected' | 'error'

/** Callbacks a transport uses to hand work back to the session. */
export interface LinkHandlers {
  /** One frame off the wire. Anything unparseable is dropped by the session, not the link. */
  readonly onMessage: (raw: unknown) => void
  /**
   * Transport state. `error` with a message is how a link reports a refused channel — which for
   * the Realtime link is the ordinary result of trying to join a case the policy will not open.
   */
  readonly onStatus: (status: CollabStatus, detail: string | null) => void
}

/** A wire. Two exist: Supabase Realtime, and the LAN relay in the Rust shell. */
export interface CollabLink {
  readonly transport: CollabTransport
  /**
   * Joins the room.
   *
   * @param handlers - Where to deliver frames and state changes.
   */
  readonly open: (handlers: LinkHandlers) => Promise<void>
  /**
   * Puts one message on the wire.
   *
   * Fire and forget: a room that blocked a keystroke on an acknowledgement would stall prep every
   * time the wifi hiccupped, and the CRDT makes a lost message recoverable by the next sync.
   */
  readonly send: (message: CollabMessage) => void
  readonly close: () => Promise<void>
}

/** Who this install is, as the room sees it. */
export interface CollabIdentity {
  /** `auth.uid()` on Realtime, or the LAN stand-in. Must be stable while the room is open. */
  readonly userId: string
  readonly displayName: string
  /** Role id from the format registry. Ours, not shared — see `CaseIdentity`. */
  readonly seat: string
}

/** Everything a session needs to run. */
export interface CollabSessionOptions {
  readonly doc: Yjs.Doc
  readonly link: CollabLink
  readonly identity: CollabIdentity
  /** Called after a peer's update lands, so the projection can be rebuilt. */
  readonly onDocChanged: () => void
  readonly onPeersChanged: (peers: readonly CollabPeer[]) => void
  readonly onStatusChanged: (status: CollabStatus, detail: string | null) => void
}

/** A running room. */
export interface CollabSession {
  readonly transport: CollabTransport
  readonly start: () => Promise<void>
  /** Leaves the room and stops every timer. Safe to call twice. */
  readonly stop: () => Promise<void>
  /** Announces which row this debater's caret is in. Null when focus left the editor. */
  readonly setFieldPath: (fieldPath: string | null) => void
  /** Announces a seat change, so the panel stops calling them the PM the moment they move. */
  readonly setSeat: (seat: string) => void
  /** Pushes the whole local state at the room. Used when a peer asks, and on reconnect. */
  readonly resync: () => void
}

/**
 * Opens a room over one link.
 *
 * @param options - See {@link CollabSessionOptions}. The `doc` is not owned here — the caller
 *   creates it, seeds it if it is the host, and disposes of it; a session that destroyed the
 *   document on stop would take the case with it when somebody closed the panel.
 * @returns The session, not yet started.
 */
export function createCollabSession(options: CollabSessionOptions): CollabSession {
  const { doc, link, identity } = options
  const tracker = createPresenceTracker()

  // Local updates waiting for the next flush. Merged rather than concatenated, so a burst of
  // twenty keystrokes leaves the room as one message.
  let pending: Uint8Array[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let isRunning = false

  // What the last presence heartbeat said. Kept so a focus change can be announced immediately
  // rather than waiting up to five seconds for the next beat.
  let seat = identity.seat
  let fieldPath: string | null = null

  const announce = (): void => {
    link.send({
      kind: 'presence',
      from: identity.userId,
      displayName: identity.displayName,
      seat,
      fieldPath,
    })
  }

  const flush = (): void => {
    flushTimer = null
    if (pending.length === 0) {
      return
    }
    const merged = Yjs.mergeUpdates(pending)
    pending = []
    link.send({ kind: 'update', from: identity.userId, data: bytesToBase64(merged) })
  }

  const onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    // An update we applied *from* a peer re-fires this listener. Sending it back would be a
    // loop that only terminates because Yjs deduplicates — a loop nonetheless.
    if (origin === REMOTE_ORIGIN || !isRunning) {
      return
    }
    pending.push(update)
    if (flushTimer === null) {
      flushTimer = setTimeout(flush, BATCH_MS)
    }
  }

  const resync = (): void => {
    link.send({
      kind: 'update',
      from: identity.userId,
      data: bytesToBase64(Yjs.encodeStateAsUpdate(doc)),
    })
  }

  /**
   * Handles one parsed message. Our own frames are dropped here rather than at the transport,
   * because only Realtime can filter them for us and the LAN relay cannot.
   */
  const handle = (message: CollabMessage): void => {
    if (message.from === identity.userId) {
      return
    }
    switch (message.kind) {
      case 'update': {
        Yjs.applyUpdate(doc, base64ToBytes(message.data), REMOTE_ORIGIN)
        options.onDocChanged()
        return
      }
      case 'hello': {
        // Everyone answers, and every answer is idempotent, so nobody has to be elected to do
        // it. `encodeStateAsUpdate` against their vector sends only what they are missing.
        const diff = Yjs.encodeStateAsUpdate(doc, base64ToBytes(message.stateVector))
        link.send({ kind: 'update', from: identity.userId, data: bytesToBase64(diff) })
        // And say who we are, so a joiner's panel fills immediately instead of over the next
        // five seconds as each heartbeat happens to come round.
        announce()
        return
      }
      case 'presence': {
        if (
          tracker.seen(
            {
              userId: message.from,
              displayName: message.displayName,
              seat: message.seat,
              fieldPath: message.fieldPath,
            },
            Date.now(),
          )
        ) {
          options.onPeersChanged(tracker.peers())
        }
        return
      }
      case 'leave': {
        if (tracker.left(message.from)) {
          options.onPeersChanged(tracker.peers())
        }
      }
    }
  }

  const onStatus = (status: CollabStatus, detail: string | null): void => {
    options.onStatusChanged(status, detail)
    if (status !== 'connected') {
      return
    }
    // Re-run on every reconnect, not only the first join: a room rejoined after a dropped
    // connection has to catch up on both sides, and the peer list will have gone stale.
    link.send({
      kind: 'hello',
      from: identity.userId,
      stateVector: bytesToBase64(Yjs.encodeStateVector(doc)),
    })
    resync()
    announce()
  }

  return {
    transport: link.transport,

    start: async (): Promise<void> => {
      if (isRunning) {
        return
      }
      isRunning = true
      doc.on('update', onLocalUpdate)
      heartbeatTimer = setInterval(() => {
        announce()
        if (tracker.expire(Date.now())) {
          options.onPeersChanged(tracker.peers())
        }
      }, HEARTBEAT_MS)

      await link.open({
        onMessage: (raw) => {
          const message = parseMessage(raw)
          if (message !== null) {
            handle(message)
          }
        },
        onStatus,
      })
    },

    stop: async (): Promise<void> => {
      if (!isRunning) {
        return
      }
      isRunning = false
      doc.off('update', onLocalUpdate)
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      pending = []
      link.send({ kind: 'leave', from: identity.userId })
      tracker.clear()
      options.onPeersChanged([])
      await link.close()
      options.onStatusChanged('idle', null)
    },

    setFieldPath: (next: string | null): void => {
      if (next === fieldPath) {
        return
      }
      fieldPath = next
      if (isRunning) {
        announce()
      }
    },

    setSeat: (next: string): void => {
      if (next === seat) {
        return
      }
      seat = next
      if (isRunning) {
        announce()
      }
    },

    resync,
  }
}
