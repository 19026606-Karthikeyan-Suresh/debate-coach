/**
 * The script, with what has been said struck out of it.
 *
 * Four states on the page at once, and each one has to be readable at a glance from a metre
 * away: text still to come is at full contrast, text already said is dimmed out of the way,
 * a skipped word is struck through in red, and a run of improvisation shows as a count where it
 * happened. Everything is driven off `AlignmentState.tokens`, indexed by the same
 * `ScriptToken.index` the compiler assigned, so nothing here decides anything — it renders a
 * classification `align.ts` already made.
 *
 * **Scrolling follows the alignment, never a fixed rate.** A prompter that scrolls on a timer is
 * a prompter you race or wait for; this one moves when the segment under the cursor changes,
 * which is the segment the speaker is actually in. Segment granularity rather than word is
 * deliberate: a segment is one breath-group, and re-centring on every word turns the page into
 * a slot machine.
 */

import { useEffect } from 'react'

import type { AlignmentState } from '../../speech/align.ts'
import type { CompiledScript, ScriptSegment } from '../../script/types.ts'

/** Props for {@link Teleprompter}. */
export interface TeleprompterProps {
  readonly script: CompiledScript
  readonly alignment: AlignmentState
  /** True while recording. Off, nothing auto-scrolls and the whole script reads at full contrast. */
  readonly isLive: boolean
}

/** Improvised words, counted at the script position they were heard at. */
function countImprovisationsByPosition(alignment: AlignmentState): ReadonlyMap<number, number> {
  const counts = new Map<number, number>()
  for (const improvisation of alignment.improvisations) {
    counts.set(
      improvisation.beforeScriptIndex,
      (counts.get(improvisation.beforeScriptIndex) ?? 0) + 1,
    )
  }
  return counts
}

/** Tailwind class for one script word's state. */
function statusClass(status: string | undefined, isLive: boolean): string {
  if (!isLive) {
    return 'prompter-pending'
  }
  switch (status) {
    case 'spoken':
      return 'prompter-spoken'
    case 'skipped':
      return 'prompter-skipped'
    default:
      return 'prompter-pending'
  }
}

/** The segment holding the cursor, or the last one once the speech has run past the end. */
function activeSegmentId(script: CompiledScript, cursor: number): string | null {
  for (const segment of script.segments) {
    const last = segment.tokens.at(-1)
    if (last && cursor <= last.index) {
      return segment.id
    }
  }
  return script.segments.at(-1)?.id ?? null
}

/**
 * One paragraph of script.
 *
 * Renders the segment's own text rather than the token list joined by spaces: the tokens carry
 * offsets into that text, so the punctuation and spacing between them survive exactly as the
 * compiler assembled it. Joining tokens instead would silently normalise "damage. What" into
 * "damage. What" on a good day and "damage.What" on a bad one.
 */
function SegmentBody({
  segment,
  alignment,
  isLive,
  improvisations,
}: {
  segment: ScriptSegment
  alignment: AlignmentState
  isLive: boolean
  improvisations: ReadonlyMap<number, number>
}): React.JSX.Element {
  const pieces: React.JSX.Element[] = []
  // End of the previous token within `segment.text`, so the gap before the next one can be
  // emitted verbatim.
  let cursorInText = 0

  for (const token of segment.tokens) {
    if (token.start > cursorInText) {
      pieces.push(
        <span key={`gap-${String(token.index)}`}>
          {segment.text.slice(cursorInText, token.start)}
        </span>,
      )
    }

    const improvisedHere = isLive ? (improvisations.get(token.index) ?? 0) : 0
    if (improvisedHere > 0) {
      pieces.push(
        <span
          key={`improvised-${String(token.index)}`}
          className="prompter-improvised"
          title={`${String(improvisedHere)} word(s) said here that are not in the script`}
        >
          +{improvisedHere}
        </span>,
      )
    }

    pieces.push(
      <span
        key={`token-${String(token.index)}`}
        className={statusClass(alignment.tokens[token.index]?.status, isLive)}
      >
        {segment.text.slice(token.start, token.end)}
      </span>,
    )
    cursorInText = token.end
  }

  if (cursorInText < segment.text.length) {
    pieces.push(<span key="gap-tail">{segment.text.slice(cursorInText)}</span>)
  }

  return <p className="prompter">{pieces}</p>
}

/**
 * Renders the compiled script and follows the speaker through it.
 *
 * @param props - See {@link TeleprompterProps}.
 * @param props.script - The compiled speech. Its `tokens` must be the same list the alignment
 *   was created from, or every word is coloured by another word's fate.
 * @param props.alignment - What has been said so far.
 * @param props.isLive - Whether to colour and follow, or just show the script.
 * @returns The scrolling script.
 */
export function Teleprompter({ script, alignment, isLive }: TeleprompterProps): React.JSX.Element {
  const improvisations = countImprovisationsByPosition(alignment)
  const activeId = isLive ? activeSegmentId(script, alignment.cursor) : null

  // `behavior: 'auto'`, and the 'smooth' that reads better here is a trap. Smooth scrolling is
  // driven by the compositor, so in a window that is not compositing — minimised, occluded,
  // backgrounded because someone alt-tabbed to their notes — the animation never advances and
  // `scrollTop` stays exactly where it was. The prompter silently stops following the speaker at
  // the precise moment they are least able to notice. Measured: smooth left the scroller at 0
  // with the active segment 1477 px below the fold; auto put it dead centre.
  //
  // Same failure family as the phase 3 `requestAnimationFrame` bug, and the same conclusion —
  // in this app, anything that needs a frame to be painted before it takes effect is a bug.
  useEffect(() => {
    if (activeId === null) {
      return
    }
    document
      .getElementById(`prompter-${activeId}`)
      ?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [activeId])

  if (script.segments.length === 0) {
    return (
      <p className="p-8 text-sm text-neutral-500 dark:text-neutral-400">
        Nothing to deliver yet — this seat&rsquo;s sections are still empty. Fill the case and the
        script compiles itself.
      </p>
    )
  }

  // `dvh`, not `vh`: iOS Safari's `vh` is the viewport with the URL bar *hidden*, so the padding
  // that centres the active line is a toolbar's height too tall until the bar collapses — and it
  // collapses mid-speech, moving the line the speaker is reading.
  return (
    <div className="mx-auto max-w-3xl px-4 py-[40dvh] sm:px-6">
      {script.segments.map((segment) => (
        <section
          key={segment.id}
          id={`prompter-${segment.id}`}
          className={`prompter-segment ${segment.id === activeId ? 'prompter-segment-active' : ''}`}
        >
          {segment.heading ? <h3 className="prompter-heading">{segment.heading}</h3> : null}
          <SegmentBody
            segment={segment}
            alignment={alignment}
            isLive={isLive}
            improvisations={improvisations}
          />
        </section>
      ))}
    </div>
  )
}
