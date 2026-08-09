import { describe, expect, it } from 'vitest'
import * as Yjs from 'yjs'

import { buildFilledExampleCase } from '../../analysis/__tests__/fixture.ts'
import { seedDoc } from '../doc.ts'
import {
  base64ToBytes,
  bytesToBase64,
  caseIdFromTopic,
  parseMessage,
  roomTopic,
} from '../protocol.ts'

/**
 * Supabase Realtime's default maximum broadcast payload.
 *
 * The join handshake is the only message that can approach it: a keystroke's update is tens of
 * bytes, but a peer answering a `hello` sends everything the joiner is missing, which on a first
 * join is the whole case.
 */
const BROADCAST_PAYLOAD_LIMIT_BYTES = 256 * 1024

describe('base64 on the wire', () => {
  it('round-trips a Yjs update', () => {
    const doc = new Yjs.Doc()
    seedDoc(doc, buildFilledExampleCase())
    const update = Yjs.encodeStateAsUpdate(doc)

    expect(base64ToBytes(bytesToBase64(update))).toEqual(update)
  })

  it('round-trips an update far larger than one chunk', () => {
    // `String.fromCharCode` takes its arguments on the stack, so the encoder chunks. A document
    // big enough to cross that boundary is the only thing that proves the chunking.
    const bytes = new Uint8Array(200_000)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256
    }
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it('leaves a whole filled case well inside one broadcast', () => {
    // A measured number rather than an assumption. If a future document shape pushed this past
    // the limit the failure would be a room that silently never syncs a late joiner.
    const doc = new Yjs.Doc()
    seedDoc(doc, buildFilledExampleCase())
    const encoded = bytesToBase64(Yjs.encodeStateAsUpdate(doc))

    expect(encoded.length).toBeLessThan(BROADCAST_PAYLOAD_LIMIT_BYTES / 2)
  })
})

describe('room topics', () => {
  it('round-trips a case id', () => {
    const caseId = 'aaaaaaaa-0000-4000-8000-000000000001'
    expect(roomTopic(caseId)).toBe(`case:${caseId}`)
    expect(caseIdFromTopic(roomTopic(caseId))).toBe(caseId)
  })

  it('refuses a topic that is not a case room', () => {
    for (const topic of ['lobby', 'case:', 'case:short', '', 'realtime:case:x']) {
      expect(caseIdFromTopic(topic)).toBeNull()
    }
  })
})

describe('parsing a frame', () => {
  it('accepts each of the four kinds', () => {
    expect(parseMessage('{"kind":"update","from":"a","data":"AA=="}')).toEqual({
      kind: 'update',
      from: 'a',
      data: 'AA==',
    })
    expect(parseMessage({ kind: 'hello', from: 'a', stateVector: 'AA==' })).toEqual({
      kind: 'hello',
      from: 'a',
      stateVector: 'AA==',
    })
    expect(parseMessage({ kind: 'leave', from: 'a' })).toEqual({ kind: 'leave', from: 'a' })
    expect(
      parseMessage({ kind: 'presence', from: 'a', displayName: 'Sam', seat: 'dpm' }),
    ).toEqual({ kind: 'presence', from: 'a', displayName: 'Sam', seat: 'dpm', fieldPath: null })
  })

  it('drops anything it cannot use rather than throwing', () => {
    // A room is a place where somebody is always running last week's install, so a frame from a
    // build with a fifth message kind has to be ignorable.
    for (const frame of [
      'not json',
      '{}',
      null,
      42,
      { kind: 'cursor', from: 'a' },
      { kind: 'update', from: 'a' },
      { kind: 'update', data: 'AA==' },
      { kind: 'update', from: '', data: 'AA==' },
      { kind: 'presence', from: 'a', displayName: 'Sam' },
    ]) {
      expect(parseMessage(frame)).toBeNull()
    }
  })
})
