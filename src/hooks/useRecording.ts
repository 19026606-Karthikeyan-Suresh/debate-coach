/**
 * Getting a speech's audio in front of an `<audio>` element.
 *
 * There is no asset protocol in this shell and no `tauri-plugin-fs` — phase 8 declined its path
 * allowlist for the export path and the same reasoning holds here — so a local recording reaches
 * the webview as bytes over one IPC call and becomes a blob URL. A teammate's comes down from the
 * bucket the same way and ends up in the same kind of URL, which is what lets the player not care
 * which it is looking at.
 *
 * **The Opus copy is what plays, including for your own recording.** The WAV is thirteen megabytes
 * and the Opus is one, and a path exercised only when somebody shares a speech is a path that is
 * broken by the time they do. If the encode fails the WAV is played instead and the panel says so:
 * a codec that stops working should cost a smaller download, not the recording.
 */

import { useEffect, useState } from 'react'

import { getSupabase } from '../sync/supabase.ts'
import {
  fetchSharedRecording,
  prepareRecording,
  readRecordingBytes,
  type RecordingEncoding,
} from '../sync/recordings.ts'

/** Which recording to play. */
export type RecordingSource =
  /** This machine's own WAV, from the session row. */
  | { readonly kind: 'local'; readonly wavPath: string }
  /** A teammate's, by its key in the `recordings` bucket. */
  | { readonly kind: 'shared'; readonly objectKey: string }

/** Where loading has got to. */
export type RecordingStatus = 'idle' | 'loading' | 'ready' | 'error'

/** An audio source the player can point at. */
export interface LoadedRecording {
  /** Blob URL, or null until it is ready. Revoked when the source changes or the player closes. */
  readonly url: string | null
  readonly status: RecordingStatus
  readonly error: string | null
  /** Sizes from the encode, or null for a downloaded recording, which was already Opus. */
  readonly encoding: RecordingEncoding | null
  /**
   * True when the encode failed and the raw WAV is playing instead. The panel says so, because a
   * thirteen-megabyte load and a one-megabyte one feel different and the reason should not be a
   * mystery.
   */
  readonly isUncompressed: boolean
}

/** Reads a thrown value as a sentence. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The bytes for a local recording, preferring the Opus copy. */
async function loadLocal(
  wavPath: string,
): Promise<{ bytes: Uint8Array; encoding: RecordingEncoding | null; mime: string }> {
  try {
    const encoding = await prepareRecording(wavPath)
    return {
      bytes: await readRecordingBytes(encoding.opusPath),
      encoding,
      mime: 'audio/ogg',
    }
  } catch {
    // The recording is the thing that matters; the encode is an optimisation on top of it.
    return { bytes: await readRecordingBytes(wavPath), encoding: null, mime: 'audio/wav' }
  }
}

/**
 * Loads a recording and hands back a URL to play.
 *
 * @param source - Which recording, or null to load nothing — which is what a session with no
 *   audio passes, and is a state rather than an error.
 * @returns See {@link LoadedRecording}. The URL is revoked automatically; do not hold on to it
 *   past a render.
 */
export function useRecording(source: RecordingSource | null): LoadedRecording {
  const [url, setUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<RecordingStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [encoding, setEncoding] = useState<RecordingEncoding | null>(null)
  const [isUncompressed, setIsUncompressed] = useState(false)

  // Two primitives rather than the object, because a caller that rebuilds the prop inline on
  // every render would otherwise re-download a teammate's speech on every render.
  const kind = source?.kind ?? null
  const locator =
    source === null ? null : source.kind === 'local' ? source.wavPath : source.objectKey

  useEffect(() => {
    if (kind === null || locator === null) {
      return undefined
    }

    // Held as a local rather than read back out of state in the cleanup: the cleanup closes over
    // the render it was created in, and a stale URL is one that never gets revoked.
    let createdUrl: string | null = null
    let isStale = false

    void (async () => {
      try {
        setStatus('loading')
        setError(null)

        let bytes: Uint8Array
        let mime = 'audio/ogg'
        if (kind === 'local') {
          const loaded = await loadLocal(locator)
          bytes = loaded.bytes
          mime = loaded.mime
          if (!isStale) {
            setEncoding(loaded.encoding)
            setIsUncompressed(loaded.encoding === null)
          }
        } else {
          const client = getSupabase()
          if (!client) {
            throw new Error('This build has no project, so a shared recording cannot be fetched.')
          }
          bytes = await fetchSharedRecording(client, locator)
          if (!isStale) {
            setEncoding(null)
            setIsUncompressed(false)
          }
        }

        if (isStale) {
          return
        }
        createdUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
        setUrl(createdUrl)
        setStatus('ready')
      } catch (loadError) {
        if (!isStale) {
          setError(messageOf(loadError))
          setStatus('error')
        }
      }
    })()

    return () => {
      isStale = true
      setUrl(null)
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl)
      }
    }
  }, [kind, locator])

  return { url, status, error, encoding, isUncompressed }
}
