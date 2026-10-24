//! Lightroom / Camera Raw XMP presets: a port of Photo Bench
//! `XMPPresetParser` (XMP -> `EditSettings`, the Lightroom-style patch
//! `XMPPreset.applying(to:)`, and the per-key compatibility table) plus the
//! engine's `presetSettings` naming (`XMPPresetNameReader`).
//!
//! The result goes through the same versioned converter as saved Photo
//! Bench settings (`convert.rs`), so a preset and a migrated photo land on
//! identical `developSettings`. Levels are reported as `exact` (Photo Bench
//! "対応" and rendered the same way here), `approximate`, `unsupported` or
//! `metadata`. Differences from Photo Bench's table, all by spec: a custom
//! (absolute) white balance is `approximate` (on a RAW, stage 2 applies the
//! working copy's white-balance table when it has one and otherwise adapts
//! from the as-shot white, so it depends on the photo), `CameraProfile =
//! Adobe Color` is `approximate` (the NIHO look
//! replaces Adobe Color), and an out-of-range value that Photo Bench clamps is
//! reported `approximate` instead of silently clamped. One difference in the
//! settings themselves: `WhiteBalance="Custom"` without `Temperature` /
//! `Tint` is Lightroom's fixed 5001 K / +10 ([`LIGHTROOM_CUSTOM_WHITE`]);
//! Photo Bench renders it as shot.  When non-zero `IncrementalTemperature` /
//! `IncrementalTint` are present instead, the converter produces calibrated
//! `niho-2` relative white balance.
//!
//! NIHO effects (#17120 E1: black & white, the post-crop vignette, grain;
//! [`EFFECT_KEYS`]) are not in Photo Bench, so they bypass its parser and the
//! converter (`CONVERTER_VERSION` is unchanged): the keys an XMP carries
//! replace the base's values, and each is `exact` when it has no effect and
//! `approximate` (NIHO's formula) when it has.

use crate::convert::{
    convert_edit_settings, to_edit_settings_value, ConvertIssue, CONVERTER_VERSION,
};
use crate::geometry::{Geometry, PerspectiveField, MAX_UPRIGHT};
use crate::local_mask::{masks_value, LocalMask};
use crate::settings::{
    num, CalibrationSettings, ColorGradingSettings, CurveChannel, CurvePoint, DevelopSettings,
    HslAdjustment, HslBand, ToneCurve, VignetteStyle, ENGINE_NIHO_10, ENGINE_NIHO_11,
    ENGINE_NIHO_12, ENGINE_NIHO_13, ENGINE_NIHO_14, ENGINE_NIHO_2, ENGINE_NIHO_3, ENGINE_NIHO_4,
    ENGINE_NIHO_5, ENGINE_NIHO_6, ENGINE_NIHO_7, ENGINE_NIHO_8, GRAIN_SEED_MAX,
};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt;

mod amount;
mod detail;
mod lens;
mod masks;
mod write;

pub use amount::{apply_preset, PRESET_AMOUNT_MAX};
pub use detail::DETAIL_KEYS;
pub use lens::LENS_KEYS;
pub use masks::LOCAL_CORRECTION_LISTS;
pub use write::{
    settings_to_xmp, XmpGroup, XmpWriteOptions, XmpWriteResult, XMP_CAMERA_RAW_VERSION,
    XMP_PROCESS_VERSION,
};

/// A preset compiled into the crate. NIHO ships three of Photo Bench's four
/// (owner decision 2026-09-28: bluesky2, pastel and colorful; night is not
/// bundled and only used as a parser test fixture).
#[derive(Debug, Clone, Copy)]
pub struct BuiltinPreset {
    pub id: &'static str,
    pub name: &'static str,
    pub xmp: &'static str,
}

pub const BUILTIN_PRESETS: [BuiltinPreset; 3] = [
    BuiltinPreset {
        id: "niho-bluesky2",
        name: "bluesky2",
        xmp: include_str!("../presets/niho-bluesky2.xmp"),
    },
    BuiltinPreset {
        id: "niho-pastel",
        name: "pastel",
        xmp: include_str!("../presets/niho-pastel.xmp"),
    },
    BuiltinPreset {
        id: "niho-colorful",
        name: "colorful",
        xmp: include_str!("../presets/niho-colorful.xmp"),
    },
];

/// Looks a bundled preset up by id.
pub fn builtin_preset(id: &str) -> Option<&'static BuiltinPreset> {
    BUILTIN_PRESETS.iter().find(|p| p.id == id)
}

#[derive(Debug, Clone, PartialEq)]
pub enum XmpError {
    /// XML could not be parsed (`presetInvalid`).
    InvalidXml(String),
    /// No Camera Raw settings at all (`presetInvalid`).
    NoSettings,
    /// A preset amount outside 0..1.5 (0..150%) or not finite
    /// ([`apply_preset`]).
    InvalidAmount(f64),
}

impl fmt::Display for XmpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            XmpError::InvalidXml(m) => write!(f, "XMP を読めません: {m}"),
            XmpError::NoSettings => write!(f, "XMP に Camera Raw の設定がありません"),
            XmpError::InvalidAmount(a) => {
                write!(f, "適用量は 0〜1.5（0〜150%）の有限数です: {a}")
            }
        }
    }
}

impl std::error::Error for XmpError {}

/// Raw `crs` contents of one XMP document.
#[derive(Debug, Clone, Default)]
pub struct XmpDocument {
    /// Root `rdf:Description` properties (attributes and simple elements).
    pub properties: BTreeMap<String, String>,
    /// Nested descriptions (an embedded `crs:Look`).
    pub nested: BTreeMap<String, String>,
    /// Root point curves keyed by qualified element name, 0..1 points.
    pub sequences: BTreeMap<String, Vec<CurvePoint>>,
    /// `crs:Name` (`x-default`, else the first alternative).
    pub name: Option<String>,
    /// Adobe's private `crs:PointColors` payload was present in an attribute,
    /// element, or nested description. NIHO never guesses its encoding.
    pub point_colors: bool,
    /// Lightroom's local correction lists ([`LOCAL_CORRECTION_LISTS`], e.g.
    /// `crs:MaskGroupBasedCorrections`) of the root description, each as its
    /// element tree. Their nested descriptions repeat the same keys per
    /// correction, so they never enter `properties` / `nested` (they used to
    /// show up as `Look.*`); `masks.rs` reads them into `masks`.
    pub local_corrections: Vec<XmlNode>,
}

/// One XML element of a local correction list: qualified name, attributes
/// (qualified names, unescaped values), text and child elements.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct XmlNode {
    pub name: String,
    pub attributes: Vec<(String, String)>,
    pub text: String,
    pub children: Vec<XmlNode>,
}

/// Builds the tree of one local correction list while [`parse`] reads it.
struct CorrectionCapture {
    /// The open elements, the list itself first.
    open: Vec<XmlNode>,
}

impl CorrectionCapture {
    fn start(&mut self, name: String, attributes: Vec<(String, String)>) {
        self.open.push(XmlNode {
            name,
            attributes,
            ..XmlNode::default()
        });
    }

    /// Closes an element inside the list (never the list itself).
    fn end(&mut self) {
        if self.open.len() > 1 {
            let node = self.open.pop().expect("open element");
            self.open
                .last_mut()
                .expect("parent element")
                .children
                .push(node);
        }
    }

    fn text(&mut self, s: &str) {
        if let Some(node) = self.open.last_mut() {
            node.text.push_str(s);
        }
    }

    /// The list element itself is the only one open.
    fn at_list(&self) -> bool {
        self.open.len() == 1
    }
}

const CURVE_MAP: [(&str, CurveChannel); 4] = [
    ("crs:ToneCurvePV2012", CurveChannel::Rgb),
    ("crs:ToneCurvePV2012Red", CurveChannel::Red),
    ("crs:ToneCurvePV2012Green", CurveChannel::Green),
    ("crs:ToneCurvePV2012Blue", CurveChannel::Blue),
];

fn curve_channel(qualified: &str) -> Option<CurveChannel> {
    CURVE_MAP
        .iter()
        .find(|(k, _)| *k == qualified)
        .map(|(_, c)| *c)
}

struct ActiveSimple {
    qualified: String,
    property: String,
    depth: usize,
    root: bool,
    text: String,
    has_child: bool,
}

