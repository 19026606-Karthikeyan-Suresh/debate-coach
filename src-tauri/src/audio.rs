//! Audio buffering, the WAV files whisper reads, and where the speaker stopped talking.
//!
//! Everything here is 16 kHz mono signed 16-bit little-endian, because that is the only format
//! whisper.cpp accepts. It resamples nothing and validates nothing — hand it 44.1 kHz and it
//! transcribes gibberish with total confidence, which is a far worse failure than an error.
//!
//! **The whole speech is held in memory.** Seven minutes is 6.7 million samples, 13 MB, and
//! keeping it means the rolling window can be re-read at any offset without seeking a file that
//! is still being written. The WAV is written once, at the end, from that buffer.
//!
//! **Pauses are measured off the audio, not off the transcript.** whisper prints a timestamp per
//! segment and puts its boundaries at pauses, so reading the gaps between segments looks like the
//! cheap way to find them — but the segments it prints are usually flush, one ending exactly where
//! the next begins, and a pause the speaker really took comes back as no gap at all. The samples
//! cannot lie about it: a run of frames below the noise floor is silence whatever whisper wrote.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// The only sample rate whisper.cpp accepts. Anything else transcribes as noise.
pub const SAMPLE_RATE: u32 = 16_000;

/// Bytes per sample on the wire — one 16-bit little-endian channel.
const BYTES_PER_SAMPLE: usize = 2;

/// A speech's audio, appended to from the IPC thread and read from the transcription worker.
///
/// The lock is held only for the memcpy in and the copy out, never across a whisper run, so a
/// slow transcription never stalls capture.
#[derive(Default)]
pub struct PcmBuffer {
    samples: Mutex<Vec<i16>>,
}

impl PcmBuffer {
    /// Creates an empty buffer sized for a full speech, so capture never reallocates mid-round.
    #[must_use]
    pub fn new() -> Self {
        Self {
            samples: Mutex::new(Vec::with_capacity(SAMPLE_RATE as usize * 60 * 8)),
        }
    }

    /// Appends raw little-endian PCM as it arrives over IPC.
    ///
    /// * `bytes` — a whole number of 16-bit samples. A trailing odd byte is dropped rather than
    ///   being padded: it means the caller split a sample across two messages, and inventing the
    ///   other half shifts every subsequent sample by one byte and turns the rest of the speech
    ///   into static.
    ///
    /// # Panics
    /// Panics if the lock is poisoned, which means the worker thread panicked mid-speech and the
    /// buffer's contents can no longer be trusted.
    pub fn append_bytes(&self, bytes: &[u8]) {
        let mut samples = self.samples.lock().expect("pcm buffer poisoned");
        samples.reserve(bytes.len() / BYTES_PER_SAMPLE);
        for pair in bytes.chunks_exact(BYTES_PER_SAMPLE) {
            samples.push(i16::from_le_bytes([pair[0], pair[1]]));
        }
    }

    /// Samples captured so far.
    ///
    /// # Panics
    /// Panics if the lock is poisoned.
    #[must_use]
    pub fn len(&self) -> usize {
        self.samples.lock().expect("pcm buffer poisoned").len()
    }

    /// Whether anything has been captured yet.
    ///
    /// # Panics
    /// Panics if the lock is poisoned.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Copies out everything from `start` onwards.
    ///
    /// * `start` — sample offset, not seconds and not bytes. An offset past the end returns an
    ///   empty vector rather than panicking, because the worker computes it from a timestamp
    ///   whisper reported and a rounding error there must not take the app down mid-speech.
    ///
    /// # Panics
    /// Panics if the lock is poisoned.
    #[must_use]
    pub fn slice_from(&self, start: usize) -> Vec<i16> {
        let samples = self.samples.lock().expect("pcm buffer poisoned");
        samples.get(start..).map(<[i16]>::to_vec).unwrap_or_default()
    }

