/**
 * Playing a recording back, with a coach's notes pinned to the moments they are about.
 *
 * This is the payoff for uploading anything at all. A report says a clause was skipped; a comment
 * at 4:12 says the rebuttal was rushed, and the only way to know which is true is to hear it.
 *
 * **The playhead is a plain state change, never a transition.** A window that is not compositing
 * does not finish a CSS transition, so a bar that animated to the current position would sit
 * wherever it was when the window went behind something — pointing at the wrong second
 * indefinitely, which is the phase 5 teleprompter bug in a different component. Only the hover
 * states here are allowed to transition, because nobody hovers over a window they cannot see.
 */

import { useRef, useState } from 'react'

import { formatClock } from '../../case/time.ts'
import { useComments } from '../../hooks/useComments.ts'
import { useRecording, type RecordingSource } from '../../hooks/useRecording.ts'
import {
  activeCommentAt,
  clampToRecording,
  commentMarkers,
  sortComments,
} from '../../speech/comments.ts'

/** Seconds a skip button moves. Long enough to matter, short enough to land in the same sentence. */
const SKIP_SECONDS = 5

/** Props for {@link Playback}. */
export interface PlaybackProps {
  readonly sessionId: string
  /** The motion, or whatever names this speech in the list it was opened from. */
  readonly title: string
  /** Speaker, format and date — one line under the title. */
  readonly subtitle: string
  /** Which recording, or null when the session has no audio. */
  readonly source: RecordingSource | null
  /** True for a speech this install recorded. Decides where comments are stored. */
  readonly isOwnSession: boolean
  /** Length from the session row, used until the audio element reports its own. */
  readonly fallbackSeconds: number
  readonly teamId: string | null
  readonly userId: string | null
  readonly displayName: string
  readonly onClose: () => void
}

/**
 * The recording player and its comment thread.
 *
 * @param props - See {@link PlaybackProps}.
 * @param props.sessionId - The speech being played.
 * @param props.title - Names it in the header.
 * @param props.subtitle - Speaker, format and date.
 * @param props.source - Which recording to load, or null for a session with none.
 * @param props.isOwnSession - True for a speech this install recorded.
 * @param props.fallbackSeconds - Length from the session row, until the audio reports its own.
 * @param props.teamId - Active team, or null.
 * @param props.userId - This install's `auth.uid()`, or null.
 * @param props.displayName - How this debater appears on a comment.
 * @param props.onClose - Back to the list.
 * @returns The player.
 */
