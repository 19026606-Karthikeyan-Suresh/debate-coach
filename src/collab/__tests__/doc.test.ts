/**
 * The shared document, proved by convergence rather than by inspection.
 *
 * A CRDT cannot be checked by reading it. Every test below runs **two documents** — the two
 * laptops of PLAN verification step 14 — exchanges updates between them in a stated order, and
 * asserts what both hold afterwards. Partition is modelled by holding a peer's updates in an
 * array and delivering them late, which is exactly what a dropped wifi connection does.
 */

import { describe, expect, it } from 'vitest'
import * as Yjs from 'yjs'

import { buildFilledExampleCase } from '../../analysis/__tests__/fixture.ts'
import { addSubstantive, setFieldByPath, setNeedsMechanism } from '../../case/update.ts'
import { createEmptyCase } from '../../types/createCase.ts'
import type { Case } from '../../types/case.ts'
import { applyCaseToDoc, caseFromDoc, isDocEmpty, seedDoc } from '../doc.ts'
import { buildCase, identityOf, walkCase, type ShapeSource } from '../shape.ts'

/** Two documents wired together, with the wire able to go down. */
interface Room {
  readonly host: Yjs.Doc
  readonly guest: Yjs.Doc
  /** Delivers everything each side has produced since the last flush. */
  readonly flush: () => void
  /** Drops the wire; updates queue on both sides until {@link Room.flush} is called again. */
  readonly partition: () => void
  /** Brings the wire back up without delivering anything yet. */
  readonly heal: () => void
}

/**
 * Wires two documents through a queue, so a test can decide when updates arrive.
 *
 * @returns The pair plus the controls.
 */
function openRoom(): Room {
  const host = new Yjs.Doc()
  const guest = new Yjs.Doc()
  const toGuest: Uint8Array[] = []
  const toHost: Uint8Array[] = []
  let isConnected = true

  host.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== guest) {
      toGuest.push(update)
    }
  })
  guest.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== host) {
      toHost.push(update)
    }
  })

  return {
    host,
    guest,
    flush: () => {
      if (!isConnected) {
        return
      }
      // Drained into locals first: applying an update makes the receiver emit its own, and
      // iterating the array being appended to would deliver a message to its own sender.
      const forGuest = toGuest.splice(0)
      const forHost = toHost.splice(0)
      for (const update of forGuest) {
        Yjs.applyUpdate(guest, update, host)
      }
      for (const update of forHost) {
        Yjs.applyUpdate(host, update, guest)
      }
    },
    partition: () => {
      isConnected = false
    },
    heal: () => {
      isConnected = true
    },
  }
}

/** Reads a case out of a document, keeping this side's own identity. */
function project(doc: Yjs.Doc, seat: Case): Case {
  return caseFromDoc(doc, identityOf(seat))
}

/** Applies one edit to a local case and pushes it into that side's document. */
function edit(doc: Yjs.Doc, current: Case, mutate: (input: Case) => Case): Case {
  const next = mutate(current)
  applyCaseToDoc(doc, current, next)
  return next
}

