/**
 * Whether this build has a Supabase project to talk to.
 *
 * **Absent is the normal state, not an error.** A fresh clone has no `.env`, and everything the
 * app does except the team layer works without one — that is the local-first promise, and the
 * way it stays true is that every entry point to sync starts by asking this and gets null.
 *
 * Both values are build-time (`VITE_`-prefixed, so Vite inlines them). Neither is a secret: the
 * anon key is designed to ship inside a client, and what it can actually do is decided by the
 * RLS policies, not by keeping it hidden.
 */

/** A project this build can reach. */
export interface SupabaseConfig {
  readonly url: string
  readonly anonKey: string
}

/**
 * Validates a pair of environment values.
 *
 * @param url - Candidate project URL. Anything that is not a parseable `http`/`https` URL is
 *   treated as absent rather than passed on — supabase-js accepts a malformed URL at
 *   construction and fails on the first request, minutes later and somewhere else.
 * @param anonKey - Candidate anon key. Whitespace-only counts as absent, which is what an
 *   `.env` line with nothing after the `=` produces.
 * @returns The config, or null when either half is missing or unusable.
 */
export function parseSupabaseConfig(
  url: string | undefined,
  anonKey: string | undefined,
): SupabaseConfig | null {
  const trimmedUrl = (url ?? '').trim()
  const trimmedKey = (anonKey ?? '').trim()
  if (trimmedUrl.length === 0 || trimmedKey.length === 0) {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(trimmedUrl)
  } catch {
    return null
  }
  // `http` is allowed for a `supabase start` instance on localhost and nowhere else; a plaintext
  // URL to a real project would send the session token over the wire in clear.
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    return null
  }

  return { url: trimmedUrl.replace(/\/+$/, ''), anonKey: trimmedKey }
}

/**
 * Reads the project this build was compiled against.
 *
 * @returns The config, or null when the build had no `.env`. Callers must treat null as "the
 *   team layer is switched off", never as a failure to report.
 */
export function supabaseConfig(): SupabaseConfig | null {
  // Written as literal member accesses because that is the form Vite statically replaces; read
  // through a variable, these are undefined in a production build.
  return parseSupabaseConfig(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY,
  )
}
