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
| Live co-prep | Yjs CRDT over Supabase Realtime broadcast, one private channel per case |
| Identity | Supabase anonymous sign-in → persistent `auth.uid()` stored in the Windows credential store |
| Membership | `join_team(code)` Postgres function, `SECURITY DEFINER`, validates a hashed invite code and inserts a `team_members` row |
| Access control | RLS on every table, keyed off `team_members`; `visibility = 'private'` restricts to owner |
| Recordings | Opus-encoded by a pure-Rust libopus port, uploaded to Supabase Storage when the debater shares them |

**Why anonymous auth rather than passwordless email:** it gives each install a real, stable user id — so edits are attributable, presence works in co-prep, and a recording belongs to a person — while onboarding a squad before a tournament is still just typing a code.

**The honest tradeoffs.** A leaked invite code lets anyone into the team until it's rotated, and anonymous identity means the app can't verify who someone actually is — so the schema includes code rotation, an admin role that can revoke members, and per-case `visibility` so sensitive prep can stay local. Supabase pauses free projects after 7 days of inactivity; for seasonal use, either unpause from the dashboard, keep it warm with a scheduled ping, or move to the $25/month tier.

**Recordings are encoded before upload.** Seven minutes of 16 kHz mono WAV is ~13 MB; the same speech as Opus at 24 kbps is ~1.2 MB. The WAV stays local for re-transcription, the Opus goes to the server. That's the difference between filling the free tier in 70 speeches and filling it in 800.

**Bad-wifi fallback.** Prep rooms have notoriously poor connectivity, which is exactly when co-prep matters most. Supabase Realtime is the default transport; a local-network room is the fallback for a room with no internet. Same CRDT either way — only the provider swaps. Built last. *(Phase 11: the LAN half is **not** `y-webrtc`, and the reason is in `src-tauri/src/lan.rs` — WebRTC needs a signalling channel that already exists, and `y-webrtc` supplies one by defaulting to servers on the internet, which in a room with no internet are exactly as unreachable as Supabase.)*

---

## Stack

- **Tauri v2** shell (Rust), **React 19 + TypeScript + Vite** frontend, Tailwind v4. One installer per teammate; ~10 MB shell.
- **SQLite** via `tauri-plugin-sql` — local source of truth, and full-text search over the cached library when offline.
- **Yjs** for the case document, so collaboration is a provider toggle rather than a rewrite. *(Phase 11 found that "from day one" never happened and did not need to have: the CRDT went underneath the finished immutable-edit pipeline without changing a single reader. See `src/collab/`.)*
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

`ydoc_state` is persisted periodically so someone joining a co-prep room late gets the document without a peer online — written by the case's **owner** only, since `cases_update` grants nobody else. `comments` is the payoff for uploading recordings — a coach scrubs to 4:12 and leaves a note there.

**One column was added locally and is deliberately not in the list above.** Phase 6's migration 2 gives the local `sessions` a `report TEXT`, and the split is by what leaves the machine: `metrics` is a dozen numbers — skip rate, filler rate, pace — and is what phase 9 replicates so a squad can see each other's trends; `report` is the detail behind them, including the transcript and every skipped clause the debater wrote. That is a recording of somebody speaking, held in text, and it stays local until there is an explicit reason for it not to. **Phase 9 decided: no column.** `recording_path` went the same way for the same reason — locally it is `C:\Users\<name>\...`, which is a path on one machine and a person's name on the wire, so the Postgres column holds a storage object key and phase 10 writes it.

#### What the build settled — `supabase/migrations/` and `src/sync/`

**The policies are proved, not reviewed.** `src/sync/__tests__/rls.test.ts` applies the four shipped migration files, byte for byte, to a real PostgreSQL — PGlite, Postgres 18 compiled to WebAssembly, with a stub supplying only what Supabase itself provides (`auth.uid()` copied from their definition, `auth.users`, the `anon` and `authenticated` roles, and enough of `storage` for the bucket policies). Two teams, three identities, 38 assertions. That is the agent brief for `supabase-rls` — "never marks a policy done without a failing-read test" — met by a test file rather than by an agent, and it needed no Docker and no project. **Every assertion that something is hidden is paired with one that the permitted read still returns its row**, because a policy that denies everything passes half a security test and fails the product.

**The membership check has to be a SECURITY DEFINER function.** A policy on `team_members` that subqueries `team_members` recurses, and Postgres reports it the first time anyone reads the table rather than when the migration runs. `is_team_member` runs as its owner, so the read inside it is not itself filtered and the recursion never starts. Both helpers run with `search_path = ''` and fully-qualified names: a SECURITY DEFINER function that resolves an unqualified name can be hijacked by anyone able to create a table earlier on the caller's path.

**Grants are revoked before they are given, and one column is never given at all.** Supabase's default privileges already grant `authenticated` everything on new tables in `public`, so a policy is the second lock on a door that is otherwise open. Revoking first is also the only way to withhold `teams.invite_code_hash`: a member who can read the bcrypt hash can attack an eight-character code offline at their leisure, so the column grant lists every column except that one and `select *` on `teams` comes back as a permission error. Two tests pin exactly that.

**`to_tsvector(doc::text)` is the one-liner and it is wrong** — every field key in the template becomes a search term, so "example" and "problem" match every case ever written. The generated column runs `case_search_text`, which walks the document and keeps only the leaves a debater typed. It is written as an explicit stack rather than a recursive CTE for a reason worth keeping: `left join lateral jsonb_each(value) on jsonb_typeof(value) = 'object'` does **not** stop the function running on the rows the condition excludes — the join evaluates and filters after, so `jsonb_each` gets handed an array and every insert fails. A recursive CTE also permits only one recursive reference, which rules out the obvious two-branch fix.

