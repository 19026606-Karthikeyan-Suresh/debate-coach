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

**One column was added locally and is deliberately not in the list above.** Phase 6's migration 2 gives the local `sessions` a `report TEXT`, and the split is by what leaves the machine: `metrics` is a dozen numbers — skip rate, filler rate, pace — and is what phase 9 replicates so a squad can see each other's trends; `report` is the detail behind them, including the transcript and every skipped clause the debater wrote. That is a recording of somebody speaking, held in text, and it stays local until there is an explicit reason for it not to. Phase 9 decides whether the Postgres side gets the column at all.

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

#### What the build settled — `src/export/` and `src-tauri/src/export.rs`

**The `.docx` is written rather than filled, and that is what makes it faithful.** The obvious implementation is to open `reference/template-blank.docx` and drop answers into its blanks. It cannot work: the template has exactly one of each table and a case has three substantives, two clashes and however many rebuttals, so the real job is duplicating XML nodes and splitting runs at a `___` that Word has scattered across four of them. Writing the document instead costs a ZIP writer and five XML parts — and buys the fidelity outright, because the question column is `buildSections`, whose labels are *imported* from the `*_LABELS` records that `template-fidelity.test.ts` diffs against the real docx. The export cannot drift from the template without failing a test that never mentions exporting. `docx.test.ts` closes the loop anyway by looking every exported question back up in the blank template.

**Well-formed XML is not a valid document, and only Word can tell you.** The children of `w:pPr` are a schema *sequence*, so `w:outlineLvl` before `w:spacing` parses perfectly and makes Word discard the entire styles part — every heading silently collapses to Normal. Found by opening the generated file in Word through COM and reading the paragraph styles back: `Heading 1` at outline level 1 is what proves `styles.xml` was accepted rather than merely present. Word also opens the case export with 12 tables and the first cell reading "Motion:", which is the only end-to-end evidence that exists for a hand-written OOXML package.

**Everything that decides what a file contains is pure; one module talks to the OS.** `zip.ts`, `ooxml.ts`, `docx.ts`, `dbcase.ts` and `speechSheet.ts` are all node-testable, and `export/index.ts` holds the save dialog and the IPC. The archive is **stored, never deflated** — compression needs `CompressionStream`, which is async and would make every caller a promise, to shrink a file nobody transfers — and **deterministic**, so two exports of one case are byte-identical and a diff between them is a diff between cases.

**The export is the whole template, not the seat.** Everything else in the app is role-scoped and this is not, because a `.docx` gets printed and handed to the rest of the team, and a whip's export that silently omits DEFINITION is not the template. Empty rows are printed for the same reason. What is *structurally* absent stays absent: no POLICY when the mechanism question was answered no, no REBUTTAL heading when no rebuttal exists — a block that does not exist is a different statement from a row nobody has filled. Preempts are the one thing pulled in from outside `buildSections`, because they are outside it for storage reasons rather than because they are not prep.

**Importing a `.dbcase` never overwrites.** A file whose case id is already here is imported as a copy with a fresh id and the caller is told which of the two happened; a file whose id is not here is restored exactly, same id and same timestamps, which is what `saveCase` taking `updatedAt` off the document rather than the clock was always for. The collision check reads `listCaseIds`, not the library's paginated list — restoring over case 101 because the list stopped at 100 is precisely the failure this format must not have.

**The Rust side writes the bytes instead of `tauri-plugin-fs`.** That plugin's scope is a path allowlist declared in the capability file, which for a user-chosen save path is either narrower than a dialog needs or, written `**`, the whole disk. Two commands that each accept one extension are a smaller thing to reason about, and the extension check is the boundary: a command that writes arbitrary bytes to an arbitrary path is a general-purpose file writer reachable from a webview. `cargo test` pins the exact argument object the frontend sends, including that a `Uint8Array` which forgot `Array.from` fails to deserialise — otherwise that shape is only ever checked by pressing the button.

**Two bugs the phase found rather than built.** The meta line printed `exported 2026-08-08` when opened at 01:03 on the 9th, because `toISOString().slice(0, 10)` is the UTC date; the date is now formatted from local parts in the impure module and the pure ones take it pre-formatted, which also makes them time-zone-free to test. And the speech sheet's print rules are verified by pulling them out of `document.styleSheets` and asking the DOM whether their selectors match anything — `body.sheet-open > #root` matching zero elements is exactly how a print stylesheet fails, and it fails silently.

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

