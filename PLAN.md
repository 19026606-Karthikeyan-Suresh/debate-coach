# Debate Coach — Tauri desktop app with Supabase team sync

## Context

I want to get better at debate. Three things are holding me back:

1. **I struggle to write information down correctly** during prep — the paper template is slow and I keep leaving it half-filled.
2. **I skip words when I speak** — a delivery problem.
3. **My substantives are subpar and surface-level** — my weakest area, and the one I most want fixed.

A friend gave me an Asian Parliamentary / WSDC-style Word template (`reference/template-blank.docx`): prep sheet (motion, actors split, 5W1H, mechanism y/n, POI list), case setup, Speaker 1 (definition + policy + substantives), Speaker 2 (rebuttal + sub 3), Speaker 3 (opposing-team rebuttals + a two-clash script with fixed slot phrasing).

Two properties of that template drive the whole design:

- Its 9-row substantive table is already an argument-quality scaffold — problem → why bad (impact) → underlying cause (mechanism) → solution → causal link → counterfactual → example → link-back. My depth rubric falls straight out of it.
- Its Speaker 3 section is **literally fill-in-the-blank prose** ("In ___ Prop told us ___. But my first speaker told you that this was not true because ___"). So a filled case compiles into deliverable speech text automatically — exactly what the teleprompter needs. The case builder and the speech trainer are two ends of one pipeline, not two separate apps.

**Decisions I've made:** Tauri desktop app; bundled whisper.cpp with `base.en` live and `small.en` for the post-speech report; offline heuristics always on with Claude as an opt-in layer; AP and BP formats; Socratic coaching only. Supabase for the team layer, syncing cases, motions, recordings, and metrics, with team invite codes for sign-in.

The three-screen mockup (Prep / Speak / Review) is the layout spec.

Environment: Windows 11, Node 24, npm 11, Python 3.13, git. Phase 0 is done — repo initialised, toolchain pinned, tooling venv created. Rust still needs installing before Tauri will build.

---

## Architecture: local-first, server-synced

SQLite in the Tauri app is the **source of truth**. Supabase is a replication target, not a dependency. Everything except refreshing the team library works with no network — case building, analysis, transcription, alignment, reporting. A sync queue drains when connectivity returns.

| Concern | Mechanism |
|---|---|
| Team library | Postgres with a generated `tsvector` + GIN index — server-side full-text search across the whole team's cases and motions |
| Live co-prep | Yjs CRDT over Supabase Realtime broadcast, one channel per case |
| Identity | Supabase anonymous sign-in → persistent `auth.uid()` stored in the Windows credential store |
| Membership | `join_team(code)` Postgres function, `SECURITY DEFINER`, validates a hashed invite code and inserts a `team_members` row |
| Access control | RLS on every table, keyed off `team_members`; `visibility = 'private'` restricts to owner |
| Recordings | Opus-encoded, uploaded to Supabase Storage in the background |

**Why anonymous auth rather than passwordless email:** it gives each install a real, stable user id — so edits are attributable, presence works in co-prep, and a recording belongs to a person — while onboarding a squad before a tournament is still just typing a code.

**The honest tradeoffs.** A leaked invite code lets anyone into the team until it's rotated, and anonymous identity means the app can't verify who someone actually is — so the schema includes code rotation, an admin role that can revoke members, and per-case `visibility` so sensitive prep can stay local. Supabase pauses free projects after 7 days of inactivity; for seasonal use, either unpause from the dashboard, keep it warm with a scheduled ping, or move to the $25/month tier.

**Recordings are encoded before upload.** Seven minutes of 16 kHz mono WAV is ~13 MB; the same speech as Opus at 24 kbps is ~1.2 MB. The WAV stays local for re-transcription, the Opus goes to the server. That's the difference between filling the free tier in 70 speeches and filling it in 800.

**Bad-wifi fallback.** Prep rooms have notoriously poor connectivity, which is exactly when co-prep matters most. Supabase Realtime is the default transport; `y-webrtc` over the local network is the fallback for a room with no internet. Same CRDT either way — only the provider swaps. Built last.

---

## Stack

