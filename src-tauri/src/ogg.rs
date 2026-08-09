//! The Ogg container, written by hand.
//!
//! An Opus encoder produces packets; a `.opus` file is those packets in Ogg pages. Nothing else in
//! this app needs a container, and the crates that would supply one bring a dependency tree to
//! write a 27-byte header and a CRC — the same trade `src/export/zip.ts` already took for the
//! `.docx`, for the same reason: the format is small, fixed, and fully testable, while a
//! dependency is none of those.
//!
//! **Three details are where a hand-written Ogg goes wrong**, and each is handled at its site:
//!
//!   * the CRC is *not* the CRC-32 everything else uses — no reflection, no final xor, and the
//!     checksum field must be zero while it is computed;
//!   * a packet is split into 255-byte lacing values, and a packet whose length is an exact
//!     multiple of 255 needs a trailing zero or the reader joins it to the next one;
//!   * granule position is per *page* and belongs to the last packet that **finishes** on it.
//!
//! What is deliberately not supported: a packet larger than one page can hold. Opus caps a packet
//! at 1275 bytes, which is six lacing values against a limit of 255, so the continuation flag has
//! no reachable caller here — and an unreachable branch is worse than a refusal that names itself.

/// Bytes a single lacing value can describe. 255 means "this packet continues".
const LACING_UNIT: usize = 255;

/// Lacing values one page can carry.
const MAX_SEGMENTS: usize = 255;

/// Segments to fill before starting a new page.
///
/// Nothing requires pages to be any particular size; this keeps them near 4 kB of payload, which
/// is what other Ogg encoders emit and what a demuxer's read buffer is sized for.
const SEGMENTS_PER_PAGE: usize = 50;

/// Header-type flag: this page opens the logical bitstream.
const FLAG_BEGIN: u8 = 0x02;

/// Header-type flag: this page closes it.
const FLAG_END: u8 = 0x04;

/// Ogg's CRC-32: polynomial 0x04c11db7, MSB-first, no input or output reflection, no final xor.
///
/// Written out because it is genuinely a different function from the reflected CRC-32 in ZIP and
/// PNG, and reusing one for the other produces a file that is byte-perfect except for four bytes
/// per page that every player rejects.
const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut index = 0usize;
    while index < 256 {
        let mut register = (index as u32) << 24;
        let mut bit = 0;
        while bit < 8 {
            register = if register & 0x8000_0000 != 0 {
                (register << 1) ^ 0x04c1_1db7
            } else {
                register << 1
            };
            bit += 1;
        }
        table[index] = register;
        index += 1;
    }
    table
}

/// The table, built at compile time.
static CRC_TABLE: [u32; 256] = crc_table();

/// Checksums a whole page, which must already have zeros in its checksum field.
fn page_crc(page: &[u8]) -> u32 {
    let mut register: u32 = 0;
    for byte in page {
        let index = ((register >> 24) as u8 ^ *byte) as usize;
        register = (register << 8) ^ CRC_TABLE[index];
    }
    register
}

/// Why a stream could not be written.
#[derive(Debug, PartialEq, Eq)]
pub enum OggError {
    /// A packet needed more lacing values than a page holds. See the module docstring — no Opus
    /// packet can reach this, so it means the caller is muxing something else.
    PacketTooLarge(usize),
}

impl std::fmt::Display for OggError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PacketTooLarge(bytes) => {
                write!(formatter, "a {bytes}-byte packet does not fit in one Ogg page")
            }
        }
    }
}

impl std::error::Error for OggError {}

/// Builds one logical Ogg bitstream.
///
/// Packets are buffered into a page, and the page is emitted when it fills, when a header forces a
/// boundary, or at [`OggWriter::finish`].
pub struct OggWriter {
    /// Identifies the logical bitstream. Only has to be unique within one physical stream, and
    /// this writer never multiplexes, so the caller passes a constant — which is what makes two
    /// encodes of one recording byte-identical.
    serial: u32,
    /// Sequence number of the next page. A gap here is how a player detects a truncated file.
    next_page: u32,
    /// Finished pages.
    out: Vec<u8>,
    /// Lacing values for the page being built.
    lacing: Vec<u8>,
    /// Payload for the page being built.
    body: Vec<u8>,
    /// Granule position of the last packet that ends on the page being built.
    granule: i64,
    /// True until the first page is emitted, so it can carry the begin-of-stream flag.
    is_first_page: bool,
}

impl OggWriter {
    /// Starts a stream.
    ///
    /// * `serial` — the bitstream serial number. Any value works; a fixed one keeps the output
    ///   deterministic, which is what lets a test compare two encodes of the same audio.
    #[must_use]
    pub fn new(serial: u32) -> Self {
        Self {
            serial,
            next_page: 0,
            out: Vec::new(),
            lacing: Vec::new(),
            body: Vec::new(),
            granule: 0,
            is_first_page: true,
        }
    }

