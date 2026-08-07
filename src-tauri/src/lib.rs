//! Debate Coach desktop shell.
//!
//! Phase 1 wires the window and the local database only. The whisper sidecar, audio capture,
//! the Anthropic proxy, and the sync queue land in later phases as sibling modules.

#![warn(missing_docs)]
#![warn(clippy::all)]

pub mod db;

/// Boots the Tauri application and blocks until the window closes.
///
/// # Panics
/// Panics if the webview cannot be created or a database migration fails — both are
/// unrecoverable at startup, and a half-migrated database must not be written to.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DB_URL, db::migrations())
                .build(),
        )
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
