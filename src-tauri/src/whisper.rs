//! The whisper sidecar — a microphone becomes words the aligner can index.
//!
//! # Why this is not what PLAN.md described
//!
//! PLAN specified "Web Audio captures mic → Tauri command streams PCM to the `whisper-stream`
//! sidecar's stdin". That cannot be built, and the reason is worth recording rather than
//! rediscovering: whisper.cpp's `stream` example **opens the microphone itself** through SDL2.
//! It has no stdin path, so there is nothing to pipe PCM into, and adopting it would mean
//! bundling SDL2, giving up device selection and echo cancellation the browser already does,
//! and handing audio capture to a process that cannot also hand back a WAV for the `small.en`
//! re-pass PLAN requires.
//!
//! What is built instead keeps every property the plan actually wanted:
//!
//! - The browser still captures the mic and still sends 16 kHz mono PCM over one Tauri command.
//! - Rust still owns the sidecar lifecycle and still emits partials over an event channel.
//! - The WAV still lands on disk for `small.en` to re-transcribe afterwards.
//!
//! Only the middle changes. A worker thread runs plain `whisper-cli` — the binary every
//! whisper.cpp build produces, no SDL2 — over a **rolling window** of the audio so far, on a
//! timer. That costs a little latency against a true streaming decoder, and buys three things:
//! the window length, the overlap and the tick are numbers `whisper-bench` can tune; a crashed
//! transcription loses one window rather than the speech; and the same binary serves the live
//! pass and the post-speech re-pass.
//!
//! # How the window advances
//!
//! whisper-cli prints each segment with a real timestamp, and it puts segment boundaries at
//! pauses. So a segment that ends comfortably before the end of the window is **finished** — no
//! later audio will revise it — and its text is appended to a committed prefix while the window
//! slides past it. Everything after that point is the live tail, re-decoded on every tick and
//! therefore free to change. The frontend is handed `committed + tail` as one transcript, which
//! is exactly the contract `advanceAlignment` documents: give it everything, every time, and it
//! will re-read only what is not yet frozen.
//!
//! Cutting at segment boundaries rather than at a fixed offset is what keeps a word from being
//! sliced in half across two windows.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::audio::{samples_at, seconds_of, write_wav, PcmBuffer, SAMPLE_RATE};

/// Event the frontend listens on for live transcripts. One payload per tick.
pub const TRANSCRIPT_EVENT: &str = "speech://transcript";

/// Live model. Small enough to stay ahead of a fast speaker on CPU.
const LIVE_MODEL: &str = "ggml-base.en.bin";

/// Review model. Slower and better; only ever run once, after the speech.
const REVIEW_MODEL: &str = "ggml-small.en.bin";

/// Overrides the resolved `whisper-cli`. Set by `whisper-bench`, never by the app.
const CLI_ENV: &str = "DEBATE_COACH_WHISPER_CLI";

/// Overrides the directory the `.bin` models are looked up in.
const MODELS_ENV: &str = "DEBATE_COACH_WHISPER_MODELS";

/// What went wrong reaching whisper.
#[derive(Debug)]
pub enum WhisperError {
    /// No `whisper-cli` in any of the searched locations. The signal to fall back to
    /// `WebSpeechSource` rather than to show the debater an error before a round.
    SidecarUnavailable(Vec<PathBuf>),
    /// The binary is present but the model file is not.
    ModelMissing(PathBuf),
    /// A speech is already being recorded. Two sessions would interleave into one buffer.
    AlreadyRecording,
    /// No speech is being recorded.
    NotRecording,
    /// Reading or writing audio failed.
    Io(std::io::Error),
    /// whisper-cli ran and failed. Carries its stderr, which says why far better than we can.
    Failed(String),
}