/// Parses XMP text the way Photo Bench's `XMPDelegate` does.
pub fn parse(text: &str) -> Result<XmpDocument, XmpError> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(false);
    let mut doc = XmpDocument::default();
    let mut description_depth: usize = 0;
    let mut stack: Vec<String> = Vec::new();
    let mut active: Vec<ActiveSimple> = Vec::new();
    let mut active_sequence: Option<String> = None;
    let mut in_li = false;
    let mut li_text = String::new();
    // Name reader state.
    let mut name_depth: Option<usize> = None;
    let mut name_item: Option<(Option<String>, String)> = None;
    let mut names: Vec<(Option<String>, String)> = Vec::new();
    let mut depth_counter: usize = 0;
    // A local correction list being read (its inside is only an element
    // tree: no properties, nested descriptions, curves or names).
    let mut capture: Option<CorrectionCapture> = None;

    loop {
        let event = reader
            .read_event()
            .map_err(|e| XmpError::InvalidXml(e.to_string()))?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let is_empty = matches!(event, Event::Empty(_));
                let qualified = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if qualified == "crs:PointColors" {
                    doc.point_colors = true;
                }
                let mut attributes: Vec<(String, String)> = Vec::new();
                for attribute in e.attributes() {
                    let attribute =
                        attribute.map_err(|err| XmpError::InvalidXml(err.to_string()))?;
                    let key = String::from_utf8_lossy(attribute.key.as_ref()).into_owned();
                    let value = attribute
                        .unescape_value()
                        .map_err(|err| XmpError::InvalidXml(err.to_string()))?
                        .into_owned();
                    attributes.push((key, value));
                }
                if attributes.iter().any(|(key, _)| key == "crs:PointColors") {
                    doc.point_colors = true;
                }
                if let Some(list) = capture.as_mut() {
                    list.start(qualified, attributes);
                    if is_empty {
                        list.end();
                    }
                    continue;
                }
                // --- start ---
                let parent = stack.last().cloned();
                for a in active.iter_mut() {
                    a.has_child = true;
                }
                if qualified == "rdf:Description" {
                    description_depth += 1;
                }
                if qualified == "rdf:Description" {
                    let target = if description_depth == 1 {
                        &mut doc.properties
                    } else {
                        &mut doc.nested
                    };
                    for (key, value) in &attributes {
                        if let Some(stripped) = key.strip_prefix("crs:") {
                            target.insert(stripped.to_string(), value.clone());
                        }
                    }
                }
                stack.push(qualified.clone());
                if parent.as_deref() == Some("rdf:Description") && qualified.starts_with("crs:") {
                    active.push(ActiveSimple {
                        qualified: qualified.clone(),
                        property: qualified[4..].to_string(),
                        depth: stack.len(),
                        root: description_depth == 1,
                        text: String::new(),
                        has_child: false,
                    });
                }
                if parent.as_deref() == Some("rdf:Description")
                    && description_depth == 1
                    && LOCAL_CORRECTION_LISTS.contains(&qualified.as_str())
                {
                    // Not a simple property, whatever it holds.
                    if let Some(simple) = active.last_mut() {
                        simple.has_child = true;
                    }
                    let list = XmlNode {
                        name: qualified.clone(),
                        attributes: attributes.clone(),
                        ..XmlNode::default()
                    };
                    if is_empty {
                        doc.local_corrections.push(list);
                    } else {
                        capture = Some(CorrectionCapture { open: vec![list] });
                    }
                }
                if curve_channel(&qualified).is_some() && description_depth == 1 {
                    active_sequence = Some(qualified.clone());
                    doc.sequences.insert(qualified.clone(), Vec::new());
                }
                if qualified == "rdf:li" && active_sequence.is_some() {
                    in_li = true;
                    li_text.clear();
                }
                // Name reader (`XMPPresetNameReader`).
                depth_counter += 1;
                if name_depth.is_none() && qualified == "crs:Name" && description_depth == 1 {
                    name_depth = Some(depth_counter);
                } else if name_depth.is_some() && qualified == "rdf:li" {
                    let lang = attributes
                        .iter()
                        .find(|(k, _)| k == "xml:lang")
                        .map(|(_, v)| v.clone());
                    name_item = Some((lang, String::new()));
                }
                if is_empty {
                    end_element(
                        &qualified,
                        &mut doc,
                        &mut description_depth,
                        &mut stack,
                        &mut active,
                        &mut active_sequence,
                        &mut in_li,
                        &mut li_text,
                    );
                    end_name(
                        &qualified,
                        &mut name_depth,
                        &mut name_item,
                        &mut names,
                        &mut depth_counter,
                    );
                }
            }
            Event::End(ref e) => {
                let qualified = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if let Some(list) = capture.as_mut() {
                    if !list.at_list() {
                        list.end();
                        continue;
                    }
                    let mut finished = capture.take().expect("capture");
                    doc.local_corrections
                        .push(finished.open.pop().expect("list element"));
                }
                end_element(
                    &qualified,
                    &mut doc,
                    &mut description_depth,
                    &mut stack,
                    &mut active,
                    &mut active_sequence,
                    &mut in_li,
                    &mut li_text,
                );
                end_name(
                    &qualified,
                    &mut name_depth,
                    &mut name_item,
                    &mut names,
                    &mut depth_counter,
                );
            }
            Event::Text(ref e) => {
                let s = e
                    .unescape()
                    .map_err(|err| XmpError::InvalidXml(err.to_string()))?;
                if let Some(list) = capture.as_mut() {
                    list.text(&s);
                    continue;
                }
                characters(&s, &stack, &mut active, in_li, &mut li_text, &mut name_item);
            }
            Event::CData(ref e) => {
                let s = String::from_utf8_lossy(e.as_ref()).into_owned();
                if let Some(list) = capture.as_mut() {
                    list.text(&s);
                    continue;
                }
                characters(&s, &stack, &mut active, in_li, &mut li_text, &mut name_item);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(XmpError::InvalidXml("unclosed element".into()));
    }
    let chosen = names
        .iter()
        .find(|(lang, _)| lang.as_deref() == Some("x-default"))
        .or_else(|| names.first());
    doc.name = chosen.map(|(_, t)| t.clone());
    Ok(doc)
}

fn characters(
    s: &str,
    stack: &[String],
    active: &mut [ActiveSimple],
    in_li: bool,
    li_text: &mut String,
    name_item: &mut Option<(Option<String>, String)>,
) {
    for a in active.iter_mut() {
        if a.depth == stack.len() && !a.has_child {
            a.text.push_str(s);
        }
    }
    if in_li {
        li_text.push_str(s);
    }
    if let Some((_, text)) = name_item.as_mut() {
        text.push_str(s);
    }
}

#[allow(clippy::too_many_arguments)]
fn end_element(
    qualified: &str,
    doc: &mut XmpDocument,
    description_depth: &mut usize,
    stack: &mut Vec<String>,
    active: &mut Vec<ActiveSimple>,
    active_sequence: &mut Option<String>,
    in_li: &mut bool,
    li_text: &mut String,
) {
    if let Some(index) = active
        .iter()
        .rposition(|a| a.qualified == qualified && a.depth == stack.len())
    {
        let element = active.remove(index);
        let value = element.text.trim().to_string();
        if !element.has_child && !value.is_empty() {
            if element.root {
                doc.properties.insert(element.property, value);
            } else {
                doc.nested.insert(element.property, value);
            }
        }
    }
    if qualified == "rdf:li" {
        if let Some(sequence) = active_sequence.as_ref() {
            let parts: Vec<f64> = li_text
                .split(',')
                .filter_map(|p| swift_double(p.trim()))
                .collect();
            if parts.len() == 2 && parts.iter().all(|p| p.is_finite()) {
                doc.sequences
                    .entry(sequence.clone())
                    .or_default()
                    .push(CurvePoint {
                        x: (parts[0] / 255.0).clamp(0.0, 1.0),
                        y: (parts[1] / 255.0).clamp(0.0, 1.0),
                    });
            }
            *in_li = false;
            li_text.clear();
        }
    }
    if curve_channel(qualified).is_some() {
        *active_sequence = None;
    }
    if qualified == "rdf:Description" {
        *description_depth = description_depth.saturating_sub(1);
    }
    if stack.last().map(String::as_str) == Some(qualified) {
        stack.pop();
    }
}

fn end_name(
    qualified: &str,
    name_depth: &mut Option<usize>,
    name_item: &mut Option<(Option<String>, String)>,
    names: &mut Vec<(Option<String>, String)>,
    depth_counter: &mut usize,
) {
    if qualified == "rdf:li" {
        if let Some((lang, text)) = name_item.take() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                names.push((lang, trimmed.to_string()));
            }
        }
    }
    if Some(*depth_counter) == *name_depth {
        *name_depth = None;
    }
    *depth_counter = depth_counter.saturating_sub(1);
}

/// Swift `Double(String)`: no surrounding whitespace, optional sign.
fn swift_double(s: &str) -> Option<f64> {
    if s.is_empty() || s.trim() != s {
        return None;
    }
    s.parse::<f64>().ok()
}

/// Lightroom's white balance for a preset with `WhiteBalance="Custom"` and
/// neither `Temperature` nor `Tint` (nor incremental values): the absolute
/// 5001 K / +10 on every photo (all five round5 exports of bluesky2, read from
/// the exported JPEGs' XMP; S9 #16999). Photo Bench renders it as shot.
pub const LIGHTROOM_CUSTOM_WHITE: (f64, f64) = (5001.0, 10.0);
const LIGHTROOM_CUSTOM_WHITE_NOTE: &str =
    "値の無い Custom は Lightroom と同じ 5001K / +10（RAW は機種の白の表があれば Apple と同じ計算、無ければ撮影時の白からの色順応で近似。非 RAW は保持のみ）";
/// A custom (absolute) white's note: exact on a RAW whose working copy has
/// the model's white-balance table (S11 #17108), approximated otherwise.
const CUSTOM_ABSOLUTE_WHITE_NOTE: &str =
    "RAW は機種の白の表があれば Apple と同じ計算、無ければ撮影時の白からの色順応で近似（非 RAW は保持のみ）";

/// Photo Bench `WhiteBalanceMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PbWhiteBalanceMode {
    AsShot,
    Custom,
    Unknown,
}

/// Photo Bench `EditSettings`, field for field (JSON via [`Self::to_value`]).
#[derive(Debug, Clone, PartialEq)]
pub struct PbEditSettings {
    pub exposure: f64,
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub whites: f64,
    pub blacks: f64,
    pub vibrance: f64,
    pub saturation: f64,
    pub relative_temperature: f64,
    pub relative_tint: f64,
    pub wb_mode: PbWhiteBalanceMode,
    pub temperature: Option<f64>,
    pub tint: Option<f64>,
    pub incremental_temperature: Option<f64>,
    pub incremental_tint: Option<f64>,
    pub tone_curves: Vec<ToneCurve>,
    pub hsl: BTreeMap<HslBand, HslAdjustment>,
    pub calibration: CalibrationSettings,
    pub color_grading: ColorGradingSettings,
    pub parametric_shadows: f64,
    pub parametric_darks: f64,
    pub parametric_lights: f64,
    pub parametric_highlights: f64,
    pub parametric_shadow_split: f64,
    pub parametric_midtone_split: f64,
    pub parametric_highlight_split: f64,
    pub curve_refine_saturation: f64,
    pub texture: f64,
    pub clarity: f64,
    pub dehaze: f64,
}

