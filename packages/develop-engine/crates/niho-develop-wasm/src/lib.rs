//! Browser (Web Worker) bindings of `niho-develop` via `wasm-bindgen`.
//!
//! Each export wraps one call of `niho_develop::api` (which documents what
//! it does) and only converts the result for JS: a frame to `{ width,
//! height, rgba, approximations }` (`rgba` a `Uint8ClampedArray`), a size
//! to `{ width, height }`, an error message to a `JsError`. The Mac's
//! native sidecar (`niho-develop-render serve`) wraps the same calls under
//! the same names, so both answer alike.
//! Everything runs single threaded (no SharedArrayBuffer, spec "段 2").

use js_sys::{Object, Reflect, Uint8ClampedArray};
use niho_develop::{api, Rendered};
use wasm_bindgen::prelude::*;

fn js_error(message: String) -> JsError {
    JsError::new(&message)
}

fn frame_object(frame: &Rendered) -> Result<Object, JsError> {
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

fn size_object(width: u32, height: u32) -> Result<Object, JsError> {
    let o = Object::new();
    for (k, v) in [("width", width), ("height", height)] {
        Reflect::set(&o, &JsValue::from_str(k), &JsValue::from(v))
            .map_err(|_| JsError::new("set"))?;
    }
    Ok(o)
}

fn sampled_color_object(color: api::SampledColor) -> Result<Object, JsError> {
    let o = Object::new();
    for (key, value) in [
        ("lightness", color.lightness),
        ("chroma", color.chroma),
        ("hue", color.hue),
    ] {
        Reflect::set(&o, &JsValue::from_str(key), &JsValue::from_f64(value))
            .map_err(|_| JsError::new("set"))?;
    }
    Ok(o)
}

/// `niho_develop::api::version`.
#[wasm_bindgen]
pub fn version() -> String {
    api::version()
}

/// `niho_develop::api::capabilities`.
#[wasm_bindgen]
pub fn capabilities() -> String {
    api::capabilities()
}

/// `niho_develop::api::render`: `{ width, height, rgba, approximations }`.
#[wasm_bindgen]
pub fn render(
    input_bytes: &[u8],
    settings_json: &str,
    max_dimension: u32,
    decode_cap: Option<u32>,
) -> Result<Object, JsError> {
    let frame =
        api::render(input_bytes, settings_json, max_dimension, decode_cap).map_err(js_error)?;
    frame_object(&frame)
}

/// `niho_develop::api::export_jpeg`.
#[wasm_bindgen(js_name = exportJpeg)]
pub fn export_jpeg(
    input_bytes: &[u8],
    settings_json: &str,
    max_dimension: u32,
    quality: u8,
    decode_cap: Option<u32>,
) -> Result<Vec<u8>, JsError> {
    api::export_jpeg(
        input_bytes,
        settings_json,
        max_dimension,
        quality,
        decode_cap,
    )
    .map_err(js_error)
}

/// `niho_develop::api::export_png`.
#[wasm_bindgen(js_name = exportPng)]
pub fn export_png(
    input_bytes: &[u8],
    settings_json: &str,
    max_dimension: u32,
    decode_cap: Option<u32>,
) -> Result<Vec<u8>, JsError> {
    api::export_png(input_bytes, settings_json, max_dimension, decode_cap).map_err(js_error)
}

/// `niho_develop::api::with_capture_exif`.
#[wasm_bindgen(js_name = withCaptureExif)]
pub fn with_capture_exif(
    jpeg_bytes: &[u8],
    captured_at: Option<String>,
    offset_minutes: i32,
) -> Result<Vec<u8>, JsError> {
    api::with_capture_exif(jpeg_bytes, captured_at.as_deref(), offset_minutes).map_err(js_error)
}

/// `niho_develop::api::before_settings`.
#[wasm_bindgen(js_name = beforeSettings)]
pub fn before_settings(settings_json: &str) -> Result<String, JsError> {
    api::before_settings(settings_json).map_err(js_error)
}

/// `niho_develop::api::image_size`: `{ width, height }`.
#[wasm_bindgen(js_name = imageSize)]
pub fn image_size(input_bytes: &[u8]) -> Result<Object, JsError> {
    let size = api::image_size(input_bytes).map_err(js_error)?;
    size_object(size.width, size.height)
}

/// `niho_develop::api::raster_decode_size`.
#[wasm_bindgen(js_name = rasterDecodeSize)]
pub fn raster_decode_size(
    settings_json: &str,
    width: u32,
    height: u32,
    max_dimension: u32,
    cap: u32,
) -> Result<u32, JsError> {
    api::raster_decode_size(settings_json, width, height, max_dimension, cap).map_err(js_error)
}

/// `niho_develop::api::geometry_output_size`: `{ width, height }`.
#[wasm_bindgen(js_name = geometryOutputSize)]
pub fn geometry_output_size(
    settings_json: &str,
    source_width: u32,
    source_height: u32,
    max_dimension: u32,
) -> Result<Object, JsError> {
    let size = api::geometry_output_size(settings_json, source_width, source_height, max_dimension)
        .map_err(js_error)?;
    size_object(size.width, size.height)
}

/// `niho_develop::api::neutral_settings`.
#[wasm_bindgen(js_name = neutralSettings)]
pub fn neutral_settings() -> String {
    api::neutral_settings()
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

/// `niho_develop::api::validate_settings`.
#[wasm_bindgen(js_name = validateSettings)]
pub fn validate_settings(settings_json: &str) -> String {
    api::validate_settings(settings_json)
}

/// `niho_develop::api::builtin_presets`.
#[wasm_bindgen(js_name = builtinPresets)]
pub fn builtin_presets() -> String {
    api::builtin_presets()
}

/// `niho_develop::api::preset_settings`.
#[wasm_bindgen(js_name = presetSettings)]
pub fn preset_settings(xmp_text: &str, base_json: Option<String>) -> Result<String, JsError> {
    api::preset_settings(xmp_text, base_json.as_deref()).map_err(js_error)
}

/// `niho_develop::api::apply_preset`.
#[wasm_bindgen(js_name = applyPreset)]
pub fn apply_preset(
    xmp_text: &str,
    base_json: &str,
    amount: f64,
    as_shot_json: Option<String>,
) -> Result<String, JsError> {
    api::apply_preset(xmp_text, base_json, amount, as_shot_json.as_deref()).map_err(js_error)
}

/// `niho_develop::api::settings_to_xmp`.
#[wasm_bindgen(js_name = settingsToXmp)]
pub fn settings_to_xmp(
    settings_json: &str,
    options_json: Option<String>,
) -> Result<String, JsError> {
    api::settings_to_xmp(settings_json, options_json.as_deref()).map_err(js_error)
}

/// `niho_develop::api::as_shot_white_from_meta`.
#[wasm_bindgen(js_name = asShotWhiteFromMeta)]
pub fn as_shot_white_from_meta(meta_json: &str) -> Result<String, JsError> {
    api::as_shot_white_from_meta(meta_json).map_err(js_error)
}

/// `niho_develop::api::convert_edit_settings`.
#[wasm_bindgen(js_name = convertEditSettings)]
pub fn convert_edit_settings(
    edit_settings_json: &str,
    base_version: Option<String>,
) -> Result<String, JsError> {
    api::convert_edit_settings(edit_settings_json, base_version.as_deref()).map_err(js_error)
}

/// `niho_develop::api::Developer`: a decoded photo kept across renders
/// (slider drags).
#[wasm_bindgen]
pub struct Developer {
    inner: api::Developer,
}

#[wasm_bindgen]
impl Developer {
    /// `niho_develop::api::Developer::new`.
    #[wasm_bindgen(constructor)]
    pub fn new(input_bytes: &[u8], working_max_dimension: u32) -> Result<Developer, JsError> {
        let inner = api::Developer::new(input_bytes, working_max_dimension).map_err(js_error)?;
        Ok(Developer { inner })
    }

    /// `niho_develop::api::Developer::open_working_copy`.
    #[wasm_bindgen(js_name = openWorkingCopy)]
    pub fn open_working_copy(png: &[u8], meta_json: &str) -> Result<Developer, JsError> {
        let inner = api::Developer::open_working_copy(png, meta_json).map_err(js_error)?;
        Ok(Developer { inner })
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.width()
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.height()
    }

    /// `niho_develop::api::Developer::as_shot_white`.
    #[wasm_bindgen(js_name = asShotWhite)]
    pub fn as_shot_white(&self) -> String {
        self.inner.as_shot_white()
    }

    /// `niho_develop::api::Developer::thumbnail`.
    pub fn thumbnail(&self, max_dimension: u32) -> Developer {
        Developer {
            inner: self.inner.thumbnail(max_dimension),
        }
    }

    /// `niho_develop::api::Developer::render`: `{ width, height, rgba,
    /// approximations }`.
    pub fn render(
        &mut self,
        settings_json: &str,
        max_dimension: u32,
        interactive: bool,
    ) -> Result<Object, JsError> {
        let frame = self
            .inner
            .render(settings_json, max_dimension, interactive)
            .map_err(js_error)?;
        frame_object(&frame)
    }

    /// `niho_develop::api::Developer::mask_plane`: `{ width, height, data }`
    /// (`data` a `Uint8Array`).
    #[wasm_bindgen(js_name = maskPlane)]
    pub fn mask_plane(
        &self,
        settings_json: &str,
        mask_id: &str,
        max_dimension: u32,
    ) -> Result<Object, JsError> {
        let plane = self
            .inner
            .mask_plane(settings_json, mask_id, max_dimension)
            .map_err(js_error)?;
        let o = size_object(plane.width, plane.height)?;
        Reflect::set(
            &o,
            &JsValue::from_str("data"),
            &js_sys::Uint8Array::from(&plane.data[..]).into(),
        )
        .map_err(|_| JsError::new("set"))?;
        Ok(o)
    }

    /// `niho_develop::api::Developer::sample_color`: `{ lightness, chroma,
    /// hue }`.
    #[wasm_bindgen(js_name = sampleColor)]
    pub fn sample_color(
        &mut self,
        settings_json: &str,
        max_dimension: u32,
        x: f64,
        y: f64,
    ) -> Result<Object, JsError> {
        let color = self
            .inner
            .sample_color(settings_json, max_dimension, x, y)
            .map_err(js_error)?;
        sampled_color_object(color)
    }

    /// `niho_develop::api::Developer::auto_settings`.
    #[wasm_bindgen(js_name = autoSettings)]
    pub fn auto_settings(&mut self, settings_json: &str) -> Result<String, JsError> {
        self.inner.auto_settings(settings_json).map_err(js_error)
    }

    /// `niho_develop::api::Developer::estimate_upright`.
    #[wasm_bindgen(js_name = estimateUpright)]
    pub fn estimate_upright(&self, settings_json: &str, mode: u32) -> Result<String, JsError> {
        self.inner
            .estimate_upright(settings_json, mode)
            .map_err(js_error)
    }
}
