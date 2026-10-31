//! The develop engine's calls as the browser's wasm (`niho-develop-wasm`)
//! and the Mac's native sidecar (`niho-develop-render serve`, #152) export
//! them: one target-independent function per export, and [`Developer`] for
//! the `Developer` class, taking the export's arguments and returning its
//! result as plain values. The two wrappers only convert the arguments and
//! the results (JS objects, sidecar frames), so they give the same pixels,
//! bytes, JSON text and error messages. An error is its message (the text
//! of the wasm's `JsError`).
//!
//! Stateless: [`render`] (`render(inputBytes, settingsJson, maxDimension,
//! decodeCap?)`) gives a frame and [`export_jpeg`] JPEG bytes;
//! [`with_capture_exif`] gives an exported JPEG the capture date
//! (orientation 1, sRGB; no location or camera). Stateful:
//! [`Developer::new`] decodes once and [`Developer::render`] reuses the
//! decode, the adaptive statistics and the previous frame's cubes.
//! A geometry (`v: 2`) renders the turned / straightened / cropped frame:
//! [`raster_decode_size`] gives the working size a Developer needs for the
//! crop, [`geometry_output_size`] the frame's size without rendering.
//! [`Developer::auto_settings`] is "自動" (the six Light sliders and
//! Vibrance for this photo). [`Developer::prepare_analysis`] makes response
//! analysis ahead, and the export / import calls move it between workers.
//! Local masks (`masks`, v 5) render through the same `render` calls;
//! [`capabilities`] says which kinds this build draws and
//! [`Developer::mask_plane`] gives one mask's plane for the editor's
//! overlay. A Developer holds the surfaces of `brush` / `subject` / `sky`
//! masks, and its JPEG / PNG exports use those surfaces.
//! [`Developer::estimate_upright`] estimates Upright (the
//! perspective that stands its lines upright). [`Developer::detect_sky`]
//! makes a `sky` mask's surface with the sky model [`set_sky_model`] gave
//! the process (niho-photo#141). Heal marks
//! (`developSettings.heal`, v 8) render through `render` and
//! [`Developer::render`] like any other setting; a Developer keeps their
//! plans across frames. The lens corrections (`developSettings.lens`, v 9)
//! do too; a Developer estimates the photo's chromatic aberration once.

use std::sync::{Arc, Mutex, PoisonError};

use crate::sky::SkyModel;
use crate::upright::UprightMode;
use crate::{
    convert, exif, frame, xmp, DevelopSettings, Filter, LightroomWhite, Quality, RenderOptions,
    Rendered, Session, WorkingCopyMeta,
};

fn message(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// A width and a height in pixels (`imageSize`, `geometryOutputSize`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

impl Size {
    fn of(width: usize, height: usize) -> Self {
        Self {
            width: width as u32,
            height: height as u32,
        }
    }
}

/// One local mask's plane ([`Developer::mask_plane`]): `width * height`
/// values, row-major.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaskPlane {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// A color sampled by [`Developer::sample_color`] (the color points'
/// lightness, chroma and hue).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SampledColor {
    pub lightness: f64,
    pub chroma: f64,
    pub hue: f64,
}

/// One-shot options: a released (Final) frame; `decode_cap` (omitted:
/// 4096) caps the decode of an original whose crop needs more than
/// `max_dimension`.
fn options(max_dimension: u32, decode_cap: Option<u32>) -> RenderOptions {
    RenderOptions {
        max_dimension: max_dimension as usize,
        quality: Quality::Final,
        filter: Filter::Lanczos3,
        decode_cap: decode_cap.map_or(frame::DEFAULT_DECODE_CAP, |c| c as usize),
    }
}

/// `niho-develop <crate version> (engine <ENGINE_VERSION>)`.
pub fn version() -> String {
    format!(
        "niho-develop {} (engine {})",
        crate::CRATE_VERSION,
        crate::ENGINE_VERSION
    )
}

