/**
 * The browser shell, assembled.
 *
 * `vite.config.ts` aliases `@platform` here under `--mode web`. Nothing in this directory imports
 * `@tauri-apps/*`, which is the property the alias exists to make provable rather than promised:
 * `grep -r @tauri-apps dist/` on a web build should find nothing.
 *
 * Four of the seven are finished — storage, identity, files and co-prep. Three report themselves
 * unavailable and say why in a sentence the UI prints: coaching needs a serverless function to
 * hold the key, and the review pass and recordings need work that is scheduled rather than
 * missing. None of them fails silently, and none pretends.
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
