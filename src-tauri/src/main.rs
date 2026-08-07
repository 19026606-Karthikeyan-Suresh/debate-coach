// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop entry point. All behaviour lives in the library crate so integration tests can
//! link it without spawning a window.

fn main() {
    debate_coach_lib::run();
}