    /// Copies out the whole speech, for writing the final WAV.
    ///
    /// # Panics
    /// Panics if the lock is poisoned.
    #[must_use]
    pub fn snapshot(&self) -> Vec<i16> {
        self.samples.lock().expect("pcm buffer poisoned").clone()
    }
}

/// Seconds of audio in a sample count, at {@link SAMPLE_RATE}.
///
/// * `samples` — a count, not an index. Off-by-one here is 62 microseconds and nothing downstream
///   can see it.
#[must_use]
pub fn seconds_of(samples: usize) -> f64 {
    samples as f64 / f64::from(SAMPLE_RATE)
}

/// Sample offset a number of seconds into the speech.
///
/// * `seconds` — negative values clamp to zero, since they only arise from a timestamp whisper
///   reported slightly before the window it was given.
#[must_use]
pub fn samples_at(seconds: f64) -> usize {
    if seconds <= 0.0 {
        return 0;
    }
    (seconds * f64::from(SAMPLE_RATE)) as usize
}

/// Writes samples as a 16 kHz mono WAV.
///
/// * `path` — the file to create. Its parent directory must exist; this does not create one,
///   because the two callers both resolve a directory they already made.
/// * `samples` — the audio. An empty slice still writes a valid header-only WAV, which whisper
///   reads as silence rather than failing to open.
///
/// # Errors
/// Returns the underlying [`std::io::Error`] if the file cannot be created or written.
pub fn write_wav(path: &Path, samples: &[i16]) -> std::io::Result<()> {
    let data_len = (samples.len() * BYTES_PER_SAMPLE) as u32;
    let byte_rate = SAMPLE_RATE * BYTES_PER_SAMPLE as u32;
    let mut file = BufWriter::new(File::create(path)?);

    // Canonical 44-byte PCM header. Sizes are known up front because the samples are already in
    // memory, which is the other reason the buffer is not streamed to disk as it arrives.
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + data_len).to_le_bytes())?;
    file.write_all(b"WAVEfmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&SAMPLE_RATE.to_le_bytes())?;
    file.write_all(&byte_rate.to_le_bytes())?;
    file.write_all(&(BYTES_PER_SAMPLE as u16).to_le_bytes())?;
    file.write_all(&16u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_len.to_le_bytes())?;

    let mut bytes = Vec::with_capacity(samples.len() * BYTES_PER_SAMPLE);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    file.write_all(&bytes)?;
    file.flush()
}

/// Builds the error a malformed or foreign WAV comes back as.
fn invalid_wav(reason: String) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, reason)
}

/// Reads a 16 kHz mono WAV back into samples.
///
/// Walks the RIFF chunk list rather than assuming the 44-byte header [`write_wav`] emits. The
/// only file this is ever pointed at today is one this app wrote, but a recording that has been
/// through anything else — a converter, a backup tool that rewrote the metadata — still opens,
/// and one at the wrong rate is refused rather than silently reported as a speech at the wrong
/// speed with every pause in the wrong place.
///
/// * `path` — the WAV to read.
///
/// # Errors
/// The underlying [`std::io::Error`] when the file cannot be read, or
/// [`std::io::ErrorKind::InvalidData`] when it is not RIFF/WAVE, when the `fmt ` or `data` chunk
/// is missing, or when it is not 16-bit mono at {@link SAMPLE_RATE}.
pub fn read_wav(path: &Path) -> std::io::Result<Vec<i16>> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(invalid_wav("not a RIFF/WAVE file".to_owned()));
    }

    // Channels, sample rate and bits per sample, once `fmt ` has been seen.
    let mut format: Option<(u16, u32, u16)> = None;
    let mut data: Option<&[u8]> = None;

    // Chunk headers are eight bytes — a four-byte id and a length — and every body is padded to
    // an even length without that padding being counted in the length.
    let mut cursor = 12;
    while cursor + 8 <= bytes.len() {
        let id = &bytes[cursor..cursor + 4];
        let length = u32::from_le_bytes([
            bytes[cursor + 4],
            bytes[cursor + 5],
            bytes[cursor + 6],
            bytes[cursor + 7],
        ]) as usize;
        let body_start = cursor + 8;
        let body_end = body_start.saturating_add(length).min(bytes.len());
        let body = &bytes[body_start..body_end];

        if id == b"fmt " && body.len() >= 16 {
            format = Some((
                u16::from_le_bytes([body[2], body[3]]),
                u32::from_le_bytes([body[4], body[5], body[6], body[7]]),
                u16::from_le_bytes([body[14], body[15]]),
            ));
        } else if id == b"data" {
            data = Some(body);
        }

        cursor = body_end + (length & 1);
    }

    let (channels, rate, bits) =
        format.ok_or_else(|| invalid_wav("no fmt chunk".to_owned()))?;
    if channels != 1 || rate != SAMPLE_RATE || bits != 16 {
        return Err(invalid_wav(format!(
            "expected 16-bit mono at {SAMPLE_RATE} Hz, got {bits}-bit {channels}-channel at {rate} Hz"
        )));
    }

    let body = data.ok_or_else(|| invalid_wav("no data chunk".to_owned()))?;
    Ok(body
        .chunks_exact(BYTES_PER_SAMPLE)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect())
}

