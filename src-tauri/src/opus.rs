//! Encoding a finished speech to Opus, and handing a recording's bytes to the webview.
//!
//! Seven minutes of 16 kHz mono WAV is about 13 MB. The same speech at 24 kbps is about 1.2 MB —
//! the difference between filling Supabase's free tier in seventy speeches and filling it in eight
//! hundred, and the difference between a coach opening a recording on hotel wifi and giving up.
//! The WAV stays on the machine that recorded it, because `small.en` re-reads it and because a
//! lossy copy is not what you want to re-transcribe.
//!
//! **Phase 9 deliberately left this out and named both wrong ways to add it.** Binding to libopus
//! wants cmake on Windows — the C toolchain kept out of `reqwest`'s TLS so a teammate could build
//! this repo with nothing but rustup — and a `MediaRecorder` on the capture stream would change
//! the phase 5 path no microphone has been through. The third way is a pure-Rust port of libopus,
//! which costs neither: it builds with cargo alone and it reads a finished file rather than
//! touching capture. What it costs instead is trust in a young crate, and that is bought back by
//! [`tests::decodes_back_to_the_signal_that_went_in`] — the encode is proved by decoding it, not
//! by the crate's own claim.
//!
//! **Encoding happens on the way to playback, not only on the way to upload.** The player reads
//! the Opus copy, so the encoder runs every time anybody scrubs a recording rather than only on
//! the day somebody shares one. A path exercised once a season is a path that is broken.

use std::path::{Path, PathBuf};

use opus_rs::{Application, OpusEncoder};
use serde::Serialize;

use crate::audio::{read_wav, seconds_of, SAMPLE_RATE};
use crate::ogg::{OggError, OggWriter};

/// Bits per second. 24 kbps is transparent enough for speech at 16 kHz and is what makes a
/// seven-minute round about 1.2 MB; the recording exists to be listened to and commented on, not
/// to be re-transcribed, which is what the WAV is for.
const BITRATE_BPS: i32 = 24_000;

/// Frame length in input samples. 20 ms is Opus's default and the only frame size whose packet
/// overhead is negligible at this bitrate.
const FRAME_SAMPLES: usize = SAMPLE_RATE as usize / 50;

/// The same frame at Opus's internal clock. **Every granule position in an Ogg Opus stream is in
/// 48 kHz samples regardless of the input rate** — writing them at 16 kHz produces a file that
/// plays at a third of its real duration, and nothing about it looks wrong until you press play.
const FRAME_SAMPLES_48K: i64 = 960;

/// 48 kHz samples the decoder discards from the front.
///
/// This is the encoder's own lookahead: the decoder's output starts that far behind the input, and
/// declaring it is what makes playback line up with the recording. libopus reports 6.5 ms at its
/// default settings and this port is a translation of libopus, so 312 is the expected value — but
/// it is not queryable through the crate's API, so it is measured instead:
/// [`tests::lines_the_decoded_audio_up_with_the_input`] fails if the real lookahead differs by
/// more than a frame. A wrong value here shifts playback by milliseconds and cannot shift a
/// duration, which is why it is a constant with a test rather than a blocker.
const PRE_SKIP_48K: u16 = 312;

/// Bitstream serial number. Fixed, so two encodes of one recording are byte-identical — the same
/// property `zip.ts` gives an export, and for the same reason: a difference between two files
/// should mean a difference between two speeches.
const STREAM_SERIAL: u32 = 0x0dbc_0a70;

/// Largest packet Opus produces, and therefore the encoder's output buffer.
const MAX_PACKET_BYTES: usize = 1275;

/// Extensions [`read_recording_bytes`] will hand to the webview.
///
/// The same boundary `export.rs` draws, from the other direction: a command that reads an
/// arbitrary path and returns its bytes is a general-purpose file reader reachable from a webview,
/// and one that reads two audio extensions is not.
const READABLE_EXTENSIONS: [&str; 2] = ["opus", "wav"];

/// Largest recording worth reading into memory. Seven minutes of WAV is 13 MB; 128 MB is an hour
/// and a half of it, which is not a debate speech however long the round felt.
const MAX_RECORDING_BYTES: u64 = 128 * 1024 * 1024;