#### What the build settled — `src-tauri/src/coach.rs` and `src/coach/`

**The split is key in Rust, words in TypeScript.** Rust owns the API key and the wire shape — model, `max_tokens`, `output_config.effort`, that a schema is always attached, that a refusal is not read as content. TypeScript owns the prompt, the schema and the validator. The security property that actually matters is that the key never reaches the webview, and that holds however the frontend words its prompt; what the split buys is that the Socratic constraint is three pure modules vitest can red-team with no process boundary and no key in the loop. `build_body` is separate from the send for the same reason on the other side: every constant that would otherwise only be checked by a live call is pinned by `cargo test`.

**`keyring`, not `tauri-plugin-stronghold`.** Stronghold is an encrypted snapshot file that needs a password to unlock, so it is either a second password every launch or a hardcoded one — and a hardcoded password over an encrypted file is a file. Windows already has a per-user secret store the OS unlocks at login. `coach_status` reports which backend it actually got and whether it survives a quit, because on a platform without one `keyring` falls back to an in-memory store and a settings box that says "saved" would be lying.

**Three tasks, one exception to the rule.** `audit` and `poi` may only return questions, and the validator additionally requires them to end in a question mark — a structural test that is cheap and impossible to satisfy accidentally while writing prose. `attack` returns the opposition's own line, which is prose and is not a question. That is the exception the fence is built around rather than a hole in it: an opposition attack is the *other* side's argument, and writing it out is exactly what makes it answerable. There is no field beside it for how to beat it, and `schema.test.ts` asserts the attack item has precisely two properties so there never is.

**The guard reports what it threw away.** Rejected items are dropped and counted on screen with the reason. A guard that silently deletes two of three attacks is indistinguishable from a model that only had one to offer, and the difference is the whole reason to trust the panel. Two rules do the work: a length cap, and a fixed list of phrasings that only appear when the model has started writing the case — second-person instruction, first-person advocacy, and "have you considered that X?", which is the single most common way an argument arrives wearing a question mark. Every pattern ships with an *accepting* test beside its rejecting one, because a guard that eats honest questions is worse than no guard: it makes the panel look broken, and a debater who stops reading the panel has lost the feature.

**Preempts are deliberately outside `buildSections`.** They are therefore outside the analyzer and outside the completeness meter, and both omissions are load-bearing. Counting an unanswered attack against completeness would mean asking for help lowers your score. Firing a rule on an empty `response` would break Layer A's own rule that no heuristic ever fires on an empty field. The coach panel and the substantive's own preempt list count the unanswered ones instead. `setFieldByPath` still routes `substantives.<id>.preempts.<id>.response`, so an answer saves and stamps `updatedAt` exactly like a template row.

**Nothing is written into the case unasked** — the same rule phase 6 settled for improvisations. An attack becomes a `Preempt` and a POI becomes a row when the debater presses the button beside it, and "Added" is derived from the case rather than remembered in the panel, so deleting the row from the prep sheet puts the button back.

**The call is filed under the substantive it was *about*.** `CoachRun.subjectId` is captured when the run starts, not read off the open section when the reply lands. High effort takes long enough to read another substantive while it runs, and filing three attacks under whichever row happened to be open is a silent, plausible-looking corruption of the case. Found by driving the panel, not by reading it.

