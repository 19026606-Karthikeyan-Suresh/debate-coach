/**
 * A save dialog, then Rust writes the bytes.
 *
 * The bytes are written by `src-tauri/src/export.rs` rather than by `tauri-plugin-fs`; that
 * module's docstring says why. Nothing here reads or writes a path the user did not pick in a
 * dialog, and the Rust side re-checks the extension before touching the disk — a check on this
 * side would be advice, not a boundary.
 */

import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

import type { FileFilter, FilesPlatform } from '../types.ts'

/** The dialog plugin wants a mutable array; `FileFilter` is readonly so a caller cannot keep one. */
function toDialogFilter(filter: FileFilter): { name: string; extensions: string[] } {
  return { name: filter.name, extensions: [...filter.extensions] }
}

/**
 * Asks where to save, then writes.
 *
 * @param options - Where to put it and what it is.
 * @param options.suggestedName - Fills the dialog's name box.
 * @param options.bytes - The file, already built.
 * @param options.filter - The type to offer. `export.rs` re-checks the extension of whatever the
 *   user actually chose, so this narrows the dialog rather than deciding anything.
 * @returns The path written, or null when the dialog was cancelled — which is not an error and
 *   must not be reported as one.
 */
async function saveBytes(options: {
  readonly suggestedName: string
  readonly bytes: Uint8Array
  readonly filter: FileFilter
}): Promise<string | null> {
  const path = await save({
    defaultPath: options.suggestedName,
    filters: [toDialogFilter(options.filter)],
  })
  if (path === null) {
    return null
  }
  // A `Uint8Array` nested inside an argument object serialises as `{"0":1,"1":2,…}`, which does
  // not deserialise into a `Vec<u8>`. Only a whole-body `ArrayBuffer` takes the raw path, and
  // that has no room for the second argument, so this goes over as a plain array.
  await invoke('write_export_file', { path, contents: Array.from(options.bytes) })
  return path
}

/**
 * Asks for a file and reads it as text.
 *
 * @param options - What to offer.
 * @param options.filter - The type to accept. `read_case_file` takes `.dbcase` only, so a filter
 *   naming anything else opens a dialog whose selection is then refused.
 * @returns The file's contents, or null when the dialog was cancelled.
 * @throws If the chosen file cannot be read.
 */
async function openTextFile(options: { readonly filter: FileFilter }): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [toDialogFilter(options.filter)],
  })
  if (selected === null) {
    return null
  }
  return await invoke<string>('read_case_file', { path: selected })
}

/** Native dialogs, with Rust writing and reading the bytes. */
export const files: FilesPlatform = {
  saveBytes,
  openTextFile,
}
