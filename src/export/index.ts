/**
 * The export path's one impure module: a save dialog, then Rust writes the bytes.
 *
 * Everything that decides *what* a file contains is a pure function in a sibling module and is
 * tested as one. This holds only the two things that cannot be — the OS dialog and the IPC — so
 * the untestable surface of phase 8 is one file long.
 *
 * The bytes are written by `src-tauri/src/export.rs` rather than by `tauri-plugin-fs`; that
 * module's docstring says why. Nothing here reads or writes a path the user did not pick in a
 * dialog.
 */

import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

import type { SpeakerRole } from '../formats/index.ts'
import type { Case } from '../types/case.ts'
import { buildDbcase, readDbcase, type DbcaseImport } from './dbcase.ts'
import { buildCaseDocx, buildSpeechSheetDocx } from './docx.ts'
import { buildSpeechSheet } from './speechSheet.ts'

/** Characters Windows forbids in a file name, plus the ones that make a name awkward to type. */
const UNSAFE_FILENAME_CHARACTERS = /[<>:"/\\|?*]/g

/** Longest suggested name. Well under `MAX_PATH` once a folder is prepended. */
const MAX_FILENAME_LENGTH = 80

/**
 * Suggests a file name from the motion.
 *
 * The motion is the only thing about a case that reads like a title, and a folder of files called
 * `case (3).docx` is a folder nobody can find anything in.
 *
 * @param caseFile - The case being exported. A blank or unusable motion falls back to
 *   `debate-case`, never to an empty name — a save dialog opened with one shows no name at all
 *   and looks broken.
 * @param extension - Extension without the dot.
 * @returns A file name, safe on Windows and short enough to read.
 */
export function suggestFileName(caseFile: Case, extension: string): string {
  const cleaned = caseFile.prep.motion
    .replace(UNSAFE_FILENAME_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILENAME_LENGTH)
    // A name ending in a dot or a space is legal to create and impossible to open on Windows.
    .replace(/[. ]+$/, '')

  return `${cleaned.length > 0 ? cleaned : 'debate-case'}.${extension}`
}

/**
 * The calendar date on this machine, as `YYYY-MM-DD`.
 *
 * `toISOString().slice(0, 10)` is the obvious way to write this and it is wrong east and west of
 * Greenwich: a case exported at half past midnight prints yesterday, and one exported in the
 * evening in Auckland prints yesterday too. A printout dated a day off is how the wrong version
 * of a case gets carried into a round.
 *
 * @param now - The moment to name. Passed in so the caller can pin it in a test.
 * @returns The local date, zero-padded.
 */
export function localDateStamp(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${String(now.getFullYear())}-${month}-${day}`
}

/** Writes bytes through the Rust command, which checks the extension before touching the disk. */
async function writeFile(path: string, bytes: Uint8Array): Promise<void> {
  // A `Uint8Array` nested inside an argument object serialises as `{"0":1,"1":2,…}`, which does
  // not deserialise into a `Vec<u8>`. Only a whole-body `ArrayBuffer` takes the raw path, and
  // that has no room for the second argument, so this goes over as a plain array.
  await invoke('write_export_file', { path, contents: Array.from(bytes) })
}

/**
 * Asks where to save, then writes the case as a Word document.
 *
 * @param caseFile - The case to export.
 * @returns The path written, or null when the dialog was cancelled — which is not an error and
 *   must not be reported as one.
 */
export async function saveCaseDocx(caseFile: Case): Promise<string | null> {
  const path = await save({
    defaultPath: suggestFileName(caseFile, 'docx'),
    filters: [{ name: 'Word document', extensions: ['docx'] }],
  })
  if (path === null) {
    return null
  }
  await writeFile(path, buildCaseDocx(caseFile, localDateStamp(new Date())))
  return path
}

/**
 * Asks where to save, then writes the case as a `.dbcase`.
 *
 * @param caseFile - The case to export.
 * @returns The path written, or null when the dialog was cancelled.
 */
export async function saveCaseDbcase(caseFile: Case): Promise<string | null> {
  const path = await save({
    defaultPath: suggestFileName(caseFile, 'dbcase'),
    filters: [{ name: 'Debate Coach case', extensions: ['dbcase'] }],
  })
  if (path === null) {
    return null
  }
  await writeFile(path, new TextEncoder().encode(buildDbcase(caseFile, new Date().toISOString())))
  return path
}

/**
 * Asks where to save, then writes this seat's speech sheet as a Word document.
 *
 * @param caseFile - The case to compile.
 * @param role - The seat whose speech to write.
 * @returns The path written, or null when the dialog was cancelled.
 */
export async function saveSpeechSheetDocx(
  caseFile: Case,
  role: SpeakerRole,
): Promise<string | null> {
  const path = await save({
    defaultPath: suggestFileName(caseFile, 'docx').replace(/\.docx$/, ` - ${role.shortLabel}.docx`),
    filters: [{ name: 'Word document', extensions: ['docx'] }],
  })
  if (path === null) {
    return null
  }
  const sheet = buildSpeechSheet(caseFile, role)
  await writeFile(path, buildSpeechSheetDocx(sheet, localDateStamp(new Date())))
  return path
}

/**
 * Asks for a `.dbcase` and parses it.
 *
 * Does not save. The caller decides what to do with the result, because `outcome` changes what
 * it should say afterwards — a restore and a copy are different events.
 *
 * @param existingIds - Every case id already on this machine. An id found here makes the import
 *   a copy rather than a restore; passing an empty list makes every import overwrite.
 * @returns The parsed case, or null when the dialog was cancelled.
 * @throws If the chosen file is not a readable `.dbcase`. The message is meant to be shown.
 */
export async function importCaseFile(
  existingIds: readonly string[],
): Promise<DbcaseImport | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Debate Coach case', extensions: ['dbcase'] }],
  })
  if (selected === null) {
    return null
  }
  const text = await invoke<string>('read_case_file', { path: selected })
  return readDbcase(text, existingIds, new Date().toISOString())
}