**Two wire decisions taken from the current API rather than from habit.** `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta is sent, so a request Opus 5's classifiers decline is re-run on the recommended fallback instead of coming back as a refusal — and a 400 mentioning it is retried once without it, because betas are enabled per organisation and losing Layer B entirely over an optional robustness feature is the worse failure. And the schema carries **no** `maxLength`, `minItems` or `minimum`: Anthropic's structured-output subset drops those silently, so a length constraint written there would look enforced and do nothing. Both caps live in `validate.ts`, and `schema.test.ts` fails if one drifts back.

**Still open: no call has been made.** Everything above is pinned by 46 TypeScript tests and 11 Rust ones, and the panel has been driven through all seven of its states — but PLAN verification step 10 needs an API key, and nothing here has yet been billed a token. What only a live call can settle is whether high effort is tolerable against a 15-minute prep clock, and whether the guard's phrase list rejects anything Opus 5 actually writes.

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

- `whisper-cli` compiled for Windows plus `ggml-base.en.bin` and `ggml-small.en.bin`, bundled by `tauri.bundle-whisper.conf.json` at release time. One installer, nothing for a teammate to download or compile — but see the note on `externalBin` below for why that config is separate from `tauri.conf.json`.
- **Live path**: Web Audio API captures mic → 16 kHz mono PCM → one Tauri command with a raw body → a Rust worker thread runs `base.en` over a rolling window → transcripts return on the `speech://transcript` event channel.
- **Report path**: the speech is saved as WAV; afterwards `retranscribe_speech` re-runs `whisper-cli` with `small.en`, alignment is recomputed, and the report is built from the better transcript. The numbers I keep are the trustworthy ones.
- Rust encodes the WAV to Opus for upload; the WAV stays local. *(Phase 9, with the upload it exists for.)*
- `TranscriptionSource` interface with `WhisperLiveSource` primary and `WebSpeechSource` retained as a fallback if the sidecar is missing or fails to launch.

#### What the build settled — `src-tauri/src/whisper.rs`

**The live path originally specified here could not be built, and the reason is worth keeping.** It read: "Tauri command streams to the `whisper-stream` sidecar's stdin". whisper.cpp's `stream` example opens the microphone itself through SDL2. It has no stdin, so there is nothing to pipe PCM into. Adopting it would mean bundling SDL2, losing device selection and noise suppression the browser already does, and handing capture to a process that cannot also produce the WAV the report path needs.

What is built keeps every property that was actually wanted — browser owns the mic, Rust owns the sidecar and the event channel, the WAV lands on disk — and changes only the middle. A worker thread runs plain `whisper-cli`, the binary every whisper.cpp build produces, over a **rolling window** of the audio so far. whisper-cli timestamps each segment and puts boundaries at pauses, so a segment ending comfortably before the window's edge is finished: its text joins a committed prefix and the window slides past it, while everything after is a live tail re-decoded each tick. The frontend is handed `committed + tail` as one transcript, which is exactly `advanceAlignment`'s contract. Cutting at segment boundaries rather than a fixed offset is what stops a word being sliced across two windows.

The cost is latency against a true streaming decoder. What it buys: window length, tail and tick are `TranscriptionOptions` rather than constants, which is the whole surface `whisper-bench` needs; a failed decode loses one window instead of the speech; and one binary serves both the live pass and the `small.en` re-pass.

**Audio crosses IPC as a raw request body**, not as a command argument — a minute of speech is a million samples and serialising those as a JSON array of numbers costs more than transcribing them. The whole speech is held in memory (13 MB for seven minutes) and written to WAV once at the end, which is also what lets the worker re-read the window at any offset without seeking a file that is still being written.

**`bundle.externalBin` is not in the committed config.** `tauri-build` validates it, so naming a binary that is not on disk fails `cargo build` — and therefore clippy and CI — for anyone who has not first downloaded 640 MB of model weights. Bundling moved to `tauri.bundle-whisper.conf.json`, merged in at release time only. Runtime resolution searches next to the executable first (where a bundled sidecar lands) then app-data (where `scripts/fetch-whisper.ps1` installs it), so the same code serves both without a build flag.

### Alignment — `src/speech/align.ts`

The core algorithm, and the thing that actually fixes the skipping.

- Streaming **Needleman–Wunsch DP** over a sliding window anchored at a moving cursor.
- Classifies every script token as `spoken`, `skipped`, or `pending`, and collects every unmatched transcript token as an `Improvisation`.
- **Normalization before matching** (`normalize.ts`): lowercase, strip punctuation, expand numerals, plus a phonetic key (classic Metaphone — see below for why not Double) so transcription errors don't register as skips. Without this the feature cries wolf and I stop trusting it.
- **Re-anchoring**: a long unmatched run widens the search window and re-scans — handles jumping sections, restarting a sentence, or answering a POI mid-speech.
- Pure function, no DOM, no async, heavily unit-tested.

#### What the build settled — `src/speech/`

**There is no substitution, and that is a feature.** A DP over words normally allows a mismatched pair at a penalty. Here it must not: "you said a different word here" is not something the debater can act on, while "you skipped this and added that" is exactly what the report shows. A wrong word therefore comes out as one skip beside one improvisation, which is both true and useful.