**pgcrypto is pinned to the `extensions` schema.** Supabase pre-installs it there; a bare `create extension pgcrypto` on another instance lands it in `public`. The SECURITY DEFINER functions run with an empty `search_path` and must name the schema, so the migration creates `extensions` and installs into it explicitly — otherwise `extensions.crypt` is an unknown function at the exact moment somebody tries to join a team.

**Joining tries every team, and that is a decision rather than an oversight.** bcrypt salts per row, so the stored hash is not a lookup key and there is nothing to index. At squad scale that is a few dozen hashes on an operation each person performs once. A wrong code and a malformed code return the same message, so a probe learns nothing from which one it got.

**The team library is browsable and copyable, not editable.** `cases_update` grants the owner and nobody else — a teammate silently rewriting your case an hour before a round is worse than having to ask them — so opening a teammate's case takes a copy with a fresh id, exactly as a `.dbcase` import does. That is also how a squad really uses one: find last season's prep on this motion, adapt it. Two people editing one document is phase 11's problem and Yjs is its answer, not a second write policy. Search says which kind it is doing: online it runs over the generated `tsvector` and reaches every word in the case, offline it is a `LIKE` over cached motions, and a cached search that finds nothing looks exactly like an empty library.

**The queue is a set of dirty rows, not a log.** A unique index on `(table_name, row_id)` means a case edited forty times on a train is one entry, and the document is re-read from SQLite at drain time so what uploads is the final text. **Cases drain before sessions, always**, because `sessions.case_id` is a foreign key and queue order is by when a row was touched, which says nothing about that; a session whose case is not going up loses its link rather than the whole row. A failure is per row — one case Postgres refuses must not stop the other thirty-nine — and the run reports pushed, failed, retrying and *stuck* separately, because a row past twelve attempts needs a human rather than another retry. A first sign-in backfills the queue from everything already in SQLite, so turning the team layer on after a season uploads the season rather than only what happens next.

**The session is chunked across credential entries.** Windows caps a credential blob at 2560 bytes and `keyring` writes UTF-16, so the real limit is about 1280 characters — and a Supabase session is a JWT, a refresh token and a user object, comfortably past it. Written whole it fails with `ERROR_INVALID_PARAMETER`, which surfaces as "the parameter is incorrect" and says nothing about length. The count is written last and cleared first, so an interrupted save reads back as no session — a fresh sign-in rather than half of two sessions spliced together.

**Deliberately not built: the recording upload.** The bucket, its four policies, `storage_team_id` and `sessions.recording_path` all ship, so phase 10 is an upload call and not a schema change. What is missing is the Opus encode, and it is missing because the obvious way to add it is wrong twice over: the `opus` bindings need cmake, which is the exact C toolchain phase 7 refused to put between a teammate and a build, and the alternative — a `MediaRecorder` on the stream the capture graph already opens — changes the phase 5 capture path that **no microphone has ever been through**. Layering an unverifiable change on an unverifiable base is how two things break at once. It belongs in phase 10, beside the playback it exists for, and behind a working microphone. Verification step 13 stays open.

**Phase 10 confirmed the schema half exactly and found the third way on the encode.** Nothing in `supabase/migrations/` changed: the bucket, the four storage policies and the comment policies were already what an upload and a comment thread need, which is what "an upload call and not a schema change" was worth. The encode is a *pure-Rust port* of libopus — a route neither of the two wrong ones covers, because it builds with cargo alone and it reads a finished WAV rather than touching capture. Three assertions were added to the RLS suite for the two directions phase 10 made reachable and phase 9 had no caller for: the debater whose speech it is can read a coach's note on it, cannot delete it, and the coach can.

---

## Live co-prep — `src/collab/`, `src/sync/provider.ts`, `src-tauri/src/lan.rs`

### What the build settled

**"Yjs from day one" never happened, and phase 11 is the evidence it did not need to.** The decision was written down in phase 0 and quietly skipped in every phase after it: `yjs` sat in `package.json` for ten phases and was imported by nothing, while the case stayed a plain immutable object edited through `setFieldByPath`. The insurance it was supposed to buy was against a rewrite — and the rewrite turns out not to exist, because **the addressing scheme was already the CRDT's**. Phase 2 gave every row a path, phase 3 sent findings to it, phase 4 stamped it on every script token; a document keyed by that same string slides underneath the finished editor and every reader downstream still gets a plain `Case`. What ten phases of not doing it cost was nothing. What they bought was a settled data model to key against.

**A case flattens into three things, and the split is by what merging means.** `text` rows become `Y.Text` and merge character by character, because two debaters writing one row must both keep their words. `scalar` rows — the branch of the "(OR)" fork, whether the POLICY block exists — are last-writer-wins, which is *correct*: nobody can half-pick a branch. `list` rows are ordered sets of uuids, so two people adding a substantive at once end up with two. Measured on the reference case: 78 leaves, 8 lists, 9,157 bytes of full state.

**Five fields are deliberately not shared, and one of them is the interesting one.** `id` and `createdAt`, because every participant keeps their own row and `cases_update` grants the owner alone — four people sharing one id would give three of them a row they cannot write. `updatedAt`, because a timestamp both sides rewrite on every keystroke conveys nothing and the sync queue compares it against *this* install's server row. `visibility`, because who may read your copy is your decision. And **`position` — the seat — because that is the whole point**: a PM and a DPM co-prepping one round are filling different blocks of the same content, and sharing the seat would move one of them out of it mid-prep.

