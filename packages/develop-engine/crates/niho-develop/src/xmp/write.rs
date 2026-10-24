//! `developSettings` -> a Lightroom / Camera Raw XMP preset (Issue #17121
//! F2a: save the current edit as a preset, which Lightroom can import).
//!
//! Written from the reading tables ([`SCALAR_KEYS`], [`hsl_key`], the
//! point-curve elements and [`EFFECT_KEYS`]), so [`super::preset_settings`]
//! reads back the written values (point curves on Lightroom's 0..255 grid).
//! Every key of a written group is written, defaults included, the way
//! Lightroom saves a preset: applying it sets those controls whatever the
//! photo had (the midtone / global luminance too since niho-photo#39
//! renders them).

use super::{hsl_key, EffectField, EffectGroup, CURVE_MAP, EFFECT_KEYS, HSL_PREFIXES, SCALAR_KEYS};
use crate::effects::GRAIN_DEFAULT_SEED;
use crate::geometry::PerspectiveField;
use crate::settings::{
    CurveChannel, DevelopSettings, HslBand, SettingsError, ToneCurve, WhiteBalanceMode,
    ENGINE_NIHO_10, ENGINE_NIHO_11, ENGINE_NIHO_12, ENGINE_NIHO_13, ENGINE_NIHO_14, ENGINE_NIHO_2,
    ENGINE_NIHO_3, ENGINE_NIHO_4, ENGINE_NIHO_5, ENGINE_NIHO_6, ENGINE_NIHO_7, ENGINE_NIHO_8,
};
use crate::tone_ops::normalized_points;
use serde_json::{Map, Value};

/// `crs:Version` of a written preset (the Camera Raw version whose keys
/// this writer uses; the calibration packets, `tools/calibrate`, say the
/// same).
pub const XMP_CAMERA_RAW_VERSION: &str = "18.3";
/// `crs:ProcessVersion` of a written preset.
pub const XMP_PROCESS_VERSION: &str = "15.4";

/// A group of controls [`settings_to_xmp`] writes (camelCase in JSON).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum XmpGroup {
    /// `Exposure2012`.
    Exposure,
    /// `WhiteBalance` / `Temperature` / `Tint` (an absolute white only).
    WhiteBalance,
    /// Contrast, highlights, shadows, whites, blacks.
    Tone,
    /// Texture, clarity, dehaze, vibrance, saturation.
    Presence,
    /// The parametric curve, the point curves (all four channels) and
    /// `CurveRefineSaturation`.
    ToneCurve,
    /// The HSL mixer (all 24 values).
    Hsl,
    /// Color grading (split toning keys for the shadow / highlight wheels,
    /// like Lightroom).
    ColorGrading,
    /// Camera calibration.
    Calibration,
    /// `ConvertToGrayscale` and the black & white mix.
    BlackAndWhite,
    /// The post-crop vignette.
    Vignette,
    /// Grain.
    Grain,
    /// Color noise reduction (signed RAW R209 or v6 detail) with its retained
    /// detail / smoothness values, and v6 luminance noise reduction.
    NoiseReduction,
    /// v6 output sharpening (amount, radius, detail, masking).
    Sharpening,
    /// The Transform sliders (`Perspective*`), "余白を埋める"
    /// (`CropConstrainToWarp`) and the kept `PerspectiveUpright`
    /// (niho-photo#46). Not in [`Self::DEFAULT`]: the geometry belongs to
    /// each photo, like the exposure.
    Transform,
    /// The Lens Corrections panel's manual values, chromatic aberration and
    /// defringe (niho-photo#45; `LensManualDistortionAmount`,
    /// `VignetteAmount` / `VignetteMidpoint`, `AutoLateralCA`, `Defringe*`).
    /// Profile corrections are never written (the working copy carries
    /// them).
    Lens,
}

impl XmpGroup {
    pub const ALL: [XmpGroup; 15] = [
        XmpGroup::Exposure,
        XmpGroup::WhiteBalance,
        XmpGroup::Tone,
        XmpGroup::Presence,
        XmpGroup::ToneCurve,
        XmpGroup::Hsl,
        XmpGroup::ColorGrading,
        XmpGroup::Calibration,
        XmpGroup::BlackAndWhite,
        XmpGroup::Vignette,
        XmpGroup::Grain,
        XmpGroup::NoiseReduction,
        XmpGroup::Sharpening,
        XmpGroup::Transform,
        XmpGroup::Lens,
    ];