**Re-anchoring freezes the confirmed prefix first.** Re-running the whole window with free leading gaps is the obvious implementation and it is wrong: a free leading gap is cheaper than keeping matches already found, so the DP discards twenty correctly-spoken words and calls them improvised. Only the unexplained tail is re-aligned, against a much wider slice — which is also what re-anchoring *means*: "these last words are not here, where are they?" Only forward jumps are searched, because searching backwards would let the aligner re-match material already marked spoken and quietly erase a real skip.

**A commit is only taken behind an `exact` match.** `near` is the tier that absorbs transcription error, and transcription error is precisely what a later revision comes back to fix, so freezing on one would make a wrong strike-through permanent. There is a separate backstop for the speaker who abandons the script entirely — nothing matches, so nothing would ever commit and the DP would widen for the rest of the speech.

**Classic Metaphone, not Double Metaphone.** The second key of the double variant exists for names of non-English origin; this compares ordinary English prose, and 500 lines of transliterated rules is 500 lines nobody can review against the transcript that broke. Most homophones fall out for free — their/there/they're, no/know, right/write — and the handful that do not are pairs where one member opens with a sounded consonant the other lacks, which is a short list of number words that is simply named.

**The resampler keeps a fractional read position across chunks.** Resampling each chunk independently and rounding its length is the natural thing to write, and it loses a fraction of a sample per call — seconds of drift over a seven-minute speech, which lands as timestamps that no longer point at the audio they came from. A test feeds seven minutes of 48 kHz through in worklet-sized frames and asserts the output is within one sample of exact; the first version of the code failed it by 3281.

### Teleprompter, timer, report — `src/components/speech/`

- **Teleprompter** auto-scrolls to the *aligned* position, not at a fixed rate. Spoken text dims, skipped words strike through red, improvisations highlight, upcoming text stays full contrast.
- **Timer** is format-aware: protected-time bar with the POI window shaded, knocks at 1:00 and 6:00, 30-second warning, hard stop, grace period.

**Built, with two things worth recording.** The teleprompter renders each segment by slicing `segment.text` at every token's `start`/`end` rather than joining tokens with spaces, so the compiler's punctuation and spacing survive exactly; a verification pass asserts the rendered text is character-identical to the compiled text for every segment, which is what actually proves the offsets. Improvisations cannot be shown inline as words — they are not in the script — so a run of them collapses to a `+n` marker at the position it was heard, and the transcript panel carries the rest.

Scrolling and the active-segment highlight both had to be made instant: see the note in CLAUDE.md on anything that needs a painted frame. The transition version left the highlight on the wrong segment indefinitely.
- **Report** — skipped words grouped by section and linked back to their case field; pace over time; fillers and pauses >2 s with timestamps; time per section vs plan; improvised additions offered for saving back into the case.
- **Playback with comments** — scrub the recording, and a coach's timestamped notes appear inline.
- **Session history** charts skip rate, filler rate, and pace across sessions, mine and the team's.

#### What the build settled — the report (`src/speech/report.ts`, `metrics.ts`, `fillers.ts`)

**There are two reports for one speech, and the order they arrive in is the design.** The live one is built from the `base.en` transcript the teleprompter was already following and is on screen the moment the speaker sits down; the `small.en` one replaces it minutes later. A report that only appears when the accurate pass finishes is a report nobody reads, because by then the round has moved on. The session row is written with the live one, so a crash during the re-pass costs the accurate numbers rather than the speech.

They do not agree, and the UI says so on every screen that shows either. Filler counts especially: the better model transcribes more disfluencies, so **a filler count is a floor rather than a total**, and the history screen charts only the sessions that have been through the review pass — plotting a `base.en` number beside a `small.en` one draws a trend out of the model rather than out of the speaker.

**Only the review pass has timings, and that is structural rather than an omission.** The live path decodes a rolling window and slides past it, so a timestamp from one window means nothing once the window has moved. `small.en` decodes the whole recording once in one frame of reference. Everything that needs a clock — pauses, per-section durations, the pace chart — therefore exists only after it, and everything that does not — which words were skipped, what was improvised, how many fillers — works identically without it. Both are the same `SpeechTimeline` type with `hasTimings` false on one, so nothing downstream branches on which pass it has.

