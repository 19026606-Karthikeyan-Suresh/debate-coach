/**
 * The aligner — where the script the debater wrote meets the words they actually said.
 *
 * This is the piece that fixes the third problem the app exists for. It takes the compiled
 * script's words and a transcript that grows while the speech runs, and says of every script
 * word: said it, skipped it, or not there yet. Everything the speaker adds that is not in the
 * script comes back as an improvisation.
 *
 * **Three passes, run on every advance:**
 *
 *   1. Normalize both sides — the committed prefix is reused, only the live tail is redone.
 *   2. Align a window of the script against the uncommitted transcript with a Needleman–Wunsch
 *      DP. Trailing script gaps are free, because the rest of the speech is *pending*, not
 *      skipped, and charging for it would drag the alignment forward to consume it.
 *   3. Classify, then commit the part that is not going to change and freeze it.
 *
 * **Re-anchoring is pass 2 done twice.** When the window explains too little of what was said,
 * the speaker is somewhere else — they jumped to another substantive, restarted a sentence,
 * came back from a POI. The second attempt widens the script window and makes *leading* script
 * gaps free too, which lets the alignment start anywhere ahead of the anchor. What it jumped
 * over is then genuinely skipped, and gets marked so.
 *
 * **Why there is no substitution.** A DP over words usually allows a mismatched pair at a
 * penalty. Here it must not: "you said a different word here" is not something this tool can
 * act on, while "you skipped this and added that" is exactly what the report shows. A word the
 * speaker got wrong therefore comes out as one skip next to one improvisation, which is both
 * true and useful. Matching is only ever `exact` or `near` — `normalize.ts` owns that decision.
 *
 * Pure: no DOM, no timers, no async. Every state transition returns a new state.
 */

import type { MatchTier, NormalizedToken } from './normalize.ts'
import { matchRuns, normalizeToken } from './normalize.ts'

/** What has become of one script word. */
export type TokenStatus = 'pending' | 'spoken' | 'skipped'

/** One script word, and what happened to it. */
export interface AlignedToken {
  /** Index into the script word list — the same index as `CompiledScript.tokens`. */
  readonly scriptIndex: number
  readonly status: TokenStatus
  /** How it matched. Null when skipped or still pending. */
  readonly tier: MatchTier | null
  /** First transcript word that matched it, or null. */
  readonly spokenIndex: number | null
}

/** Something the speaker said that is not in the script. */
export interface Improvisation {
  readonly spokenIndex: number
  readonly text: string
  /** Script position it was heard at, so the report can show it in place. */
  readonly beforeScriptIndex: number
}

/** How the aligner is tuned. Every default is stated where it is defined. */
export interface AlignmentOptions {
  /** Script words considered per advance. Roughly a minute of speech at pace. */
  readonly scriptWindow: number
  /** Script words considered when re-anchoring. Large enough to find another substantive. */
  readonly reAnchorWindow: number
  /** Transcript words kept live before a commit is forced. */
  readonly spokenWindow: number
  /** Decided words kept revisable behind the last confident match. */
  readonly commitMargin: number
  /** Unexplained words at the end of the transcript before the search widens. */
  readonly reAnchorMinSpoken: number
}

/**
 * Defaults.
 *
 * `scriptWindow` at 160 is about a minute of delivery, which is far more slack than a speaker
 * reading from a prompter ever needs and still small enough that the DP is free. `commitMargin`
 * at 24 is the one worth understanding: whisper revises the tail of its transcript, so a
 * classification is only frozen once 24 further words have been decided behind it. Freeze
 * sooner and a revision arrives too late to correct a wrong red strike-through.
 */
export const DEFAULT_ALIGNMENT_OPTIONS: AlignmentOptions = {
  scriptWindow: 160,
  reAnchorWindow: 900,
  spokenWindow: 200,
  commitMargin: 24,
  reAnchorMinSpoken: 12,
}

/** Everything the aligner carries between advances. */
export interface AlignmentState {
  readonly options: AlignmentOptions
  readonly script: readonly NormalizedToken[]
  readonly spoken: readonly NormalizedToken[]
  /** One entry per script word, in script order. */
  readonly tokens: readonly AlignedToken[]
  readonly improvisations: readonly Improvisation[]
  /**
   * First script word not yet accounted for — what the teleprompter scrolls to.
   *
   * Everything before it is spoken or skipped; everything from it on is pending.
   */
  readonly cursor: number
  /** Script words before this are frozen and will not be revised. */
  readonly anchorScript: number
  /** Transcript words before this are frozen. */
  readonly anchorSpoken: number
  /** True when the last advance had to widen its search to find the speaker. */
  readonly reAnchored: boolean
}