    /// The default of "save the current edit as a preset": everything but
    /// the exposure, white balance and transform, which belong to each photo
    /// (so the preset stacks on a photo's own edit, whichever comes first).
    /// The lens corrections are in it: they belong to the lens and the
    /// shot, like Lightroom's Lens Corrections in a preset.
    pub const DEFAULT: [XmpGroup; 12] = [
        XmpGroup::Tone,
        XmpGroup::Presence,
        XmpGroup::ToneCurve,
        XmpGroup::Hsl,
        XmpGroup::ColorGrading,
        XmpGroup::Calibration,
        XmpGroup::BlackAndWhite,
        XmpGroup::Vignette,
        XmpGroup::Grain,
        XmpGroup::NoiseReduction,
        XmpGroup::Sharpening,
        XmpGroup::Lens,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            XmpGroup::Exposure => "exposure",
            XmpGroup::WhiteBalance => "whiteBalance",
            XmpGroup::Tone => "tone",
            XmpGroup::Presence => "presence",
            XmpGroup::ToneCurve => "toneCurve",
            XmpGroup::Hsl => "hsl",
            XmpGroup::ColorGrading => "colorGrading",
            XmpGroup::Calibration => "calibration",
            XmpGroup::BlackAndWhite => "blackAndWhite",
            XmpGroup::Vignette => "vignette",
            XmpGroup::Grain => "grain",
            XmpGroup::NoiseReduction => "noiseReduction",
            XmpGroup::Sharpening => "sharpening",
            XmpGroup::Transform => "transform",
            XmpGroup::Lens => "lens",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        XmpGroup::ALL.into_iter().find(|g| g.as_str() == s)
    }

    fn of_effect(group: EffectGroup) -> Self {
        match group {
            EffectGroup::Grayscale => XmpGroup::BlackAndWhite,
            EffectGroup::Vignette => XmpGroup::Vignette,
            EffectGroup::Grain => XmpGroup::Grain,
        }
    }
}

/// What [`settings_to_xmp`] writes besides the settings.
#[derive(Debug, Clone, PartialEq)]
pub struct XmpWriteOptions {
    /// `crs:Name` (`x-default`).
    pub name: String,
    /// `crs:UUID` (32 hex digits); `None` derives one from the name and the
    /// written settings (the same content gives the same UUID).
    pub uuid: Option<String>,
    /// The groups written.
    pub groups: Vec<XmpGroup>,
}

impl Default for XmpWriteOptions {
    fn default() -> Self {
        Self {
            name: String::new(),
            uuid: None,
            groups: XmpGroup::DEFAULT.to_vec(),
        }
    }
}

impl XmpWriteOptions {
    /// Reads `{ "name"?, "uuid"?, "groups"? }` (the wasm / API JSON; absent
    /// keys take [`Default`]). Unknown keys and groups, and a UUID other
    /// than 32 hex digits, are errors.
    pub fn from_value(value: &Value) -> Result<Self, SettingsError> {
        let object = value.as_object().ok_or_else(|| {
            SettingsError::new("", "invalidType", "XMP options must be an object")
        })?;
        let mut options = Self::default();
        for (key, v) in object {
            match key.as_str() {
                "name" => {
                    options.name = v
                        .as_str()
                        .ok_or_else(|| SettingsError::new(key, "invalidType", "must be a string"))?
                        .to_string()
                }
                "uuid" => {
                    options.uuid = match v {
                        Value::Null => None,
                        Value::String(s)
                            if s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit()) =>
                        {
                            Some(s.to_ascii_uppercase())
                        }
                        _ => {
                            return Err(SettingsError::new(
                                key,
                                "invalidValue",
                                "must be 32 hex digits",
                            ))
                        }
                    }
                }
                "groups" => {
                    let list = v.as_array().ok_or_else(|| {
                        SettingsError::new(key, "invalidType", "must be an array")
                    })?;
                    let mut groups = Vec::new();
                    for (i, g) in list.iter().enumerate() {
                        let group = g.as_str().and_then(XmpGroup::parse).ok_or_else(|| {
                            SettingsError::new(
                                &format!("groups[{i}]"),
                                "invalidValue",
                                "unknown group",
                            )
                        })?;
                        if !groups.contains(&group) {
                            groups.push(group);
                        }
                    }
                    options.groups = groups;
                }
                _ => return Err(SettingsError::new(key, "unknownKey", "not an XMP option")),
            }
        }
        Ok(options)
    }
}

/// [`settings_to_xmp`]'s result.
#[derive(Debug, Clone, PartialEq)]
pub struct XmpWriteResult {
    pub xmp: String,
    /// `developSettings` paths in a written group that XMP cannot carry
    /// (`niho-1` relative white balance, `legacySettings`).
    pub not_written: Vec<String>,
}

