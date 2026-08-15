/**
 * The desktop shell, assembled.
 *
 * `vite.config.ts` aliases `@platform` here when `APP_TARGET` is `tauri`, which is the default —
 * so every existing command still builds the app it always built.
 *
 * The `satisfies Platform` at the bottom is what catches a capability added to the interface and
 * implemented in only one shell. The per-module annotations catch a wrong signature; only this
 * catches a missing module.
 */

import type { Platform } from '../types.ts'
import { auth } from './auth.ts'
import { coach } from './coach.ts'
import { collab } from './collab.ts'
import { database } from './database.ts'
import { files } from './files.ts'
import { recordings } from './recordings.ts'
import { speech } from './speech.ts'

export { auth } from './auth.ts'
export { coach } from './coach.ts'
export { collab } from './collab.ts'
export { database } from './database.ts'
export { files } from './files.ts'
export { recordings } from './recordings.ts'
export { speech } from './speech.ts'

/** Every capability this shell provides, checked as a whole. */
export const platform = {
  auth,
  coach,
  collab,
  database,
  files,
  recordings,
  speech,
} satisfies Platform