// A match is worth more than the two gaps it replaces, so the DP always prefers explaining a
// word to dropping it. `near` still beats skip-plus-improvise, which is the point of the tier:
// a mis-transcribed word is a word that was said.
const TIER_SCORE: Readonly<Record<Exclude<MatchTier, 'none'>, number>> = { exact: 2, near: 1 }
const SKIP_SCORE = -1
const IMPROVISE_SCORE = -1

/**
 * Run lengths a single match may span.
 *
 * `(1,1)` is an ordinary word. `(1,2)` and `(1,3)` are one written word transcribed as several
 * — "misinformation" heard as "miss information", "2016" said as "twenty sixteen". `(2,1)` and
 * `(3,1)` are the reverse. Nothing wider than one on both sides at once: two written words
 * becoming two different words is a substitution, and this aligner does not do those.
 */
const MATCH_SHAPES: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, 2],
  [1, 3],
  [2, 1],
  [3, 1],
]

/** One step of the traceback. A gap has a zero on the side it does not consume. */
interface AlignmentOp {
  readonly scriptRun: number
  readonly spokenRun: number
  readonly tier: MatchTier | null
}

/** Where a cell was reached from, so the traceback can walk back out. */
interface Origin {
  readonly scriptRun: number
  readonly spokenRun: number
  readonly tier: MatchTier | null
}

/**
 * Starts an alignment against a script.
 *
 * @param scriptWords - The script's words in delivery order, normally
 *   `compiled.tokens.map((token) => token.text)`. Indices in the result point back into this
 *   list, so passing a filtered list silently misaddresses every finding.
 * @param options - Tuning overrides; anything omitted comes from `DEFAULT_ALIGNMENT_OPTIONS`.
 * @returns A state with every script word pending and nothing spoken.
 */
export function createAlignment(
  scriptWords: readonly string[],
  options: Partial<AlignmentOptions> = {},
): AlignmentState {
  const script = scriptWords.map(normalizeToken)
  return {
    options: { ...DEFAULT_ALIGNMENT_OPTIONS, ...options },
    script,
    spoken: [],
    tokens: script.map((_token, scriptIndex) => pendingToken(scriptIndex)),
    improvisations: [],
    cursor: 0,
    anchorScript: 0,
    anchorSpoken: 0,
    reAnchored: false,
  }
}

/** A script word nobody has reached yet. */
function pendingToken(scriptIndex: number): AlignedToken {
  return { scriptIndex, status: 'pending', tier: null, spokenIndex: null }
}

/**
 * Re-aligns against the transcript as it now stands.
 *
 * Takes the **whole** transcript rather than only what is new, because whisper revises: the tail
 * of a partial transcript changes as more audio arrives, and a caller that could only append
 * would have to decide what to do about that on its own. Words before `anchorSpoken` are already
 * frozen and are not re-read, so passing the full list every time costs nothing.
 *
 * @param state - The state to advance.
 * @param transcript - Every word transcribed so far, in order. A shorter list than last time is
 *   treated as a revision and the uncommitted tail is simply recomputed.
 * @returns A new state. The input is not modified.
 */
export function advanceAlignment(
  state: AlignmentState,
  transcript: readonly string[],
): AlignmentState {
  const { options } = state

  // Only the live tail is re-normalized; the frozen prefix keeps the tokens it already had.
  const frozenSpoken = state.spoken.slice(0, Math.min(state.anchorSpoken, transcript.length))
  const spoken = [
    ...frozenSpoken,
    ...transcript.slice(frozenSpoken.length).map(normalizeToken),
  ]

  const scriptWindow = state.script.slice(
    state.anchorScript,
    state.anchorScript + options.scriptWindow,
  )
  const spokenWindow = spoken.slice(state.anchorSpoken)

  if (spokenWindow.length === 0) {
    return { ...state, spoken, reAnchored: false }
  }

  let ops = align(scriptWindow, spokenWindow, false)
  let reAnchored = false

  // A long run of speech at the end that the window could not explain means the speaker is not
  // where we think. Only that run is re-aligned, against a much wider slice of the script.
  //
  // Re-running the *whole* window with free leading gaps is the obvious thing to do and it is
  // wrong: a free leading gap is cheaper than keeping the matches already found, so the DP
  // discards the confirmed prefix and calls twenty correctly-spoken words improvised. Freezing
  // the prefix first is what stops that, and it is also what re-anchoring actually means —
  // "these last words are not here, where are they?"
  const tail = unexplainedTail(ops)
  if (spokenWindow.length - tail.spokenPos >= options.reAnchorMinSpoken) {
    const from = state.anchorScript + tail.scriptPos
    const wideWindow = state.script.slice(from, from + options.reAnchorWindow)
    const tailOps = align(wideWindow, spokenWindow.slice(tail.spokenPos), true)
    if (matchedSpokenCount(tailOps) > matchedSpokenCount(ops.slice(tail.opIndex))) {
      ops = [...ops.slice(0, tail.opIndex), ...tailOps]
      reAnchored = true
    }
  }

  return applyOps(state, spoken, ops, reAnchored)
}

