//! Browser (Web Worker) bindings of `niho-develop` via `wasm-bindgen`.
//!
//! Stateless: `render(inputBytes, settingsJson, maxDimension, decodeCap?)`
//! -> `{ width, height, rgba }` and `exportJpeg(...)` -> JPEG bytes.
//! `withCaptureExif(jpeg, capturedAt, offsetMinutes)` gives an exported JPEG
//! the capture date (orientation 1, sRGB; no location or camera).
//! Stateful: `new Developer(inputBytes, workingMaxDimension)` decodes once;
//! `developer.render(settingsJson, maxDimension, interactive)` reuses the
//! decode, the adaptive statistics and the previous frame's cubes.
//! A geometry (`v: 2`) renders the turned / straightened / cropped frame:
//! `rasterDecodeSize` gives the working size a Developer needs for the
//! crop, `geometryOutputSize` the frame's size without rendering.
//! `developer.autoSettings(settingsJson)` is "自動" (the six Light sliders
//! and Vibrance for this photo). `developer.prepareAnalysis(settingsJson)`
//! makes ahead, while idle, the response analysis a preset's first frame
//! would wait for (#129); `developer.exportAnalysis(settingsJson)` makes it
//! as versioned bytes in a helper worker and `developer.importAnalysis(bytes)`
//! takes them in (#155).
//! Local masks (`masks`, v 5) render through the same `render` calls;
//! `capabilities()` says which kinds this build draws and
//! `developer.maskPlane(settingsJson, maskId, maxDimension)` gives one
//! mask's plane for the editor's overlay. `developer.estimateUpright(settingsJson,
//! mode)` estimates Upright (the perspective that stands its lines upright).
//! Heal marks (`developSettings.heal`, v 8) render through `render` and
//! `developer.render` like any other setting; the Developer keeps their plans
//! across frames. The lens corrections (`developSettings.lens`, v 9) do too;
//! the Developer estimates the photo's chromatic aberration once.
//! Everything runs single threaded (no SharedArrayBuffer, spec "段 2").

use js_sys::{Object, Reflect, Uint8ClampedArray};
use niho_develop::upright::UprightMode;
use niho_develop::{
    convert, frame, pipeline, xmp, DevelopSettings, Filter, LightroomWhite, Quality, RenderOptions,
    Session, WorkingCopyMeta,
};
use wasm_bindgen::prelude::*;