/// The native render pool size reported by `serve.hello`.
pub fn thread_count() -> usize {
    #[cfg(feature = "threads")]
    {
        rayon::current_num_threads()
    }
    #[cfg(not(feature = "threads"))]
    {
        1
    }
}

/// What this build draws beyond what [`validate_settings`] reads, as JSON:
/// `{"masks":{"kinds":["linear","radial","brush","subject","sky"],
/// "max":8,"maskPlane":true,"surfaces":true,"skyDetection":true}}` — local
/// masks of those kinds render, at most `max` of them, `Developer.maskPlane`
/// exists, a Developer holds surfaces for `brush` / `subject` / `sky`
/// masks, and `skyDetection`: [`Developer::detect_sky`] makes a `sky`
/// mask's surface once [`set_sky_model`] gave a model.
pub fn capabilities() -> String {
    serde_json::json!({
        "masks": {
            "kinds": ["linear", "radial", "brush", "subject", "sky"],
            "max": crate::settings::MAX_LOCAL_MASKS,
            "maskPlane": true,
            "surfaces": true,
            "skyDetection": true,
        }
    })
    .to_string()
}

/// The sky model of [`Developer::detect_sky`], one for the process (every
/// Developer, every client of the sidecar).
static SKY_MODEL: Mutex<Option<Arc<SkyModel>>> = Mutex::new(None);

/// Gives the process the sky model (niho-photo#141,
/// [`crate::sky::SkyModel::parse`]: `layout_json` is `train_sky.py
/// export`'s `layout.json`, `weights` its `weights.f32`), replacing the one
/// it had. Returns `{"long", "inputs", "channels"}` of the model as JSON.
/// A model it cannot read is an error and leaves the one it had.
pub fn set_sky_model(layout_json: &str, weights: &[u8]) -> Result<String, String> {
    let model = SkyModel::parse(layout_json, weights)?;
    let description = serde_json::json!({
        "long": model.long_side(),
        "inputs": model.inputs().name(),
        "channels": model.widths(),
    })
    .to_string();
    *SKY_MODEL.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(model));
    Ok(description)
}

fn sky_model() -> Option<Arc<SkyModel>> {
    SKY_MODEL
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// Long side of the working image [`Developer::detect_sky`] finds the sky
/// on, and of the surface it makes (a smaller photo keeps its size).
pub const SKY_SURFACE_LONG_EDGE: u32 = 1024;

/// The settings a working image renders with, the frame mask surfaces are
/// made on: `"v": 1` with only these settings' `engine`, `look` and `base`
/// (no adjustments, geometry, lens corrections, heal marks or masks; as the
/// Mac's `mask_detection::working_image_settings`). Settings without an
/// `engine` are an error.
fn working_image_settings(settings_json: &str) -> Result<DevelopSettings, String> {
    use serde_json::Value;
    let given: Value = serde_json::from_str(settings_json).map_err(message)?;
    let engine = given
        .get("engine")
        .and_then(Value::as_str)
        .ok_or_else(|| "settings have no engine".to_string())?;
    let mut settings = serde_json::json!({ "v": 1, "engine": engine });
    if let Some(look) = given.get("look").and_then(Value::as_str) {
        settings["look"] = serde_json::json!(look);
    }
    if let Some(base) = given.get("base") {
        settings["base"] = base.clone();
    }
    crate::parse_settings(&settings.to_string()).map_err(message)
}

/// A `sky` mask's surface [`Developer::detect_sky`] made: the PNG
/// ([`encode_mask_surface`]'s bytes, [`mask_surface_id`] names it) and its
/// size (the working image's).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedSky {
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
}

/// The id of a mask surface PNG: the sha256 of its bytes (64 lowercase hex
/// digits, the `surface.id` of the settings).
pub fn mask_surface_id(png: &[u8]) -> String {
    crate::mask_surface::surface_id(png)
}

