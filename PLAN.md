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

Environment: Windows 11, Node 24, npm 11, Python 3.13, git. Phase 0 is done — repo initialised, toolchain pinned, tooling venv created. Rust 1.97.1 is installed and pinned by `rust-toolchain.toml`.

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
  setup: { characterisation, burdens, policy, stance,
           oppositionRebuttals,        // "Rebuttals (if opp 1)" — sits in CASE SET-UP,
                                       // separate from the REBUTTAL table
           caseDivision }
  definition: DefinitionBlock          // 4 rows
  policy: PolicyBlock | null           // 5 rows
  substantives: Substantive[]
  policyRebuttal: PolicyRebuttalBlock  // 4 rows
  rebuttals: RebuttalBlock[]           // 7 rows each
  opposingRebuttals: OpposingRebuttalBlock[]  // 6 rows each
  clashes: Clash[]                     // Speaker 3 / whip
  extension: ExtensionBlock | null     // BP closing half only; not a docx block
}
```

`extension` is the one block with no counterpart in the template — the docx is written for AP, where nobody extends. It exists because the format registry gives CG/CO roles an `extension` block id, so without it those seats have a section the editor cannot render. Its three labels are authored rather than quoted, and no fidelity test pins them.

Text fields are `Y.Text` inside a `Y.Doc`, with a plain-object projection for the analyzer, export, and the `doc jsonb` column.

### Field registry and section projection — `src/case/`

Three responsibilities that would otherwise each grow their own idea of what a field is — rendering, completeness counting, and the address an analyzer finding points at — are collapsed into one module.

- `fields.ts` — a `FieldSpec` per editable row: the template question **imported from the `*_LABELS` records** rather than retyped, plus a one-line hint. The Speaker 3 script slots have no label record because the template writes them as prose, so their labels are the sentence with its blank left in as `___`; a test splits each on that marker and looks every fragment up in the real `.docx`. Also holds `withOpponentName`, because the template is written from opposition's chair and says "Prop" where it means "the other side" — rendered unchanged to a government speaker it reads backwards, so the swap happens at render time and the stored label stays verbatim.
- `sections.ts` — `buildSections(case, role)` projects a case into just the blocks that seat fills, keyed by item id rather than index so a path survives reordering.
- `completeness.ts` — role-scoped, so a whip is not docked for an empty DEFINITION table. `findNextGap` walks in document order, because the template's order *is* the prep order.
- `update.ts` — immutable edits. `setFieldByPath` takes the same path strings `buildSections` hands out.

### UI — `src/components/`

- `TemplateTable.tsx` renders resolved fields rather than a block plus a spec list, so it cannot show a row the completeness meter is not counting.
- `SectionView.tsx` renders one section; everything bespoke in it is structural (add a substantive, answer the mechanism question, pick a side of the "(OR)" fork) because none of those are text boxes.
- Keyboard-first: Tab between fields, `Ctrl+Enter` to the next section.
- **Prep timer** with format-aware duration (BP 15 min, AP 30 min) and pacing nudges — "4 min left, Sub 2 has no mechanism yet."
- **Completeness meter** per role.
- **Library** — my cases plus the team's, searched server-side when online and against the SQLite cache when not.
- **Export** — `.docx` in the original template layout, `.dbcase` JSON, print/PDF speech sheet.

---

## Part 2 — Depth Analyzer

### Layer A — offline heuristics (`src/analysis/`, always on)

Pure TypeScript, debounced on keystroke. Each rule returns `Finding[]`: `{ fieldPath, rule, severity, span, message, socraticPrompt }`, rendered as inline underlines plus the depth panel. `span` is `TextSpan | null` rather than optional — null means the whole field is the problem, which is a different statement from "this rule forgot to say", and the two must not collapse.

**`fieldPath` is the string phase 2 already assigns.** `buildSections` produces it and `setFieldByPath` consumes it, so a finding routes back to its field with no second addressing scheme. Repeatable blocks are keyed by id, not index:

```
prep.motion                    setup.caseDivision.sub1
prep.fiveW1H.who               substantives.<uuid>.whyBad
prep.pois.<uuid>.response      clashes.<uuid>.engagements.<uuid>.responded.whyWrong
```

Take the field list from `flattenFields(buildSections(case, role))` rather than walking the `Case` object — it is already role-scoped, and it resolves only the selected side of each `(OR)` fork, so rules never fire on a branch the whip is not going to say.

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

#### What the build settled — `src/analysis/`

Three things the table above does not say, each of which the reference case forced.

**Not every template row is the same kind of writing, and one rule set for all of them is wrong three ways.** `scope.ts` classifies each field as `argument` (our reasoning — everything applies), `report` (their argument, quoted — only sentence length, because grading an opponent's prose is neither useful nor fair), `name` (an actor or a 5W1H answer — vagueness only, since it must be specific but is not prose), or `skip` (speaker positions, sub titles, the motion, the scratch pad). Within `argument`, a second flag marks the *core* rows a judge actually weighs; `causalChain` fires only on those, because a depth warning on all forty rows is forty warnings. The classification lives in the analyzer rather than in `case/fields.ts` on purpose — that registry mirrors the docx and holds only what the template says, while this is the analyzer's opinion about the template.

**No rule ever fires on an empty field.** Emptiness is the completeness meter's job; it is already counted, already named in the prep-timer nudge, and saying it twice is how a panel becomes noise.

**Two thresholds are measured rather than chosen.** `subOverlap` subtracts the motion's own vocabulary before comparing — every substantive in a round shares the motion's nouns, and counting that as similarity flags every case ever built. On the reference case the pair that really is one argument scores 0.11 and a pair on separate ground scores 0.04; the threshold sits at 0.07 and both numbers are pinned by tests. `causalChain` needed three families of connective, not one: plain connectives, mechanism verbs (`reduces`, `forces`), and `by` plus a gerund. With only the first, pages of ordinary policy writing came back as "bare assertion" — the exact false positive the rule cannot afford. `as` stays out, documented, because subtracting its non-causal collocations costs more than the mechanism verbs already buy.

Findings render twice: a wavy underline on the span, and the message plus its Socratic prompt under the box. `FieldEditor` stacks a transparent copy of the text behind the textarea to draw the underlines, which is why `.field-input` now forces `font-family: inherit` and a stable scrollbar gutter — a browser gives a textarea its own font, and either difference rewraps the layer out from under the words. Analysis is debounced 350 ms, so spans always lag the text slightly and `buildHighlightSegments` clamps them.

### Layer B — Claude audit (`src-tauri/src/coach.rs` + `src/coach/`, opt-in)

Activates when an Anthropic API key has been saved to the OS keychain. Uses **`claude-opus-5`** — thinking is on by default on Opus 5, so send no `thinking` param; set `output_config.effort: "high"` and `max_tokens: 16000`.

- `audit` — scores one substantive on mechanism / impact / comparative / evidence / link-back, returns **only questions**.
- `attack` — the three strongest opposition responses to this sub, phrased as an opponent would say them, which I then answer in the `preempts` fields. Highest-leverage feature in the app.
- `poi` — likely POIs, to fill the template's POI list.

**The Socratic constraint is enforced structurally.** Requests use `output_config.format` with a JSON schema whose only fields are questions and missing-axis labels — no free-prose field the model could write my argument into. A validation pass rejects responses whose question strings exceed a length threshold or contain first-person argumentative phrasing.

---

## Part 3 — Speech Trainer

### Script compiler — `src/script/`

The bridge between the two halves.

- **Speaker 3 / whip**: direct slot-filling into the template's existing prose skeleton.
- **Speaker 1 / 2**: generated from substantive fields via signpost templates.
- Output is `ScriptSegment[]` — `{ id, sectionId, text, tokens }` — so teleprompter, timer, and report reference the same positions, and a skipped word traces back to the case field it came from.

Compiled scripts stay editable; edits are stored separately so re-editing the case doesn't clobber delivery tweaks.

#### What the build settled — `src/script/`

**The compiler reads values through `buildSections`, not off the `Case`.** Same decision the analyzer made, and it buys the same four things: the field list is already scoped to one seat, it already resolves only the chosen side of each "(OR)" fork, its `path` is the string `setFieldByPath` accepts, and its `label` is already pointed at the right bench by `withOpponentName`. Structure — which clashes exist, which engagement kind, which branch, whether the branch carries the extension — still comes off the `Case`, because that is exactly what the projection flattens away. The block walk in `compile.ts` deliberately mirrors `buildSections`: the script comes out in the editor's order, which is the template's order, which is the order the speech is given in.

**The unit that stands or falls is a line, and a line with a blank slot is not emitted at all.** Reading "In response they told us. This argument is wrong because." out loud is worse than saying nothing, so the sentence is dropped and the field comes back in `CompiledScript.gaps` with the label the editor shows. This is a different statement from the completeness meter's: not "twelve rows left" but "these are the sentences you cannot say yet", and it is what makes the length estimate honest. On the reference case it is also the phase's clearest result — the filled example compiles to 1060 words, 6:38 of a 7:00 speech, with CASE SET-UP still entirely unwritten.

**Punctuation at the seam is where the real bugs were.** The template punctuates its prose and the debater punctuates their answers, and naive concatenation produces "…irrecoverable. , their argument fails." on ordinary input. `assembleText` resolves four boundary cases, one of which needs to know whether the incoming run is the template's prose or a field: the template splices mid-sentence ("This is bad because ___ is something that happens all the time"), so a lowercase continuation means the debater's full stop lands in the middle of the template's sentence and has to go — but only when the lowercase words are the template's, because plenty of answers start lowercase and are whole sentences.

**Nothing corrects the debater's text.** A field starting lowercase after a lead-in's question mark stays lowercase. Beyond keeping the compiler out of the business of rewriting, it means a script token is byte-identical to the field text it came from, which is what lets phase 6 map a skipped word back to a character span in the row.

**Three modules, not one.** `skeleton.ts` is the template's Speaker 3 prose quoted verbatim as data, and `skeleton.test.ts` looks every phrase of three words or more back up in the real `.docx` — the same guarantee `fields.ts` has, for the same reason. `signposts.ts` is the authored Speaker 1/2 glue, kept separate precisely because no fidelity test pins it. `lines.ts` holds the join rules and the tokenizer, which is the analyzer's own `tokenize` rather than a second one, so the word a finding underlines and the word the aligner marks as skipped are the same word. A slot naming a field the registry lacks drops its line silently rather than throwing mid-round; `skeleton.test.ts` checks both directions of that mapping, including which registry rows are deliberately never spoken.

**Segment ids are derived from case ids** (`substantives.<uuid>#body`, `clashes.<uuid>#engagement.<uuid>`), never counted, so a delivery edit stored in `edits.ts` lands back on the same segment after the next keystroke recompiles everything. An edited segment's tokens carry `fieldPath: null` — matching a rewrite back against the values it was built from is a guess dressed up as a fact, and the whole point of `fieldPath` is that it is not one.