impl PbEditSettings {
    pub fn neutral() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
            vibrance: 0.0,
            saturation: 0.0,
            relative_temperature: 0.0,
            relative_tint: 0.0,
            wb_mode: PbWhiteBalanceMode::AsShot,
            temperature: None,
            tint: None,
            incremental_temperature: None,
            incremental_tint: None,
            tone_curves: Vec::new(),
            hsl: BTreeMap::new(),
            calibration: CalibrationSettings::default(),
            color_grading: ColorGradingSettings::default(),
            parametric_shadows: 0.0,
            parametric_darks: 0.0,
            parametric_lights: 0.0,
            parametric_highlights: 0.0,
            parametric_shadow_split: 25.0,
            parametric_midtone_split: 50.0,
            parametric_highlight_split: 75.0,
            curve_refine_saturation: 100.0,
            texture: 0.0,
            clarity: 0.0,
            dehaze: 0.0,
        }
    }

    /// Lenient read of `EditSettings` JSON (`decodeIfPresent` defaults).
    pub fn from_value(value: &Value) -> Self {
        let mut s = Self::neutral();
        let Some(o) = value.as_object() else {
            return s;
        };
        let n = |key: &str, default: f64| o.get(key).and_then(Value::as_f64).unwrap_or(default);
        s.exposure = n("exposure", 0.0);
        s.contrast = n("contrast", 0.0);
        s.highlights = n("highlights", 0.0);
        s.shadows = n("shadows", 0.0);
        s.whites = n("whites", 0.0);
        s.blacks = n("blacks", 0.0);
        s.vibrance = n("vibrance", 0.0);
        s.saturation = n("saturation", 0.0);
        s.relative_temperature = n("relativeTemperature", 0.0);
        s.relative_tint = n("relativeTint", 0.0);
        s.parametric_shadows = n("parametricShadows", 0.0);
        s.parametric_darks = n("parametricDarks", 0.0);
        s.parametric_lights = n("parametricLights", 0.0);
        s.parametric_highlights = n("parametricHighlights", 0.0);
        s.parametric_shadow_split = n("parametricShadowSplit", 25.0);
        s.parametric_midtone_split = n("parametricMidtoneSplit", 50.0);
        s.parametric_highlight_split = n("parametricHighlightSplit", 75.0);
        s.curve_refine_saturation = n("curveRefineSaturation", 100.0);
        s.texture = n("texture", 0.0);
        s.clarity = n("clarity", 0.0);
        s.dehaze = n("dehaze", 0.0);
        if let Some(wb) = o.get("whiteBalance").and_then(Value::as_object) {
            s.wb_mode = match wb.get("mode").and_then(Value::as_str) {
                Some("custom") => PbWhiteBalanceMode::Custom,
                Some("unknown") => PbWhiteBalanceMode::Unknown,
                _ => PbWhiteBalanceMode::AsShot,
            };
            s.temperature = wb.get("temperature").and_then(Value::as_f64);
            s.tint = wb.get("tint").and_then(Value::as_f64);
            s.incremental_temperature = wb.get("incrementalTemperature").and_then(Value::as_f64);
            s.incremental_tint = wb.get("incrementalTint").and_then(Value::as_f64);
        }
        if let Some(curves) = o
            .get("toneCurves")
            .and_then(|v| crate::settings::parse_tone_curves(v).ok())
        {
            s.tone_curves = curves;
        }
        if let Some(hsl) = o
            .get("hsl")
            .and_then(|v| crate::settings::parse_hsl(v).ok())
        {
            s.hsl = hsl.entries().iter().copied().collect();
        }
        if let Some(c) = o
            .get("calibration")
            .and_then(|v| crate::settings::parse_calibration(v).ok())
        {
            s.calibration = c;
        }
        if let Some(g) = o
            .get("colorGrading")
            .and_then(|v| crate::settings::parse_color_grading(v).ok())
        {
            s.color_grading = g;
        }
        s
    }

    /// JSON exactly as Photo Bench's `JSONEncoder` writes it (every key; the
    /// optional white balance values only when present; `hsl` alternating).
    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        for (k, v) in [
            ("exposure", self.exposure),
            ("contrast", self.contrast),
            ("highlights", self.highlights),
            ("shadows", self.shadows),
            ("whites", self.whites),
            ("blacks", self.blacks),
            ("vibrance", self.vibrance),
            ("saturation", self.saturation),
            ("relativeTemperature", self.relative_temperature),
            ("relativeTint", self.relative_tint),
        ] {
            o.insert(k.into(), num(v));
        }
        let mut wb = Map::new();
        wb.insert(
            "mode".into(),
            Value::from(match self.wb_mode {
                PbWhiteBalanceMode::AsShot => "asShot",
                PbWhiteBalanceMode::Custom => "custom",
                PbWhiteBalanceMode::Unknown => "unknown",
            }),
        );
        for (k, v) in [
            ("temperature", self.temperature),
            ("tint", self.tint),
            ("incrementalTemperature", self.incremental_temperature),
            ("incrementalTint", self.incremental_tint),
        ] {
            if let Some(v) = v {
                wb.insert(k.into(), num(v));
            }
        }
        o.insert("whiteBalance".into(), Value::Object(wb));
        let mut dev = DevelopSettings::neutral();
        dev.tone_curves = self.tone_curves.clone();
        for (band, a) in &self.hsl {
            dev.hsl.set(*band, *a);
        }
        dev.calibration = self.calibration;
        dev.color_grading = self.color_grading.clone();
        let dev_value = dev.to_value();
        for key in ["toneCurves", "hsl", "calibration", "colorGrading"] {
            o.insert(key.into(), dev_value[key].clone());
        }
        for (k, v) in [
            ("parametricShadows", self.parametric_shadows),
            ("parametricDarks", self.parametric_darks),
            ("parametricLights", self.parametric_lights),
            ("parametricHighlights", self.parametric_highlights),
            ("parametricShadowSplit", self.parametric_shadow_split),
            ("parametricMidtoneSplit", self.parametric_midtone_split),
            ("parametricHighlightSplit", self.parametric_highlight_split),
            ("curveRefineSaturation", self.curve_refine_saturation),
            ("texture", self.texture),
            ("clarity", self.clarity),
            ("dehaze", self.dehaze),
        ] {
            o.insert(k.into(), num(v));
        }
        Value::Object(o)
    }
}

// MARK: - Scalar keys (the one table for reading and writing XMP)

/// Defines [`ScalarField`] from `Variant => field.path` pairs, with the
/// same path on Photo Bench's `EditSettings` ([`PbEditSettings`]) and on
/// `developSettings` ([`DevelopSettings`]).
macro_rules! scalar_fields {
    ($($variant:ident => $($field:ident).+),+ $(,)?) => {
        /// A numeric Camera Raw control that `EditSettings` and
        /// `developSettings` share (same name, same unit).
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum ScalarField {
            $($variant),+
        }

        impl ScalarField {
            /// The control's value in `developSettings`.
            pub fn value(self, s: &DevelopSettings) -> f64 {
                match self {
                    $(ScalarField::$variant => s.$($field).+),+
                }
            }

            /// The control's slot in `developSettings`.
            pub fn value_mut(self, s: &mut DevelopSettings) -> &mut f64 {
                match self {
                    $(ScalarField::$variant => &mut s.$($field).+),+
                }
            }

            fn pb_value(self, s: &PbEditSettings) -> f64 {
                match self {
                    $(ScalarField::$variant => s.$($field).+),+
                }
            }

            fn pb_mut(self, s: &mut PbEditSettings) -> &mut f64 {
                match self {
                    $(ScalarField::$variant => &mut s.$($field).+),+
                }
            }
        }
    };
}

scalar_fields! {
    Exposure => exposure,
    Contrast => contrast,
    Highlights => highlights,
    Shadows => shadows,
    Whites => whites,
    Blacks => blacks,
    Texture => texture,
    Clarity => clarity,
    Dehaze => dehaze,
    Vibrance => vibrance,
    Saturation => saturation,
    ParametricShadows => parametric_shadows,
    ParametricDarks => parametric_darks,
    ParametricLights => parametric_lights,
    ParametricHighlights => parametric_highlights,
    ParametricShadowSplit => parametric_shadow_split,
    ParametricMidtoneSplit => parametric_midtone_split,
    ParametricHighlightSplit => parametric_highlight_split,
    CurveRefineSaturation => curve_refine_saturation,
    ShadowTint => calibration.shadow_tint,
    RedHue => calibration.red_hue,
    RedSaturation => calibration.red_saturation,
    GreenHue => calibration.green_hue,
    GreenSaturation => calibration.green_saturation,
    BlueHue => calibration.blue_hue,
    BlueSaturation => calibration.blue_saturation,
    ShadowGradeHue => color_grading.shadow.hue,
    ShadowGradeSaturation => color_grading.shadow.saturation,
    ShadowGradeLuminance => color_grading.shadow.luminance,
    MidtoneGradeHue => color_grading.midtone.hue,
    MidtoneGradeSaturation => color_grading.midtone.saturation,
    MidtoneGradeLuminance => color_grading.midtone.luminance,
    HighlightGradeHue => color_grading.highlight.hue,
    HighlightGradeSaturation => color_grading.highlight.saturation,
    HighlightGradeLuminance => color_grading.highlight.luminance,
    GlobalGradeHue => color_grading.global.hue,
    GlobalGradeSaturation => color_grading.global.saturation,
    GlobalGradeLuminance => color_grading.global.luminance,
    GradeBlending => color_grading.blending,
    GradeBalance => color_grading.balance,
}

impl ScalarField {
    /// A color grading wheel angle (0..359, interpolated along the circle).
    pub fn is_grade_hue(self) -> bool {
        matches!(
            self,
            ScalarField::ShadowGradeHue
                | ScalarField::MidtoneGradeHue
                | ScalarField::HighlightGradeHue
                | ScalarField::GlobalGradeHue
        )
    }

    /// One of the ten basic sliders the converter requires as integers
    /// (`convert::INTEGER_SLIDERS`; Lightroom's sliders are integers too).
    pub fn is_integer_slider(self) -> bool {
        matches!(
            self,
            ScalarField::Contrast
                | ScalarField::Highlights
                | ScalarField::Shadows
                | ScalarField::Whites
                | ScalarField::Blacks
                | ScalarField::Texture
                | ScalarField::Clarity
                | ScalarField::Dehaze
                | ScalarField::Vibrance
                | ScalarField::Saturation
        )
    }
}

/// One numeric Camera Raw key of [`SCALAR_KEYS`].
#[derive(Debug, Clone, Copy)]
pub struct ScalarKey {
    /// The `crs` property written (Lightroom's name), and read when
    /// `preferred` is absent from the XMP.
    pub xmp: &'static str,
    /// A property read in preference to `xmp` (Color Grading's own name of
    /// a shadow / highlight wheel that Lightroom writes as split toning).
    pub preferred: Option<&'static str>,
    /// The value when the XMP carries neither key.
    pub default: f64,
    /// The range a read value is clamped into (= `validate`'s range).
    pub range: (f64, f64),
    pub field: ScalarField,
    /// The group of [`settings_to_xmp`] that writes it.
    pub group: XmpGroup,
}

impl ScalarKey {
    /// The properties read, in preference order.
    pub fn read_keys(&self) -> impl Iterator<Item = &'static str> {
        self.preferred.into_iter().chain(std::iter::once(self.xmp))
    }
}

const PM: (f64, f64) = (-100.0, 100.0);
const PCT: (f64, f64) = (0.0, 100.0);
const HUE: (f64, f64) = (0.0, 359.0);

/// Builds [`SCALAR_KEYS`]: `"Property" [prefer "Property"] => field, group,
/// range, default;` per key.
macro_rules! scalar_keys {
    ($($xmp:literal $(prefer $preferred:literal)? => $field:ident, $group:ident, $range:expr, $default:expr;)+) => {
        [$(ScalarKey {
            xmp: $xmp,
            preferred: scalar_keys!(@preferred $($preferred)?),
            default: $default,
            range: $range,
            field: ScalarField::$field,
            group: XmpGroup::$group,
        }),+]
    };
    (@preferred) => { None };
    (@preferred $preferred:literal) => { Some($preferred) };
}