/** Where the traceback stops explaining anything — the first op past the last match. */
interface UnexplainedTail {
  readonly opIndex: number
  readonly scriptPos: number
  readonly spokenPos: number
}

/**
 * Finds the point after the last match, which is where a jump would have started.
 *
 * Only forward jumps are searched for. A speaker who goes back to an earlier substantive is
 * left as improvisation, because searching backwards would let the aligner re-match material it
 * has already marked spoken and quietly erase a real skip.
 */
function unexplainedTail(ops: readonly AlignmentOp[]): UnexplainedTail {
  let scriptPos = 0
  let spokenPos = 0
  let tail: UnexplainedTail = { opIndex: 0, scriptPos: 0, spokenPos: 0 }

  for (const [opIndex, operation] of ops.entries()) {
    scriptPos += operation.scriptRun
    spokenPos += operation.spokenRun
    if (operation.tier !== null) {
      tail = { opIndex: opIndex + 1, scriptPos, spokenPos }
    }
  }
  return tail
}

/**
 * Aligns a script window against a transcript window.
 *
 * Both ends are deliberately asymmetric. Leading transcript gaps cost, because words said
 * before the first match really were improvised. Trailing script gaps are free, because the
 * script that has not been reached yet is pending rather than skipped — the alignment simply
 * stops where the speaker has got to.
 *
 * @param script - The script window.
 * @param spoken - The transcript window. Every word of it is consumed; it was said, so it has
 *   to be classified as either matched or improvised.
 * @param freeLeadingScriptGap - True on the re-anchor pass, which lets the alignment begin part
 *   way down the window and mark everything it jumped as skipped at no cost.
 * @returns The traceback, in delivery order.
 */
function align(
  script: readonly NormalizedToken[],
  spoken: readonly NormalizedToken[],
  freeLeadingScriptGap: boolean,
): readonly AlignmentOp[] {
  const scriptCount = script.length
  const spokenCount = spoken.length
  const width = spokenCount + 1

  const score = new Float64Array((scriptCount + 1) * width)
  const origin: (Origin | null)[] = new Array<Origin | null>((scriptCount + 1) * width).fill(null)

  for (let scriptPos = 1; scriptPos <= scriptCount; scriptPos += 1) {
    score[scriptPos * width] = freeLeadingScriptGap ? 0 : scriptPos * SKIP_SCORE
    origin[scriptPos * width] = { scriptRun: 1, spokenRun: 0, tier: null }
  }
  for (let spokenPos = 1; spokenPos <= spokenCount; spokenPos += 1) {
    score[spokenPos] = spokenPos * IMPROVISE_SCORE
    origin[spokenPos] = { scriptRun: 0, spokenRun: 1, tier: null }
  }

  for (let scriptPos = 1; scriptPos <= scriptCount; scriptPos += 1) {
    for (let spokenPos = 1; spokenPos <= spokenCount; spokenPos += 1) {
      const cell = scriptPos * width + spokenPos
      let best = (score[cell - width] ?? 0) + SKIP_SCORE
      let bestOrigin: Origin = { scriptRun: 1, spokenRun: 0, tier: null }

      const improvised = (score[cell - 1] ?? 0) + IMPROVISE_SCORE
      if (improvised > best) {
        best = improvised
        bestOrigin = { scriptRun: 0, spokenRun: 1, tier: null }
      }

      for (const [scriptRun, spokenRun] of MATCH_SHAPES) {
        if (scriptPos < scriptRun || spokenPos < spokenRun) {
          continue
        }
        const tier = matchRuns(
          script.slice(scriptPos - scriptRun, scriptPos),
          spoken.slice(spokenPos - spokenRun, spokenPos),
        )
        if (tier === 'none') {
          continue
        }
        const candidate =
          (score[(scriptPos - scriptRun) * width + (spokenPos - spokenRun)] ?? 0) +
          TIER_SCORE[tier] * Math.max(scriptRun, spokenRun)
        if (candidate > best) {
          best = candidate
          bestOrigin = { scriptRun, spokenRun, tier }
        }
        // A plain word-for-word match is never improved on by pretending two words are one, and
        // skipping the wider shapes here is most of the DP's cost on ordinary delivery.
        if (tier === 'exact' && scriptRun === 1 && spokenRun === 1) {
          break
        }
      }

      score[cell] = best
      origin[cell] = bestOrigin
    }
  }

  // Every transcript word must be consumed, but the script may stop short — so the answer is the
  // best cell in the last column, not the bottom-right corner.
  let endScript = 0
  let bestScore = score[spokenCount] ?? 0
  for (let scriptPos = 1; scriptPos <= scriptCount; scriptPos += 1) {
    const candidate = score[scriptPos * width + spokenCount] ?? 0
    if (candidate > bestScore) {
      bestScore = candidate
      endScript = scriptPos
    }
  }

  const ops: AlignmentOp[] = []
  let scriptPos = endScript
  let spokenPos = spokenCount
  while (scriptPos > 0 || spokenPos > 0) {
    const step = origin[scriptPos * width + spokenPos]
    if (!step) {
      break
    }
    ops.push({ scriptRun: step.scriptRun, spokenRun: step.spokenRun, tier: step.tier })
    scriptPos -= step.scriptRun
    spokenPos -= step.spokenRun
  }
  return ops.reverse()
}