    /// Lacing values a packet of this length needs.
    ///
    /// A length that is an exact multiple of 255 needs one more than the division says — the extra
    /// zero is what tells a reader the packet ended rather than continuing into the next segment.
    fn segments_for(length: usize) -> usize {
        length / LACING_UNIT + 1
    }

    /// Adds a packet to the stream.
    ///
    /// * `packet` — one Opus packet, or one header packet. Empty is legal Ogg — a zero-length
    ///   lacing value — and is written rather than skipped, because dropping it would shift every
    ///   following packet's granule.
    /// * `granule` — the granule position *after* this packet, in 48 kHz samples for an Opus
    ///   stream. Must not decrease; that is not checked here because the only caller computes it
    ///   monotonically and the check would be unreachable from the public API.
    ///
    /// # Errors
    /// [`OggError::PacketTooLarge`] if the packet needs more than 255 lacing values.
    pub fn push_packet(&mut self, packet: &[u8], granule: i64) -> Result<(), OggError> {
        let segments = Self::segments_for(packet.len());
        if segments > MAX_SEGMENTS {
            return Err(OggError::PacketTooLarge(packet.len()));
        }
        if self.lacing.len() + segments > MAX_SEGMENTS {
            self.flush_page(false);
        }

        let mut remaining = packet.len();
        while remaining >= LACING_UNIT {
            self.lacing.push(255);
            remaining -= LACING_UNIT;
        }
        self.lacing.push(remaining as u8);
        self.body.extend_from_slice(packet);
        self.granule = granule;

        if self.lacing.len() >= SEGMENTS_PER_PAGE {
            self.flush_page(false);
        }
        Ok(())
    }

    /// Ends the current page, whatever is on it.
    ///
    /// Called after each header packet, because a decoder is entitled to expect `OpusHead` alone
    /// on the first page and `OpusTags` to start the second. Does nothing when no packet has been
    /// added since the last page.
    pub fn end_page(&mut self) {
        if !self.lacing.is_empty() {
            self.flush_page(false);
        }
    }

    /// Emits the buffered page.
    fn flush_page(&mut self, is_last: bool) {
        let mut page = Vec::with_capacity(27 + self.lacing.len() + self.body.len());
        page.extend_from_slice(b"OggS");
        page.push(0);

        let mut flags = 0u8;
        if self.is_first_page {
            flags |= FLAG_BEGIN;
        }
        if is_last {
            flags |= FLAG_END;
        }
        page.push(flags);

        page.extend_from_slice(&self.granule.to_le_bytes());
        page.extend_from_slice(&self.serial.to_le_bytes());
        page.extend_from_slice(&self.next_page.to_le_bytes());
        // Checksummed with these four bytes zero, then patched below.
        let checksum_at = page.len();
        page.extend_from_slice(&[0, 0, 0, 0]);
        page.push(self.lacing.len() as u8);
        page.extend_from_slice(&self.lacing);
        page.extend_from_slice(&self.body);

        let checksum = page_crc(&page);
        page[checksum_at..checksum_at + 4].copy_from_slice(&checksum.to_le_bytes());

        self.out.extend_from_slice(&page);
        self.next_page += 1;
        self.is_first_page = false;
        self.lacing.clear();
        self.body.clear();
    }

    /// Closes the stream and returns the file.
    ///
    /// The last page carries the end-of-stream flag, which is how a player knows the file is whole
    /// rather than cut off mid-upload. An empty page is emitted if every packet has already been
    /// flushed, because the flag has to land somewhere.
    #[must_use]
    pub fn finish(mut self) -> Vec<u8> {
        self.flush_page(true);
        self.out
    }
}

/// One page, as a reader sees it.
#[cfg(test)]
pub struct Page {
    /// Header-type flags byte.
    pub flags: u8,
    /// Granule position of the last packet finishing on this page.
    pub granule: i64,
    /// Page sequence number.
    pub sequence: u32,
    /// Whole packets that ended on this page.
    pub packets: Vec<Vec<u8>>,
}

