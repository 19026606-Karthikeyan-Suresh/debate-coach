//! Where the Supabase session lives.
//!
//! The same split phase 7 made: the credential is in Rust, the protocol is in TypeScript.
//! supabase-js persists its session in `localStorage` by default, which in a desktop app is a
//! file in the webview's profile directory that any process running as this user can read. The
//! session holds a refresh token, and a refresh token is a long-lived key to this debater's
//! cases and their squad's — so it goes to the same per-user store the Anthropic key does.
//!
//! # Why this is chunked
//!
//! The Windows Credential Manager caps a credential blob at 2560 bytes, and `keyring` writes the
//! secret as UTF-16 — so the real limit is about 1280 characters. A Supabase session is a JWT, a
//! refresh token and a user object, comfortably past that. Writing it whole fails with
//! `ERROR_INVALID_PARAMETER`, which surfaces as "the parameter is incorrect" and says nothing
//! about length. It is therefore split across numbered entries with a count beside them.
//!
//! Nothing here parses the session. It is an opaque string to this module, which is what keeps
//! the token shape a supabase-js concern.

use serde::Serialize;

use crate::coach::CREDENTIAL_STORE;

/// Credential-manager service name. Shared with the Anthropic key so one uninstall finds both.
const KEYRING_SERVICE: &str = "com.kartixc.debatecoach";

/// Entry holding how many chunks the session was split into.
const COUNT_ACCOUNT: &str = "supabase-session-count";

/// Prefix for the chunk entries themselves; the index is appended.
const CHUNK_PREFIX: &str = "supabase-session-";

/// Characters per chunk.
///
/// 1000 against a real ceiling near 1280, because the ceiling is in *bytes* after UTF-16
/// encoding and a session containing anything outside the BMP would encode to two units per
/// character. The margin costs one extra credential entry and removes a failure that only
/// appears for some users.
const CHUNK_CHARS: usize = 1000;

/// Most chunks that will be written or read.
///
/// A session past 32 000 characters is not a session; refusing is better than filling somebody's
/// credential store with a runaway loop.
const MAX_CHUNKS: usize = 32;

/// Whether a session can be kept across launches, and where.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncIdentityStatus {
    /// True when a session is stored right now.
    pub has_session: bool,
    /// Human name of the credential store, for the team settings panel.
    pub backend: &'static str,
    /// False when the store does not outlive the process, which means signing in every launch.
    pub persistent: bool,
    /// Why the store could not be read, when the reason is something other than "nothing saved".
    pub error: Option<String>,
}

/// Splits a session into credential-sized pieces.
///
/// Splits on characters rather than bytes: slicing a UTF-8 string mid-codepoint panics, and the
/// session is JSON that may carry a debater's display name.
///
/// * `session` — the whole serialised session. An empty string yields no chunks, which reads
///   back as no session at all.
///
/// * `returns` — the pieces, in order.
#[must_use]
pub fn chunk_session(session: &str) -> Vec<String> {
    session
        .chars()
        .collect::<Vec<char>>()
        .chunks(CHUNK_CHARS)
        .map(|piece| piece.iter().collect())
        .collect()
}

/// Opens one credential entry.
///
/// # Errors
/// A message when the platform store cannot be addressed, which is different from the entry
/// being absent.
fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account).map_err(|error| error.to_string())
}

