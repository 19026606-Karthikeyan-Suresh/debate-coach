/**
 * Storage, as the rest of the app names it.
 *
 * Every call site — `hooks/`, `components/`, `sync/engine.ts`, `sync/library.ts` — imports from
 * here and always has. What changed when the web shell landed is only what is *behind* it: on the
 * desktop, SQLite with a real dirty-row queue; in a browser, Supabase, where a write is already up
 * and the queue methods are inert. Neither is named here, which is the point.
 *
 * **The docstrings moved rather than vanished.** `src/platform/types.ts` states what each of these
 * does and what happens if you pass the wrong thing, and each shell's implementation documents how
 * it does it. Restating that here would give three places to disagree.
 *
 * Destructured rather than wrapped, which is safe for exactly one reason: **a platform
 * implementation is an object literal of standalone functions and may never use `this`.** Both
 * shells hold to that, and a method that started using it would break here rather than at its own
 * call site, which is the wrong place to find out.
 */

import { database } from '@platform'

export type { CaseSummary, SessionSummary } from '../platform/types.ts'

export const {
  requiresIdentity,
  saveCase,
  loadCase,
  listCases,
  listCaseIds,
  deleteCase,
  saveSession,
  listSessions,
  setSessionRecordingObject,
  loadSessionReport,
  deleteSession,
  listComments,
  loadComment,
  saveComment,
  deleteComment,
  replaceRemoteComments,
  loadScriptEdits,
  saveScriptEdit,
  deleteScriptEdit,
} = database
