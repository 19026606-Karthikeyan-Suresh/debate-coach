//! Layer B — the Claude coach, and the only part of the app that talks to a network.
//!
//! # What lives here and what does not
//!
//! This module owns two things: the API key, and the shape of the request on the wire. It owns
//! neither the words sent nor the meaning of what comes back. Those are in `src/coach/`, in
//! TypeScript, because that is where they can be tested — the Socratic constraint is a property
//! of a prompt, a JSON schema and a validator, and vitest can red-team all three without a
//! process boundary or an API key in the loop.
//!
//! The split is not arbitrary. The security property that matters is **the key never reaches the
//! webview**, and that holds however the frontend words its prompt. The invariants that matter on
//! the wire — which model, how many tokens, that a reply is schema-constrained, that a refusal is
//! not read as content — are the same for all three tasks, so they are constants here rather than
//! three copies in the caller.
//!
//! # Why the key is in the credential manager rather than a file
//!
//! PLAN said `tauri-plugin-stronghold`. Stronghold is an encrypted snapshot file that needs a
//! password to unlock, which means either prompting for a second password every launch or
//! hardcoding one — and a hardcoded password over an encrypted file is a file. Windows already
//! has a per-user secret store the OS unlocks at login, so the key goes there. `keyring` is the
//! crate; on Windows it is the Credential Manager, and [`coach_status`] reports which backend it
//! actually got so a build on a platform without one cannot quietly pretend the key was saved.
//!
//! # Failure is a first-class state
//!
//! Everything here is opt-in and everything degrades to Layer A. No key is not an error, it is a
//! status. A refusal, a rate limit and a dead network are three different messages because they
//! call for three different things from the debater, and "Claude failed" tells them none of it.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Credential-manager service name. Matches the bundle identifier so the entry is findable in
/// the Windows Credential Manager UI by someone who wants to delete it by hand.
const KEYRING_SERVICE: &str = "com.kartixc.debatecoach";

/// Credential-manager account name. One key per install; a second profile would need a second.
const KEYRING_ACCOUNT: &str = "anthropic-api-key";

/// The Messages endpoint. Nothing else in the app makes an outbound request.
const API_URL: &str = "https://api.anthropic.com/v1/messages";

/// Anthropic's dated API version header. Not the model version.
const API_VERSION: &str = "2023-06-01";

/// The model. Thinking is on by default on Opus 5, so no `thinking` parameter is sent — passing
/// one is either a no-op or, with `budget_tokens`, a 400.
const MODEL: &str = "claude-opus-5";

/// Output ceiling, covering thinking as well as the reply. The replies here are a few hundred
/// tokens of JSON; the headroom is for the thinking in front of them.
const MAX_TOKENS: u32 = 16_000;

/// Reasoning depth. The whole point of Layer B is the question Layer A's regexes cannot ask.
const EFFORT: &str = "high";

/// Opts into server-side refusal fallbacks. Opus 5's safety classifiers can decline a request
/// outright; with this the API re-runs it on Anthropic's recommended fallback instead of handing
/// back a refusal. See [`mentions_fallback`] for what happens when an account cannot use it.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// How long to wait. High effort plus a cold start can run past a minute, and the alternative to
/// waiting is a timeout error on a request that was about to succeed.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// Human name of the credential store this build actually got.
#[cfg(windows)]
const CREDENTIAL_STORE: &str = "Windows Credential Manager";

/// Human name of the credential store this build actually got.
#[cfg(not(windows))]
const CREDENTIAL_STORE: &str = "in-memory store (forgotten on quit)";

