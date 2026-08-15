/**
 * Live co-prep, in the prep screen's right rail.
 *
 * Three things the panel has to get right, all of them about saying what is actually true:
 *
 *   * **A room is started, never joined by accident.** Nothing about a case goes on the wire
 *     unasked — the same rule the recording upload follows. This is a button.
 *   * **A private case has no room**, because the policy resolves to the same predicate that
 *     decides who can read the case. Saying that in those words, with the switch beside it,
 *     beats reporting a channel error nobody can act on.
 *   * **Which wire it is on, always.** Realtime and the LAN relay fail in completely different
 *     ways, and "it stopped updating" is unanswerable without knowing which one is carrying it.
 *
 * A browser has one wire rather than two — no sockets to bind, so no relay — and the panel drops
 * the second button rather than offering one that always fails. The visibility explanation changes
 * with it: on the desktop a private case still has the local-network room as a way in, and in a
 * browser it has none, so promising one there sends somebody looking for a button that is not
 * present.
 */

import type { CollabPeer } from '../collab/presence.ts'
import type { CoPrep } from '../hooks/useCoPrep.ts'
import type { SpeakerRole } from '../formats/index.ts'
import type { Case } from '../types/case.ts'

/** Props for {@link CoPrepPanel}. */
export interface CoPrepPanelProps {
  readonly coPrep: CoPrep
  /** The open case, for the visibility check the room needs. */
  readonly caseFile: Case
  /** Seats of the open format, so a peer is named by their position rather than by an id. */
  readonly roles: readonly SpeakerRole[]
  /** Labels a field path, so "editing Sub 2's mechanism" reads as the template's own question. */
  readonly labelForPath: (fieldPath: string) => string | null
}

/** Turns a role id into the seat's label, falling back to the raw id. */
function seatLabel(roles: readonly SpeakerRole[], seat: string): string {
  return roles.find((role) => role.id === seat)?.label ?? (seat === '' ? 'no seat' : seat)
}

/** One teammate, and where they are working. */
function PeerRow({
  peer,
  roles,
  labelForPath,
}: {
  peer: CollabPeer
  roles: readonly SpeakerRole[]
  labelForPath: (fieldPath: string) => string | null
}): React.JSX.Element {
  const where = peer.fieldPath === null ? null : labelForPath(peer.fieldPath)
  return (
    <li className="flex flex-col gap-0.5">
      <span className="text-neutral-700 dark:text-neutral-200">
        {peer.displayName === '' ? 'A teammate' : peer.displayName}
        <span className="text-neutral-400 dark:text-neutral-500">
          {' · '}
          {seatLabel(roles, peer.seat)}
        </span>
      </span>
      {where !== null && (
        <span className="text-neutral-500 dark:text-neutral-400">in “{where}”</span>
      )}
    </li>
  )
}

/**
 * Renders the co-prep controls and the roster.
 *
 * @param props - See {@link CoPrepPanelProps}.
 * @param props.coPrep - State from `useCoPrep`, owned by the screen.
 * @param props.caseFile - The open case.
 * @param props.roles - Seats of the open format.
 * @param props.labelForPath - Resolves a field path to the template's question.
 * @returns The panel.
 */
export function CoPrepPanel({
  coPrep,
  caseFile,
  roles,
  labelForPath,
}: CoPrepPanelProps): React.JSX.Element {
  const isOpen = coPrep.status === 'connected' || coPrep.status === 'connecting'
  // A room over Realtime is only reachable by somebody who can read the case, so a private one is
  // a room of one. The LAN relay has no such check — it is whoever is on the network.
  const needsSharing = caseFile.visibility !== 'team'

  return (
    <section className="flex flex-col gap-2 text-sm">
      <h2 className="font-medium text-neutral-700 dark:text-neutral-200">Co-prep</h2>

      {!coPrep.canStart && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          This build has no team project and no desktop shell, so there is nowhere to run a room.
        </p>
      )}

      {coPrep.canStart && !isOpen && (
        <>
          <div className="flex gap-1.5">
            <button
              type="button"
              className="btn flex-1 justify-center"
              disabled={coPrep.isBusy || needsSharing}
              onClick={() => {
                void coPrep.start('realtime')
              }}
            >
              {coPrep.hasLanTransport ? 'Online' : 'Start a room'}
            </button>
            {coPrep.hasLanTransport && (
              <button
                type="button"
                className="btn flex-1 justify-center"
                disabled={coPrep.isBusy}
                onClick={() => {
                  void coPrep.start('lan')
                }}
              >
                This network
              </button>
            )}
          </div>
          {needsSharing &&
            (coPrep.hasLanTransport ? (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                An online room is open to the teammates who can read the case, so this one has to be
                shared with your team first. A local-network room does not — it is whoever is in the
                room with you.
              </p>
            ) : (
              // Same constraint, minus the escape hatch: pointing a browser at a local-network
              // room it cannot open is worse than saying there is one way in.
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                A room is open to the teammates who can read the case, so this one has to be shared
                with your team first.
              </p>
            ))}
        </>
      )}

      {isOpen && (
        <>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {coPrep.status === 'connecting' ? 'Joining' : 'In'} the{' '}
            {coPrep.transport === 'lan' ? 'local-network' : 'online'} room
            {coPrep.role === 'guest' ? ' as a guest' : ''}.
          </p>
          <button
            type="button"
            className="btn w-full justify-center"
            disabled={coPrep.isBusy}
            onClick={() => {
              void coPrep.stop()
            }}
          >
            Leave the room
          </button>
        </>
      )}

      {coPrep.status === 'error' && coPrep.detail !== null && (
        <p className="text-xs text-red-700 dark:text-red-400">{coPrep.detail}</p>
      )}
      {coPrep.status !== 'error' && coPrep.detail !== null && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{coPrep.detail}</p>
      )}

      {isOpen && (
        <div className="flex flex-col gap-1 text-xs">
          {coPrep.peers.length === 0 ? (
            <p className="text-neutral-500 dark:text-neutral-400">
              Nobody else is here yet. Your work is saved either way.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {coPrep.peers.map((peer) => (
                <PeerRow
                  key={peer.userId}
                  peer={peer}
                  roles={roles}
                  labelForPath={labelForPath}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