/** Transcript words explained by a match rather than left as improvisation. */
function matchedSpokenCount(ops: readonly AlignmentOp[]): number {
  let matched = 0
  for (const operation of ops) {
    if (operation.tier !== null) {
      matched += operation.spokenRun
    }
  }
  return matched
}

/** A point in the traceback where both sides can be cut cleanly. */
interface Boundary {
  readonly scriptPos: number
  readonly spokenPos: number
}

/**
 * Turns a traceback into classifications, then freezes the part that will not change again.
 *
 * The commit point is the last boundary far enough behind the last *exact* match to be safe —
 * `commitMargin` words behind it. A near match is not good enough to commit on: it is the tier
 * that absorbs transcription error, and transcription error is exactly what a later revision
 * comes back to fix.
 */
function applyOps(
  state: AlignmentState,
  spoken: readonly NormalizedToken[],
  ops: readonly AlignmentOp[],
  reAnchored: boolean,
): AlignmentState {
  const { options } = state
  const tokens = [...state.tokens]
  const improvisations = state.improvisations.filter(
    (item) => item.spokenIndex < state.anchorSpoken,
  )

  let scriptPos = state.anchorScript
  let spokenPos = state.anchorSpoken
  const boundaries: Boundary[] = [{ scriptPos, spokenPos }]
  // End of the last match confident enough to freeze behind.
  let lastExactScript = -1

  for (const operation of ops) {
    if (operation.tier !== null) {
      for (let offset = 0; offset < operation.scriptRun; offset += 1) {
        tokens[scriptPos + offset] = {
          scriptIndex: scriptPos + offset,
          status: 'spoken',
          tier: operation.tier,
          spokenIndex: spokenPos,
        }
      }
      if (operation.tier === 'exact') {
        lastExactScript = scriptPos + operation.scriptRun
      }
    } else if (operation.scriptRun > 0) {
      for (let offset = 0; offset < operation.scriptRun; offset += 1) {
        tokens[scriptPos + offset] = {
          scriptIndex: scriptPos + offset,
          status: 'skipped',
          tier: null,
          spokenIndex: null,
        }
      }
    } else {
      for (let offset = 0; offset < operation.spokenRun; offset += 1) {
        improvisations.push({
          spokenIndex: spokenPos + offset,
          text: spoken[spokenPos + offset]?.text ?? '',
          beforeScriptIndex: scriptPos,
        })
      }
    }

    scriptPos += operation.scriptRun
    spokenPos += operation.spokenRun
    boundaries.push({ scriptPos, spokenPos })
  }

  // Anything the alignment did not reach is pending again, which is what undoes a strike-through
  // that a revision has just disproved.
  for (let index = scriptPos; index < tokens.length; index += 1) {
    tokens[index] = pendingToken(index)
  }

  const commit = chooseCommit(boundaries, lastExactScript, spoken.length, options)

  return {
    ...state,
    spoken,
    tokens,
    improvisations,
    cursor: scriptPos,
    anchorScript: commit.scriptPos,
    anchorSpoken: commit.spokenPos,
    reAnchored,
  }
}

