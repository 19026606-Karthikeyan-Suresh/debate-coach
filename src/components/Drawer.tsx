/**
 * A pane that is a column on a wide screen and a slide-over on a narrow one.
 *
 * The Prep screen is three panes and the Speak screen is two; below their breakpoint the extra
 * ones live in here, behind a button.
 *
 * **One element, and the breakpoint is entirely CSS.** The obvious build is a `useMediaQuery` hook
 * choosing between a `<aside>` and a modal — and it was built that way first, and it was wrong. The
 * layout then depends on a `matchMedia` change event firing, which makes an iPad rotating from
 * portrait to landscape a layout update rather than a repaint: measured at 1280px after a resize,
 * the CSS grid had gone to three columns while React still believed it was narrow, leaving an empty
 * 304px column, no rail in it, and the phone's top bar across the top of a desktop. Anything the
 * browser can decide from the viewport alone should be decided in CSS, where there is no event to
 * miss.
 *
 * So `isOpen` is the only thing React owns, and it only means anything below the breakpoint —
 * above it the pane is a static grid child whatever the state says.
 *
 * **There is no slide-in animation**, which is also measured rather than stylistic. A `from`-only
 * keyframe looks like it cannot get stuck, since the end state is the element's own position. But
 * `from` applies at time zero and in a window that is not compositing the animation clock never
 * advances: `playState: "running"`, `currentTime: 0`, six hundred milliseconds later, holding
 * `translateX(-100%)` — open according to React, off-screen according to the screen. Same rule as
 * the teleprompter's active highlight: presence is state, and state may not be expressed in
 * anything the compositor has to run.
 */

import { useEffect } from 'react'

/** Which edge the pane sits on when it is a slide-over. */
export type DrawerSide = 'left' | 'right'

/** The width at which the pane stops being a slide-over and becomes a column. */
export type DrawerBreakpoint = 'md' | 'lg'

// Tailwind only sees class names it can find as literal strings, so the two variants are spelled
// out rather than interpolated. `static` undoes `fixed`, and the display utility undoes `hidden`.
const AS_COLUMN: Readonly<Record<DrawerBreakpoint, string>> = {
  md: 'md:static md:z-auto md:w-auto md:flex md:shadow-none',
  lg: 'lg:static lg:z-auto lg:w-auto lg:flex lg:shadow-none',
}

/** Hides the backdrop and the pane's own close header once it is a column. */
const ONLY_NARROW: Readonly<Record<DrawerBreakpoint, string>> = {
  md: 'md:hidden',
  lg: 'lg:hidden',
}

/** What a drawer needs to render itself. */
export interface DrawerProps {
  /** Only consulted below {@link DrawerProps.columnFrom}; above it the pane is always a column. */
  readonly isOpen: boolean
  readonly side: DrawerSide
  /** Where it becomes a column. Must match the parent grid's breakpoint or the two disagree. */
  readonly columnFrom: DrawerBreakpoint
  /** Shown in the slide-over's header and used as its accessible name. */
  readonly title: string
  /** Called by the backdrop, the close button, and Escape. */
  readonly onClose: () => void
  /**
   * Classes for the wrapper around {@link DrawerProps.children}. The section nav brings its own
   * padding and scrolling and wants none; the right rails want a padded stack.
   */
  readonly contentClassName?: string
  readonly children: React.ReactNode
}

/**
 * Renders the pane, as a column or as a slide-over depending only on the viewport.
 *
 * @param props - See {@link DrawerProps}.
 * @param props.isOpen - Whether the slide-over is showing. Ignored once it is a column.
 * @param props.side - Which edge it comes from while it is a slide-over.
 * @param props.columnFrom - The breakpoint at which it becomes a column.
 * @param props.title - Accessible name, shown in the slide-over header.
 * @param props.onClose - Invoked on backdrop click, the close button, and Escape.
 * @param props.contentClassName - Overrides the padded stack around the children.
 * @param props.children - The pane's contents. Mounted at every width, so they hold their state
 *   across a rotation rather than being torn down and rebuilt.
 * @returns The pane, and a backdrop when it is open and narrow.
 */
export function Drawer({
  isOpen,
  side,
  columnFrom,
  title,
  onClose,
  contentClassName = 'flex flex-col gap-5 p-4',
  children,
}: DrawerProps): React.JSX.Element {
  // Escape closes. Harmless at a width where the pane is a column: nothing there can set `isOpen`,
  // so there is nothing to close. No body scroll lock, deliberately — the app is `height: 100%`
  // with its own scrollers and the page itself never scrolls, so a lock would be a side effect
  // with no symptom to prevent and one more thing to leave behind on a rotation.
  useEffect(() => {
    if (!isOpen) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isOpen, onClose])

  return (
    <>
      {isOpen && (
        // A button rather than a div: closing by tapping outside has to be reachable by keyboard
        // and announced, and `aria-label` on a div with an onClick is neither.
        <button
          type="button"
          aria-label={`Close ${title}`}
          className={`fixed inset-0 z-30 bg-neutral-950/40 ${ONLY_NARROW[columnFrom]}`}
          onClick={onClose}
        />
      )}
      <aside
        aria-label={title}
        className={`app-surface fixed inset-y-0 z-40 w-[min(20rem,85vw)] flex-col overflow-y-auto
          overscroll-contain border-neutral-200 shadow-xl dark:border-neutral-800
          ${isOpen ? 'flex' : 'hidden'}
          ${side === 'left' ? 'left-0 border-r' : 'right-0 border-l'}
          ${AS_COLUMN[columnFrom]}`}
      >
        <header
          className={`flex items-center justify-between gap-2 border-b border-neutral-200 p-3
            dark:border-neutral-800 ${ONLY_NARROW[columnFrom]}`}
        >
          <span className="section-heading">{title}</span>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>
        <div className={contentClassName}>{children}</div>
      </aside>
    </>
  )
}
