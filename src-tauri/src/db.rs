//! Local SQLite schema and migrations.
//!
//! SQLite is the source of truth; Supabase (phase 9) replicates from it. The column names
//! here deliberately match the Postgres schema in `PLAN.md` so sync is a row copy rather
//! than a translation layer. Two deviations are forced by SQLite: `jsonb` columns are `TEXT`
//! holding serialised JSON, and `bytea` is `BLOB`.

use tauri_plugin_sql::{Migration, MigrationKind};

/// Filename of the local database, resolved against the app data directory by the SQL plugin.
pub const DB_URL: &str = "sqlite:debate-coach.db";

/// Every migration, in application order.
///
/// # Panics
/// Never panics itself, but the plugin will panic at startup if a migration's `version` is
/// reused with different SQL after it has run on a machine — versions are append-only.
/// Never edit a shipped migration; add the next one.
pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "core case, motion, session, comment and sync tables",
            sql: INITIAL_SCHEMA,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "speech report detail alongside the syncable metrics",
            sql: SESSION_REPORT,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "settings, cached team library, and a dedupable sync queue",
            sql: SYNC_STATE,
            kind: MigrationKind::Up,
        },
    ]
}

// `cases.doc` holds the whole filled template as JSON — the plain-object projection of the
// Yjs document, matching the `Case` type in src/types/case.ts. Keeping it in one column
// rather than a table per template block means adding a field is a frontend-only change.
//
// `ydoc_state` is the Yjs update blob. Null until a case has been opened in a co-prep room;
// it exists from phase 1 so phase 11 does not need a migration on live data.
//
// `sync_queue` drains when connectivity returns. `attempts` gates exponential backoff so a
// row that fails permanently does not spin.
const INITIAL_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS teams (
    id                TEXT PRIMARY KEY NOT NULL,
    name              TEXT NOT NULL,
    created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
    team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id           TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    role              TEXT NOT NULL CHECK (role IN ('member', 'coach', 'admin')),
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS cases (
    id                TEXT PRIMARY KEY NOT NULL,
    team_id           TEXT REFERENCES teams(id) ON DELETE SET NULL,
    owner_id          TEXT,
    motion            TEXT NOT NULL DEFAULT '',
    format            TEXT NOT NULL CHECK (format IN ('AP', 'BP')),
    side              TEXT NOT NULL CHECK (side IN ('gov', 'opp')),
    position          TEXT NOT NULL DEFAULT '',
    doc               TEXT NOT NULL,
    ydoc_state        BLOB,
    visibility        TEXT NOT NULL DEFAULT 'private'
                      CHECK (visibility IN ('private', 'team')),
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cases_updated_at ON cases(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_team ON cases(team_id);

CREATE TABLE IF NOT EXISTS motions (
    id                TEXT PRIMARY KEY NOT NULL,
    team_id           TEXT REFERENCES teams(id) ON DELETE CASCADE,
    text              TEXT NOT NULL,
    tournament        TEXT,
    date              TEXT,
    source            TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id                TEXT PRIMARY KEY NOT NULL,
    team_id           TEXT REFERENCES teams(id) ON DELETE SET NULL,
    user_id           TEXT,
    case_id           TEXT REFERENCES cases(id) ON DELETE SET NULL,
    format            TEXT NOT NULL CHECK (format IN ('AP', 'BP')),
    role              TEXT NOT NULL DEFAULT '',
    duration_s        INTEGER NOT NULL DEFAULT 0,
    metrics           TEXT NOT NULL DEFAULT '{}',
    recording_path    TEXT,
    created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_case ON sessions(case_id);

CREATE TABLE IF NOT EXISTS comments (
    id                TEXT PRIMARY KEY NOT NULL,
    session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    author_id         TEXT,
    t_seconds         REAL NOT NULL,
    body              TEXT NOT NULL,
    created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_session ON comments(session_id, t_seconds);

CREATE TABLE IF NOT EXISTS sync_queue (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name        TEXT NOT NULL,
    row_id            TEXT NOT NULL,
    operation         TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    payload           TEXT,
    attempts          INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    queued_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_queued_at ON sync_queue(queued_at);
"#;

// Two columns for one speech, split by what leaves the machine.
//
// `metrics` is a dozen numbers — skip rate, filler rate, pace — and it is what phase 9 syncs, so
// a squad can see each other's trends. `report` is the detail those numbers came from: the
// transcript, every skipped run with the case field it belongs to, the improvisations, the
// pauses. That is a recording of somebody speaking, held in text, and it stays local until there
// is an explicit reason for it not to.
//
// `SELECT *` on `sessions` is never used, so an added column cannot surprise a reader of a row.
const SESSION_REPORT: &str = r#"
ALTER TABLE sessions ADD COLUMN report TEXT;
"#;

// What phase 9 needs locally, which is three separate things.
//
// `app_settings` holds the small facts sync needs across launches: which team is active, which
// `auth.uid()` this install signed in as, and when the library was last pulled. A key-value table
// rather than columns because every one of them is a single row and adding the next one should
// not be a migration.
//
// `team_library` is the cached listing of teammates' shared cases, kept apart from `cases` on
// purpose. Folding them in would make `listCases` return work this install cannot edit — RLS
// says only the owner writes a case — and would mean downloading every teammate's whole document
// to draw a list. The summary is enough to browse and search offline; the document is fetched
// only when someone imports one.
//
// The unique index turns `sync_queue` into a set of dirty rows rather than a log. A case edited
// forty times on a train pushes once, with its final text, because the queue holds the id and the
// payload is re-read at drain time. `payload` therefore stays null and is the one column of the
// phase 1 schema that nothing writes.
const SYNC_STATE: &str = r#"
CREATE TABLE IF NOT EXISTS app_settings (
    key               TEXT PRIMARY KEY NOT NULL,
    value             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_library (
    id                TEXT PRIMARY KEY NOT NULL,
    team_id           TEXT NOT NULL,
    owner_id          TEXT NOT NULL,
    owner_name        TEXT NOT NULL DEFAULT '',
    motion            TEXT NOT NULL DEFAULT '',
    format            TEXT NOT NULL,
    side              TEXT NOT NULL,
    position          TEXT NOT NULL DEFAULT '',
    updated_at        TEXT NOT NULL,
    cached_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_library_updated ON team_library(updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_queue_row ON sync_queue(table_name, row_id);
"#;