**An edit is written to the document as a delta, never as a snapshot.** The natural implementation diffs the local case against the document and writes the difference. It is wrong in three ways that all look identical from one side — the local case is simply out of date, which it is for one render after every remote update and for the whole of a partition. Reconciling a snapshot resurrects a row a peer deleted, deletes a row a peer added, and — worst — reads a peer's words in the same field as text the local user must have selected over, and deletes them. Sending `diffText(before, after)` at the position the user made it is what a real Yjs binding does, and it is what leaves the merge to the only thing that can do it correctly. Three tests exist for exactly those three interleavings.

**The React wiring is where the last keystroke gets lost, so there is no effect in the path.** Mirroring `caseFile` into the CRDT from an effect drops a character whenever a peer's update lands between a keystroke and the effect that would have pushed it — a one-render window, and the one bug a text editor may not have. `useCoPrep.update` instead reads the live `Y.Doc`, applies the edit to it and projects back, all synchronously inside the event handler. The store underneath is untouched and still owns SQLite, so a room is a layer over the local-first path rather than a replacement: pull the network and the case keeps saving.

**Presence is a heartbeat in the protocol, not a feature of the transport.** Supabase Realtime has one that would do half the job for free — but only half, because the LAN fallback has no Supabase in it, and a room where the roster works differently depending on the wire is a room with two bugs to find. One pure implementation over one message type serves both, and it carries something a socket-level presence never could: the field path the peer's caret is in. "Sam is writing Sub 2's mechanism" is what stops two people landing on one row; "Sam is online" is not.

**Updates are batched at 120 ms because the throttle is ten a second.** A debater types faster than that, and one message per keystroke is dropped frames during exactly the burst that matters. Yjs merges losslessly, so a flush interval collapses a burst of twenty-two keystrokes into one message — pinned by a test that counts frames on the wire.

**The LAN fallback is not `y-webrtc`, and the reason is that `y-webrtc` cannot do the job it was named for.** WebRTC cannot introduce two peers to each other: every connection is negotiated over a signalling channel that has to already exist, and `y-webrtc` supplies that by defaulting to public servers on the internet — which in a prep room with no internet are exactly as unreachable as Supabase. So "the LAN fallback" means running a signalling server on the LAN regardless, and once one laptop is running a server, WebRTC's whole reason for existing is gone. What remains of it is ICE negotiation inside a webview plus three dependencies, one of which phones a public host by default. `lan.rs` is the server that argument leaves behind: UDP broadcast discovery, a TCP relay, `std::net` and threads, no new crates. **The host joins its own relay over loopback**, which is worth the extra socket because it makes the host and the guests run identical client code.

**A co-prep room is authorised by the same predicate that decides who can read the case.** A Realtime broadcast channel is public by default and the anon key ships inside the app, so a room named after a case would otherwise be a live feed of a squad's prep to anyone who guessed a case id. Migration 6 puts RLS on `realtime.messages`, resolving `case:<uuid>` back to a row through `cases_select`'s own condition. Reading a case and co-prepping it are deliberately the same permission — writing the *row* stays owner-only, and that is not a contradiction: the room is a shared document and the row is one person's copy of it. This is the answer phase 9 deferred when it wrote that two writers on one document is phase 11's problem and Yjs is its answer, not a second write policy.

**Two consequences of that, both of which the panel has to say out loud.** A private case has a room of one, so the panel says so in those words with the visibility switch beside it rather than reporting a channel error. And a project that has never had migration 6 applied refuses every room — **measured live**: `Unauthorized: You do not have permissions to read from this Channel topic: case:<uuid>`. That is the right way round to fail, and it is why the panel prints its own sentence first and the server's after it: the first names the fix for the common cause, the second is the only thing that diagnoses the rare one.

**A defect the browser found rather than the tests.** Focus is read off the section container, because every input already carries `id={field.path}` for the depth panel to focus — so the address a teammate needs is on the event and no field component changes. But `focusout` fires before the next `focusin`, so clearing unconditionally made every Tab between two rows report "nowhere" and then the new row: two presence messages per keypress against a ten-a-second throttle, and a panel that blinks while a teammate walks the template. It now clears only when focus leaves the editor. Found by walking focus in a browser and reading the sequence — and the walk had to be driven with synthetic `focusin`/`focusout`, because the pane is not composited, `document.hasFocus()` is false, and **a document without focus never dispatches the native events at all**. That is the same compositing fact as the missing screenshot, from a third side.

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

**Superseded for the coach key, on request: it is now `ANTHROPIC_API_KEY`.** The settings box and both write commands are gone; `coach.rs` reads the environment, then a `.env` in the working directory or one above it. `keyring` stays — the Supabase session still lives there — and the property the split existed for is untouched, because there is still no command that accepts a key and none that returns one. What was given up is real and worth naming: the credential store is encrypted at rest per user, while a `.env` is plaintext on disk and, in this project's tree, inside a OneDrive-synced folder. A real exported variable is the better of the two and is what the docs recommend; the file is the dev convenience. **The name must never gain a `VITE_` prefix** — Vite inlines those into the frontend bundle, which would put the key in the webview and ship it in the installer — and a test asserts the prefixed name does not resolve, so that mistake fails `cargo test` rather than a release.

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

**The edit layer now has a UI, and it is a mode rather than an inline affordance.** `edits.ts` shipped in phase 4 and nothing wrote to it for seven phases; `ScriptEditor` on the Speak screen now does, through `useScriptEdits` and a `script_edits` table keyed by `(case_id, segment_id)`. Editing is a pane you switch into rather than a textarea inside the teleprompter, because the teleprompter renders each segment by slicing `segment.text` at every token's `start`/`end` and a verification pass pins that its rendered text is character-identical to the compiled text — that is what proves the offsets the aligner indexes into, and a caret and a scroll position in the middle of it is the last thing that surface needs. It is disabled while recording for the same reason: renumbering tokens under a running aligner. The speech sheet and its `.docx` apply the same edits, because the sheet is the teleprompter's backup and the two saying different words is the one failure it cannot have.