impl XmpWriteResult {
    /// `{ xmp, notWritten }` for the wasm / API boundary.
    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("xmp".into(), Value::from(self.xmp.clone()));
        o.insert("notWritten".into(), Value::from(self.not_written.clone()));
        Value::Object(o)
    }
}

/// A number as Lightroom writes it: an integer without a fraction, a sign
/// on a positive value of a signed control; otherwise the shortest decimal
/// that reads back as the same `f64`.
fn number(v: f64, signed: bool) -> String {
    let text = if v == libm::trunc(v) && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    };
    if signed && v > 0.0 {
        format!("+{text}")
    } else {
        text
    }
}

/// XML text / attribute value (control characters XML 1.0 cannot carry
/// are dropped).
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

/// A channel's curve on Lightroom's 0..255 integer grid (the points the
/// renderer uses, `tone_ops::normalized_points`). A point off the 1/255 grid
/// is rounded to it, so such a curve reads back slightly different; points
/// that round to the same x keep the last. The identity (no curve) is
/// `0, 0` / `255, 255`, which Lightroom writes for a linear channel.
fn grid_points(curves: &[ToneCurve], channel: CurveChannel) -> Vec<(i64, i64)> {
    let points = curves
        .iter()
        .find(|c| c.channel == channel)
        .map(normalized_points)
        .unwrap_or_default();
    let mut out: Vec<(i64, i64)> = Vec::new();
    for p in points {
        let q = (
            libm::round(p.x * 255.0) as i64,
            libm::round(p.y * 255.0) as i64,
        );
        match out.last_mut() {
            Some(last) if last.0 == q.0 => *last = q,
            _ => out.push(q),
        }
    }
    if out.len() < 2 {
        return vec![(0, 0), (255, 255)];
    }
    out
}

/// A 32-hex-digit id from the preset's content (FNV-1a, 128 bit).
fn content_uuid(
    name: &str,
    attributes: &[(String, String)],
    curves: &[(&str, Vec<(i64, i64)>)],
) -> String {
    const OFFSET: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    const PRIME: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013b;
    let mut h = OFFSET;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            h ^= u128::from(*b);
            h = h.wrapping_mul(PRIME);
        }
    };
    feed(name.as_bytes());
    feed(&[0]);
    for (k, v) in attributes {
        feed(k.as_bytes());
        feed(b"=");
        feed(v.as_bytes());
        feed(&[0]);
    }
    for (element, points) in curves {
        feed(element.as_bytes());
        for (x, y) in points {
            feed(format!(":{x},{y}").as_bytes());
        }
        feed(&[0]);
    }
    format!("{h:032X}")
}

