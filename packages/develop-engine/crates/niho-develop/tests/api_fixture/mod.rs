//! The inputs and the pinned results of `niho_develop::api`, shared by
//! `tests/api_cross_target.rs` (the calls themselves, natively and in
//! browser wasm) and `niho-develop-render`'s `tests/serve.rs` (the same
//! calls through `niho-develop-render serve`): the Mac's sidecar must give
//! what the wasm gives, byte for byte.
//!
//! Both tests make the calls in this order and collect `(name, result)`
//! for [`assert_expected`]: `render`, `exportJpeg`, `exportPng`,
//! `withCaptureExif` (of that JPEG) and `imageSize` of [`photo_png`]; a
//! `Developer` of it at its own size: `render` interactive then final at
//! [`MAX_DIMENSION`], `maskPlane` of [`MASK_ID`], `sampleColor` at
//! [`SAMPLE_X`] / [`SAMPLE_Y`], `autoSettings`, `estimateUpright`
//! ([`UPRIGHT_MODE`]), and a `thumbnail` ([`THUMBNAIL_MAX_DIMENSION`])
//! rendered at its own size, all with [`SETTINGS`]; a `Developer` of
//! [`working_copy`]: `asShotWhite` and a final `render` of
//! [`WORKING_COPY_SETTINGS`] at its own size; then `presetSettings`,
//! `applyPreset`, `settingsToXmp`, `validateSettings` and
//! `convertEditSettings`.

#![allow(dead_code)]

use niho_develop::decode::{self, LinearImage};
use niho_develop::encode;

/// A 160 x 120 photo (PNG): a sky over a dark field with a saturated
/// object, with noise.
pub fn photo_png() -> Vec<u8> {
    let (w, h) = (160usize, 120usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    let mut state = 0x1b87_3593u32;
    for y in 0..h {
        for x in 0..w {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 9) as i32 - 4;
            let sky = y < 50;
            let object = (x as i32 - 104).pow(2) + (y as i32 - 84).pow(2) < 360;
            let (r, g, b) = if sky {
                (140 + x as i32 / 4, 185 + y as i32, 240)
            } else if object {
                (190, 60, 45)
            } else {
                (35 + x as i32 / 6, 45 + y as i32 / 8, 25)
            };
            let c = |v: i32| (v + noise).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[c(r), c(g), c(b), 255]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

/// A synthetic RAW working copy (16-bit PNG, 96 x 64) for
/// [`WORKING_COPY_META`].
pub fn working_copy() -> Vec<u8> {
    let (w, h) = (96usize, 64usize);
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let t = x as f32 / (w - 1) as f32;
            let u = y as f32 / (h - 1) as f32;
            data.extend_from_slice(&[
                0.02 + 0.85 * t * t,
                0.04 + 0.45 * u,
                0.1 + 0.35 * (1.0 - t) * u,
            ]);
        }
    }
    decode::encode_working_copy(&LinearImage {
        width: w,
        height: h,
        data,
    })
}

pub const WORKING_COPY_META: &str = r#"{"kind":"raw","baselineEV":0.1,"asShotWhite":{"x":0.3324,"y":0.3474,"temperature":5400,"tint":4},"asShotWhiteAdobe":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v2","lookTableIncluded":false}"#;

/// A turned, straightened crop with a linear and a radial mask (v 5,
/// `niho-14`).
pub const SETTINGS: &str = r#"{"v":5,"engine":"niho-14","look":"niho-standard-1","base":null,"exposure":0.15,"shadows":25,"vibrance":10,
"geometry":{"rotate":90,"angle":3.5,"crop":{"left":0.05,"top":0.08,"right":0.93,"bottom":0.95}},
"masks":[
 {"id":"sky","kind":"linear","zero":{"x":0.5,"y":0.45},"full":{"x":0.52,"y":0.1},"adjust":{"exposure":-0.9,"highlights":-40,"saturation":15}},
 {"id":"object","kind":"radial","invert":true,"center":{"x":0.62,"y":0.66},"radius":{"x":0.2,"y":0.25},"angle":-25,"feather":45,"adjust":{"clarity":30,"relativeTemperature":-20}}
]}"#;