/// A mask surface PNG of `data` (`width * height` values 0..=255, row-major;
/// 1..=4096 per side): non-interlaced 8-bit grayscale, the bytes
/// [`Developer::set_mask_surface`] takes.
pub fn encode_mask_surface(width: u32, height: u32, data: &[u8]) -> Result<Vec<u8>, String> {
    let surface = crate::mask_surface::MaskSurface::new(width, height, data.to_vec())
        .map_err(|reason| format!("{}: {reason}", crate::MASK_SURFACE_INVALID))?;
    crate::mask_surface::encode_surface_png(&surface).map_err(message)
}

/// Renders a JPEG / PNG original (`rgba` is sRGB 8-bit, ready for
/// `new ImageData(rgba, width, height)`). With a geometry the original is
/// decoded large enough for the crop to reach `max_dimension`, up to
/// `decode_cap` (`None`: 4096; 0: no cap).
pub fn render(
    input_bytes: &[u8],
    settings_json: &str,
    max_dimension: u32,
    decode_cap: Option<u32>,
) -> Result<Rendered, String> {
    crate::render(
        input_bytes,
        settings_json,
        &options(max_dimension, decode_cap),
    )
    .map_err(message)
}

/// Renders and encodes a JPEG (`quality` 1..100; `decode_cap` as
/// [`render`]).
pub fn export_jpeg(
    input_bytes: &[u8],
    settings_json: &str,
    max_dimension: u32,
    quality: u8,
    decode_cap: Option<u32>,
) -> Result<Vec<u8>, String> {
    crate::export_jpeg(
        input_bytes,
        settings_json,
        &options(max_dimension, decode_cap),
        quality,
    )
    .map_err(message)
}

/// Renders and encodes a PNG (`decode_cap` as [`render`]).
pub fn export_png(
    input_bytes: &[u8],
    settings_json: &str,
    max_dimension: u32,
    decode_cap: Option<u32>,
) -> Result<Vec<u8>, String> {
    crate::export_png(
        input_bytes,
        settings_json,
        &options(max_dimension, decode_cap),
    )
    .map_err(message)
}

/// The JPEG of an export with the EXIF NIHO writes (F7a #17143): the
/// capture date and time, orientation 1 and sRGB; no location or camera,
/// any earlier EXIF removed. `captured_at` is the photo's `capturedAt`
/// (ISO 8601, e.g. `2026-09-17T02:12:59.000Z`), shown at `offset_minutes`
/// from UTC (Japan: 540); absent, the JPEG gets no EXIF. Works on
/// [`export_jpeg`]'s output and on a canvas-encoded JPEG alike.
pub fn with_capture_exif(
    jpeg_bytes: &[u8],
    captured_at: Option<&str>,
    offset_minutes: i32,
) -> Result<Vec<u8>, String> {
    let capture = captured_at
        .map(|iso| exif::CaptureTime::from_iso(iso, offset_minutes))
        .transpose()
        .map_err(message)?;
    exif::with_capture_exif(jpeg_bytes, capture.as_ref()).map_err(message)
}

/// "補正前": the settings with the color adjustments back to neutral,
/// keeping `v`, `engine`, `look`, `base` and `geometry` (the same cropped
/// frame with the original's colors).
pub fn before_settings(settings_json: &str) -> Result<String, String> {
    crate::before_settings(settings_json).map_err(message)
}

/// A JPEG / PNG's size with its EXIF orientation applied, from the header
/// only.
pub fn image_size(input_bytes: &[u8]) -> Result<Size, String> {
    let (width, height) = frame::image_size(input_bytes).map_err(message)?;
    Ok(Size::of(width, height))
}