/// Every numeric Camera Raw key that `EditSettings` and `developSettings`
/// share: [`XmpDocument::edit_settings`] and [`XmpDocument::apply_to`] read
/// them and [`settings_to_xmp`] writes them from this one table (HSL, the
/// white balance, the point curves and the NIHO effects have their own).
#[rustfmt::skip]
pub const SCALAR_KEYS: [ScalarKey; 40] = scalar_keys! {
    "Exposure2012"             => Exposure, Exposure, (-5.0, 5.0), 0.0;
    "Contrast2012"             => Contrast, Tone, PM, 0.0;
    "Highlights2012"           => Highlights, Tone, PM, 0.0;
    "Shadows2012"              => Shadows, Tone, PM, 0.0;
    "Whites2012"               => Whites, Tone, PM, 0.0;
    "Blacks2012"               => Blacks, Tone, PM, 0.0;
    "Texture"                  => Texture, Presence, PM, 0.0;
    "Clarity2012"              => Clarity, Presence, PM, 0.0;
    "Dehaze"                   => Dehaze, Presence, PM, 0.0;
    "Vibrance"                 => Vibrance, Presence, PM, 0.0;
    "Saturation"               => Saturation, Presence, PM, 0.0;
    "ParametricShadows"        => ParametricShadows, ToneCurve, PM, 0.0;
    "ParametricDarks"          => ParametricDarks, ToneCurve, PM, 0.0;
    "ParametricLights"         => ParametricLights, ToneCurve, PM, 0.0;
    "ParametricHighlights"     => ParametricHighlights, ToneCurve, PM, 0.0;
    "ParametricShadowSplit"    => ParametricShadowSplit, ToneCurve, PCT, 25.0;
    "ParametricMidtoneSplit"   => ParametricMidtoneSplit, ToneCurve, PCT, 50.0;
    "ParametricHighlightSplit" => ParametricHighlightSplit, ToneCurve, PCT, 75.0;
    "CurveRefineSaturation"    => CurveRefineSaturation, ToneCurve, PCT, 100.0;
    "ShadowTint"               => ShadowTint, Calibration, PM, 0.0;
    "RedHue"                   => RedHue, Calibration, PM, 0.0;
    "RedSaturation"            => RedSaturation, Calibration, PM, 0.0;
    "GreenHue"                 => GreenHue, Calibration, PM, 0.0;
    "GreenSaturation"          => GreenSaturation, Calibration, PM, 0.0;
    "BlueHue"                  => BlueHue, Calibration, PM, 0.0;
    "BlueSaturation"           => BlueSaturation, Calibration, PM, 0.0;
    // Lightroom writes the shadow / highlight wheels as split toning; the
    // Color Grading names win when an XMP has both.
    "SplitToningShadowHue" prefer "ColorGradeShadowHue"
        => ShadowGradeHue, ColorGrading, HUE, 0.0;
    "SplitToningShadowSaturation" prefer "ColorGradeShadowSat"
        => ShadowGradeSaturation, ColorGrading, PCT, 0.0;
    "ColorGradeShadowLum"      => ShadowGradeLuminance, ColorGrading, PM, 0.0;
    "ColorGradeMidtoneHue"     => MidtoneGradeHue, ColorGrading, HUE, 0.0;
    "ColorGradeMidtoneSat"     => MidtoneGradeSaturation, ColorGrading, PCT, 0.0;
    "ColorGradeMidtoneLum"     => MidtoneGradeLuminance, ColorGrading, PM, 0.0;
    "SplitToningHighlightHue" prefer "ColorGradeHighlightHue"
        => HighlightGradeHue, ColorGrading, HUE, 0.0;
    "SplitToningHighlightSaturation" prefer "ColorGradeHighlightSat"
        => HighlightGradeSaturation, ColorGrading, PCT, 0.0;
    "ColorGradeHighlightLum"   => HighlightGradeLuminance, ColorGrading, PM, 0.0;
    "ColorGradeGlobalHue"      => GlobalGradeHue, ColorGrading, HUE, 0.0;
    "ColorGradeGlobalSat"      => GlobalGradeSaturation, ColorGrading, PCT, 0.0;
    "ColorGradeGlobalLum"      => GlobalGradeLuminance, ColorGrading, PM, 0.0;
    "ColorGradeBlending"       => GradeBlending, ColorGrading, PCT, 100.0;
    "SplitToningBalance"       => GradeBalance, ColorGrading, PM, 0.0;
};

/// HSL property prefixes, Lightroom's order (`HueAdjustmentRed` ...).
pub const HSL_PREFIXES: [&str; 3] = [
    "HueAdjustment",
    "SaturationAdjustment",
    "LuminanceAdjustment",
];

/// The `crs` property of one HSL component (0 hue, 1 saturation, 2
/// luminance) of a band.
pub fn hsl_key(component: usize, band: HslBand) -> String {
    format!("{}{}", HSL_PREFIXES[component], band.xmp_suffix())
}

impl XmpDocument {
    fn number(&self, key: &str, default: f64, range: (f64, f64)) -> f64 {
        match self.properties.get(key).and_then(|v| swift_double(v)) {
            Some(v) if v.is_finite() => v.clamp(range.0, range.1),
            _ => default,
        }
    }

    /// A [`SCALAR_KEYS`] value: the first finite of its properties,
    /// clamped into its range, else its default.
    fn scalar(&self, key: &ScalarKey) -> f64 {
        key.read_keys()
            .find_map(|k| self.optional_number(k))
            .map_or(key.default, |v| v.clamp(key.range.0, key.range.1))
    }

    fn optional_number(&self, key: &str) -> Option<f64> {
        self.properties
            .get(key)
            .and_then(|v| swift_double(v))
            .filter(|v| v.is_finite())
    }

    fn has_finite_number(&self, key: &str) -> bool {
        self.optional_number(key).is_some()
    }

    fn white_balance_mode(&self) -> PbWhiteBalanceMode {
        match self.properties.get("WhiteBalance") {
            None => PbWhiteBalanceMode::AsShot,
            Some(v) => match v.trim().to_lowercase().as_str() {
                "as shot" | "asshot" => PbWhiteBalanceMode::AsShot,
                "custom" => PbWhiteBalanceMode::Custom,
                _ => PbWhiteBalanceMode::Unknown,
            },
        }
    }

    /// `XMPDelegate.makePreset`'s settings.
    pub fn edit_settings(&self) -> PbEditSettings {
        let mut s = PbEditSettings::neutral();
        for key in &SCALAR_KEYS {
            *key.field.pb_mut(&mut s) = self.scalar(key);
        }
        s.wb_mode = self.white_balance_mode();
        s.temperature = self.optional_number("Temperature");
        s.tint = self.optional_number("Tint");
        s.incremental_temperature = self.optional_number("IncrementalTemperature");
        s.incremental_tint = self.optional_number("IncrementalTint");
        let mut curves: Vec<ToneCurve> = self
            .sequences
            .iter()
            .filter_map(|(key, points)| {
                let channel = curve_channel(key)?;
                (points.len() >= 2).then(|| ToneCurve {
                    channel,
                    points: points.clone(),
                })
            })
            .collect();
        curves.sort_by(|a, b| a.channel.as_str().cmp(b.channel.as_str()));
        s.tone_curves = curves;
        for band in HslBand::ALL {
            let a = HslAdjustment {
                hue: self.number(&hsl_key(0, band), 0.0, PM),
                saturation: self.number(&hsl_key(1, band), 0.0, PM),
                luminance: self.number(&hsl_key(2, band), 0.0, PM),
            };
            if !a.is_zero() {
                s.hsl.insert(band, a);
            }
        }
        s
    }

    /// `WhiteBalance="Custom"` with no `Temperature` / `Tint` and no
    /// non-zero incremental value: Lightroom's fixed white.
    fn is_custom_without_values(&self) -> bool {
        let zero = |k: &str| self.optional_number(k).unwrap_or(0.0) == 0.0;
        self.white_balance_mode() == PbWhiteBalanceMode::Custom
            && !self.properties.contains_key("Temperature")
            && !self.properties.contains_key("Tint")
            && zero("IncrementalTemperature")
            && zero("IncrementalTint")
    }

    /// `XMPPreset.applying(to:)`: only the controls the XMP carries replace
    /// `base`'s (and a Custom white without values is Lightroom's fixed one).
    pub fn apply_to(&self, base: &PbEditSettings) -> PbEditSettings {
        let parsed = self.edit_settings();
        let mut r = base.clone();
        let has = |k: &str| self.has_finite_number(k);
        macro_rules! patch {
            ($key:expr, $field:ident) => {
                if has($key) {
                    r.$field = parsed.$field;
                }
            };
        }
        for key in &SCALAR_KEYS {
            if key.read_keys().any(has) {
                *key.field.pb_mut(&mut r) = key.field.pb_value(&parsed);
            }
        }
        if self.properties.contains_key("WhiteBalance") {
            r.wb_mode = parsed.wb_mode;
        }
        patch!("Temperature", temperature);
        patch!("Tint", tint);
        patch!("IncrementalTemperature", incremental_temperature);
        patch!("IncrementalTint", incremental_tint);
        let incremental_active = parsed.incremental_temperature.unwrap_or(0.0) != 0.0
            || parsed.incremental_tint.unwrap_or(0.0) != 0.0;
        if self.white_balance_mode() == PbWhiteBalanceMode::Custom
            && incremental_active
            && !self.properties.contains_key("Temperature")
            && !self.properties.contains_key("Tint")
        {
            // An incremental Custom preset names a relative white, not the
            // target photo's previously stored absolute white.
            r.temperature = None;
            r.tint = None;
        }
        if self.is_custom_without_values() && r.temperature.is_none() && r.tint.is_none() {
            (r.temperature, r.tint) = (
                Some(LIGHTROOM_CUSTOM_WHITE.0),
                Some(LIGHTROOM_CUSTOM_WHITE.1),
            );
        }
        for curve in &parsed.tone_curves {
            r.tone_curves.retain(|c| c.channel != curve.channel);
            r.tone_curves.push(curve.clone());
        }
        r.tone_curves
            .sort_by(|a, b| a.channel.as_str().cmp(b.channel.as_str()));
        for band in HslBand::ALL {
            let p = parsed.hsl.get(&band).copied().unwrap_or_default();
            let mut a = r.hsl.get(&band).copied().unwrap_or_default();
            if has(&hsl_key(0, band)) {
                a.hue = p.hue;
            }
            if has(&hsl_key(1, band)) {
                a.saturation = p.saturation;
            }
            if has(&hsl_key(2, band)) {
                a.luminance = p.luminance;
            }
            if a.is_zero() {
                r.hsl.remove(&band);
            } else {
                r.hsl.insert(band, a);
            }
        }
        r
    }
}

// MARK: - NIHO effects (not in Photo Bench)

/// The `developSettings` field of a NIHO effect XMP key ([`EFFECT_KEYS`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectField {
    /// `grayscale` (`"True"` / `"False"`).
    Grayscale,
    /// `grayMixer.<band>`.
    GrayMix(HslBand),
    VignetteAmount,
    VignetteMidpoint,
    VignetteRoundness,
    VignetteFeather,
    /// `vignette.highlights` (rendered for a darkening highlight-priority
    /// vignette, retained otherwise).
    VignetteHighlights,
    /// `vignette.style` (1 = highlightPriority, 2 = colorPriority,
    /// 3 = paintOverlay).
    VignetteStyle,
    GrainAmount,
    GrainSize,
    /// `grain.roughness` (Lightroom's `GrainFrequency`).
    GrainRoughness,
    GrainSeed,
}

/// Which effect group a field belongs to (whether it acts depends on the
/// group's switch: `grayscale`, `vignette.amount`, `grain.amount`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EffectGroup {
    Grayscale,
    Vignette,
    Grain,
}

