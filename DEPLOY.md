# Deploying the web build to Vercel

The desktop app is unaffected by everything here. `npm run tauri build` still produces the same
installer, still reads SQLite, still talks to Claude through the Rust process — the two shells
share a codebase and nothing in this file changes the one behind `src/platform/tauri/`.

What gets deployed is `npm run build:web`: the same `src/` with `@platform` aliased to
`src/platform/web/`, plus one serverless function at `api/coach.ts`.

---

## Before the first deploy

**1. Apply the migrations.** All eight, in order — see [`supabase/README.md`](supabase/README.md).
Migrations 7 and 8 are the web shell's and the app is broken without them: a browser has no
SQLite, so `session_reports` and `script_edits` are where the report and the delivery rewrites
live, and `claim_coach_call` is what stops a public URL being an open Anthropic proxy.

**2. Enable anonymous sign-ins**, under Authentication → Providers. Every identity in the schema
is an anonymous `auth.users` row. Without this the app stops at its own sign-in gate and says so —
which is the correct failure, but it is a five-second fix in the dashboard.

**3. Set the Auth URLs**, under Authentication → URL Configuration. This is the step whose failure
mode is worst, because a link is still *sent* and only refuses when somebody clicks it.

| Field | Value |
|---|---|
| Site URL | `https://<your-project>.vercel.app` |
| Redirect URLs | `https://<your-project>.vercel.app/**` |
| Redirect URLs | `https://<your-project>-*.vercel.app/**` — preview deployments |
| Redirect URLs | `http://localhost:1420/**` — `npm run dev:web` |

The app asks for a link back to *the origin it was requested from*, not to the Site URL, so a
preview deployment confirms onto itself instead of onto production. Every origin that should be
able to do that has to be listed here.

---

## The Vercel project

Import the repository. [`vercel.json`](vercel.json) already carries the build command
(`npm run build:web`), the output directory (`dist`), the SPA rewrite, and the function's
duration, so the only thing to set by hand is the environment.

### Environment variables

| Name | Environments | Why |
|---|---|---|
| `VITE_SUPABASE_URL` | Production, Preview, Development | Read at **build** time by Vite and at **run** time by the function |
| `VITE_SUPABASE_ANON_KEY` | Production, Preview, Development | Same |
| `ANTHROPIC_API_KEY` | Production (and Preview if you want coaching there) | Read only by `api/coach.ts` |
| `VITE_ENABLE_COACH` | Wherever the panel should appear | Omit and Layer B does not render at all |
| `COACH_DAILY_LIMIT` | Optional | Calls per identity per UTC day. Defaults to 50 |

Three things about that table are load-bearing:

- **`ANTHROPIC_API_KEY` has no `VITE_` prefix and must never gain one.** Vite inlines anything so
  prefixed into the frontend bundle, which on a public URL means publishing the key. A test
  asserts the prefixed name does not resolve, so adding it fails the build rather than a release.
- **The two Supabase values are not secrets.** The anon key is designed to ship inside a client;
  what it can reach is decided by the RLS policies. They are `VITE_`-prefixed precisely because
  they are meant to be in the bundle.
- **`VITE_ENABLE_COACH` is a separate switch from the key** on purpose. `ANTHROPIC_API_KEY` is a
  de-facto standard often already set for unrelated tools, and a panel that switched itself on
  because of one would bill somebody for a feature they never asked for.

### Node and the function

`engines.node` is `>=24`, which Vercel resolves to the latest 24.x — its current default. The
function's `maxDuration` is 300 s, which is the ceiling on Hobby and within it on Pro, so the
long-running `effort: "high"` audit fits on every plan and needs no streaming variant.

---

## After the first deploy

Worth checking in this order, because each one fails differently:

1. **The app opens and the library lists.** If it stops on "No storage configured", the two
   `VITE_SUPABASE_*` values were not present *at build time* — they are inlined, so adding them
   afterwards needs a redeploy, not a restart.
2. **Create a case, reload.** It should come back. That is the whole PostgREST round trip.
3. **`POST /api/coach` with no `Authorization` header** should be refused. A public URL with an
   Anthropic key behind it is an open proxy until this is true.
4. **Run one audit** and watch the duration. This is the number most likely to want changing.
5. **Add an email in the Account panel**, click the link in the inbox, and confirm it lands back
   on the deployment rather than somewhere else. This is the step that fails when the redirect
   allow-list is missing an entry.
6. **The microphone.** Vercel serves HTTPS, which is what `getUserMedia` and the Web Speech API
   require. Chrome or Edge — WebKit's `SpeechRecognition` support is not equivalent.

---

## What the deployed build does not have

Stated here as well as in the UI, because these are the questions a debater will ask first:

- **Whisper, both passes.** The browser uses the Web Speech API, which is Chrome/Edge, needs a
  network round trip, and is a Google service. Accuracy is materially worse than `base.en`.
- **Pause detection, per-section durations, the pace chart.** All three came from the accurate
  re-pass over the recording, and there is no local decoder to run it.
- **The LAN co-prep fallback.** Realtime only. A room with no internet has no co-prep, and the
  panel offers one transport rather than one that always fails.
- **Offline anything.** Local-first is a desktop property now. A browser with no connection
  cannot open a case.
- **The OS keychain.** The session is in `localStorage`, so clearing site data starts a new
  anonymous identity — which is exactly what the email in the Account panel is for.