/// Everything that can go wrong turning a recording into an upload.
#[derive(Debug)]
pub enum OpusError {
    /// The WAV could not be read, or was not 16 kHz mono. Carries the reason.
    Source(String),
    /// The encoder refused. Carries what it said.
    Encoder(String),
    /// The container refused a packet.
    Container(OggError),
    /// The `.opus` could not be written, or the file could not be read back.
    Io(String),
    /// A path with an extension this command does not handle.
    UnsupportedExtension(String),
    /// The file is larger than [`MAX_RECORDING_BYTES`], so it is not a speech.
    TooLarge(u64),
}

impl std::fmt::Display for OpusError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Source(reason) => write!(formatter, "the recording could not be read: {reason}"),
            Self::Encoder(reason) => write!(formatter, "the recording could not be encoded: {reason}"),
            Self::Container(error) => write!(formatter, "the recording could not be packaged: {error}"),
            Self::Io(reason) => write!(formatter, "the file could not be used: {reason}"),
            Self::UnsupportedExtension(extension) => {
                write!(formatter, "cannot read a .{extension} file here")
            }
            Self::TooLarge(bytes) => {
                write!(formatter, "that file is {bytes} bytes, far too large to be a recording")
            }
        }
    }
}

impl std::error::Error for OpusError {}

impl From<OpusError> for String {
    fn from(error: OpusError) -> Self {
        error.to_string()
    }
}

impl From<OggError> for OpusError {
    fn from(error: OggError) -> Self {
        Self::Container(error)
    }
}

/// The `OpusHead` packet — the first thing in the file, and what tells a decoder how to run.
///
/// * `channels` — 1 or 2. Mapping family 0 covers both and nothing here produces more.
/// * `input_rate` — the rate the samples were captured at. Informational: Opus always decodes at
///   48 kHz, and this field exists so a player can say "16 kHz" rather than change anything.
fn opus_head(channels: u8, input_rate: u32) -> Vec<u8> {
    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1);
    head.push(channels);
    head.extend_from_slice(&PRE_SKIP_48K.to_le_bytes());
    head.extend_from_slice(&input_rate.to_le_bytes());
    // Output gain, Q7.8 dB. Zero: the level the debater was recorded at is the level they spoke at.
    head.extend_from_slice(&0i16.to_le_bytes());
    // Channel mapping family 0 — mono or plain stereo, no mapping table follows.
    head.push(0);
    head
}

/// The `OpusTags` packet. Required to be present; its contents are not.
fn opus_tags() -> Vec<u8> {
    let vendor = b"debate-coach";
    let mut tags = Vec::with_capacity(8 + 4 + vendor.len() + 4);
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    // No user comments. A recording of a named person is not a place to write their name.
    tags.extend_from_slice(&0u32.to_le_bytes());
    tags
}