Three things in the template are followed rather than improved, each recorded at its site: "Prop's 2nd/ 3rd speaker" keeps its slash, "Even if we accept their characterisation of ___." keeps its sentence fragment, and every clash compiles with the first clash's wording because the data model has one engagement shape. The edit layer is the escape hatch for all three.

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
  types/createCase.ts      empty-block factories, hydrateCase()
  formats/index.ts         AP + BP presets
  case/fields.ts           FieldSpec registry, withOpponentName()
  case/sections.ts         buildSections(case, role) -> CaseSection[]
  case/completeness.ts     role-scoped scoring, findNextGap()
  case/update.ts           immutable edits, setFieldByPath()
  case/time.ts             formatClock(), shared with the speech timer
  hooks/useCaseStore.ts    load + debounced SQLite autosave
  hooks/usePrepTimer.ts    deadline-based prep countdown
  hooks/useAnalysis.ts     debounced runAnalysis
  db/index.ts              SQLite queries, Yjs doc <-> row projection
  sync/supabase.ts         client, auth, join_team, library queries
  sync/provider.ts         Yjs over Realtime; y-webrtc LAN fallback
  analysis/index.ts        runAnalysis(case, role) -> Finding[]
  analysis/types.ts        Finding, RuleContext, AnalysisRule
  analysis/scope.ts        which rules may fire on which field
  analysis/highlight.ts    findings -> underline segments
  analysis/text.ts, lexicons.ts, rules/*.ts
  script/types.ts          ScriptSegment, ScriptToken, CompiledScript, ScriptGap
  script/lines.ts          LineTemplate, join rules, provenance-keeping tokenizer
  script/skeleton.ts       the template's Speaker 3 prose, quoted as data
  script/signposts.ts      authored Speaker 1/2 signposts
  script/compile.ts        compileScript(case, role) -> CompiledScript
  script/edits.ts          per-segment delivery edits, stored apart from the case
  speech/recognition.ts    TranscriptionSource, WhisperLiveSource, WebSpeechSource
  speech/align.ts          streaming DP aligner (pure)
  speech/normalize.ts      lowercase / punct / numerals / phonetic key
  speech/fillers.ts, metrics.ts
  components/              CaseEditor, SectionView, TemplateTable, FieldEditor,
                           SectionNav, SeatPicker, PrepTimer, CompletenessMeter,
                           Library, DepthPanel, TeamSetup
  components/speech/       Teleprompter, SpeechTimer, LiveTranscript,
                           SpeechReport, Playback, SessionHistory
  export/docx.ts, dbcase.ts, speechSheet.tsx
  **/__tests__/*.test.ts
```

**Build order.** Each phase is usable on its own, and each ends in a commit:

0. ~~Project scaffold, pinned toolchain, git~~ — done
1. ~~Tauri scaffold + SQLite + formats + data model~~ — done
2. ~~Case Builder UI~~ — done
3. ~~Analyzer Layer A~~ — done
4. ~~Script compiler~~ *(the hinge — landed before any speech UI)* — done
5. Whisper sidecar + aligner + teleprompter + timer ← **next**
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
export function measureCausalChain(
  passage: string,
  connectives: readonly LexiconEntry[],
): CausalChainResult
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

This section originally planned nine `.claude/agents/*.md` definitions. **Phases 1–3 shipped without writing any of them**, including `analyzer-rule`, which phase 3 was supposed to be the whole use case for. That is worth recording honestly rather than quietly restating the plan, because the reason generalises to the phases still ahead.

### What the first three phases actually showed

**Three of the nine were solving a problem that structure solves better.**

- `template-fidelity` was going to re-extract the docx and diff it against the data model. Instead the labels are *imported* from the `*_LABELS` records rather than retyped, and `types/__tests__/template-fidelity.test.ts` diffs those records against the real `.docx` on every run. A label cannot drift without failing a test. An agent that checks when you remember to run it is strictly worse than a test that checks when you don't.
- `doc-comment-auditor` was going to enforce the conventions above on changed files. ESLint does the mechanical half — `jsdoc/require-jsdoc`, `require-param-description`, `check-param-names`, `id-length`, `naming-convention` — and CI fails on it. What is left is the judgement half: a comment that narrates the next line, an argument description that only restates its type. That is review, and it is cheaper as part of reading the diff than as a separate pass over every changed file.
- `analyzer-rule` was going to write one heuristic at a time against the `Finding` contract. The rules turned out to share far too much to hand out one at a time: a lexicon, a field-kind taxonomy, and a `Finding` shape that all ten pull on. Worse, two of the thresholds could only be set by watching every rule fire on one real case at once — `subOverlap`'s 0.07 and `causalChain`'s connective families were both wrong until the whole set ran against the filled example together. Ten cold agents would have re-derived the taxonomy ten times and calibrated nothing.

What did survive from `analyzer-rule` is its actual content: **every rule ships with a false-positive test.** That is now a convention the tests enforce, not a brief.

### The rule that came out of it

**An agent pays where the work is adversarial or empirical against an interface that already exists. It loses where the work is design.**

Breaking a finished pure function, measuring word error rate, and proving an RLS policy fails from a second identity are all jobs with a fixed target and a clear win condition — exactly what a cold agent with no conversation context does well. Deciding what a `Finding` is, or which template rows a judge weighs, is design: it needs the whole picture in one head, and briefing it costs more than doing it.

### The five that still earn their place

Each of these is downstream of an interface that will already exist when the agent runs.

| Agent | Phase | Job | Model |
|---|---|---|---|
| **aligner-tester** | 5 | Adversarial. Its job is to *break* `align.ts`: homophones, restarted sentences, section jumps, POI interruptions, ASR dropout, filler storms. Generates synthetic transcripts and asserts exact token classifications. The strongest case of the nine — `align.ts` is a pure function with a fixed signature, so the whole brief is "here is the contract, break it". | opus |
| **whisper-bench** | 5 | Empirical. Measures live latency and word error rate for `base.en` vs `small.en` on real recordings; tunes chunk size and window overlap. Reports numbers, doesn't guess. Long-running and decides nothing. | sonnet |
| **rust-sidecar** | 5 | Tauri v2 specifics — `externalBin`, `bundle.resources`, capability and permission JSON, sidecar spawn, stdin piping, event channels. Version-specific, fiddly, and genuinely isolated from app logic. | opus |
| **prompt-guard** | 7 | Red-teams the Socratic constraint. Actively tries to make Layer B write my argument, and verifies the JSON schema plus the validator both hold. Runs on every prompt change. Adversarial against a fixed schema. | opus |
| **supabase-rls** | 9 | Writes migrations and *proves* the policies by attempting cross-team reads from a second identity. Security-critical and quietly easy to get wrong. Never marks a policy done without a failing-read test. | opus |

Three of these land in phase 5, so they are worth writing *before* it rather than during.

**`crdt-sync` is split rather than kept.** The Yjs document shape and the doc↔row projection are design work tangled with the data model and the editor — inline. The convergence tests under partition are adversarial against a finished provider, and that half is agent work; fold it into phase 11 as a test brief rather than an agent that owns the feature.

**Still not agents.** The Case Builder UI, the script compiler, and the export path are one-off, highly interdependent, and easier to hold in one head than to brief — build those inline. Phases 1–3 confirmed it.

---

## Verification

1. `npx vitest run` — every analyzer rule and every aligner case has unit tests.
2. **Regression fixture from real work.** Seed the fake-news case from my friend's filled example (`reference/template-filled-example.docx`). It has genuine, checkable defects the analyzer must catch:
   - `subOverlap` flags Sub 1 ("fake news causes irreparable damage") against Sub 2 ("allowing the spread is supporting it") — they share most of their content vocabulary.
   - `vagueness` flags "damages lives", "individuals in society", "many damages".
   - `impactAxes` flags Sub 1 as missing probability and timeframe.
   - Sub 2's `howThisSolves` and both subs' `example`/`link` are empty → completeness meter shows the gap.
3. **Script compiler against the template.** Every phrase the compiler claims is the template's is looked back up in `reference/template-blank.docx`, and every slot resolves to a row the editor actually renders — both directions, so a template row that is never spoken has to be listed as deliberate. A completely filled case, for all fourteen seats across both formats, compiles with an empty `gaps`.
4. **Aligner tests without a microphone** — synthetic transcripts against a known script: verbatim, dropped clause, improvised insertion, homophone (`their`/`there`), restarted sentence, jump from Sub 1 to Sub 3. Assert exact skipped/added token sets.
5. `npm run tauri dev` → build a case end-to-end: BP + CG, fill Sub 1, confirm inline underlines and depth-panel findings appear.
6. **Whisper sidecar check** — `base.en` transcribes live with the teleprompter keeping pace during fast delivery; the `small.en` post-pass produces a different and better transcript that the report is built from.
7. Deliberately skip a sentence mid-speech; confirm it strikes through live and lands in the report linked to its case field.
8. **Offline test** — disable networking entirely. Case building, analysis, transcription, alignment, and reporting all still work; edits queue and drain on reconnect. Only the Claude button and library refresh degrade.
9. `npm run tauri build` → install the `.msi` on a second machine with no dev tools; confirm speech capture works with zero setup.
10. With an API key saved: run `attack` on a substantive, confirm three opposition responses come back and that no returned field contains a written-out argument for my own motion.
11. **RLS test** — join two teams with different codes from two installs and confirm neither can read the other's cases, sessions, or recordings by any query. Mark a case `private` and confirm a teammate cannot see it. Rotate the invite code and confirm the old one stops working.
12. **Recording round-trip** — record a speech, confirm the Opus upload is roughly a tenth the WAV's size, then play it back on a second machine and leave a comment at a timestamp that appears on the first.
13. **Co-prep test** — two instances edit different fields of one case simultaneously; confirm convergence with no lost text. Pull one machine off the network mid-edit and confirm it reconciles on rejoin. Then kill internet on both and confirm the LAN fallback still merges.
14. **Conventions hold** — `npm run lint` and `cargo clippy -- -D warnings` both pass with the docstring rules on. Then delete a docstring and a param description and confirm CI actually fails, so the rule isn't quietly disabled.