fn js_error(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn frame_object(frame: &pipeline::Rendered) -> Result<Object, JsError> {
    let o = Object::new();
    let set = |k: &str, v: &JsValue| {
        Reflect::set(&o, &JsValue::from_str(k), v)
            .map(|_| ())
            .map_err(|_| JsError::new("set"))
    };
    set("width", &JsValue::from(frame.width as u32))?;
    set("height", &JsValue::from(frame.height as u32))?;
    set("rgba", &Uint8ClampedArray::from(&frame.rgba[..]).into())?;
    let approximations = js_sys::Array::new();
    for a in &frame.approximations {
        approximations.push(&JsValue::from_str(a));
    }
    set("approximations", &approximations.into())?;
    Ok(o)
}

fn size_object(width: usize, height: usize) -> Result<Object, JsError> {
    let o = Object::new();
    for (k, v) in [("width", width), ("height", height)] {
        Reflect::set(&o, &JsValue::from_str(k), &JsValue::from(v as u32))
            .map_err(|_| JsError::new("set"))?;
    }
    Ok(o)
}

fn sampled_color_object(color: [f64; 3]) -> Result<Object, JsError> {
    let o = Object::new();
    for (key, value) in [
        ("lightness", color[0]),
        ("chroma", color[1]),
        ("hue", color[2]),
    ] {
        Reflect::set(&o, &JsValue::from_str(key), &JsValue::from_f64(value))
            .map_err(|_| JsError::new("set"))?;
    }
    Ok(o)
}

/// One-shot options; `decode_cap` (omitted: 4096) caps the decode of an
/// original whose crop needs more than `max_dimension`.
fn options(max_dimension: u32, interactive: bool, decode_cap: Option<u32>) -> RenderOptions {
    RenderOptions {
        max_dimension: max_dimension as usize,
        quality: if interactive {
            Quality::Interactive
        } else {
            Quality::Final
        },
        filter: Filter::Lanczos3,
        decode_cap: decode_cap.map_or(frame::DEFAULT_DECODE_CAP, |c| c as usize),
    }
}

/// `niho-develop <crate version> (engine niho-1)`.
#[wasm_bindgen]
pub fn version() -> String {
    format!(
        "niho-develop {} (engine {})",
        niho_develop::CRATE_VERSION,
        niho_develop::ENGINE_VERSION
    )
}

/// What this build draws beyond what `validateSettings` reads, as JSON:
/// `{"masks":{"kinds":["linear","radial"],"max":8,"maskPlane":true}}` —
/// local masks of those kinds render (`brush` / `subject` / `sky` need a
/// surface store and fail with `maskSurfaceMissing`), at most `max` of them,
/// and `Developer.maskPlane` exists. A build without this export draws no
/// masks (it may still validate them).
#[wasm_bindgen]
pub fn capabilities() -> String {
    serde_json::json!({
        "masks": {
            "kinds": ["linear", "radial"],
            "max": niho_develop::settings::MAX_LOCAL_MASKS,
            "maskPlane": true,
        }
    })
    .to_string()
}

/// Renders a JPEG / PNG original: `{ width, height, rgba, approximations }`
/// (`rgba` is sRGB 8-bit, ready for `new ImageData(rgba, width, height)`).
/// With a geometry the original is decoded large enough for the crop to
/// reach `maxDimension`, up to `decodeCap` (omitted: 4096; 0: no cap).
#[wasm_bindgen]
pub fn render(
    input_bytes: &[u8],
    settings_json: &str,
    max_dimension: u32,
    decode_cap: Option<u32>,
) -> Result<Object, JsError> {
    let frame = niho_develop::render(
        input_bytes,
        settings_json,
        &options(max_dimension, false, decode_cap),
    )
    .map_err(js_error)?;
    frame_object(&frame)
}

/// Renders and encodes a JPEG (`quality` 1..100; `decodeCap` as `render`).
#[wasm_bindgen(js_name = exportJpeg)]
pub fn export_jpeg(
    input_bytes: &[u8],
    settings_json: &str,
    max_dimension: u32,
    quality: u8,
    decode_cap: Option<u32>,
) -> Result<Vec<u8>, JsError> {
    niho_develop::export_jpeg(
        input_bytes,
        settings_json,
        &options(max_dimension, false, decode_cap),
        quality,
    )
    .map_err(js_error)
}

/// Renders and encodes a PNG (`decodeCap` as `render`).
#[wasm_bindgen(js_name = exportPng)]
pub fn export_png(
    input_bytes: &[u8],
    settings_json: &str,
    max_dimension: u32,
    decode_cap: Option<u32>,
) -> Result<Vec<u8>, JsError> {
    niho_develop::export_png(
        input_bytes,
        settings_json,
        &options(max_dimension, false, decode_cap),
    )
    .map_err(js_error)
}

/// The JPEG of an export with the EXIF NIHO writes (F7a #17143): the capture
/// date and time, orientation 1 and sRGB; no location or camera, any earlier
/// EXIF removed. `captured_at` is the photo's `capturedAt` (ISO 8601, e.g.
/// `2026-09-17T02:12:59.000Z`), shown at `offset_minutes` from UTC (Japan:
/// 540); absent, the JPEG gets no EXIF. Works on the crate's `exportJpeg`
/// output and on a canvas-encoded JPEG alike.
#[wasm_bindgen(js_name = withCaptureExif)]
pub fn with_capture_exif(
    jpeg_bytes: &[u8],
    captured_at: Option<String>,
    offset_minutes: i32,
) -> Result<Vec<u8>, JsError> {
    let capture = captured_at
        .map(|iso| niho_develop::exif::CaptureTime::from_iso(&iso, offset_minutes))
        .transpose()
        .map_err(js_error)?;
    niho_develop::exif::with_capture_exif(jpeg_bytes, capture.as_ref()).map_err(js_error)
}

/// "補正前": the settings with the color adjustments back to neutral,
/// keeping `v`, `engine`, `look`, `base` and `geometry` (the same cropped
/// frame with the original's colors).
#[wasm_bindgen(js_name = beforeSettings)]
pub fn before_settings(settings_json: &str) -> Result<String, JsError> {
    niho_develop::before_settings(settings_json).map_err(js_error)
}

/// A JPEG / PNG's `{ width, height }` with its EXIF orientation applied,
/// from the header only.
#[wasm_bindgen(js_name = imageSize)]
pub fn image_size(input_bytes: &[u8]) -> Result<Object, JsError> {
    let (width, height) = frame::image_size(input_bytes).map_err(js_error)?;
    size_object(width, height)
}

/// The working size to open a `Developer` of a `width x height` original
/// at (`imageSize`) so these settings' crop reaches `maxDimension`:
/// `min(cap, long edge, ceil(long edge * maxDimension / crop long edge))`
/// (`maxDimension` 0: the original's size; `cap` 0: no cap; without a
/// geometry the crop is the whole photo).
#[wasm_bindgen(js_name = rasterDecodeSize)]
pub fn raster_decode_size(
    settings_json: &str,
    width: u32,
    height: u32,
    max_dimension: u32,
    cap: u32,
) -> Result<u32, JsError> {
    let settings = niho_develop::parse_settings(settings_json).map_err(js_error)?;
    let size = niho_develop::raster_decode_size(
        &settings,
        width as usize,
        height as usize,
        max_dimension as usize,
        cap as usize,
    )
    .map_err(js_error)?;
    Ok(size as u32)
}

/// The `{ width, height }` these settings render at from a `sourceWidth x
/// sourceHeight` source (a Developer's `width` / `height`) at
/// `maxDimension`, without rendering.
#[wasm_bindgen(js_name = geometryOutputSize)]
pub fn geometry_output_size(
    settings_json: &str,
    source_width: u32,
    source_height: u32,
    max_dimension: u32,
) -> Result<Object, JsError> {
    let settings = niho_develop::parse_settings(settings_json).map_err(js_error)?;
    let (width, height) = niho_develop::output_size(
        &settings,
        source_width as usize,
        source_height as usize,
        max_dimension as usize,
    )
    .map_err(js_error)?;
    size_object(width, height)
}

/// Initial `developSettings` v1 for a new edit ("初期化" saves this).
#[wasm_bindgen(js_name = neutralSettings)]
pub fn neutral_settings() -> String {
    DevelopSettings::new_edit().to_json()
}

#[cfg(test)]
mod tests {
    use super::{capabilities, neutral_settings, validate_settings};

    #[test]
    fn capabilities_name_the_mask_kinds_this_build_draws() {
        let value: serde_json::Value = serde_json::from_str(&capabilities()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"masks": {"kinds": ["linear", "radial"], "max": 8, "maskPlane": true}})
        );
    }

    #[test]
    fn neutral_settings_initializer_uses_standard_look() {
        let settings: serde_json::Value = serde_json::from_str(&neutral_settings()).unwrap();
        assert_eq!(settings["look"], "niho-standard-1");
    }

    /// `validateSettings` reads `masks` like the crate does (v 5 and later,
    /// strict keys; v 6 is the detail version, v 10 is a future version).
    #[test]
    fn validate_settings_accepts_and_rejects_masks() {
        let mask = r#"{"id":"m1","kind":"linear","zero":{"x":0.5,"y":0.2},"full":{"x":0.5,"y":0.5},"adjust":{"exposure":-0.7}}"#;
        let issues = |v: u32, mask: &str| -> Vec<serde_json::Value> {
            let text = format!(
                r#"{{"v":{v},"engine":"niho-10","look":"niho-standard-1","base":null,"masks":[{mask}]}}"#
            );
            serde_json::from_str(&validate_settings(&text)).unwrap()
        };
        assert!(issues(5, mask).is_empty());
        assert!(issues(6, mask).is_empty());
        assert!(issues(8, mask).is_empty());
        assert!(issues(9, mask).is_empty());
        assert_eq!(issues(4, mask)[0]["code"], "versionTooLow");
        assert_eq!(issues(10, mask)[0]["code"], "unsupportedVersion");
        let unknown = mask.replace(r#""adjust""#, r#""opacity":1,"adjust""#);
        assert_eq!(issues(5, &unknown)[0]["code"], "unknownMaskKey");
    }
}