/// The working size to open a [`Developer`] of a `width x height` original
/// at ([`image_size`]) so these settings' crop reaches `max_dimension`:
/// `min(cap, long edge, ceil(long edge * max_dimension / crop long edge))`
/// (`max_dimension` 0: the original's size; `cap` 0: no cap; without a
/// geometry the crop is the whole photo).
pub fn raster_decode_size(
    settings_json: &str,
    width: u32,
    height: u32,
    max_dimension: u32,
    cap: u32,
) -> Result<u32, String> {
    let settings = crate::parse_settings(settings_json).map_err(message)?;
    let size = crate::raster_decode_size(
        &settings,
        width as usize,
        height as usize,
        max_dimension as usize,
        cap as usize,
    )
    .map_err(message)?;
    Ok(size as u32)
}

/// The size these settings render at from a `source_width x
/// source_height` source (a Developer's `width` / `height`) at
/// `max_dimension`, without rendering.
pub fn geometry_output_size(
    settings_json: &str,
    source_width: u32,
    source_height: u32,
    max_dimension: u32,
) -> Result<Size, String> {
    let settings = crate::parse_settings(settings_json).map_err(message)?;
    let (width, height) = crate::output_size(
        &settings,
        source_width as usize,
        source_height as usize,
        max_dimension as usize,
    )
    .map_err(message)?;
    Ok(Size::of(width, height))
}

/// Initial `developSettings` v1 for a new edit ("初期化" saves this).
pub fn neutral_settings() -> String {
    DevelopSettings::new_edit().to_json()
}

/// Validation problems of a `developSettings` JSON as a JSON array of
/// `{ path, code, message }` (`[]` when valid).
pub fn validate_settings(settings_json: &str) -> String {
    let issues: Vec<serde_json::Value> = match DevelopSettings::from_json(settings_json) {
        Err(e) => vec![serde_json::json!({"path": e.path, "code": e.code, "message": e.message})],
        Ok(s) => s
            .validate()
            .into_iter()
            .map(|e| serde_json::json!({"path": e.path, "code": e.code, "message": e.message}))
            .collect(),
    };
    serde_json::Value::from(issues).to_string()
}

/// Bundled presets: `[{ id, name, xmp }]` JSON.
pub fn builtin_presets() -> String {
    let list: Vec<serde_json::Value> = xmp::BUILTIN_PRESETS
        .iter()
        .map(|p| serde_json::json!({"id": p.id, "name": p.name, "xmp": p.xmp}))
        .collect();
    serde_json::Value::from(list).to_string()
}

/// XMP preset on `base_json` (neutral when absent): `{ name, settings,
/// unsupported, approximate, items, converted, convertIssues, ..., masks }`
/// JSON. `masks` are the preset's Lightroom masks in the coordinates of
/// the photo's visible frame (`xmp::PresetResult::masks`; `settings.masks`
/// stay the base's).
pub fn preset_settings(xmp_text: &str, base_json: Option<&str>) -> Result<String, String> {
    let base = match base_json {
        Some(text) => Some(DevelopSettings::from_json(text).map_err(message)?),
        None => None,
    };
    let result = xmp::preset_settings(xmp_text, base.as_ref()).map_err(message)?;
    Ok(result.to_value().to_string())
}

/// `{"temperature","tint"}` JSON of a white on Lightroom's scale, `null`
/// without one.
fn white_json(white: Option<LightroomWhite>) -> String {
    match white {
        Some(w) => serde_json::json!({"temperature": w.temperature, "tint": w.tint}).to_string(),
        None => "null".into(),
    }
}

/// Reads `{"temperature","tint"}` (absent or `null`: none).
fn parse_white(json: Option<&str>) -> Result<Option<LightroomWhite>, String> {
    let Some(text) = json else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(text).map_err(message)?;
    if value.is_null() {
        return Ok(None);
    }
    let number = |key: &str| value.get(key).and_then(serde_json::Value::as_f64);
    match (number("temperature"), number("tint")) {
        (Some(temperature), Some(tint)) => LightroomWhite::new(temperature, tint)
            .map(Some)
            .ok_or_else(|| "asShot: temperature must be positive and tint finite".to_string()),
        _ => Err("asShot must be {\"temperature\", \"tint\"} or null".to_string()),
    }
}

