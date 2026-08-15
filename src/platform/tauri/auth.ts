/**
 * The Supabase session, in the Windows Credential Manager.
 *
 * `keyring`, not `tauri-plugin-stronghold` — stronghold needs a password to unlock a file, so it
 * is either a second password every launch or a hardcoded one over an encrypted file, which is a
 * file. Windows already unlocks a per-user secret store at login.
 *
 * The blob is chunked across credential entries on the Rust side, because Windows caps one at
 * 2560 bytes and `keyring` writes UTF-16 — so the real limit is ~1280 characters and a session is
 * well past it.
 */

import { createClient, type SupportedStorage } from '@supabase/supabase-js'
import { invoke } from '@tauri-apps/api/core'

import { supabaseConfig } from '../../sync/config.ts'
import type { AuthPlatform, MaybeSupabaseClient } from '../types.ts'

/** Whether the Tauri IPC exists. False under `npm run dev` in a plain browser tab. */
function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * supabase-js's storage, backed by the OS credential store.
 *
 * The library asks for several keys — the session, and a PKCE verifier during sign-in — so the
 * one credential blob holds a JSON map rather than a bare value. With no shell underneath it
 * degrades to memory, which means a browser dev session signs in again on reload and never
 * writes a refresh token to a file.
 *
 * @returns The storage supabase-js expects.
 */
function sessionStorage(): SupportedStorage {
  const fallback = new Map<string, string>()

  const readAll = async (): Promise<Record<string, string>> => {
    if (!hasTauri()) {
      return Object.fromEntries(fallback)
    }
    const stored = await invoke<string | null>('sync_session_get')
    if (stored === null || stored.length === 0) {
      return {}
    }
    try {
      return JSON.parse(stored) as Record<string, string>
    } catch {
      // A blob that will not parse is a half-written save. Treating it as empty costs a
      // sign-in; treating it as a session costs an unexplainable auth failure.
      return {}
    }
  }

  const writeAll = async (values: Record<string, string>): Promise<void> => {
    if (!hasTauri()) {
      fallback.clear()
      for (const [key, value] of Object.entries(values)) {
        fallback.set(key, value)
      }
      return
    }
    const hasAny = Object.keys(values).length > 0
    await invoke('sync_session_set', { session: hasAny ? JSON.stringify(values) : '' })
  }

  return {
    getItem: async (key: string) => (await readAll())[key] ?? null,
    setItem: async (key: string, value: string) => {
      await writeAll({ ...(await readAll()), [key]: value })
    },
    removeItem: async (key: string) => {
      const { [key]: _removed, ...rest } = await readAll()
      await writeAll(rest)
    },
  }
}

// One client per process. Two would each keep their own auto-refresh timer against the same
// credential entry and race each other writing it back.
let clientHandle: MaybeSupabaseClient = null

/**
 * The client, or null when this build has no project.
 *
 * @returns The shared client. Null is the ordinary state of a clone with no `.env`.
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
      // No URL to parse in a desktop shell, and leaving it on makes supabase-js read
      // `window.location` on every construction.
      detectSessionInUrl: false,
    },
  })
  return clientHandle
}

/** The OS credential store, and no address bar to read a callback out of. */
export const auth: AuthPlatform = {
  getClient,
  sessionStorage,
  persistsSession: true,
  // No URL to parse in a desktop shell, and leaving it on makes supabase-js read
  // `window.location` on every construction.
  detectSessionInUrl: false,
}