/// Writes `settings` as a Lightroom XMP preset: the groups of
/// `options.groups`, every key of a group, with the reading tables'
/// names. `look`, `engine`, `base` and unknown keys are never written.
pub fn settings_to_xmp(settings: &DevelopSettings, options: &XmpWriteOptions) -> XmpWriteResult {
    let on = |g: XmpGroup| options.groups.contains(&g);
    let mut not_written: Vec<String> = Vec::new();
    let mut attributes: Vec<(String, String)> = Vec::new();
    let mut put = |k: &str, v: String| attributes.push((k.to_string(), v));

    if on(XmpGroup::WhiteBalance) {
        let wb = &settings.white_balance;
        match (wb.mode, wb.temperature, wb.tint) {
            (WhiteBalanceMode::AsShot, _, _) => put("WhiteBalance", "As Shot".into()),
            (WhiteBalanceMode::Absolute, Some(temperature), Some(tint)) => {
                put("WhiteBalance", "Custom".into());
                put("Temperature", number(temperature, false));
                put("Tint", number(tint, true));
            }
            (WhiteBalanceMode::Absolute, _, _) => not_written.push("whiteBalance".into()),
            (WhiteBalanceMode::Relative, _, _) => {
                if matches!(
                    settings.engine.as_str(),
                    ENGINE_NIHO_2
                        | ENGINE_NIHO_3
                        | ENGINE_NIHO_4
                        | ENGINE_NIHO_5
                        | ENGINE_NIHO_6
                        | ENGINE_NIHO_7
                        | ENGINE_NIHO_10
                        | ENGINE_NIHO_11
                        | ENGINE_NIHO_8
                        | ENGINE_NIHO_12
                        | ENGINE_NIHO_13
                        | ENGINE_NIHO_14
                ) {
                    if settings.relative_temperature == 0.0 && settings.relative_tint == 0.0 {
                        // Lightroom interprets Custom with both increments at
                        // zero as a fixed white, so write a neutral preset.
                        put("WhiteBalance", "As Shot".into());
                    } else {
                        put("WhiteBalance", "Custom".into());
                        put(
                            "IncrementalTemperature",
                            number(settings.relative_temperature, true),
                        );
                        put("IncrementalTint", number(settings.relative_tint, true));
                    }
                } else {
                    not_written.push("relativeTemperature".into());
                    not_written.push("relativeTint".into());
                }
            }
        }
    }
    for key in &SCALAR_KEYS {
        if !on(key.group) {
            continue;
        }
        let v = key.field.value(settings);
        // Lightroom stores its ten basic sliders as integers.  A migrated or
        // API-created DevelopSettings can still contain a fractional value,
        // so round at the XMP boundary instead of emitting a value that the
        // reader will reject and silently move to legacySettings.
        let v = if key.field.is_integer_slider() {
            libm::round(v)
        } else {
            v
        };
        put(key.xmp, number(v, key.range.0 < 0.0));
    }
    // Noise reduction: a signed RAW engine always carries its R209 color NR
    // (and the retained detail / smoothness); any engine with a v6 `detail`
    // object carries what it renders (its explicit color NR, else the
    // legacy amount on a signed RAW engine, else 0) plus luminance NR. An
    // edit without `detail` on another engine renders no NR, so its preset
    // bytes stay unchanged. Camera Raw's XMP schema defines these as Integer:
    // https://developer.adobe.com/xmp/docs/xmp-namespaces/crs/
    let legacy_raw_cnr = super::detail::renders_legacy_raw_cnr(&settings.engine);
    if on(XmpGroup::NoiseReduction) && (legacy_raw_cnr || settings.detail.is_some()) {
        let color = settings
            .detail
            .and_then(|detail| detail.color_noise_reduction)
            .unwrap_or_else(|| super::detail::effective_color_noise_reduction(settings));
        if let Some(detail) = settings.detail {
            put(
                "LuminanceSmoothing",
                number(libm::round(detail.luminance_noise_reduction), false),
            );
        }
        for (key, value) in [
            ("ColorNoiseReduction", color),
            (
                "ColorNoiseReductionDetail",
                settings.color_noise_reduction_detail,
            ),
            (
                "ColorNoiseReductionSmoothness",
                settings.color_noise_reduction_smoothness,
            ),
        ] {
            put(key, number(libm::round(value), false));
        }
    }
    // Sharpening exists only with v6 `detail`; an edit without it renders
    // none and writes nothing (the bytes of existing presets stay). The
    // radius is Real in Camera Raw's schema, the others Integer.
    if let Some(detail) = settings.detail.filter(|_| on(XmpGroup::Sharpening)) {
        let sharpening = detail.sharpening;
        put("Sharpness", number(libm::round(sharpening.amount), false));
        put(
            "SharpenRadius",
            format!("{:+.1}", libm::round(sharpening.radius * 10.0) / 10.0),
        );
        put(
            "SharpenDetail",
            number(libm::round(sharpening.detail), false),
        );
        put(
            "SharpenEdgeMasking",
            number(libm::round(sharpening.masking), false),
        );
    }
    if on(XmpGroup::Hsl) {
        for component in 0..HSL_PREFIXES.len() {
            for band in HslBand::ALL {
                let a = settings.hsl.get(band).unwrap_or_default();
                let v = [a.hue, a.saturation, a.luminance][component];
                put(&hsl_key(component, band), number(v, true));
            }
        }
    }
    let mut curves: Vec<(&str, Vec<(i64, i64)>)> = Vec::new();
    if on(XmpGroup::ToneCurve) {
        for (element, channel) in CURVE_MAP {
            let points = grid_points(&settings.tone_curves, channel);
            curves.push((element.trim_start_matches("crs:"), points));
        }
        if curves
            .iter()
            .any(|(_, points)| points.iter().any(|(x, y)| x != y))
        {
            put("ToneCurveName2012", "Custom".into());
        }
    }
    for key in EFFECT_KEYS {
        let field = key.field;
        if !on(XmpGroup::of_effect(field.group())) {
            continue;
        }
        // An absent seed is the renderer's fixed default.  Lightroom presets
        // must carry the value so applying one replaces an existing seed
        // instead of preserving it from the target photo.
        let v = field
            .value(settings)
            .or_else(|| (field == EffectField::GrainSeed).then_some(GRAIN_DEFAULT_SEED as f64));
        let Some(v) = v else { continue };
        let text = match field.range() {
            None if field == EffectField::Grayscale => {
                if v != 0.0 { "True" } else { "False" }.to_string()
            }
            None => number(v, false),
            Some(range) => number(v, range.0 < 0.0),
        };
        put(key.xmp, text);
    }
    if on(XmpGroup::Transform) {
        // Every slider, the identity's too (applying the preset sets them),
        // and the kept Upright mode.
        let geometry = settings.geometry.clone().unwrap_or_default();
        for field in PerspectiveField::ALL {
            let (lo, _) = field.range();
            put(
                field.xmp(),
                number(field.get(&geometry.perspective), lo < 0.0),
            );
        }
        put("PerspectiveUpright", number(geometry.upright, false));
        put(
            "CropConstrainToWarp",
            if geometry.constrain { "1" } else { "0" }.into(),
        );
    }
    if on(XmpGroup::Lens) {
        // Lightroom keeps these as integers; the fringe amounts on its
        // 0..20 scale (NIHO's 0..100 / 5).
        let lens = &settings.lens;
        let int = |v: f64, signed: bool| number(libm::round(v), signed);
        put("LensManualDistortionAmount", int(lens.distortion, true));
        put("VignetteAmount", int(lens.vignetting, true));
        put("VignetteMidpoint", int(lens.vignetting_midpoint, false));
        put(
            "AutoLateralCA",
            if lens.remove_chromatic_aberration {
                "1"
            } else {
                "0"
            }
            .into(),
        );
        for (prefix, band) in [
            ("DefringePurple", &lens.defringe.purple),
            ("DefringeGreen", &lens.defringe.green),
        ] {
            put(
                &format!("{prefix}Amount"),
                int(band.amount / super::lens::DEFRINGE_AMOUNT_SCALE, false),
            );
            put(&format!("{prefix}HueLo"), int(band.hue_lo, false));
            put(&format!("{prefix}HueHi"), int(band.hue_hi, false));
        }
    }
    if settings.legacy_settings.is_some() {
        not_written.push("legacySettings".into());
    }
    if !settings.color_points.is_empty() {
        // Do not fabricate Adobe's private crs:PointColors representation.
        // The API/UI surfaces `notWritten` to the person exporting.
        not_written.push("colorPoints".into());
    }
    if !settings.masks.is_empty() {
        // Local masks have no preset representation here (Lightroom's
        // MaskGroupBasedCorrections are read in M6, #69, never written).
        not_written.push("masks".into());
    }
    if !settings.heal.is_empty() {
        // Heal marks are photo-specific and never part of an XMP preset.
        not_written.push("heal".into());
    }

    let monochrome = on(XmpGroup::BlackAndWhite) && settings.grayscale;
    let uuid = options
        .uuid
        .clone()
        .unwrap_or_else(|| content_uuid(&options.name, &attributes, &curves));
    let mut all: Vec<(String, String)> = vec![
        ("PresetType".into(), "Normal".into()),
        ("UUID".into(), uuid),
        ("SupportsAmount".into(), "True".into()),
        (
            "SupportsColor".into(),
            if monochrome { "False" } else { "True" }.into(),
        ),
        // Lightroom presets are valid for both color and monochrome photos;
        // `SupportsColor` carries the distinction for a grayscale preset.
        ("SupportsMonochrome".into(), "True".into()),
        ("Version".into(), XMP_CAMERA_RAW_VERSION.into()),
        ("ProcessVersion".into(), XMP_PROCESS_VERSION.into()),
    ];
    all.extend(attributes);
    all.push(("HasSettings".into(), "True".into()));

    let mut x = String::new();
    x.push_str("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n");
    x.push_str(" <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n");
    x.push_str("  <rdf:Description rdf:about=\"\"\n");
    x.push_str("    xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"");
    for (k, v) in &all {
        x.push_str(&format!("\n   crs:{k}=\"{}\"", escape(v)));
    }
    x.push_str(">\n");
    x.push_str("   <crs:Name>\n    <rdf:Alt>\n");
    x.push_str(&format!(
        "     <rdf:li xml:lang=\"x-default\">{}</rdf:li>\n",
        escape(&options.name)
    ));
    x.push_str("    </rdf:Alt>\n   </crs:Name>\n");
    for (element, points) in &curves {
        x.push_str(&format!("   <crs:{element}>\n    <rdf:Seq>\n"));
        for (px, py) in points {
            x.push_str(&format!("     <rdf:li>{px}, {py}</rdf:li>\n"));
        }
        x.push_str(&format!("    </rdf:Seq>\n   </crs:{element}>\n"));
    }
    x.push_str("  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n");
    XmpWriteResult {
        xmp: x,
        not_written,
    }
}
