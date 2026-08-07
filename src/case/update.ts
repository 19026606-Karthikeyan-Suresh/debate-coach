/**
 * Immutable edits to a case.
 *
 * Every function returns a new case and stamps `updatedAt`, because that timestamp is what the
 * sync queue (phase 9) compares against the server row — an in-place mutation would save
 * without ever looking modified.
 *
 * `setFieldByPath` is the one the editor actually calls on every keystroke. It takes the same
 * `path` strings `buildSections` hands out, which is what lets phase 3 send a finding straight
 * to the field it came from without a second addressing scheme.
 */

import type { Side, SpeakerRole } from '../formats/index.ts'
import { getRole, requiresExtension } from '../formats/index.ts'
import type {
  Case,
  Clash,
  ClashEngagement,
  MechanismDecision,
  OpponentResponseBranch,
  Visibility,
} from '../types/case.ts'
import {
  createClash,
  createExtensionBlock,
  createHandledArgument,
  createOpposingRebuttalBlock,
  createOurArgumentEngagement,
  createOverlapEngagement,
  createPointOfInformation,
  createPolicyBlock,
  createRebuttalBlock,
  createSubstantive,
  createTheirArgumentEngagement,
} from '../types/createCase.ts'

/**
 * Applies changes and stamps the modification time.
 *
 * @param caseFile - The case being edited.
 * @param changes - Fields to overwrite. Passing `id` or `createdAt` here would rewrite
 *   identity, so no caller in this module does.
 */
function touched(caseFile: Case, changes: Partial<Case>): Case {
  return { ...caseFile, ...changes, updatedAt: new Date().toISOString() }
}

/**
 * Overwrites one string property of a block.
 *
 * @param block - The block holding the field.
 * @param key - Property name, parsed out of a field path.
 * @param value - Replacement text.
 * @param path - Full path, used only for the error message.
 * @throws If the block has no such property — a mistyped path would otherwise write a field
 *   that nothing reads back, and the edit would look like it silently did not save.
 */
function replaceField<TBlock extends object>(
  block: TBlock,
  key: string,
  value: string,
  path: string,
): TBlock {
  if (!(key in block)) {
    throw new Error(`No such field: ${path}`)
  }
  // Key membership was just checked, so the computed-key spread cannot widen `TBlock`.
  return { ...block, [key]: value } as TBlock
}

/**
 * Rebuilds a list with one item replaced.
 *
 * @param items - The list to copy.
 * @param itemId - Id of the item to replace.
 * @param replace - Produces the replacement from the existing item.
 * @param path - Full path, used only for the error message.
 * @throws If no item carries that id, which means the path outlived the thing it addressed.
 */
function replaceById<TItem extends { readonly id: string }>(
  items: readonly TItem[],
  itemId: string,
  replace: (item: TItem) => TItem,
  path: string,
): TItem[] {
  let found = false
  const next = items.map((item) => {
    if (item.id !== itemId) {
      return item
    }
    found = true
    return replace(item)
  })
  if (!found) {
    throw new Error(`No such item: ${path}`)
  }
  return next
}

/**
 * Answers the template's mechanism question.
 *
 * Answering "no" drops the POLICY block entirely rather than hiding it, so a case that later
 * flips back to "yes" starts that table clean instead of resurrecting half-written text from
 * a policy the debater already decided against.
 *
 * @param caseFile - The case being edited.
 * @param decision - The answer. `undecided` keeps or restores an empty policy block, because
 *   the completeness meter should nag about the unanswered question, not about the table.
 * @returns The updated case.
 */
export function setNeedsMechanism(caseFile: Case, decision: MechanismDecision): Case {
  return touched(caseFile, {
    prep: { ...caseFile.prep, needsMechanism: decision },
    policy: decision === 'no' ? null : (caseFile.policy ?? createPolicyBlock()),
  })
}

/**
 * Writes one field, addressed by the path `buildSections` produced for it.
 *
 * `prep.needsMechanism` is accepted and routed through `setNeedsMechanism`, so the tri-state
 * control does not need a separate code path in the editor.
 *
 * @param caseFile - The case being edited.
 * @param path - A field path, e.g. `substantives.<id>.whyBad`.
 * @param value - Replacement text. Not trimmed — trailing spaces are normal mid-typing, and
 *   the completeness check trims when it decides whether a field counts.
 * @returns The updated case.
 * @throws If the path names a block, item, or field that does not exist.
 */
