/**
 * Build-time environment.
 *
 * Declared here rather than pulled in from `vite/client` because `types` in `tsconfig.json` is
 * an explicit list and these are the only variables the app reads. All are optional: the team
 * layer and the coach are both off when they are absent, which is the ordinary state of a fresh
 * clone.
 *
 * **None of these is a secret, and that is the rule for this file.** Vite inlines every
 * `VITE_`-prefixed value into the frontend bundle, so anything declared here ships inside the
 * installer in readable form. The anon key is designed for that and is worth exactly what RLS
 * says it is; a flag is worth nothing. The Anthropic key is therefore deliberately **not** here —
 * it has no prefix and is read in the Rust shell. See `src/coach/config.ts`.
 */
interface ImportMetaEnv {
  /** Project URL, e.g. `https://abcdefgh.supabase.co`. */
  readonly VITE_SUPABASE_URL?: string
  /** The project's anonymous key. */
  readonly VITE_SUPABASE_ANON_KEY?: string
  /**
   * Whether the Claude coach appears at all. Absent means off.
   *
   * Not keyed off the presence of an API key on purpose — `ANTHROPIC_API_KEY` is often already
   * exported for unrelated tools, and a panel that switched itself on because of that would make
   * billed calls nobody asked for.
   */
  readonly VITE_ENABLE_COACH?: string
}

/** Vite's `import.meta` extension. */
interface ImportMeta {
  readonly env: ImportMetaEnv
}
