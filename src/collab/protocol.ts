/**
 * What one co-prep room says on the wire, whatever the wire is.
 *
 * Four messages, and every one of them is broadcast to the whole room rather than addressed to a
 * peer. That is not a shortcut: applying a Yjs update you already have is a no-op, so an
 * unaddressed reply is *idempotent*, and idempotence is what removes every question about who
 * should have answered a late joiner when three people were online. The cost is a few extra
 * kilobytes on a join, once.
 *
 * Messages are JSON because both transports carry text — Supabase Realtime broadcasts a JSON
 * payload, and the LAN relay frames UTF-8 — and because a room that misbehaves is then readable
 * in a log. Yjs updates are binary, so they ride as base64.
 */

/** Which wire a room is running over. */
export type CollabTransport = 'realtime' | 'lan'

/** A Yjs update, or a slice of one peer's whole state. */
export interface UpdateMessage {
  readonly kind: 'update'
  /** Sender's `auth.uid()`, or its LAN stand-in. Used to drop our own echo. */
  readonly from: string
  /** Base64 of a Yjs update. */
  readonly data: string
}

/**
 * "I have just joined; here is what I already know."
 *
 * Every peer answers with the difference, which is why a joiner needs no server and no elected
 * host to catch up as long as one other person is in the room.
 */
export interface HelloMessage {
  readonly kind: 'hello'
  readonly from: string
  /** Base64 of `Y.encodeStateVector`. */
  readonly stateVector: string
}

/** Who is in the room, where they are sitting, and which row they are in. */
export interface PresenceMessage {
  readonly kind: 'presence'
  readonly from: string
  readonly displayName: string
  /** Role id from the format registry, so the panel can say "DPM" rather than a uuid. */
  readonly seat: string
  /** Field path this peer's caret is in, or null when they are not in a field. */
  readonly fieldPath: string | null
}

/** "I am closing the tab" — so a peer disappears at once rather than after the heartbeat lapses. */
export interface LeaveMessage {
  readonly kind: 'leave'
  readonly from: string
}

/** Anything a room can say. */
export type CollabMessage = UpdateMessage | HelloMessage | PresenceMessage | LeaveMessage

/**
 * `String.fromCharCode` takes its arguments on the stack, so a whole document at once overflows
 * it. 32 KB per call is comfortably under every engine's limit.
 */
const BASE64_CHUNK_BYTES = 0x8000

/**
 * Base64-encodes a Yjs update.
 *
 * @param bytes - The update. Any length; it is chunked.
 * @returns The encoded string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES))
  }
  return btoa(binary)
}

/**
 * Decodes what {@link bytesToBase64} produced.
 *
 * @param encoded - Base64 text.
 * @returns The bytes.
 * @throws If the string is not valid base64 — which means a corrupted frame, and applying a
 *   half-decoded update to a live document is worse than dropping the message.
 */
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * Parses one frame off the wire.
 *
 * @param raw - The JSON text, or an already-parsed object from a transport that hands one over.
 * @returns The message, or null when it is not one we understand. Null rather than a throw: a
 *   peer on a newer build sending a fifth message kind must not take the room down, and a room
 *   is a place where somebody is always running last week's install.
 */
export function parseMessage(raw: unknown): CollabMessage | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const candidate = value as Partial<CollabMessage> & Record<string, unknown>
  if (typeof candidate.from !== 'string' || candidate.from.length === 0) {
    return null
  }

  switch (candidate.kind) {
    case 'update':
      return typeof candidate.data === 'string'
        ? { kind: 'update', from: candidate.from, data: candidate.data }
        : null
    case 'hello':
      return typeof candidate.stateVector === 'string'
        ? { kind: 'hello', from: candidate.from, stateVector: candidate.stateVector }
        : null
    case 'presence':
      return typeof candidate.displayName === 'string' && typeof candidate.seat === 'string'
        ? {
            kind: 'presence',
            from: candidate.from,
            displayName: candidate.displayName,
            seat: candidate.seat,
            fieldPath: typeof candidate.fieldPath === 'string' ? candidate.fieldPath : null,
          }
        : null
    case 'leave':
      return { kind: 'leave', from: candidate.from }
    default:
      return null
  }
}

/**
 * The channel name a case's room runs on.
 *
 * The prefix is not decoration: `realtime.messages`' policy parses it to find the case, so a
 * topic that does not match this shape is refused rather than joined. See migration 6.
 *
 * @param caseId - The **host's** case id. A guest's local copy has its own id and must not be
 *   used here, or two people would sit in two rooms and each see nobody.
 * @returns The topic.
 */
export function roomTopic(caseId: string): string {
  return `case:${caseId}`
}

/**
 * Pulls the case id back out of a topic.
 *
 * @param topic - As produced by {@link roomTopic}.
 * @returns The case id, or null when the topic is not a case room.
 */
export function caseIdFromTopic(topic: string): string | null {
  const match = /^case:([0-9a-fA-F-]{36})$/.exec(topic)
  return match?.[1] ?? null
}