/// Validation problems of a `developSettings` JSON (`[]` when valid).
#[wasm_bindgen(js_name = validateSettings)]
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

/// Bundled presets: `[{ id, name, xmp }]`.
#[wasm_bindgen(js_name = builtinPresets)]
pub fn builtin_presets() -> String {
    let list: Vec<serde_json::Value> = xmp::BUILTIN_PRESETS
        .iter()
        .map(|p| serde_json::json!({"id": p.id, "name": p.name, "xmp": p.xmp}))
        .collect();
    serde_json::Value::from(list).to_string()
}

/// XMP preset on `baseJson` (neutral when absent): `{ name, settings,
/// unsupported, approximate, items, converted, convertIssues, ..., masks }`.
/// `masks` are the preset's Lightroom masks in the coordinates of the
/// photo's visible frame (`xmp::PresetResult::masks`; `settings.masks` stay
/// the base's).
#[wasm_bindgen(js_name = presetSettings)]
pub fn preset_settings(xmp_text: &str, base_json: Option<String>) -> Result<String, JsError> {
    let base = match base_json {
        Some(text) => Some(DevelopSettings::from_json(&text).map_err(js_error)?),
        None => None,
    };
    let result = xmp::preset_settings(xmp_text, base.as_ref()).map_err(js_error)?;
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
fn parse_white(json: Option<String>) -> Result<Option<LightroomWhite>, JsError> {
    let Some(text) = json else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(&text).map_err(js_error)?;
    if value.is_null() {
        return Ok(None);
    }
    let number = |key: &str| value.get(key).and_then(serde_json::Value::as_f64);
    match (number("temperature"), number("tint")) {
        (Some(temperature), Some(tint)) => LightroomWhite::new(temperature, tint)
            .map(Some)
            .ok_or_else(|| JsError::new("asShot: temperature must be positive and tint finite")),
        _ => Err(JsError::new(
            "asShot must be {\"temperature\", \"tint\"} or null",
        )),
    }
}

/// XMP preset on `baseJson` at `amount` (0..1.5 = 0..150%; 0 is the base,
/// 1 the whole preset): `presetSettings`' result with `amount`.
/// `asShotJson` is the photo's as-shot white (`asShotWhiteFromMeta` /
/// `Developer.asShotWhite()`, `null` for a JPEG / PNG): an absolute white
/// moves from it in mireds.
#[wasm_bindgen(js_name = applyPreset)]
pub fn apply_preset(
    xmp_text: &str,
    base_json: &str,
    amount: f64,
    as_shot_json: Option<String>,
) -> Result<String, JsError> {
    let base = DevelopSettings::from_json(base_json).map_err(js_error)?;
    let as_shot = parse_white(as_shot_json)?;
    let result = xmp::apply_preset(xmp_text, &base, amount, as_shot).map_err(js_error)?;
    Ok(result.to_value().to_string())
}

/// `developSettings` as a Lightroom XMP preset: `{ xmp, notWritten }`.
/// `optionsJson`: `{ name?, uuid?, groups? }` (groups: `exposure`,
/// `whiteBalance`, `tone`, `presence`, `toneCurve`, `hsl`, `colorGrading`,
/// `calibration`, `blackAndWhite`, `vignette`, `grain`, `noiseReduction`;
/// noise reduction is written only for NIHO 3; the default leaves
/// out `exposure` and `whiteBalance`).
#[wasm_bindgen(js_name = settingsToXmp)]
pub fn settings_to_xmp(
    settings_json: &str,
    options_json: Option<String>,
) -> Result<String, JsError> {
    let settings = DevelopSettings::from_json(settings_json).map_err(js_error)?;
    let options = match options_json {
        Some(text) => {
            let value: serde_json::Value = serde_json::from_str(&text).map_err(js_error)?;
            xmp::XmpWriteOptions::from_value(&value).map_err(js_error)?
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
#[wasm_bindgen(js_name = asShotWhiteFromMeta)]
pub fn as_shot_white_from_meta(meta_json: &str) -> Result<String, JsError> {
    let meta = WorkingCopyMeta::from_json(meta_json).map_err(js_error)?;
    Ok(white_json(meta.lightroom_as_shot_white()))
}

/// Photo Bench `EditSettings` JSON -> `{ ok, settings, issues, notes }`.
#[wasm_bindgen(js_name = convertEditSettings)]
pub fn convert_edit_settings(
    edit_settings_json: &str,
    base_version: Option<String>,
) -> Result<String, JsError> {
    let outcome = convert::convert_edit_settings_json(edit_settings_json, base_version.as_deref())
        .map_err(js_error)?;
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
#[wasm_bindgen]
pub struct Developer {
    session: Session,
}

#[wasm_bindgen]
impl Developer {
    /// Decodes a JPEG / PNG original, reduced to `workingMaxDimension`
    /// (0 = original size; 2560 matches the working copies).
    #[wasm_bindgen(constructor)]
    pub fn new(input_bytes: &[u8], working_max_dimension: u32) -> Result<Developer, JsError> {
        let session = Session::open_raster(
            input_bytes,
            working_max_dimension as usize,
            Filter::Lanczos3,
        )
        .map_err(js_error)?;
        Ok(Developer { session })
    }

    /// Opens a working copy (16-bit PNG) with its metadata JSON.
    #[wasm_bindgen(js_name = openWorkingCopy)]
    pub fn open_working_copy(png: &[u8], meta_json: &str) -> Result<Developer, JsError> {
        let session =
            Session::open_working_copy(png, meta_json, Filter::Lanczos3).map_err(js_error)?;
        Ok(Developer { session })
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.session.source_size().0 as u32
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.session.source_size().1 as u32
    }

    /// The photo's as-shot white on Lightroom's scale: `{ temperature, tint }`
    /// JSON, `null` for a JPEG / PNG (the `asShotJson` of `applyPreset`).
    #[wasm_bindgen(js_name = asShotWhite)]
    pub fn as_shot_white(&self) -> String {
        white_json(self.session.as_shot_white())
    }

    /// A separate `Developer` for preset previews at a long side of
    /// `maxDimension` (at most 512; 0 = 512) without decoding again. Signed
    /// NIHO 3 sources retain their full master internally for canonical
    /// analysis. Rendering leaves this one's next drag frame as it was.
    /// Render it with `maxDimension` 0 (its own size).
    pub fn thumbnail(&self, max_dimension: u32) -> Developer {
        Developer {
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
    ) -> Result<Object, JsError> {
        let settings = niho_develop::parse_settings(settings_json).map_err(js_error)?;
        let quality = if interactive {
            Quality::Interactive
        } else {
            Quality::Final
        };
        let frame = self
            .session
            .render(&settings, max_dimension as usize, quality)
            .map_err(js_error)?;
        frame_object(&frame)
    }

    /// Makes ahead, while the editor is idle, the response analysis frames of
    /// these settings read once they use Highlights or Shadows (signed RAW:
    /// the noise reduction source, the response coefficients and the
    /// highlight maps; #129), so the first such frame does not wait for it.
    /// Draws nothing and leaves the frames' bytes as they are. `false`:
    /// nothing to make ahead for this photo and engine.
    #[wasm_bindgen(js_name = prepareAnalysis)]
    pub fn prepare_analysis(&mut self, settings_json: &str) -> Result<bool, JsError> {
        let settings = niho_develop::parse_settings(settings_json).map_err(js_error)?;
        self.session.prepare_analysis(&settings).map_err(js_error)
    }

    /// Drops the analysis made ahead for other settings (a kept photo's
    /// Developer, #129). Frames are the same bytes.
    #[wasm_bindgen(js_name = releaseAnalysisAhead)]
    pub fn release_analysis_ahead(&mut self) {
        self.session.release_analysis_ahead();
    }

    /// Makes the analysis `prepareAnalysis` makes and gives it as versioned
    /// bytes (#155: a helper worker opens the same photo the same way and
    /// makes it there, so the editor's worker is not held by it). The
    /// editor's Developer takes them in with `importAnalysis`. `undefined`:
    /// nothing to make ahead for this photo and engine.
    #[wasm_bindgen(js_name = exportAnalysis)]
    pub fn export_analysis(&mut self, settings_json: &str) -> Result<Option<Vec<u8>>, JsError> {
        let settings = niho_develop::parse_settings(settings_json).map_err(js_error)?;
        self.session.export_analysis(&settings).map_err(js_error)
    }

    /// Takes in the bytes `exportAnalysis` gave for this photo (a copy;
    /// #155). Frames are the same bytes as when this Developer makes the
    /// analysis. `false`: it already held all of it. Bytes of another photo,
    /// broken or of an unknown version throw and change nothing.
    #[wasm_bindgen(js_name = importAnalysis)]
    pub fn import_analysis(&mut self, bytes: &[u8]) -> Result<bool, JsError> {
        self.session.import_analysis(bytes).map_err(js_error)
    }

    /// One local mask's plane for the editor's overlay: `{ width, height,
    /// data }` where `data` is a `Uint8Array` of `width * height` values
    /// (`round(weight / 65536 * 255)`, row-major, the mask's `invert`
    /// applied, drawn whether or not it is enabled) at the size `render`
    /// gives these settings at `maxDimension`, from the same map and plane
    /// as the render. Leaves the drag frames' kept state as it was. A
    /// `brush` / `subject` / `sky` mask fails with `maskSurfaceMissing`, an
    /// id the settings do not have with `maskNotFound`.
    #[wasm_bindgen(js_name = maskPlane)]
    pub fn mask_plane(
        &self,
        settings_json: &str,
        mask_id: &str,
        max_dimension: u32,
    ) -> Result<Object, JsError> {
        let settings = niho_develop::parse_settings(settings_json).map_err(js_error)?;
        let (width, height, data) = self
            .session
            .mask_plane(&settings, mask_id, max_dimension as usize)
            .map_err(js_error)?;
        let o = size_object(width, height)?;
        Reflect::set(
            &o,
            &JsValue::from_str("data"),
            &js_sys::Uint8Array::from(&data[..]).into(),
        )
        .map_err(|_| JsError::new("set"))?;
        Ok(o)
    }

    /// Samples Stage Q after hue stabilization and before color points /
    /// Color Grading at normalized rendered-frame coordinates.
    #[wasm_bindgen(js_name = sampleColor)]
    pub fn sample_color(
        &mut self,
        settings_json: &str,
        max_dimension: u32,
        x: f64,
        y: f64,
    ) -> Result<Object, JsError> {
        let settings = niho_develop::parse_settings(settings_json).map_err(js_error)?;
        let color = self
            .session
            .sample_color(&settings, max_dimension as usize, x, y)
            .map_err(js_error)?;
        sampled_color_object(color)
    }

    /// "自動": these settings with the six Light sliders and Vibrance set
    /// for this photo (within its crop), as a `developSettings` JSON; every
    /// other key keeps the text it was given. The frames' kept state is
    /// left as it was.
    #[wasm_bindgen(js_name = autoSettings)]
    pub fn auto_settings(&mut self, settings_json: &str) -> Result<String, JsError> {
        let settings = niho_develop::parse_settings(settings_json).map_err(js_error)?;
        let result = self.session.auto_settings(&settings).map_err(js_error)?;
        niho_develop::auto::write_changes(settings_json, &settings, &result).map_err(js_error)
    }

    /// Upright (niho-photo#46): the perspective that stands this photo's
    /// lines upright, found on the frame of these settings' quarter turns
    /// and flips (their straighten angle taken off). `mode`: 1 auto, 2
    /// level, 3 vertical, 4 full. Returns `{ perspective: { vertical,
    /// horizontal, rotate, aspect, scale, x, y }, mode, confidence, lines:
    /// { vertical, horizontal }, reason? }` JSON (`reason` "noLines": the
    /// identity, nothing to correct). The frames' kept state is left as it
    /// was.
    #[wasm_bindgen(js_name = estimateUpright)]
    pub fn estimate_upright(&self, settings_json: &str, mode: u32) -> Result<String, JsError> {
        let settings = niho_develop::parse_settings(settings_json).map_err(js_error)?;
        let mode = UprightMode::from_number(mode).ok_or_else(|| {
            JsError::new("mode must be 1 (auto), 2 (level), 3 (vertical) or 4 (full)")
        })?;
        Ok(self
            .session
            .estimate_upright(&settings, mode)
            .to_value()
            .to_string())
    }
}
