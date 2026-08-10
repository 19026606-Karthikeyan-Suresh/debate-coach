/**
 * The motion, kept on screen.
 *
 * It is one field on the prep sheet, which means it scrolls out of sight the moment somebody
 * opens Sub 2 — and it is the one sentence every other row has to answer to. A substantive
 * written against a half-remembered motion is the expensive kind of mistake, and it is made
 * quietly. So the motion sits above the work on both case screens rather than in it.
 *
 * Sticky rather than fixed: it belongs to the scrolling column, so it stays put while the
 * sections move under it and does not have to know the width of the rails either side of it.
 * On the Speak screen the teleprompter centres the active line, so a bar at the top cannot
 * cover the words being read.
 */

/** Props for {@link MotionBar}. */
export interface MotionBarProps {
  /** The motion, as typed. Empty is normal early in prep and is shown as a prompt, not blank. */
  readonly motion: string
  /**
   * Jumps to the motion field. Omit on screens with no editor behind them — the Speak screen
   * passes nothing, and the bar renders as plain text rather than as a button that does nothing.
   */
  readonly onEdit?: (() => void) | undefined
  /**
   * Where the bar sits relative to the scrolling content.
   *
   * `sticky` (default) belongs *inside* the scrolling column and pins itself as the content
   * moves under it — right for Prep, where nothing scrolls except the reader.
   *
   * `block` is a plain row for a caller that has already put the bar **outside** the scroller.
   * The Speak screen uses it, because the teleprompter drives its own `scrollIntoView` and a bar
   * overlaying the top of that container is a thing that can cover the line being read. Taking
   * it out of the container removes the question rather than answering it — and that geometry
   * is not measurable in a browser pane locked to 263 px of height.
   */
  readonly placement?: 'sticky' | 'block'
}

/**
 * Renders the motion above the work.
 *
 * @param props - See {@link MotionBarProps}.
 * @param props.motion - The motion text.
 * @param props.onEdit - Optional jump to the field.
 * @param props.placement - `sticky` inside a scroller, or `block` when the caller has already
 *   put the bar outside one.
 * @returns The bar.
 */
export function MotionBar({
  motion,
  onEdit,
  placement = 'sticky',
}: MotionBarProps): React.JSX.Element {
  const trimmed = motion.trim()
  const hasMotion = trimmed.length > 0

  const body = (
    <>
      <span className="section-heading shrink-0">Motion</span>
      <span
        className={
          hasMotion
            ? 'text-sm leading-snug text-neutral-900 dark:text-neutral-100'
            : 'text-sm text-neutral-400 italic dark:text-neutral-500'
        }
      >
        {hasMotion ? trimmed : 'Not written yet'}
      </span>
    </>
  )

  const common =
    'flex items-baseline gap-3 border-b border-neutral-200 bg-neutral-50 px-6 py-3 dark:border-neutral-800 dark:bg-neutral-950'

  // `sticky top-0` pins it inside the scrolling column; the negative margins let it span that
  // column's padding, or text scrolls visibly through the gap at either side. `block` needs
  // neither, because the caller has placed it outside the scroller already.
  const shell =
    placement === 'sticky' ? `sticky top-0 z-10 -mx-6 -mt-6 mb-5 ${common}` : common

  if (!onEdit) {
    return <div className={shell}>{body}</div>
  }

  return (
    <button
      type="button"
      className={`${shell} text-left ${placement === 'sticky' ? 'w-[calc(100%+3rem)]' : 'w-full'}`}
      onClick={onEdit}
    >
      {body}
    </button>
  )
}
