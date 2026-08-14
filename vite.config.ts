import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// From 'vitest/config', not 'vite' — the plain Vite `defineConfig` has no `test` key.
import { defineConfig } from 'vitest/config'

// Tauri drives the dev server through these; the fixed port matters because
// tauri.conf.json's devUrl is hardcoded and Tauri cannot follow a port bump.
const DEV_SERVER_PORT = 1420

/**
 * Vite config for both shells.
 *
 * `strictPort` is deliberate: silently moving to 1421 leaves Tauri loading a
 * dead URL and the window comes up blank with no error.
 *
 * **`--mode web` is what picks the browser shell**, through the `@platform` alias below. Vite's
 * mode is separate from the production/development switch — `vite build --mode web` is still a
 * production build — so it costs nothing to reuse it as the target, and it is the only
 * cross-platform way to pass one through an npm script without adding a dependency for it.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],

  // Tauri reads Rust build errors off stderr; letting Vite own the screen hides them.
  clearScreen: false,

  resolve: {
    alias: {
      // The repo's only path alias, and it earns the exception: a runtime
      // `'__TAURI_INTERNALS__' in window` branch would pull @tauri-apps into the browser bundle,
      // which is the one property the web build has to be able to prove it does not have.
      //
      // `src/platform/web/` lands with the Supabase-backed storage; until then only the default
      // target resolves.
      '@platform': fileURLToPath(
        new URL(`./src/platform/${mode === 'web' ? 'web' : 'tauri'}/index.ts`, import.meta.url),
      ),
    },
  },

  server: {
    port: DEV_SERVER_PORT,
    strictPort: true,
    watch: {
      // src-tauri churns constantly during cargo builds; watching it causes reload storms.
      ignored: ['**/src-tauri/**'],
    },
  },

  // Chromium/WebView2 is the only target, so there is no reason to down-level further.
  build: {
    target: 'chrome110',
    sourcemap: true,
  },

  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
  },
}))
