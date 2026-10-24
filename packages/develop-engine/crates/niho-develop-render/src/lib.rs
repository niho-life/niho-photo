//! `niho-develop-render`: the native stage-2 renderer that NIHO Desktop runs
//! as a child process for the full-size export (spec
//! `specs/initiatives/niho-develop-engine.md` "Desktop（S7）", Issue #16946).
//!
//! It renders one photo with the same crate (`niho-develop`) and the same
//! calls as the browser's wasm, so the pixels agree with the wasm within
//! 1 LSB at the same size (spec 決まりごと 2):
//!
//! - `--working-copy <png> --meta <json>`: `Session::open_working_copy`, then
//!   `render(settings, max_dimension, Quality::Final)` (the wasm's
//!   `Developer.openWorkingCopy(...).render(settings, maxDimension, false)`).
//! - `--raster <jpeg|png>`: `Session::open_raster(bytes, max_dimension)`, then
//!   `render(settings, 0, Quality::Final)` (the wasm's one-shot `render` /
//!   `exportJpeg`). With a geometry (`v: 2`) the original is opened at
//!   `raster_decode_size(settings, width, height, max_dimension, 0)` (large
//!   enough for the crop to reach `max_dimension`, no cap) and rendered at
//!   `max_dimension`: the one-shot `render` with `decode_cap` 0.
//! - `--mask-surface <id>=<png>` (repeatable, at most 8): the surfaces of
//!   `brush` / `subject` / `sky` masks, set into the Session with
//!   `Session::set_mask_surface` before the render (the wasm's
//!   `Developer.setMaskSurface`; `docs/local-adjustments.md` "面の受け渡し").
//!
//! The output is an 8-bit sRGB PNG without an ICC profile (untagged = sRGB).
//! The JPEG is written by `apple-raw-linear encode-jpeg`, which carries the
//! original's capture time only (W2b-1 #17145, Epic #17114 Decision 10).
//!
//! stdout carries exactly one JSON line: the summary, or
//! `{"error":"<code>","message":"..."}` with a non-zero exit code
//! ([`ErrorCode::exit_code`], README "native CLI").

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};
use niho_develop::settings::READABLE_SETTINGS_VERSIONS;
use niho_develop::{DecodeError, DevelopSettings, Filter, Quality, Session};
use serde_json::{json, Value};

pub const TOOL_NAME: &str = "niho-develop-render";

/// Stable error codes (stdout `error`) and their exit codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// Unknown subcommand / option, missing or conflicting options.
    InvalidArguments,
    /// `developSettings` of a shape (`v`), formula (`engine`) or look this
    /// build does not render.
    UnsupportedSettings,
    /// `developSettings` unreadable, of the wrong types or out of range.
    InvalidSettings,
    /// An input file (settings, working copy, meta, original, mask
    /// surface) is missing.
    InputNotFound,
    /// An input file exists but cannot be read.
    ReadFailed,
    /// The working copy / original is not a decodable JPEG / PNG, or a mask
    /// surface is not the PNG its id names (`maskSurfaceInvalid`).
    DecodeFailed,
    /// The original's ICC profile cannot be converted.
    UnsupportedProfile,
    /// The working copy's metadata is malformed.
    InvalidMetadata,
    /// The PNG could not be encoded.
    EncodeFailed,
    /// The PNG could not be written or moved into place.
    WriteFailed,
    /// A bug (a panic).
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidArguments => "invalid_arguments",
            ErrorCode::UnsupportedSettings => "unsupported_settings",
            ErrorCode::InvalidSettings => "invalid_settings",
            ErrorCode::InputNotFound => "input_not_found",
            ErrorCode::ReadFailed => "read_failed",
            ErrorCode::DecodeFailed => "decode_failed",
            ErrorCode::UnsupportedProfile => "unsupported_profile",
            ErrorCode::InvalidMetadata => "invalid_metadata",
            ErrorCode::EncodeFailed => "encode_failed",
            ErrorCode::WriteFailed => "write_failed",
            ErrorCode::Internal => "internal_error",
        }
    }

    /// 1 arguments, 2 unsupported settings, 3 invalid settings, 4 an input
    /// file, 5 an input that does not decode, 6 the output, 70 a bug.
    pub fn exit_code(self) -> i32 {
        match self {
            ErrorCode::InvalidArguments => 1,
            ErrorCode::UnsupportedSettings => 2,
            ErrorCode::InvalidSettings => 3,
            ErrorCode::InputNotFound | ErrorCode::ReadFailed => 4,
            ErrorCode::DecodeFailed
            | ErrorCode::UnsupportedProfile
            | ErrorCode::InvalidMetadata => 5,
            ErrorCode::EncodeFailed | ErrorCode::WriteFailed => 6,
            ErrorCode::Internal => 70,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliError {
    pub code: ErrorCode,
    pub message: String,
}

impl CliError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn arguments(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArguments, message)
    }

    /// `{"error":"<code>","message":"..."}` on one line.
    pub fn json_line(&self) -> String {
        json!({"error": self.code.as_str(), "message": self.message}).to_string()
    }
}