/// Everything that can go wrong reaching Claude.
///
/// Split finer than the HTTP status codes because the debater's next move differs: a bad key is
/// fixed in the settings box, a rate limit is fixed by waiting, and a dead network means finish
/// the prep on Layer A.
#[derive(Debug)]
pub enum CoachError {
    /// No key saved. The normal state, not a failure — Layer B is opt-in.
    NoKey,
    /// The credential store itself refused. Carries its message, which is usually specific.
    Keyring(String),
    /// The request never reached Anthropic: no route, DNS, TLS, or timeout.
    Network(String),
    /// 401. The key is wrong, revoked, or from a different organisation.
    Unauthorized,
    /// 429, with the `retry-after` seconds when the response carried one.
    RateLimited(Option<u64>),
    /// 500-series or 529. Retrying later is the whole remedy.
    Overloaded(u16),
    /// Any other non-2xx. Carries Anthropic's own message, which says more than a status.
    Api {
        /// The HTTP status, kept because 400 is what the fallback-beta retry keys off.
        status: u16,
        /// Anthropic's `error.message`, or the first 400 bytes of the body when it had none.
        message: String,
    },
    /// `stop_reason: "refusal"` — a successful HTTP 200 with nothing usable in it. Carries the
    /// policy category when the response named one.
    Refused(Option<String>),
    /// 200 with no text block, or a reply cut off at `max_tokens` mid-JSON.
    Unusable(String),
}

impl std::fmt::Display for CoachError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoKey => write!(formatter, "no Anthropic API key is saved"),
            Self::Keyring(message) => write!(formatter, "credential store failed: {message}"),
            Self::Network(message) => write!(formatter, "could not reach Anthropic: {message}"),
            Self::Unauthorized => {
                write!(formatter, "Anthropic rejected the saved key. Replace it and try again.")
            }
            Self::RateLimited(Some(seconds)) => {
                write!(formatter, "rate limited by Anthropic. Retry in {seconds}s.")
            }
            Self::RateLimited(None) => write!(formatter, "rate limited by Anthropic. Retry shortly."),
            Self::Overloaded(status) => {
                write!(formatter, "Anthropic is unavailable right now (HTTP {status}). Retry shortly.")
            }
            Self::Api { status, message } => write!(formatter, "Anthropic error {status}: {message}"),
            Self::Refused(Some(category)) => {
                write!(formatter, "Claude declined this request ({category}).")
            }
            Self::Refused(None) => write!(formatter, "Claude declined this request."),
            Self::Unusable(reason) => write!(formatter, "unusable reply: {reason}"),
        }
    }
}

impl std::error::Error for CoachError {}

/// Whether Layer B can run, and where the key is kept.
///
/// `persistent` is not decoration: on a build whose credential backend is the in-memory fallback,
/// a saved key survives until quit and no longer, and the settings box says so instead of letting
/// the debater discover it before a round.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoachStatus {
    /// True when a key is readable right now.
    pub has_key: bool,
    /// Human name of the credential store, for the settings box.
    pub backend: &'static str,
    /// False when the store does not outlive the process.
    pub persistent: bool,
    /// The model every request uses, so the UI never has to hardcode it a second time.
    pub model: &'static str,
    /// Why the key could not be read, when the reason is something other than "there is none".
    pub error: Option<String>,
}

/// One coaching call, as the frontend asks for it.
///
/// The frontend supplies only the three things that differ per task. Everything the wire needs
/// beyond these is fixed here, so a task cannot accidentally ship without its schema.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoachRequest {
    /// System prompt. Carries the Socratic rule in words; the schema carries it in structure.
    pub system: String,
    /// The user turn — the motion and the rows being asked about.
    pub user: String,
    /// JSON Schema the reply is constrained to. Anthropic compiles and caches it, so the same
    /// task pays the compilation cost once per day rather than once per call.
    pub schema: Value,
}

/// What came back.
///
/// `json` is the raw text of the reply's first text block, not a parsed object: the frontend owns
/// the shape, and re-serialising it here to hand it back would be two conversions to say nothing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoachReply {
    /// The model's reply, guaranteed by `output_config.format` to be JSON matching the schema.
    pub json: String,
    /// Model that actually served the reply. Differs from [`MODEL`] when a fallback ran.
    pub model: String,
    /// Billed input tokens, including anything served from cache.
    pub input_tokens: u64,
    /// Billed output tokens, thinking included.
    pub output_tokens: u64,
}

/// Opens the credential-store entry for the API key.
///
/// # Errors
/// [`CoachError::Keyring`] when the platform store cannot be addressed at all, which is a
/// different failure from the entry being absent.
fn entry() -> Result<keyring::Entry, CoachError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| CoachError::Keyring(error.to_string()))
}

