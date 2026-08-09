//! Debate Coach desktop shell.
//!
//! Phase 1 wired the window and the local database; phase 5 added audio capture and the whisper
//! sidecar; phase 6 added the post-speech pass the report is built from; phase 7 the Anthropic
//! proxy; phase 8 the export path; phase 9 the Supabase session the team layer signs in with;
//! phase 11 the LAN relay co-prep falls back to when the room has no internet.

#![warn(missing_docs)]
#![warn(clippy::all)]

pub mod audio;
pub mod coach;
pub mod db;
pub mod export;
pub mod lan;
pub mod ogg;
pub mod opus;
pub mod sync;
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
        .plugin(tauri_plugin_dialog::init())
        // One recording slot for the whole app. A second speech cannot start while one is open,
        // which is enforced here by there being nowhere to put it.
        .manage(whisper::SpeechState::default())
        // One co-prep room at a time, for the same reason: a second relay on one install would
        // fan the same document into two rooms.
        .manage(lan::LanState::default())
        .invoke_handler(tauri::generate_handler![
            whisper::whisper_status,
            whisper::start_speech_session,
            whisper::push_speech_audio,
            whisper::stop_speech_session,
            whisper::retranscribe_speech,
            whisper::speech_sample_rate,
            audio::find_recording_pauses,
            opus::encode_recording_opus,
            opus::read_recording_bytes,
            opus::delete_recording,
            coach::coach_status,
            coach::run_coach_request,
            export::write_export_file,
            export::read_case_file,
            sync::sync_session_get,
            sync::sync_session_set,
            sync::sync_session_clear,
            sync::sync_identity_status,
            lan::lan_host,
            lan::lan_discover,
            lan::lan_connect,
            lan::lan_send,
            lan::lan_leave,
            lan::lan_status,
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
