/**
 * Live co-prep for one open case.
 *
 * # The document is the source of truth while a room is open
 *
 * The obvious wiring is to keep React's `caseFile` authoritative and mirror it into the CRDT from
 * an effect. It loses keystrokes, and the window is one render: a peer's update that lands
 * between a keystroke and the effect that would have pushed it makes the projection overwrite a
 * character that was never sent. In a text editor that is the one bug not worth any amount of
 * simplicity.
 *
 * So {@link CoPrep.update} reads the live `Yjs.Doc`, applies the edit to it, and projects back —
 * all synchronously, inside the event handler. Remote updates project the same way from the Yjs
 * observer. There is no effect in the path and nothing to race: every local edit is composed
 * against the document as it is at that instant, which is also the state every other peer's
 * merge is computed against.
 *
 * The store underneath is untouched. It still owns SQLite and still autosaves, so a room is a
 * layer over the local-first path rather than a replacement for it — pull the network and the
 * case keeps saving.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as Yjs from 'yjs'

import { applyCaseToDoc, caseFromDoc, REMOTE_ORIGIN, seedDoc } from '../collab/doc.ts'
import type { CollabPeer } from '../collab/presence.ts'
import { roomTopic, type CollabTransport } from '../collab/protocol.ts'
import {
  createCollabSession,
  type CollabSession,
  type CollabStatus,
} from '../collab/session.ts'
import { identityOf } from '../collab/shape.ts'
import type { Case } from '../types/case.ts'
import {
  createLanLink,
  createRealtimeLink,
  findOrHostLanRoom,
  hasLanTransport,
} from '../sync/provider.ts'
import { readRoomLink, readSetting, SETTING_KEYS } from '../sync/store.ts'
import { ensureSignedIn, fetchDocState, getSupabase, pushDocState } from '../sync/supabase.ts'

/** How long the document must be quiet before the host writes a snapshot. */
const SNAPSHOT_DELAY_MS = 4_000

/** Whether this install owns the case the room is named after. */
export type RoomRole = 'host' | 'guest'

/** Everything the co-prep panel shows and does. */
export interface CoPrep {
  /** False on a build with no Supabase project *and* no Tauri shell — nothing to run a room on. */
  readonly canStart: boolean
  /**
   * Whether `start('lan')` is worth offering.
   *
   * Straight through from the platform, because the panel is the only thing that can act on it:
   * a browser has no sockets to bind, so a LAN button there is a button that always fails.
   */
  readonly hasLanTransport: boolean
  readonly status: CollabStatus
  /** Null until a room has been started. */
  readonly transport: CollabTransport | null
  /** The host's case id — the room's name. Null until the room link has been read. */
  readonly roomId: string | null
  readonly role: RoomRole
  readonly peers: readonly CollabPeer[]
  /** The last error, or an explanation of the current state. Null when there is nothing to say. */
  readonly detail: string | null
  /** True while joining or leaving. */
  readonly isBusy: boolean
  readonly start: (transport: CollabTransport) => Promise<void>
  readonly stop: () => Promise<void>
  /**
   * Edits the case.
   *
   * While a room is open this goes through the document; otherwise it is the store's own
   * `update`. Callers use it unconditionally, which is what keeps the editor free of a branch on
   * every keystroke.
   */
  readonly update: (mutate: (current: Case) => Case) => void
  /** Announces which row the caret is in, so teammates can see it. */
  readonly setFieldPath: (fieldPath: string | null) => void
}

/**
 * Runs co-prep for the open case.
 *
 * @param caseFile - The case, from the store. Null while it loads; every action is a no-op then.
 * @param update - The store's own `update`. Used verbatim when no room is open, and to publish
 *   the projection when one is.
 * @returns See {@link CoPrep}.
 */