/// Reads the saved key.
///
/// # Errors
/// [`CoachError::Keyring`] when the store errors. A *missing* entry is `Ok(None)` — not having a
/// key is the default state of the app, and treating it as an error would put a red message in
/// front of every debater who never opted in.
fn read_key() -> Result<Option<String>, CoachError> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(CoachError::Keyring(error.to_string())),
    }
}

/// Reports whether Layer B is usable.
///
/// Never fails: a broken credential store comes back as `has_key: false` with the reason in
/// `error`, because the Prep screen has to render regardless.
#[tauri::command]
pub fn coach_status() -> CoachStatus {
    let (has_key, error) = match read_key() {
        Ok(key) => (key.is_some(), None),
        Err(problem) => (false, Some(problem.to_string())),
    };

    CoachStatus {
        has_key,
        backend: CREDENTIAL_STORE,
        persistent: cfg!(windows),
        model: MODEL,
        error,
    }
}

/// Saves an API key to the credential store.
///
/// * `key` — the key. Trimmed, because a value pasted out of a browser usually arrives with a
///   newline on it and a stray newline in an HTTP header is a 401 nobody can explain. An empty
///   or whitespace-only key is refused rather than saved, since saving it would flip the UI to
///   "coaching on" and then fail on the first call.
///
/// # Errors
/// A message when the value is blank or the credential store refuses the write.
#[tauri::command]
pub fn save_coach_key(key: String) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("an API key is required".to_owned());
    }
    entry()
        .and_then(|slot| {
            slot.set_password(trimmed).map_err(|error| CoachError::Keyring(error.to_string()))
        })
        .map_err(|error| error.to_string())
}

/// Deletes the saved key.
///
/// Deleting when there is nothing saved succeeds — the caller's intent is "there should be no key
/// here", and that is already true.
///
/// # Errors
/// A message when the credential store refuses the delete.
#[tauri::command]
pub fn clear_coach_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(CoachError::Keyring(error.to_string()).to_string()),
    }
}

impl From<CoachError> for String {
    fn from(error: CoachError) -> Self {
        error.to_string()
    }
}

/// Builds the request body.
///
/// Pure and separate from the send so `cargo test` can pin the wire shape without a key or a
/// network — every constant in this file is a decision that would otherwise only be checked by
/// a live call.
///
/// * `request` — the per-task parts.
/// * `with_fallbacks` — whether to ask for a server-side refusal fallback. False on the retry
///   described in [`mentions_fallback`].
fn build_body(request: &CoachRequest, with_fallbacks: bool) -> Value {
    let mut body = json!({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": request.system,
        "messages": [{ "role": "user", "content": request.user }],
        "output_config": {
            "effort": EFFORT,
            // The structural half of the Socratic constraint. The schema has no free-prose field
            // for Claude to write the debater's argument into, so it cannot, whatever the prompt.
            "format": { "type": "json_schema", "schema": request.schema },
        },
    });

    if with_fallbacks {
        // `"default"` rather than a named model: the right substitute depends on why the request
        // was declined, and a pinned name is a migration owed the next time it is deprecated.
        body["fallbacks"] = json!("default");
    }
    body
}

/// True when a 400 looks like the account cannot use the refusal-fallback beta.
///
/// Betas are enabled per organisation, and an account without this one gets a 400 rather than
/// having the parameter ignored. That would take Layer B down entirely over an optional
/// robustness feature, so a 400 mentioning it is retried once without it — see
/// [`run_coach_request`]. Matching on message text is fragile by nature; the cost of a false
/// positive is one retry that fails the same way, which is why it is safe to be loose here.
fn mentions_fallback(message: &str) -> bool {
    let lowered = message.to_lowercase();
    lowered.contains("fallback") || lowered.contains(FALLBACK_BETA)
}

/// Pulls Anthropic's own error message out of an error body, falling back to the raw text.
fn api_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|parsed| parsed["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| body.chars().take(400).collect())
}