export function setFieldByPath(caseFile: Case, path: string, value: string): Case {
  const [blockId, second, third, fourth] = path.split('.')

  switch (blockId) {
    case 'prep': {
      if (second === 'needsMechanism') {
        return setNeedsMechanism(caseFile, value as MechanismDecision)
      }
      if (second === 'fiveW1H' && third !== undefined) {
        return touched(caseFile, {
          prep: {
            ...caseFile.prep,
            fiveW1H: replaceField(caseFile.prep.fiveW1H, third, value, path),
          },
        })
      }
      if (second === 'pois' && third !== undefined && fourth !== undefined) {
        return touched(caseFile, {
          prep: {
            ...caseFile.prep,
            pois: replaceById(
              caseFile.prep.pois,
              third,
              (poi) => replaceField(poi, fourth, value, path),
              path,
            ),
          },
        })
      }
      if (second !== undefined) {
        return touched(caseFile, { prep: replaceField(caseFile.prep, second, value, path) })
      }
      break
    }

    case 'setup': {
      if (second === 'caseDivision' && third !== undefined) {
        return touched(caseFile, {
          setup: {
            ...caseFile.setup,
            caseDivision: replaceField(caseFile.setup.caseDivision, third, value, path),
          },
        })
      }
      if (second !== undefined) {
        return touched(caseFile, { setup: replaceField(caseFile.setup, second, value, path) })
      }
      break
    }

    case 'definition':
      if (second !== undefined) {
        return touched(caseFile, {
          definition: replaceField(caseFile.definition, second, value, path),
        })
      }
      break

    case 'policy':
      if (second !== undefined && caseFile.policy) {
        return touched(caseFile, { policy: replaceField(caseFile.policy, second, value, path) })
      }
      break

    case 'policyRebuttal':
      if (second !== undefined) {
        return touched(caseFile, {
          policyRebuttal: replaceField(caseFile.policyRebuttal, second, value, path),
        })
      }
      break

    case 'extension':
      if (second !== undefined && caseFile.extension) {
        return touched(caseFile, {
          extension: replaceField(caseFile.extension, second, value, path),
        })
      }
      break

    case 'substantives':
      if (second !== undefined && third !== undefined) {
        return touched(caseFile, {
          substantives: replaceById(
            caseFile.substantives,
            second,
            (substantive) => replaceField(substantive, third, value, path),
            path,
          ),
        })
      }
      break

    case 'rebuttals':
      if (second !== undefined && third !== undefined) {
        return touched(caseFile, {
          rebuttals: replaceById(
            caseFile.rebuttals,
            second,
            (rebuttal) => replaceField(rebuttal, third, value, path),
            path,
          ),
        })
      }
      break

    case 'opposingRebuttals':
      if (second !== undefined && third !== undefined) {
        return touched(caseFile, {
          opposingRebuttals: replaceById(
            caseFile.opposingRebuttals,
            second,
            (opposing) => replaceField(opposing, third, value, path),
            path,
          ),
        })
      }
      break

    case 'clashes':
      if (second !== undefined) {
        return touched(caseFile, {
          clashes: replaceById(
            caseFile.clashes,
            second,
            (clash) => setClashField(clash, path, value),
            path,
          ),
        })
      }
      break
  }

  throw new Error(`Unroutable field path: ${path}`)
}

/**
 * Writes one field inside a clash — its title, a signposted argument, or an engagement slot.
 *
 * Split out of `setFieldByPath` because the clash script nests three levels deep and the
 * switch above was already the widest thing in the file.
 *
 * @param clash - The clash the path resolved to.
 * @param path - The full field path, re-split here rather than threaded through as fragments.
 * @param value - Replacement text.
 * @returns The updated clash.
 * @throws If the path names something inside the clash that does not exist.
 */
function setClashField(clash: Clash, path: string, value: string): Clash {
  const [, , third, fourth, fifth, sixth] = path.split('.')

  if (third === 'title') {
    return { ...clash, title: value }
  }

  if (third === 'handledArguments' && fourth !== undefined && fifth !== undefined) {
    return {
      ...clash,
      handledArguments: replaceById(
        clash.handledArguments,
        fourth,
        (handled) => replaceField(handled, fifth, value, path),
        path,
      ),
    }
  }

  if (third === 'engagements' && fourth !== undefined && fifth !== undefined) {
    return {
      ...clash,
      engagements: replaceById(
        clash.engagements,
        fourth,
        (engagement) => {
          // A branch path has a sixth segment; anything shorter targets the engagement itself.
          if ((fifth === 'refused' || fifth === 'responded') && sixth !== undefined) {
            if (engagement.kind === 'overlap') {
              throw new Error(`Overlap engagements have no "(OR)" fork: ${path}`)
            }
            return {
              ...engagement,
              response: {
                ...engagement.response,
                [fifth]: replaceField(engagement.response[fifth], sixth, value, path),
              },
            }
          }
          return replaceField(engagement, fifth, value, path)
        },
        path,
      ),
    }
  }

  throw new Error(`Unroutable field path: ${path}`)
}

