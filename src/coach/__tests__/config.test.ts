/**
 * Which environment values switch Layer B on.
 *
 * The important case is the negative one, and for a sharper reason than the Supabase config's:
 * guessing wrong here does not degrade a feature, it makes billed API calls from a prep screen.
 * Everything that is not an explicit yes is a no.
 */

import { describe, expect, it } from 'vitest'

import { parseCoachEnabled } from '../config.ts'

describe('parseCoachEnabled', () => {
  it('accepts the ways a person writes yes', () => {
    for (const value of ['true', '1', 'yes', 'on', 'TRUE', ' True ', 'YES']) {
      expect(parseCoachEnabled(value), value).toBe(true)
    }
  })

  it('treats an unset or empty variable as off', () => {
    // The default state of a fresh clone, and the state the project is deliberately in.
    for (const value of [undefined, '', '   ']) {
      expect(parseCoachEnabled(value)).toBe(false)
    }
  })

  it('treats anything else as off rather than guessing', () => {
    // `'false'` is the one that matters: a truthiness check would read it as on, and the cost of
    // that mistake is a request nobody asked for against somebody's account.
    for (const value of ['false', '0', 'no', 'off', 'maybe', 'enabled', 'ANTHROPIC']) {
      expect(parseCoachEnabled(value), value).toBe(false)
    }
  })
})