/// XMP preset on `base_json` at `amount` (0..1.5 = 0..150%; 0 is the base,
/// 1 the whole preset): [`preset_settings`]' result with `amount`.
/// `as_shot_json` is the photo's as-shot white ([`as_shot_white_from_meta`]
/// / [`Developer::as_shot_white`], `null` for a JPEG / PNG): an absolute
/// white moves from it in mireds.
pub fn apply_preset(
    xmp_text: &str,
    base_json: &str,
    amount: f64,
    as_shot_json: Option<&str>,
) -> Result<String, String> {
    let base = DevelopSettings::from_json(base_json).map_err(message)?;
    let as_shot = parse_white(as_shot_json)?;
    let result = xmp::apply_preset(xmp_text, &base, amount, as_shot).map_err(message)?;
    Ok(result.to_value().to_string())
}

/// `developSettings` as a Lightroom XMP preset: `{ xmp, notWritten }`
/// JSON. `options_json`: `{ name?, uuid?, groups? }` (groups: `exposure`,
/// `whiteBalance`, `tone`, `presence`, `toneCurve`, `hsl`, `colorGrading`,
/// `calibration`, `blackAndWhite`, `vignette`, `grain`, `noiseReduction`;
/// noise reduction is written only for NIHO 3; the default leaves
/// out `exposure` and `whiteBalance`).
pub fn settings_to_xmp(settings_json: &str, options_json: Option<&str>) -> Result<String, String> {
    let settings = DevelopSettings::from_json(settings_json).map_err(message)?;
    let options = match options_json {
        Some(text) => {
            let value: serde_json::Value = serde_json::from_str(text).map_err(message)?;
            xmp::XmpWriteOptions::from_value(&value).map_err(message)?
        }
        None => xmp::XmpWriteOptions::default(),
    };
    Ok(xmp::settings_to_xmp(&settings, &options)
        .to_value()
        .to_string())
}

/// The as-shot white of a working copy's metadata JSON on Lightroom's
/// scale: `{ temperature, tint }` JSON, `null` when it has none (a non-RAW
/// working copy, or no K / tint recorded). For applying a preset without
/// opening the working copy.
pub fn as_shot_white_from_meta(meta_json: &str) -> Result<String, String> {
    let meta = WorkingCopyMeta::from_json(meta_json).map_err(message)?;
    Ok(white_json(meta.lightroom_as_shot_white()))
}

/// Photo Bench `EditSettings` JSON -> `{ converter, ok, settings, issues,
/// notes }` JSON.
pub fn convert_edit_settings(
    edit_settings_json: &str,
    base_version: Option<&str>,
) -> Result<String, String> {
    let outcome =
        convert::convert_edit_settings_json(edit_settings_json, base_version).map_err(message)?;
    let issues = |list: &[convert::ConvertIssue]| -> Vec<serde_json::Value> {
        list.iter()
            .map(|i| serde_json::json!({"path": i.path, "code": i.code, "message": i.message}))
            .collect()
    };
    Ok(serde_json::json!({
        "converter": outcome.converter,
        "ok": outcome.ok,
        "settings": outcome.settings.to_value(),
        "issues": issues(&outcome.issues),
        "notes": issues(&outcome.notes),
    })
    .to_string())
}

/// A decoded photo kept across renders (slider drags).
pub struct Developer {
    session: Session,
}

impl Developer {
    /// Decodes a JPEG / PNG original, reduced to `working_max_dimension`
    /// (0 = original size; 2560 matches the working copies).
    pub fn new(input_bytes: &[u8], working_max_dimension: u32) -> Result<Self, String> {
        let session = Session::open_raster(
            input_bytes,
            working_max_dimension as usize,
            Filter::Lanczos3,
        )
        .map_err(message)?;
        Ok(Self { session })
    }