/// Reads one entry, treating "not there" as `None`.
fn read_entry(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Deletes one entry, treating "not there" as success.
fn delete_entry(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Reads the stored session.
///
/// * `returns` — the session as it was written, or `None` when there is none. A partially
///   written session — a count with a missing chunk, which is what a crash mid-save leaves —
///   reads as `None` rather than as a truncated token, because a truncated token fails
///   authentication in a way nobody can diagnose.
///
/// # Errors
/// A message when the credential store itself refuses.
#[tauri::command]
pub fn sync_session_get() -> Result<Option<String>, String> {
    let Some(count_text) = read_entry(COUNT_ACCOUNT)? else {
        return Ok(None);
    };
    let Ok(count) = count_text.parse::<usize>() else {
        return Ok(None);
    };
    if count == 0 || count > MAX_CHUNKS {
        return Ok(None);
    }

    let mut session = String::new();
    for index in 0..count {
        match read_entry(&format!("{CHUNK_PREFIX}{index}"))? {
            Some(piece) => session.push_str(&piece),
            None => return Ok(None),
        }
    }
    Ok(Some(session))
}

/// Stores a session, replacing whatever was there.
///
/// The count is written **last**. An interrupted save therefore leaves a stale count pointing at
/// chunks that no longer all exist, and [`sync_session_get`] reads that as no session — a fresh
/// sign-in, rather than half of two sessions spliced together.
///
/// * `session` — the serialised session. Empty clears it, which is what supabase-js does on
///   sign-out through its storage adapter.
///
/// # Errors
/// A message when the session is implausibly long or the credential store refuses a write.
#[tauri::command]
pub fn sync_session_set(session: String) -> Result<(), String> {
    if session.is_empty() {
        return sync_session_clear();
    }

    let pieces = chunk_session(&session);
    if pieces.len() > MAX_CHUNKS {
        return Err("that session is too large to store".to_owned());
    }

    sync_session_clear()?;
    for (index, piece) in pieces.iter().enumerate() {
        entry(&format!("{CHUNK_PREFIX}{index}"))?
            .set_password(piece)
            .map_err(|error| error.to_string())?;
    }
    entry(COUNT_ACCOUNT)?
        .set_password(&pieces.len().to_string())
        .map_err(|error| error.to_string())
}

/// Removes the stored session.
///
/// Clears the count first, so an interrupted clear leaves entries nothing points at rather than
/// a count pointing at entries that are gone. Both read as no session; this order also means the
/// next save overwrites the orphans.
///
/// # Errors
/// A message when the credential store refuses a delete.
#[tauri::command]
pub fn sync_session_clear() -> Result<(), String> {
    delete_entry(COUNT_ACCOUNT)?;
    for index in 0..MAX_CHUNKS {
        delete_entry(&format!("{CHUNK_PREFIX}{index}"))?;
    }
    Ok(())
}

/// Reports whether an identity can survive a quit.
///
/// Never fails: a broken credential store comes back as `has_session: false` with the reason in
/// `error`, because the Library has to render either way.
#[tauri::command]
pub fn sync_identity_status() -> SyncIdentityStatus {
    let (has_session, error) = match sync_session_get() {
        Ok(session) => (session.is_some(), None),
        Err(problem) => (false, Some(problem)),
    };

    SyncIdentityStatus {
        has_session,
        backend: CREDENTIAL_STORE,
        persistent: cfg!(windows),
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_a_short_session_in_one_piece() {
        assert_eq!(chunk_session("abc"), vec!["abc".to_owned()]);
    }

    #[test]
    fn splits_a_session_past_the_credential_limit() {
        // A real Supabase session is a JWT plus a refresh token plus a user object, which lands
        // here. Written whole, Windows rejects it with "the parameter is incorrect".
        let session = "x".repeat(2500);
        let pieces = chunk_session(&session);
        assert_eq!(pieces.len(), 3);
        assert_eq!(pieces.concat(), session);
    }

    #[test]
    fn rejoins_to_exactly_what_went_in() {
        let session = r#"{"access_token":"header.payload.signature","user":{"id":"abc"}}"#
            .repeat(40);
        assert_eq!(chunk_session(&session).concat(), session);
    }

    #[test]
    fn never_splits_a_character_in_half() {
        // Display names travel inside the session. Slicing UTF-8 by byte offset panics here.
        let session = "é".repeat(CHUNK_CHARS + 5);
        let pieces = chunk_session(&session);
        assert_eq!(pieces.len(), 2);
        assert_eq!(pieces.concat(), session);
    }

    #[test]
    fn treats_an_empty_session_as_no_chunks() {
        assert!(chunk_session("").is_empty());
    }
}
