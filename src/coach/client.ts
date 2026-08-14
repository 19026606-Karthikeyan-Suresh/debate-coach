/**
 * The frontend half of the proxy.
 *
 * **The key crosses nothing here, on either shell.** On the desktop it is read from
 * `ANTHROPIC_API_KEY` in the Rust process; on the web it lives in a serverless function. There is
 * no call that accepts a key and none that returns one, which is the whole reason the Anthropic
 * request is not made from this side.
 *
 * That is also why the variable has no `VITE_` prefix. Vite inlines anything so prefixed into the
 * frontend bundle, which would put the key in this file's neighbourhood and ship it inside the
 * installer.
 *
 * `readCoachStatus` degrades rather than throwing when there is nothing behind it. `npm run dev`
 * in a plain browser has no shell, and the Prep screen still has to render — the coach panel just
 * says it is unavailable.
 */

import { coach } from '@platform'

export type { CoachReply, CoachStatus } from '../platform/types.ts'

export const { readCoachStatus, requestCoach } = coach