    /// Opens a working copy (16-bit PNG) with its metadata JSON.
    pub fn open_working_copy(png: &[u8], meta_json: &str) -> Result<Self, String> {
        let session =
            Session::open_working_copy(png, meta_json, Filter::Lanczos3).map_err(message)?;
        Ok(Self { session })
    }

    /// The working image's width (the `sourceWidth` of
    /// [`geometry_output_size`]).
    pub fn width(&self) -> u32 {
        self.session.source_size().0 as u32
    }

    /// The working image's height.
    pub fn height(&self) -> u32 {
        self.session.source_size().1 as u32
    }

    /// The photo's as-shot white on Lightroom's scale: `{ temperature, tint }`
    /// JSON, `null` for a JPEG / PNG (the `as_shot_json` of [`apply_preset`]).
    pub fn as_shot_white(&self) -> String {
        white_json(self.session.as_shot_white())
    }

    /// A separate `Developer` for preset previews at a long side of
    /// `max_dimension` (at most 512; 0 = 512) without decoding again. Signed
    /// NIHO 3 sources retain their full master internally for canonical
    /// analysis. Rendering leaves this one's next drag frame as it was.
    /// Render it with `max_dimension` 0 (its own size).
    pub fn thumbnail(&self, max_dimension: u32) -> Self {
        Self {
            session: self.session.thumbnail(max_dimension as usize),
        }
    }

    /// `interactive`: drag frames (Shadows nDisc 5, statistics at 375px,
    /// 33^3 tone cube); release with `false` for the exact frame.
    pub fn render(
        &mut self,
        settings_json: &str,
        max_dimension: u32,
        interactive: bool,
    ) -> Result<Rendered, String> {
        let settings = crate::parse_settings(settings_json).map_err(message)?;
        let quality = if interactive {
            Quality::Interactive
        } else {
            Quality::Final
        };
        self.session
            .render(&settings, max_dimension as usize, quality)
            .map_err(message)
    }

    /// Makes ahead, while the editor is idle, the response analysis frames
    /// these settings read once they use Highlights or Shadows. `false`
    /// means there is nothing to make ahead for this photo and engine.
    pub fn prepare_analysis(&mut self, settings_json: &str) -> Result<bool, String> {
        let settings = crate::parse_settings(settings_json).map_err(message)?;
        self.session.prepare_analysis(&settings).map_err(message)
    }

    /// Drops analysis made ahead for other settings. Rendered bytes do not
    /// change.
    pub fn release_analysis_ahead(&mut self) {
        self.session.release_analysis_ahead();
    }

    /// Makes the analysis [`Developer::prepare_analysis`] makes and returns
    /// its versioned bytes. `None` means there is nothing to make ahead.
    pub fn export_analysis(&mut self, settings_json: &str) -> Result<Option<Vec<u8>>, String> {
        let settings = crate::parse_settings(settings_json).map_err(message)?;
        self.session.export_analysis(&settings).map_err(message)
    }

    /// Whether this Developer already holds all analysis needed by these
    /// settings. `false` also means there is nothing to make ahead.
    pub fn holds_analysis(&self, settings_json: &str) -> Result<bool, String> {
        let settings = crate::parse_settings(settings_json).map_err(message)?;
        Ok(self.session.holds_analysis(&settings))
    }

    /// Takes in bytes returned by [`Developer::export_analysis`]. `false`
    /// means this Developer already held all of it.
    pub fn import_analysis(&mut self, bytes: &[u8]) -> Result<bool, String> {
        self.session.import_analysis(bytes).map_err(message)
    }

    /// Holds a `brush` / `subject` / `sky` mask surface for later render,
    /// mask-plane and export calls.
    pub fn set_mask_surface(&mut self, id: &str, png: &[u8]) -> Result<(), String> {
        self.session.set_mask_surface(id, png).map_err(message)
    }

    /// Drops surface `id`; `true` when it was held.
    pub fn drop_mask_surface(&mut self, id: &str) -> bool {
        self.session.drop_mask_surface(id)
    }

