/**
 * Getting a file out of the browser and back into it.
 *
 * The five modules that decide *what* a file contains are pure and unchanged — this shell exports
 * byte-identical `.docx` and `.dbcase` files to the desktop one, because the ZIP writer and the
 * OOXML parts do not know which shell they are running in.
 *
 * A download reports a file *name*, not a path. Where it landed is the browser's business and it
 * does not say, so `saveBytes` returns the name it suggested — which is what the caller shows,
 * and is honest as long as nothing tries to read it back.
 */

import type { FileFilter, FilesPlatform } from '../types.ts'

/** Extension-to-type, for the download hint and the file input's `accept`. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  dbcase: 'application/json',
}

/** `accept` wants dotted extensions; `FileFilter` holds them bare. */
function acceptAttribute(filter: FileFilter): string {
  return filter.extensions.map((extension) => `.${extension}`).join(',')
}

/**
 * Saves bytes as a download.
 *
 * @param options - Where to put it and what it is.
 * @param options.suggestedName - Becomes the download's filename. The browser may still rename it
 *   to avoid a collision, which is one more reason the return value is not a path.
 * @param options.bytes - The file, already built.
 * @param options.filter - Only its first extension is used, to pick a MIME type. A browser has no
 *   type dropdown to populate.
 * @returns The suggested name. Never null: a download cannot be cancelled, because by the time
 *   the browser asks, the app is no longer involved.
 */
async function saveBytes(options: {
  readonly suggestedName: string
  readonly bytes: Uint8Array
  readonly filter: FileFilter
}): Promise<string | null> {
  await Promise.resolve()
  const extension = options.filter.extensions[0] ?? ''
  // A fresh ArrayBuffer, because `bytes` may be a view onto a larger buffer and Blob would
  // otherwise take the whole of it.
  const copy = new Uint8Array(options.bytes)
  const blob = new Blob([copy], { type: MIME_TYPES[extension] ?? 'application/octet-stream' })
  const url = URL.createObjectURL(blob)

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = options.suggestedName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()

  // Revoked on the next task rather than immediately: Safari has not finished reading the blob
  // when `click` returns, and revoking synchronously produces an empty file.
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 0)
  return options.suggestedName
}

/**
 * Asks for a file and reads it as text.
 *
 * A hidden `<input type="file">` rather than `showOpenFilePicker`, which does not exist in Safari
 * or Firefox — and this is the import path for somebody's whole case, so it is the wrong place to
 * be Chromium-only.
 *
 * @param options - What to offer.
 * @param options.filter - Its extensions become the input's `accept`. A hint, not a guarantee:
 *   every browser lets the user pick "all files", so the parser stays the real check.
 * @returns The file's text, or null when the dialog was dismissed.
 */
async function openTextFile(options: { readonly filter: FileFilter }): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = acceptAttribute(options.filter)
    input.style.display = 'none'

    // There is no cancel event with useful support, so dismissal is detected by the window
    // regaining focus with no file chosen. `once` on both, and the input is removed either way.
    const finish = (text: string | null): void => {
      input.remove()
      resolve(text)
    }

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) {
        finish(null)
        return
      }
      file
        .text()
        .then(finish)
        .catch(() => {
          finish(null)
        })
    })

    input.addEventListener('cancel', () => {
      finish(null)
    })

    document.body.append(input)
    input.click()
  })
}

/** Downloads out, a file input in. */
export const files: FilesPlatform = {
  saveBytes,
  openTextFile,
}