export function Playback({
  sessionId,
  title,
  subtitle,
  source,
  isOwnSession,
  fallbackSeconds,
  teamId,
  userId,
  displayName,
  onClose,
}: PlaybackProps): React.JSX.Element {
  const recording = useRecording(source)
  const thread = useComments({ sessionId, isOwnSession, teamId, userId, displayName })

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [currentSeconds, setCurrentSeconds] = useState(0)
  const [loadedSeconds, setLoadedSeconds] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  /** Where a comment being written is anchored, or null when nothing is being written. */
  const [draftAt, setDraftAt] = useState<number | null>(null)
  const [draft, setDraft] = useState('')

  // The element's own duration once it has one; a session row's number until then. An Ogg whose
  // last page never arrived reports Infinity, which would put every marker at zero.
  const durationSeconds =
    Number.isFinite(loadedSeconds) && loadedSeconds > 0 ? loadedSeconds : fallbackSeconds

  // Sorted here rather than trusted from the source. The markers on the bar are in playback order
  // because `commentMarkers` sorts, and a list beside them in a different order reads as a bug —
  // which is what a note added mid-session looked like, appended to the end while its marker sat
  // where it belonged.
  const ordered = sortComments(thread.comments)
  const markers = commentMarkers(ordered, durationSeconds)
  const active = activeCommentAt(ordered, currentSeconds)
  const progress = durationSeconds > 0 ? Math.min(1, currentSeconds / durationSeconds) : 0

  /** Moves the playhead, and the audio with it. */
  const seekTo = (seconds: number): void => {
    const audio = audioRef.current
    const target = clampToRecording(seconds, durationSeconds)
    if (audio) {
      audio.currentTime = target
    }
    setCurrentSeconds(target)
  }

  /** Seeks to the point on the bar that was clicked. */
  const seekFromBar = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width <= 0) {
      return
    }
    seekTo(((event.clientX - bounds.left) / bounds.width) * durationSeconds)
  }

  const togglePlay = (): void => {
    const audio = audioRef.current
    if (!audio) {
      return
    }
    if (audio.paused) {
      void audio.play()
    } else {
      audio.pause()
    }
  }

  const saveDraft = (): void => {
    if (draftAt === null) {
      return
    }
    void thread.add(draftAt, draft).then(() => {
      setDraft('')
      setDraftAt(null)
    })
  }

  return (
    <main className="mx-auto flex h-full max-w-3xl flex-col gap-5 overflow-y-auto p-8">
      <header className="flex items-center gap-3">
        <button type="button" className="btn" onClick={onClose}>
          ← Sessions
        </button>
        <div className="flex flex-col">
          <h1 className="text-xl font-semibold">{title}</h1>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{subtitle}</span>
        </div>
      </header>

      {source === null ? (
        <p className="panel p-3 text-sm text-neutral-600 dark:text-neutral-300">
          This speech has no recording. The browser recogniser keeps none, so there is nothing to
          play back — the report is still here.
        </p>
      ) : null}

      {recording.status === 'loading' ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Preparing the audio…</p>
      ) : null}

      {recording.error !== null ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {recording.error}
        </p>
      ) : null}

      {recording.url !== null ? (
        <section className="panel flex flex-col gap-3 p-4">
          <audio
            ref={audioRef}
            src={recording.url}
            preload="metadata"
            onLoadedMetadata={(event) => {
              setLoadedSeconds(event.currentTarget.duration)
            }}
            onTimeUpdate={(event) => {
              setCurrentSeconds(event.currentTarget.currentTime)
            }}
            onPlay={() => {
              setIsPlaying(true)
            }}
            onPause={() => {
              setIsPlaying(false)
            }}
            onEnded={() => {
              setIsPlaying(false)
            }}
          >
            <track kind="captions" />
          </audio>

          <div className="flex items-center gap-3">
            <button type="button" className="btn" onClick={togglePlay}>
              {isPlaying ? '❙❙ Pause' : '▶ Play'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                seekTo(currentSeconds - SKIP_SECONDS)
              }}
            >
              −{SKIP_SECONDS}s
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                seekTo(currentSeconds + SKIP_SECONDS)
              }}
            >
              +{SKIP_SECONDS}s
            </button>
            <span className="ml-auto text-sm tabular-nums text-neutral-600 dark:text-neutral-300">
              {formatClock(Math.floor(currentSeconds))} / {formatClock(Math.round(durationSeconds))}
            </span>
          </div>

          {/* The bar itself is the seek control; the markers on it are separate buttons so a
              comment can be jumped to by name as well as by position. */}
          <div className="relative h-8">
            <button
              type="button"
              className="absolute inset-x-0 top-3 h-2 w-full cursor-pointer rounded bg-neutral-200 dark:bg-neutral-700"
              onClick={seekFromBar}
              aria-label="Seek"
            >
              <span
                className="block h-2 rounded bg-neutral-900 dark:bg-neutral-100"
                style={{ width: `${String(progress * 100)}%` }}
              />
            </button>
            {markers.map((marker) => (
              <button
                key={marker.comment.id}
                type="button"
                className={`absolute top-0 h-8 w-1.5 -translate-x-1/2 rounded-full ${
                  active?.id === marker.comment.id
                    ? 'bg-amber-500'
                    : 'bg-amber-300 dark:bg-amber-700'
                }`}
                style={{ left: `${String(marker.position * 100)}%` }}
                title={`${formatClock(Math.floor(marker.comment.atSeconds))} — ${marker.comment.body}`}
                onClick={() => {
                  seekTo(marker.comment.atSeconds)
                }}
              >
                <span className="sr-only">
                  Jump to the comment at {formatClock(Math.floor(marker.comment.atSeconds))}
                </span>
              </button>
            ))}
          </div>

          {recording.encoding !== null ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Playing the Opus copy — {Math.round(recording.encoding.opusBytes / 1024)} kB, against{' '}
              {Math.round(recording.encoding.wavBytes / 1024)} kB of WAV.
            </p>
          ) : null}
          {recording.isUncompressed ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              The Opus copy could not be made, so this is the raw WAV. Playback works; sharing this
              speech will not.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h2 className="section-heading">Comments ({ordered.length})</h2>
          {thread.isCached ? (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              cached — not refreshed from the squad
            </span>
          ) : null}
          <button
            type="button"
            className="btn ml-auto"
            disabled={thread.isBusy || draftAt !== null}
            onClick={() => {
              setDraftAt(clampToRecording(currentSeconds, durationSeconds))
            }}
          >
            Comment at {formatClock(Math.floor(currentSeconds))}
          </button>
        </div>

        {thread.error !== null ? (
          <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            {thread.error}
          </p>
        ) : null}

        {draftAt !== null ? (
          <div className="panel flex flex-col gap-2 p-3">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              At {formatClock(Math.floor(draftAt))}
            </span>
            <textarea
              className="field-input min-h-20"
              value={draft}
              autoFocus
              placeholder="What should they do differently here?"
              onChange={(event) => {
                setDraft(event.target.value)
              }}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="btn"
                disabled={thread.isBusy || draft.trim().length === 0}
                onClick={saveDraft}
              >
                Save
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDraftAt(null)
                  setDraft('')
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {ordered.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No comments yet. Scrub to a moment worth talking about and leave one there.
          </p>
        ) : null}

        <ul className="flex flex-col gap-1.5">
          {ordered.map((comment) => (
            <li
              key={comment.id}
              className={`panel flex items-start gap-3 p-3 ${
                active?.id === comment.id ? 'ring-2 ring-amber-500' : ''
              }`}
            >
              <button
                type="button"
                className="text-sm tabular-nums text-neutral-500 hover:underline dark:text-neutral-400"
                onClick={() => {
                  seekTo(comment.atSeconds)
                }}
              >
                {formatClock(Math.floor(comment.atSeconds))}
              </button>
              <div className="flex flex-1 flex-col">
                <span className="text-sm">{comment.body}</span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {comment.authorName.trim() || 'A teammate'}
                  {comment.isRemote ? '' : ' · not sent yet'}
                </span>
              </div>
              {comment.authorId !== null && comment.authorId === userId ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={thread.isBusy}
                  onClick={() => {
                    void thread.remove(comment.id)
                  }}
                >
                  Delete
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