/**
 * Picks how far it is safe to freeze.
 *
 * Two reasons to commit, and the second is a backstop rather than a goal: enough decided words
 * sit behind a confident match, or the live transcript has grown past `spokenWindow` and the DP
 * would otherwise keep widening for the rest of the speech. The backstop matters on a speaker
 * who has gone badly off script — nothing matches, so nothing would ever commit.
 */
function chooseCommit(
  boundaries: readonly Boundary[],
  lastExactScript: number,
  spokenLength: number,
  options: AlignmentOptions,
): Boundary {
  let chosen = boundaries[0] ?? { scriptPos: 0, spokenPos: 0 }

  if (lastExactScript >= 0) {
    const safeScript = lastExactScript - options.commitMargin
    const safeSpoken = spokenLength - options.commitMargin
    for (const boundary of boundaries) {
      if (boundary.scriptPos <= safeScript && boundary.spokenPos <= safeSpoken) {
        chosen = boundary
      }
    }
  }

  // Backstop: the live transcript has outgrown the window, so something has to be frozen even
  // though nothing matched. Without this a speaker who abandons the script entirely makes the
  // DP widen for the rest of the speech.
  const forcedSpoken = spokenLength - options.spokenWindow
  if (chosen.spokenPos < forcedSpoken) {
    for (const boundary of boundaries) {
      if (boundary.spokenPos <= forcedSpoken && boundary.spokenPos > chosen.spokenPos) {
        chosen = boundary
      }
    }
  }

  return chosen
}

/**
 * Words of transcript fed per advance when replaying a finished speech.
 *
 * Roughly seven seconds of delivery, which is a few whisper ticks' worth — close enough to the
 * live path that a replay and a live run reach the same classifications, and far enough under
 * `scriptWindow` that no advance can present more new speech than the window can absorb.
 */
const REPLAY_CHUNK_WORDS = 20

/**
 * Aligns a whole transcript, as if it had been delivered.
 *
 * **Advances in chunks rather than handing over everything at once, and that is not an
 * optimisation.** `scriptWindow` bounds how far ahead of the anchor one advance can look, so a
 * single call against a full-length speech can only ever reach the first 160 script words —
 * the other nine hundred come back skipped and the whole transcript comes back improvised. The
 * anchor only moves when a commit is taken, and a commit only happens on an advance, so the
 * script is walked by advancing repeatedly. That is exactly what the live path does; this
 * replays it.
 *
 * Used by the report, which re-runs alignment against the accurate `small.en` transcript once
 * the speech is over, and by tests.
 *
 * @param scriptWords - The script's words in delivery order.
 * @param transcript - Every word said, in order.
 * @param options - Tuning overrides.
 * @returns The final state, identical to what streaming the same words live would have produced.
 */
export function alignSpeech(
  scriptWords: readonly string[],
  transcript: readonly string[],
  options: Partial<AlignmentOptions> = {},
): AlignmentState {
  let state = createAlignment(scriptWords, options)
  for (let spoken = 0; spoken < transcript.length; spoken += REPLAY_CHUNK_WORDS) {
    // The whole transcript so far, every time — `advanceAlignment` takes the full list by
    // contract and re-reads only what it has not frozen.
    state = advanceAlignment(state, transcript.slice(0, spoken + REPLAY_CHUNK_WORDS))
  }
  return transcript.length === 0 ? advanceAlignment(state, transcript) : state
}

/**
 * Script words at a given status.
 *
 * @param state - The alignment to read.
 * @param status - Which classification to collect.
 * @returns The matching entries, in script order.
 */
export function tokensWithStatus(
  state: AlignmentState,
  status: TokenStatus,
): readonly AlignedToken[] {
  return state.tokens.filter((token) => token.status === status)
}

/**
 * Share of the script reached so far that was actually said.
 *
 * @param state - The alignment to measure. Pending words are excluded from both halves, so the
 *   number does not start at zero and climb — it means "of what you have got through".
 * @returns 0 to 1, and 1 before anything has been said.
 */
export function skipRate(state: AlignmentState): number {
  let spokenCount = 0
  let skippedCount = 0
  for (const token of state.tokens) {
    if (token.status === 'spoken') {
      spokenCount += 1
    } else if (token.status === 'skipped') {
      skippedCount += 1
    }
  }
  const reached = spokenCount + skippedCount
  return reached === 0 ? 0 : skippedCount / reached
}