- **Tauri v2** shell (Rust), **React 19 + TypeScript + Vite** frontend, Tailwind v4. One installer per teammate; ~10 MB shell.
- **SQLite** via `tauri-plugin-sql` — local source of truth, and full-text search over the cached library when offline.
- **Yjs** for the case document from day one, so collaboration is a provider toggle rather than a rewrite.
- **Supabase JS** for sync, realtime, storage; service-role operations never leave Rust.
- **whisper.cpp** as a Tauri sidecar binary.
- **Rust side**: sidecar lifecycle, audio piping, Opus encoding, Anthropic proxy with the key in the OS keychain (`tauri-plugin-stronghold`), sync queue.
- **Vitest** for the analyzer and aligner; both pure TypeScript.

### Supabase schema

```sql
teams(id, name, invite_code_hash, created_at)
team_members(team_id, user_id, display_name, role)      -- member | coach | admin
cases(id, team_id, owner_id, motion, format, side, position,
      doc jsonb, ydoc_state bytea, visibility, updated_at, search tsvector)
motions(id, team_id, text, tournament, date, source)
sessions(id, team_id, user_id, case_id, format, role,
         duration_s, metrics jsonb, recording_path, created_at)
comments(id, session_id, author_id, t_seconds, body)     -- coach feedback anchored to a timestamp
```

`ydoc_state` is persisted periodically so someone joining a co-prep room late gets the document without a peer online. `comments` is the payoff for uploading recordings — a coach scrubs to 4:12 and leaves a note there.

---

## Part 1 — Case Builder

### Format registry — `src/formats/index.ts`

```ts
type SpeakerRole = { id: string; label: string; side: string; blocks: BlockId[] }
type Format = {
  id: 'AP' | 'BP'
  speechSeconds: number
  replySeconds: number | null
  poiWindow: [number, number]   // protected time before/after, in seconds
  roles: SpeakerRole[]
}
```

- **AP**: PM, DPM, Whip (Gov) / LO, DLO, Whip (Opp) + reply. 7 min, 4 min reply, POIs 1:00–6:00.
- **BP**: OG (PM, DPM), OO (LO, DLO), CG (MG, GW), CO (MO, OW). 7 min, no reply, POIs 1:00–6:00. CG/CO surface an **extension** field — the template's Speaker 3 script already says "this is my extension because ___", so the clash builder maps onto the whip speech cleanly.

### Data model — `src/types/case.ts`

Every block keyed to the docx tables 1:1; every field with a stable id so analyzer findings, teleprompter positions, and CRDT updates can all address it.

```ts
interface Substantive {          // the 9 rows from SUBSTANTIVE STRUCTURE
  oneSentence, problem, whyBad, whyExists, howSolve,
  howThisSolves, counterfactual, example, link: string
  preempts: Preempt[]            // new: my answers to generated opposition attacks
}
interface Case {
  id, createdAt, updatedAt, format, side, position, visibility
  prep: { motion, actorsSplit, fiveW1H, needsMechanism, scratch, pois }
  setup: { characterisation, burdens, policy, stance, caseDivision }
  definition: DefinitionBlock          // 4 rows
  policy: PolicyBlock | null           // 5 rows
  substantives: Substantive[]
  policyRebuttal: PolicyRebuttalBlock  // 4 rows
  rebuttals: RebuttalBlock[]           // 7 rows each
  opposingRebuttals: OpposingRebuttalBlock[]  // 6 rows each
  clashes: Clash[]                     // Speaker 3 / whip
}
```

Text fields are `Y.Text` inside a `Y.Doc`, with a plain-object projection for the analyzer, export, and the `doc jsonb` column.

### UI — `src/components/`

- `TemplateTable.tsx` renders any block's rows as labeled fields, using the **exact template question as the label** plus a one-line hint on what a good answer does.
- Keyboard-first: Tab between fields, `Ctrl+Enter` to the next section.
- **Prep timer** with format-aware duration (BP 15 min, AP 30 min) and pacing nudges — "4 min left, Sub 2 has no mechanism yet."
- **Completeness meter** per role.
- **Library** — my cases plus the team's, searched server-side when online and against the SQLite cache when not.
- **Export** — `.docx` in the original template layout, `.dbcase` JSON, print/PDF speech sheet.

---

## Part 2 — Depth Analyzer