### Whisper sidecar — `src-tauri/`

- `whisper-cli` compiled for Windows plus `ggml-base.en.bin` and `ggml-small.en.bin`, bundled by `tauri.bundle-whisper.conf.json` at release time. One installer, nothing for a teammate to download or compile — but see the note on `externalBin` below for why that config is separate from `tauri.conf.json`.
- **Live path**: Web Audio API captures mic → 16 kHz mono PCM → one Tauri command with a raw body → a Rust worker thread runs `base.en` over a rolling window → transcripts return on the `speech://transcript` event channel.
- **Report path**: the speech is saved as WAV; afterwards `retranscribe_speech` re-runs `whisper-cli` with `small.en`, alignment is recomputed, and the report is built from the better transcript. The numbers I keep are the trustworthy ones.
- Rust encodes the WAV to Opus for upload; the WAV stays local. *(Phase 10. `opus.rs` over a pure-Rust port of libopus, with `ogg.rs` writing the container.)*
- `TranscriptionSource` interface with `WhisperLiveSource` primary and `WebSpeechSource` retained as a fallback if the sidecar is missing or fails to launch.

#### What the build settled — `src-tauri/src/whisper.rs`

**The live path originally specified here could not be built, and the reason is worth keeping.** It read: "Tauri command streams to the `whisper-stream` sidecar's stdin". whisper.cpp's `stream` example opens the microphone itself through SDL2. It has no stdin, so there is nothing to pipe PCM into. Adopting it would mean bundling SDL2, losing device selection and noise suppression the browser already does, and handing capture to a process that cannot also produce the WAV the report path needs.

What is built keeps every property that was actually wanted — browser owns the mic, Rust owns the sidecar and the event channel, the WAV lands on disk — and changes only the middle. A worker thread runs plain `whisper-cli`, the binary every whisper.cpp build produces, over a **rolling window** of the audio so far. whisper-cli timestamps each segment and puts boundaries at pauses, so a segment ending comfortably before the window's edge is finished: its text joins a committed prefix and the window slides past it, while everything after is a live tail re-decoded each tick. The frontend is handed `committed + tail` as one transcript, which is exactly `advanceAlignment`'s contract. Cutting at segment boundaries rather than a fixed offset is what stops a word being sliced across two windows.

The cost is latency against a true streaming decoder. What it buys: window length, tail and tick are `TranscriptionOptions` rather than constants, which is the whole surface `whisper-bench` needs; a failed decode loses one window instead of the speech; and one binary serves both the live pass and the `small.en` re-pass.

**Audio crosses IPC as a raw request body**, not as a command argument — a minute of speech is a million samples and serialising those as a JSON array of numbers costs more than transcribing them. The whole speech is held in memory (13 MB for seven minutes) and written to WAV once at the end, which is also what lets the worker re-read the window at any offset without seeking a file that is still being written.

**`bundle.externalBin` is not in the committed config.** `tauri-build` validates it, so naming a binary that is not on disk fails `cargo build` — and therefore clippy, and any CI added later — for anyone who has not first downloaded 640 MB of model weights. Bundling moved to `tauri.bundle-whisper.conf.json`, merged in at release time only. Runtime resolution searches next to the executable first (where a bundled sidecar lands) then app-data (where `scripts/fetch-whisper.ps1` installs it), so the same code serves both without a build flag.

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
- **Playback with comments** — scrub the recording, and a coach's timestamped notes appear inline. *(Built in phase 10; the recording that plays is the Opus copy, made on the way to the player rather than only on the way to the bucket, so the encoder runs whenever anybody scrubs rather than only when somebody shares.)*
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

#### What the build settled — the recording (`src-tauri/src/opus.rs`, `ogg.rs`, `src/components/speech/Playback.tsx`)

**A pure-Rust port of libopus is the third option, and it costs neither of the two things phase 9 refused.** `opus-rs` is a translation of libopus 1.6 that builds with cargo alone — no cmake, no C toolchain between a teammate and their first build — and it encodes a finished WAV, so it never touches the capture path no microphone has been through. What it costs instead is trust in a young crate, and that is not paid with a version pin: `decodes_back_to_the_signal_that_went_in` encodes a tone, demuxes the stream, decodes the packets and correlates the result against the input. A codec emitting plausible-looking packets of noise passes every other test in the file and fails that one.

**The container is written by hand, for the reason the `.docx` was.** A `.opus` file is Opus packets in Ogg pages, and nothing else in the app needs a container — the same trade `zip.ts` took. Three details are where a hand-written Ogg goes wrong and all three are load-bearing: Ogg's CRC-32 is **not** the reflected one in ZIP and PNG, so reusing the existing table produces a file that is byte-perfect except for four bytes per page that every player rejects; a packet whose length is an exact multiple of 255 needs a trailing zero lacing value or the reader joins it to the next packet; and **every granule position in an Ogg Opus stream is in 48 kHz samples whatever the input rate**, so writing them at 16 kHz produces a file that plays at a third of its real duration and looks completely normal until you press play.

**Trimming is granule arithmetic at both ends.** The encoder is fed `ceil((pre-skip + samples) / frame)` frames with the tail zero-padded, and the last page's granule is set to the real length rather than the padded one — which is the mechanism that removes the padding again. The head is trimmed by declaring the encoder's lookahead as pre-skip. That constant is 312 because libopus reports 6.5 ms and this is a translation of libopus, but the crate does not expose it, so it is *measured*: a test encodes silence-then-burst and fails if the burst comes back more than one frame out.

