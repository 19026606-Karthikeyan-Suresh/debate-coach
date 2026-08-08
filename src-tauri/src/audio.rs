//! Audio buffering and the WAV files whisper reads.
//!
//! Everything here is 16 kHz mono signed 16-bit little-endian, because that is the only format
//! whisper.cpp accepts. It resamples nothing and validates nothing — hand it 44.1 kHz and it
//! transcribes gibberish with total confidence, which is a far worse failure than an error.
//!
//! **The whole speech is held in memory.** Seven minutes is 6.7 million samples, 13 MB, and
//! keeping it means the rolling window can be re-read at any offset without seeking a file that
//! is still being written. The WAV is written once, at the end, from that buffer.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::Mutex;

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
}