### Layer A — offline heuristics (`src/analysis/`, always on)

Pure TypeScript, debounced on keystroke. Each rule returns `Finding[]`: `{ fieldPath, severity, span?, rule, message, socraticPrompt }`, rendered as inline underlines plus the depth panel.

| Rule | What it catches |
|---|---|
| `causalChain` | Longest run of linked causal connectives (`because`, `which means`, `this leads to`). Depth 0 = bare assertion, 3+ = deep. **The single most diagnostic signal for surface-level writing.** |
| `assertionWithoutMechanism` | Evaluative sentences (`this is bad`, `devastating`) with no causal connective in the same or next sentence. |
| `vagueness` | Vague nouns/quantifiers (`people`, `society`, `lives`, `a lot`) vs specificity markers (numbers, %, dates, named institutions). |
| `impactAxes` | Does the sub address magnitude, probability, reversibility, timeframe? Missing axes become prompts. |
| `comparativeWeighing` | Counterfactual/comparison language (`without this`, `status quo`, `even if`, `worse than`). A sub with none cannot win a close round. |
| `stakeholderCoverage` | Cross-field: do the actors I named in 5W1H appear in the substantive? |
| `subOverlap` | Jaccard over content-word sets between every pair of substantives. Flags "Sub 2 is Sub 1 restated." |
| `hedgeAndFiller` | `basically`, `kind of`, `very`, `really`, `just`. |
| `linkBack` | Do the `link` fields contain the motion's key content words? |
| `sentenceLength` | Sentences over ~35 words in speech-destined fields — feeds straight into the delivery problem. |

Shared helpers in `text.ts` and `lexicons.ts` keep rules small and individually testable.

### Layer B — Claude audit (`src-tauri/src/coach.rs` + `src/coach/`, opt-in)

Activates when an Anthropic API key has been saved to the OS keychain. Uses **`claude-opus-5`** — thinking is on by default on Opus 5, so send no `thinking` param; set `output_config.effort: "high"` and `max_tokens: 16000`.

- `audit` — scores one substantive on mechanism / impact / comparative / evidence / link-back, returns **only questions**.
- `attack` — the three strongest opposition responses to this sub, phrased as an opponent would say them, which I then answer in the `preempts` fields. Highest-leverage feature in the app.
- `poi` — likely POIs, to fill the template's POI list.

**The Socratic constraint is enforced structurally.** Requests use `output_config.format` with a JSON schema whose only fields are questions and missing-axis labels — no free-prose field the model could write my argument into. A validation pass rejects responses whose question strings exceed a length threshold or contain first-person argumentative phrasing.

---

## Part 3 — Speech Trainer

### Script compiler — `src/script/compile.ts`

The bridge between the two halves.

- **Speaker 3 / whip**: direct slot-filling into the template's existing prose skeleton.
- **Speaker 1 / 2**: generated from substantive fields via signpost templates.
- Output is `ScriptSegment[]` — `{ id, sectionId, text, tokens }` — so teleprompter, timer, and report reference the same positions, and a skipped word traces back to the case field it came from.

Compiled scripts stay editable; edits are stored separately so re-editing the case doesn't clobber delivery tweaks.

### Whisper sidecar — `src-tauri/`

- `whisper.cpp` compiled for Windows, declared under `bundle.externalBin`; `ggml-base.en.bin` and `ggml-small.en.bin` in `bundle.resources`. One installer, nothing for a teammate to download or compile.
- **Live path**: Web Audio API captures mic → 16 kHz mono PCM → Tauri command streams to the `whisper-stream` sidecar's stdin → partial transcripts return over a Tauri event channel. `base.en` stays comfortably real-time on CPU.
- **Report path**: the speech is saved as WAV; afterwards `whisper-cli` re-transcribes with `small.en`, alignment is recomputed, and the report is built from the better transcript. The numbers I keep are the trustworthy ones.
- Rust encodes the WAV to Opus for upload; the WAV stays local.
- `TranscriptionSource` interface with `WhisperLiveSource` primary and `WebSpeechSource` retained as a fallback if a sidecar fails to launch.

### Alignment — `src/speech/align.ts`

The core algorithm, and the thing that actually fixes the skipping.