impl EffectField {
    /// The range a numeric value is clamped into (`None`: not numeric).
    pub fn range(self) -> Option<(f64, f64)> {
        match self {
            EffectField::Grayscale | EffectField::VignetteStyle => None,
            EffectField::GrayMix(_)
            | EffectField::VignetteAmount
            | EffectField::VignetteRoundness => Some((-100.0, 100.0)),
            EffectField::VignetteMidpoint
            | EffectField::VignetteFeather
            | EffectField::VignetteHighlights
            | EffectField::GrainAmount
            | EffectField::GrainSize
            | EffectField::GrainRoughness => Some((0.0, 100.0)),
            EffectField::GrainSeed => Some((0.0, GRAIN_SEED_MAX)),
        }
    }

    fn group(self) -> EffectGroup {
        match self {
            EffectField::Grayscale | EffectField::GrayMix(_) => EffectGroup::Grayscale,
            EffectField::VignetteAmount
            | EffectField::VignetteMidpoint
            | EffectField::VignetteRoundness
            | EffectField::VignetteFeather
            | EffectField::VignetteHighlights
            | EffectField::VignetteStyle => EffectGroup::Vignette,
            EffectField::GrainAmount
            | EffectField::GrainSize
            | EffectField::GrainRoughness
            | EffectField::GrainSeed => EffectGroup::Grain,
        }
    }

    /// The value of an XMP string (numbers clamped into [`Self::range`],
    /// the seed rounded); `None` when the string is not a valid value.
    pub fn parse_xmp(self, raw: &str) -> Option<f64> {
        match self {
            EffectField::Grayscale => match raw {
                "True" => Some(1.0),
                "False" => Some(0.0),
                _ => None,
            },
            EffectField::VignetteStyle => swift_double(raw)
                .and_then(VignetteStyle::from_xmp_code)
                .map(|style| style.xmp_code() as f64),
            _ => {
                let v = swift_double(raw).filter(|v| v.is_finite())?;
                let (lo, hi) = self.range().expect("numeric");
                let v = v.clamp(lo, hi);
                Some(if self == EffectField::GrainSeed {
                    libm::round(v)
                } else {
                    v
                })
            }
        }
    }

    /// The field's value in `s` (booleans 0 / 1, the style as its XMP code,
    /// `None` for an absent seed).
    pub fn value(self, s: &DevelopSettings) -> Option<f64> {
        Some(match self {
            EffectField::Grayscale => f64::from(u8::from(s.grayscale)),
            EffectField::GrayMix(band) => s.gray_mixer.get(band),
            EffectField::VignetteAmount => s.vignette.amount,
            EffectField::VignetteMidpoint => s.vignette.midpoint,
            EffectField::VignetteRoundness => s.vignette.roundness,
            EffectField::VignetteFeather => s.vignette.feather,
            EffectField::VignetteHighlights => s.vignette.highlights,
            EffectField::VignetteStyle => s.vignette.style.xmp_code() as f64,
            EffectField::GrainAmount => s.grain.amount,
            EffectField::GrainSize => s.grain.size,
            EffectField::GrainRoughness => s.grain.roughness,
            EffectField::GrainSeed => return s.grain.seed,
        })
    }

    /// Sets the field from a value of [`Self::parse_xmp`].
    pub fn set(self, s: &mut DevelopSettings, value: f64) {
        match self {
            EffectField::Grayscale => s.grayscale = value != 0.0,
            EffectField::GrayMix(band) => s.gray_mixer.set(band, value),
            EffectField::VignetteAmount => s.vignette.amount = value,
            EffectField::VignetteMidpoint => s.vignette.midpoint = value,
            EffectField::VignetteRoundness => s.vignette.roundness = value,
            EffectField::VignetteFeather => s.vignette.feather = value,
            EffectField::VignetteHighlights => s.vignette.highlights = value,
            EffectField::VignetteStyle => {
                if let Some(style) = VignetteStyle::from_xmp_code(value) {
                    s.vignette.style = style;
                }
            }
            EffectField::GrainAmount => s.grain.amount = value,
            EffectField::GrainSize => s.grain.size = value,
            EffectField::GrainRoughness => s.grain.roughness = value,
            EffectField::GrainSeed => s.grain.seed = Some(value),
        }
    }
}

/// One NIHO effect XMP key.
#[derive(Debug, Clone, Copy)]
pub struct EffectKey {
    /// `crs` property name.
    pub xmp: &'static str,
    pub field: EffectField,
}

/// Every NIHO effect key, in Lightroom's order (the one table for reading
/// and, later, writing XMP).
pub const EFFECT_KEYS: [EffectKey; 19] = [
    EffectKey {
        xmp: "ConvertToGrayscale",
        field: EffectField::Grayscale,
    },
    EffectKey {
        xmp: "GrayMixerRed",
        field: EffectField::GrayMix(HslBand::Red),
    },
    EffectKey {
        xmp: "GrayMixerOrange",
        field: EffectField::GrayMix(HslBand::Orange),
    },
    EffectKey {
        xmp: "GrayMixerYellow",
        field: EffectField::GrayMix(HslBand::Yellow),
    },
    EffectKey {
        xmp: "GrayMixerGreen",
        field: EffectField::GrayMix(HslBand::Green),
    },
    EffectKey {
        xmp: "GrayMixerAqua",
        field: EffectField::GrayMix(HslBand::Aqua),
    },
    EffectKey {
        xmp: "GrayMixerBlue",
        field: EffectField::GrayMix(HslBand::Blue),
    },
    EffectKey {
        xmp: "GrayMixerPurple",
        field: EffectField::GrayMix(HslBand::Purple),
    },
    EffectKey {
        xmp: "GrayMixerMagenta",
        field: EffectField::GrayMix(HslBand::Magenta),
    },
    EffectKey {
        xmp: "PostCropVignetteAmount",
        field: EffectField::VignetteAmount,
    },
    EffectKey {
        xmp: "PostCropVignetteMidpoint",
        field: EffectField::VignetteMidpoint,
    },
    EffectKey {
        xmp: "PostCropVignetteFeather",
        field: EffectField::VignetteFeather,
    },
    EffectKey {
        xmp: "PostCropVignetteRoundness",
        field: EffectField::VignetteRoundness,
    },
    EffectKey {
        xmp: "PostCropVignetteStyle",
        field: EffectField::VignetteStyle,
    },
    EffectKey {
        xmp: "PostCropVignetteHighlightContrast",
        field: EffectField::VignetteHighlights,
    },
    EffectKey {
        xmp: "GrainAmount",
        field: EffectField::GrainAmount,
    },
    EffectKey {
        xmp: "GrainSize",
        field: EffectField::GrainSize,
    },
    EffectKey {
        xmp: "GrainFrequency",
        field: EffectField::GrainRoughness,
    },
    EffectKey {
        xmp: "GrainSeed",
        field: EffectField::GrainSeed,
    },
];

/// The effect field of an XMP key.
pub fn effect_field(key: &str) -> Option<EffectField> {
    EFFECT_KEYS.iter().find(|k| k.xmp == key).map(|k| k.field)
}

/// Copies the effects of `from` into `to`.
fn copy_effects(from: &DevelopSettings, to: &mut DevelopSettings) {
    to.grayscale = from.grayscale;
    to.gray_mixer = from.gray_mixer;
    to.vignette = from.vignette;
    to.grain = from.grain;
}

const NOTE_EFFECT_FITTED: &str =
    "NIHO の式を Lightroom の書き出し（round8・round9）に当てはめたもの（ΔE00 平均 3.0 以下）";
const NOTE_EFFECT_GRAIN: &str =
    "粒の強さと大きさを Lightroom に統計で合わせた NIHO の粒（粒の形・並びは Lightroom と違う）";
const NOTE_EFFECT_NONE: &str = "効果なし（既定値）";
const NOTE_PERSPECTIVE: &str = "NIHO の遠近の近似モデル（Lightroom の実測による校正は未実施）";
const NOTE_UPRIGHT: &str = "Upright の自動計算（値は保持するが適用しない）";
const NOTE_UPRIGHT_OFF: &str = "Upright がオフなので使われない計算値（保持のみ）";

impl XmpDocument {
    /// Replaces the Transform of `s` this XMP carries (niho-photo#46).
    pub fn apply_perspective(&self, s: &mut DevelopSettings) {
        let had = s.geometry.is_some();
        let mut g = s.geometry.take().unwrap_or_default();
        for field in PerspectiveField::ALL {
            if let Some(v) = self.optional_number(field.xmp()) {
                let (lo, hi) = field.range();
                *field.get_mut(&mut g.perspective) = v.clamp(lo, hi);
            }
        }
        match self.optional_number("CropConstrainToWarp") {
            Some(0.0) => g.constrain = false,
            Some(1.0) => g.constrain = true,
            _ => {}
        }
        if let Some(u) = self
            .optional_number("PerspectiveUpright")
            .filter(|u| *u == libm::trunc(*u) && (0.0..=f64::from(MAX_UPRIGHT)).contains(u))
        {
            g.upright = u;
        }
        s.geometry = (had || g != Geometry::default()).then_some(g);
    }

    fn upright_on(&self) -> bool {
        self.optional_number("PerspectiveUpright")
            .is_some_and(|u| u != 0.0)
    }

    /// Replaces the effects of `s` this XMP carries (valid values only).
    pub fn apply_effects(&self, s: &mut DevelopSettings) {
        for key in EFFECT_KEYS {
            if let Some(value) = self
                .properties
                .get(key.xmp)
                .and_then(|raw| key.field.parse_xmp(raw))
            {
                key.field.set(s, value);
            }
        }
    }

    /// Whether applying this XMP leaves an effect group active. Presets can
    /// omit a group's switch while retaining the active value from their base.
    fn effect_group_on(settings: &DevelopSettings, group: EffectGroup) -> bool {
        match group {
            EffectGroup::Grayscale => settings.grayscale,
            EffectGroup::Vignette => settings.vignette.amount != 0.0,
            EffectGroup::Grain => settings.grain.amount > 0.0,
        }
    }