impl From<DecodeError> for CliError {
    fn from(e: DecodeError) -> Self {
        let (code, message) = match e {
            DecodeError::DecodeFailed(m) => (ErrorCode::DecodeFailed, m),
            DecodeError::UnsupportedProfile(m) => (ErrorCode::UnsupportedProfile, m),
            DecodeError::InvalidMetadata(m) => (ErrorCode::InvalidMetadata, m),
        };
        Self::new(code, message)
    }
}

impl From<niho_develop::Error> for CliError {
    fn from(e: niho_develop::Error) -> Self {
        match e {
            niho_develop::Error::Decode(d) => d.into(),
            niho_develop::Error::Encode(m) => Self::new(ErrorCode::EncodeFailed, m),
            // An active `brush` / `subject` / `sky` mask whose surface was
            // not given (`--mask-surface`): these settings cannot be drawn
            // as they are (as M2, which had no surfaces at all).
            e @ niho_develop::Error::MaskSurfaceMissing(_) => {
                Self::new(ErrorCode::UnsupportedSettings, e.to_string())
            }
            // A `--mask-surface` file that is not the surface its id names.
            e @ niho_develop::Error::MaskSurfaceInvalid { .. } => {
                Self::new(ErrorCode::DecodeFailed, e.to_string())
            }
            // `maskSurfaceMismatch` (the settings' `surface` size is not the
            // surface's) and the rest.
            other => Self::new(ErrorCode::InvalidSettings, other.to_string()),
        }
    }
}

/// What the photo is rendered from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A working copy (16-bit PNG) with its metadata JSON. `base_version` is
    /// the working copy's `baseVersion` (`--base-version`, else the meta's
    /// top-level `baseVersion`).
    WorkingCopy {
        png: PathBuf,
        meta: PathBuf,
        base_version: Option<String>,
    },
    /// A JPEG / PNG original.
    Raster { path: PathBuf },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderArgs {
    pub settings: PathBuf,
    pub out: PathBuf,
    pub source: Source,
    /// Long-edge cap of the output (0 = the source's size).
    pub max_dimension: usize,
    /// `--mask-surface <id>=<png>`: the surfaces of `brush` / `subject` /
    /// `sky` masks (id, file), in the order given, ids distinct.
    pub mask_surfaces: Vec<(String, PathBuf)>,
}

/// At most this many `--mask-surface` (the settings' masks).
pub const MAX_MASK_SURFACE_ARGS: usize = niho_develop::settings::MAX_LOCAL_MASKS;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Help,
    Version,
    Render(RenderArgs),
}

pub fn version_line() -> String {
    format!(
        "{TOOL_NAME} {} (niho-develop {}, engine {})",
        env!("CARGO_PKG_VERSION"),
        niho_develop::CRATE_VERSION,
        niho_develop::ENGINE_VERSION
    )
}

pub const USAGE: &str = "\
niho-develop-render — native stage-2 render (niho-develop) to an 8-bit sRGB PNG