/// Encodes 16 kHz mono PCM as an Ogg Opus file.
///
/// The frame count is `ceil((pre-skip + samples) / frame)` and the input is zero-padded to reach
/// it, so nothing is lost off the end; the final page's granule position is set to the real length
/// rather than to the padded one, which is the mechanism that trims the padding back off. Get that
/// wrong in either direction and the file is a fraction of a second long or short, which is
/// invisible until a comment at 4:12 points at the wrong sentence.
///
/// * `samples` — the whole recording at {@link crate::audio::SAMPLE_RATE}. Audio at another rate
///   encodes without complaint and plays back at the wrong speed, which is why
///   [`encode_wav_to_opus`] reads through [`read_wav`] rather than parsing a header itself.
/// * `bitrate_bps` — target bitrate. Passing something absurd is the encoder's business to refuse.
///
/// # Errors
/// [`OpusError::Encoder`] if the encoder rejects its settings or a frame, or
/// [`OpusError::Container`] if a packet will not fit a page.
pub fn encode_pcm_to_ogg_opus(samples: &[i16], bitrate_bps: i32) -> Result<Vec<u8>, OpusError> {
    let mut encoder = OpusEncoder::new(SAMPLE_RATE as i32, 1, Application::Voip)
        .map_err(|reason| OpusError::Encoder(reason.to_owned()))?;
    encoder.bitrate_bps = bitrate_bps;
    // Speech at a fixed bitrate over a fixed-size upload. Variable bitrate would be smaller on
    // average and makes a seek estimate wrong, which is the one thing this file is for.
    encoder.use_cbr = true;

    let mut writer = OggWriter::new(STREAM_SERIAL);
    writer.push_packet(&opus_head(1, SAMPLE_RATE), 0)?;
    writer.end_page();
    writer.push_packet(&opus_tags(), 0)?;
    writer.end_page();

    // Granule counts 48 kHz samples including the pre-skip, so the stream's true end is the
    // pre-skip plus the audio. Every page's granule is capped at it: a lower final value than the
    // frames imply is exactly how Ogg says "stop decoding here", and it is what removes the
    // zero-padding on the last frame.
    let total_48k = PRE_SKIP_48K as i64 + samples.len() as i64 * 3;
    let frame_count = (total_48k as usize).div_ceil(FRAME_SAMPLES_48K as usize);

    let mut packet = vec![0u8; MAX_PACKET_BYTES];
    let mut frame = vec![0f32; FRAME_SAMPLES];

    for index in 0..frame_count {
        let start = index * FRAME_SAMPLES;
        for (slot, offset) in frame.iter_mut().zip(start..start + FRAME_SAMPLES) {
            *slot = samples.get(offset).map_or(0.0, |sample| f32::from(*sample) / 32_768.0);
        }

        let written = encoder
            .encode(&frame, FRAME_SAMPLES, &mut packet)
            .map_err(|reason| OpusError::Encoder(reason.to_owned()))?;
        let granule = ((index as i64 + 1) * FRAME_SAMPLES_48K).min(total_48k);
        writer.push_packet(&packet[..written], granule)?;
    }

    Ok(writer.finish())
}

/// What an encode produced, as the frontend needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEncoding {
    /// Absolute path to the `.opus`, beside the WAV it came from.
    pub opus_path: PathBuf,
    /// Size of the `.opus`. Shown next to the WAV's size, because "a tenth the size" is the whole
    /// argument for encoding at all and a number is how anyone checks it.
    pub opus_bytes: u64,
    /// Size of the WAV it was made from.
    pub wav_bytes: u64,
    /// Length of the recording. Taken from the sample count, not from the file's metadata.
    pub duration_seconds: f64,
}

/// Encodes a recording, or reuses the `.opus` already beside it.
///
/// * `wav_path` — a WAV this app wrote. A file at another rate is refused by [`read_wav`] rather
///   than encoded into a recording that plays at the wrong speed.
///
/// # Errors
/// [`OpusError::Source`] when the WAV is missing or not 16 kHz mono, [`OpusError::Encoder`] or
/// [`OpusError::Container`] when the encode fails, [`OpusError::Io`] when the result cannot be
/// written.
pub fn encode_wav_to_opus(wav_path: &Path) -> Result<RecordingEncoding, OpusError> {
    let samples = read_wav(wav_path).map_err(|error| OpusError::Source(error.to_string()))?;
    let wav_bytes = std::fs::metadata(wav_path)
        .map(|meta| meta.len())
        .map_err(|error| OpusError::Io(error.to_string()))?;
    let opus_path = wav_path.with_extension("opus");

    // Re-encoding on every playback would be seconds of CPU for a file that cannot have changed —
    // a WAV is written once, at the end of a speech, and never appended to.
    let opus_bytes = match std::fs::metadata(&opus_path) {
        Ok(meta) if meta.len() > 0 => meta.len(),
        _ => {
            let bytes = encode_pcm_to_ogg_opus(&samples, BITRATE_BPS)?;
            std::fs::write(&opus_path, &bytes).map_err(|error| OpusError::Io(error.to_string()))?;
            bytes.len() as u64
        }
    };

    Ok(RecordingEncoding {
        opus_path,
        opus_bytes,
        wav_bytes,
        duration_seconds: seconds_of(samples.len()),
    })
}