**ffmpeg is what says it is an Opus file; our own demuxer only says the arithmetic is right.** Same rule as opening the generated `.docx` in Word. `ffprobe` reads the output as `ogg`/`opus`, mono, 24.7 kbps; `ffmpeg` decodes it back to a WAV of exactly the source duration, with the silence in the middle landing within 6 ms of where it was. And Chromium — the actual player — loads the blob to `readyState: 4` and advances `currentTime`, which is the check that matters because the `<audio>` element is what a coach presses play on.

**Sharing is a button; nothing about a recording moves on a drain.** Every other row replicates automatically because a row is a few hundred bytes and a case you edited is a case you meant to back up. A recording is seven minutes of somebody's voice, and phase 9's rule that nothing identifying a person leaves unasked applies to it more than to anything else. `backfillQueue` therefore takes cases, sessions and comments and not audio: a first sign-in that pushed a season of speeches over tournament wifi would be a surprise and a bandwidth bill.

**The local path and the bucket key are two columns, not one column that changes meaning.** `recording_path` is `C:\Users\<name>\…` and stays; `recording_object_path` is `<team_id>/<session_id>.opus` and is what `sessionToRemoteRow` sends. One column would mean the difference between the two is a convention somebody has to remember, and the thing being remembered is a person's name on the wire.

**Comments go one way locally and the other way online, and the asymmetry is a foreign key.** Notes on *your own* speech are cached in SQLite — the session row is here, and a coach's advice should still be readable on the train. Notes on a *teammate's* speech are not cached at all: their session has no local row for `comments.session_id` to reference, and inventing a stub session so a coach's own note had somewhere to live would put a speech in their history that they never gave. So the coach comments online and the debater reads it offline, which is the way round it needs to work. A pull replaces only the rows marked remote, so a note typed on a train is pending rather than deleted.

**The queue drains cases, then sessions, then comments** — the same foreign-key rule phase 9 wrote for the first two, now with a third table under it. `is_remote` exists solely to keep a pulled comment out of the queue: without it every drain is a round trip that changes nothing.

**Two things driving the player found.** The comment list rendered in whatever order its source returned while the markers on the bar were sorted, so a note added mid-session sat at the bottom of the list with its marker in the right place — which reads as a bug in the marker. The list is sorted in the component now, beside the markers, rather than trusting a query's `ORDER BY`. And every element that encodes where the playhead is was checked for a transition: `transition-duration` is `0s` on the progress fill, the active-comment ring and the markers, with the only 0.15 s transition being `.btn`'s hover colours. That is the phase 5 rule applied before it could cost anything — a bar that animated to the current position would sit wherever it was when the window went behind something.

### Free-speech mode

No script loaded: transcribe an opponent's speech, then optionally have Claude flow it into the rebuttal-table structure. Doubles as a live-flowing tool.

---

## Files to create

```
supabase/
  README.md                how to apply them, and what they assume of a project
  migrations/*.sql         schema + search, RLS, team functions, recordings bucket
src-tauri/
  tauri.conf.json          window, SQLite plugin. No externalBin — see the whisper note
  tauri.bundle-whisper.conf.json   merged in at release time to bundle cli + models
  Cargo.toml
  src/main.rs, lib.rs
  src/whisper.rs           sidecar lifecycle, rolling-window worker, event emit
  src/audio.rs             PCM buffer, WAV writer, adaptive pause detection
  src/ogg.rs               Ogg pages, lacing and Ogg's own CRC-32 (pure)
  src/opus.rs              WAV -> Ogg Opus, and the recording's bytes over raw IPC
  src/coach.rs             Anthropic calls, keychain-backed key
  src/export.rs            extension-checked file write + `.dbcase` read
  src/sync.rs              the Supabase session, chunked across credential entries
  src/lan.rs               UDP discovery + a TCP relay, for a room with no internet
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
  sync/config.ts           whether this build has a project at all (pure)
  sync/rows.ts             local row <-> Postgres row, and what never goes up (pure)
  sync/store.ts            dirty-row queue, settings, cached library; pure backoff
  sync/supabase.ts         client, anonymous auth, team functions, library queries
  sync/engine.ts           the drain: cases before sessions, failure per row
  sync/library.ts          browse online or cached, and copy a teammate's case
  sync/recordings.ts       encode, share, fetch and take back down
  sync/provider.ts         the two wires: Supabase Realtime, and the Rust LAN relay
  collab/shape.ts          a case flattened to its own field paths; both directions (pure)
  collab/textDiff.ts       whole-value replacement -> one splice (pure)
  collab/doc.ts            the Y.Doc, and one immutable edit as the smallest CRDT delta
  collab/protocol.ts       the four messages a room speaks, and base64 (pure)
  collab/presence.ts       the roster, from heartbeats (pure)
  collab/session.ts        handshake, batching, presence, echo suppression — transport-free
  hooks/useCoPrep.ts       one room for one open case
  hooks/useSync.ts         sign-in, teams, drain — one screen's worth of state
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
  speech/comments.ts       comment ordering, markers, the active one (pure)
  hooks/useSpeechReview.ts live report, small.en re-pass, session row
  hooks/useRecording.ts    bytes -> blob URL, local or downloaded
  hooks/useComments.ts     the thread, cached one way and online the other
  components/              CaseEditor, SectionView, TemplateTable, FieldEditor,
                           SectionNav, SeatPicker, PrepTimer, CompletenessMeter,
                           Library, DepthPanel, CoachPanel, PreemptList, TeamSetup,
                           ExportPanel, SpeechSheetView
  components/speech/       SpeechView, Teleprompter, SpeechTimer, LiveTranscript,
                           SpeechReport, SessionHistory, Playback
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
9. ~~Supabase: schema, RLS, invite-code join, library sync~~ — done *(recording upload moved to 10, with the microphone it needs)*
10. ~~Coach comments on recordings, and the Opus upload they are anchored to~~ — done
11. ~~Live co-prep over Realtime, then the LAN fallback~~ — done *(the fallback is a relay in the Rust shell, not `y-webrtc`)*

---

## Code conventions

Enforced, not aspirational: ESLint `jsdoc/require-jsdoc` + `require-param-description` for TypeScript, `#![warn(missing_docs)]` for Rust. A missing docstring fails `npm run lint`.