    /// NIHO level and note of an effect key (Photo Bench: unsupported).
    fn effect_level(
        &self,
        key: &str,
        field: EffectField,
        raw: &str,
        settings: &DevelopSettings,
    ) -> (Level, String) {
        if field.parse_xmp(raw).is_none() {
            let note = match field {
                EffectField::Grayscale => "True / False 以外の値は適用しない",
                EffectField::VignetteStyle => "1〜3 以外の様式は適用しない",
                _ => "有限数として読めないため適用しない",
            };
            return (Level::Unsupported, note.into());
        }
        if !Self::effect_group_on(settings, field.group()) {
            let note = if field.group() == EffectGroup::Grayscale && key != "ConvertToGrayscale" {
                "白黒でないため効果なし"
            } else {
                NOTE_EFFECT_NONE
            };
            return (Level::Exact, note.into());
        }
        if field == EffectField::VignetteHighlights && swift_double(raw) != Some(0.0) {
            // Rendered for a darkening highlight-priority vignette (round9,
            // #17259). Color priority keeps the value only; Lightroom's
            // brightening vignettes and paint overlay have no highlights.
            let v = &settings.vignette;
            return match (v.style, v.amount < 0.0) {
                (VignetteStyle::HighlightPriority, true) => {
                    (Level::Exact, NOTE_EFFECT_FITTED.into())
                }
                (VignetteStyle::ColorPriority, true) => {
                    (Level::Approximate, "保持のみ（描画に使わない）".into())
                }
                _ => (
                    Level::Exact,
                    "明るくする側とペイントオーバーレイには効かない（Lightroom と同じ）".into(),
                ),
            };
        }
        // round8 / round9 (#17120, #17259): black & white and the vignette
        // are within the gate (mean ΔE00 <= 3.0); grain matches Lightroom's
        // statistics, not its pixels.
        if field.group() == EffectGroup::Grain {
            return (Level::Approximate, NOTE_EFFECT_GRAIN.into());
        }
        (Level::Exact, NOTE_EFFECT_FITTED.into())
    }
}

/// Compatibility level of one XMP item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// Photo Bench "対応", rendered the same way by this crate.
    Exact,
    /// Rendered, but not the way Lightroom / Photo Bench does.
    Approximate,
    /// Kept (in the report) but not rendered.
    Unsupported,
    /// Descriptive only (name, UUID, ...).
    Metadata,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Exact => "exact",
            Level::Approximate => "approximate",
            Level::Unsupported => "unsupported",
            Level::Metadata => "metadata",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompatibilityItem {
    pub property: String,
    pub value: String,
    pub level: Level,
    /// Photo Bench's own level for the same item (`exact` = "対応").
    pub photo_bench_level: Level,
    pub note: String,
}

const SUPPORTED_SCALARS: [&str; 11] = [
    "Exposure2012",
    "Contrast2012",
    "Whites2012",
    "Blacks2012",
    "ParametricShadows",
    "ParametricDarks",
    "ParametricLights",
    "ParametricHighlights",
    "ParametricShadowSplit",
    "ParametricMidtoneSplit",
    "ParametricHighlightSplit",
];
const SUPPORTED_COLOR_SCALARS: [&str; 25] = [
    "Vibrance",
    "Saturation",
    "RedHue",
    "RedSaturation",
    "GreenHue",
    "GreenSaturation",
    "BlueHue",
    "BlueSaturation",
    "ColorGradeShadowHue",
    "ColorGradeShadowSat",
    "ColorGradeShadowLum",
    "ColorGradeMidtoneHue",
    "ColorGradeMidtoneSat",
    "ColorGradeHighlightHue",
    "ColorGradeHighlightSat",
    "ColorGradeHighlightLum",
    "ColorGradeGlobalHue",
    "ColorGradeGlobalSat",
    "ColorGradeBlending",
    "SplitToningShadowHue",
    "SplitToningShadowSaturation",
    "SplitToningHighlightHue",
    "SplitToningHighlightSaturation",
    "SplitToningBalance",
    "ShadowTint",
];
const METADATA_KEYS: [&str; 25] = [
    "AutoGrayscaleMix",
    "Version",
    "ProcessVersion",
    "UUID",
    "Name",
    "ShortName",
    "SortName",
    "PresetType",
    "CameraModelRestriction",
    "Copyright",
    "ContactInfo",
    "Description",
    "HasSettings",
    "Cluster",
    "Group",
    "Stubbed",
    "RequiresRGBTables",
    "SupportsAmount",
    "SupportsAmount2",
    "SupportsColor",
    "SupportsHighDynamicRange",
    "SupportsMonochrome",
    "SupportsNormalDynamicRange",
    "SupportsOutputReferred",
    "SupportsSceneReferred",
];

fn is_numeric_crs_property(key: &str) -> bool {
    effect_field(key).is_some_and(|f| f != EffectField::Grayscale)
        || SUPPORTED_SCALARS.contains(&key)
        || SUPPORTED_COLOR_SCALARS.contains(&key)
        || matches!(
            key,
            "Highlights2012"
                | "Shadows2012"
                | "Texture"
                | "Clarity2012"
                | "Dehaze"
                | "CurveRefineSaturation"
                | "Temperature"
                | "Tint"
                | "IncrementalTemperature"
                | "IncrementalTint"
                | "ColorGradeMidtoneLum"
                | "ColorGradeGlobalLum"
                | "Sharpness"
                | "SharpenRadius"
                | "SharpenDetail"
                | "SharpenEdgeMasking"
                | "LuminanceSmoothing"
                | "LuminanceNoiseReductionDetail"
                | "LuminanceNoiseReductionContrast"
                | "ColorNoiseReduction"
                | "ColorNoiseReductionDetail"
                | "ColorNoiseReductionSmoothness"
                | "PerspectiveUpright"
                | "CropConstrainToWarp"
        )
        || PerspectiveField::from_xmp(key).is_some()
        || LENS_KEYS.contains(&key)
        || key.starts_with("HueAdjustment")
        || key.starts_with("SaturationAdjustment")
        || key.starts_with("LuminanceAdjustment")
}

/// Range Photo Bench clamps each numeric key into (for the out-of-range
/// report).
fn clamp_range(key: &str) -> Option<(f64, f64)> {
    if let Some(field) = effect_field(key) {
        return field.range();
    }
    match key {
        "Sharpness" => return Some(detail::SHARPNESS_RANGE),
        "SharpenRadius" => return Some(detail::SHARPEN_RADIUS_RANGE),
        _ if detail::DETAIL_KEYS.contains(&key) => return Some(detail::PERCENT_RANGE),
        _ => {}
    }
    if let Some(field) = PerspectiveField::from_xmp(key) {
        return Some(field.range());
    }
    if let Some(range) = lens::lens_range(key) {
        return Some(range);
    }
    if key == "Exposure2012" {
        return Some((-5.0, 5.0));
    }
    if key.ends_with("Split") || key == "CurveRefineSaturation" || key == "ColorGradeBlending" {
        return Some((0.0, 100.0));
    }
    if key.ends_with("Hue") && (key.starts_with("ColorGrade") || key.starts_with("SplitToning")) {
        return Some((0.0, 359.0));
    }
    if key.ends_with("Sat") || key.ends_with("Saturation") && key.starts_with("SplitToning") {
        return Some((0.0, 100.0));
    }
    let pm = [
        "Contrast2012",
        "Highlights2012",
        "Shadows2012",
        "Whites2012",
        "Blacks2012",
        "Vibrance",
        "Saturation",
        "ParametricShadows",
        "ParametricDarks",
        "ParametricLights",
        "ParametricHighlights",
        "Texture",
        "Clarity2012",
        "Dehaze",
        "ShadowTint",
        "RedHue",
        "RedSaturation",
        "GreenHue",
        "GreenSaturation",
        "BlueHue",
        "BlueSaturation",
        "SplitToningBalance",
        "IncrementalTemperature",
        "IncrementalTint",
    ];
    if pm.contains(&key)
        || key.starts_with("HueAdjustment")
        || key.starts_with("SaturationAdjustment")
        || key.starts_with("LuminanceAdjustment")
        || key.ends_with("Lum")
    {
        return Some((-100.0, 100.0));
    }
    None
}

impl XmpDocument {
    /// `XMPDelegate.compatibilityItems` with the NIHO level beside Photo
    /// Bench's.
    pub fn compatibility(&self) -> Vec<CompatibilityItem> {
        let mut settings = DevelopSettings::neutral();
        self.apply_effects(&mut settings);
        self.apply_detail(&mut settings);
        self.apply_lens(&mut settings);
        self.compatibility_for(&settings)
    }