/// Turns a non-2xx response into the error that says what to do about it.
fn status_error(status: u16, retry_after: Option<u64>, body: &str) -> CoachError {
    match status {
        401 | 403 => CoachError::Unauthorized,
        429 => CoachError::RateLimited(retry_after),
        500..=599 => CoachError::Overloaded(status),
        _ => CoachError::Api { status, message: api_message(body) },
    }
}

/// Sends one request and returns the parsed JSON envelope.
///
/// * `client` — the HTTP client, carrying the timeout.
/// * `key` — the API key. Goes in `x-api-key`; never logged, never returned.
/// * `body` — from [`build_body`].
/// * `with_fallbacks` — must match what was passed to [`build_body`], because the beta header and
///   the `fallbacks` parameter are a pair and sending one without the other is a 400.
///
/// # Errors
/// [`CoachError::Network`] before a response, or a status-derived error after one.
async fn send_once(
    client: &reqwest::Client,
    key: &str,
    body: &Value,
    with_fallbacks: bool,
) -> Result<Value, CoachError> {
    let mut request = client
        .post(API_URL)
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json");
    if with_fallbacks {
        request = request.header("anthropic-beta", FALLBACK_BETA);
    }

    let response =
        request.json(body).send().await.map_err(|error| CoachError::Network(error.to_string()))?;

    let status = response.status().as_u16();
    // Read before the body: consuming the body moves the response and takes the headers with it.
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());

    let text = response.text().await.map_err(|error| CoachError::Network(error.to_string()))?;

    if !(200..300).contains(&status) {
        return Err(status_error(status, retry_after, &text));
    }
    serde_json::from_str(&text)
        .map_err(|error| CoachError::Unusable(format!("response was not JSON: {error}")))
}

/// Reads the reply out of a successful envelope.
///
/// Checks `stop_reason` **before** touching `content`: a refusal is an HTTP 200 whose content is
/// empty, so code that indexes the first block first panics on the one case this exists to
/// handle. Thinking blocks arrive ahead of the text and carry no text of their own, which is why
/// this scans for the first `text` block rather than taking `content[0]`.
///
/// # Errors
/// [`CoachError::Refused`] when the safety classifiers declined, or [`CoachError::Unusable`] when
/// the reply was truncated at `max_tokens` or carried no text block at all.
fn parse_reply(payload: &Value) -> Result<CoachReply, CoachError> {
    let stop_reason = payload["stop_reason"].as_str().unwrap_or_default();
    if stop_reason == "refusal" {
        let category = payload["stop_details"]["category"].as_str().map(str::to_owned);
        return Err(CoachError::Refused(category));
    }
    if stop_reason == "max_tokens" {
        return Err(CoachError::Unusable(
            "Claude ran out of output tokens before finishing. Try one substantive at a time."
                .to_owned(),
        ));
    }

    let text = payload["content"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|block| block["type"] == "text")
        .and_then(|block| block["text"].as_str())
        .ok_or_else(|| CoachError::Unusable("no text block in the reply".to_owned()))?;

    Ok(CoachReply {
        json: text.to_owned(),
        model: payload["model"].as_str().unwrap_or(MODEL).to_owned(),
        input_tokens: payload["usage"]["input_tokens"].as_u64().unwrap_or_default(),
        output_tokens: payload["usage"]["output_tokens"].as_u64().unwrap_or_default(),
    })
}