impl std::fmt::Display for WhisperError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SidecarUnavailable(searched) => {
                let places = searched
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                write!(formatter, "whisper-cli not found. Looked in: {places}")
            }
            Self::ModelMissing(path) => write!(formatter, "model not found: {}", path.display()),
            Self::AlreadyRecording => write!(formatter, "a speech is already being recorded"),
            Self::NotRecording => write!(formatter, "no speech is being recorded"),
            Self::Io(error) => write!(formatter, "audio i/o failed: {error}"),
            Self::Failed(stderr) => write!(formatter, "whisper-cli failed: {stderr}"),
        }
    }
}

impl std::error::Error for WhisperError {}

impl From<std::io::Error> for WhisperError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Tunables for the rolling window.
///
/// Exposed on the start command rather than hardcoded because they are exactly what
/// `whisper-bench` exists to measure — every default below is a guess until it has run.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TranscriptionOptions {
    /// Seconds between transcription attempts. The floor on how stale the teleprompter can be.
    pub tick_ms: u64,
    /// Seconds at the end of the window held back from committing, because a segment that ends
    /// near the edge may still be revised when the next second of audio arrives.
    pub tail_seconds: f64,
    /// Window length past which a commit is forced even with no segment boundary to cut on.
    /// Without it, a speaker who never pauses grows the window for the whole speech.
    pub max_window_seconds: f64,
    /// Decode threads. More than four buys little and starves the UI thread on a laptop.
    pub threads: u32,
}

impl Default for TranscriptionOptions {
    fn default() -> Self {
        Self {
            tick_ms: 1_200,
            tail_seconds: 2.0,
            max_window_seconds: 24.0,
            threads: 4,
        }
    }
}

/// Least audio worth sending to whisper. Below a second it hallucinates a word out of a breath.
const MIN_WINDOW_SECONDS: f64 = 1.0;

/// Where whisper was found, and where the models are.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperAssets {
    /// The `whisper-cli` executable.
    pub cli: PathBuf,
    /// `base.en` — the live pass.
    pub live_model: PathBuf,
    /// `small.en` — the post-speech pass the report is built from.
    pub review_model: PathBuf,
}

/// What the frontend needs to decide between the whisper source and the browser fallback.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperStatus {
    /// True only when the binary and the live model are both present. The review model missing
    /// does not disable live transcription — it only costs the accurate post-pass.
    pub available: bool,
    /// Resolved paths, or null when the search failed.
    pub assets: Option<WhisperAssets>,
    /// Why it is unavailable, phrased for a person. Null when it is available.
    pub reason: Option<String>,
}

/// One timestamped chunk of transcript as whisper-cli prints it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    /// Seconds from the start of the file it was decoded from — the window, not the speech.
    pub start: f64,
    /// End in the same frame of reference.
    pub end: f64,
    /// The words, already trimmed. Never empty; blank segments are dropped at parse time.
    pub text: String,
}

/// The accurate transcript, and the timings that only the post-speech pass has.
///
/// The live path emits text alone: its windows are re-decoded and slid past, so a timestamp from
/// one of them means nothing once the window has moved. This pass decodes the whole recording
/// once, in one frame of reference, which is what lets the report put a time on a filler and a
/// duration on a section.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTranscript {
    /// Every segment's text, joined by single spaces. What the aligner is re-run against.
    pub text: String,
    /// The same words, still carrying the times they were said at.
    pub segments: Vec<TranscriptSegment>,
}

/// A live transcript, as it stands this tick.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptUpdate {
    /// Everything heard so far, committed prefix and live tail already joined. Always the whole
    /// transcript, never a delta — the aligner re-reads only what it has not frozen.
    pub text: String,
    /// Seconds of audio this transcript accounts for. Drives the live words-per-minute readout.
    pub audio_seconds: f64,
    /// True on the flush emitted after the speech stops.
    pub is_final: bool,
}