    fn compatibility_for(&self, effective_settings: &DevelopSettings) -> Vec<CompatibilityItem> {
        let custom_absolute = self.white_balance_mode() == PbWhiteBalanceMode::Custom
            && self.has_finite_number("Temperature")
            && self.has_finite_number("Tint");
        let custom_fixed = self.is_custom_without_values();
        let incremental_relative = self.white_balance_mode() == PbWhiteBalanceMode::Custom
            && !self.properties.contains_key("Temperature")
            && !self.properties.contains_key("Tint")
            && (self
                .optional_number("IncrementalTemperature")
                .unwrap_or(0.0)
                != 0.0
                || self.optional_number("IncrementalTint").unwrap_or(0.0) != 0.0);
        let incremental_valid = ["IncrementalTemperature", "IncrementalTint"]
            .into_iter()
            .all(|key| {
                self.optional_number(key)
                    .is_none_or(|value| (-100.0..=100.0).contains(&value))
            });
        let mut items = Vec::new();
        for (key, value) in &self.properties {
            let k = key.as_str();
            let is_hsl = k.starts_with("HueAdjustment")
                || k.starts_with("SaturationAdjustment")
                || k.starts_with("LuminanceAdjustment");
            let malformed_numeric = is_numeric_crs_property(k)
                && !self
                    .optional_number(k)
                    .is_some_and(|number| number.is_finite());
            let effect = effect_field(k);
            let graded_luminance_model =
                matches!(k, "ColorGradeMidtoneLum" | "ColorGradeGlobalLum");
            let perspective = PerspectiveField::from_xmp(k);
            let (mut pb, mut level, mut note): (Level, Level, String) =
                if k == "ToneCurveName2012" && self.sequences.is_empty() {
                    (
                        Level::Metadata,
                        Level::Metadata,
                        "名称のみ保持（曲線点なし）".into(),
                    )
                } else if k == "CameraProfile" {
                    match value.as_str() {
                        "Adobe Standard" => (
                            Level::Exact,
                            Level::Exact,
                            "段 1 の Adobe Standard（DCP）で描く".into(),
                        ),
                        "Adobe Color" => (
                            Level::Exact,
                            Level::Approximate,
                            "Adobe Color のルックは NIHO 標準ルックで置き換える".into(),
                        ),
                        _ => (
                            Level::Unsupported,
                            Level::Unsupported,
                            "Adobe Standard / Adobe Color 以外のカメラプロファイルは未対応".into(),
                        ),
                    }
                } else if k == "CurveRefineSaturation" {
                    if swift_double(value).is_some_and(|v| v == 100.0) {
                        (Level::Exact, Level::Exact, "既定値 100 に対応".into())
                    } else {
                        (
                            Level::Unsupported,
                            Level::Unsupported,
                            "100 以外は値を保持するのみ（100 として描画）".into(),
                        )
                    }
                } else if matches!(k, "WhiteBalance" | "Temperature" | "Tint") {
                    if incremental_relative && incremental_valid {
                        (
                            Level::Exact,
                            Level::Exact,
                            "非 RAW の増分ホワイトバランス（niho-2 の較正 LUT）".into(),
                        )
                    } else if incremental_relative {
                        (
                            Level::Unsupported,
                            Level::Unsupported,
                            "増分ホワイトバランスは -100..100 の範囲だけ対応".into(),
                        )
                    } else if custom_fixed {
                        let note = LIGHTROOM_CUSTOM_WHITE_NOTE.into();
                        (Level::Exact, Level::Approximate, note)
                    } else if custom_absolute {
                        (
                            Level::Exact,
                            Level::Approximate,
                            CUSTOM_ABSOLUTE_WHITE_NOTE.into(),
                        )
                    } else {
                        (Level::Exact, Level::Exact, "撮影時の白のまま".into())
                    }
                } else if k == "ShadowTint" {
                    (
                        Level::Exact,
                        Level::Exact,
                        "実測で効果ゼロ（何もしない演算として対応）".into(),
                    )
                } else if matches!(k, "IncrementalTemperature" | "IncrementalTint")
                    && incremental_relative
                    && incremental_valid
                {
                    (
                        Level::Exact,
                        Level::Exact,
                        "合成 sRGB 色見本から較正した出力 RGB 差分 LUT（niho-2）".into(),
                    )
                } else if matches!(k, "IncrementalTemperature" | "IncrementalTint")
                    && incremental_relative
                {
                    (
                        Level::Unsupported,
                        Level::Unsupported,
                        "-100..100 の範囲外なので適用しない".into(),
                    )
                } else if graded_luminance_model {
                    // Photo Bench keeps the value only; NIHO renders it with an
                    // approximation not calibrated against Lightroom yet
                    // (niho-photo#39, `color_ops::LUM_MIDTONE` / `LUM_GLOBAL`).
                    if swift_double(value) == Some(0.0) {
                        (Level::Unsupported, Level::Exact, NOTE_EFFECT_NONE.into())
                    } else {
                        (
                            Level::Unsupported,
                            Level::Approximate,
                            "NIHO の近似式（Lightroom の実測による校正は未実施）".into(),
                        )
                    }
                } else if let Some(field) = perspective {
                    if swift_double(value) == Some(field.neutral()) {
                        (Level::Unsupported, Level::Exact, NOTE_EFFECT_NONE.into())
                    } else {
                        (
                            Level::Unsupported,
                            Level::Approximate,
                            NOTE_PERSPECTIVE.into(),
                        )
                    }
                } else if k == "PerspectiveUpright" {
                    if swift_double(value) == Some(0.0) {
                        (Level::Unsupported, Level::Exact, NOTE_EFFECT_NONE.into())
                    } else {
                        (Level::Unsupported, Level::Unsupported, NOTE_UPRIGHT.into())
                    }
                } else if k == "CropConstrainToWarp" {
                    match swift_double(value) {
                        Some(0.0) => (Level::Unsupported, Level::Exact, NOTE_EFFECT_NONE.into()),
                        Some(1.0) => (
                            Level::Unsupported,
                            Level::Approximate,
                            "NIHO の「余白を埋める」（補正した写真の中に切り抜きを収める）".into(),
                        ),
                        _ => (
                            Level::Unsupported,
                            Level::Unsupported,
                            "0 / 1 以外は適用しない".into(),
                        ),
                    }
                } else if k == "UprightVersion" {
                    (Level::Unsupported, Level::Metadata, "値を保持".into())
                } else if k.starts_with("Upright") {
                    if self.upright_on() {
                        (Level::Unsupported, Level::Unsupported, NOTE_UPRIGHT.into())
                    } else {
                        (Level::Unsupported, Level::Metadata, NOTE_UPRIGHT_OFF.into())
                    }
                } else if matches!(k, "Highlights2012" | "Shadows2012") {
                    (
                        Level::Exact,
                        Level::Exact,
                        "局所ラプラシアン（linear ProPhoto）".into(),
                    )
                } else if matches!(k, "Texture" | "Clarity2012") {
                    (
                        Level::Exact,
                        Level::Exact,
                        "段別ゲイン（linear ProPhoto）".into(),
                    )
                } else if let Some(found) = self.detail_level(k, value, effective_settings) {
                    found
                } else if let Some(found) = self.lens_level(k, value, effective_settings) {
                    found
                } else if k == "Dehaze" {
                    (Level::Exact, Level::Exact, "トーンカーブ＋彩度倍率".into())
                } else if SUPPORTED_SCALARS.contains(&k) {
                    (Level::Exact, Level::Exact, "実測フィット式".into())
                } else if SUPPORTED_COLOR_SCALARS.contains(&k) || is_hsl {
                    (
                        Level::Exact,
                        Level::Exact,
                        "実測フィット式（linear ProPhoto）".into(),
                    )
                } else if k == "ToneCurveName2012" {
                    (
                        Level::Approximate,
                        Level::Approximate,
                        "曲線点で描く（名称は保持のみ）".into(),
                    )
                } else if METADATA_KEYS.contains(&k) {
                    (Level::Metadata, Level::Metadata, "値を保持".into())
                } else {
                    (
                        Level::Unsupported,
                        Level::Unsupported,
                        "未認識の Camera Raw 設定（適用しない）".into(),
                    )
                };
            // NIHO effects (Photo Bench: unrecognized, so unsupported).
            if let Some(field) = effect {
                (level, note) = self.effect_level(k, field, value, effective_settings);
            }
            if malformed_numeric {
                pb = Level::Unsupported;
                level = Level::Unsupported;
                note = "有限数として読めないため適用しない".into();
            }
            // Effects, Detail values, graded luminance and Transform sliders
            // in use can already be approximate; their notes still say the value was clamped.
            let clampable = match effect {
                Some(_) => matches!(level, Level::Exact | Level::Approximate),
                None if graded_luminance_model
                    || perspective.is_some()
                    || detail::DETAIL_KEYS.contains(&k)
                    || LENS_KEYS.contains(&k) =>
                {
                    matches!(level, Level::Exact | Level::Approximate)
                }
                None => matches!(level, Level::Exact),
            };
            if let (Some(range), Some(v)) = (clamp_range(k), swift_double(value)) {
                if v.is_finite() && (v < range.0 || v > range.1) && clampable {
                    level = Level::Approximate;
                    note = format!("範囲外の値を {}..{} に丸めて適用", range.0, range.1);
                }
            }
            items.push(CompatibilityItem {
                property: key.clone(),
                value: value.clone(),
                level,
                photo_bench_level: pb,
                note,
            });
        }
        for (key, value) in &self.nested {
            items.push(CompatibilityItem {
                property: format!("Look.{key}"),
                value: value.clone(),
                level: Level::Unsupported,
                photo_bench_level: Level::Unsupported,
                note: "埋め込みの Adobe Look（適用しない）".into(),
            });
        }
        for (key, points) in &self.sequences {
            items.push(CompatibilityItem {
                property: key.trim_start_matches("crs:").to_string(),
                value: format!("{} points", points.len()),
                level: Level::Exact,
                photo_bench_level: Level::Exact,
                note: "DNG スプライン＋RGBTone 色相保持（sRGB 符号化空間）".into(),
            });
        }
        if self.point_colors && !items.iter().any(|item| item.property == "PointColors") {
            items.push(CompatibilityItem {
                property: "PointColors".into(),
                value: "present".into(),
                level: Level::Unsupported,
                photo_bench_level: Level::Unsupported,
                note: "Adobe の非公開形式なので読み書き・推測変換をしない".into(),
            });
        }
        items
    }
}

/// `presetSettings` result.
#[derive(Debug, Clone)]
pub struct PresetResult {
    /// `crs:Name` (root simple property, else the `x-default` alternative).
    pub name: String,
    pub settings: DevelopSettings,
    /// Photo Bench `EditSettings` JSON after the patch (what Photo Bench's
    /// engine returns for the same request).
    pub edit_settings: Value,
    pub items: Vec<CompatibilityItem>,
    /// Photo Bench contract: the unsupported property names, in its order.
    pub unsupported: Vec<String>,
    pub approximate: Vec<String>,
    pub converter: &'static str,
    /// `false` when the patched settings did not convert cleanly.
    pub converted: bool,
    pub convert_issues: Vec<ConvertIssue>,
    pub convert_notes: Vec<ConvertIssue>,
    /// The preset amount of [`apply_preset`] (0..1.5); `None` for
    /// [`preset_settings`] (the whole preset).
    pub amount: Option<f64>,
    /// The preset's local adjustments (Lightroom's linear / radial masks,
    /// at most [`crate::settings::MAX_LOCAL_MASKS`], ids `xmp-1`...), in the
    /// coordinates of the **visible frame** of the photo the preset is
    /// applied to (its cropped, rotated, flipped and straightened output),
    /// not of the working image like `developSettings.masks`. They are not
    /// in `settings` (whose `masks` stay the base's): the caller maps them
    /// through the photo's geometry and size (`develop-preset-masks.ts`).
    /// What could not be read is in `items` / `unsupported`
    /// (`MaskGroupBasedCorrections.<n>.<reason>`). [`apply_preset`] scales
    /// their `adjust` by the amount.
    pub masks: Vec<LocalMask>,
}

