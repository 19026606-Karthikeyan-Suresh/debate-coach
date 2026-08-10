# Debate Coach

A local-first desktop app for competitive parliamentary debate. It helps a debater prep a case
faster, find the holes in their arguments before a judge does, and deliver a speech without
skipping words — for Asian Parliamentary and British Parliamentary formats.

Built around a real Word template a friend uses, mirrored 1:1 in the data model, so what you fill
in on screen is what you would have written on paper.

---

## The three problems it solves

| Problem | Feature |
|---|---|
| Prep is slow and cases end up half-filled | **Case Builder** — the template as a keyboard-first editor, with a prep timer and a per-seat completeness meter |
| Substantives are surface-level | **Depth Analyzer** — ten offline heuristics that always run, plus opt-in Socratic coaching from Claude |
| Words get skipped while speaking | **Speech Trainer** — a teleprompter that follows what you actually said, and a report naming every clause you dropped |

### The insight the whole app turns on

The template's Speaker 3 section is fill-in-the-blank prose:

> "In ___ Prop told us ___. But my first speaker told you that this was not true because ___"

So **a filled case compiles into deliverable speech text automatically.** The case builder and the
speech trainer are two ends of one pipeline, not two separate tools — which is why the script
compiler landed before any speech UI. The reference case compiles to a 1060-word first speech,
6:38 of a 7:00 slot.

---

## Features

- **Case Builder** — every block keyed to the docx tables, role-scoped so a whip is not shown a
  DEFINITION table they do not fill. Tab through fields in template order, `Ctrl+Enter` for the
  next section. Debounced SQLite autosave.
- **Prep timer** — format-aware (BP 15 min, AP 30 min) with pacing nudges that name the next
  blank row. The length is editable and remembered per format; changing it mid-prep shifts the
  clock by the difference rather than restarting, because that is what "five more minutes" means.
- **Depth Analyzer** — causal-chain depth, missing impact axes, vague actors, substantive overlap,
  comparative weighing, link-back and more, as wavy underlines plus a depth panel. Never fires on
  an empty field; that is the completeness meter's job.