// ---------------------------------------------------------------------------
// Pauses
// ---------------------------------------------------------------------------

/// A stretch inside the speech where nobody was speaking.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pause {
    /// Seconds from the start of the recording.
    pub start_seconds: f64,
    /// Seconds from the start of the recording. Always greater than `start_seconds`.
    pub end_seconds: f64,
}

/// Analysis frame. 20 ms is short enough to place a pause's edge to within a syllable and long
/// enough that one loud click cannot end a silence on its own.
const FRAME_SAMPLES: usize = 320;

/// Quietest a frame may be and still count as speech, as a fraction of full scale.
///
/// The backstop for a recording with no noise at all — a synthetic one, or a mic gate that writes
/// digital zero. Without it the adaptive threshold below lands at zero and every frame counts as
/// speech, so a silent recording reports no pauses at all.
const ABSOLUTE_FLOOR: f64 = 0.004;

/// How far above the noise floor a frame has to be. Three would clip the tail of quiet words.
const NOISE_MULTIPLE: f64 = 4.0;

/// Share of the speaker's own loudness the threshold may not exceed, so a quietly-recorded speech
/// is not read as one long pause.
const LOUD_SHARE: f64 = 0.15;

/// Root-mean-square level of each frame, as a fraction of full scale.
fn frame_levels(samples: &[i16]) -> Vec<f64> {
    samples
        .chunks(FRAME_SAMPLES)
        .map(|frame| {
            let energy: f64 = frame
                .iter()
                .map(|sample| {
                    let level = f64::from(*sample) / f64::from(i16::MAX);
                    level * level
                })
                .sum();
            (energy / frame.len() as f64).sqrt()
        })
        .collect()
}

/// Value at a fraction through an already-sorted list. Empty gives zero.
fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

/// Picks the level below which a frame is silence, from the recording's own dynamic range.
///
/// A fixed threshold cannot work: the same number is either above a laptop microphone's hiss in a
/// quiet room or below a debater's voice at the back of a lecture theatre, never both. The floor
/// is taken from the recording's quiet tenth and the ceiling from its loud tenth.
fn silence_threshold(levels: &[f64]) -> f64 {
    let mut sorted = levels.to_vec();
    sorted.sort_by(f64::total_cmp);

    let noise_floor = percentile(&sorted, 0.10);
    let loud = percentile(&sorted, 0.90);
    // `clamp` panics when its bounds cross, and a whisper-quiet recording crosses them.
    let ceiling = (loud * LOUD_SHARE).max(ABSOLUTE_FLOOR);
    (noise_floor * NOISE_MULTIPLE).clamp(ABSOLUTE_FLOOR, ceiling)
}