**There is no CI, and this section said there was for eleven phases.** The rules are real and they do fail the build — but nothing runs them on push, so what enforces them is the five-command gate run by hand before each commit. Recorded rather than quietly corrected, because "enforced, not aspirational" was half true and the half that was false is exactly the half a reader would rely on.

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
- `doc-comment-auditor` was going to enforce the conventions above on changed files. ESLint does the mechanical half — `jsdoc/require-jsdoc`, `require-param-description`, `check-param-names`, `id-length`, `naming-convention` — and `npm run lint` fails on it. What is left is the judgement half: a comment that narrates the next line, an argument description that only restates its type. That is review, and it is cheaper as part of reading the diff than as a separate pass over every changed file.
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
| **supabase-rls** | 9 | ~~Writes migrations and *proves* the policies by attempting cross-team reads from a second identity. Security-critical and quietly easy to get wrong. Never marks a policy done without a failing-read test.~~ **Shipped as a test file instead — see below.** | opus |

Three of these land in phase 5, so they are worth writing *before* it rather than during.

**Phase 7 shipped without `prompt-guard`, and the reason is the one the table itself gives.** The brief was "red-team the Socratic constraint, verify the schema and the validator both hold" — adversarial against a fixed target, which is exactly where an agent pays. What it turned out to be was 46 assertions in three files, and the ones that mattered were not adversarial at all: the accepting case beside each rejecting pattern, which is what stops the guard eating honest questions. A cold agent trying to break the fence would have written more attacks on it and none of those. The content survived as a convention, the way `analyzer-rule`'s did: **every voice rule ships with an example it must let through.** The agent still has a real job on the next prompt change, when the fence is fixed and only the wording moves.

**`supabase-rls` was the last one standing, and phase 9 dissolved it the same way phase 3 dissolved `analyzer-rule` — by finding the structure that does the job every run instead of when someone remembers.** The brief was exactly right about what mattered: never mark a policy done without a failing-read test. What it assumed was that proving it needed a second live identity against a hosted project, which is a thing you do once and then stop doing. PGlite is Postgres compiled to WebAssembly, so the failing-read test is 38 assertions in `npx vitest run` with no Docker, no project and no credentials — and the policies are re-proved on every commit rather than on the day someone runs the agent. The half the brief could not have supplied is the half that turned out to matter most: **every denial assertion is paired with a permitted one**, because an agent trying to break in has no reason to check that the front door still opens. That is the same convention `analyzer-rule` left behind and `prompt-guard` left behind, arrived at for the third time.

**Phase 5 shipped without them too, and this time for a mechanical reason rather than a judgement:** `.claude/` is in `.gitignore` as per-machine state, so an agent definition written there is not team state and never reaches the repo. That is fine for `aligner-tester` in hindsight — the adversarial cases it was briefed to generate are the eight `describe` blocks in `align.test.ts`, written alongside the aligner while the contract was still moving, and the one that mattered (a jump between substantives discarding the confirmed prefix) came out of watching the DP misbehave, not out of a cold brief. `whisper-bench` still has a real job and now has a real surface to point at: `TranscriptionOptions` exists precisely so the window, tail and tick can be measured rather than guessed, and none of them has been. `rust-sidecar`'s work is done. If the agents are wanted, un-ignore `.claude/agents/` first.

**`crdt-sync` is split rather than kept.** The Yjs document shape and the doc↔row projection are design work tangled with the data model and the editor — inline. The convergence tests under partition are adversarial against a finished provider, and that half is agent work; fold it into phase 11 as a test brief rather than an agent that owns the feature.

**Phase 11 shipped without the agent half too, and for the fourth time the same reason.** The split was right about which part was adversarial: the convergence tests are exactly that, and they are the strongest thing in the phase. But they could not have been written against "a finished provider", because the three interleavings that mattered — a resurrected delete, a deleted addition, a clobbered sentence — are not failures of the *provider*. They are failures of the seam between an immutable-edit pipeline and a CRDT, and the only way to see them is to have just written that seam and noticed that a stale snapshot is indistinguishable from a partition. A cold agent handed a finished provider would have tested the provider, which was never where the bug was. What survives is the convention, again: **every convergence assertion runs two documents and a wire the test can take down** — a merge cannot be checked by reading it, exactly as a policy cannot.

**Still not agents.** The Case Builder UI, the script compiler, and the export path are one-off, highly interdependent, and easier to hold in one head than to brief — build those inline. Phases 1–3 confirmed it, and **phase 8 confirmed the export half specifically, though not for the reason given.** The export path is neither interdependent nor hard to brief; a ZIP writer and an OOXML emitter are about as isolated and as fixed-target as work gets. What an agent would have shipped is a file that is well-formed XML and that Word discards half of, because the win condition it would have been briefed against — "the reader gets the text back" — is satisfied by exactly that file. The thing that caught it was opening the result in Word, which is not a brief, it is knowing what would still be wrong once the tests passed.

