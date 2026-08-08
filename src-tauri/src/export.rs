//! Writing exports to disk, and reading a `.dbcase` back.
//!
//! The frontend builds the bytes — a `.docx` is assembled in `src/export/`, where it can be
//! round-tripped by the same tests that read the reference template — and this puts them on
//! disk. The alternative was `tauri-plugin-fs`, whose scope is a path allowlist declared in the
//! capability file: granting the webview a path it can write is either narrower than a save
//! dialog needs or, spelled `**`, the whole disk. Two commands that each accept one extension
//! are a smaller thing to reason about.
//!
//! **The extension check is the whole security boundary here.** A command that writes arbitrary
//! bytes to an arbitrary path is a general-purpose file writer reachable from a webview; one
//! that writes only to `.docx` and `.dbcase` is not. The path itself always comes from the OS
//! save dialog, so this is a second line rather than the first — but it costs a string compare.

use std::path::Path;
use std::path::PathBuf;

/// Extensions [`write_export_file`] will write. Everything this app exports has one of them.
const WRITABLE_EXTENSIONS: [&str; 2] = ["docx", "dbcase"];

/// Extension [`read_case_file`] will read.
const READABLE_EXTENSION: &str = "dbcase";

/// Largest `.dbcase` worth reading into memory.
///
/// A case is a few hundred kilobytes of JSON; sixteen megabytes is three orders of magnitude of
/// headroom and still small enough that pointing this at a disk image fails fast instead of
/// exhausting memory.
const MAX_IMPORT_BYTES: u64 = 16 * 1024 * 1024;

/// Everything that can go wrong moving a case between the app and the filesystem.
#[derive(Debug)]
pub enum ExportError {
    /// The path does not end in an extension this command handles. Carries what was asked for.
    UnsupportedExtension(String),
    /// The directory the file would go in does not exist. Usually a stale path, not a typo.
    MissingDirectory(PathBuf),
    /// The file is larger than [`MAX_IMPORT_BYTES`], so it is not a case file.
    TooLarge(u64),
    /// The file is not valid UTF-8, so it is not a `.dbcase` whatever it is named.
    NotText,
    /// The filesystem refused. Carries its own message, which names the actual cause.
    Io(String),
}

impl std::fmt::Display for ExportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedExtension(extension) => {
                write!(formatter, "cannot handle a .{extension} file here")
            }
            Self::MissingDirectory(path) => {
                write!(formatter, "that folder no longer exists: {}", path.display())
            }
            Self::TooLarge(bytes) => {
                write!(formatter, "that file is {bytes} bytes, far too large to be a case file")
            }
            Self::NotText => write!(formatter, "that file is not text, so it is not a case file"),
            Self::Io(message) => write!(formatter, "the file could not be used: {message}"),
        }
    }
}

impl std::error::Error for ExportError {}

impl From<ExportError> for String {
    fn from(error: ExportError) -> Self {
        error.to_string()
    }
}

/// Checks a path's extension against a list.
///
/// * `path` — the destination or source. A path with no extension at all is refused rather than
///   defaulting to anything: an export saved as `case` with no suffix opens in nothing.
/// * `allowed` — lowercase extensions without the dot. Comparison is case-insensitive, because a
///   Windows save dialog will hand back `.DOCX` if that is what was typed.
///
/// # Errors
/// [`ExportError::UnsupportedExtension`] naming what the path actually ended in.
pub fn check_extension(path: &Path, allowed: &[&str]) -> Result<(), ExportError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if allowed.contains(&extension.as_str()) {
        Ok(())
    } else {
        Err(ExportError::UnsupportedExtension(extension))
    }
}

/// Writes an export to disk.
///
/// `(async)` because it runs off the main thread: a case on a network drive or a OneDrive folder
/// mid-sync can block for seconds on a write that is instant locally, and this is called from a
/// button the user just pressed.
///
/// * `path` — where to write, from the OS save dialog. Must end in `.docx` or `.dbcase`; see the
///   module docstring for why that is checked rather than trusted.
/// * `contents` — the file's bytes. Sent as a plain array rather than as a raw request body,
///   which carries no second argument for the path — an export is a hundred kilobytes once per
///   press, so the encoding cost is not worth a header round trip.
///
/// # Errors
/// Returns a message when the extension is not one this app writes, the folder is gone, or the
/// write itself fails.
#[tauri::command(async)]
pub fn write_export_file(path: PathBuf, contents: Vec<u8>) -> Result<(), String> {
    check_extension(&path, &WRITABLE_EXTENSIONS)?;

    // Checked before writing so a stale folder reports as itself. `fs::write` would report
    // "the system cannot find the path specified", which reads like the file is missing.
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(ExportError::MissingDirectory(parent.to_path_buf()).into());
        }
    }

    std::fs::write(&path, contents).map_err(|error| ExportError::Io(error.to_string()).into())
}