/// Parses `xmp` and applies it on `base` (neutral when `None`).
pub fn preset_settings(
    xmp: &str,
    base: Option<&DevelopSettings>,
) -> Result<PresetResult, XmpError> {
    let doc = parse(xmp)?;
    if doc.properties.is_empty()
        && doc.sequences.values().all(|p| p.len() < 2)
        && !doc.point_colors
        && doc.local_corrections.is_empty()
    {
        return Err(XmpError::NoSettings);
    }
    let base_pb = match base {
        Some(b) => PbEditSettings::from_value(&to_edit_settings_value(b)),
        None => PbEditSettings::neutral(),
    };
    let patched = doc.apply_to(&base_pb);
    let edit_settings = patched.to_value();
    let outcome = convert_edit_settings(&edit_settings, base.and_then(|b| b.base.as_deref()));
    let mut settings = outcome.settings;
    if let Some(b) = base {
        // XMP presets only patch color settings. Keep geometry from the saved
        // base, which is intentionally outside Photo Bench's EditSettings.
        settings.geometry = b.geometry.clone();
        settings.extra = b.extra.clone();
        // The look is the photo's (S8 #16947): a preset never switches it,
        // whatever `CameraProfile` it names.
        settings.look = b.look.clone();
        // A preset keeps the photo's formula version unless the converter
        // deliberately promoted a nested incremental white to niho-2.
        if settings.engine != ENGINE_NIHO_2
            || matches!(
                b.engine.as_str(),
                ENGINE_NIHO_3
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
            )
        {
            settings.engine = b.engine.clone();
        }
        copy_effects(b, &mut settings);
        // Detail is not in Photo Bench's EditSettings either: start from the
        // photo's, then let this XMP's Detail-panel keys replace it below.
        settings.detail = b.detail;
        // Adobe XMP has no public representation for NIHO's independently
        // authored OKLCH points. Applying a preset must never erase them.
        settings.color_points = b.color_points.clone();
        // Local masks are the photo's own edit as well (never in a preset).
        settings.masks = b.masks.clone();
        // Heal marks belong to the photo (niho-photo#44), like its geometry.
        settings.heal = b.heal.clone();
        // The lens corrections are not in Photo Bench's EditSettings: start
        // from the photo's, then let this XMP's Lens Corrections keys
        // replace them below (niho-photo#45).
        settings.lens = b.lens;
    }
    // NIHO effects are not in Photo Bench's `EditSettings`, so they do not go
    // through the converter (`CONVERTER_VERSION` is unchanged): the base's
    // effects (defaults without a base) with the keys this XMP carries
    // replaced, like Lightroom applying a preset.
    doc.apply_effects(&mut settings);
    doc.apply_perspective(&mut settings);
    doc.apply_lens(&mut settings);
    if matches!(
        settings.engine.as_str(),
        ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
    ) {
        let inherited = base.cloned().unwrap_or_else(DevelopSettings::neutral);
        settings.color_noise_reduction = doc
            .optional_number("ColorNoiseReduction")
            .filter(|v| v.is_finite())
            .map(|v| v.clamp(0.0, 100.0))
            .unwrap_or(inherited.color_noise_reduction);
        settings.color_noise_reduction_detail = doc
            .optional_number("ColorNoiseReductionDetail")
            .filter(|v| v.is_finite())
            .map(|v| v.clamp(0.0, 100.0))
            .unwrap_or(inherited.color_noise_reduction_detail);
        settings.color_noise_reduction_smoothness = doc
            .optional_number("ColorNoiseReductionSmoothness")
            .filter(|v| v.is_finite())
            .map(|v| v.clamp(0.0, 100.0))
            .unwrap_or(inherited.color_noise_reduction_smoothness);
    }
    // Sharpening and noise reduction (v6 detail) after the engine and the
    // legacy signed-RAW color NR are final (detail.rs decides whether the
    // legacy field can carry the value).
    doc.apply_detail(&mut settings);
    // The preset may turn on an effect after the geometry/base shape was
    // restored, so derive the version only after all effect patches land.
    settings.v = settings.required_version();
    let mut items = doc.compatibility_for(&settings);
    // Lightroom's masks: separate from `settings` (visible-frame coordinates).
    let local = masks::read_local_masks(&doc, settings.white_balance.mode);
    items.extend(local.items);
    let mut converted = outcome.ok;
    let mut convert_issues = outcome.issues;
    let mut legacy = settings.legacy_settings.take().unwrap_or_default();
    if let Some(base_legacy) = base
        .and_then(|b| b.legacy_settings.as_ref())
        .filter(|legacy| !legacy.is_empty())
    {
        let mut merged = base_legacy.clone();
        // A value explicitly patched by this preset is the latest source, while
        // untouched legacy values from the saved base remain available.
        merged.extend(legacy);
        legacy = merged;
        converted = false;
        convert_issues.push(ConvertIssue::new(
            "legacySettings",
            "unsupported",
            "the base contains settings that this renderer cannot apply",
        ));
    }
    for (key, value) in &doc.properties {
        if !is_numeric_crs_property(key) {
            continue;
        }
        let issue_code = match swift_double(value) {
            None => Some("invalidType"),
            Some(number) if !number.is_finite() => Some("notFinite"),
            _ => None,
        };
        if let Some(code) = issue_code {
            converted = false;
            convert_issues.push(ConvertIssue::new(
                key,
                code,
                "XMP numeric property must be a finite number",
            ));
            legacy.insert(format!("xmp:{key}"), Value::String(value.clone()));
        }
    }
    // Effect values that are no valid value (`ConvertToGrayscale` other than
    // True / False, a style other than 1..3) are kept like malformed numbers.
    for (key, value) in &doc.properties {
        let Some(field) = effect_field(key) else {
            continue;
        };
        let finite_number = swift_double(value).is_some_and(f64::is_finite);
        let numeric_issue = is_numeric_crs_property(key) && !finite_number;
        if !numeric_issue && field.parse_xmp(value).is_none() {
            converted = false;
            convert_issues.push(ConvertIssue::new(
                key,
                "invalidValue",
                "XMP effect property has an unknown value",
            ));
            legacy.insert(format!("xmp:{key}"), Value::String(value.clone()));
        }
    }
    settings.legacy_settings = (!legacy.is_empty()).then_some(legacy);
    let name = doc
        .properties
        .get("Name")
        .filter(|n| !n.is_empty())
        .cloned()
        .or_else(|| doc.name.clone())
        .unwrap_or_default();
    Ok(PresetResult {
        name,
        settings,
        edit_settings,
        unsupported: items
            .iter()
            .filter(|i| i.level == Level::Unsupported)
            .map(|i| i.property.clone())
            .collect(),
        approximate: items
            .iter()
            .filter(|i| i.level == Level::Approximate)
            .map(|i| i.property.clone())
            .collect(),
        items,
        converter: CONVERTER_VERSION,
        converted,
        convert_issues,
        convert_notes: outcome.notes,
        amount: None,
        masks: local.masks,
    })
}

impl PresetResult {
    /// JSON for the wasm / API boundary.
    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("name".into(), Value::from(self.name.clone()));
        o.insert("settings".into(), self.settings.to_value());
        o.insert("unsupported".into(), Value::from(self.unsupported.clone()));
        o.insert("approximate".into(), Value::from(self.approximate.clone()));
        o.insert(
            "items".into(),
            Value::Array(
                self.items
                    .iter()
                    .map(|i| {
                        let mut m = Map::new();
                        m.insert("property".into(), Value::from(i.property.clone()));
                        m.insert("value".into(), Value::from(i.value.clone()));
                        m.insert("level".into(), Value::from(i.level.as_str()));
                        m.insert(
                            "photoBenchLevel".into(),
                            Value::from(i.photo_bench_level.as_str()),
                        );
                        m.insert("note".into(), Value::from(i.note.clone()));
                        Value::Object(m)
                    })
                    .collect(),
            ),
        );
        o.insert("converter".into(), Value::from(self.converter));
        o.insert("converted".into(), Value::from(self.converted));
        let issues = |list: &[ConvertIssue]| {
            Value::Array(
                list.iter()
                    .map(|i| {
                        let mut m = Map::new();
                        m.insert("path".into(), Value::from(i.path.clone()));
                        m.insert("code".into(), Value::from(i.code.clone()));
                        m.insert("message".into(), Value::from(i.message.clone()));
                        Value::Object(m)
                    })
                    .collect(),
            )
        };
        o.insert("convertIssues".into(), issues(&self.convert_issues));
        o.insert("convertNotes".into(), issues(&self.convert_notes));
        // Visible-frame coordinates (see `masks`), in the canonical shape.
        o.insert("masks".into(), masks_value(&self.masks));
        if let Some(amount) = self.amount {
            o.insert("amount".into(), num(amount));
        }
        Value::Object(o)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_xmp_without_settings() {
        let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>"#;
        assert_eq!(
            preset_settings(xmp, None).unwrap_err(),
            XmpError::NoSettings
        );
        assert!(matches!(
            preset_settings("<a><b></a>", None),
            Err(XmpError::InvalidXml(_))
        ));
    }

    #[test]
    fn simple_elements_and_out_of_range_are_reported() {
        let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+6.5">
<crs:Contrast2012>-20</crs:Contrast2012><crs:Sharpness>0</crs:Sharpness><crs:FutureThing>1</crs:FutureThing>
</rdf:Description></rdf:RDF></x:xmpmeta>"#;
        let r = preset_settings(xmp, None).unwrap();
        assert_eq!(r.settings.exposure, 5.0);
        assert_eq!(r.settings.contrast, -20.0);
        assert!(r.approximate.contains(&"Exposure2012".to_string()));
        // Sharpness 0 renders no sharpening, exactly like Lightroom at 0
        // (Issue #32), and creates no v6 detail.
        let sharpness = r.items.iter().find(|i| i.property == "Sharpness").unwrap();
        assert_eq!(sharpness.level, Level::Exact);
        assert_eq!(sharpness.photo_bench_level, Level::Unsupported);
        assert_eq!(r.settings.detail, None);
        assert!(r.unsupported.contains(&"FutureThing".to_string()));
    }

    #[test]
    fn malformed_known_numeric_xmp_is_unsupported_and_preserved() {
        let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="NaN" />
</rdf:RDF></x:xmpmeta>"#;
        let result = preset_settings(xmp, None).unwrap();
        let item = result
            .items
            .iter()
            .find(|item| item.property == "Exposure2012")
            .unwrap();
        assert_eq!(item.level, Level::Unsupported);
        assert!(!result.converted);
        assert_eq!(result.convert_issues[0].code, "notFinite");
        assert_eq!(
            result.settings.legacy_settings.unwrap()["xmp:Exposure2012"],
            "NaN"
        );
    }

    #[test]
    fn preset_keeps_base_legacy_settings_and_marks_conversion_incomplete() {
        let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="1" />
</rdf:RDF></x:xmpmeta>"#;
        let mut base = crate::settings::DevelopSettings::neutral();
        let mut legacy = Map::new();
        legacy.insert("futureControl".into(), Value::from(12));
        base.legacy_settings = Some(legacy);

        let result = preset_settings(xmp, Some(&base)).unwrap();
        assert_eq!(result.settings.exposure, 1.0);
        assert!(!result.converted);
        assert_eq!(
            result.settings.legacy_settings.unwrap()["futureControl"],
            12
        );
        assert!(result
            .convert_issues
            .iter()
            .any(|issue| issue.path == "legacySettings"));
    }

    #[test]
    fn preset_keeps_base_geometry_and_shape_version() {
        let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="1" />
</rdf:RDF></x:xmpmeta>"#;
        let base =
            crate::settings::DevelopSettings::from_json(r#"{"v":2,"geometry":{"rotate":90}}"#)
                .unwrap();
        let expected_geometry = base.geometry.clone();

        let result = preset_settings(xmp, Some(&base)).unwrap();

        assert_eq!(result.settings.geometry, expected_geometry);
        assert_eq!(result.settings.v, 2);
        assert_eq!(result.settings.required_version(), 2);
        assert!(result.settings.validate().is_empty());
    }

    #[test]
    fn preset_conversion_rejects_unrendered_xmp_controls() {
        let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:CurveRefineSaturation="80" crs:ColorGradeMidtoneLum="20" crs:ColorGradeGlobalLum="-10" />
</rdf:RDF></x:xmpmeta>"#;
        let result = preset_settings(xmp, None).unwrap();
        assert!(!result.converted);
        let legacy = result.settings.legacy_settings.as_ref().unwrap();
        assert!(legacy.contains_key("curveRefineSaturation"));
        assert!(!legacy.contains_key("colorGrading"));
        assert_eq!(result.settings.color_grading.midtone.luminance, 20.0);
        assert_eq!(result.settings.color_grading.global.luminance, -10.0);
    }
}
