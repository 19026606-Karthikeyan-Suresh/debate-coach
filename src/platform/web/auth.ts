/**
 * The Supabase client and where its session lives in a browser.
 *
 * `localStorage`, which is supabase-js's own default and the only thing there. That is a real
 * downgrade from the desktop's OS credential store, which is encrypted at rest per user, and the
 * app has to say so rather than imply otherwise: `persistsSession` is true because a reload keeps
 * you signed in, but clearing site data starts a **new anonymous identity that owns none of the
 * previous one's cases**. Linking an email is what makes that recoverable.
 *
 * `detectSessionInUrl` is on here and off on the desktop. It is how the callback from a magic
 * link gets read out of the address bar, and there is no address bar in a Tauri window.
 */

import { createClient, type SupportedStorage } from '@supabase/supabase-js'

import { supabaseConfig } from '../../sync/config.ts'
import type { AuthPlatform, MaybeSupabaseClient } from '../types.ts'

/**
 * supabase-js's storage, backed by `localStorage`.
 *
 * Returned explicitly rather than left to the library's default so that both shells answer the
 * same question in the same place, and so a browser with `localStorage` blocked — private mode on
 * some configurations, or a third-party frame — degrades to memory rather than throwing during
 * client construction, which would take the whole app down before it rendered.
 *
 * @returns The storage supabase-js expects.
 */
function sessionStorage(): SupportedStorage {
  const fallback = new Map<string, string>()

  const usable = (): boolean => {
    try {
      return typeof window !== 'undefined' && window.localStorage !== null
    } catch {
      // Reading the property itself throws when storage is disallowed, which is why this is a
      // try/catch around an access rather than a null check.
      return false
    }
  }

  return {
    getItem: (key: string) => (usable() ? window.localStorage.getItem(key) : (fallback.get(key) ?? null)),
    setItem: (key: string, value: string) => {
      if (usable()) {
        window.localStorage.setItem(key, value)
      } else {
        fallback.set(key, value)
      }
    },
    removeItem: (key: string) => {
      if (usable()) {
        window.localStorage.removeItem(key)
      } else {
        fallback.delete(key)
      }
    },
  }
}

// One client per tab. Two would each keep their own auto-refresh timer against the same
// `localStorage` entry and race each other writing it back.
let clientHandle: MaybeSupabaseClient = null

/**
 * The client, or null when this build has no project.
 *
 * @returns The shared client. Null means the build was compiled without `VITE_SUPABASE_URL` —
 *   which on the web is not "the team layer is off" but "there is no storage at all", and the
 *   Library says so rather than showing an empty list.
 */
function getClient(): MaybeSupabaseClient {
  if (clientHandle) {
    return clientHandle
  }
  const config = supabaseConfig()
  if (!config) {
    return null
  }
  clientHandle = createClient(config.url, config.anonKey, {
    auth: {
      storage: sessionStorage(),
      persistSession: true,
      autoRefreshToken: true,
      // The magic-link callback arrives as a URL fragment; without this it is never consumed and
      // the user lands back on the sign-in prompt holding a valid token.
      detectSessionInUrl: true,
    },
  })
  return clientHandle
}

/** `localStorage`, and an address bar an auth callback can arrive in. */
export const auth: AuthPlatform = {
  getClient,
  sessionStorage,
  persistsSession: true,
  detectSessionInUrl: true,
}
