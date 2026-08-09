/**
 * The room protocol, run for real over a wire that happens to be an array.
 *
 * Two whole sessions, the same code the Realtime and LAN links drive, exchanging actual frames:
 * the join handshake, the batching, the heartbeat and the echo suppression are all under test
 * here, so the two shipped transports are left responsible only for moving a string.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Yjs from 'yjs'

import { setFieldByPath } from '../../case/update.ts'
import { createEmptyCase } from '../../types/createCase.ts'
import { applyCaseToDoc, caseFromDoc, seedDoc } from '../doc.ts'
import { identityOf } from '../shape.ts'
import { HEARTBEAT_MS, PEER_TIMEOUT_MS, type CollabPeer } from '../presence.ts'
import { createCollabSession, BATCH_MS, type CollabLink, type LinkHandlers } from '../session.ts'
import type { CollabMessage } from '../protocol.ts'

/** An in-memory room every link in a test attaches to. */
interface Hub {
  /** Every frame anybody put on the wire, in order. */
  readonly frames: CollabMessage[]
  /** Builds a link for one identity. */
  readonly link: (userId: string) => CollabLink
  /** Stops delivery without closing anything — a dropped connection. */
  readonly drop: () => void
  /** Restores delivery and tells everyone they are connected again. */
  readonly restore: () => void
  /** Detaches one peer without a goodbye — a closed laptop rather than a closed tab. */
  readonly silence: (userId: string) => void
  /** Puts a raw frame on the wire, bypassing the message builders. */
  readonly inject: (raw: unknown) => void
}

/** Wires an in-memory hub that broadcasts to every attached link but the sender. */
function createHub(): Hub {
  const attached = new Map<string, LinkHandlers>()
  const frames: CollabMessage[] = []
  // Peers whose wire has gone in both directions, without either end noticing.
  const silenced = new Set<string>()
  let isUp = true

  return {
    frames,
    drop: () => {
      isUp = false
    },
    restore: () => {
      isUp = true
      for (const handlers of attached.values()) {
        handlers.onStatus('connected', null)
      }
    },
    silence: (userId: string) => {
      silenced.add(userId)
    },
    inject: (raw: unknown) => {
      for (const handlers of attached.values()) {
        handlers.onMessage(raw)
      }
    },
    link: (userId: string): CollabLink => ({
      transport: 'realtime',
      open: async (handlers) => {
        attached.set(userId, handlers)
        handlers.onStatus('connected', null)
      },
      send: (message) => {
        frames.push(message)
        if (!isUp || silenced.has(userId)) {
          return
        }
        for (const [peerId, handlers] of attached) {
          if (peerId !== userId && !silenced.has(peerId)) {
            // Through JSON, so the tests exercise the parser the real transports feed.
            handlers.onMessage(JSON.stringify(message))
          }
        }
      },
      close: async () => {
        attached.delete(userId)
      },
    }),
  }
}

/** One participant: a document, a session, and whatever the callbacks last reported. */
interface Participant {
  readonly doc: Yjs.Doc
  readonly session: ReturnType<typeof createCollabSession>
  peers: readonly CollabPeer[]
  docChanges: number
}

/** Attaches a started session to the hub. */
async function join(
  hub: Hub,
  userId: string,
  displayName: string,
  seat: string,
): Promise<Participant> {
  const doc = new Yjs.Doc()
  const state: Participant = {
    doc,
    peers: [],
    docChanges: 0,
    session: createCollabSession({
      doc,
      link: hub.link(userId),
      identity: { userId, displayName, seat },
      onDocChanged: () => {
        state.docChanges += 1
      },
      onPeersChanged: (peers) => {
        state.peers = peers
      },
      onStatusChanged: () => {},
    }),
  }
  await state.session.start()
  return state
}