---

## Verification

1. `npx vitest run` — every analyzer rule and every aligner case has unit tests. **Passing** at 907 tests across 44 files, alongside `cargo test` at 68.
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
12. **RLS test** — join two teams with different codes from two installs and confirm neither can read the other's cases, sessions, or recordings by any query. Mark a case `private` and confirm a teammate cannot see it. Rotate the invite code and confirm the old one stops working. **Done, against a real Postgres rather than two installs.** `src/sync/__tests__/rls.test.ts` applies the four shipped migration files to PGlite and runs Alice, Bob and Carol across two teams: every cross-team read of a team row, a member list, a case, a session, a motion, a comment and a storage object comes back empty or denied, including when the case id is passed in exactly. A private case is hidden from a teammate and absent from their search. A member cannot select `invite_code_hash` or `*` from `teams`. Nobody can insert themselves into `team_members` — there is no grant, and `join_team` is the only door. Rotation invalidates the old code and the new one works; a non-admin and an outsider are both refused. A storage path whose first segment is not a uuid is *denied* rather than raising a cast error, which would surface as a 500 and be recorded nowhere as an access denial.

    **Now also done against a hosted project — 63 live assertions, all passing.** Three anonymous identities, three teams, over real PostgREST. The run ends by deleting everything it made and asserting nothing is left, which is only possible because of the two functions below. Everything PGlite could not answer, answered:

    - **The schema cache resolves the embed.** `team_members.select('…, teams(name)')` comes back as an *object*, not an array. The array-tolerant branch in `myTeams` and `remoteRowToTeamCase` stays, because which shape PostgREST returns depends on when its cache was last reloaded, not on the schema — but on this project today it is an object.
    - **A denial through REST is not one thing.** A withheld column grant is `permission denied for table teams` on both `select invite_code_hash` and `select *`; a failed `with check` is `new row violates row-level security policy`; a failed `using` on a read is an empty array with a 200. The queue's per-row error handling sees all three.
    - **`case_search_text` works end to end.** A nonsense word buried in `fiveW1H.who` and a substantive is found by `search_cases` through the REST layer; the same query run by an outsider returns nothing; and searching `oneSentence` — a field *key* — returns nothing, which is the whole reason that function exists instead of `to_tsvector(doc::text)`.
    - **The foreign key fires as designed.** A session pointing at a case that is not up there is rejected with `23503`, which is what `sessionToRemoteRow`'s `hasSyncedCase` argument exists to avoid.
    - **Storage behaves.** A teammate downloads the object; the other team gets `Object not found` rather than a 403 that would confirm it exists; a teammate's delete leaves the file intact; and a path whose first segment is not a uuid is refused by the policy rather than raising a cast error.
    - **Rotation is real.** A member and an outsider are both refused with "only an admin can rotate the invite code"; after an admin rotates, the old code fails and the new one joins.

    **The one gap this found: there was no way to delete a team.** Creation goes through `create_team`, and there was no delete grant on `teams` and no counterpart function, so a team whose last member left was an unreachable row. The verification left three of them behind.

    Both are now proved live as well: the last admin is refused with the message that tells them what to do, handing over then leaving works, a plain member leaves freely, `delete_team` is refused to a member and to an outsider, refused again while a recording would be orphaned, and on success returns 1 — the one shared case, which survives with `team_id` null and `visibility` back to `private` while its teammate can no longer see it.

    Migration 5 adds `delete_team` — admin-only and explicit rather than automatic when the last member leaves, because a squad of one between tournaments is normal and a team that evaporates takes its invite code with it. It detaches rather than destroys: cases and sessions belong to the people who wrote them, so `team_id` goes null, and any case that was shared is set back to `private`. It refuses while the team still has recordings, since an object under a deleted team fails every storage policy and becomes both unplayable and undeletable.

    **Fixing it opened a second hole immediately**, which is the part worth keeping. Admin-only means `is_team_admin`, which reads a membership row — so a team whose last admin *left* still could not be deleted by anyone, and Leave sits next to Delete in the same panel. The invariant is now "every team has at least one admin", enforced by `team_members_keep_an_admin` on the way out rather than repaired afterwards. It is a prompt and not a trap, because an admin can promote anyone first. The subtlety is that `delete_team` cascades into the very rows the trigger guards, so it returns early when the parent team is already gone — without that check, deleting a team would raise the error the trigger exists to give.
