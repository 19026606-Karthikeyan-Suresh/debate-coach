/**
 * Whether Layer B appears in the app at all.
 *
 * **Off by default.** Layer A — the offline depth panel — is the part of the analyzer that always
 * runs and always will; Claude was always the opt-in half, and this makes the opt-in explicit
 * rather than implied by whether a key happens to be lying around.
 *
 * # Why a flag and not just "is there a key"
 *
 * Keying the UI off the presence of `ANTHROPIC_API_KEY` is the tempting one-liner and it is
 * wrong: that variable is a de-facto standard and is very often already exported on a developer's
 * machine for entirely unrelated tools. A panel that switched itself on because of somebody
 * else's environment — and then made billed calls from a prep screen — is a surprise nobody
 * asked for. Turning Layer B on is a decision, so it gets its own switch.
 *
 * # Why `VITE_` is correct here and wrong for the key
 *
 * Vite inlines `VITE_`-prefixed values into the frontend bundle. For the API key that is
 * disqualifying, which is why `ANTHROPIC_API_KEY` has no prefix and is read in Rust. For a
 * boolean that decides whether a panel renders, being in the bundle is exactly right — the
 * frontend is what needs to know, there is nothing to leak, and a build-time constant lets the
 * whole panel drop out rather than render and hide.
 */

/**
 * Reads a flag the way a person would write it.
 *
 * @param raw - The environment value, or undefined when the variable is unset.
 * @returns True only for an affirmative spelling. Anything else — unset, empty, `false`, `0`, or
 *   a typo — is off, because the failure mode of guessing wrong is a billed API call.
 */
export function parseCoachEnabled(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase()
  return value === 'true' || value === '1' || value === 'yes' || value === 'on'
}

/**
 * Whether this build shows the Claude coach.
 *
 * @returns True when `VITE_ENABLE_COACH` is set to an affirmative value. False on a fresh clone,
 *   which is the intended default: everything else in the app works, and the depth panel still
 *   runs every offline rule.
 */
export function isCoachEnabled(): boolean {
  // A literal member access, because that is the form Vite statically replaces — read through a
  // variable it is undefined in a production build, which would silently disable the feature for
  // anyone who had switched it on.
  return parseCoachEnabled(import.meta.env.VITE_ENABLE_COACH)
}