/// Start of a frame, in seconds.
fn frame_seconds(frame: usize) -> f64 {
    seconds_of(frame * FRAME_SAMPLES)
}

/// Finds the silences a listener would notice.
///
/// Only silence **between** speech is reported. The quiet before the first word and after the last
/// is the speaker walking to the lectern and sitting down, and telling them they paused for six
/// seconds before they started would be both true and useless.
///
/// * `samples` — the whole recording at {@link SAMPLE_RATE}. Audio at any other rate produces
///   pauses at the wrong times rather than an error, which is why [`read_wav`] checks the rate.
/// * `min_seconds` — shortest gap worth reporting. Two seconds is a pause a judge hears; anything
///   under one reports the gaps between ordinary sentences and buries the real ones.
///
/// * `returns` — pauses in order, never overlapping.
#[must_use]
pub fn find_pauses(samples: &[i16], min_seconds: f64) -> Vec<Pause> {
    let levels = frame_levels(samples);
    let threshold = silence_threshold(&levels);

    let Some(first_spoken) = levels.iter().position(|level| *level >= threshold) else {
        return Vec::new();
    };
    let last_spoken = levels
        .iter()
        .rposition(|level| *level >= threshold)
        .unwrap_or(first_spoken);

    let mut pauses = Vec::new();
    // Frame the current silence started at, or None while the speaker is talking.
    let mut silence_from: Option<usize> = None;

    for (offset, level) in levels[first_spoken..=last_spoken].iter().enumerate() {
        let frame = first_spoken + offset;
        if *level < threshold {
            silence_from.get_or_insert(frame);
            continue;
        }
        if let Some(start) = silence_from.take() {
            let (start_seconds, end_seconds) = (frame_seconds(start), frame_seconds(frame));
            if end_seconds - start_seconds >= min_seconds {
                pauses.push(Pause { start_seconds, end_seconds });
            }
        }
    }

    pauses
}

/// Shortest silence the report calls a pause. Matches `DEFAULT_MIN_PAUSE_SECONDS` in the frontend.
const DEFAULT_MIN_PAUSE_SECONDS: f64 = 2.0;