/// Reads a stream back, checking every page's CRC.
///
/// Test-only, and deliberately not part of the shipped API: it exists to prove the writer's
/// arithmetic, not to be trusted about the format. ffmpeg is what says the result is an Opus file —
/// see the phase note in PLAN.md. `opus.rs`'s round trip uses this to recover the packets it fed in.
///
/// * `bytes` — a whole stream from [`OggWriter::finish`].
///
/// # Panics
/// On a malformed page, a bad checksum, or a packet continued across a page boundary, none of
/// which this writer produces.
#[cfg(test)]
#[must_use]
pub fn read_pages(bytes: &[u8]) -> Vec<Page> {
    let mut pages = Vec::new();
    let mut cursor = 0usize;

    // Each iteration reads one page: header, lacing table, then the bodies the lacing describes.
    // A lacing value under 255 ends a packet, which is the only place a packet boundary exists.
    while cursor < bytes.len() {
        assert_eq!(&bytes[cursor..cursor + 4], b"OggS", "page must start with OggS");
        let segment_count = bytes[cursor + 26] as usize;
        let lacing = &bytes[cursor + 27..cursor + 27 + segment_count];
        let body_len: usize = lacing.iter().map(|value| *value as usize).sum();
        let page_len = 27 + segment_count + body_len;
        let page = &bytes[cursor..cursor + page_len];

        let stated = u32::from_le_bytes([page[22], page[23], page[24], page[25]]);
        let mut zeroed = page.to_vec();
        zeroed[22..26].copy_from_slice(&[0, 0, 0, 0]);
        assert_eq!(page_crc(&zeroed), stated, "page checksum");

        let mut packets = Vec::new();
        let mut packet = Vec::new();
        let mut at = 27 + segment_count;
        for value in lacing {
            let length = *value as usize;
            packet.extend_from_slice(&page[at..at + length]);
            at += length;
            if length < LACING_UNIT {
                packets.push(std::mem::take(&mut packet));
            }
        }
        assert!(packet.is_empty(), "this writer never continues a packet across pages");

        pages.push(Page {
            flags: page[5],
            granule: i64::from_le_bytes(page[6..14].try_into().expect("8 bytes")),
            sequence: u32::from_le_bytes(page[18..22].try_into().expect("4 bytes")),
            packets,
        });
        cursor += page_len;
    }
    pages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_header_page_a_reader_can_take_back_apart() {
        let mut writer = OggWriter::new(0x0000_0001);
        let mut head = Vec::from(*b"OpusHead");
        head.extend_from_slice(&[1, 1]);
        head.extend_from_slice(&312u16.to_le_bytes());
        head.extend_from_slice(&16_000u32.to_le_bytes());
        head.extend_from_slice(&[0, 0, 0]);
        writer.push_packet(&head, 0).expect("header fits");
        writer.end_page();
        let bytes = writer.finish();

        let pages = read_pages(&bytes);
        assert_eq!(pages[0].flags & FLAG_BEGIN, FLAG_BEGIN);
        assert_eq!(pages[0].packets[0], head);
    }

    #[test]
    fn a_packet_that_is_a_multiple_of_255_keeps_its_boundary() {
        // The classic Ogg bug: 255 bytes laces as [255] and joins the next packet unless the
        // trailing zero is written.
        let mut writer = OggWriter::new(7);
        writer.push_packet(&vec![1u8; 255], 960).expect("fits");
        writer.push_packet(&[2u8, 2], 1920).expect("fits");
        let pages = read_pages(&writer.finish());

        let packets: Vec<Vec<u8>> = pages.into_iter().flat_map(|page| page.packets).collect();
        assert_eq!(packets.len(), 2);
        assert_eq!(packets[0].len(), 255);
        assert_eq!(packets[1], vec![2, 2]);
    }

    #[test]
    fn pages_are_numbered_without_gaps_and_the_last_one_ends_the_stream() {
        let mut writer = OggWriter::new(7);
        for frame in 1..=200 {
            writer.push_packet(&[9u8; 40], i64::from(frame) * 960).expect("fits");
        }
        let pages = read_pages(&writer.finish());

        assert!(pages.len() > 1, "200 packets must span pages");
        for (index, page) in pages.iter().enumerate() {
            assert_eq!(page.sequence, index as u32);
        }
        assert_eq!(pages.last().expect("a page").flags & FLAG_END, FLAG_END);
        assert_eq!(pages.last().expect("a page").granule, 200 * 960);
    }

    #[test]
    fn a_granule_belongs_to_the_page_its_packet_finishes_on() {
        let mut writer = OggWriter::new(7);
        writer.push_packet(&[1u8; 10], 960).expect("fits");
        writer.end_page();
        writer.push_packet(&[2u8; 10], 1920).expect("fits");
        let pages = read_pages(&writer.finish());

        assert_eq!(pages[0].granule, 960);
        assert_eq!(pages[1].granule, 1920);
    }

    #[test]
    fn refuses_a_packet_no_page_could_hold() {
        let mut writer = OggWriter::new(7);
        let refused = writer.push_packet(&vec![0u8; 255 * 256], 0);
        assert_eq!(refused, Err(OggError::PacketTooLarge(255 * 256)));
    }

    #[test]
    fn two_encodes_of_the_same_packets_are_byte_identical() {
        let build = || {
            let mut writer = OggWriter::new(7);
            writer.push_packet(b"OpusHead-ish", 0).expect("fits");
            writer.end_page();
            writer.push_packet(&[3u8; 90], 960).expect("fits");
            writer.finish()
        };
        assert_eq!(build(), build());
    }
}