- Streaming **Needleman–Wunsch DP** over a sliding window anchored at a moving cursor.
- Classifies every script token as `spoken`, `skipped`, or `pending`, and every unmatched transcript token as `added` (improvised).
- **Normalization before matching** (`normalize.ts`): lowercase, strip punctuation, expand numerals, plus a phonetic key (Double Metaphone) so transcription errors don't register as skips. Without this the feature cries wolf and I stop trusting it.
- **Re-anchoring**: a long unmatched run widens the search window and re-scans — handles jumping sections, restarting a sentence, or answering a POI mid-speech.
- Pure function, no DOM, no async, heavily unit-tested.

### Teleprompter, timer, report — `src/components/speech/`

- **Teleprompter** auto-scrolls to the *aligned* position, not at a fixed rate. Spoken text dims, skipped words strike through red, improvisations highlight, upcoming text stays full contrast.
- **Timer** is format-aware: protected-time bar with the POI window shaded, knocks at 1:00 and 6:00, 30-second warning, hard stop, grace period.
- **Report** — skipped words grouped by section and linked back to their case field; pace over time; fillers and pauses >2 s with timestamps; time per section vs plan; improvised additions offered for saving back into the case.
- **Playback with comments** — scrub the recording, and a coach's timestamped notes appear inline.
- **Session history** charts skip rate, filler rate, and pace across sessions, mine and the team's.

### Free-speech mode

No script loaded: transcribe an opponent's speech, then optionally have Claude flow it into the rebuttal-table structure. Doubles as a live-flowing tool.

---

## Files to create

```
supabase/
  migrations/*.sql         schema, RLS policies, join_team(), rotate_invite_code()
src-tauri/
  tauri.conf.json          externalBin: whisper sidecars; resources: ggml models
  Cargo.toml
  src/main.rs, lib.rs
  src/whisper.rs           sidecar lifecycle, PCM stdin, event emit
  src/audio.rs             WAV capture, Opus encode
  src/coach.rs             Anthropic calls, keychain-backed key
  src/sync.rs              offline queue, upload/download, conflict handling
  src/db.rs                SQLite migrations
src/
  main.tsx, App.tsx
  types/case.ts            data model
  formats/index.ts         AP + BP presets
  db/index.ts              SQLite queries, Yjs doc <-> row projection
  sync/supabase.ts         client, auth, join_team, library queries
  sync/provider.ts         Yjs over Realtime; y-webrtc LAN fallback
  analysis/index.ts        runAnalysis(case) -> Finding[]
  analysis/text.ts, lexicons.ts, rules/*.ts
  script/compile.ts        Case -> ScriptSegment[]
  speech/recognition.ts    TranscriptionSource, WhisperLiveSource, WebSpeechSource
  speech/align.ts          streaming DP aligner (pure)
  speech/normalize.ts      lowercase / punct / numerals / phonetic key
  speech/fillers.ts, metrics.ts
  components/              CaseEditor, TemplateTable, FieldEditor, DepthPanel,
                           PrepTimer, CompletenessMeter, Library, TeamSetup
  components/speech/       Teleprompter, SpeechTimer, LiveTranscript,
                           SpeechReport, Playback, SessionHistory
  export/docx.ts, dbcase.ts, speechSheet.tsx
  **/__tests__/*.test.ts
```

**Build order.** Each phase is usable on its own, and each ends in a commit:

0. ~~Project scaffold, pinned toolchain, git~~ — done
1. Tauri scaffold + SQLite + formats + data model
2. Case Builder UI
3. Analyzer Layer A
4. Script compiler *(the hinge — lands before any speech UI)*
5. Whisper sidecar + aligner + teleprompter + timer
6. Report + session history
7. Claude Layer B
8. Export + `.docx` / `.dbcase`
9. Supabase: schema, RLS, invite-code join, library sync, recording upload
10. Coach comments on recordings
11. Live co-prep over Realtime, then the y-webrtc LAN fallback

---

## Code conventions

Enforced, not aspirational: ESLint `jsdoc/require-jsdoc` + `require-param-description` for TypeScript, `#![warn(missing_docs)]` for Rust. CI fails on a missing docstring.

### Naming