13. **Recording round-trip** — record a speech, confirm the Opus upload is roughly a tenth the WAV's size, then play it back on a second machine and leave a comment at a timestamp that appears on the first. **Built, and everything except the second machine and the microphone is proved.**

    - **A tenth is measured, not claimed.** 12.34 s of 16 kHz mono WAV is 394,924 bytes and its Opus copy is 38,152 — a ratio of 0.097. A `cargo test` asserts the ratio stays under 0.15 on thirty seconds of tone so a bitrate change cannot quietly undo it.
    - **Three readers agree the file is an Opus file.** Our own demuxer recovers every packet and checks every page CRC; `ffprobe` reports `ogg` / `opus`, mono, 24.7 kbps; `ffmpeg` decodes it to a WAV of *exactly* the source duration — 12.340000 against 12.340000, which is both trims working — with the 1.5 s silence in the middle landing 5.8 ms from where it went in. That last number is the pre-skip constant being right.
    - **Chromium plays it**, which is the reader that actually matters, because the player is an `<audio>` element. A blob of the generated file reaches `readyState: 4`, reports 12.3465 s (granule including pre-skip — a player's duration does not subtract it, though its decode does), and `currentTime` advances 0.798 s over 900 ms of playing.
    - **The player was driven rather than looked at.** The progress fill's rendered width is 352.73 px of a 670 px bar at 6.5 s of 12.3465 — 0.5265 against 0.5265. The three comment markers sit at 66.96 / 334.82 / 669.64 px against an arithmetic 66.96 / 334.80 / 669.60. Seeking to 6.5 s highlights the note left at 6.17 s and not the one at 1.23 s. A comment of whitespace is refused before it is written, as the Postgres check constraint would refuse it hours later. Add and delete both round-trip through the real hooks.
    - **The comment policies were already right and are now proved from both ends.** Phase 9 tested a coach writing a note and an outsider being unable to read it; phase 10 adds that the debater whose speech it is *can* read it, *cannot* delete it — a hidden button is not an access control, and advice you can delete is advice you can ignore quietly — and that the coach can delete their own.

    **Still open**: no second machine, and still no microphone. Every recording that has been through this is a generated tone, and the round trip has run against one install. What only two installs can settle is the part of the sentence after "and": a comment left on a teammate's speech reaching the person who gave it. Everything under it is proved — the storage policies against a real Postgres and a hosted project, the comment policies both ways, the upload path itself — but the wire has not carried an actual speech.
14. **Co-prep test** — two instances edit different fields of one case simultaneously; confirm convergence with no lost text. Pull one machine off the network mid-edit and confirm it reconciles on rejoin. Then kill internet on both and confirm the LAN fallback still merges. **Built, and everything except two installs is proved.**

    - **Convergence is proved against two real documents, not described.** `src/collab/__tests__/doc.test.ts` runs two `Y.Doc`s through a wire a test can take down: two fields edited at once both survive; two people typing in *one* field keep both sentences, one inserting at the head and one at the tail; two concurrent "add a substantive" produce two substantives with the same ids on both sides; and a guest who types a whole row one keystroke at a time while partitioned reconciles with a host who was writing elsewhere. Three further tests cover the interleavings a snapshot-diff would get wrong — a resurrected delete, a deleted addition, and a clobbered sentence.
    - **The protocol is proved by running two whole sessions**, the same code both shipped transports drive, over an in-memory link: a joiner is handed the case with nobody elected to give it, an edit crosses both ways, twenty-two keystrokes leave as one message, the roster fills and empties, a peer that goes quiet times out, and four malformed frames in a row do not take the room down.
    - **The relay is proved in `cargo test`** with real sockets on loopback: a frame round-trips through the length prefix, the sender never receives its own, three other peers all get it, a dropped peer is forgotten rather than blocking the room, and a length prefix past the cap is refused instead of allocating. Discovery answers its own room over a real UDP broadcast and stays silent for another squad's.
    - **The policies are proved against a real Postgres**, paired both ways as phase 9 requires: the owner and a teammate can join a shared case's room; a teammate cannot join a private one and the other team cannot join either; six malformed topics are *denied rather than raised*, which is the `storage_team_id` trap again; a teammate can broadcast and the other team is refused with `row-level security`; a teammate reads the room's messages and the other team reads none; and un-sharing a case closes the room, which is what stops "make this private again" leaving a live feed open.
    - **The panel was driven in a browser** rather than looked at: all four states render with the right buttons enabled, nothing encoding a peer's position carries a CSS transition (`0s` on every one; the only 0.15 s is `.btn`'s hover colours), the panel does not overflow the rail, and the focus walk reports one path per field with no null between adjacent rows — which is the defect that walk was written to find.
    - **Migration 6 is applied, and the whole thing has now run against the hosted project.** Three anonymous identities, a real team, a real invite code, and two real `CollabSession`s over two real Realtime links. Everything one machine can answer, answered:
      - **Two identities converge over the live wire.** Alice seeds the room; the join handshake alone hands Bob the whole case, with nobody elected to give it. Alice types and it reaches Bob; Bob types and it reaches Alice — the second direction being the half a one-way pipe would pass.
      - **The policy decides the room, and it is not merely permissive.** The owner and a teammate may join a shared case; an outsider may not; a private case is its owner's alone and a *teammate* is refused it. Three malformed topics come back `false` rather than raising, which is the `storage_team_id` trap surviving contact with PostgREST.
      - **A refused room is refused at the channel.** An outsider's subscribe settles as `CHANNEL_ERROR` carrying the panel's own sentence — not a silent room that never delivers, which is what a policy denying reads while permitting joins would look like.
      - **Before the migration, the same project refused every room** with `Unauthorized: You do not have permissions to read from this Channel topic`, and `can_join_case_room` did not resolve at all. The fail-closed direction, confirmed from both sides of one project rather than argued.
      - The run deletes its cases and its team and **asserts the cleanup**, because `rpc` reports a failure in its result rather than throwing and a silent one leaves a team nobody can reach or remove.

    **Still open**: two installs. Everything above ran on one machine, so the one unproved clause is physical — a teammate's keystrokes arriving on *another computer's* screen. What separates that from what is proved is now only the hardware: two independent clients, two documents, two sessions and the real policy have all been in one room together over the real wire.
15. **Conventions hold** — `npm run lint` and `cargo clippy -- -D warnings` both pass with the docstring rules on. Then delete a docstring and a param description and confirm `npm run lint` actually fails, so the rule isn't quietly disabled.

    **The step as written assumed a CI that does not exist.** There is no `.github/` in this repo and nothing runs on push, so "confirm CI actually fails" was never a check anybody could perform. The rules themselves are real — ESLint and clippy do reject a missing docstring — but the thing standing between a bad commit and the trunk is a human running five commands. Either add the workflow or read this step as what it now says.