    /// Whether surface `id` is held.
    pub fn has_mask_surface(&self, id: &str) -> bool {
        self.session.has_mask_surface(id)
    }

    /// The released frame, with this Developer's surfaces, as a JPEG.
    pub fn export_jpeg(
        &mut self,
        settings_json: &str,
        max_dimension: u32,
        quality: u8,
    ) -> Result<Vec<u8>, String> {
        let settings = crate::parse_settings(settings_json).map_err(message)?;
        self.session
            .export_jpeg(&settings, max_dimension as usize, quality)
            .map_err(message)
    }

    /// The released frame, with this Developer's surfaces, as a PNG.
    pub fn export_png(
        &mut self,
        settings_json: &str,
        max_dimension: u32,
    ) -> Result<Vec<u8>, String> {
        let settings = crate::parse_settings(settings_json).map_err(message)?;
        self.session
            .export_png(&settings, max_dimension as usize)
            .map_err(message)
    }

    /// One local mask's plane for the editor's overlay: `width * height`
    /// values (`round(weight / 65536 * 255)`, row-major, the mask's
    /// `invert` applied, drawn whether or not it is enabled) at the size
    /// [`Developer::render`] gives these settings at `max_dimension`, from
    /// the same map and plane as the render. Leaves the drag frames' kept
    /// state as it was. A `brush` / `subject` / `sky` mask fails with
    /// `maskSurfaceMissing`, an id the settings do not have with
    /// `maskNotFound`.
    pub fn mask_plane(
        &self,
        settings_json: &str,
        mask_id: &str,
        max_dimension: u32,
    ) -> Result<MaskPlane, String> {
        let settings = crate::parse_settings(settings_json).map_err(message)?;
        let (width, height, data) = self
            .session
            .mask_plane(&settings, mask_id, max_dimension as usize)
            .map_err(message)?;
        let size = Size::of(width, height);
        Ok(MaskPlane {
            width: size.width,
            height: size.height,
            data,
        })
    }

    /// Samples Stage Q after hue stabilization and before color points /
    /// Color Grading at normalized rendered-frame coordinates.
    pub fn sample_color(
        &mut self,
        settings_json: &str,
        max_dimension: u32,
        x: f64,
        y: f64,
    ) -> Result<SampledColor, String> {
        let settings = crate::parse_settings(settings_json).map_err(message)?;
        let [lightness, chroma, hue] = self
            .session
            .sample_color(&settings, max_dimension as usize, x, y)
            .map_err(message)?;
        Ok(SampledColor {
            lightness,
            chroma,
            hue,
        })
    }

    /// "自動": these settings with the six Light sliders and Vibrance set
    /// for this photo (within its crop), as a `developSettings` JSON; every
    /// other key keeps the text it was given. The frames' kept state is
    /// left as it was.
    pub fn auto_settings(&mut self, settings_json: &str) -> Result<String, String> {
        let settings = crate::parse_settings(settings_json).map_err(message)?;
        let result = self.session.auto_settings(&settings).map_err(message)?;
        crate::auto::write_changes(settings_json, &settings, &result).map_err(message)
    }

    /// Upright (niho-photo#46): the perspective that stands this photo's
    /// lines upright, found on the frame of these settings' quarter turns
    /// and flips (their straighten angle taken off). `mode`: 1 auto, 2
    /// level, 3 vertical, 4 full. Returns `{ perspective: { vertical,
    /// horizontal, rotate, aspect, scale, x, y }, mode, confidence, lines:
    /// { vertical, horizontal }, reason? }` JSON (`reason` "noLines": the
    /// identity, nothing to correct). The frames' kept state is left as it
    /// was.
    pub fn estimate_upright(&self, settings_json: &str, mode: u32) -> Result<String, String> {
        let settings = crate::parse_settings(settings_json).map_err(message)?;
        let mode = UprightMode::from_number(mode).ok_or_else(|| {
            "mode must be 1 (auto), 2 (level), 3 (vertical) or 4 (full)".to_string()
        })?;
        Ok(self
            .session
            .estimate_upright(&settings, mode)
            .to_value()
            .to_string())
    }