No single-letter names anywhere — not loop counters, not lambda parameters, not generics. A reader should know what a variable holds without scrolling up.

```ts
// no
const t = s.split(/\s+/).map(w => n(w))
for (let i = 0; i < r.length; i++) { ... }

// yes
const spokenTokens = transcript.split(/\s+/).map(word => normalizeToken(word))
for (let scriptIndex = 0; scriptIndex < scriptTokens.length; scriptIndex++) { ... }
```

Generics get real names too: `Finding<TRule>` not `Finding<T>`. Booleans read as assertions — `hasCausalChain`, `isProtectedTime` — never `flag` or `check`.

### Docstrings

Every exported function, type, and Rust public item. State what it does and why each argument exists — an argument's docstring explains what happens if you pass the wrong thing, not what its type already says.

**Get to the point.** Terse and direct, not descriptive prose.

```ts
/**
 * Finds the longest chain of linked causal steps in a passage.
 * Depth 0 means bare assertion; 3+ means the argument survives a judge asking "why" three times.
 *
 * @param passage - One substantive field. Multi-sentence is expected; chains cross sentence boundaries.
 * @param connectives - Causal markers to match. Pass a trimmed set to test a single family in isolation.
 * @returns Depth, plus the span of the longest chain so the UI can underline it.
 */
export function measureCausalChain(passage: string, connectives: Connective[]): CausalChainResult
```

Not: *"This function is responsible for taking in a piece of text and carefully analysing it in order to determine the various causal connectives that may be present."* Say what it does, then stop.

Rust uses `///` with the same rule, and `# Errors` / `# Panics` sections where either is possible.

```rust
/// Streams 16 kHz mono PCM to the whisper-stream sidecar and emits partial transcripts.
///
/// * `sample_rate` — must be 16000; whisper.cpp resamples nothing and silently produces garbage otherwise.
/// * `model_path` — resolved from bundle resources, not user input. Callers never build this by hand.
///
/// # Errors
/// Returns `WhisperError::SidecarUnavailable` if the binary is missing from the bundle,
/// which is the signal to fall back to `WebSpeechSource`.
pub fn stream_transcription(sample_rate: u32, model_path: &Path) -> Result<Receiver<Partial>, WhisperError>
```

### Comments

Two jobs, and only these two:

1. **Every non-obvious variable at its declaration** — what it holds, in a fragment.

```ts
// Cursor into scriptTokens; only ever moves forward except on re-anchor.
let alignmentCursor = 0

// Tokens seen since the last confident match. A long run here triggers a wider re-anchor scan.
let unmatchedRun: string[] = []
```

2. **A header block before any chunk over ~15 lines** — the overall process, so a reader can skip the body.

```ts
// Three passes:
//   1. normalize both sides (case, punctuation, numerals, phonetic key)
//   2. DP-align the window around alignmentCursor
//   3. classify every script token as spoken / skipped / pending
// Re-anchoring lives in step 2 — if the best local score falls below RE_ANCHOR_THRESHOLD
// the window widens and rescans before we accept any classification.
```

Never comment what the next line already says. `// increment the counter` is noise. Comment the reason, the constraint, or the surprise — the magic number, the ordering dependency, the API quirk that had to be worked around.

---

## Agents

Nine `.claude/agents/*.md` definitions. Each is narrow enough that a cold agent with no conversation context does it well, and each maps to work that recurs across the build.

```markdown
---
name: analyzer-rule
description: Writes a new depth-analysis rule for src/analysis/rules/. Use when adding
  or revising any heuristic in the analyzer table. Knows the Finding contract and the
  requirement that every rule ships with a false-positive test.
model: sonnet
tools: Read, Write, Edit, Grep, Glob, Bash
---
```