/// Reads a `.dbcase` back.
///
/// * `path` — the file to read, from the OS open dialog. Must end in `.dbcase`.
///
/// # Errors
/// Returns a message when the extension is wrong, the file is implausibly large, it is not UTF-8,
/// or it cannot be read. Whether the contents are actually a case file is decided in TypeScript
/// by `readDbcase`, which is where the format is defined.
#[tauri::command(async)]
pub fn read_case_file(path: PathBuf) -> Result<String, String> {
    check_extension(&path, &[READABLE_EXTENSION])?;

    let metadata =
        std::fs::metadata(&path).map_err(|error| ExportError::Io(error.to_string()))?;
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(ExportError::TooLarge(metadata.len()).into());
    }

    let bytes = std::fs::read(&path).map_err(|error| ExportError::Io(error.to_string()))?;
    let text = String::from_utf8(bytes).map_err(|_| ExportError::NotText)?;
    // A file saved from Notepad carries a UTF-8 BOM, and `JSON.parse` throws on one with an
    // error that says nothing about a byte-order mark.
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_two_export_extensions() {
        assert!(check_extension(Path::new("C:/prep/case.docx"), &WRITABLE_EXTENSIONS).is_ok());
        assert!(check_extension(Path::new("C:/prep/case.dbcase"), &WRITABLE_EXTENSIONS).is_ok());
    }

    #[test]
    fn accepts_an_extension_the_dialog_upper_cased() {
        assert!(check_extension(Path::new("C:/prep/CASE.DOCX"), &WRITABLE_EXTENSIONS).is_ok());
    }

    #[test]
    fn refuses_anything_else() {
        // The point of the check: without it this command overwrites a DLL beside the app.
        let refused = check_extension(Path::new("C:/windows/system32/foo.dll"), &WRITABLE_EXTENSIONS);
        assert!(matches!(refused, Err(ExportError::UnsupportedExtension(ref found)) if found == "dll"));
    }

    #[test]
    fn refuses_a_path_with_no_extension() {
        let refused = check_extension(Path::new("C:/prep/case"), &WRITABLE_EXTENSIONS);
        assert!(matches!(refused, Err(ExportError::UnsupportedExtension(ref found)) if found.is_empty()));
    }

    #[test]
    fn import_refuses_a_docx() {
        // A `.docx` is an export, not an import — reading one back is phase 8's one asymmetry,
        // and it has to fail as a wrong file rather than as unparseable JSON.
        let refused = check_extension(Path::new("C:/prep/case.docx"), &[READABLE_EXTENSION]);
        assert!(refused.is_err());
    }

    /// The exact argument object `writeFile` in `src/export/index.ts` sends.
    ///
    /// Pinned here for the same reason `coach.rs` pins its request body: this shape is otherwise
    /// only ever checked by pressing the button, and the failure — a `Uint8Array` serialising as
    /// `{"0":1,…}` instead of an array — produces a deserialisation error with no clue in it.
    #[derive(serde::Deserialize)]
    struct WriteArgs {
        path: PathBuf,
        contents: Vec<u8>,
    }

    #[test]
    fn accepts_the_argument_shape_the_frontend_sends() {
        let body = r#"{"path":"C:/prep/case.docx","contents":[80,75,3,4]}"#;
        let parsed: WriteArgs = serde_json::from_str(body).expect("frontend shape must parse");
        assert_eq!(parsed.path, PathBuf::from("C:/prep/case.docx"));
        // "PK\x03\x04" — the local file header signature every export starts with.
        assert_eq!(parsed.contents, vec![80, 75, 3, 4]);
    }

    #[test]
    fn refuses_the_shape_a_uint8array_would_serialise_to() {
        // What `invoke` sends if the frontend ever stops calling `Array.from`.
        let body = r#"{"path":"C:/prep/case.docx","contents":{"0":80,"1":75}}"#;
        assert!(serde_json::from_str::<WriteArgs>(body).is_err());
    }

    #[test]
    fn writes_then_reads_a_case_file_back() {
        let path = std::env::temp_dir().join("debate-coach-export-test.dbcase");
        let contents = br#"{"kind":"debate-coach-case"}"#;
        write_export_file(path.clone(), contents.to_vec()).expect("write");

        assert_eq!(read_case_file(path.clone()).as_deref(), Ok(r#"{"kind":"debate-coach-case"}"#));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn strips_the_byte_order_mark_notepad_adds() {
        let path = std::env::temp_dir().join("debate-coach-bom-test.dbcase");
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice(b"{}");
        std::fs::write(&path, &bytes).expect("write");

        // Without the strip this comes back with a leading U+FEFF and `JSON.parse` throws an
        // error that says nothing about a byte-order mark.
        assert_eq!(read_case_file(path.clone()).as_deref(), Ok("{}"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn reports_a_missing_folder_as_itself() {
        let refused = write_export_file(
            PathBuf::from("C:/definitely/not/here/case.docx"),
            vec![1, 2, 3],
        );
        assert!(refused.is_err_and(|message| message.contains("no longer exists")));
    }

    #[test]
    fn write_refuses_before_touching_the_disk() {
        // The destination is inside a folder that does not exist either; the extension check has
        // to be what rejects it, so the error names the real reason.
        let refused = write_export_file(
            PathBuf::from("C:/definitely/not/here/case.exe"),
            vec![1, 2, 3],
        );
        assert_eq!(refused, Err("cannot handle a .exe file here".to_owned()));
    }
}