/**
 * Picks which side of an engagement's "(OR)" fork the whip will actually say.
 *
 * The unselected branch keeps whatever was typed into it — a whip who switches to "they
 * refused to respond" and back should not find their answer gone.
 *
 * @param caseFile - The case being edited.
 * @param clashId - Clash holding the engagement.
 * @param engagementId - Engagement to switch.
 * @param branch - Which continuation to render and compile.
 * @returns The updated case.
 * @throws If the engagement is an overlap variant, which has no fork.
 */
export function setEngagementBranch(
  caseFile: Case,
  clashId: string,
  engagementId: string,
  branch: OpponentResponseBranch,
): Case {
  return updateEngagement(caseFile, clashId, engagementId, (engagement) => {
    if (engagement.kind === 'overlap') {
      throw new Error('Overlap engagements have no "(OR)" fork')
    }
    return { ...engagement, response: { ...engagement.response, branch } }
  })
}

/**
 * Marks the engagement that carries the BP extension.
 *
 * The template writes the "Furthermore" paragraph two ways — plain, or "their argument is
 * tenuous, and this is my extension because" — so this flag is what phase 4 reads to pick the
 * wording. Setting it on one engagement does not clear it elsewhere; a closing team may well
 * push their extension through more than one clash.
 *
 * @param caseFile - The case being edited.
 * @param clashId - Clash holding the engagement.
 * @param engagementId - Engagement to flag.
 * @param isExtension - Whether this engagement carries the extension.
 * @returns The updated case.
 * @throws If the engagement is an overlap variant.
 */
export function setEngagementIsExtension(
  caseFile: Case,
  clashId: string,
  engagementId: string,
  isExtension: boolean,
): Case {
  return updateEngagement(caseFile, clashId, engagementId, (engagement) => {
    if (engagement.kind === 'overlap') {
      throw new Error('Overlap engagements carry no extension flag')
    }
    return {
      ...engagement,
      response: {
        ...engagement.response,
        responded: { ...engagement.response.responded, isExtension },
      },
    }
  })
}

/**
 * Applies a change to one engagement.
 *
 * @param caseFile - The case being edited.
 * @param clashId - Clash holding the engagement.
 * @param engagementId - Engagement to change.
 * @param replace - Produces the replacement engagement.
 * @returns The updated case.
 * @throws If either id does not resolve.
 */
function updateEngagement(
  caseFile: Case,
  clashId: string,
  engagementId: string,
  replace: (engagement: ClashEngagement) => ClashEngagement,
): Case {
  return touched(caseFile, {
    clashes: replaceById(
      caseFile.clashes,
      clashId,
      (clash) => ({
        ...clash,
        engagements: replaceById(clash.engagements, engagementId, replace, engagementId),
      }),
      clashId,
    ),
  })
}

/**
 * Builds an empty engagement of the requested kind.
 *
 * @param kind - Which of the template's three script skeletons to use.
 * @returns A fresh engagement.
 */
export function createEngagementOfKind(kind: ClashEngagement['kind']): ClashEngagement {
  switch (kind) {
    case 'their-argument':
      return createTheirArgumentEngagement()
    case 'our-argument':
      return createOurArgumentEngagement()
    case 'overlap':
      return createOverlapEngagement()
  }
}

// ---------------------------------------------------------------------------
// Adding and removing repeatable blocks
// ---------------------------------------------------------------------------

/** Appends an empty substantive. */
export function addSubstantive(caseFile: Case): Case {
  return touched(caseFile, { substantives: [...caseFile.substantives, createSubstantive()] })
}

/**
 * Drops one substantive.
 *
 * @param caseFile - The case being edited.
 * @param substantiveId - Which to remove. An unknown id is a no-op — the common cause is a
 *   double-click on delete, and throwing there would lose the whole edit.
 */
export function removeSubstantive(caseFile: Case, substantiveId: string): Case {
  return touched(caseFile, {
    substantives: caseFile.substantives.filter((item) => item.id !== substantiveId),
  })
}

/** Appends an empty REBUTTAL table. */
export function addRebuttal(caseFile: Case): Case {
  return touched(caseFile, { rebuttals: [...caseFile.rebuttals, createRebuttalBlock()] })
}