export function useCoPrep(
  caseFile: Case | null,
  update: (mutate: (current: Case) => Case) => void,
): CoPrep {
  const [status, setStatus] = useState<CollabStatus>('idle')
  const [transport, setTransport] = useState<CollabTransport | null>(null)
  const [peers, setPeers] = useState<readonly CollabPeer[]>([])
  const [detail, setDetail] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [roomId, setRoomId] = useState<string | null>(null)
  const [role, setRole] = useState<RoomRole>('host')

  // The live room. Refs rather than state: none of these is rendered, and a re-render on every
  // keystroke to store a document that has not been replaced is work for nothing.
  const docRef = useRef<Yjs.Doc | null>(null)
  const sessionRef = useRef<CollabSession | null>(null)
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Identity for a projection driven by a *peer*, which has no local edit to take it from.
  // Only ever holds this install's own id, seat and visibility — never a peer's.
  const identityRef = useRef(caseFile ? identityOf(caseFile) : null)
  useEffect(() => {
    identityRef.current = caseFile ? identityOf(caseFile) : null
  }, [caseFile])

  const caseId = caseFile?.id ?? null

  // Switching cases blanks the room during render rather than in an effect, the same way the
  // store blanks the document: an effect would paint one frame of the previous case's room.
  const [loadedCaseId, setLoadedCaseId] = useState(caseId)
  if (loadedCaseId !== caseId) {
    setLoadedCaseId(caseId)
    setRoomId(null)
    setRole('host')
  }

  // A copy of a teammate's case remembers whose room it belongs to; a case of our own is its own
  // room. Read on open rather than on start, so the panel can say which it will be.
  useEffect(() => {
    if (caseId === null) {
      return
    }
    let isStale = false
    void readRoomLink(caseId)
      .then((linked) => {
        if (!isStale) {
          setRoomId(linked ?? caseId)
          setRole(linked === null ? 'host' : 'guest')
        }
      })
      .catch(() => {
        if (!isStale) {
          setRoomId(caseId)
          setRole('host')
        }
      })
    return () => {
      isStale = true
    }
  }, [caseId])

  /** Publishes the document into React state. Called by a peer's update, never by our own. */
  const projectFromDoc = useCallback((): void => {
    const doc = docRef.current
    const localIdentity = identityRef.current
    if (!doc || !localIdentity) {
      return
    }
    // `updatedAt` is stamped here rather than shared, so the store's autosave notices and the
    // sync queue has a timestamp that means "when this install last changed".
    const projected: Case = {
      ...caseFromDoc(doc, localIdentity),
      updatedAt: new Date().toISOString(),
    }
    update(() => projected)
  }, [update])

  /**
   * Writes the document to `cases.ydoc_state` after a pause, so somebody opening the case with
   * nobody else online still gets it. Host only — `cases_update` grants nobody else, which is
   * the right shape rather than a limitation.
   */
  const scheduleSnapshot = useCallback(
    (targetRoomId: string): void => {
      if (snapshotTimerRef.current !== null) {
        clearTimeout(snapshotTimerRef.current)
      }
      snapshotTimerRef.current = setTimeout(() => {
        snapshotTimerRef.current = null
        const doc = docRef.current
        const client = getSupabase()
        if (!doc || !client) {
          return
        }
        // A failed snapshot costs a late joiner a wait for a peer, which is recoverable, so it
        // is not reported: a red banner for something nobody in the room can act on is noise.
        void pushDocState(client, targetRoomId, Yjs.encodeStateAsUpdate(doc)).catch(() => {})
      }, SNAPSHOT_DELAY_MS)
    },
    [],
  )

  const stop = useCallback(async (): Promise<void> => {
    if (snapshotTimerRef.current !== null) {
      clearTimeout(snapshotTimerRef.current)
      snapshotTimerRef.current = null
    }
    const session = sessionRef.current
    sessionRef.current = null
    docRef.current = null
    setPeers([])
    setTransport(null)
    setStatus('idle')
    if (session) {
      await session.stop()
    }
  }, [])

  const start = useCallback(
    async (wanted: CollabTransport): Promise<void> => {
      if (caseFile === null || roomId === null || sessionRef.current !== null) {
        return
      }
      setIsBusy(true)
      setDetail(null)
      try {
        const doc = new Yjs.Doc()
        const client = getSupabase()
        // Read at join time, not on open: signing in is a network call, and opening a case must
        // not make one. `ensureSignedIn` below resumes the stored session when there is one.
        const displayName = (await readSetting(SETTING_KEYS.displayName).catch(() => null)) ?? ''
        let userId = roomUserId(null)

        // A guest starts from the stored snapshot when there is one, so opening a teammate's
        // room with nobody online shows the case rather than an empty template. A host seeds
        // from its own case — and **only** a host seeds: two peers seeding one empty room
        // produce two of every substantive, and the CRDT is right to keep both.
        if (role === 'guest') {
          if (client) {
            const snapshot = await fetchDocState(client, roomId).catch(() => null)
            if (snapshot) {
              Yjs.applyUpdate(doc, snapshot, REMOTE_ORIGIN)
            }
          }
        } else {
          seedDoc(doc, caseFile)
        }

        let link
        if (wanted === 'realtime') {
          if (!client) {
            setDetail('This build has no Supabase project, so only the local-network room works.')
            setIsBusy(false)
            return
          }
          // A private channel is authorised from the socket's token, so the identity has to
          // exist before the join rather than after it.
          userId = await ensureSignedIn(client)
          link = createRealtimeLink(client, roomTopic(roomId))
        } else {
          const room = await findOrHostLanRoom(roomId)
          setDetail(
            room.isHosting
              ? `Hosting on this network. If a teammate's search is blocked, they can type ${room.address.replace('127.0.0.1', '<your IP>')}.`
              : `Joined ${room.address}.`,
          )
          link = createLanLink(room.address)
        }

        docRef.current = doc
        const session = createCollabSession({
          doc,
          link,
          identity: { userId, displayName, seat: caseFile.position },
          onDocChanged: () => {
            projectFromDoc()
            if (role === 'host') {
              scheduleSnapshot(roomId)
            }
          },
          onPeersChanged: setPeers,
          onStatusChanged: (next, why) => {
            setStatus(next)
            if (why !== null) {
              setDetail(why)
            }
          },
        })
        sessionRef.current = session
        setTransport(wanted)
        await session.start()

        // A guest's local case is replaced by the room's, which is the point of joining one.
        if (role === 'guest') {
          projectFromDoc()
        } else {
          scheduleSnapshot(roomId)
        }
      } catch (startError) {
        setDetail(startError instanceof Error ? startError.message : String(startError))
        setStatus('error')
        await stop()
      } finally {
        setIsBusy(false)
      }
    },
    [caseFile, roomId, role, projectFromDoc, scheduleSnapshot, stop],
  )

  // Leaving the editor leaves the room. Without this a closed case keeps broadcasting presence
  // and keeps a socket open, and a teammate's panel keeps listing somebody who has gone.
  useEffect(() => {
    return () => {
      const session = sessionRef.current
      sessionRef.current = null
      docRef.current = null
      if (snapshotTimerRef.current !== null) {
        clearTimeout(snapshotTimerRef.current)
      }
      void session?.stop()
    }
  }, [caseId])

  // The seat is not shared, but it is announced: a teammate's panel should say "DPM", and should
  // stop saying it the moment they are reassigned.
  const seat = caseFile?.position ?? ''
  useEffect(() => {
    sessionRef.current?.setSeat(seat)
  }, [seat])

  /**
   * The edit path. Reads the live document, applies, writes the delta, projects — synchronously,
   * so nothing can land in between.
   */
  const roomUpdate = useCallback(
    (mutate: (current: Case) => Case): void => {
      const doc = docRef.current
      if (!doc || caseFile === null) {
        update(mutate)
        return
      }
      const current = caseFromDoc(doc, identityOf(caseFile))
      const next = mutate(current)
      applyCaseToDoc(doc, current, next)
      // Identity comes off `next`, not off a ref: `setSeat` and the visibility switch are edits
      // to fields the document does not carry, and reading them from anywhere else reverts them.
      const nextIdentity = identityOf(next)
      identityRef.current = nextIdentity
      update(() => ({ ...caseFromDoc(doc, nextIdentity), updatedAt: new Date().toISOString() }))
      if (role === 'host' && roomId !== null) {
        scheduleSnapshot(roomId)
      }
    },
    [caseFile, update, role, roomId, scheduleSnapshot],
  )

  const setFieldPath = useCallback((fieldPath: string | null): void => {
    sessionRef.current?.setFieldPath(fieldPath)
  }, [])

  return {
    canStart: getSupabase() !== null || hasLanTransport,
    hasLanTransport,
    status,
    transport,
    roomId,
    role,
    peers,
    detail,
    isBusy,
    start,
    stop,
    update: roomUpdate,
    setFieldPath,
  }
}

/** Stands in for `auth.uid()` on a build with no project. One per launch, which is enough. */
let launchId: string | null = null

/** This install's id inside a room. */
function roomUserId(userId: string | null): string {
  if (userId !== null) {
    return userId
  }
  launchId ??= crypto.randomUUID()
  return launchId
}