**Word times are interpolated across their segment, not measured.** whisper-cli times segments, and a segment is a clause. So a word's time is good to about the length of the clause holding it — enough for "the rebuttal ran ninety seconds" and for putting a filler in the right part of the speech, not enough to claim a word was said at 2:14.3. Nothing in the report claims that.

**Pauses are measured off the samples.** Reading the gaps between whisper's segments is the obvious implementation and it does not work: the segments it prints are usually flush, one ending exactly where the next begins, so a pause the speaker really took comes back as no gap at all. `find_pauses` in `audio.rs` takes an adaptive threshold from the recording's own quiet tenth and loud tenth — a fixed one is either above a laptop microphone's hiss or below a quiet speaker, never both — and reports only silence *between* speech, because the quiet before the first word is the walk to the lectern.

**A skipped run never crosses a field.** Sixteen consecutive red words are one dropped clause and the report says so, but two adjacent clauses from different rows stay separate however contiguous the script made them, because the whole question the report answers is which row to go and fix. Each run carries the row's **label as well as its path**, copied in at build time: a report is opened against a case that has since been rewritten or deleted, and "the row that used to be at this path" cannot be resolved then.

**Nothing is written back into the case without being asked.** An improvisation's field is a guess — the token it was heard at, or the nearest one behind it in the same segment that came from a field — and a guess does not get to edit a case unasked. The report offers the row by name and the debater presses the button.

**`alignSpeech` could not align a real speech, and the report is what found it.** One `advanceAlignment` is bounded by `scriptWindow`, so a single call against a 1000-word script reached the first 160 words and classified the other 900 as skipped with the whole transcript improvised. The anchor only moves when a commit is taken and a commit only happens on an advance, so the script has to be walked by advancing repeatedly — which is exactly what the live path does. `alignSpeech` now replays in chunks. Every phase 5 test used a script short enough to fit one window, which is why it survived a phase.

**Two commands were running on the main thread.** `retranscribe_speech` is minutes of CPU and `stop_speech_session` blocks on the worker's final flush; both are `#[tauri::command(async)]` now. Phase 5 never called either with a real model behind it, so neither had ever blocked anything.

**Deliberately not built here.** Playback is phase 10, with the coach comments it exists for — the WAV is kept and its path is on the session row, but there is no scrubber. And `SPEAKING_WORDS_PER_MINUTE` is still 160 rather than this debater's own measured pace: the sessions now hold the number, but feeding it back into the compiler's length estimate would make the script's "6:38" mean something different on every machine and after every speech, and that wants deciding rather than doing quietly.

### Free-speech mode

No script loaded: transcribe an opponent's speech, then optionally have Claude flow it into the rebuttal-table structure. Doubles as a live-flowing tool.

---

## Files to create

```
supabase/
  migrations/*.sql         schema, RLS policies, join_team(), rotate_invite_code()
src-tauri/
  tauri.conf.json          window, SQLite plugin. No externalBin — see the whisper note
  tauri.bundle-whisper.conf.json   merged in at release time to bundle cli + models
  Cargo.toml
  src/main.rs, lib.rs
  src/whisper.rs           sidecar lifecycle, rolling-window worker, event emit
  src/audio.rs             PCM buffer, WAV writer (Opus encode lands in phase 9)
  src/coach.rs             Anthropic calls, keychain-backed key
  src/export.rs            extension-checked file write + `.dbcase` read
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
  hooks/useSpeechTimer.ts  deadline-based speech clock, fires each knock once
  hooks/useSpeechSession.ts  source lifecycle + incremental alignment
  db/index.ts              SQLite queries, Yjs doc <-> row projection
  sync/supabase.ts         client, auth, join_team, library queries
  sync/provider.ts         Yjs over Realtime; y-webrtc LAN fallback
  coach/types.ts           CoachResult, DepthAxis, CoachPrompt — Layer B's contract
  coach/schema.ts          the JSON schemas; the structural half of the Socratic rule
  coach/prompts.ts         system + user prompts, built through buildSections
  coach/validate.ts        length cap + coaching-voice guard (pure)
  coach/parse.ts           reply -> CoachResult, guarded (pure)
  coach/client.ts          the four Tauri commands; the key never comes back
  coach/index.ts           runAudit / runAttack / runPois
  hooks/useCoach.ts        one call at a time, key status, subject capture
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
  speech/normalize.ts      variants, Metaphone, run-to-run matching (pure)
  speech/capture.ts        mic -> 16 kHz mono PCM16, drift-free resampler
  speech/transcript.ts     word splitting, interim merge, pace (pure)
  speech/timer.ts          speech clock + edge-triggered knocks (pure)
  speech/fillers.ts        guarded filler lexicon (pure)
  speech/metrics.ts        word timeline, pace series, SessionMetrics (pure)
  speech/report.ts         skipped runs, section table, SpeechReport (pure)
  hooks/useSpeechReview.ts live report, small.en re-pass, session row
  components/              CaseEditor, SectionView, TemplateTable, FieldEditor,
                           SectionNav, SeatPicker, PrepTimer, CompletenessMeter,
                           Library, DepthPanel, CoachPanel, PreemptList, TeamSetup,
                           ExportPanel, SpeechSheetView
  components/speech/       SpeechView, Teleprompter, SpeechTimer, LiveTranscript,
                           SpeechReport, SessionHistory, Playback (phase 10)
  export/zip.ts            CRC-32 + stored-entry ZIP writer, deterministic (pure)
  export/ooxml.ts          WordprocessingML fragments + the five package parts (pure)
  export/docx.ts           buildCaseDocx, buildSpeechSheetDocx (pure)
  export/dbcase.ts         serialise + import with the restore/copy rule (pure)
  export/speechSheet.ts    printable model off compileScript (pure)
  export/index.ts          save/open dialogs and the two Tauri commands
  **/__tests__/*.test.ts
```