/// Encodes a finished speech to Opus for playback and upload.
///
/// `(async)` for the same reason `retranscribe_speech` is: this is called the moment a report is
/// opened, and a minute of audio is real CPU. Encoding on the main thread freezes the window at
/// exactly the point the debater is waiting to press play.
///
/// * `wav_path` — from `stop_speech_session`, or off a session row.
///
/// # Errors
/// Returns a message naming which stage failed — a missing recording, a rejected format, a failed
/// encode and a failed write are four different things to do next.
#[tauri::command(async)]
pub fn encode_recording_opus(wav_path: PathBuf) -> Result<RecordingEncoding, String> {
    Ok(encode_wav_to_opus(&wav_path)?)
}

/// Checks a path's extension against [`READABLE_EXTENSIONS`].
fn check_readable(path: &Path) -> Result<(), OpusError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if READABLE_EXTENSIONS.contains(&extension.as_str()) {
        Ok(())
    } else {
        Err(OpusError::UnsupportedExtension(extension))
    }
}

/// Hands a recording's bytes to the webview.
///
/// Returned as a raw [`tauri::ipc::Response`] rather than a `Vec<u8>`: a command returning a
/// vector serialises it as a JSON array of numbers, and 1.2 MB of Opus becomes several megabytes
/// of decimal digits for the webview to parse. This is the same decision `push_speech_audio` took
/// in the other direction.
///
/// The webview needs the bytes because that is where the audio element and the Supabase client
/// both live — Rust holds no access token, and the one it could parse out of the credential store
/// is supabase-js's to refresh.
///
/// * `path` — a `.opus` or `.wav` recording. Any other extension is refused; see the constant.
///
/// # Errors
/// Returns a message when the extension is wrong, the file is implausibly large, or it cannot be
/// read.
#[tauri::command(async)]
pub fn read_recording_bytes(path: PathBuf) -> Result<tauri::ipc::Response, String> {
    check_readable(&path).map_err(String::from)?;

    let metadata = std::fs::metadata(&path).map_err(|error| OpusError::Io(error.to_string()))?;
    if metadata.len() > MAX_RECORDING_BYTES {
        return Err(OpusError::TooLarge(metadata.len()).into());
    }

    let bytes = std::fs::read(&path).map_err(|error| OpusError::Io(error.to_string()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Deletes a recording and its encoded copy.
///
/// Deleting a session leaves the audio alone — that is `deleteSession`'s documented behaviour and
/// the right default, since a file removed from under a coach's comment is not recoverable. This
/// is the louder, separate action, and it takes both files because leaving the WAV behind means
/// "deleted" freed a tenth of what it appeared to.
///
/// * `wav_path` — the recording. A file that is already gone is not an error: the intent is that
///   it should not be there, and it is not.
///
/// # Errors
/// Returns a message when the extension is wrong, or when a file exists and cannot be removed.
#[tauri::command(async)]
pub fn delete_recording(wav_path: PathBuf) -> Result<(), String> {
    check_readable(&wav_path).map_err(String::from)?;

    for path in [wav_path.with_extension("opus"), wav_path] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(OpusError::Io(error.to_string()).into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{samples_at, write_wav};
    use crate::ogg::read_pages;
    use opus_rs::OpusDecoder;

    /// A 300 Hz tone — inside the band Opus keeps at any bitrate, so what comes back is comparable
    /// with what went in.
    fn tone(seconds: f64) -> Vec<i16> {
        (0..samples_at(seconds))
            .map(|index| {
                let phase = index as f64 * 2.0 * std::f64::consts::PI * 300.0 / 16_000.0;
                (phase.sin() * 8_000.0) as i16
            })
            .collect()
    }

    /// Decodes a stream this module wrote, back to 16 kHz mono.
    ///
    /// Skips the two header packets and drops the pre-skip, which is exactly what a player does.
    fn decode(bytes: &[u8]) -> Vec<f32> {
        let mut decoder = OpusDecoder::new(SAMPLE_RATE as i32, 1).expect("decoder");
        let packets: Vec<Vec<u8>> =
            read_pages(bytes).into_iter().flat_map(|page| page.packets).skip(2).collect();

        let mut samples = Vec::new();
        let mut frame = vec![0f32; FRAME_SAMPLES];
        for packet in packets {
            let written = decoder.decode(&packet, FRAME_SAMPLES, &mut frame).expect("decode");
            samples.extend_from_slice(&frame[..written]);
        }
        // Pre-skip is quoted at 48 kHz; the decoder here runs at 16.
        samples.split_off(PRE_SKIP_48K as usize / 3)
    }

    /// Normalised cross-correlation of two signals at one lag. 1.0 is identical, 0.0 unrelated.
    fn correlation_at(left: &[f32], right: &[f32], lag: usize) -> f64 {
        let overlap = left.len().min(right.len().saturating_sub(lag));
        let mut dot = 0.0f64;
        let mut left_energy = 0.0f64;
        let mut right_energy = 0.0f64;
        for index in 0..overlap {
            let (one, two) = (f64::from(left[index]), f64::from(right[index + lag]));
            dot += one * two;
            left_energy += one * one;
            right_energy += two * two;
        }
        dot / (left_energy.sqrt() * right_energy.sqrt()).max(f64::MIN_POSITIVE)
    }

    /// Best correlation within a lag window, and the lag it was found at.
    ///
    /// Searched rather than taken at zero because a periodic signal's zero-lag correlation is a
    /// measure of phase, not of similarity: a 300 Hz tone repeats every 53 samples, so a few
    /// milliseconds of codec delay drives it negative while the two signals are plainly the same
    /// sound. Alignment is what `lines_the_decoded_audio_up_with_the_input` measures; this asks
    /// only whether the audio survived.
    fn best_correlation(left: &[f32], right: &[f32], max_lag: usize) -> (f64, usize) {
        (0..=max_lag)
            .map(|lag| (correlation_at(left, right, lag), lag))
            .fold((f64::MIN, 0), |best, candidate| {
                if candidate.0 > best.0 { candidate } else { best }
            })
    }

    #[test]
    fn writes_a_stream_that_opens_with_the_two_required_headers() {
        let bytes = encode_pcm_to_ogg_opus(&tone(0.5), BITRATE_BPS).expect("encode");
        let pages = read_pages(&bytes);

        assert_eq!(&pages[0].packets[0][..8], b"OpusHead");
        assert_eq!(pages[0].packets.len(), 1, "OpusHead must be alone on the first page");
        assert_eq!(&pages[1].packets[0][..8], b"OpusTags");
        // Pre-skip is at bytes 10..12 of OpusHead, and a decoder trims exactly this much.
        assert_eq!(
            u16::from_le_bytes([pages[0].packets[0][10], pages[0].packets[0][11]]),
            PRE_SKIP_48K,
        );
    }

    #[test]
    fn the_final_granule_is_the_real_length_not_the_padded_one() {
        // 1.11 s is deliberately not a whole number of 20 ms frames: the last frame is padded with
        // silence, and the granule has to say so or the file is longer than the speech.
        let samples = tone(1.11);
        let bytes = encode_pcm_to_ogg_opus(&samples, BITRATE_BPS).expect("encode");
        let final_granule = read_pages(&bytes).last().expect("a page").granule;

        assert_eq!(final_granule, i64::from(PRE_SKIP_48K) + samples.len() as i64 * 3);
        // What a player reports as the duration: granule minus pre-skip, at 48 kHz.
        let duration = (final_granule - i64::from(PRE_SKIP_48K)) as f64 / 48_000.0;
        assert!((duration - 1.11).abs() < 0.001, "duration was {duration}");
    }

    #[test]
    fn decodes_back_to_the_signal_that_went_in() {
        // The whole reason a pure-Rust port is acceptable here: the encode is proved by decoding
        // it, not by the crate saying it works. A codec that produced plausible-looking packets of
        // noise would pass every other test in this file.
        let samples = tone(1.0);
        let decoded = decode(&encode_pcm_to_ogg_opus(&samples, BITRATE_BPS).expect("encode"));

        assert!(decoded.len() >= samples.len(), "decoded {} samples", decoded.len());
        let original: Vec<f32> =
            samples.iter().map(|sample| f32::from(*sample) / 32_768.0).collect();

        // Correlation rather than sample equality: Opus is lossy, so the question is whether this
        // is the same signal, not whether it is the same numbers.
        let (matched, lag) = best_correlation(&original, &decoded, FRAME_SAMPLES);
        assert!(matched > 0.9, "correlation was {matched} at lag {lag}");
    }

    #[test]
    fn lines_the_decoded_audio_up_with_the_input() {
        // Measures the constant PRE_SKIP_48K claims. Silence, then a burst: if the declared
        // pre-skip matches the encoder's real lookahead the burst comes back where it went in.
        let mut samples = vec![0i16; samples_at(0.4)];
        samples.extend(tone(0.4));
        samples.extend(vec![0i16; samples_at(0.4)]);
        let decoded = decode(&encode_pcm_to_ogg_opus(&samples, BITRATE_BPS).expect("encode"));

        let onset = decoded
            .iter()
            .position(|value| value.abs() > 0.05)
            .expect("the burst must survive encoding");
        let drift = onset as i64 - samples_at(0.4) as i64;
        // One 20 ms frame of tolerance. A larger drift means this port's lookahead is not
        // libopus's, and the constant at the top of this file is the thing to change.
        assert!(drift.abs() < FRAME_SAMPLES as i64, "burst arrived {drift} samples out");
    }

    #[test]
    fn is_roughly_a_tenth_the_size_of_the_wav() {
        // The claim phase 9 made when it deferred this, checked rather than repeated.
        let samples = tone(30.0);
        let bytes = encode_pcm_to_ogg_opus(&samples, BITRATE_BPS).expect("encode");
        let wav_bytes = samples.len() * 2;
        let ratio = bytes.len() as f64 / wav_bytes as f64;
        assert!(ratio < 0.15, "opus was {ratio} of the wav");
    }

    #[test]
    fn encodes_a_recording_with_no_audio_in_it() {
        // A speech where the microphone was muted still has a session row, and the player still
        // opens it. An empty stream is a valid one.
        let bytes = encode_pcm_to_ogg_opus(&[], BITRATE_BPS).expect("encode");
        let pages = read_pages(&bytes);
        assert_eq!(&pages[0].packets[0][..8], b"OpusHead");
        assert_eq!(pages.last().expect("a page").granule, i64::from(PRE_SKIP_48K));
    }

    #[test]
    fn writes_the_opus_beside_the_wav_and_reuses_it() {
        let dir = std::env::temp_dir().join("debate-coach-opus-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let wav_path = dir.join("session.wav");
        std::fs::remove_file(wav_path.with_extension("opus")).ok();
        write_wav(&wav_path, &tone(2.0)).expect("write");

        let first = encode_wav_to_opus(&wav_path).expect("encode");
        assert_eq!(first.opus_path, dir.join("session.opus"));
        assert!(first.opus_bytes > 0 && first.opus_bytes < first.wav_bytes);
        assert!((first.duration_seconds - 2.0).abs() < 0.01);

        // Second call must not re-encode: a WAV is written once and never appended to.
        let modified = std::fs::metadata(&first.opus_path).expect("meta").modified().expect("mtime");
        let second = encode_wav_to_opus(&wav_path).expect("encode");
        assert_eq!(second.opus_bytes, first.opus_bytes);
        assert_eq!(
            std::fs::metadata(&second.opus_path).expect("meta").modified().expect("mtime"),
            modified,
        );

        delete_recording(wav_path.clone()).expect("delete");
        assert!(!wav_path.exists() && !first.opus_path.exists());
    }

    #[test]
    fn refuses_to_read_anything_that_is_not_a_recording() {
        // Without this check the command is a general-purpose file reader reachable from a webview.
        assert!(check_readable(Path::new("C:/prep/session.opus")).is_ok());
        assert!(check_readable(Path::new("C:/prep/session.WAV")).is_ok());
        assert!(check_readable(Path::new("C:/windows/system32/config/SAM")).is_err());
        assert!(check_readable(Path::new("C:/prep/session")).is_err());
    }

    #[test]
    fn deleting_a_recording_that_is_already_gone_is_not_an_error() {
        let path = std::env::temp_dir().join("debate-coach-never-existed.wav");
        assert_eq!(delete_recording(path), Ok(()));
    }
}
