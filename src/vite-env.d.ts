/**
 * Build-time environment.
 *
 * Declared here rather than pulled in from `vite/client` because `types` in `tsconfig.json` is
 * an explicit list and these are the only two variables the app reads. Both are optional: the
 * whole team layer is off when they are absent, which is the ordinary state of a fresh clone.
 *
 * Neither is a secret. The anon key is designed to be shipped in a client and is worth exactly
 * what RLS says it is — see `supabase/migrations/20260809000200_rls.sql`.
 */
interface ImportMetaEnv {
  /** Project URL, e.g. `https://abcdefgh.supabase.co`. */
  readonly VITE_SUPABASE_URL?: string
  /** The project's anonymous key. */
  readonly VITE_SUPABASE_ANON_KEY?: string
}

/** Vite's `import.meta` extension. */
interface ImportMeta {
  readonly env: ImportMetaEnv
}