- **Claude coaching (opt-in, and off by default)** — `audit` scores a substantive and asks a
  question about each axis, `attack` writes the opposition's three strongest responses, `poi`
  predicts what the other bench will offer. Socratic by JSON schema, not by prompt wording: there
  is no field in the schema to write your argument into. The panel does not appear unless
  `VITE_ENABLE_COACH` is set — see [Claude coaching](#claude-coaching).
- **Speech Trainer** — whisper.cpp transcribes live, a streaming Needleman–Wunsch aligner marks
  each script word spoken / skipped / pending, and the teleprompter follows your actual position.
  Format-aware timer with the POI window shaded and knocks at 1:00 and 6:00.
- **Script editing** — the compiled speech is editable line by line, and rewrites are stored
  apart from the case so editing a field in Prep recompiles everything around them and leaves
  them alone. A line can also be dropped from delivery outright.
- **Report and history** — skipped words grouped into runs that never cross a field, each named by
  the template row it came from; pace, fillers, pauses over 2 s, time per section. Charted across
  sessions.
- **Recording playback** — the speech encoded to Ogg Opus (~a tenth the WAV), scrubable, with a
  coach's timestamped comments appearing inline at the second they refer to.
- **Team layer** — anonymous sign-in, invite-code teams, a shared searchable library, and a sync
  queue that drains when the network comes back.
- **Live co-prep** — two debaters write one case at once over Supabase Realtime, or over the local
  network with no internet at all. Each keeps their own seat.
- **Export** — `.docx` in the template's own layout, `.dbcase` for another install, and a
  printable speech sheet.

---

## Stack

**Desktop shell** — [Tauri v2](https://tauri.app) (Rust). One installer, ~10 MB shell, no Electron.

**Frontend** — React 19, TypeScript 5.9, Vite 8, Tailwind v4.

**Local store** — SQLite via `tauri-plugin-sql`. **The source of truth is the local database**;
everything except refreshing the team library works with no network.

**Speech** — [whisper.cpp](https://github.com/ggml-org/whisper.cpp) v1.9.2 as a sidecar.
`base.en` live for teleprompter alignment, `small.en` re-transcribes afterwards so the report is
built from the accurate transcript.

**Collaboration** — [Yjs](https://yjs.dev) CRDT, keyed by the same field paths the editor uses.

**Team sync** — Supabase (Postgres + RLS + Realtime + Storage), optional. A replication target,
never a dependency.

**AI** — the Anthropic API (`claude-opus-5`), opt-in. Offline heuristics always run.

### Rust crates, and why these ones

| Crate | Instead of | Why |
|---|---|---|
| `reqwest` + `native-tls` | rustls / aws-lc-rs | The default TLS stack needs cmake and NASM on Windows. `native-tls` is schannel here — no C toolchain between a teammate and a build. |
| `keyring` (`windows-native`) | `tauri-plugin-stronghold` | Holds the **Supabase session** (the Anthropic key moved to an env var). Stronghold needs a password to unlock a file, so it is a second password every launch or a hardcoded one. Windows already unlocks a per-user secret store at login. |
| `opus-rs` | `audiopus_sys` / any binding | Every binding crate builds libopus and wants cmake. This is a pure-Rust port — cargo alone. |
| `std::net` | `y-webrtc` | WebRTC needs signalling that already exists; `y-webrtc` defaults to servers on the internet, which a room with no internet does not have. The LAN fallback is a relay in the shell. |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  React 19 webview                               │
│                                                 │
│  case/ ── analysis/ ── script/ ── speech/       │  pure TypeScript,
│    │         │           │          │           │  node-testable
│    └─────────┴───────────┴──────────┘           │
│                   │                             │
│              collab/  (Yjs)                     │
└───────────────────┼─────────────────────────────┘
                    │  Tauri IPC
┌───────────────────┼─────────────────────────────┐
│  Rust shell                                     │
│  whisper · audio · opus/ogg · coach · export    │
│  sync (keychain) · lan (relay) · db (SQLite)    │
└───────────────────┼─────────────────────────────┘
                    │
              SQLite  ←── source of truth
                    │
              Supabase  ←── replication target, optional
```

Three properties hold everywhere:

1. **Local-first.** Pull the network out and case building, analysis, transcription, alignment,
   reporting and export all still work. Edits queue and drain on reconnect.
2. **The secret stays in Rust.** The Anthropic key never reaches the webview and is never logged.
3. **Nothing identifying leaves unasked.** Recordings and transcripts stay local until you press
   a button. The Postgres schema has no `report` column and no local file paths, deliberately.

---

## Getting started

### Prerequisites

| | Version | Notes |
|---|---|---|
| Windows | 11 | The only target built and tested. `rust-toolchain.toml` pins `x86_64-pc-windows-msvc`. |
| Node | ≥ 24 | Pinned by `.nvmrc`. `engines` in `package.json` enforces it. |
| npm | ≥ 11 | |
| Rust | 1.97.1 | Pinned by `rust-toolchain.toml`; rustup reads it automatically. |
| WebView2 | — | Ships with Windows 11. |

Also needed by Tauri: the **MSVC build tools** with the Windows SDK
([Tauri's prerequisites](https://tauri.app/start/prerequisites/)).

### Install and run

```bash
npm install
```

```bash
npm run tauri dev
```

That is the whole setup. The app opens with an empty library, creates its SQLite database on
first run, and works — no account, no key, no network.

> `npm run dev` alone gets you a blank screen. The frontend calls `Database.load` from
> `tauri-plugin-sql`, which only exists inside the shell. Use `npm run tauri dev`.

---

## Optional setup

Each of these turns on one feature. **None of them is required**, and the app says which mode it
is in rather than failing quietly.

### Speech transcription (~640 MB, one time)

The whisper binary and its two models are not in git.

```bash
powershell -ExecutionPolicy Bypass -File scripts/fetch-whisper.ps1
```

They install to `%APPDATA%\com.kartixc.debatecoach\whisper\`, which is where a dev run resolves
them. Pass `-SkipSmall` to fetch only `base.en` (148 MB): live transcription still works, and the
accurate post-speech re-pass falls back to the worse model.

Without this, the Speak screen falls back to the browser's speech recogniser and says so.

Measured on a 4-thread laptop: `base.en` ~6.5× real time, `small.en` ~1.9×, so a seven-minute
speech re-transcribes in about three and a half minutes — which is why the live report appears
first and the accurate one replaces it.

### Team sync and co-prep

1. Create a Supabase project.
2. Copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Paste [`supabase/apply-all.sql`](supabase/apply-all.sql) into the dashboard's SQL editor and
   run it — that is all six migrations in order, and it is safe to run twice.
4. Enable **anonymous sign-ins** under Authentication → Providers.

Both `.env` values are read at build time, so changing them means restarting the dev server.
**Neither is a secret** — the anon key is designed to ship inside a client, and what it can reach
is decided by the RLS policies. See [`supabase/README.md`](supabase/README.md).

### Claude coaching

**Off by default — the panel does not appear at all.** Two switches, deliberately separate:

```
VITE_ENABLE_COACH=true      # in .env — makes the panel exist
ANTHROPIC_API_KEY=sk-ant-…  # the key itself, read by the Rust shell
```

The flag is separate from the key because `ANTHROPIC_API_KEY` is a de-facto standard that is
often already exported for other tools, and a panel that switched itself on because of somebody
else's environment — then made billed calls from a prep screen — is a surprise nobody asked for.
Turning Layer B on is a decision, so it gets its own switch.

Note the flag *is* `VITE_`-prefixed and the key is not. That is not an inconsistency: Vite inlines
prefixed values into the frontend bundle, which is right for a boolean the UI needs and
disqualifying for a secret.

For the key, set it and restart the app:

```bash
setx ANTHROPIC_API_KEY "sk-ant-..."
```

Or, for a dev run, add it to `.env` — there is a commented slot in `.env.example`. A real
environment variable is the better of the two: `.env` is plaintext on disk, and in this project's
case inside a OneDrive-synced folder.

**Never name it `VITE_ANTHROPIC_API_KEY`.** Vite inlines anything prefixed `VITE_` into the
frontend bundle at build time, which would write the key into the webview's JavaScript and ship
it inside the installer. Without the prefix it is invisible to Vite and is read only by the Rust
shell, which is what makes the request. There is no command that accepts a key and none that
returns one, so it never reaches the webview at all.

The variable is read at launch, so a change needs the app restarting — the panel says so rather
than leaving you pressing a button that cannot work.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run tauri dev` | The app, with hot reload |
| `npm run tauri build` | A release `.msi` and `.exe` installer |
| `npm run dev` | Vite alone — blank screen without the shell, see above |
| `npm test` | The TypeScript suite (`vitest run`) |
| `npm run test:watch` | The same, watching |
| `npm run lint` | ESLint, including the docstring rules |
| `npm run typecheck` | `tsc --noEmit` |

To bundle whisper into the installer, opt in at release time:

```bash
npm run tauri build -- --config tauri.bundle-whisper.conf.json
```

`tauri.conf.json` deliberately omits `bundle.externalBin`: Tauri validates it at build time, so
declaring a binary that is not on disk would break `cargo build` for anyone who has not first
downloaded 640 MB of models.

---

## Project layout

```
src/
  types/        the data model — a 1:1 mirror of the docx, labels verbatim
  formats/      AP and BP presets: seats, speech lengths, POI windows
  case/         field registry, section projection, completeness, immutable edits
  analysis/     Layer A — ten offline depth heuristics (pure)
  coach/        Layer B — prompts, JSON schemas, the Socratic guard (pure)
  script/       the compiler: a filled case -> deliverable speech text
  speech/       aligner, normaliser, timer, metrics, report (all pure)
  script/edits  per-segment delivery rewrites, laid over the compiled script (pure)
  collab/       the Yjs document, room protocol, presence (pure + one Y.Doc)
  sync/         Supabase client, dirty-row queue, library, the two co-prep wires
  export/       ZIP writer, OOXML, .docx / .dbcase / speech sheet (pure)
  db/           SQLite queries
  hooks/        one per screen's worth of state
  components/   the three screens: Prep, Speak, Review

src-tauri/src/
  whisper.rs    sidecar lifecycle, rolling-window worker, event channel
  audio.rs      PCM buffer, WAV writer, adaptive pause detection
  opus.rs       WAV -> Ogg Opus          ogg.rs   the container, by hand
  coach.rs      Anthropic proxy, key in the OS keychain
  export.rs     extension-checked file writes
  sync.rs       the Supabase session, chunked across credential entries
  lan.rs        UDP discovery + TCP relay, for a room with no internet
  db.rs         SQLite migrations

supabase/migrations/   schema, RLS, team functions, storage, delete_team, co-prep rooms
reference/             the source Word template, and a real filled example
```

---

## Testing

```bash
npx vitest run
```

907 TypeScript tests across 44 files, plus 68 Rust tests:

```bash
cd src-tauri && cargo test
```

The environment is **node, with no jsdom**, and `test.include` matches `.test.ts` only. That is
deliberate: logic lives in pure modules and is tested directly, while UI is verified by driving
the running app. A component test named `.test.tsx` would be silently never run.

Three conventions the suites hold to, each learned the hard way:

- **Every analyzer rule ships with a false-positive test** — a heuristic that cries wolf gets
  ignored, which is worse than not having it.
- **Every voice rule in the Claude guard ships with an example it must let through** — a guard
  that eats honest questions makes the panel look broken.
- **Every RLS denial is paired with a permitted read**, and every convergence assertion runs two
  documents across a wire the test can take down. A policy that denies everything passes half a
  security test and fails the product; a merge cannot be checked by reading it.

The RLS suite applies the shipped migration files, byte for byte, to a real PostgreSQL — PGlite,
Postgres 18 compiled to WebAssembly. No Docker and no project needed:

```bash
npx vitest run src/sync
```

Before committing, all five:

```bash
npx tsc --noEmit && npm run lint && npx vitest run && cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
```

---

## Code conventions

Enforced by ESLint (`jsdoc/require-jsdoc`, `require-param-description`, `id-length`) and
`#![warn(missing_docs)]` + clippy.

- **No single-letter names** — not loop counters, not lambda params, not generics. `scriptIndex`
  not `i`, `Finding<TRule>` not `Finding<T>`. Booleans read as assertions: `hasCausalChain`.
- **A docstring on every exported function, type and Rust public item.** For each argument, say
  what happens if you pass the wrong thing — not what the type already says.
- **Comment the reason, the constraint, or the surprise.** Never what the next line says.
- **Get to the point.** Terse and direct.

[`PLAN.md`](PLAN.md) holds the full architecture, the data model, and a "what the build settled"
section per part recording where the implementation departed from the plan and why. Read those
before re-deriving a decision.

---

## Status

All eleven phases of the build order are complete. What that does **not** mean:

- **No microphone has ever been through the speech path.** Whisper's parser, the window-commit
  logic, the aligner and the pause detector are unit-tested, and the UI has been driven against a
  synthetic delivery — but audio has only ever gone in as a file.
- **No Anthropic call has been made.** The schema, the guard and the panel are covered by 59
  tests; nothing has yet been billed a token, so it is unknown whether high effort is tolerable
  against a 15-minute prep clock.
- **No second machine.** Co-prep converges between two clients over the real wire, and the
  recording round trip works — but both ran on one install, so a teammate's keystrokes have never
  actually reached another computer's screen.
- **The release installer has never been built.**
- **There is no CI.** The lint and docstring rules are real and enforced by `npm run lint`, but
  nothing runs them automatically on push.

Honest limitations rather than a roadmap: this is a personal tool, built for one debater, and the
gaps are recorded so nobody trusts a number that was never measured.

---

## Licence

None yet — all rights reserved by default.

`reference/template-blank.docx` and `reference/template-filled-example.docx` are **not mine**:
they are a friend's prep template and a real filled case, included with permission for use as a
fidelity fixture. They are not covered by any licence granted here, and should not be
redistributed.