| Agent | Phase | Job | Model |
|---|---|---|---|
| **template-fidelity** | 1–2 | Guards the 1:1 mapping to the docx. Every field label must match the template question verbatim; nothing silently dropped. Re-extracts the docx and diffs against the data model. | sonnet |
| **analyzer-rule** | 3 | Writes one heuristic rule at a time against the `Finding` contract, reusing `text.ts` and `lexicons.ts`. Each rule ships with tests including **a false-positive case** — a rule that fires on good writing is worse than no rule. | sonnet |
| **aligner-tester** | 5 | Adversarial. Its job is to *break* `align.ts`: homophones, restarted sentences, section jumps, POI interruptions, ASR dropout, filler storms. Generates synthetic transcripts and asserts exact token classifications. | opus |
| **whisper-bench** | 5 | Empirical. Measures live latency and word error rate for `base.en` vs `small.en` on real recordings; tunes chunk size and window overlap. Reports numbers, doesn't guess. | sonnet |
| **rust-sidecar** | 5 | Tauri v2 specifics — `externalBin`, `bundle.resources`, capability and permission JSON, sidecar spawn, stdin piping, event channels. Version-specific and fiddly; worth isolating from app logic. | opus |
| **prompt-guard** | 7 | Red-teams the Socratic constraint. Actively tries to make Layer B write my argument, and verifies the JSON schema plus the validator both hold. Runs on every prompt change. | opus |
| **supabase-rls** | 9 | Writes migrations and *proves* the policies by attempting cross-team reads from a second identity. Security-critical and quietly easy to get wrong. Never marks a policy done without a failing-read test. | opus |
| **crdt-sync** | 11 | Yjs document shape, the doc↔row projection, provider wiring, offline queue reconciliation, and convergence tests under partition. | opus |
| **doc-comment-auditor** | all | Enforces the conventions above on changed files: missing docstrings, single-letter names, argument descriptions that only restate the type, comments that narrate the next line. Runs before commit. | sonnet |

**Not agents.** The Case Builder UI, the script compiler, and the export path are one-off, highly interdependent, and easier to hold in one head than to brief — build those inline.

---

## Verification

1. `npx vitest run` — every analyzer rule and every aligner case has unit tests.
2. **Regression fixture from real work.** Seed the fake-news case from my friend's filled example (`reference/template-filled-example.docx`). It has genuine, checkable defects the analyzer must catch:
   - `subOverlap` flags Sub 1 ("fake news causes irreparable damage") against Sub 2 ("allowing the spread is supporting it") — they share most of their content vocabulary.
   - `vagueness` flags "damages lives", "individuals in society", "many damages".
   - `impactAxes` flags Sub 1 as missing probability and timeframe.
   - Sub 2's `howThisSolves` and both subs' `example`/`link` are empty → completeness meter shows the gap.
3. **Aligner tests without a microphone** — synthetic transcripts against a known script: verbatim, dropped clause, improvised insertion, homophone (`their`/`there`), restarted sentence, jump from Sub 1 to Sub 3. Assert exact skipped/added token sets.
4. `npm run tauri dev` → build a case end-to-end: BP + CG, fill Sub 1, confirm inline underlines and depth-panel findings appear.
5. **Whisper sidecar check** — `base.en` transcribes live with the teleprompter keeping pace during fast delivery; the `small.en` post-pass produces a different and better transcript that the report is built from.
6. Deliberately skip a sentence mid-speech; confirm it strikes through live and lands in the report linked to its case field.
7. **Offline test** — disable networking entirely. Case building, analysis, transcription, alignment, and reporting all still work; edits queue and drain on reconnect. Only the Claude button and library refresh degrade.
8. `npm run tauri build` → install the `.msi` on a second machine with no dev tools; confirm speech capture works with zero setup.
9. With an API key saved: run `attack` on a substantive, confirm three opposition responses come back and that no returned field contains a written-out argument for my own motion.
10. **RLS test** — join two teams with different codes from two installs and confirm neither can read the other's cases, sessions, or recordings by any query. Mark a case `private` and confirm a teammate cannot see it. Rotate the invite code and confirm the old one stops working.
11. **Recording round-trip** — record a speech, confirm the Opus upload is roughly a tenth the WAV's size, then play it back on a second machine and leave a comment at a timestamp that appears on the first.
12. **Co-prep test** — two instances edit different fields of one case simultaneously; confirm convergence with no lost text. Pull one machine off the network mid-edit and confirm it reconciles on rejoin. Then kill internet on both and confirm the LAN fallback still merges.
13. **Conventions hold** — `npm run lint` and `cargo clippy -- -D warnings` both pass with the docstring rules on. Then delete a docstring and a param description and confirm CI actually fails, so the rule isn't quietly disabled.