describe('a co-prep room', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands a joiner the whole case without anyone electing a host', async () => {
    const hub = createHub()
    const seed = createEmptyCase('AP', 'gov', 'pm')

    const host = await join(hub, 'user-host', 'Priya', 'pm')
    seedDoc(host.doc, seed)
    vi.advanceTimersByTime(BATCH_MS)

    const guest = await join(hub, 'user-guest', 'Sam', 'dpm')
    // The joiner's hello is answered by everyone present; one answer is enough and the rest are
    // no-ops, which is why nobody has to be chosen to give it.
    const joined = caseFromDoc(guest.doc, identityOf(seed))
    expect(joined.substantives).toHaveLength(seed.substantives.length)
    expect(joined.clashes).toHaveLength(seed.clashes.length)

    await host.session.stop()
    await guest.session.stop()
  })

  it('carries an edit both ways', async () => {
    const hub = createHub()
    const seed = createEmptyCase('AP', 'gov', 'pm')
    const host = await join(hub, 'user-host', 'Priya', 'pm')
    seedDoc(host.doc, seed)
    vi.advanceTimersByTime(BATCH_MS)
    const guest = await join(hub, 'user-guest', 'Sam', 'dpm')

    const hostCase = caseFromDoc(host.doc, identityOf(seed))
    applyCaseToDoc(host.doc, hostCase, setFieldByPath(hostCase, 'prep.motion', 'THW ban homework'))
    vi.advanceTimersByTime(BATCH_MS)
    expect(caseFromDoc(guest.doc, identityOf(seed)).prep.motion).toBe('THW ban homework')

    const guestCase = caseFromDoc(guest.doc, identityOf(seed))
    applyCaseToDoc(
      guest.doc,
      guestCase,
      setFieldByPath(guestCase, 'setup.burdens', 'Prove the harm is systemic.'),
    )
    vi.advanceTimersByTime(BATCH_MS)
    expect(caseFromDoc(host.doc, identityOf(seed)).setup.burdens).toBe('Prove the harm is systemic.')

    await host.session.stop()
    await guest.session.stop()
  })

  it('sends one message for a burst of typing, not one per keystroke', async () => {
    const hub = createHub()
    const seed = createEmptyCase('AP', 'gov', 'pm')
    const host = await join(hub, 'user-host', 'Priya', 'pm')
    seedDoc(host.doc, seed)
    vi.advanceTimersByTime(BATCH_MS)

    const before = hub.frames.filter((frame) => frame.kind === 'update').length
    let current = caseFromDoc(host.doc, identityOf(seed))
    const typed = 'social media platforms'
    for (let length = 1; length <= typed.length; length += 1) {
      const next = setFieldByPath(current, 'prep.motion', typed.slice(0, length))
      applyCaseToDoc(host.doc, current, next)
      current = next
    }
    vi.advanceTimersByTime(BATCH_MS)

    const sent = hub.frames.filter((frame) => frame.kind === 'update').length - before
    // Twenty-two keystrokes. Realtime's default client throttle is ten events a second, so one
    // message per keystroke is dropped frames during the burst that matters most.
    expect(typed.length).toBeGreaterThan(20)
    expect(sent).toBe(1)

    await host.session.stop()
  })

  it('shows who is in the room and which row they are in', async () => {
    const hub = createHub()
    const host = await join(hub, 'user-host', 'Priya', 'pm')
    const guest = await join(hub, 'user-guest', 'Sam', 'dpm')

    expect(host.peers.map((peer) => peer.displayName)).toEqual(['Sam'])
    expect(guest.peers.map((peer) => peer.displayName)).toEqual(['Priya'])
    expect(host.peers[0]?.seat).toBe('dpm')

    guest.session.setFieldPath('substantives.sub-2.whyExists')
    expect(host.peers[0]?.fieldPath).toBe('substantives.sub-2.whyExists')

    // A seat change reaches the panel at once rather than at the next heartbeat: a debater
    // reassigned mid-prep is exactly when the roster needs to be right.
    guest.session.setSeat('whip')
    expect(host.peers[0]?.seat).toBe('whip')

    await host.session.stop()
    await guest.session.stop()
  })

  it('removes a peer that leaves at once, and one that goes quiet on a timeout', async () => {
    const hub = createHub()
    const host = await join(hub, 'user-host', 'Priya', 'pm')
    const guest = await join(hub, 'user-guest', 'Sam', 'dpm')
    expect(host.peers).toHaveLength(1)

    await guest.session.stop()
    expect(host.peers).toHaveLength(0)

    // The backstop, for the laptop that was closed rather than the tab: no goodbye is sent, so
    // the only evidence is the heartbeat stopping.
    const silent = await join(hub, 'user-silent', 'Ada', 'whip')
    expect(host.peers).toHaveLength(1)
    hub.silence('user-silent')
    vi.advanceTimersByTime(PEER_TIMEOUT_MS + HEARTBEAT_MS)
    expect(host.peers).toHaveLength(0)

    await silent.session.stop()
    await host.session.stop()
  })

  it('never applies its own update twice', async () => {
    const hub = createHub()
    const seed = createEmptyCase('AP', 'gov', 'pm')
    const host = await join(hub, 'user-host', 'Priya', 'pm')
    seedDoc(host.doc, seed)
    vi.advanceTimersByTime(BATCH_MS)

    const changesBefore = host.docChanges
    const current = caseFromDoc(host.doc, identityOf(seed))
    applyCaseToDoc(host.doc, current, setFieldByPath(current, 'prep.motion', 'THW abolish exams'))
    vi.advanceTimersByTime(BATCH_MS * 4)

    // Nothing came back from a peer, so nothing should have been reported as a remote change.
    expect(host.docChanges).toBe(changesBefore)
    expect(caseFromDoc(host.doc, identityOf(seed)).prep.motion).toBe('THW abolish exams')

    await host.session.stop()
  })

  it('catches both sides up after the wire comes back', async () => {
    const hub = createHub()
    const seed = createEmptyCase('AP', 'gov', 'pm')
    const host = await join(hub, 'user-host', 'Priya', 'pm')
    seedDoc(host.doc, seed)
    vi.advanceTimersByTime(BATCH_MS)
    const guest = await join(hub, 'user-guest', 'Sam', 'dpm')

    hub.drop()
    const hostCase = caseFromDoc(host.doc, identityOf(seed))
    applyCaseToDoc(host.doc, hostCase, setFieldByPath(hostCase, 'prep.motion', 'THW ban zoos'))
    const guestCase = caseFromDoc(guest.doc, identityOf(seed))
    applyCaseToDoc(
      guest.doc,
      guestCase,
      setFieldByPath(guestCase, 'setup.stance', 'We stand in proposition.'),
    )
    vi.advanceTimersByTime(BATCH_MS)

    expect(caseFromDoc(guest.doc, identityOf(seed)).prep.motion).toBe('')

    // Reconnecting re-runs the handshake, which is why it is on every `connected` rather than
    // only the first one.
    hub.restore()
    vi.advanceTimersByTime(BATCH_MS)

    expect(caseFromDoc(guest.doc, identityOf(seed)).prep.motion).toBe('THW ban zoos')
    expect(caseFromDoc(host.doc, identityOf(seed)).setup.stance).toBe('We stand in proposition.')

    await host.session.stop()
    await guest.session.stop()
  })

  it('ignores a frame it does not understand and keeps the room open', async () => {
    const hub = createHub()
    const seed = createEmptyCase('AP', 'gov', 'pm')
    const host = await join(hub, 'user-host', 'Priya', 'pm')
    seedDoc(host.doc, seed)
    vi.advanceTimersByTime(BATCH_MS)
    const guest = await join(hub, 'user-guest', 'Sam', 'dpm')

    // A peer on a build that gained a fifth message kind, a truncated frame, a frame with no
    // sender, and something that is not JSON at all. A room is a place where somebody is always
    // running last week's install, so none of these may take it down.
    hub.inject('{"kind":"cursor","from":"user-guest","x":4}')
    hub.inject('{"kind":"update","from":"user-guest"}')
    hub.inject('{"kind":"presence","displayName":"Nobody"}')
    hub.inject('not json at all')
    hub.inject(null)

    const hostCase = caseFromDoc(host.doc, identityOf(seed))
    applyCaseToDoc(host.doc, hostCase, setFieldByPath(hostCase, 'prep.motion', 'THW ban zoos'))
    vi.advanceTimersByTime(BATCH_MS)
    expect(caseFromDoc(guest.doc, identityOf(seed)).prep.motion).toBe('THW ban zoos')
    expect(host.peers).toHaveLength(1)

    await guest.session.stop()
    await host.session.stop()
  })
})