USAGE
  niho-develop-render render --settings <developSettings.json> --out <out.png>
      (--working-copy <working.png> --meta <meta.json> [--base-version <v>]
       | --raster <original.jpg|png>)
      [--max-dimension <0|px>]          (default 0 = the source's size)
      [--mask-surface <sha256>=<surface.png>]...   (at most 8)
  niho-develop-render version

The output PNG has no ICC profile (sRGB) and is written through a temporary
file in the same folder, then renamed. stdout is one JSON line: the summary
({\"width\",\"height\",\"renderMs\",\"baseMismatch\",...}) or
{\"error\":\"<code>\",\"message\":\"...\"}.

A working copy needs its baseVersion (--base-version, or a top-level
\"baseVersion\" in the meta) so the summary can report baseMismatch; it is
rendered even when the settings' base differs.

Settings with a geometry (v 2) render the turned, straightened and cropped
frame; --max-dimension caps its long edge (never enlarged), and an original
is decoded large enough for the crop.

--mask-surface gives the surface of brush / subject / sky masks (v 5): the
file is the 8-bit grayscale PNG (at most 8 MiB, 1..4096 px per side) whose
sha256 is <sha256> (64 lowercase hex digits). A file that is not that PNG
is decode_failed (maskSurfaceInvalid); an active surface mask whose surface
is not given is unsupported_settings (maskSurfaceMissing); a surface of
another size than the mask's \"surface\" is invalid_settings
(maskSurfaceMismatch).

Exit codes: 0 ok, 1 invalid_arguments, 2 unsupported_settings,
3 invalid_settings, 4 input_not_found / read_failed,
5 decode_failed / unsupported_profile / invalid_metadata,
6 encode_failed / write_failed, 70 internal_error.
";

/// Parses the arguments after the program name. Options take `--name value`
/// or `--name=value`.
pub fn parse(args: &[String]) -> Result<Command, CliError> {
    let Some((subcommand, rest)) = args.split_first() else {
        return Ok(Command::Help);
    };
    match subcommand.as_str() {
        "-h" | "--help" | "help" => Ok(Command::Help),
        "-V" | "--version" | "version" => Ok(Command::Version),
        "render" => parse_render(rest),
        other => Err(CliError::arguments(format!(
            "unknown subcommand '{other}' (see --help)"
        ))),
    }
}

const RENDER_OPTIONS: [&str; 8] = [
    "--settings",
    "--out",
    "--working-copy",
    "--meta",
    "--base-version",
    "--raster",
    "--max-dimension",
    "--mask-surface",
];

/// Options that may be given more than once.
const REPEATED_OPTIONS: [&str; 1] = ["--mask-surface"];

/// `<id>=<path>` of `--mask-surface`.
fn parse_mask_surface(value: &str) -> Result<(String, PathBuf), CliError> {
    let (id, path) = value.split_once('=').ok_or_else(|| {
        CliError::arguments(format!(
            "--mask-surface must be <sha256>=<surface.png> (got '{value}')"
        ))
    })?;
    if !niho_develop::mask_surface::is_surface_id(id) {
        return Err(CliError::arguments(
            "--mask-surface needs the surface's sha256 (64 lowercase hex digits) before '='",
        ));
    }
    if path.is_empty() {
        return Err(CliError::arguments(format!(
            "--mask-surface {id}= needs a file"
        )));
    }
    Ok((id.to_string(), path.into()))
}

fn parse_render(args: &[String]) -> Result<Command, CliError> {
    let mut values: Vec<(&'static str, String)> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let token = &args[i];
        i += 1;
        if token == "-h" || token == "--help" {
            return Ok(Command::Help);
        }
        let (name, inline) = match token.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (token.as_str(), None),
        };
        let Some(&option) = RENDER_OPTIONS.iter().find(|o| **o == name) else {
            return Err(CliError::arguments(if token.starts_with('-') {
                format!("unknown option {name} (see --help)")
            } else {
                format!("unexpected argument '{token}' (see --help)")
            }));
        };
        let value = match inline {
            Some(v) => v,
            None => {
                let v = args
                    .get(i)
                    .ok_or_else(|| CliError::arguments(format!("{option} needs a value")))?;
                i += 1;
                v.clone()
            }
        };
        if value.is_empty() {
            return Err(CliError::arguments(format!(
                "{option} needs a non-empty value"
            )));
        }
        if !REPEATED_OPTIONS.contains(&option) && values.iter().any(|(o, _)| *o == option) {
            return Err(CliError::arguments(format!(
                "{option} was given more than once"
            )));
        }
        values.push((option, value));
    }
    let mut mask_surfaces: Vec<(String, PathBuf)> = Vec::new();
    for (_, value) in values.iter().filter(|(o, _)| *o == "--mask-surface") {
        let (id, path) = parse_mask_surface(value)?;
        if mask_surfaces.iter().any(|(given, _)| *given == id) {
            return Err(CliError::arguments(format!(
                "--mask-surface {id} was given more than once"
            )));
        }
        mask_surfaces.push((id, path));
    }
    if mask_surfaces.len() > MAX_MASK_SURFACE_ARGS {
        return Err(CliError::arguments(format!(
            "at most {MAX_MASK_SURFACE_ARGS} --mask-surface"
        )));
    }
    let take = |name: &str| {
        values
            .iter()
            .find(|(o, _)| *o == name)
            .map(|(_, v)| v.clone())
    };
    let settings = take("--settings")
        .ok_or_else(|| CliError::arguments("render needs --settings <developSettings.json>"))?;
    let out = take("--out").ok_or_else(|| CliError::arguments("render needs --out <out.png>"))?;
    let max_dimension = match take("--max-dimension") {
        None => 0,
        Some(v) => v.parse::<u32>().map(|n| n as usize).map_err(|_| {
            CliError::arguments(format!(
                "--max-dimension must be 0 or a positive integer (got '{v}')"
            ))
        })?,
    };
    let source = match (take("--working-copy"), take("--raster")) {
        (Some(png), None) => {
            let meta = take("--meta")
                .ok_or_else(|| CliError::arguments("--working-copy needs --meta <meta.json>"))?;
            Source::WorkingCopy {
                png: png.into(),
                meta: meta.into(),
                base_version: take("--base-version"),
            }
        }
        (None, Some(path)) => {
            for option in ["--meta", "--base-version"] {
                if take(option).is_some() {
                    return Err(CliError::arguments(format!(
                        "{option} is only for --working-copy"
                    )));
                }
            }
            Source::Raster { path: path.into() }
        }
        (Some(_), Some(_)) => {
            return Err(CliError::arguments(
                "--working-copy and --raster cannot be used together",
            ))
        }
        (None, None) => {
            return Err(CliError::arguments(
                "render needs --working-copy <png> --meta <json> or --raster <jpeg|png>",
            ))
        }
    };
    Ok(Command::Render(RenderArgs {
        settings: settings.into(),
        out: out.into(),
        source,
        max_dimension,
        mask_surfaces,
    }))
}

/// Reads `developSettings` for rendering: `v` and `engine` must be present
/// and the ones this build renders (else `unsupported_settings`, like an
/// unknown `look`); wrong types and out-of-range values are
/// `invalid_settings`.
pub fn load_settings(text: &str) -> Result<DevelopSettings, CliError> {
    let invalid = |m: String| CliError::new(ErrorCode::InvalidSettings, m);
    let unsupported = |m: String| CliError::new(ErrorCode::UnsupportedSettings, m);
    let value: Value = serde_json::from_str(text)
        .map_err(|e| invalid(format!("developSettings is not JSON: {e}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid("developSettings must be an object".into()))?;
    let readable = READABLE_SETTINGS_VERSIONS.map(|r| r.to_string()).join(", ");
    match object.get("v") {
        Some(v)
            if v.as_f64()
                .is_some_and(|n| READABLE_SETTINGS_VERSIONS.iter().any(|&r| n == r as f64)) => {}
        Some(v) => {
            return Err(unsupported(format!(
                "developSettings v {v} is not supported (this build reads v {readable})"
            )))
        }
        None => {
            return Err(unsupported(format!(
                "developSettings has no v (this build reads v {readable})"
            )))
        }
    }
    match object.get("engine") {
        Some(Value::String(e)) if niho_develop::settings::is_known_engine(e) => {}
        Some(e) => {
            return Err(unsupported(format!(
                "developSettings engine {e} is not supported (this build renders niho-1 through niho-8 and niho-10 through niho-14)"
            )))
        }
        None => {
            return Err(unsupported(
                "developSettings has no engine (this build renders niho-1 through niho-8 and niho-10 through niho-14)".to_owned(),
            ))
        }
    }
    let settings = DevelopSettings::from_json(text).map_err(|e| {
        let message = format!("developSettings: {e}");
        match e.code.as_str() {
            "unsupportedVersion" | "unsupportedEngine" | "unsupportedLook" => unsupported(message),
            _ => invalid(message),
        }
    })?;
    let issues = settings.validate();
    if !issues.is_empty() {
        let joined: Vec<String> = issues.iter().map(|e| e.to_string()).collect();
        return Err(invalid(format!("developSettings: {}", joined.join("; "))));
    }
    Ok(settings)
}

fn read_bytes(path: &Path, what: &str) -> Result<Vec<u8>, CliError> {
    fs::read(path).map_err(|e| {
        let code = if e.kind() == std::io::ErrorKind::NotFound {
            ErrorCode::InputNotFound
        } else {
            ErrorCode::ReadFailed
        };
        CliError::new(
            code,
            format!("cannot read the {what} {}: {e}", path.display()),
        )
    })
}

/// A mask surface file: at most [`niho_develop::mask_surface::MAX_SURFACE_PNG_BYTES`]
/// + 1 bytes are read (a larger one is refused by `set_mask_surface`).
fn read_mask_surface(path: &Path) -> Result<Vec<u8>, CliError> {
    use std::io::Read;
    let failed = |e: std::io::Error| {
        let code = if e.kind() == std::io::ErrorKind::NotFound {
            ErrorCode::InputNotFound
        } else {
            ErrorCode::ReadFailed
        };
        CliError::new(
            code,
            format!("cannot read the mask surface {}: {e}", path.display()),
        )
    };
    let file = File::open(path).map_err(failed)?;
    let mut bytes = Vec::new();
    file.take(niho_develop::mask_surface::MAX_SURFACE_PNG_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(failed)?;
    Ok(bytes)
}

fn read_text(path: &Path, what: &str) -> Result<String, CliError> {
    let bytes = read_bytes(path, what)?;
    String::from_utf8(bytes).map_err(|_| {
        CliError::new(
            ErrorCode::ReadFailed,
            format!("the {what} {} is not UTF-8", path.display()),
        )
    })
}

/// The output must not replace an input or a folder.
fn check_out(args: &RenderArgs) -> Result<(), CliError> {
    let Ok(out) = fs::canonicalize(&args.out) else {
        return Ok(()); // does not exist yet
    };
    if out.is_dir() {
        return Err(CliError::arguments(format!(
            "--out {} is a folder",
            args.out.display()
        )));
    }
    let mut inputs = vec![&args.settings];
    match &args.source {
        Source::WorkingCopy { png, meta, .. } => inputs.extend([png, meta]),
        Source::Raster { path } => inputs.push(path),
    }
    inputs.extend(args.mask_surfaces.iter().map(|(_, path)| path));
    for input in inputs {
        if fs::canonicalize(input).ok().as_deref() == Some(out.as_path()) {
            return Err(CliError::arguments(format!(
                "--out {} would overwrite an input",
                args.out.display()
            )));
        }
    }
    Ok(())
}

/// The temporary file being written (removed by the panic hook as well).
static PARTIAL: Mutex<Option<PathBuf>> = Mutex::new(None);

fn set_partial(path: Option<PathBuf>) {
    if let Ok(mut guard) = PARTIAL.lock() {
        *guard = path;
    }
}

/// Prints a panic as the `internal_error` JSON line, removes a partial
/// output and exits 70 (the release profile aborts on panic otherwise).
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        if let Ok(guard) = PARTIAL.try_lock() {
            if let Some(path) = guard.as_ref() {
                let _ = fs::remove_file(path);
            }
        }
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let location = info
            .location()
            .map(|l| format!(" at {}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let line = CliError::new(ErrorCode::Internal, format!("{message}{location}")).json_line();
        let _ = writeln!(std::io::stdout(), "{line}");
        std::process::exit(ErrorCode::Internal.exit_code());
    }));
}

/// Writes RGBA8 (alpha 255) as an RGB8 PNG through a temporary file in the
/// destination folder, then renames it into place. Returns the file size.
fn write_png(out: &Path, mut rgba: Vec<u8>, width: usize, height: usize) -> Result<u64, CliError> {
    let pixels = width * height;
    for i in 0..pixels {
        rgba.copy_within(i * 4..i * 4 + 3, i * 3);
    }
    rgba.truncate(pixels * 3);
    let rgb = rgba;

    let write_failed = |e: &dyn std::fmt::Display| {
        CliError::new(
            ErrorCode::WriteFailed,
            format!("cannot write {}: {e}", out.display()),
        )
    };
    let directory = match out.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    fs::create_dir_all(&directory).map_err(|e| write_failed(&e))?;
    let name = out
        .file_name()
        .ok_or_else(|| CliError::arguments(format!("--out {} has no file name", out.display())))?;
    let temporary = directory.join(format!(
        ".{}.partial-{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    set_partial(Some(temporary.clone()));
    let result = encode_png_file(&temporary, &rgb, width, height)
        .and_then(|()| fs::rename(&temporary, out).map_err(|e| write_failed(&e)));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    set_partial(None);
    result?;
    fs::metadata(out)
        .map(|m| m.len())
        .map_err(|e| write_failed(&e))
}

fn encode_png_file(path: &Path, rgb: &[u8], width: usize, height: usize) -> Result<(), CliError> {
    let write_failed = |e: std::io::Error| {
        CliError::new(
            ErrorCode::WriteFailed,
            format!("cannot write {}: {e}", path.display()),
        )
    };
    let file = File::create(path).map_err(write_failed)?;
    let mut writer = BufWriter::with_capacity(1 << 20, file);
    PngEncoder::new(&mut writer)
        .write_image(rgb, width as u32, height as u32, ExtendedColorType::Rgb8)
        .map_err(|e| CliError::new(ErrorCode::EncodeFailed, e.to_string()))?;
    writer.flush().map_err(write_failed)
}

fn ms(duration: std::time::Duration) -> f64 {
    (duration.as_secs_f64() * 10_000.0).round() / 10.0
}

/// Renders the photo to `args.out` and returns the summary JSON.
pub fn render(args: &RenderArgs) -> Result<Value, CliError> {
    let started = Instant::now();
    let settings_text = read_text(&args.settings, "settings")?;
    let settings = load_settings(&settings_text)?;
    check_out(args)?;
    // The surface files before the (larger) source.
    let surfaces = args
        .mask_surfaces
        .iter()
        .map(|(id, path)| Ok((id, read_mask_surface(path)?)))
        .collect::<Result<Vec<_>, CliError>>()?;

    let (mut session, source_kind, source_base, render_max) = match &args.source {
        Source::WorkingCopy {
            png,
            meta,
            base_version,
        } => {
            let meta_text = read_text(meta, "working-copy metadata")?;
            let meta_value: Value = serde_json::from_str(&meta_text).map_err(|e| {
                CliError::new(
                    ErrorCode::InvalidMetadata,
                    format!("the working-copy metadata is not JSON: {e}"),
                )
            })?;
            let base = base_version
                .clone()
                .or_else(|| meta_value["baseVersion"].as_str().map(str::to_string))
                .ok_or_else(|| {
                    CliError::arguments(
                        "the working copy's baseVersion is unknown: pass --base-version <v>",
                    )
                })?;
            let bytes = read_bytes(png, "working copy")?;
            let session = Session::open_working_copy(&bytes, &meta_text, Filter::Lanczos3)?;
            (session, "workingCopy", Some(base), args.max_dimension)
        }
        Source::Raster { path } => {
            let bytes = read_bytes(path, "original")?;
            if settings.geometry.as_ref().is_some_and(|g| !g.is_identity()) {
                let (width, height) = niho_develop::frame::image_size(&bytes)?;
                let long_edge = niho_develop::raster_decode_size(
                    &settings,
                    width,
                    height,
                    args.max_dimension,
                    0,
                )?;
                let session = Session::open_raster(&bytes, long_edge, Filter::Lanczos3)?;
                (session, "raster", None, args.max_dimension)
            } else {
                let session = Session::open_raster(&bytes, args.max_dimension, Filter::Lanczos3)?;
                (session, "raster", None, 0)
            }
        }
    };
    for (id, bytes) in &surfaces {
        session.set_mask_surface(id, bytes)?;
    }
    drop(surfaces);
    let opened = started.elapsed();

    let frame = session.render(&settings, render_max, Quality::Final)?;
    drop(session);
    let rendered = started.elapsed();

    let (width, height) = (frame.width, frame.height);
    let approximations = frame.approximations.clone();
    let bytes = write_png(&args.out, frame.rgba, width, height)?;
    let total = started.elapsed();

    let settings_base = settings.base.clone();
    Ok(json!({
        "width": width,
        "height": height,
        "source": source_kind,
        "maxDimension": args.max_dimension,
        "bytes": bytes,
        "engine": settings.engine,
        "version": niho_develop::CRATE_VERSION,
        "settingsBase": settings_base,
        "sourceBase": source_base,
        "baseMismatch": settings_base != source_base,
        "approximations": approximations,
        "decodeMs": ms(opened),
        "renderMs": ms(rendered - opened),
        "encodeMs": ms(total - rendered),
        "totalMs": ms(total),
    }))
}

/// Runs a command line (without the program name), prints the stdout line
/// and returns the exit code.
pub fn run(args: &[String]) -> i32 {
    let outcome = parse(args).and_then(|command| match command {
        Command::Help => {
            print!("{USAGE}");
            Ok(None)
        }
        Command::Version => {
            println!("{}", version_line());
            Ok(None)
        }
        Command::Render(render_args) => render(&render_args).map(Some),
    });
    match outcome {
        Ok(Some(summary)) => {
            println!("{summary}");
            0
        }
        Ok(None) => 0,
        Err(e) => {
            println!("{}", e.json_line());
            e.code.exit_code()
        }
    }
}