/// Finds the pauses in a finished recording.
///
/// Runs on a worker thread — `(async)` on a synchronous command is what buys that — because
/// reading and scanning thirteen megabytes on the main thread stalls the window for as long as it
/// takes, and this is called the moment a speech ends.
///
/// * `wav_path` — a WAV this app wrote. Anything not 16-bit mono at {@link SAMPLE_RATE} is
///   refused rather than measured.
/// * `min_seconds` — shortest gap to report; omit for two seconds.
///
/// # Errors
/// Returns a message when the file cannot be read or is not the expected format.
#[tauri::command(async)]
pub fn find_recording_pauses(
    wav_path: PathBuf,
    min_seconds: Option<f64>,
) -> Result<Vec<Pause>, String> {
    let samples = read_wav(&wav_path).map_err(|error| error.to_string())?;
    Ok(find_pauses(
        &samples,
        min_seconds.unwrap_or(DEFAULT_MIN_PAUSE_SECONDS),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_little_endian_pairs_and_drops_a_split_sample() {
        let buffer = PcmBuffer::new();
        buffer.append_bytes(&[0x01, 0x00, 0xff, 0xff, 0x7f]);
        assert_eq!(buffer.snapshot(), vec![1, -1]);
    }

    #[test]
    fn slicing_past_the_end_is_empty_rather_than_a_panic() {
        let buffer = PcmBuffer::new();
        buffer.append_bytes(&[0x01, 0x00]);
        assert!(buffer.slice_from(99).is_empty());
    }

    #[test]
    fn seconds_and_samples_round_trip() {
        assert_eq!(samples_at(seconds_of(32_000)), 32_000);
        assert_eq!(samples_at(-1.0), 0);
    }

    #[test]
    fn writes_a_header_of_the_documented_size() {
        let dir = std::env::temp_dir().join("debate-coach-wav-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("tone.wav");
        write_wav(&path, &[0, 1, -1]).expect("write");
        let written = std::fs::read(&path).expect("read");
        assert_eq!(written.len(), 44 + 6);
        assert_eq!(&written[0..4], b"RIFF");
        assert_eq!(&written[8..12], b"WAVE");
    }

    #[test]
    fn reads_back_what_it_wrote() {
        let dir = std::env::temp_dir().join("debate-coach-wav-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("round-trip.wav");
        let samples = vec![0i16, 1, -1, 32_767, -32_768];
        write_wav(&path, &samples).expect("write");
        assert_eq!(read_wav(&path).expect("read"), samples);
    }

    #[test]
    fn refuses_a_file_that_is_not_a_wav() {
        let dir = std::env::temp_dir().join("debate-coach-wav-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("not-audio.wav");
        std::fs::write(&path, b"this is a text file").expect("write");
        assert!(read_wav(&path).is_err());
    }

    /// A square wave, which at this amplitude sits well above any plausible threshold.
    fn speech(seconds: f64) -> Vec<i16> {
        (0..samples_at(seconds))
            .map(|index| if index % 8 < 4 { 8_000 } else { -8_000 })
            .collect()
    }

    /// Silence at a given amplitude. Zero is a digital mute; anything else is room noise.
    fn quiet(seconds: f64, amplitude: i16) -> Vec<i16> {
        (0..samples_at(seconds))
            .map(|index| if index % 2 == 0 { amplitude } else { -amplitude })
            .collect()
    }

    /// Concatenates stretches into one recording.
    fn recording(parts: &[Vec<i16>]) -> Vec<i16> {
        parts.iter().flatten().copied().collect()
    }

    #[test]
    fn finds_a_pause_between_two_stretches_of_speech() {
        let audio = recording(&[speech(4.0), quiet(3.0, 0), speech(4.0)]);
        let pauses = find_pauses(&audio, 2.0);
        assert_eq!(pauses.len(), 1);
        // Within one frame either side: the edge is placed at a 20 ms boundary.
        assert!((pauses[0].start_seconds - 4.0).abs() < 0.05);
        assert!((pauses[0].end_seconds - 7.0).abs() < 0.05);
    }

    #[test]
    fn ignores_the_silence_before_the_first_word_and_after_the_last() {
        let audio = recording(&[quiet(6.0, 0), speech(3.0), quiet(6.0, 0)]);
        assert!(find_pauses(&audio, 2.0).is_empty());
    }

    #[test]
    fn ignores_a_gap_shorter_than_the_minimum() {
        let audio = recording(&[speech(3.0), quiet(1.0, 0), speech(3.0)]);
        assert!(find_pauses(&audio, 2.0).is_empty());
    }

    #[test]
    fn hears_a_pause_through_room_noise() {
        // The gap is not digital silence — it is a live microphone in a room. A fixed threshold
        // low enough for a quiet speaker would count this as speech.
        let audio = recording(&[speech(4.0), quiet(3.0, 300), speech(4.0)]);
        assert_eq!(find_pauses(&audio, 2.0).len(), 1);
    }

    #[test]
    fn reports_nothing_for_a_recording_with_no_speech_in_it() {
        assert!(find_pauses(&quiet(30.0, 0), 2.0).is_empty());
        assert!(find_pauses(&[], 2.0).is_empty());
    }

    #[test]
    fn finds_every_pause_in_a_stop_start_delivery() {
        let audio = recording(&[
            speech(3.0),
            quiet(2.5, 0),
            speech(3.0),
            quiet(1.0, 0),
            speech(3.0),
            quiet(4.0, 0),
            speech(3.0),
        ]);
        let pauses = find_pauses(&audio, 2.0);
        assert_eq!(pauses.len(), 2);
        assert!(pauses[0].start_seconds < pauses[1].start_seconds);
    }
}