/// Runs one coaching request against Anthropic.
///
/// Async because it is a network call of unbounded length behind a button: on the main thread
/// this is the Prep screen freezing for the whole of a high-effort reply, which is the same
/// mistake phase 6 found in `retranscribe_speech`.
///
/// * `request` — system prompt, user turn, and the schema the reply is constrained to. The
///   schema is not optional: a request without one would let Claude answer in prose, which is
///   the one thing the Socratic rule forbids.
///
/// # Errors
/// A human-readable message. [`CoachError`] distinguishes the cases the debater can act on —
/// missing key, bad key, rate limit, refusal, no network — and the message names which.
#[tauri::command]
pub async fn run_coach_request(request: CoachRequest) -> Result<CoachReply, String> {
    let key = read_key()?.ok_or(CoachError::NoKey)?;

    // Built per call rather than pooled. A coaching call happens when someone presses a button,
    // three times in a prep at most, so a reused connection would save a handshake nobody
    // notices and cost a static that has to stay valid across a key change.
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| CoachError::Network(error.to_string()))?;

    let payload = match send_once(&client, &key, &build_body(&request, true), true).await {
        Err(CoachError::Api { status: 400, message }) if mentions_fallback(&message) => {
            log::warn!("refusal fallbacks unavailable on this account, retrying without: {message}");
            send_once(&client, &key, &build_body(&request, false), false).await
        }
        other => other,
    }?;

    parse_reply(&payload).map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal request, standing in for any of the three tasks.
    fn sample_request() -> CoachRequest {
        CoachRequest {
            system: "Ask, never answer.".to_owned(),
            user: "Motion: THW ban X".to_owned(),
            schema: json!({ "type": "object", "additionalProperties": false }),
        }
    }

    #[test]
    fn body_pins_the_model_and_the_reasoning_budget() {
        let body = build_body(&sample_request(), true);
        assert_eq!(body["model"], "claude-opus-5");
        assert_eq!(body["max_tokens"], 16_000);
        assert_eq!(body["output_config"]["effort"], "high");
    }

    #[test]
    fn body_always_carries_a_schema() {
        let body = build_body(&sample_request(), true);
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert!(body["output_config"]["format"]["schema"].is_object());
    }

    /// Thinking is on by default on Opus 5 and sampling parameters are rejected outright, so the
    /// body must carry neither. Both are easy to add back by habit from an older model.
    #[test]
    fn body_omits_parameters_opus_5_rejects() {
        let body = build_body(&sample_request(), true);
        for removed in ["thinking", "temperature", "top_p", "top_k"] {
            assert!(body.get(removed).is_none(), "{removed} must not be sent");
        }
    }

    #[test]
    fn fallbacks_are_opt_in_and_droppable() {
        assert_eq!(build_body(&sample_request(), true)["fallbacks"], "default");
        assert!(build_body(&sample_request(), false).get("fallbacks").is_none());
    }

    #[test]
    fn a_refusal_is_not_read_as_content() {
        let payload = json!({
            "model": "claude-opus-5",
            "stop_reason": "refusal",
            "stop_details": { "type": "refusal", "category": "cyber" },
            "content": [],
        });
        match parse_reply(&payload) {
            Err(CoachError::Refused(Some(category))) => assert_eq!(category, "cyber"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn thinking_blocks_are_skipped_to_reach_the_json() {
        let payload = json!({
            "model": "claude-opus-5",
            "stop_reason": "end_turn",
            "content": [
                { "type": "thinking", "thinking": "" },
                { "type": "text", "text": "{\"questions\":[]}" },
            ],
            "usage": { "input_tokens": 12, "output_tokens": 3 },
        });
        let reply = parse_reply(&payload).expect("a text block is present");
        assert_eq!(reply.json, "{\"questions\":[]}");
        assert_eq!(reply.input_tokens, 12);
        assert_eq!(reply.output_tokens, 3);
    }

    #[test]
    fn a_truncated_reply_is_refused_rather_than_parsed() {
        let payload = json!({
            "stop_reason": "max_tokens",
            "content": [{ "type": "text", "text": "{\"questions\":[\"why" }],
        });
        assert!(matches!(parse_reply(&payload), Err(CoachError::Unusable(_))));
    }

    #[test]
    fn a_rate_limit_carries_its_retry_delay() {
        match status_error(429, Some(30), "{}") {
            CoachError::RateLimited(Some(seconds)) => assert_eq!(seconds, 30),
            other => panic!("expected a rate limit, got {other:?}"),
        }
    }

    #[test]
    fn anthropics_own_message_survives_an_api_error() {
        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad schema"}}"#;
        match status_error(400, None, body) {
            CoachError::Api { message, .. } => assert_eq!(message, "bad schema"),
            other => panic!("expected an api error, got {other:?}"),
        }
    }

    #[test]
    fn the_fallback_retry_only_fires_on_a_fallback_complaint() {
        assert!(mentions_fallback("fallbacks: unsupported beta"));
        assert!(!mentions_fallback("max_tokens: must be greater than 0"));
    }
}