describe('the shared document', () => {
  it('round-trips the filled example through Yjs unchanged', () => {
    const original = buildFilledExampleCase()
    const doc = new Yjs.Doc()
    expect(isDocEmpty(doc)).toBe(true)

    seedDoc(doc, original)
    expect(isDocEmpty(doc)).toBe(false)

    expect(project(doc, original)).toEqual(original)
  })

  it('round-trips a case through the projection with no document at all', () => {
    // `walkCase` and `buildCase` are inverses over plain data; Yjs is only the storage. Proving
    // it here means a projection bug cannot hide behind a CRDT bug.
    const original = buildFilledExampleCase()
    const shape = walkCase(original)
    const leaves = new Map(shape.leaves.map((leaf) => [leaf.path, leaf.value]))
    const lists = new Map(shape.lists.map((list) => [list.path, list.ids]))
    const source: ShapeSource = {
      text: (path) => leaves.get(path) ?? null,
      scalar: (path) => leaves.get(path) ?? null,
      list: (path) => lists.get(path) ?? null,
    }

    expect(buildCase(source, identityOf(original))).toEqual(original)
  })

  it('keeps a structurally absent block absent', () => {
    const withoutPolicy = setNeedsMechanism(buildFilledExampleCase(), 'no')
    expect(withoutPolicy.policy).toBeNull()

    const doc = new Yjs.Doc()
    seedDoc(doc, withoutPolicy)

    // Absent is a different statement from empty, and the round trip has to keep them apart:
    // an empty POLICY table is a section the editor renders and the completeness meter counts.
    expect(project(doc, withoutPolicy).policy).toBeNull()
    expect(project(doc, withoutPolicy).extension).toBeNull()
  })

  it('merges edits to two different fields', () => {
    const room = openRoom()
    const seed = buildFilledExampleCase()
    seedDoc(room.host, seed)
    room.flush()

    let hostCase = project(room.host, seed)
    let guestCase = project(room.guest, seed)
    const substantiveId = seed.substantives[0]?.id ?? ''

    hostCase = edit(room.host, hostCase, (input) =>
      setFieldByPath(input, `substantives.${substantiveId}.example`, 'Cambridge Analytica, 2018.'),
    )
    guestCase = edit(room.guest, guestCase, (input) =>
      setFieldByPath(input, 'prep.fiveW1H.who', 'Teenagers aged 13 to 17.'),
    )
    room.flush()

    for (const [doc, seat] of [
      [room.host, hostCase],
      [room.guest, guestCase],
    ] as const) {
      const merged = project(doc, seat)
      expect(merged.substantives[0]?.example).toBe('Cambridge Analytica, 2018.')
      expect(merged.prep.fiveW1H.who).toBe('Teenagers aged 13 to 17.')
    }
  })

  it('keeps both sentences when two people type in one field at once', () => {
    // The whole reason for a character-level diff. A whole-value write would make each keystroke
    // a replacement of the entire row, and the merge would keep one debater's work and bin the
    // other's — which is the failure co-prep exists to avoid.
    const room = openRoom()
    const seed = createEmptyCase('AP', 'gov', 'pm')
    seedDoc(room.host, seed)
    room.flush()

    let hostCase = project(room.host, seed)
    let guestCase = project(room.guest, seed)

    hostCase = edit(room.host, hostCase, (input) =>
      setFieldByPath(input, 'setup.burdens', 'We must prove the harm is systemic.'),
    )
    room.flush()
    guestCase = project(room.guest, guestCase)

    room.partition()
    hostCase = edit(room.host, hostCase, (input) =>
      setFieldByPath(
        input,
        'setup.burdens',
        'We must prove the harm is systemic, not anecdotal.',
      ),
    )
    guestCase = edit(room.guest, guestCase, (input) =>
      setFieldByPath(
        input,
        'setup.burdens',
        'In this round, we must prove the harm is systemic.',
      ),
    )
    room.heal()
    room.flush()

    const hostText = project(room.host, hostCase).setup.burdens
    const guestText = project(room.guest, guestCase).setup.burdens
    expect(hostText).toBe(guestText)
    // Both insertions survive: the head one and the tail one.
    expect(hostText).toContain('In this round')
    expect(hostText).toContain('not anecdotal')
  })

  it('keeps both substantives when two people add one at once', () => {
    const room = openRoom()
    const seed = createEmptyCase('AP', 'gov', 'pm')
    seedDoc(room.host, seed)
    room.flush()

    let hostCase = project(room.host, seed)
    let guestCase = project(room.guest, seed)
    const startingCount = seed.substantives.length

    room.partition()
    hostCase = edit(room.host, hostCase, addSubstantive)
    guestCase = edit(room.guest, guestCase, addSubstantive)
    room.heal()
    room.flush()

    const hostMerged = project(room.host, hostCase)
    const guestMerged = project(room.guest, guestCase)
    expect(hostMerged.substantives).toHaveLength(startingCount + 2)
    expect(guestMerged.substantives.map((item) => item.id)).toEqual(
      hostMerged.substantives.map((item) => item.id),
    )
  })

  it('reconciles a partition where one side wrote for a while', () => {
    const room = openRoom()
    const seed = buildFilledExampleCase()
    seedDoc(room.host, seed)
    room.flush()

    let hostCase = project(room.host, seed)
    let guestCase = project(room.guest, seed)
    const substantiveId = seed.substantives[1]?.id ?? ''

    // The guest is off the network and types a whole row, one keystroke at a time — the shape
    // the store really produces, rather than one big write.
    room.partition()
    const typed = 'Platforms profit from outrage, so the algorithm selects for it.'
    for (let length = 1; length <= typed.length; length += 1) {
      guestCase = edit(room.guest, guestCase, (input) =>
        setFieldByPath(input, `substantives.${substantiveId}.whyExists`, typed.slice(0, length)),
      )
    }
    hostCase = edit(room.host, hostCase, (input) =>
      setFieldByPath(input, 'setup.stance', 'We stand in firm proposition.'),
    )

    room.heal()
    room.flush()

    const hostMerged = project(room.host, hostCase)
    const guestMerged = project(room.guest, guestCase)
    expect(hostMerged.substantives[1]?.whyExists).toBe(typed)
    expect(guestMerged.setup.stance).toBe('We stand in firm proposition.')
    expect(hostMerged.substantives).toEqual(guestMerged.substantives)
  })

  it('never shares the seat, the id or the timestamps', () => {
    // A PM and a DPM co-prepping one round fill different blocks of the same content. Sharing
    // `position` would move one of them out of their own seat mid-prep.
    const room = openRoom()
    const seed = createEmptyCase('AP', 'gov', 'pm')
    seedDoc(room.host, seed)
    room.flush()

    const guestSeat: Case = {
      ...createEmptyCase('AP', 'gov', 'dpm'),
      id: 'guest-local-id',
      createdAt: '2026-01-01T00:00:00.000Z',
    }

    const hostView = project(room.host, seed)
    const guestView = project(room.guest, guestSeat)

    expect(hostView.position).toBe('pm')
    expect(guestView.position).toBe('dpm')
    expect(guestView.id).toBe('guest-local-id')
    expect(guestView.createdAt).toBe('2026-01-01T00:00:00.000Z')
    // The round itself is shared, because both debaters are in it.
    expect(guestView.format).toBe(hostView.format)
    expect(guestView.side).toBe(hostView.side)
  })

  it('removes a deleted block from the document rather than leaving it behind', () => {
    const doc = new Yjs.Doc()
    const seed = buildFilledExampleCase()
    seedDoc(doc, seed)

    const before = doc.getMap('fields').size
    const withoutPolicy = setNeedsMechanism(seed, 'no')
    applyCaseToDoc(doc, seed, withoutPolicy)

    // Five POLICY rows gone. A document that only ever grows sends a late joiner rows for
    // blocks nobody can see, and does it for the whole of prep.
    expect(doc.getMap('fields').size).toBe(before - 5)
    expect(project(doc, seed).policy).toBeNull()
  })

  // The next three are the reason an edit is written to the document as a delta rather than as
  // the local snapshot. All three look identical from one side: the local case is simply out of
  // date, which it is for one render after every remote update and for the whole of a partition.
  it('does not resurrect a row a peer deleted while this side was typing', () => {
    const room = openRoom()
    const seed = buildFilledExampleCase()
    seedDoc(room.host, seed)
    room.flush()

    let hostCase = project(room.host, seed)
    const guestCase = project(room.guest, seed)
    const doomed = seed.substantives[2]?.id ?? ''

    room.partition()
    // The guest removes a substantive. The host, not knowing, types into it.
    edit(room.guest, guestCase, (input) => ({
      ...input,
      substantives: input.substantives.filter((item) => item.id !== doomed),
    }))
    hostCase = edit(room.host, hostCase, (input) =>
      setFieldByPath(input, `substantives.${doomed}.example`, 'A study from 2024.'),
    )
    room.heal()
    room.flush()

    expect(project(room.host, hostCase).substantives.map((item) => item.id)).not.toContain(doomed)
    expect(project(room.guest, guestCase).substantives.map((item) => item.id)).not.toContain(doomed)
  })

  it('does not delete a row a peer added while this side was typing', () => {
    const room = openRoom()
    const seed = createEmptyCase('AP', 'gov', 'pm')
    seedDoc(room.host, seed)
    room.flush()

    let hostCase = project(room.host, seed)
    const guestCase = project(room.guest, seed)

    room.partition()
    const guestAdded = edit(room.guest, guestCase, addSubstantive)
    const addedId = guestAdded.substantives.at(-1)?.id ?? ''
    hostCase = edit(room.host, hostCase, (input) =>
      setFieldByPath(input, 'prep.motion', 'THW ban political advertising online'),
    )
    room.heal()
    room.flush()

    expect(project(room.host, hostCase).substantives.map((item) => item.id)).toContain(addedId)
  })

  it('does not clobber a peer’s words in the same row', () => {
    const doc = new Yjs.Doc()
    const seed = createEmptyCase('AP', 'gov', 'pm')
    seedDoc(doc, seed)

    const stale = project(doc, seed)
    // A peer's edit lands in the document. The local case still holds the old value, which is
    // exactly the state a keystroke can be composed against.
    doc.getMap<Yjs.Text>('fields').get('setup.stance')?.insert(0, 'We stand in proposition.')

    applyCaseToDoc(doc, stale, setFieldByPath(stale, 'setup.stance', 'X'))

    const merged = project(doc, seed).setup.stance
    expect(merged).toContain('We stand in proposition.')
    expect(merged).toContain('X')
  })

  it('emits one update for one edit, however many rows it touched', () => {
    // Realtime's rate limit is per message, so a transaction per row would put a burst of a
    // dozen messages on the wire for one click. It also matters for correctness: half an edit
    // arriving alone is a substantive in the list with no rows behind it.
    const doc = new Yjs.Doc()
    const seed = createEmptyCase('AP', 'gov', 'pm')
    seedDoc(doc, seed)

    let updates = 0
    doc.on('update', () => {
      updates += 1
    })
    applyCaseToDoc(doc, seed, addSubstantive(seed))
    expect(updates).toBe(1)
  })
})
