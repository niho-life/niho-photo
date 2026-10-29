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
    (
        "render",
        "fea876f2981be2c70d485f736012ebbd1130923e36bd93aff06fef0294b4ac33",
    ),
    ("render.size", "83x96"),
    ("render.approximations", ""),
    (
        "exportJpeg",
        "0cb6dd7ad3d215bccb793be3178867c32c920acc67a2cea34e1d9d0a398fd880",
    ),
    (
        "exportPng",
        "da74a4884e28bd49ac935a8c22bbd972fd30a006253bf6c63b741e713557a4d9",
    ),
    (
        "withCaptureExif",
        "148bb8d7916a4d515739f9502e1251bb7c06274285342d72f8f2980f2b5b2844",
    ),
    ("imageSize", "160x120"),
    ("Developer.new.size", "160x120"),
    (
        "Developer.render.interactive",
        "ea6399c8f36925d666cd2b336c0e7eef283f47f7ff086c4c4d6845dcf77a5233",
    ),
    (
        "Developer.render.final",
        "9fd18169bdbc21be1ce1be04ebdd274464fc4f5f014fc41c1440e47c1c845b6c",
    ),
    ("Developer.render.size", "83x96"),
    (
        "Developer.maskPlane",
        "ac9d3f095ef2772c3486213244bfdb4d989e7b1fb435b820e046d85a0f574463",
    ),
    ("Developer.maskPlane.size", "83x96"),
    (
        "Developer.sampleColor",
        "b2d040b1844e20d51a702fffe935ac96ab1e005a2d992d013123643711c85b76",
    ),
    (
        "Developer.autoSettings",
        "56c11ef214d99d5252c15feb5d0c7e6ad4dae475d124fdb413acdcc6fff29e2b",
    ),
    (
        "Developer.estimateUpright",
        "26083c64ba165d86d193435a3cf5dbe4b070bd98354539d3762217bacf084289",
    ),
    (
        "Developer.thumbnail.render",
        "0af490ee372d3f993faf8c9919faf65d837b1192c1e04dff06f92e85f59bccda",
    ),
    (
        "Developer.asShotWhite",
        "{\"temperature\":5400.0,\"tint\":4.0}",
    ),
    (
        "Developer.openWorkingCopy.render",
        "7b9bb061575cb2fee91ec8434814691ad51530d47564e4ec5793c22f811e33c1",
    ),
    (
        "presetSettings",
        "2e4c667b04c593a92bf697970bb903be42c3781246b949c7f66176b043c9ec63",
    ),
    (
        "applyPreset",
        "c685fef8af1e6e0b0a68a4bae20b3065751b8173f15ca19573f341f731e9c00c",
    ),
    (
        "settingsToXmp",
        "3a5c49cde714053f2dac76dcaee211210e146a2272ea651ca1872aa20f2184b8",
    ),
    (
        "validateSettings",
        "a0df9aa965ee513d4b4e9108d5c38f26a50293f24b927b4562e305a73a647b07",
    ),
    (
        "convertEditSettings",
        "1939174e68475b2ed577c55ef389a0a75b793e1113012578e4160f333d916e23",
    ),
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
