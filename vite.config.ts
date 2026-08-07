import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// From 'vitest/config', not 'vite' — the plain Vite `defineConfig` has no `test` key.
import { defineConfig } from 'vitest/config'

// Tauri drives the dev server through these; the fixed port matters because
// tauri.conf.json's devUrl is hardcoded and Tauri cannot follow a port bump.
const DEV_SERVER_PORT = 1420

/**
 * Vite config for the Tauri frontend.
 *
 * `strictPort` is deliberate: silently moving to 1421 leaves Tauri loading a
 * dead URL and the window comes up blank with no error.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Tauri reads Rust build errors off stderr; letting Vite own the screen hides them.
  clearScreen: false,

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
})