pub const WORKING_COPY_SETTINGS: &str = r#"{"v":1,"engine":"niho-14","look":"niho-standard-1","base":null,"exposure":0.3,"contrast":12,"shadows":20,"whiteBalance":{"mode":"absolute","temperature":4800,"tint":6}}"#;

/// Settings `validateSettings` finds problems in.
pub const INVALID_SETTINGS: &str = r#"{"v":5,"engine":"niho-14","look":"niho-standard-1","exposure":9,"masks":[{"id":"m","kind":"linear","zero":{"x":0.5,"y":0.2},"full":{"x":0.5,"y":0.5},"adjust":{"exposure":-9}}]}"#;

/// A Photo Bench `EditSettings`.
pub const EDIT_SETTINGS: &str = r#"{"exposure":0.5,"contrast":-12,"relativeTemperature":-30,"relativeTint":12,"whiteBalance":{"mode":"asShot"}}"#;
pub const CONVERT_BASE: &str = "base-api";

pub const MAX_DIMENSION: u32 = 96;
pub const THUMBNAIL_MAX_DIMENSION: u32 = 64;
pub const JPEG_QUALITY: u8 = 85;
pub const CAPTURED_AT: &str = "2026-09-17T02:12:59.000Z";
pub const OFFSET_MINUTES: i32 = 540;
pub const MASK_ID: &str = "sky";
pub const SAMPLE_X: f64 = 0.3;
pub const SAMPLE_Y: f64 = 0.6;
pub const UPRIGHT_MODE: u32 = 1;
pub const PRESET_AMOUNT: f64 = 0.6;
pub const XMP_OPTIONS: &str = r#"{"name":"api"}"#;

/// The first bundled preset's XMP.
pub fn preset_xmp() -> &'static str {
    niho_develop::xmp::BUILTIN_PRESETS[0].xmp
}

/// The SHA-256 of `bytes` in lowercase hex.
pub fn sha256(bytes: &[u8]) -> String {
    niho_develop::mask_surface::surface_id(bytes)
}

/// `<width>x<height>`.
pub fn size_text(width: u64, height: u64) -> String {
    format!("{width}x{height}")
}

/// What the digest of a sampled color covers: its lightness, chroma and
/// hue as little-endian `f64`s.
pub fn color_digest(lightness: f64, chroma: f64, hue: f64) -> String {
    let mut bytes = Vec::with_capacity(24);
    for value in [lightness, chroma, hue] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    sha256(&bytes)
}

/// The results, in the order above: a SHA-256, a size or a short text.
pub const EXPECTED: [(&str, &str); 24] = [
    ("render", ""),
    ("render.size", ""),
    ("render.approximations", ""),
    ("exportJpeg", ""),
    ("exportPng", ""),
    ("withCaptureExif", ""),
    ("imageSize", "160x120"),
    ("Developer.new.size", "160x120"),
    ("Developer.render.interactive", ""),
    ("Developer.render.final", ""),
    ("Developer.render.size", ""),
    ("Developer.maskPlane", ""),
    ("Developer.maskPlane.size", ""),
    ("Developer.sampleColor", ""),
    ("Developer.autoSettings", ""),
    ("Developer.estimateUpright", ""),
    ("Developer.thumbnail.render", ""),
    ("Developer.asShotWhite", ""),
    ("Developer.openWorkingCopy.render", ""),
    ("presetSettings", ""),
    ("applyPreset", ""),
    ("settingsToXmp", ""),
    ("validateSettings", ""),
    ("convertEditSettings", ""),
];

/// Fails with every result (as lines for [`EXPECTED`]) unless they are
/// [`EXPECTED`].
pub fn assert_expected(actual: &[(&str, String)]) {
    let same = actual.len() == EXPECTED.len()
        && actual
            .iter()
            .zip(EXPECTED.iter())
            .all(|((name, value), (want_name, want))| name == want_name && value == want);
    if !same {
        let lines: Vec<String> = actual
            .iter()
            .map(|(name, value)| {
                let mark = match EXPECTED.iter().find(|(want_name, _)| want_name == name) {
                    Some((_, want)) if want == value => "",
                    _ => "  // differs",
                };
                format!("    ({name:?}, {value:?}),{mark}")
            })
            .collect();
        panic!(
            "the results are not EXPECTED; they are:\n{}",
            lines.join("\n")
        );
    }
}