    /// "空" (niho-photo#141, `docs/local-adjustments.md` "空の検出"): this
    /// photo's sky as a `sky` mask's surface, found by the process's sky
    /// model ([`set_sky_model`], [`crate::sky::estimate_sky`]) on the
    /// working image: the frame mask coordinates live in (no geometry, no
    /// masks), rendered released with only these settings' `engine`, `look`
    /// and `base` ([`working_image_settings`]) at a long side of
    /// [`SKY_SURFACE_LONG_EDGE`]. `ev100` is the capture's exposure at ISO
    /// 100, `None` when unknown (a model of `"rgb"` inputs does not read
    /// it). `None` without sky. Fails with `skyModelMissing` before a model
    /// is set, and on settings without an `engine`. The render touches the
    /// drag frames' kept state like any other render (the next frame of the
    /// photo's own settings renders afresh).
    pub fn detect_sky(
        &mut self,
        settings_json: &str,
        ev100: Option<f64>,
    ) -> Result<Option<DetectedSky>, String> {
        let model = sky_model().ok_or_else(|| {
            format!(
                "{}: no sky model is set (setSkyModel)",
                crate::SKY_MODEL_MISSING
            )
        })?;
        let settings = working_image_settings(settings_json)?;
        let frame = self
            .session
            .render(&settings, SKY_SURFACE_LONG_EDGE as usize, Quality::Final)
            .map_err(message)?;
        let rgb: Vec<u8> = frame
            .rgba
            .chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect();
        let Some(sky) = crate::sky::estimate_sky(&model, &rgb, frame.width, frame.height, ev100)
        else {
            return Ok(None);
        };
        let (width, height) = (sky.width, sky.height);
        let png = encode_mask_surface(width, height, &sky.data)?;
        Ok(Some(DetectedSky { width, height, png }))
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_white, white_json, Developer};

    #[test]
    fn whites_read_and_write_lightrooms_scale() {
        assert_eq!(parse_white(None).unwrap(), None);
        assert_eq!(parse_white(Some("null")).unwrap(), None);
        let white = parse_white(Some(r#"{"temperature":5400,"tint":4}"#))
            .unwrap()
            .unwrap();
        assert_eq!((white.temperature, white.tint), (5400.0, 4.0));
        assert_eq!(
            white_json(Some(white)),
            r#"{"temperature":5400.0,"tint":4.0}"#
        );
        assert_eq!(white_json(None), "null");
        assert_eq!(
            parse_white(Some(r#"{"temperature":-1,"tint":0}"#)).unwrap_err(),
            "asShot: temperature must be positive and tint finite"
        );
        assert_eq!(
            parse_white(Some(r#"{"temperature":5000}"#)).unwrap_err(),
            "asShot must be {\"temperature\", \"tint\"} or null"
        );
        assert!(parse_white(Some("{")).is_err());
    }

    /// The errors are the messages the wasm's `JsError` carried.
    #[test]
    fn errors_are_the_engines_messages() {
        let error = Developer::new(b"not an image", 0).err().unwrap();
        assert!(!error.is_empty());
        let png = crate::encode::encode_png(&[128u8, 128, 128, 255].repeat(16), 4, 4).unwrap();
        let developer = Developer::new(&png, 0).unwrap();
        assert_eq!((developer.width(), developer.height()), (4, 4));
        assert_eq!(developer.as_shot_white(), "null");
        assert_eq!(
            developer.estimate_upright("{}", 9).unwrap_err(),
            "mode must be 1 (auto), 2 (level), 3 (vertical) or 4 (full)"
        );
        let unreadable = developer.estimate_upright("{", 1).unwrap_err();
        assert_eq!(
            unreadable,
            crate::parse_settings("{").err().unwrap().to_string()
        );
    }
}