**Build order.** Each phase is usable on its own, and each ends in a commit:

0. ~~Project scaffold, pinned toolchain, git~~ — done
1. ~~Tauri scaffold + SQLite + formats + data model~~ — done
2. ~~Case Builder UI~~ — done
3. ~~Analyzer Layer A~~ — done
4. ~~Script compiler~~ *(the hinge — landed before any speech UI)* — done
5. ~~Whisper sidecar + aligner + teleprompter + timer~~ — done
6. ~~Report + session history~~ — done
7. ~~Claude Layer B~~ — done
8. ~~Export + `.docx` / `.dbcase`~~ — done
9. Supabase: schema, RLS, invite-code join, library sync, recording upload ← **next**
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

Taken from the shipped `whisper.rs`, so the example stays honest:

```rust
/// Finds whisper and its models.
///
/// * `app` — supplies the resource and app-data directories, which differ between a dev run and
///   an installed build. Never build these paths by hand.
///
/// # Errors
/// [`WhisperError::SidecarUnavailable`] when no binary is found — the signal to fall back to the
/// browser recogniser — or [`WhisperError::ModelMissing`] when the binary is there but
/// `base.en` is not, which means a half-finished install rather than no install.
pub fn resolve_assets<TRuntime: Runtime>(
    app: &AppHandle<TRuntime>,
) -> Result<WhisperAssets, WhisperError>
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
| **rust-sidecar** | 5 | Tauri v2 specifics — `externalBin`, `bundle.resources`, capability and permission JSON, sidecar spawn, raw-body IPC, event channels. Version-specific, fiddly, and genuinely isolated from app logic. | opus |
| **prompt-guard** | 7 | Red-teams the Socratic constraint. Actively tries to make Layer B write my argument, and verifies the JSON schema plus the validator both hold. Runs on every prompt change. Adversarial against a fixed schema. | opus |
| **supabase-rls** | 9 | Writes migrations and *proves* the policies by attempting cross-team reads from a second identity. Security-critical and quietly easy to get wrong. Never marks a policy done without a failing-read test. | opus |

Three of these land in phase 5, so they are worth writing *before* it rather than during.

**Phase 7 shipped without `prompt-guard`, and the reason is the one the table itself gives.** The brief was "red-team the Socratic constraint, verify the schema and the validator both hold" — adversarial against a fixed target, which is exactly where an agent pays. What it turned out to be was 46 assertions in three files, and the ones that mattered were not adversarial at all: the accepting case beside each rejecting pattern, which is what stops the guard eating honest questions. A cold agent trying to break the fence would have written more attacks on it and none of those. The content survived as a convention, the way `analyzer-rule`'s did: **every voice rule ships with an example it must let through.** The agent still has a real job on the next prompt change, when the fence is fixed and only the wording moves.

**Phase 5 shipped without them too, and this time for a mechanical reason rather than a judgement:** `.claude/` is in `.gitignore` as per-machine state, so an agent definition written there is not team state and never reaches the repo. That is fine for `aligner-tester` in hindsight — the adversarial cases it was briefed to generate are the eight `describe` blocks in `align.test.ts`, written alongside the aligner while the contract was still moving, and the one that mattered (a jump between substantives discarding the confirmed prefix) came out of watching the DP misbehave, not out of a cold brief. `whisper-bench` still has a real job and now has a real surface to point at: `TranscriptionOptions` exists precisely so the window, tail and tick can be measured rather than guessed, and none of them has been. `rust-sidecar`'s work is done. If the agents are wanted, un-ignore `.claude/agents/` first.

**`crdt-sync` is split rather than kept.** The Yjs document shape and the doc↔row projection are design work tangled with the data model and the editor — inline. The convergence tests under partition are adversarial against a finished provider, and that half is agent work; fold it into phase 11 as a test brief rather than an agent that owns the feature.

**Still not agents.** The Case Builder UI, the script compiler, and the export path are one-off, highly interdependent, and easier to hold in one head than to brief — build those inline. Phases 1–3 confirmed it, and **phase 8 confirmed the export half specifically, though not for the reason given.** The export path is neither interdependent nor hard to brief; a ZIP writer and an OOXML emitter are about as isolated and as fixed-target as work gets. What an agent would have shipped is a file that is well-formed XML and that Word discards half of, because the win condition it would have been briefed against — "the reader gets the text back" — is satisfied by exactly that file. The thing that caught it was opening the result in Word, which is not a brief, it is knowing what would still be wrong once the tests passed.

---

## Verification

1. `npx vitest run` — every analyzer rule and every aligner case has unit tests. **Passing** at 752 tests across 34 files, alongside `cargo test` at 42.
2. **Regression fixture from real work.** Seed the fake-news case from my friend's filled example (`reference/template-filled-example.docx`). It has genuine, checkable defects the analyzer must catch:
   - `subOverlap` flags Sub 1 ("fake news causes irreparable damage") against Sub 2 ("allowing the spread is supporting it") — they share most of their content vocabulary.
   - `vagueness` flags "damages lives", "individuals in society", "many damages".
   - `impactAxes` flags Sub 1 as missing probability and timeframe.
   - Sub 2's `howThisSolves` and both subs' `example`/`link` are empty → completeness meter shows the gap.
3. **Script compiler against the template.** Every phrase the compiler claims is the template's is looked back up in `reference/template-blank.docx`, and every slot resolves to a row the editor actually renders — both directions, so a template row that is never spoken has to be listed as deliberate. A completely filled case, for all fourteen seats across both formats, compiles with an empty `gaps`.
4. **Aligner tests without a microphone** — synthetic transcripts against a known script: verbatim, dropped clause, improvised insertion, homophone (`their`/`there`), restarted sentence, jump from Sub 1 to Sub 3. Assert exact skipped/added token sets. **Done** — all six are in `align.test.ts`, plus a dropped run of transcript, a filler storm, a speaker who abandons the script, and a check that streaming in chunks of 1, 2, 5 and 13 words reaches the same answer as one call.
5. `npm run tauri dev` → build a case end-to-end: BP + CG, fill Sub 1, confirm inline underlines and depth-panel findings appear.
6. **Whisper sidecar check** — **half done.** `scripts/fetch-whisper.ps1` has now run, and whisper.cpp **v1.9.2** transcribes on this machine with the exact flags `transcribe_wav` passes. Measured on `samples/jfk.wav`, looped to length, at 4 threads:

   | | v1.7.6 | v1.9.2 | 7-minute speech |
   |---|---|---|---|
   | `base.en` | 6.5× real time | 6.5× | ~65 s |
   | `small.en` | 2.2× | 1.9× | ~3.5 min |

   - **`small.en` at three and a half minutes for one speech confirms the re-pass cannot block anything**, which is what phase 6's `(async)` fix was for, and why the live report is shown first rather than waited on.
   - **The live tick is decode-bound, not tick-bound.** `tick_ms` is 1200, but a window of `max_window_seconds` (24 s) takes ~3.7 s to decode, so the worst-case teleprompter update period is nearer 5 s than 1.2 s. In ordinary delivery the window slides at every pause and stays far shorter, so this is the backstop's cost rather than the normal case — but 24 s is now a number with a measured consequence rather than a guess, and it is the first thing `whisper-bench` should look at.
   - **How much better `small.en` is depends on the release, which is worth knowing before trusting the architecture.** Under v1.7.6 `base.en` misheard "ask not" as "asked not" and `small.en` got it right: a wrong word against a right one, which is the strongest possible case for a re-pass. Under v1.9.2 `base.en` no longer makes that error, and on clean audio the two now differ only in punctuation. The re-pass still earns its place — punctuation is exactly what `fillers.ts` keys its comma guards off, so the two models still produce different filler counts, which is why the report refuses to compare them — but the margin is narrower than one release made it look. A single clean 11-second sample is thin evidence either way; this is what `whisper-bench` is for.

   **Still open**: no microphone. Everything above is file-in, file-out, on one sample of clean studio audio looped end to end — which is not debate delivery at pace in a room. What only live capture can settle is whether the window slides the way `fold_window` assumes on continuous speech, and whether the teleprompter's real lag is tolerable.
7. Deliberately skip a sentence mid-speech; confirm it strikes through live and lands in the report linked to its case field. **Done.** A synthetic delivery that drops nine words strikes through exactly those nine and nothing else in the running UI, and a delivery that drops a whole row comes back in the report as one clause naming `substantives.sub-1.whyBad` — rendered as the template's own question, "Why is the problem so bad?". Pinned by `report.test.ts` against the real compiled fixture, not a hand-made script.
8. **Offline test** — disable networking entirely. Case building, analysis, transcription, alignment, and reporting all still work; edits queue and drain on reconnect. Only the Claude button and library refresh degrade.
9. `npm run tauri build` → install the `.msi` on a second machine with no dev tools; confirm speech capture works with zero setup.
10. With an API key saved: run `attack` on a substantive, confirm three opposition responses come back and that no returned field contains a written-out argument for my own motion. **Half done — everything except the call itself.** The schema has nowhere to put an argument for my own motion and a test walks it to prove that; the guard rejects the phrasings that would smuggle one past a schema, with an accepting case beside every rejecting one; and the panel was driven through all seven of its states against synthetic replies, which is what caught the run being filed under the wrong substantive. What is untested is the round trip: no request has been sent, so nothing yet says whether `effort: "high"` is tolerable against a prep clock, whether the guard rejects things Opus 5 genuinely writes, or whether this account can use the refusal-fallback beta. That needs an API key, which is the debater's to add.
11. **Export round-trip.** **Done, including the part only Word can answer.** The generated `.docx` is read back by `readDocx.ts` — the same reader every fidelity test runs against the real template — and every question in it is looked back up in `reference/template-blank.docx`. Beyond that: .NET's `ZipFile` opens the archive, every one of the five XML parts parses, and **Microsoft Word opens both exports through COM** — 12 tables in the case export with "Motion:" in the first cell, and the custom styles resolving to `Heading 1` at outline level 1, which is what proves `styles.xml` was accepted rather than discarded. A `.dbcase` round-trips to an equal `Case`, and re-importing one already present lands as a copy rather than over the top of it. The speech sheet was driven in a browser: its rendered paragraphs are character-identical to the model's, and every `@media print` selector was pulled out of the live stylesheet and matched against the real DOM.

    **Still open**: nothing has been through the actual save dialog. The extension check, the argument shape and the file read are covered by `cargo test`, and the capability resolves `dialog:default` at build time, but no path has come back from `save()` on this machine — that needs `npm run tauri dev` and a hand on the mouse.
12. **RLS test** — join two teams with different codes from two installs and confirm neither can read the other's cases, sessions, or recordings by any query. Mark a case `private` and confirm a teammate cannot see it. Rotate the invite code and confirm the old one stops working.
13. **Recording round-trip** — record a speech, confirm the Opus upload is roughly a tenth the WAV's size, then play it back on a second machine and leave a comment at a timestamp that appears on the first.
14. **Co-prep test** — two instances edit different fields of one case simultaneously; confirm convergence with no lost text. Pull one machine off the network mid-edit and confirm it reconciles on rejoin. Then kill internet on both and confirm the LAN fallback still merges.
15. **Conventions hold** — `npm run lint` and `cargo clippy -- -D warnings` both pass with the docstring rules on. Then delete a docstring and a param description and confirm CI actually fails, so the rule isn't quietly disabled.