/**
 * Drops one REBUTTAL table.
 *
 * @param caseFile - The case being edited.
 * @param rebuttalId - Which to remove. An unknown id is a no-op.
 */
export function removeRebuttal(caseFile: Case, rebuttalId: string): Case {
  return touched(caseFile, {
    rebuttals: caseFile.rebuttals.filter((item) => item.id !== rebuttalId),
  })
}

/** Appends an empty OPPOSING TEAM REBUTTALS table. */
export function addOpposingRebuttal(caseFile: Case): Case {
  return touched(caseFile, {
    opposingRebuttals: [...caseFile.opposingRebuttals, createOpposingRebuttalBlock()],
  })
}

/**
 * Drops one OPPOSING TEAM REBUTTALS table.
 *
 * @param caseFile - The case being edited.
 * @param opposingId - Which to remove. An unknown id is a no-op.
 */
export function removeOpposingRebuttal(caseFile: Case, opposingId: string): Case {
  return touched(caseFile, {
    opposingRebuttals: caseFile.opposingRebuttals.filter((item) => item.id !== opposingId),
  })
}

/** Appends an empty POI to the prep sheet's list. */
export function addPointOfInformation(caseFile: Case): Case {
  return touched(caseFile, {
    prep: { ...caseFile.prep, pois: [...caseFile.prep.pois, createPointOfInformation()] },
  })
}

/**
 * Drops one POI.
 *
 * @param caseFile - The case being edited.
 * @param poiId - Which to remove. An unknown id is a no-op.
 */
export function removePointOfInformation(caseFile: Case, poiId: string): Case {
  return touched(caseFile, {
    prep: { ...caseFile.prep, pois: caseFile.prep.pois.filter((item) => item.id !== poiId) },
  })
}

/** Appends an empty clash. */
export function addClash(caseFile: Case): Case {
  return touched(caseFile, { clashes: [...caseFile.clashes, createClash()] })
}

/**
 * Drops one clash.
 *
 * @param caseFile - The case being edited.
 * @param clashId - Which to remove. An unknown id is a no-op.
 */
export function removeClash(caseFile: Case, clashId: string): Case {
  return touched(caseFile, { clashes: caseFile.clashes.filter((item) => item.id !== clashId) })
}

/**
 * Appends an engagement to a clash.
 *
 * @param caseFile - The case being edited.
 * @param clashId - Clash to append to.
 * @param kind - Which script skeleton the engagement follows.
 * @returns The updated case.
 * @throws If the clash id does not resolve.
 */
export function addEngagement(
  caseFile: Case,
  clashId: string,
  kind: ClashEngagement['kind'],
): Case {
  return touched(caseFile, {
    clashes: replaceById(
      caseFile.clashes,
      clashId,
      (clash) => ({ ...clash, engagements: [...clash.engagements, createEngagementOfKind(kind)] }),
      clashId,
    ),
  })
}

/**
 * Drops one engagement from a clash.
 *
 * @param caseFile - The case being edited.
 * @param clashId - Clash holding it.
 * @param engagementId - Which to remove. An unknown id is a no-op.
 * @returns The updated case.
 * @throws If the clash id does not resolve.
 */
export function removeEngagement(caseFile: Case, clashId: string, engagementId: string): Case {
  return touched(caseFile, {
    clashes: replaceById(
      caseFile.clashes,
      clashId,
      (clash) => ({
        ...clash,
        engagements: clash.engagements.filter((item) => item.id !== engagementId),
      }),
      clashId,
    ),
  })
}

/**
 * Appends a slot to a clash's signposting line.
 *
 * @param caseFile - The case being edited.
 * @param clashId - Clash to append to.
 * @param side - Whose argument the slot handles.
 * @returns The updated case.
 * @throws If the clash id does not resolve.
 */
export function addHandledArgument(caseFile: Case, clashId: string, side: Side): Case {
  return touched(caseFile, {
    clashes: replaceById(
      caseFile.clashes,
      clashId,
      (clash) => ({
        ...clash,
        handledArguments: [...clash.handledArguments, createHandledArgument(side)],
      }),
      clashId,
    ),
  })
}

/**
 * Drops one signposted argument.
 *
 * @param caseFile - The case being edited.
 * @param clashId - Clash holding it.
 * @param handledId - Which to remove. An unknown id is a no-op.
 * @returns The updated case.
 * @throws If the clash id does not resolve.
 */
export function removeHandledArgument(caseFile: Case, clashId: string, handledId: string): Case {
  return touched(caseFile, {
    clashes: replaceById(
      caseFile.clashes,
      clashId,
      (clash) => ({
        ...clash,
        handledArguments: clash.handledArguments.filter((item) => item.id !== handledId),
      }),
      clashId,
    ),
  })
}

