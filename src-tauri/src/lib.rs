//! Debate Coach desktop shell.
//!
//! Phase 1 wired the window and the local database; phase 5 added audio capture and the whisper
//! sidecar; phase 6 added the post-speech pass the report is built from; phase 7 adds the
//! Anthropic proxy. The sync queue lands in a later phase as a sibling module.

#![warn(missing_docs)]
#![warn(clippy::all)]

pub mod audio;
pub mod coach;
pub mod db;
pub mod whisper;

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
        // One recording slot for the whole app. A second speech cannot start while one is open,
        // which is enforced here by there being nowhere to put it.
        .manage(whisper::SpeechState::default())
        .invoke_handler(tauri::generate_handler![
            whisper::whisper_status,
            whisper::start_speech_session,
            whisper::push_speech_audio,
            whisper::stop_speech_session,
            whisper::retranscribe_speech,
            whisper::speech_sample_rate,
            audio::find_recording_pauses,
            coach::coach_status,
            coach::save_coach_key,
            coach::clear_coach_key,
            coach::run_coach_request,
        ])
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