/// A recording in progress.
struct Session {
    /// Where the WAV will be written when the speech ends.
    wav_path: PathBuf,
    pcm: Arc<PcmBuffer>,
    /// Set to stop the worker. It checks between ticks, so stopping takes up to one window.
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

/// The one recording the app may have open, held as Tauri managed state.
#[derive(Default)]
pub struct SpeechState {
    session: Mutex<Option<Session>>,
}

/// What `stop_speech_session` hands back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecording {
    /// The WAV, kept local. Phase 9 encodes a copy to Opus for upload; this one never leaves.
    pub wav_path: PathBuf,
    /// Audio actually captured, which is shorter than the speech clock by whatever the mic
    /// missed while the capture graph was starting.
    pub duration_seconds: f64,
}

// ---------------------------------------------------------------------------
// Locating the binary and the models
// ---------------------------------------------------------------------------

/// Directories `whisper-cli` may live in, in the order they are searched.
///
/// Next to the executable first, because that is where Tauri's `externalBin` puts a bundled
/// sidecar and a bundled one must always win over a developer's stray copy. The app-data
/// directory second, because that is where `scripts/fetch-whisper.ps1` installs it during
/// development, when nothing has been bundled yet.
fn cli_search_paths<TRuntime: Runtime>(app: &AppHandle<TRuntime>) -> Vec<PathBuf> {
    let executable_name = if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" };
    let mut candidates = Vec::new();

    if let Ok(override_path) = std::env::var(CLI_ENV) {
        candidates.push(PathBuf::from(override_path));
    }
    if let Ok(current) = std::env::current_exe() {
        if let Some(directory) = current.parent() {
            candidates.push(directory.join(executable_name));
        }
    }
    if let Ok(data_dir) = app.path().app_data_dir() {
        candidates.push(data_dir.join("whisper").join(executable_name));
    }
    candidates
}

/// Directories the `.bin` models may live in, in the order they are searched.
fn model_search_paths<TRuntime: Runtime>(app: &AppHandle<TRuntime>, name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(override_dir) = std::env::var(MODELS_ENV) {
        candidates.push(PathBuf::from(override_dir).join(name));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("models").join(name));
    }
    if let Ok(data_dir) = app.path().app_data_dir() {
        candidates.push(data_dir.join("whisper").join("models").join(name));
    }
    candidates
}

/// First candidate that exists on disk.
fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|path| path.is_file()).cloned()
}

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
) -> Result<WhisperAssets, WhisperError> {
    let cli_candidates = cli_search_paths(app);
    let cli = first_existing(&cli_candidates)
        .ok_or_else(|| WhisperError::SidecarUnavailable(cli_candidates.clone()))?;

    let live_candidates = model_search_paths(app, LIVE_MODEL);
    let live_model = first_existing(&live_candidates).ok_or_else(|| {
        WhisperError::ModelMissing(
            live_candidates.first().cloned().unwrap_or_else(|| PathBuf::from(LIVE_MODEL)),
        )
    })?;

    // The review model is optional at this stage: a missing `small.en` costs the accurate
    // post-pass, not the live teleprompter, and refusing to start a speech over it would be
    // punishing the debater for a download.
    let review_model = first_existing(&model_search_paths(app, REVIEW_MODEL))
        .unwrap_or_else(|| live_model.clone());

    Ok(WhisperAssets { cli, live_model, review_model })
}

// ---------------------------------------------------------------------------
// Running whisper-cli
// ---------------------------------------------------------------------------

/// Parses `HH:MM:SS.mmm` into seconds. Returns None on anything else.
fn parse_timestamp(stamp: &str) -> Option<f64> {
    let mut parts = stamp.trim().split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// Reads whisper-cli's stdout into segments.
///
/// Every line that is not a `[start --> end] text` row is ignored rather than treated as an
/// error. whisper-cli prints a system-information banner, and which lines it prints has changed
/// between releases — a parser that insists on the exact shape of the whole output breaks on a
/// version bump, while one that picks out the rows it recognises does not.
///
/// * `stdout` — the process's whole standard output.
/// * `returns` — segments in the order printed, blank ones dropped.
#[must_use]
pub fn parse_segments(stdout: &str) -> Vec<TranscriptSegment> {
    let mut segments = Vec::new();

    for line in stdout.lines() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix('[') else {
            continue;
        };
        let Some((stamps, text)) = rest.split_once(']') else {
            continue;
        };
        let Some((start_stamp, end_stamp)) = stamps.split_once("-->") else {
            continue;
        };
        let (Some(start), Some(end)) = (parse_timestamp(start_stamp), parse_timestamp(end_stamp))
        else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        segments.push(TranscriptSegment { start, end, text: text.to_owned() });
    }

    segments
}