/**
 * Switches which bench a signposted argument belongs to.
 *
 * @param caseFile - The case being edited.
 * @param clashId - Clash holding it.
 * @param handledId - Slot to switch.
 * @param side - The bench that ran the argument.
 * @returns The updated case.
 * @throws If either id does not resolve.
 */
export function setHandledArgumentSide(
  caseFile: Case,
  clashId: string,
  handledId: string,
  side: Side,
): Case {
  return touched(caseFile, {
    clashes: replaceById(
      caseFile.clashes,
      clashId,
      (clash) => ({
        ...clash,
        handledArguments: replaceById(
          clash.handledArguments,
          handledId,
          (handled) => ({ ...handled, side }),
          handledId,
        ),
      }),
      clashId,
    ),
  })
}

// ---------------------------------------------------------------------------
// Case-level settings
// ---------------------------------------------------------------------------

/**
 * Reassigns the seat this case is prepped for.
 *
 * Nothing already typed is discarded, even when the new seat does not use those blocks — a
 * debater reassigned from DPM to Whip mid-prep still wants their substantive text if they get
 * moved back. Blocks simply stop being rendered and stop counting.
 *
 * Seeds the new seat's blocks on the way through, so a debater moved to whip lands on a clash
 * they can type into rather than an empty screen.
 *
 * @param caseFile - The case being edited.
 * @param format - Format key.
 * @param side - Bench.
 * @param position - Role id from the format registry. Pass `''` to leave the seat unassigned;
 *   an id belonging to another format is stored as-is and simply seeds nothing.
 * @returns The updated case.
 */
export function setSeat(
  caseFile: Case,
  format: Case['format'],
  side: Side,
  position: string,
): Case {
  const reseated = touched(caseFile, { format, side, position })
  const role = getRole(format, position)
  return role ? ensureRequiredBlocks(reseated, role) : reseated
}

/**
 * Sets who may read the case.
 *
 * @param caseFile - The case being edited.
 * @param visibility - `private` keeps it off team sync entirely, including from phase 9's
 *   library. It does not encrypt anything.
 * @returns The updated case.
 */
export function setVisibility(caseFile: Case, visibility: Visibility): Case {
  return touched(caseFile, { visibility })
}

/**
 * Seeds the empty blocks a seat needs something to type into.
 *
 * `createEmptyCase` cannot do this, because it does not know the seat is a whip until the role
 * is chosen — and a whip opening a case to find no clash and no exchange has to click twice
 * before writing a word. Returns the case unchanged when nothing was missing, so the editor
 * can call it on open without dirtying a case that was already fine.
 *
 * @param caseFile - The case being opened.
 * @param role - The seat. Only blocks this role is asked to fill are seeded.
 * @returns The case, seeded if it needed it.
 */
export function ensureRequiredBlocks(caseFile: Case, role: SpeakerRole): Case {
  const changes: Partial<Case> = {}

  if (role.blocks.includes('substantives') && caseFile.substantives.length === 0) {
    changes.substantives = [createSubstantive()]
  }
  if (role.blocks.includes('rebuttals') && caseFile.rebuttals.length === 0) {
    changes.rebuttals = [createRebuttalBlock()]
  }
  if (role.blocks.includes('opposingRebuttals') && caseFile.opposingRebuttals.length === 0) {
    changes.opposingRebuttals = [createOpposingRebuttalBlock()]
  }

  // The template's script opens "I have two clashes for the house", so a whip gets both.
  // Each is seeded with one engagement and one signposted argument: a clash with neither is
  // a heading, and would score 100% complete off its title alone.
  if (role.blocks.includes('clashes')) {
    const seeded = caseFile.clashes.length === 0 ? [createClash(), createClash()] : caseFile.clashes
    const filled = seeded.map((clash) => ({
      ...clash,
      handledArguments:
        clash.handledArguments.length === 0
          ? [createHandledArgument(caseFile.side === 'gov' ? 'opp' : 'gov')]
          : clash.handledArguments,
      engagements:
        clash.engagements.length === 0 ? [createTheirArgumentEngagement()] : clash.engagements,
    }))
    if (filled.some((clash, index) => clash !== caseFile.clashes[index])) {
      changes.clashes = filled
    }
  }

  if (requiresExtension(role) && caseFile.extension === null) {
    changes.extension = createExtensionBlock()
  }

  return Object.keys(changes).length === 0 ? caseFile : touched(caseFile, changes)
}