/// Transcribes one WAV file.
///
/// * `cli` — the resolved binary. A path that does not exist surfaces as [`WhisperError::Io`].
/// * `model` — a `.bin` matching the language the flags claim; passing a multilingual model with
///   `-l en` works, passing `ggml-base.en.bin` with another language silently produces English.
/// * `wav` — must be 16 kHz mono. whisper.cpp resamples nothing.
/// * `threads` — clamped to at least one.
///
/// # Errors
/// [`WhisperError::Failed`] with the process's stderr when it exits non-zero.
pub fn transcribe_wav(
    cli: &Path,
    model: &Path,
    wav: &Path,
    threads: u32,
) -> Result<Vec<TranscriptSegment>, WhisperError> {
    let mut command = Command::new(cli);
    command
        .arg("-m")
        .arg(model)
        .arg("-f")
        .arg(wav)
        .arg("-t")
        .arg(threads.max(1).to_string())
        // Suppresses the banner and the progress bar. Without it every tick writes a screenful
        // to stderr, which on Windows is a visible stall.
        .arg("--no-prints")
        .arg("-l")
        .arg("en");

    // Without this a console window flashes on screen every tick for the whole speech.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command.output()?;
    if !output.status.success() {
        return Err(WhisperError::Failed(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(parse_segments(&String::from_utf8_lossy(&output.stdout)))
}

// ---------------------------------------------------------------------------
// The rolling-window worker
// ---------------------------------------------------------------------------

/// Everything the worker thread needs, so the loop takes one argument instead of six.
struct Worker<TRuntime: Runtime> {
    app: AppHandle<TRuntime>,
    pcm: Arc<PcmBuffer>,
    stop: Arc<AtomicBool>,
    assets: WhisperAssets,
    options: TranscriptionOptions,
    /// Scratch WAV the current window is written to, overwritten every tick.
    window_wav: PathBuf,
}

/// The result of folding one window's segments into the running transcript.
struct WindowFold {
    /// Text of segments that will not be revised again.
    committed: String,
    /// Text of the segments still inside the tail.
    tail: String,
    /// Seconds into the window the committed part ends at. Zero means nothing committed.
    committed_end: f64,
}

/// Splits a window's segments into what is safe to freeze and what is still live.
///
/// * `segments` — as printed, timestamped relative to the window.
/// * `window_seconds` — length of the audio that produced them.
/// * `options` — supplies `tail_seconds` and the forced-commit backstop.
///
/// A segment is committed when it ends `tail_seconds` before the window does: later audio
/// cannot reach back past a pause and change it. The backstop handles a speaker who never
/// pauses — past `max_window_seconds` the cut is taken wherever it falls, because an
/// ever-growing window means an ever-growing decode.
fn fold_window(
    segments: &[TranscriptSegment],
    window_seconds: f64,
    options: TranscriptionOptions,
) -> WindowFold {
    let forced = window_seconds > options.max_window_seconds;
    let cut = if forced {
        window_seconds - options.tail_seconds.min(window_seconds / 2.0)
    } else {
        window_seconds - options.tail_seconds
    };

    let mut fold = WindowFold {
        committed: String::new(),
        tail: String::new(),
        committed_end: 0.0,
    };

    for segment in segments {
        // On a forced cut a segment straddling the boundary is committed whole rather than split;
        // splitting would need word timings the plain output does not carry.
        let is_committed = segment.end <= cut || (forced && segment.start < cut);
        if is_committed {
            push_words(&mut fold.committed, &segment.text);
            fold.committed_end = segment.end.max(fold.committed_end);
        } else {
            push_words(&mut fold.tail, &segment.text);
        }
    }

    // Silence: no segments at all, but the window is still growing. Slide it forward anyway.
    if forced && fold.committed_end == 0.0 {
        fold.committed_end = cut;
    }

    fold
}

/// Appends text with exactly one separating space.
fn push_words(target: &mut String, text: &str) {
    if !target.is_empty() {
        target.push(' ');
    }
    target.push_str(text);
}

/// Joins the frozen prefix and the live tail into the transcript the frontend is handed.
fn joined(committed: &str, tail: &str) -> String {
    match (committed.is_empty(), tail.is_empty()) {
        (true, _) => tail.to_owned(),
        (_, true) => committed.to_owned(),
        _ => format!("{committed} {tail}"),
    }
}

impl<TRuntime: Runtime> Worker<TRuntime> {
    /// Decodes one window and emits, returning how far the window may now slide.
    ///
    /// Returns None when there is not enough new audio to be worth a decode, or when the decode
    /// failed — a failed window is logged and skipped, never fatal. Losing one window costs the
    /// teleprompter a second of lag; taking the app down mid-speech costs the round.
    fn tick(&self, window_start: usize, committed: &mut String) -> Option<usize> {
        let window = self.pcm.slice_from(window_start);
        let window_seconds = seconds_of(window.len());
        if window_seconds < MIN_WINDOW_SECONDS {
            return None;
        }

        if let Err(error) = write_wav(&self.window_wav, &window) {
            log::warn!("could not write the transcription window: {error}");
            return None;
        }

        let segments = match transcribe_wav(
            &self.assets.cli,
            &self.assets.live_model,
            &self.window_wav,
            self.options.threads,
        ) {
            Ok(segments) => segments,
            Err(error) => {
                log::warn!("transcription window failed: {error}");
                return None;
            }
        };

        let fold = fold_window(&segments, window_seconds, self.options);
        if !fold.committed.is_empty() {
            push_words(committed, &fold.committed);
        }

        self.emit(joined(committed, &fold.tail), window_start + window.len(), false);
        Some(window_start + samples_at(fold.committed_end))
    }

    /// Emits one transcript update. A failed emit means the window is gone, so there is nothing
    /// to recover and nothing to report it to.
    fn emit(&self, text: String, total_samples: usize, is_final: bool) {
        let update = TranscriptUpdate {
            text,
            audio_seconds: seconds_of(total_samples),
            is_final,
        };
        if let Err(error) = self.app.emit(TRANSCRIPT_EVENT, update) {
            log::warn!("could not emit a transcript update: {error}");
        }
    }

    /// Decodes what is left with nothing held back, so the last words of the speech are not
    /// stuck in a tail that no further audio will ever push out.
    fn flush(&self, window_start: usize, committed: &mut String) {
        let window = self.pcm.slice_from(window_start);
        let total = window_start + window.len();

        if seconds_of(window.len()) >= MIN_WINDOW_SECONDS && write_wav(&self.window_wav, &window).is_ok() {
            if let Ok(segments) = transcribe_wav(
                &self.assets.cli,
                &self.assets.live_model,
                &self.window_wav,
                self.options.threads,
            ) {
                for segment in &segments {
                    push_words(committed, &segment.text);
                }
            }
        }

        self.emit(committed.clone(), total, true);
        let _ = std::fs::remove_file(&self.window_wav);
    }

    /// Ticks until stopped, then flushes.
    fn run(self) {
        // Start of the live window, in samples from the start of the speech. Only ever moves
        // forward, and only past a segment boundary whisper placed at a pause.
        let mut window_start = 0usize;
        // Every committed segment's text, joined. The frozen prefix of the transcript.
        let mut committed = String::new();

        while !self.stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(self.options.tick_ms));
            if self.stop.load(Ordering::Relaxed) {
                break;
            }
            if let Some(next_start) = self.tick(window_start, &mut committed) {
                window_start = next_start;
            }
        }

        self.flush(window_start, &mut committed);
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Reports whether live whisper transcription is available.
///
/// Called before the Speak screen opens so the UI can pick a transcription source without
/// waiting for a failure. Never errors: "not available, and here is why" is the answer, not a
/// fault.
///
/// * `app` — supplies the search directories.
/// * `returns` — availability, the resolved paths when there are any, and a reason when there
///   are not.
#[tauri::command]
pub fn whisper_status<TRuntime: Runtime>(app: AppHandle<TRuntime>) -> WhisperStatus {
    match resolve_assets(&app) {
        Ok(assets) => WhisperStatus { available: true, assets: Some(assets), reason: None },
        Err(error) => WhisperStatus {
            available: false,
            assets: None,
            reason: Some(error.to_string()),
        },
    }
}

/// Opens a recording and starts the transcription worker.
///
/// * `app` — resolves whisper and the directory the WAV is written to.
/// * `state` — the one recording slot. A second call while one is open is refused rather than
///   silently interleaving two speeches into one buffer.
/// * `session_id` — names the WAV. Callers pass the session row's id so the recording can be
///   found again; any filesystem-unsafe characters are the caller's problem.
/// * `options` — window tuning; omit for the defaults.
///
/// # Errors
/// Returns a human-readable message when whisper is unavailable, a recording is already open, or
/// the recordings directory cannot be created.
#[tauri::command]
pub fn start_speech_session<TRuntime: Runtime>(
    app: AppHandle<TRuntime>,
    state: tauri::State<'_, SpeechState>,
    session_id: String,
    options: Option<TranscriptionOptions>,
) -> Result<PathBuf, String> {
    let mut slot = state.session.lock().map_err(|_| "recording state poisoned".to_owned())?;
    if slot.is_some() {
        return Err(WhisperError::AlreadyRecording.to_string());
    }

    let assets = resolve_assets(&app).map_err(|error| error.to_string())?;
    let recordings = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("recordings");
    std::fs::create_dir_all(&recordings).map_err(|error| error.to_string())?;

    let wav_path = recordings.join(format!("{session_id}.wav"));
    let pcm = Arc::new(PcmBuffer::new());
    let stop = Arc::new(AtomicBool::new(false));

    let worker = Worker {
        app: app.clone(),
        pcm: Arc::clone(&pcm),
        stop: Arc::clone(&stop),
        assets,
        options: options.unwrap_or_default(),
        window_wav: std::env::temp_dir().join(format!("debate-coach-window-{session_id}.wav")),
    };
    let handle = std::thread::Builder::new()
        .name("whisper-window".to_owned())
        .spawn(move || worker.run())
        .map_err(|error| error.to_string())?;

    *slot = Some(Session { wav_path: wav_path.clone(), pcm, stop, worker: Some(handle) });
    Ok(wav_path)
}

/// Takes a chunk of captured audio.
///
/// Audio arrives as the **raw request body** rather than as a command argument. A minute of
/// speech is a million samples, and serialising those as a JSON array of numbers costs more than
/// transcribing them does.
///
/// * `state` — the open recording. Audio pushed with none open is dropped, not an error: the
///   capture graph is torn down asynchronously and the last buffer often lands after the stop.
/// * `request` — the body must be raw bytes, a whole number of 16-bit little-endian samples at
///   16 kHz mono. Any other rate transcribes as noise; nothing here can detect that.
///
/// # Errors
/// Returns a message when the body is not raw bytes, which means the caller passed an object
/// instead of an `ArrayBuffer`.
#[tauri::command]
pub fn push_speech_audio(
    state: tauri::State<'_, SpeechState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("audio must be sent as an ArrayBuffer, not an object".to_owned());
    };

    let slot = state.session.lock().map_err(|_| "recording state poisoned".to_owned())?;
    if let Some(session) = slot.as_ref() {
        session.pcm.append_bytes(bytes);
    }
    Ok(())
}

/// Ends the recording, writes the WAV, and waits for the final transcript.
///
/// Blocks until the worker has flushed, which takes up to one window — the last emitted update
/// carries `isFinal`, and it is the one the report is built from until `small.en` has
/// re-transcribed. `(async)` because of that wait: the flush runs a whole whisper decode, and on
/// the main thread that is the window freezing at the exact moment the speaker sits down.
///
/// * `state` — the open recording.
///
/// # Errors
/// [`WhisperError::NotRecording`] as a message when nothing is open, or the underlying io error
/// when the WAV cannot be written.
#[tauri::command(async)]
pub fn stop_speech_session(
    state: tauri::State<'_, SpeechState>,
) -> Result<SessionRecording, String> {
    // Taken out of the slot before the join so a panicking worker cannot leave the app unable to
    // ever start another recording.
    let session = {
        let mut slot = state.session.lock().map_err(|_| "recording state poisoned".to_owned())?;
        slot.take().ok_or_else(|| WhisperError::NotRecording.to_string())?
    };

    session.stop.store(true, Ordering::Relaxed);
    if let Some(handle) = session.worker {
        let _ = handle.join();
    }

    let samples = session.pcm.snapshot();
    write_wav(&session.wav_path, &samples).map_err(|error| error.to_string())?;

    Ok(SessionRecording {
        wav_path: session.wav_path,
        duration_seconds: seconds_of(samples.len()),
    })
}

/// Re-transcribes a finished recording with `small.en`.
///
/// The accurate pass, and the one the report's numbers come from. `base.en` is chosen for the
/// live path because it keeps up, not because it is right.
///
/// `(async)` is not decoration: `small.en` over a seven-minute speech is minutes of CPU, and a
/// synchronous command runs on the main thread. The frontend is expected to show the live
/// report immediately and swap this one in when it lands.
///
/// * `app` — resolves the review model. Falls back to `base.en` when `small.en` was never
///   downloaded, which produces a transcript no better than the live one rather than an error.
/// * `wav_path` — a WAV this app wrote. A file at another sample rate transcribes as noise.
/// * `returns` — the joined transcript and the timestamped segments behind it.
///
/// # Errors
/// Returns a message when whisper is unavailable or the decode fails.
#[tauri::command(async)]
pub fn retranscribe_speech<TRuntime: Runtime>(
    app: AppHandle<TRuntime>,
    wav_path: PathBuf,
) -> Result<ReviewTranscript, String> {
    let assets = resolve_assets(&app).map_err(|error| error.to_string())?;
    let segments = transcribe_wav(
        &assets.cli,
        &assets.review_model,
        &wav_path,
        TranscriptionOptions::default().threads,
    )
    .map_err(|error| error.to_string())?;

    let mut text = String::new();
    for segment in &segments {
        push_words(&mut text, &segment.text);
    }
    Ok(ReviewTranscript { text, segments })
}

/// Sample rate the frontend must resample to before pushing audio.
///
/// Exposed as a command so the capture graph reads it from the one place it is defined rather
/// than hardcoding 16000 on both sides of the IPC boundary.
#[tauri::command]
#[must_use]
pub fn speech_sample_rate() -> u32 {
    SAMPLE_RATE
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_OUTPUT: &str = "\
whisper_init_from_file_with_params_no_state: loading model
system_info: n_threads = 4

[00:00:00.000 --> 00:00:03.480]   My first substantive is that fake news causes damage.
[00:00:03.480 --> 00:00:07.960]   What is the problem?
[00:00:07.960 --> 00:00:11.000]
[00:01:02.500 --> 00:01:05.250]   It uproots the life of an organization.
";

    #[test]
    fn reads_timestamped_rows_and_ignores_the_banner() {
        let segments = parse_segments(SAMPLE_OUTPUT);
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0].start, 0.0);
        assert_eq!(segments[0].end, 3.48);
        assert_eq!(segments[0].text, "My first substantive is that fake news causes damage.");
    }

    #[test]
    fn reads_timestamps_past_a_minute() {
        let segments = parse_segments(SAMPLE_OUTPUT);
        assert_eq!(segments[2].start, 62.5);
        assert_eq!(segments[2].end, 65.25);
    }

    #[test]
    fn survives_output_it_does_not_recognise() {
        assert!(parse_segments("").is_empty());
        assert!(parse_segments("[malformed --> ] text").is_empty());
        assert!(parse_segments("no brackets here at all").is_empty());
    }

    /// Captured verbatim from `whisper-cli.exe` on `samples/jfk.wav`, with the exact flags
    /// [`transcribe_wav`] passes: `-m … -f … -t 4 --no-prints -l en`. Blank leading line and all.
    ///
    /// Byte-identical under both v1.7.6 and v1.9.2, which is the evidence that made the bump
    /// safe. Everything else in this module is a fixture somebody typed; this one is the real
    /// thing, and it is what says the pinned release still prints what the parser reads.
    ///
    /// Only **stdout** appears here. v1.9.2 added `load_backend: …` and `read_audio_data: …`
    /// chatter that `--no-prints` does not suppress, but it goes to stderr and
    /// [`transcribe_wav`] reads the two streams separately — which is why that addition cost
    /// nothing.
    const REAL_RELEASE_OUTPUT: &str = "
[00:00:00.000 --> 00:00:11.000]   And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.
";

    #[test]
    fn reads_what_the_pinned_release_actually_prints() {
        let segments = parse_segments(REAL_RELEASE_OUTPUT);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start, 0.0);
        assert_eq!(segments[0].end, 11.0);
        assert!(segments[0].text.starts_with("And so my fellow Americans"));
        // The three spaces whisper pads with must not survive into the transcript: they would
        // become an empty word the aligner counts as an improvisation.
        assert!(!segments[0].text.starts_with(' '));
    }

    /// Two segments, the second of which ends inside the tail and must stay revisable.
    fn two_segments() -> Vec<TranscriptSegment> {
        vec![
            TranscriptSegment { start: 0.0, end: 4.0, text: "the first part".to_owned() },
            TranscriptSegment { start: 4.0, end: 9.5, text: "the live tail".to_owned() },
        ]
    }

    #[test]
    fn commits_only_what_the_tail_does_not_cover() {
        let fold = fold_window(&two_segments(), 10.0, TranscriptionOptions::default());
        assert_eq!(fold.committed, "the first part");
        assert_eq!(fold.tail, "the live tail");
        assert_eq!(fold.committed_end, 4.0);
    }

    #[test]
    fn commits_nothing_when_every_segment_is_still_live() {
        let segments = vec![TranscriptSegment {
            start: 0.0,
            end: 2.5,
            text: "only just said".to_owned(),
        }];
        let fold = fold_window(&segments, 3.0, TranscriptionOptions::default());
        assert!(fold.committed.is_empty());
        assert_eq!(fold.tail, "only just said");
        assert_eq!(fold.committed_end, 0.0);
    }

    #[test]
    fn forces_the_window_forward_when_the_speaker_never_pauses() {
        // One unbroken segment longer than the backstop: without the force it would never
        // commit, and the window would grow for the rest of the speech.
        let segments = vec![TranscriptSegment {
            start: 0.0,
            end: 30.0,
            text: "on and on".to_owned(),
        }];
        let fold = fold_window(&segments, 30.0, TranscriptionOptions::default());
        assert_eq!(fold.committed, "on and on");
        assert!(fold.committed_end > 0.0);
    }

    #[test]
    fn slides_past_silence() {
        let fold = fold_window(&[], 30.0, TranscriptionOptions::default());
        assert!(fold.committed.is_empty());
        assert!(fold.committed_end > 0.0);
    }

    #[test]
    fn joins_the_prefix_and_the_tail_with_one_space() {
        assert_eq!(joined("first", "second"), "first second");
        assert_eq!(joined("", "second"), "second");
        assert_eq!(joined("first", ""), "first");
        assert_eq!(joined("", ""), "");
    }
}
