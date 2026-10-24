//! `developSettings` v1 / v2 / v3 / v4 / v5 / v6 / v7 / v8 / v9: the saved edit of one photo.
//!
//! The JSON shape is Photo Bench `EditSettings` (`docs/ENGINE_PROTOCOL.md`,
//! `EditSettings.swift`'s `CodingKeys`) plus `v`, `engine`, `look`, `base`
//! and `geometry` (spec `niho-develop-engine.md` "段 2"). `v` is 9 when the
//! lens corrections render something (`lens.rs`), 8 when heal
//! marks exist, 7 when perspective is active, 6 when detail exists, 5 when a
//! local mask exists, 4 when color points exist, 3 when an effect is active,
//! 2 when geometry is not the identity, else 1. An older reader refuses an
//! edit it cannot render instead of silently dropping it. Differences from `EditSettings`:
//!
//!
//! - `whiteBalance.mode` is `asShot | absolute | relative`. `absolute` keeps
//!   the RAW Kelvin/tint in `whiteBalance.temperature` / `whiteBalance.tint`;
//!   `relative` uses the top-level `relativeTemperature` / `relativeTint`
//!   (-100..+100). The two are never converted into each other.
//! - `legacySettings` holds `EditSettings` values the versioned converter
//!   could not carry over (`convert.rs`).
//! - `grayscale` / `grayMixer` / `vignette` / `grain` are NIHO effects (not in
//!   `EditSettings`, #17120 E1), written only when they differ from their
//!   defaults.
//! - `colorPoints` is NIHO's independent OKLCH mixer, written only when at
//!   least one point exists.
//! - `masks` are the local adjustments of Epic #31 (`local_mask.rs`,
//!   `docs/local-adjustments.md`), written only when at least one exists.
//!
//! `hsl` keeps Photo Bench's JSON encoding (Swift encodes a dictionary with
//! enum keys as an alternating `[band, adjustment, ...]` array); an object
//! map `{ "red": {...} }` is also accepted on input. Unknown top-level keys
//! are preserved verbatim (`extra`) and written back, so a client can round
//! trip fields it does not understand.

pub use crate::geometry::{Geometry, GEOMETRY_SETTINGS_VERSION, PERSPECTIVE_SETTINGS_VERSION};
pub use crate::heal::{HealMark, HealMode, HEAL_SETTINGS_VERSION};
pub use crate::lens::{Lens, LENS_SETTINGS_VERSION};
pub use crate::local_mask::LocalMask;
use serde_json::{Map, Value};
use std::fmt;

/// Shape version (`v`) of settings without a geometry (and of new edits).
pub const SETTINGS_VERSION: u32 = 1;
/// Shape version required when a NIHO effect changes pixels.
pub const EFFECTS_SETTINGS_VERSION: u32 = 3;
/// Shape version required when at least one independent OKLCH color point is
/// present. Older readers must refuse the edit instead of dropping the mixer.
pub const COLOR_POINTS_SETTINGS_VERSION: u32 = 4;
/// Shape version required when at least one local mask (`masks`) is present.
pub const MASKS_SETTINGS_VERSION: u32 = 5;
/// Shape version required whenever the `detail` object is present. This is
/// required even when every amount is zero: older readers must not silently
/// drop a control group they do not understand.
pub const DETAIL_SETTINGS_VERSION: u32 = 6;
/// Highest shape version this crate reads.
pub const MAX_SETTINGS_VERSION: u32 = LENS_SETTINGS_VERSION;
/// The shape versions this crate reads.
pub const READABLE_SETTINGS_VERSIONS: [u32; 9] = [
    SETTINGS_VERSION,
    GEOMETRY_SETTINGS_VERSION,
    EFFECTS_SETTINGS_VERSION,
    COLOR_POINTS_SETTINGS_VERSION,
    MASKS_SETTINGS_VERSION,
    DETAIL_SETTINGS_VERSION,
    PERSPECTIVE_SETTINGS_VERSION,
    HEAL_SETTINGS_VERSION,
    LENS_SETTINGS_VERSION,
];
/// The UI and renderer intentionally share this small upper bound.
pub const MAX_COLOR_POINTS: usize = 8;
/// At most this many local masks (`masks`); the renderer draws one layer each.
pub const MAX_LOCAL_MASKS: usize = 8;
/// Formula version (`engine`). Bump only with a new formula set; old saved
/// settings keep rendering with the engine they name.
pub const ENGINE_NIHO_1: &str = "niho-1";
/// Formula version whose raster relative white balance uses the calibrated
/// output-space delta LUT.  All other formulas are unchanged from `niho-1`.
pub const ENGINE_NIHO_2: &str = "niho-2";
/// Signed-RAW causal renderer frozen for #17515.
pub const ENGINE_NIHO_3: &str = "niho-3";
/// R372 camera-scoped signed-RAW renderer.
pub const ENGINE_NIHO_4: &str = "niho-4";
/// P5 signed-RAW highlight reconstruction on top of the R395 formula.
pub const ENGINE_NIHO_5: &str = "niho-5";
/// JPEG / PNG (raster) renderer of #18397: the `niho-2` formula with
/// Highlights (<= 0) and Shadows (>= 0) from a JPEG-trained response
/// (`niho6.rs`, `NIHO6.md`). Raster input only.
pub const ENGINE_NIHO_6: &str = "niho-6";
/// NIHO 5 plus the fixed R23 non-FX residual / R42 FX30 shoulder.
pub const ENGINE_NIHO_7: &str = "niho-7";
/// Opt-in evaluation engine for #29. Raster sources use the `niho-6`
/// formulas and legacy (unsigned) RAW working copies use the `niho-2`
/// formulas, with unquantized f32 entries in every color cube. It is a
/// reader capability, not a constructor or product default.
pub const ENGINE_NIHO_8: &str = "niho-8";
/// `niho-6` raster renderer with hue-stable global / HSL saturation.
pub const ENGINE_NIHO_10: &str = "niho-10";
/// `niho-7` signed-RAW renderer with hue-stable global / HSL saturation.
pub const ENGINE_NIHO_11: &str = "niho-11";
/// #29 float-cube renderer for new raster and legacy (unsigned) RAW edits.
/// Raster sources use the `niho-10` formulas and legacy unsigned RAW working
/// copies the `niho-2` formulas (the `niho-8` RAW path); every color cube
/// (RAW look + ACR3, P, Q) keeps unquantized f32 entries on the same grid
/// (Interactive 33³ / Final 64³, gamma 1.8, input clamp, trilinear). Signed
/// RAW and camera-linear input are refused. The pixels of saved `niho-12`
/// settings are frozen from here on: a later formula or precision change is a
/// new engine, never a change of `niho-12`.
pub const ENGINE_NIHO_12: &str = "niho-12";
/// #27 head white-balance renderer for new raster and legacy (unsigned) RAW
/// edits: `niho-12`, except that on raster sources (JPEG / PNG originals and
/// raster working copies) the relative white balance is the measured
/// incremental-WB delta (`calibration/jpeg-incremental-wb-v1.bin`, the
/// `niho-2` LUT's knots, interpolation and pair residual) added in float to
/// the encoded sRGB of the source right after its conversion to linear
/// sRGB, instead of to the 8-bit output. Everything downstream (the `niho-6`
/// H/S analysis, the local pass and its statistics, Auto, the color picker)
/// reads that balanced source; there is no output-side LUT. Legacy unsigned
/// RAW working copies render exactly as `niho-12` (the `niho-2` formula and
/// its linear relative-WB matrix). Signed RAW and camera-linear input are
/// refused. With a zero relative white balance it draws `niho-12`'s bytes.
/// The pixels of saved `niho-13` settings are frozen from here on: a later
/// formula change is a new engine, never a change of `niho-13`.
pub const ENGINE_NIHO_13: &str = "niho-13";
/// #89 renderer for new raster and legacy (unsigned) RAW edits: `niho-13`
/// with a lighter analysis of the `niho-6` H/S response (`NIHO14.md`,
/// `niho14_analysis.rs`): the local means of the two large levels (σ = 64
/// and 128) are blurred on planes reduced 4 times and read back bilinearly,
/// and the response networks run in `f32` (four pixels per SIMD vector,
/// `exp`-based `tanh` / softplus). The response's coefficients, the analysis
/// image, the gain and every other formula are `niho-13`'s; settings that do
/// not use the response (no Highlights < 0 / Shadows > 0 on a raster
/// source) and legacy unsigned RAW working copies draw `niho-13`'s bytes.
/// Signed RAW and camera-linear input are refused. The pixels of saved
/// `niho-14` settings are frozen from here on.
pub const ENGINE_NIHO_14: &str = "niho-14";

pub fn is_known_engine(engine: &str) -> bool {
    matches!(
        engine,
        ENGINE_NIHO_1
            | ENGINE_NIHO_2
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
    )
}

/// Engines whose raster / legacy-RAW cubes keep unquantized f32 entries
/// (the `niho-8` candidate, `niho-12`, `niho-13` and `niho-14`). Older
/// engines keep their original cube precision so their saved pixels never
/// change.
pub fn uses_float_cubes(engine: &str) -> bool {
    matches!(
        engine,
        ENGINE_NIHO_8 | ENGINE_NIHO_12 | ENGINE_NIHO_13 | ENGINE_NIHO_14
    )
}

/// Engines that apply the relative white balance of a raster source to the
/// source itself (`niho-13`, `niho-14`, `head_wb.rs`) rather than to the
/// output.
pub fn uses_head_white_balance(engine: &str) -> bool {
    matches!(engine, ENGINE_NIHO_13 | ENGINE_NIHO_14)
}
/// Look versions (`look`): `niho-interim-1` is the identity and the default
/// of settings that do not name one (S5 photos and converted Photo Bench
/// settings keep it); `niho-standard-1` is the S8 NIHO standard look.
pub use crate::look::{
    LOOK_NIHO_INTERIM_1, LOOK_NIHO_STANDARD_1, LOOK_NIHO_STANDARD_2, LOOK_NIHO_STANDARD_3,
    LOOK_NIHO_STANDARD_4, LOOK_NIHO_STANDARD_5,
};
/// Maximum serialized size accepted (spec: 64KiB).
pub const MAX_SETTINGS_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurveChannel {
    Rgb,
    Red,
    Green,
    Blue,
}

impl CurveChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            CurveChannel::Rgb => "rgb",
            CurveChannel::Red => "red",
            CurveChannel::Green => "green",
            CurveChannel::Blue => "blue",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "rgb" => Some(CurveChannel::Rgb),
            "red" => Some(CurveChannel::Red),
            "green" => Some(CurveChannel::Green),
            "blue" => Some(CurveChannel::Blue),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CurvePoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToneCurve {
    pub channel: CurveChannel,
    /// Authored order (duplicate x resolve last-authored-wins at render).
    pub points: Vec<CurvePoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HslBand {
    Red,
    Orange,
    Yellow,
    Green,
    Aqua,
    Blue,
    Purple,
    Magenta,
}

impl HslBand {
    pub const ALL: [HslBand; 8] = [
        HslBand::Red,
        HslBand::Orange,
        HslBand::Yellow,
        HslBand::Green,
        HslBand::Aqua,
        HslBand::Blue,
        HslBand::Purple,
        HslBand::Magenta,
    ];

    pub fn ordinal(self) -> usize {
        self as usize
    }

    pub fn as_str(self) -> &'static str {
        match self {
            HslBand::Red => "red",
            HslBand::Orange => "orange",
            HslBand::Yellow => "yellow",
            HslBand::Green => "green",
            HslBand::Aqua => "aqua",
            HslBand::Blue => "blue",
            HslBand::Purple => "purple",
            HslBand::Magenta => "magenta",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        HslBand::ALL.into_iter().find(|b| b.as_str() == s)
    }

    /// `Red` for the XMP suffix (`HueAdjustmentRed`).
    pub fn xmp_suffix(self) -> &'static str {
        match self {
            HslBand::Red => "Red",
            HslBand::Orange => "Orange",
            HslBand::Yellow => "Yellow",
            HslBand::Green => "Green",
            HslBand::Aqua => "Aqua",
            HslBand::Blue => "Blue",
            HslBand::Purple => "Purple",
            HslBand::Magenta => "Magenta",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct HslAdjustment {
    pub hue: f64,
    pub saturation: f64,
    pub luminance: f64,
}

impl HslAdjustment {
    pub fn is_zero(&self) -> bool {
        self.hue == 0.0 && self.saturation == 0.0 && self.luminance == 0.0
    }
}

/// One independent OKLCH selection in Stage Q. `target` and `range` select
/// colors in the unmodified Stage-Q input; all selected deltas are combined
/// before any point is applied, so overlapping points are order independent.
#[derive(Debug, Clone, PartialEq)]
pub struct ColorPoint {
    pub id: String,
    pub target: OklchTarget,
    pub range: OklchRange,
    pub delta: OklchDelta,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OklchTarget {
    pub lightness: f64,
    pub chroma: f64,
    pub hue: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OklchRange {
    pub hue: f64,
    pub chroma: f64,
    pub lightness: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OklchDelta {
    pub hue: f64,
    /// 1 is unchanged, 0 removes chroma, and 3 triples it.
    pub chroma_scale: f64,
    pub lightness: f64,
}

impl OklchDelta {
    pub fn is_zero(self) -> bool {
        self.hue == 0.0 && self.chroma_scale == 1.0 && self.lightness == 0.0
    }
}

/// The 8-band mixer, one entry per band at most, kept in band order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HslAdjustments {
    entries: Vec<(HslBand, HslAdjustment)>,
}

impl HslAdjustments {
    pub fn entries(&self) -> &[(HslBand, HslAdjustment)] {
        &self.entries
    }

    pub fn get(&self, band: HslBand) -> Option<HslAdjustment> {
        self.entries
            .iter()
            .find(|(b, _)| *b == band)
            .map(|(_, a)| *a)
    }

    pub fn set(&mut self, band: HslBand, adjustment: HslAdjustment) {
        if let Some(entry) = self.entries.iter_mut().find(|(b, _)| *b == band) {
            entry.1 = adjustment;
        } else {
            self.entries.push((band, adjustment));
            self.entries.sort_by_key(|(b, _)| *b);
        }
    }

    pub fn remove(&mut self, band: HslBand) {
        self.entries.retain(|(b, _)| *b != band);
    }

    pub fn is_zero(&self) -> bool {
        self.entries.iter().all(|(_, a)| a.is_zero())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct CalibrationSettings {
    pub shadow_tint: f64,
    pub red_hue: f64,
    pub red_saturation: f64,
    pub green_hue: f64,
    pub green_saturation: f64,
    pub blue_hue: f64,
    pub blue_saturation: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ColorGradeBand {
    /// 0..359 (wheel angle).
    pub hue: f64,
    /// 0..100.
    pub saturation: f64,
    /// -100..100.
    pub luminance: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ColorGradingSettings {
    pub shadow: ColorGradeBand,
    pub midtone: ColorGradeBand,
    pub highlight: ColorGradeBand,
    pub global: ColorGradeBand,
    /// 0..100 (absent defaults to 100 like Photo Bench).
    pub blending: f64,
    /// -100..100.
    pub balance: f64,
}

impl Default for ColorGradingSettings {
    fn default() -> Self {
        Self {
            shadow: ColorGradeBand::default(),
            midtone: ColorGradeBand::default(),
            highlight: ColorGradeBand::default(),
            global: ColorGradeBand::default(),
            blending: 100.0,
            balance: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WhiteBalanceMode {
    #[default]
    AsShot,
    Absolute,
    Relative,
}

impl WhiteBalanceMode {
    pub fn as_str(self) -> &'static str {
        match self {
            WhiteBalanceMode::AsShot => "asShot",
            WhiteBalanceMode::Absolute => "absolute",
            WhiteBalanceMode::Relative => "relative",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct WhiteBalance {
    pub mode: WhiteBalanceMode,
    /// Absolute Kelvin (RAW, 2000..50000). Kept when `mode = relative` won.
    pub temperature: Option<f64>,
    /// Absolute tint (RAW, -150..150).
    pub tint: Option<f64>,
}

/// Absolute white balance limits (spec).
pub const ABSOLUTE_TEMPERATURE_RANGE: (f64, f64) = (2000.0, 50000.0);
pub const ABSOLUTE_TINT_RANGE: (f64, f64) = (-150.0, 150.0);

// MARK: - Effects (NIHO extension, #17120 E1)
//
// Black & white (`grayscale` + `grayMixer`), the post-crop vignette and grain
// are not in Photo Bench's `EditSettings`. Each group is written only when it
// differs from its default, so settings without effects serialize exactly as
// before (and render the same pixels).

/// Black & white mix (`grayMixer`): -100..100 per HSL band (Lightroom's
/// `GrayMixerRed` ...), used only while `grayscale` is on.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct GrayMixer {
    /// Indexed by [`HslBand::ordinal`].
    pub bands: [f64; 8],
}

impl GrayMixer {
    pub fn get(&self, band: HslBand) -> f64 {
        self.bands[band.ordinal()]
    }

    pub fn set(&mut self, band: HslBand, value: f64) {
        self.bands[band.ordinal()] = value;
    }

    pub fn is_zero(&self) -> bool {
        self.bands.iter().all(|v| *v == 0.0)
    }
}

/// Post-crop vignette style (Lightroom `PostCropVignetteStyle` 1..3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VignetteStyle {
    /// A linear gain before the tone curves (the UI's only style).
    #[default]
    HighlightPriority,
    /// A gain on the encoded output.
    ColorPriority,
    /// A blend of the encoded output toward black / white.
    PaintOverlay,
}

impl VignetteStyle {
    pub const ALL: [VignetteStyle; 3] = [
        VignetteStyle::HighlightPriority,
        VignetteStyle::ColorPriority,
        VignetteStyle::PaintOverlay,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            VignetteStyle::HighlightPriority => "highlightPriority",
            VignetteStyle::ColorPriority => "colorPriority",
            VignetteStyle::PaintOverlay => "paintOverlay",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        VignetteStyle::ALL.into_iter().find(|v| v.as_str() == s)
    }

    /// Lightroom's `PostCropVignetteStyle` value.
    pub fn xmp_code(self) -> u8 {
        match self {
            VignetteStyle::HighlightPriority => 1,
            VignetteStyle::ColorPriority => 2,
            VignetteStyle::PaintOverlay => 3,
        }
    }

    pub fn from_xmp_code(code: f64) -> Option<Self> {
        VignetteStyle::ALL
            .into_iter()
            .find(|v| v.xmp_code() as f64 == code)
    }
}

/// Post-crop vignette (`vignette`): applied to the rendered frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VignetteSettings {
    /// -100..100 (negative darkens the edges).
    pub amount: f64,
    /// 0..100 (where the falloff starts: 0 near the center, 100 corners only).
    pub midpoint: f64,
    /// -100..100 (0 = ellipse inscribed in the frame, 100 = circle,
    /// -100 = rounded rectangle).
    pub roundness: f64,
    /// 0..100 (width of the falloff: 0 = a hard edge).
    pub feather: f64,
    /// 0..100 (Lightroom `PostCropVignetteHighlightContrast`): bright pixels
    /// take less of a darkening highlight-priority vignette. Retained only
    /// for the other styles and for brightening.
    pub highlights: f64,
    pub style: VignetteStyle,
}

impl Default for VignetteSettings {
    fn default() -> Self {
        Self {
            amount: 0.0,
            midpoint: 50.0,
            roundness: 0.0,
            feather: 50.0,
            highlights: 0.0,
            style: VignetteStyle::HighlightPriority,
        }
    }
}

impl VignetteSettings {
    /// Whether the vignette changes pixels.
    pub fn is_active(&self) -> bool {
        self.amount != 0.0
    }
}

/// Grain (`grain`): monochrome, on the encoded output.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GrainSettings {
    /// 0..100.
    pub amount: f64,
    /// 0..100 (grain size relative to the photo).
    pub size: f64,
    /// 0..100 (Lightroom `GrainFrequency`: share of the finer octave).
    pub roughness: f64,
    /// Integer 0..4294967295; `None` = the fixed default seed.
    pub seed: Option<f64>,
}

impl Default for GrainSettings {
    fn default() -> Self {
        Self {
            amount: 0.0,
            size: 25.0,
            roughness: 50.0,
            seed: None,
        }
    }
}

impl GrainSettings {
    /// Whether the grain changes pixels.
    pub fn is_active(&self) -> bool {
        self.amount > 0.0
    }
}

/// Largest `grain.seed`.
pub const GRAIN_SEED_MAX: f64 = u32::MAX as f64;

/// Output-resolution sharpening controls. The defaults are serialized when
/// a v6 `detail` object exists so its shape is exact and cross-language.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SharpeningSettings {
    pub amount: f64,
    pub radius: f64,
    pub detail: f64,
    pub masking: f64,
}

impl Default for SharpeningSettings {
    fn default() -> Self {
        Self {
            amount: 0.0,
            radius: 1.0,
            detail: 25.0,
            masking: 0.0,
        }
    }
}

/// v6 detail processing. `color_noise_reduction: None` deliberately differs
/// from `Some(0)`: absent preserves a signed-RAW edit's legacy R209 amount,
/// while a present value overrides it. Raster inputs never inherit the old
/// top-level color-noise field.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DetailSettings {
    pub sharpening: SharpeningSettings,
    pub luminance_noise_reduction: f64,
    pub color_noise_reduction: Option<f64>,
}

impl Default for DetailSettings {
    fn default() -> Self {
        Self {
            sharpening: SharpeningSettings::default(),
            luminance_noise_reduction: 0.0,
            color_noise_reduction: None,
        }
    }
}

impl DetailSettings {
    pub fn is_active(self) -> bool {
        self.sharpening.amount > 0.0
            || self.luminance_noise_reduction > 0.0
            || self
                .color_noise_reduction
                .is_some_and(|amount| amount > 0.0)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DevelopSettings {
    pub v: u32,
    pub engine: String,
    pub look: String,
    /// Working-copy `baseVersion`; `None` only for small JPEG/PNG originals
    /// rendered directly.
    pub base: Option<String>,
    pub exposure: f64,
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub whites: f64,
    pub blacks: f64,
    pub texture: f64,
    pub clarity: f64,
    pub dehaze: f64,
    pub vibrance: f64,
    pub saturation: f64,
    /// RAW color-noise reduction. NIHO 3 implements the frozen R209 map.
    pub color_noise_reduction: f64,
    /// Retained explicitly; the frozen NIHO 3 model is characterized at 50.
    pub color_noise_reduction_detail: f64,
    /// Retained explicitly; the frozen NIHO 3 model is characterized at 50.
    pub color_noise_reduction_smoothness: f64,
    pub white_balance: WhiteBalance,
    pub relative_temperature: f64,
    pub relative_tint: f64,
    pub tone_curves: Vec<ToneCurve>,
    pub hsl: HslAdjustments,
    pub color_points: Vec<ColorPoint>,
    /// Local adjustments (`masks`, Epic #31); empty = none.
    pub masks: Vec<LocalMask>,
    pub calibration: CalibrationSettings,
    pub color_grading: ColorGradingSettings,
    pub parametric_shadows: f64,
    pub parametric_darks: f64,
    pub parametric_lights: f64,
    pub parametric_highlights: f64,
    pub parametric_shadow_split: f64,
    pub parametric_midtone_split: f64,
    pub parametric_highlight_split: f64,
    /// Retained only; 100 is the only modeled value.
    pub curve_refine_saturation: f64,
    /// Black & white (NIHO extension): replaces Vibrance / Saturation / HSL
    /// with [`GrayMixer`] in cube Q (their values are kept).
    pub grayscale: bool,
    pub gray_mixer: GrayMixer,
    pub vignette: VignetteSettings,
    pub grain: GrainSettings,
    /// Optional v6 detail group. Presence, not activity, requires v6.
    pub detail: Option<DetailSettings>,
    /// `EditSettings` values the converter could not carry over.
    pub legacy_settings: Option<Map<String, Value>>,
    /// Quarter turns, flips, straighten and crop (`None` = not written).
    pub geometry: Option<Geometry>,
    /// Heal marks in the order drawn (`heal.rs`; empty = not written).
    pub heal: Vec<HealMark>,
    /// Manual lens corrections and the chromatic aberration / fringe removal
    /// (`lens.rs`; the defaults = not written).
    pub lens: Lens,
    /// Unknown keys, preserved verbatim.
    pub extra: Map<String, Value>,
}

impl Default for DevelopSettings {
    fn default() -> Self {
        Self::neutral()
    }
}

impl DevelopSettings {
    /// Legacy neutral settings retained for missing fields and old saved data.
    pub fn neutral() -> Self {
        Self {
            v: SETTINGS_VERSION,
            engine: ENGINE_NIHO_1.to_string(),
            look: LOOK_NIHO_INTERIM_1.to_string(),
            base: None,
            exposure: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
            texture: 0.0,
            clarity: 0.0,
            dehaze: 0.0,
            vibrance: 0.0,
            saturation: 0.0,
            color_noise_reduction: 0.0,
            color_noise_reduction_detail: 50.0,
            color_noise_reduction_smoothness: 50.0,
            white_balance: WhiteBalance::default(),
            relative_temperature: 0.0,
            relative_tint: 0.0,
            tone_curves: Vec::new(),
            hsl: HslAdjustments::default(),
            color_points: Vec::new(),
            masks: Vec::new(),
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
            grayscale: false,
            gray_mixer: GrayMixer::default(),
            vignette: VignetteSettings::default(),
            grain: GrainSettings::default(),
            detail: None,
            legacy_settings: None,
            geometry: None,
            heal: Vec::new(),
            lens: Lens::default(),
            extra: Map::new(),
        }
    }

    /// Initial settings for a newly created edit. Persisted settings without a
    /// `look` still use `niho-interim-1` through `from_value`'s neutral base.
    pub fn new_edit() -> Self {
        let mut settings = Self::neutral();
        settings.look = LOOK_NIHO_STANDARD_1.to_string();
        settings
    }

    /// The `v` these settings need: 9 for an active lens, 8 for heal marks,
    /// 7 for a perspective, 6 for detail, 5 for local masks, 4 for color
    /// points, 3 for active effects, 2 for non-identity geometry, and 1
    /// otherwise.
    pub fn required_version(&self) -> u32 {
        if self.lens.is_active() {
            LENS_SETTINGS_VERSION
        } else if !self.heal.is_empty() {
            HEAL_SETTINGS_VERSION
        } else if self
            .geometry
            .as_ref()
            .is_some_and(|g| g.active_perspective().is_some())
        {
            PERSPECTIVE_SETTINGS_VERSION
        } else if self.detail.is_some() {
            DETAIL_SETTINGS_VERSION
        } else if !self.masks.is_empty() {
            MASKS_SETTINGS_VERSION
        } else if !self.color_points.is_empty() {
            COLOR_POINTS_SETTINGS_VERSION
        } else if self.grayscale || self.vignette.is_active() || self.grain.is_active() {
            EFFECTS_SETTINGS_VERSION
        } else {
            match &self.geometry {
                Some(g) if !g.is_identity() => GEOMETRY_SETTINGS_VERSION,
                _ => SETTINGS_VERSION,
            }
        }
    }

    pub fn has_active_color_points(&self) -> bool {
        self.color_points.iter().any(|point| !point.delta.is_zero())
    }

    /// Whether at least one local mask would change pixels: enabled with a
    /// non-zero `adjust` (a mask whose surface turns out to be all 0 is only
    /// known to the renderer, M2).
    pub fn has_active_masks(&self) -> bool {
        self.masks.iter().any(LocalMask::is_active)
    }

    /// Effective signed-RAW R209 amount. An explicit v6 value overrides the
    /// legacy top-level value, including an explicit zero.
    pub fn raw_color_noise_reduction(&self) -> f64 {
        self.detail
            .and_then(|detail| detail.color_noise_reduction)
            .unwrap_or(self.color_noise_reduction)
    }

    /// Whether rendering these settings changes nothing (the Photo Bench
    /// `hasActiveColorEdits` complement plus the white balance mode).
    /// `engine` / `look` / `base` / `geometry` / `heal` / retained-only
    /// values do not count ("初期化" resets the color, not the crop or the
    /// heal marks); an active `lens` does (it changes the pixels and
    /// "初期化" resets it).
    pub fn is_neutral(&self) -> bool {
        let scalars = [
            self.exposure,
            self.contrast,
            self.highlights,
            self.shadows,
            self.whites,
            self.blacks,
            self.texture,
            self.clarity,
            self.dehaze,
            self.vibrance,
            self.saturation,
            if self
                .detail
                .is_some_and(|detail| detail.color_noise_reduction.is_some())
            {
                0.0
            } else {
                self.color_noise_reduction
            },
            self.parametric_shadows,
            self.parametric_darks,
            self.parametric_lights,
            self.parametric_highlights,
        ];
        let calibration = [
            self.calibration.red_hue,
            self.calibration.red_saturation,
            self.calibration.green_hue,
            self.calibration.green_saturation,
            self.calibration.blue_hue,
            self.calibration.blue_saturation,
        ];
        let g = &self.color_grading;
        let grading = [
            g.shadow.saturation,
            g.shadow.luminance,
            g.midtone.saturation,
            g.midtone.luminance,
            g.highlight.saturation,
            g.highlight.luminance,
            g.global.saturation,
            g.global.luminance,
        ];
        let white_balance_neutral = match self.white_balance.mode {
            WhiteBalanceMode::AsShot => true,
            WhiteBalanceMode::Absolute => false,
            WhiteBalanceMode::Relative => {
                self.relative_temperature == 0.0 && self.relative_tint == 0.0
            }
        };
        scalars.iter().all(|v| *v == 0.0)
            && calibration.iter().all(|v| *v == 0.0)
            && grading.iter().all(|v| *v == 0.0)
            && self.hsl.is_zero()
            && !self.has_active_color_points()
            && !self.has_active_masks()
            && crate::tone_ops::curves_are_identity(&self.tone_curves, 1e-9)
            && white_balance_neutral
            && !self.grayscale
            && !self.vignette.is_active()
            && !self.grain.is_active()
            && self.detail.is_none_or(|detail| !detail.is_active())
            && !self.lens.is_active()
    }

    /// Parses `developSettings` JSON text.
    pub fn from_json(text: &str) -> Result<Self, SettingsError> {
        if text.len() > MAX_SETTINGS_BYTES {
            return Err(SettingsError::new(
                "",
                "tooLarge",
                "developSettings is larger than 64KiB",
            ));
        }
        let value: Value = serde_json::from_str(text)
            .map_err(|e| SettingsError::new("", "invalidJson", &e.to_string()))?;
        Self::from_value(&value)
    }

    /// Parses a `developSettings` JSON value. Missing keys take neutral
    /// values; wrong types and non-finite numbers are errors.
    pub fn from_value(value: &Value) -> Result<Self, SettingsError> {
        let object = value.as_object().ok_or_else(|| {
            SettingsError::new("", "invalidType", "developSettings must be an object")
        })?;
        let mut s = Self::neutral();
        let mut extra = Map::new();
        for (key, v) in object {
            let path = key.as_str();
            match path {
                "v" => {
                    let n = number(v, path)?;
                    s.v = match n {
                        _ if n == 1.0 => 1,
                        _ if n == 2.0 => 2,
                        _ if n == 3.0 => 3,
                        _ if n == 4.0 => 4,
                        _ if n == 5.0 => 5,
                        _ if n == 6.0 => 6,
                        _ if n == 7.0 => 7,
                        _ if n == 8.0 => 8,
                        _ if n == 9.0 => 9,
                        _ => {
                            return Err(SettingsError::new(
                                path,
                                "unsupportedVersion",
                                "only v = 1, v = 2, v = 3, v = 4, v = 5, v = 6, v = 7, v = 8, and v = 9 are supported",
                            ))
                        }
                    };
                }
                "engine" => {
                    let e = string(v, path)?;
                    if !is_known_engine(&e) {
                        return Err(SettingsError::new(
                            path,
                            "unsupportedEngine",
                            "unknown engine version",
                        ));
                    }
                    s.engine = e;
                }
                "look" => {
                    let l = string(v, path)?;
                    if !crate::look::is_known(&l) {
                        return Err(SettingsError::new(
                            path,
                            "unsupportedLook",
                            "unknown look version",
                        ));
                    }
                    s.look = l;
                }
                "base" => {
                    s.base = if v.is_null() {
                        None
                    } else {
                        Some(string(v, path)?)
                    };
                }
                "exposure" => s.exposure = number(v, path)?,
                "contrast" => s.contrast = number(v, path)?,
                "highlights" => s.highlights = number(v, path)?,
                "shadows" => s.shadows = number(v, path)?,
                "whites" => s.whites = number(v, path)?,
                "blacks" => s.blacks = number(v, path)?,
                "texture" => s.texture = number(v, path)?,
                "clarity" => s.clarity = number(v, path)?,
                "dehaze" => s.dehaze = number(v, path)?,
                "vibrance" => s.vibrance = number(v, path)?,
                "saturation" => s.saturation = number(v, path)?,
                "colorNoiseReduction" => s.color_noise_reduction = number(v, path)?,
                "colorNoiseReductionDetail" => s.color_noise_reduction_detail = number(v, path)?,
                "colorNoiseReductionSmoothness" => {
                    s.color_noise_reduction_smoothness = number(v, path)?
                }
                "relativeTemperature" => s.relative_temperature = number(v, path)?,
                "relativeTint" => s.relative_tint = number(v, path)?,
                "whiteBalance" => s.white_balance = parse_white_balance(v)?,
                "toneCurves" => s.tone_curves = parse_tone_curves(v)?,
                "hsl" => s.hsl = parse_hsl(v)?,
                "colorPoints" => s.color_points = parse_color_points(v)?,
                "masks" => s.masks = crate::local_mask::parse_masks(v)?,
                "calibration" => s.calibration = parse_calibration(v)?,
                "colorGrading" => s.color_grading = parse_color_grading(v)?,
                "parametricShadows" => s.parametric_shadows = number(v, path)?,
                "parametricDarks" => s.parametric_darks = number(v, path)?,
                "parametricLights" => s.parametric_lights = number(v, path)?,
                "parametricHighlights" => s.parametric_highlights = number(v, path)?,
                "parametricShadowSplit" => s.parametric_shadow_split = number(v, path)?,
                "parametricMidtoneSplit" => s.parametric_midtone_split = number(v, path)?,
                "parametricHighlightSplit" => s.parametric_highlight_split = number(v, path)?,
                "curveRefineSaturation" => s.curve_refine_saturation = number(v, path)?,
                "grayscale" => {
                    s.grayscale = v.as_bool().ok_or_else(|| {
                        SettingsError::new(path, "invalidType", "must be a boolean")
                    })?
                }
                "grayMixer" => s.gray_mixer = parse_gray_mixer(v)?,
                "vignette" => s.vignette = parse_vignette(v)?,
                "grain" => s.grain = parse_grain(v)?,
                "detail" => s.detail = Some(parse_detail(v)?),
                "geometry" => {
                    s.geometry = if v.is_null() {
                        None
                    } else {
                        Some(Geometry::from_value(v)?)
                    };
                }
                "heal" => s.heal = crate::heal::parse_heal(v)?,
                "lens" => s.lens = crate::lens::parse_lens(v)?,
                "legacySettings" => {
                    s.legacy_settings = if v.is_null() {
                        None
                    } else {
                        Some(v.as_object().cloned().ok_or_else(|| {
                            SettingsError::new(
                                path,
                                "invalidType",
                                "legacySettings must be an object",
                            )
                        })?)
                    };
                }
                _ => {
                    extra.insert(key.clone(), v.clone());
                }
            }
        }
        s.extra = extra;
        // `masks` are checked strictly on read (shape, ranges, ids, and the
        // white-balance rule, which needs `whiteBalance` parsed above).
        if let Some(issue) = crate::local_mask::validate_masks(&s.masks, s.white_balance.mode)
            .into_iter()
            .next()
        {
            return Err(issue);
        }
        let matched = match s.engine.as_str() {
            ENGINE_NIHO_3 => s.look == LOOK_NIHO_STANDARD_2,
            ENGINE_NIHO_4 => s.look == LOOK_NIHO_STANDARD_3,
            ENGINE_NIHO_5 => s.look == LOOK_NIHO_STANDARD_4,
            ENGINE_NIHO_7 | ENGINE_NIHO_11 => s.look == LOOK_NIHO_STANDARD_5,
            _ => !matches!(
                s.look.as_str(),
                LOOK_NIHO_STANDARD_2
                    | LOOK_NIHO_STANDARD_3
                    | LOOK_NIHO_STANDARD_4
                    | LOOK_NIHO_STANDARD_5
            ),
        };
        if !matched {
            let message = if matches!(s.engine.as_str(), ENGINE_NIHO_7 | ENGINE_NIHO_11)
                || s.look == LOOK_NIHO_STANDARD_5
            {
                "niho-7/niho-11 require niho-standard-5, and niho-standard-5 requires niho-7/niho-11"
            } else if s.engine == ENGINE_NIHO_5 || s.look == LOOK_NIHO_STANDARD_4 {
                "niho-5 requires niho-standard-4, and niho-standard-4 requires niho-5"
            } else if s.engine == ENGINE_NIHO_4 || s.look == LOOK_NIHO_STANDARD_3 {
                "niho-4 requires niho-standard-3, and niho-standard-3 requires niho-4"
            } else {
                "niho-3 requires niho-standard-2, and niho-standard-2 requires niho-3"
            };
            return Err(SettingsError::new("look", "engineLookMismatch", message));
        }
        Ok(s)
    }

    /// Serializes to the canonical JSON value (Photo Bench key names).
    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("v".into(), Value::from(self.v));
        o.insert("engine".into(), Value::from(self.engine.clone()));
        o.insert("look".into(), Value::from(self.look.clone()));
        o.insert(
            "base".into(),
            self.base.clone().map(Value::from).unwrap_or(Value::Null),
        );
        let scalars: &[(&str, f64)] = &[
            ("exposure", self.exposure),
            ("contrast", self.contrast),
            ("highlights", self.highlights),
            ("shadows", self.shadows),
            ("whites", self.whites),
            ("blacks", self.blacks),
            ("texture", self.texture),
            ("clarity", self.clarity),
            ("dehaze", self.dehaze),
            ("vibrance", self.vibrance),
            ("saturation", self.saturation),
            ("relativeTemperature", self.relative_temperature),
            ("relativeTint", self.relative_tint),
            ("parametricShadows", self.parametric_shadows),
            ("parametricDarks", self.parametric_darks),
            ("parametricLights", self.parametric_lights),
            ("parametricHighlights", self.parametric_highlights),
            ("parametricShadowSplit", self.parametric_shadow_split),
            ("parametricMidtoneSplit", self.parametric_midtone_split),
            ("parametricHighlightSplit", self.parametric_highlight_split),
            ("curveRefineSaturation", self.curve_refine_saturation),
        ];
        for (key, value) in scalars {
            o.insert((*key).into(), num(*value));
        }
        // Keep canonical JSON for existing engines byte-compatible unless a
        // caller explicitly supplied a non-default NIHO 3-only control.
        if matches!(
            self.engine.as_str(),
            ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
        ) || self.color_noise_reduction != 0.0
            || self.color_noise_reduction_detail != 50.0
            || self.color_noise_reduction_smoothness != 50.0
        {
            o.insert(
                "colorNoiseReduction".into(),
                num(self.color_noise_reduction),
            );
            o.insert(
                "colorNoiseReductionDetail".into(),
                num(self.color_noise_reduction_detail),
            );
            o.insert(
                "colorNoiseReductionSmoothness".into(),
                num(self.color_noise_reduction_smoothness),
            );
        }
        let mut wb = Map::new();
        wb.insert("mode".into(), Value::from(self.white_balance.mode.as_str()));
        if let Some(t) = self.white_balance.temperature {
            wb.insert("temperature".into(), num(t));
        }
        if let Some(t) = self.white_balance.tint {
            wb.insert("tint".into(), num(t));
        }
        o.insert("whiteBalance".into(), Value::Object(wb));
        o.insert(
            "toneCurves".into(),
            Value::Array(
                self.tone_curves
                    .iter()
                    .map(|c| {
                        let mut m = Map::new();
                        m.insert("channel".into(), Value::from(c.channel.as_str()));
                        m.insert(
                            "points".into(),
                            Value::Array(
                                c.points
                                    .iter()
                                    .map(|p| {
                                        let mut pm = Map::new();
                                        pm.insert("x".into(), num(p.x));
                                        pm.insert("y".into(), num(p.y));
                                        Value::Object(pm)
                                    })
                                    .collect(),
                            ),
                        );
                        Value::Object(m)
                    })
                    .collect(),
            ),
        );
        let mut hsl = Vec::new();
        for (band, a) in self.hsl.entries() {
            hsl.push(Value::from(band.as_str()));
            let mut m = Map::new();
            m.insert("hue".into(), num(a.hue));
            m.insert("saturation".into(), num(a.saturation));
            m.insert("luminance".into(), num(a.luminance));
            hsl.push(Value::Object(m));
        }
        o.insert("hsl".into(), Value::Array(hsl));
        if !self.color_points.is_empty() {
            o.insert(
                "colorPoints".into(),
                Value::Array(self.color_points.iter().map(color_point_value).collect()),
            );
        }
        if !self.masks.is_empty() {
            o.insert("masks".into(), crate::local_mask::masks_value(&self.masks));
        }
        let c = &self.calibration;
        let mut cal = Map::new();
        for (k, v) in [
            ("shadowTint", c.shadow_tint),
            ("redHue", c.red_hue),
            ("redSaturation", c.red_saturation),
            ("greenHue", c.green_hue),
            ("greenSaturation", c.green_saturation),
            ("blueHue", c.blue_hue),
            ("blueSaturation", c.blue_saturation),
        ] {
            cal.insert(k.into(), num(v));
        }
        o.insert("calibration".into(), Value::Object(cal));
        let g = &self.color_grading;
        let band = |b: &ColorGradeBand| {
            let mut m = Map::new();
            m.insert("hue".into(), num(b.hue));
            m.insert("saturation".into(), num(b.saturation));
            m.insert("luminance".into(), num(b.luminance));
            Value::Object(m)
        };
        let mut grading = Map::new();
        grading.insert("shadow".into(), band(&g.shadow));
        grading.insert("midtone".into(), band(&g.midtone));
        grading.insert("highlight".into(), band(&g.highlight));
        grading.insert("global".into(), band(&g.global));
        grading.insert("blending".into(), num(g.blending));
        grading.insert("balance".into(), num(g.balance));
        o.insert("colorGrading".into(), Value::Object(grading));
        // Effects: only groups that differ from their defaults.
        if self.grayscale {
            o.insert("grayscale".into(), Value::from(true));
        }
        if !self.gray_mixer.is_zero() {
            let mut m = Map::new();
            for band in HslBand::ALL {
                m.insert(band.as_str().into(), num(self.gray_mixer.get(band)));
            }
            o.insert("grayMixer".into(), Value::Object(m));
        }
        if self.vignette != VignetteSettings::default() {
            let v = &self.vignette;
            let mut m = Map::new();
            m.insert("amount".into(), num(v.amount));
            m.insert("midpoint".into(), num(v.midpoint));
            m.insert("roundness".into(), num(v.roundness));
            m.insert("feather".into(), num(v.feather));
            m.insert("highlights".into(), num(v.highlights));
            m.insert("style".into(), Value::from(v.style.as_str()));
            o.insert("vignette".into(), Value::Object(m));
        }
        if self.grain != GrainSettings::default() {
            let g = &self.grain;
            let mut m = Map::new();
            m.insert("amount".into(), num(g.amount));
            m.insert("size".into(), num(g.size));
            m.insert("roughness".into(), num(g.roughness));
            if let Some(seed) = g.seed {
                m.insert("seed".into(), num(seed));
            }
            o.insert("grain".into(), Value::Object(m));
        }
        if let Some(detail) = self.detail {
            let sharpening = detail.sharpening;
            let mut sharp = Map::new();
            sharp.insert("amount".into(), num(sharpening.amount));
            sharp.insert("radius".into(), num(sharpening.radius));
            sharp.insert("detail".into(), num(sharpening.detail));
            sharp.insert("masking".into(), num(sharpening.masking));
            let mut value = Map::new();
            value.insert("sharpening".into(), Value::Object(sharp));
            value.insert(
                "luminanceNoiseReduction".into(),
                num(detail.luminance_noise_reduction),
            );
            if let Some(amount) = detail.color_noise_reduction {
                value.insert("colorNoiseReduction".into(), num(amount));
            }
            o.insert("detail".into(), Value::Object(value));
        }
        if let Some(legacy) = &self.legacy_settings {
            o.insert("legacySettings".into(), Value::Object(legacy.clone()));
        }
        if let Some(geometry) = &self.geometry {
            o.insert("geometry".into(), geometry.to_value());
        }
        if !self.heal.is_empty() {
            o.insert("heal".into(), crate::heal::heal_to_value(&self.heal));
        }
        if !self.lens.is_default() {
            o.insert("lens".into(), crate::lens::lens_to_value(&self.lens));
        }
        for (k, v) in &self.extra {
            o.entry(k.clone()).or_insert_with(|| v.clone());
        }
        Value::Object(o)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.to_value()).expect("settings serialize")
    }

    /// Range checks for rendering and saving (spec ranges). Returns every
    /// problem found; an empty list means the settings are valid.
    pub fn validate(&self) -> Vec<SettingsError> {
        let mut issues = Vec::new();
        let mut check = |path: &str, value: f64, lo: f64, hi: f64| {
            if !value.is_finite() || value < lo || value > hi {
                issues.push(SettingsError::new(
                    path,
                    "outOfRange",
                    &format!("must be within {lo}..{hi}"),
                ));
            }
        };
        check("exposure", self.exposure, -5.0, 5.0);
        for (path, value) in [
            ("contrast", self.contrast),
            ("highlights", self.highlights),
            ("shadows", self.shadows),
            ("whites", self.whites),
            ("blacks", self.blacks),
            ("texture", self.texture),
            ("clarity", self.clarity),
            ("dehaze", self.dehaze),
            ("vibrance", self.vibrance),
            ("saturation", self.saturation),
            ("relativeTemperature", self.relative_temperature),
            ("relativeTint", self.relative_tint),
            ("parametricShadows", self.parametric_shadows),
            ("parametricDarks", self.parametric_darks),
            ("parametricLights", self.parametric_lights),
            ("parametricHighlights", self.parametric_highlights),
            ("calibration.shadowTint", self.calibration.shadow_tint),
            ("calibration.redHue", self.calibration.red_hue),
            ("calibration.redSaturation", self.calibration.red_saturation),
            ("calibration.greenHue", self.calibration.green_hue),
            (
                "calibration.greenSaturation",
                self.calibration.green_saturation,
            ),
            ("calibration.blueHue", self.calibration.blue_hue),
            (
                "calibration.blueSaturation",
                self.calibration.blue_saturation,
            ),
            ("colorGrading.balance", self.color_grading.balance),
        ] {
            check(path, value, -100.0, 100.0);
        }
        for (path, value) in [
            ("parametricShadowSplit", self.parametric_shadow_split),
            ("parametricMidtoneSplit", self.parametric_midtone_split),
            ("parametricHighlightSplit", self.parametric_highlight_split),
            ("curveRefineSaturation", self.curve_refine_saturation),
            ("colorGrading.blending", self.color_grading.blending),
            ("colorNoiseReduction", self.color_noise_reduction),
            (
                "colorNoiseReductionDetail",
                self.color_noise_reduction_detail,
            ),
            (
                "colorNoiseReductionSmoothness",
                self.color_noise_reduction_smoothness,
            ),
        ] {
            check(path, value, 0.0, 100.0);
        }
        for (name, b) in [
            ("shadow", &self.color_grading.shadow),
            ("midtone", &self.color_grading.midtone),
            ("highlight", &self.color_grading.highlight),
            ("global", &self.color_grading.global),
        ] {
            check(&format!("colorGrading.{name}.hue"), b.hue, 0.0, 359.0);
            check(
                &format!("colorGrading.{name}.saturation"),
                b.saturation,
                0.0,
                100.0,
            );
            check(
                &format!("colorGrading.{name}.luminance"),
                b.luminance,
                -100.0,
                100.0,
            );
        }
        for (band, a) in self.hsl.entries() {
            let b = band.as_str();
            check(&format!("hsl.{b}.hue"), a.hue, -100.0, 100.0);
            check(&format!("hsl.{b}.saturation"), a.saturation, -100.0, 100.0);
            check(&format!("hsl.{b}.luminance"), a.luminance, -100.0, 100.0);
        }
        let mut color_point_issues = Vec::new();
        if self.color_points.len() > MAX_COLOR_POINTS {
            color_point_issues.push(SettingsError::new(
                "colorPoints",
                "tooMany",
                "at most 8 color points are allowed",
            ));
        }
        let mut color_point_ids = std::collections::BTreeSet::new();
        for (index, point) in self.color_points.iter().enumerate() {
            let path = format!("colorPoints[{index}]");
            if point.id.is_empty() || point.id.len() > 64 || !point.id.is_ascii() {
                color_point_issues.push(SettingsError::new(
                    &format!("{path}.id"),
                    "invalidValue",
                    "must be 1..64 ASCII bytes",
                ));
            } else if !color_point_ids.insert(point.id.as_str()) {
                color_point_issues.push(SettingsError::new(
                    &format!("{path}.id"),
                    "duplicateId",
                    "color point ids must be unique",
                ));
            }
            check(
                &format!("{path}.target.lightness"),
                point.target.lightness,
                0.0,
                1.0,
            );
            check(
                &format!("{path}.target.chroma"),
                point.target.chroma,
                0.0,
                5.0,
            );
            check(&format!("{path}.target.hue"), point.target.hue, 0.0, 360.0);
            if point.target.hue == 360.0 {
                color_point_issues.push(SettingsError::new(
                    &format!("{path}.target.hue"),
                    "outOfRange",
                    "must be >= 0 and < 360",
                ));
            }
            check(&format!("{path}.range.hue"), point.range.hue, 1.0, 180.0);
            check(
                &format!("{path}.range.chroma"),
                point.range.chroma,
                0.001,
                5.0,
            );
            check(
                &format!("{path}.range.lightness"),
                point.range.lightness,
                0.001,
                1.0,
            );
            check(&format!("{path}.delta.hue"), point.delta.hue, -180.0, 180.0);
            check(
                &format!("{path}.delta.chromaScale"),
                point.delta.chroma_scale,
                0.0,
                3.0,
            );
            check(
                &format!("{path}.delta.lightness"),
                point.delta.lightness,
                -1.0,
                1.0,
            );
        }
        for band in HslBand::ALL {
            check(
                &format!("grayMixer.{}", band.as_str()),
                self.gray_mixer.get(band),
                -100.0,
                100.0,
            );
        }
        let v = &self.vignette;
        check("vignette.amount", v.amount, -100.0, 100.0);
        check("vignette.midpoint", v.midpoint, 0.0, 100.0);
        check("vignette.roundness", v.roundness, -100.0, 100.0);
        check("vignette.feather", v.feather, 0.0, 100.0);
        check("vignette.highlights", v.highlights, 0.0, 100.0);
        let g = &self.grain;
        check("grain.amount", g.amount, 0.0, 100.0);
        check("grain.size", g.size, 0.0, 100.0);
        check("grain.roughness", g.roughness, 0.0, 100.0);
        if let Some(seed) = g.seed {
            check("grain.seed", seed, 0.0, GRAIN_SEED_MAX);
        }
        if let Some(detail) = self.detail {
            check(
                "detail.sharpening.amount",
                detail.sharpening.amount,
                0.0,
                150.0,
            );
            check(
                "detail.sharpening.radius",
                detail.sharpening.radius,
                0.5,
                3.0,
            );
            check(
                "detail.sharpening.detail",
                detail.sharpening.detail,
                0.0,
                100.0,
            );
            check(
                "detail.sharpening.masking",
                detail.sharpening.masking,
                0.0,
                100.0,
            );
            check(
                "detail.luminanceNoiseReduction",
                detail.luminance_noise_reduction,
                0.0,
                100.0,
            );
            if let Some(amount) = detail.color_noise_reduction {
                check("detail.colorNoiseReduction", amount, 0.0, 100.0);
            }
        }
        for (i, curve) in self.tone_curves.iter().enumerate() {
            for (j, p) in curve.points.iter().enumerate() {
                check(&format!("toneCurves[{i}].points[{j}].x"), p.x, 0.0, 1.0);
                check(&format!("toneCurves[{i}].points[{j}].y"), p.y, 0.0, 1.0);
            }
        }
        match self.white_balance.mode {
            WhiteBalanceMode::Absolute => {
                match (self.white_balance.temperature, self.white_balance.tint) {
                    (Some(t), Some(tint)) => {
                        check(
                            "whiteBalance.temperature",
                            t,
                            ABSOLUTE_TEMPERATURE_RANGE.0,
                            ABSOLUTE_TEMPERATURE_RANGE.1,
                        );
                        check(
                            "whiteBalance.tint",
                            tint,
                            ABSOLUTE_TINT_RANGE.0,
                            ABSOLUTE_TINT_RANGE.1,
                        );
                    }
                    _ => issues.push(SettingsError::new(
                        "whiteBalance",
                        "missingValue",
                        "absolute white balance needs temperature and tint",
                    )),
                }
            }
            WhiteBalanceMode::AsShot | WhiteBalanceMode::Relative => {}
        }
        issues.extend(color_point_issues);
        issues.extend(crate::local_mask::validate_masks(
            &self.masks,
            self.white_balance.mode,
        ));
        if self.white_balance.mode != WhiteBalanceMode::Relative
            && (self.relative_temperature != 0.0 || self.relative_tint != 0.0)
        {
            issues.push(SettingsError::new(
                "whiteBalance.mode",
                "modeMismatch",
                "relativeTemperature / relativeTint need whiteBalance.mode = relative",
            ));
        }
        if let Some(seed) = self.grain.seed {
            if seed.is_finite() && seed != libm::trunc(seed) {
                issues.push(SettingsError::new(
                    "grain.seed",
                    "notInteger",
                    "must be an integer",
                ));
            }
        }
        if let Some(geometry) = &self.geometry {
            geometry.validate(&mut issues);
        }
        crate::heal::validate_heal(&self.heal, &mut issues);
        crate::lens::validate_lens(&self.lens, &mut issues);
        if self.v < self.required_version() {
            issues.push(SettingsError::new(
                "v",
                "versionTooLow",
                "an active lens needs v = 9, heal marks need v = 8, a perspective needs v = 7, detail needs v = 6, local masks need v = 5, color points need v = 4, active effects need v = 3, and non-identity geometry needs v = 2",
            ));
        }
        let matched = match self.engine.as_str() {
            ENGINE_NIHO_3 => self.look == LOOK_NIHO_STANDARD_2,
            ENGINE_NIHO_4 => self.look == LOOK_NIHO_STANDARD_3,
            ENGINE_NIHO_5 => self.look == LOOK_NIHO_STANDARD_4,
            ENGINE_NIHO_7 | ENGINE_NIHO_11 => self.look == LOOK_NIHO_STANDARD_5,
            _ => !matches!(
                self.look.as_str(),
                LOOK_NIHO_STANDARD_2
                    | LOOK_NIHO_STANDARD_3
                    | LOOK_NIHO_STANDARD_4
                    | LOOK_NIHO_STANDARD_5
            ),
        };
        if !matched {
            let message = if matches!(self.engine.as_str(), ENGINE_NIHO_7 | ENGINE_NIHO_11)
                || self.look == LOOK_NIHO_STANDARD_5
            {
                "niho-7/niho-11 require niho-standard-5, and niho-standard-5 requires niho-7/niho-11"
            } else if self.engine == ENGINE_NIHO_5 || self.look == LOOK_NIHO_STANDARD_4 {
                "niho-5 requires niho-standard-4, and niho-standard-4 requires niho-5"
            } else if self.engine == ENGINE_NIHO_4 || self.look == LOOK_NIHO_STANDARD_3 {
                "niho-4 requires niho-standard-3, and niho-standard-3 requires niho-4"
            } else {
                "niho-3 requires niho-standard-2, and niho-standard-2 requires niho-3"
            };
            issues.push(SettingsError::new("look", "engineLookMismatch", message));
        }
        issues
    }
}

/// Writes integral values as JSON integers (Photo Bench's JSONEncoder does
/// the same for `Double`), everything else as a float.
pub(crate) fn num(v: f64) -> Value {
    if v.is_finite() && v == libm::trunc(v) && v.abs() < 1e15 {
        Value::from(v as i64)
    } else {
        serde_json::Number::from_f64(v)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsError {
    /// JSON path (`hsl.red.hue`, `whiteBalance.mode`, ...).
    pub path: String,
    /// Stable machine code (`invalidType`, `outOfRange`, ...).
    pub code: String,
    pub message: String,
}

impl SettingsError {
    pub fn new(path: &str, code: &str, message: &str) -> Self {
        Self {
            path: path.to_string(),
            code: code.to_string(),
            message: message.to_string(),
        }
    }
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() {
            write!(f, "{}: {}", self.code, self.message)
        } else {
            write!(f, "{} ({}): {}", self.path, self.code, self.message)
        }
    }
}

impl std::error::Error for SettingsError {}

pub(crate) fn number(v: &Value, path: &str) -> Result<f64, SettingsError> {
    let n = v
        .as_f64()
        .ok_or_else(|| SettingsError::new(path, "invalidType", "must be a number"))?;
    if !n.is_finite() {
        return Err(SettingsError::new(path, "notFinite", "must be finite"));
    }
    Ok(n)
}

pub(crate) fn string(v: &Value, path: &str) -> Result<String, SettingsError> {
    v.as_str()
        .map(str::to_string)
        .ok_or_else(|| SettingsError::new(path, "invalidType", "must be a string"))
}

pub(crate) fn object<'a>(
    v: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, SettingsError> {
    v.as_object()
        .ok_or_else(|| SettingsError::new(path, "invalidType", "must be an object"))
}

fn parse_white_balance(v: &Value) -> Result<WhiteBalance, SettingsError> {
    let o = object(v, "whiteBalance")?;
    let mode = match o.get("mode").map(|m| m.as_str()) {
        None => WhiteBalanceMode::AsShot,
        Some(Some("asShot")) => WhiteBalanceMode::AsShot,
        Some(Some("absolute")) => WhiteBalanceMode::Absolute,
        Some(Some("relative")) => WhiteBalanceMode::Relative,
        Some(_) => {
            return Err(SettingsError::new(
                "whiteBalance.mode",
                "invalidValue",
                "must be asShot, absolute or relative",
            ))
        }
    };
    let optional = |key: &str| -> Result<Option<f64>, SettingsError> {
        match o.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => number(value, &format!("whiteBalance.{key}")).map(Some),
        }
    };
    Ok(WhiteBalance {
        mode,
        temperature: optional("temperature")?,
        tint: optional("tint")?,
    })
}

pub(crate) fn parse_tone_curves(v: &Value) -> Result<Vec<ToneCurve>, SettingsError> {
    let array = v
        .as_array()
        .ok_or_else(|| SettingsError::new("toneCurves", "invalidType", "must be an array"))?;
    let mut curves = Vec::new();
    for (i, item) in array.iter().enumerate() {
        let path = format!("toneCurves[{i}]");
        let o = object(item, &path)?;
        let channel = o
            .get("channel")
            .and_then(Value::as_str)
            .and_then(CurveChannel::parse)
            .ok_or_else(|| {
                SettingsError::new(
                    &format!("{path}.channel"),
                    "invalidValue",
                    "must be rgb, red, green or blue",
                )
            })?;
        let points_value = o.get("points").and_then(Value::as_array).ok_or_else(|| {
            SettingsError::new(&format!("{path}.points"), "invalidType", "must be an array")
        })?;
        let mut points = Vec::new();
        for (j, p) in points_value.iter().enumerate() {
            let pp = format!("{path}.points[{j}]");
            let po = object(p, &pp)?;
            let x = number(po.get("x").unwrap_or(&Value::Null), &format!("{pp}.x"))?;
            let y = number(po.get("y").unwrap_or(&Value::Null), &format!("{pp}.y"))?;
            points.push(CurvePoint { x, y });
        }
        if curves.iter().any(|c: &ToneCurve| c.channel == channel) {
            return Err(SettingsError::new(
                &path,
                "duplicateChannel",
                "one curve per channel",
            ));
        }
        curves.push(ToneCurve { channel, points });
    }
    Ok(curves)
}

fn parse_hsl_adjustment(v: &Value, path: &str) -> Result<HslAdjustment, SettingsError> {
    let o = object(v, path)?;
    let get = |key: &str| -> Result<f64, SettingsError> {
        match o.get(key) {
            None => Ok(0.0),
            Some(value) => number(value, &format!("{path}.{key}")),
        }
    };
    Ok(HslAdjustment {
        hue: get("hue")?,
        saturation: get("saturation")?,
        luminance: get("luminance")?,
    })
}

pub(crate) fn parse_hsl(v: &Value) -> Result<HslAdjustments, SettingsError> {
    let mut result = HslAdjustments::default();
    let mut insert = |band_name: &str, value: &Value| -> Result<(), SettingsError> {
        let band = HslBand::parse(band_name).ok_or_else(|| {
            SettingsError::new(
                &format!("hsl.{band_name}"),
                "invalidValue",
                "unknown HSL band",
            )
        })?;
        if result.get(band).is_some() {
            return Err(SettingsError::new(
                &format!("hsl.{band_name}"),
                "duplicateBand",
                "one entry per band",
            ));
        }
        let adjustment = parse_hsl_adjustment(value, &format!("hsl.{band_name}"))?;
        result.set(band, adjustment);
        Ok(())
    };
    match v {
        Value::Array(items) => {
            if items.len() % 2 != 0 {
                return Err(SettingsError::new(
                    "hsl",
                    "invalidType",
                    "alternating [band, adjustment] array expected",
                ));
            }
            for pair in items.chunks(2) {
                let name = pair[0].as_str().ok_or_else(|| {
                    SettingsError::new("hsl", "invalidType", "band name must be a string")
                })?;
                insert(name, &pair[1])?;
            }
        }
        Value::Object(map) => {
            for (name, value) in map {
                insert(name, value)?;
            }
        }
        _ => {
            return Err(SettingsError::new(
                "hsl",
                "invalidType",
                "must be an array or an object",
            ))
        }
    }
    Ok(result)
}

fn exact_object<'a>(
    value: &'a Value,
    path: &str,
    keys: &[&str],
) -> Result<&'a Map<String, Value>, SettingsError> {
    let object = object(value, path)?;
    if let Some(key) = object.keys().find(|key| !keys.contains(&key.as_str())) {
        return Err(SettingsError::new(
            &format!("{path}.{key}"),
            "unknownKey",
            "unknown object field",
        ));
    }
    Ok(object)
}

fn required_number(
    object: &Map<String, Value>,
    path: &str,
    key: &str,
) -> Result<f64, SettingsError> {
    number(
        object.get(key).unwrap_or(&Value::Null),
        &format!("{path}.{key}"),
    )
}

pub(crate) fn parse_color_points(v: &Value) -> Result<Vec<ColorPoint>, SettingsError> {
    let points = v
        .as_array()
        .ok_or_else(|| SettingsError::new("colorPoints", "invalidType", "must be an array"))?;
    if points.len() > MAX_COLOR_POINTS {
        return Err(SettingsError::new(
            "colorPoints",
            "tooMany",
            "at most 8 color points are allowed",
        ));
    }
    let mut result = Vec::with_capacity(points.len());
    for (index, value) in points.iter().enumerate() {
        let path = format!("colorPoints[{index}]");
        let point = exact_object(value, &path, &["id", "target", "range", "delta"])?;
        let id = string(
            point.get("id").unwrap_or(&Value::Null),
            &format!("{path}.id"),
        )?;
        let target_path = format!("{path}.target");
        let target = exact_object(
            point.get("target").unwrap_or(&Value::Null),
            &target_path,
            &["lightness", "chroma", "hue"],
        )?;
        let range_path = format!("{path}.range");
        let range = exact_object(
            point.get("range").unwrap_or(&Value::Null),
            &range_path,
            &["hue", "chroma", "lightness"],
        )?;
        let delta_path = format!("{path}.delta");
        let delta = exact_object(
            point.get("delta").unwrap_or(&Value::Null),
            &delta_path,
            &["hue", "chromaScale", "lightness"],
        )?;
        result.push(ColorPoint {
            id,
            target: OklchTarget {
                lightness: required_number(target, &target_path, "lightness")?,
                chroma: required_number(target, &target_path, "chroma")?,
                hue: required_number(target, &target_path, "hue")?,
            },
            range: OklchRange {
                hue: required_number(range, &range_path, "hue")?,
                chroma: required_number(range, &range_path, "chroma")?,
                lightness: required_number(range, &range_path, "lightness")?,
            },
            delta: OklchDelta {
                hue: required_number(delta, &delta_path, "hue")?,
                chroma_scale: required_number(delta, &delta_path, "chromaScale")?,
                lightness: required_number(delta, &delta_path, "lightness")?,
            },
        });
    }
    Ok(result)
}

fn color_point_value(point: &ColorPoint) -> Value {
    let object3 = |values: [(&str, f64); 3]| {
        Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key.to_string(), num(value)))
                .collect(),
        )
    };
    Value::Object(Map::from_iter([
        ("id".into(), Value::from(point.id.clone())),
        (
            "target".into(),
            object3([
                ("lightness", point.target.lightness),
                ("chroma", point.target.chroma),
                ("hue", point.target.hue),
            ]),
        ),
        (
            "range".into(),
            object3([
                ("hue", point.range.hue),
                ("chroma", point.range.chroma),
                ("lightness", point.range.lightness),
            ]),
        ),
        (
            "delta".into(),
            object3([
                ("hue", point.delta.hue),
                ("chromaScale", point.delta.chroma_scale),
                ("lightness", point.delta.lightness),
            ]),
        ),
    ]))
}

pub(crate) fn parse_calibration(v: &Value) -> Result<CalibrationSettings, SettingsError> {
    let o = object(v, "calibration")?;
    let get = |key: &str| -> Result<f64, SettingsError> {
        match o.get(key) {
            None => Ok(0.0),
            Some(value) => number(value, &format!("calibration.{key}")),
        }
    };
    Ok(CalibrationSettings {
        shadow_tint: get("shadowTint")?,
        red_hue: get("redHue")?,
        red_saturation: get("redSaturation")?,
        green_hue: get("greenHue")?,
        green_saturation: get("greenSaturation")?,
        blue_hue: get("blueHue")?,
        blue_saturation: get("blueSaturation")?,
    })
}

fn parse_grade_band(v: Option<&Value>, path: &str) -> Result<ColorGradeBand, SettingsError> {
    let Some(v) = v else {
        return Ok(ColorGradeBand::default());
    };
    let o = object(v, path)?;
    let get = |key: &str| -> Result<f64, SettingsError> {
        match o.get(key) {
            None => Ok(0.0),
            Some(value) => number(value, &format!("{path}.{key}")),
        }
    };
    Ok(ColorGradeBand {
        hue: get("hue")?,
        saturation: get("saturation")?,
        luminance: get("luminance")?,
    })
}

pub(crate) fn parse_color_grading(v: &Value) -> Result<ColorGradingSettings, SettingsError> {
    let o = object(v, "colorGrading")?;
    let scalar = |key: &str, default: f64| -> Result<f64, SettingsError> {
        match o.get(key) {
            None => Ok(default),
            Some(value) => number(value, &format!("colorGrading.{key}")),
        }
    };
    Ok(ColorGradingSettings {
        shadow: parse_grade_band(o.get("shadow"), "colorGrading.shadow")?,
        midtone: parse_grade_band(o.get("midtone"), "colorGrading.midtone")?,
        highlight: parse_grade_band(o.get("highlight"), "colorGrading.highlight")?,
        global: parse_grade_band(o.get("global"), "colorGrading.global")?,
        blending: scalar("blending", 100.0)?,
        balance: scalar("balance", 0.0)?,
    })
}

pub(crate) fn parse_gray_mixer(v: &Value) -> Result<GrayMixer, SettingsError> {
    let o = object(v, "grayMixer")?;
    let mut mixer = GrayMixer::default();
    for (name, value) in o {
        let path = format!("grayMixer.{name}");
        let band = HslBand::parse(name)
            .ok_or_else(|| SettingsError::new(&path, "invalidValue", "unknown HSL band"))?;
        mixer.set(band, number(value, &path)?);
    }
    Ok(mixer)
}

pub(crate) fn parse_vignette(v: &Value) -> Result<VignetteSettings, SettingsError> {
    let o = object(v, "vignette")?;
    let d = VignetteSettings::default();
    let get = |key: &str, default: f64| -> Result<f64, SettingsError> {
        match o.get(key) {
            None => Ok(default),
            Some(value) => number(value, &format!("vignette.{key}")),
        }
    };
    let style = match o.get("style") {
        None => d.style,
        Some(value) => {
            let name = string(value, "vignette.style")?;
            VignetteStyle::parse(&name).ok_or_else(|| {
                SettingsError::new(
                    "vignette.style",
                    "invalidValue",
                    "must be highlightPriority, colorPriority or paintOverlay",
                )
            })?
        }
    };
    Ok(VignetteSettings {
        amount: get("amount", d.amount)?,
        midpoint: get("midpoint", d.midpoint)?,
        roundness: get("roundness", d.roundness)?,
        feather: get("feather", d.feather)?,
        highlights: get("highlights", d.highlights)?,
        style,
    })
}

pub(crate) fn parse_grain(v: &Value) -> Result<GrainSettings, SettingsError> {
    let o = object(v, "grain")?;
    let d = GrainSettings::default();
    let get = |key: &str, default: f64| -> Result<f64, SettingsError> {
        match o.get(key) {
            None => Ok(default),
            Some(value) => number(value, &format!("grain.{key}")),
        }
    };
    let seed = match o.get("seed") {
        None | Some(Value::Null) => None,
        Some(value) => Some(number(value, "grain.seed")?),
    };
    Ok(GrainSettings {
        amount: get("amount", d.amount)?,
        size: get("size", d.size)?,
        roughness: get("roughness", d.roughness)?,
        seed,
    })
}

fn parse_detail(v: &Value) -> Result<DetailSettings, SettingsError> {
    let detail = exact_object(
        v,
        "detail",
        &[
            "sharpening",
            "luminanceNoiseReduction",
            "colorNoiseReduction",
        ],
    )?;
    let sharpening = exact_object(
        detail.get("sharpening").unwrap_or(&Value::Null),
        "detail.sharpening",
        &["amount", "radius", "detail", "masking"],
    )?;
    Ok(DetailSettings {
        sharpening: SharpeningSettings {
            amount: required_number(sharpening, "detail.sharpening", "amount")?,
            radius: required_number(sharpening, "detail.sharpening", "radius")?,
            detail: required_number(sharpening, "detail.sharpening", "detail")?,
            masking: required_number(sharpening, "detail.sharpening", "masking")?,
        },
        luminance_noise_reduction: required_number(detail, "detail", "luminanceNoiseReduction")?,
        color_noise_reduction: detail
            .get("colorNoiseReduction")
            .map(|value| number(value, "detail.colorNoiseReduction"))
            .transpose()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_round_trips_and_is_neutral() {
        let neutral = DevelopSettings::neutral();
        assert!(neutral.is_neutral());
        assert!(neutral.validate().is_empty());
        let parsed = DevelopSettings::from_json(&neutral.to_json()).unwrap();
        assert_eq!(parsed, neutral);
        let value = neutral.to_value();
        assert_eq!(value["v"], 1);
        assert_eq!(value["engine"], "niho-1");
        assert_eq!(value["look"], "niho-interim-1");
        assert!(value["base"].is_null());
        assert_eq!(value["whiteBalance"]["mode"], "asShot");
        assert_eq!(value["colorGrading"]["blending"], 100);
    }

    #[test]
    fn detail_v6_is_exact_round_trips_and_preserves_explicit_zero_override() {
        let json = r#"{"v":6,"detail":{"sharpening":{"amount":0,"radius":1,"detail":25,"masking":0},"luminanceNoiseReduction":0,"colorNoiseReduction":0}}"#;
        let parsed = DevelopSettings::from_json(json).unwrap();
        assert_eq!(parsed.required_version(), DETAIL_SETTINGS_VERSION);
        assert!(parsed.is_neutral());
        assert_eq!(parsed.raw_color_noise_reduction(), 0.0);
        assert_eq!(
            DevelopSettings::from_value(&parsed.to_value()).unwrap(),
            parsed
        );
        assert!(parsed.to_value()["detail"]
            .get("colorNoiseReduction")
            .is_some());

        let inherited = DevelopSettings::from_json(
            r#"{"v":6,"colorNoiseReduction":31,"detail":{"sharpening":{"amount":0,"radius":1,"detail":25,"masking":0},"luminanceNoiseReduction":0}}"#,
        )
        .unwrap();
        assert_eq!(inherited.raw_color_noise_reduction(), 31.0);
    }

    #[test]
    fn detail_rejects_empty_partial_unknown_nonfinite_ranges_and_old_version() {
        let error = |json: &str| DevelopSettings::from_json(json).unwrap_err();
        assert_eq!(error(r#"{"v":6,"detail":{}}"#).path, "detail.sharpening");
        assert_eq!(
            error(r#"{"v":6,"detail":{"sharpening":{"amount":0,"radius":1,"detail":25,"masking":0,"future":1},"luminanceNoiseReduction":0}}"#).code,
            "unknownKey"
        );
        assert_eq!(
            error(r#"{"v":6,"detail":{"sharpening":{"amount":0,"radius":1,"detail":25,"masking":0},"luminanceNoiseReduction":"NaN"}}"#).code,
            "invalidType"
        );
        let out_of_range = DevelopSettings::from_json(
            r#"{"v":6,"detail":{"sharpening":{"amount":151,"radius":0.4,"detail":101,"masking":-1},"luminanceNoiseReduction":101,"colorNoiseReduction":-1}}"#,
        )
        .unwrap();
        assert_eq!(out_of_range.validate().len(), 6);
        let old = DevelopSettings::from_json(
            r#"{"v":4,"detail":{"sharpening":{"amount":0,"radius":1,"detail":25,"masking":0},"luminanceNoiseReduction":0}}"#,
        )
        .unwrap();
        assert_eq!(old.validate()[0].code, "versionTooLow");
    }

    #[test]
    fn new_edit_keeps_niho1_and_standard_look_while_neutral_saved_settings_remain_interim() {
        assert_eq!(DevelopSettings::neutral().engine, ENGINE_NIHO_1);
        assert_eq!(DevelopSettings::neutral().look, LOOK_NIHO_INTERIM_1);
        assert_eq!(DevelopSettings::new_edit().engine, ENGINE_NIHO_1);
        assert_eq!(DevelopSettings::new_edit().look, LOOK_NIHO_STANDARD_1);
        assert_eq!(
            DevelopSettings::from_json("{}").unwrap().look,
            LOOK_NIHO_INTERIM_1
        );
        assert_eq!(
            DevelopSettings::from_json(r#"{"exposure":0.25}"#)
                .unwrap()
                .look,
            LOOK_NIHO_INTERIM_1
        );
    }

    #[test]
    fn empty_object_reads_as_neutral() {
        let parsed = DevelopSettings::from_json("{}").unwrap();
        assert_eq!(parsed, DevelopSettings::neutral());
    }

    #[test]
    fn hsl_accepts_alternating_array_and_object() {
        let a = DevelopSettings::from_json(
            r#"{"hsl":["blue",{"hue":-14,"saturation":14,"luminance":17},"green",{"hue":12,"saturation":-23,"luminance":0}]}"#,
        )
        .unwrap();
        let b = DevelopSettings::from_json(
            r#"{"hsl":{"green":{"hue":12,"saturation":-23},"blue":{"hue":-14,"saturation":14,"luminance":17}}}"#,
        )
        .unwrap();
        assert_eq!(a.hsl, b.hsl);
        assert_eq!(a.hsl.entries()[0].0, HslBand::Green);
        let out = a.to_value();
        assert_eq!(out["hsl"][0], "green");
        assert_eq!(out["hsl"][3]["luminance"], 17);
    }

    #[test]
    fn unknown_keys_are_preserved() {
        let parsed = DevelopSettings::from_json(r#"{"futureKey":{"a":1},"exposure":0.5}"#).unwrap();
        assert_eq!(parsed.extra["futureKey"]["a"], 1);
        let out = parsed.to_value();
        assert_eq!(out["futureKey"]["a"], 1);
        assert_eq!(out["exposure"], 0.5);
    }

    #[test]
    fn rejects_unknown_engine_and_non_finite() {
        assert_eq!(
            DevelopSettings::from_json(r#"{"engine":"niho-2"}"#)
                .unwrap()
                .engine,
            ENGINE_NIHO_2
        );
        assert_eq!(
            DevelopSettings::from_json(r#"{"engine":"niho-8"}"#)
                .unwrap()
                .engine,
            ENGINE_NIHO_8
        );
        assert_eq!(
            DevelopSettings::from_json(r#"{"engine":"niho-12"}"#)
                .unwrap()
                .engine,
            ENGINE_NIHO_12
        );
        assert_eq!(
            DevelopSettings::from_json(r#"{"engine":"niho-13"}"#)
                .unwrap()
                .engine,
            ENGINE_NIHO_13
        );
        assert_eq!(
            DevelopSettings::from_json(r#"{"engine":"niho-14"}"#)
                .unwrap()
                .engine,
            ENGINE_NIHO_14
        );
        for unknown in ["niho-9", "niho-15"] {
            assert_eq!(
                DevelopSettings::from_json(&format!(r#"{{"engine":"{unknown}"}}"#))
                    .unwrap_err()
                    .code,
                "unsupportedEngine"
            );
        }
        assert_eq!(
            DevelopSettings::from_json(r#"{"exposure":"1"}"#)
                .unwrap_err()
                .code,
            "invalidType"
        );
        assert_eq!(
            DevelopSettings::from_json(r#"{"whiteBalance":{"mode":"custom"}}"#)
                .unwrap_err()
                .code,
            "invalidValue"
        );
    }

    #[test]
    fn geometry_needs_v2_and_round_trips() {
        let crop = r#""geometry":{"rotate":90,"angle":-2.5,"crop":{"left":0.1,"top":0,"right":0.9,"bottom":1},"aspect":"4:5"}"#;
        let v2 = DevelopSettings::from_json(&format!(r#"{{"v":2,{crop}}}"#)).unwrap();
        assert_eq!(v2.v, 2);
        assert_eq!(v2.required_version(), 2);
        assert!(v2.validate().is_empty());
        assert!(v2.is_neutral(), "the geometry is not a color edit");
        let out = v2.to_value();
        assert_eq!(out["v"], 2);
        assert_eq!(out["geometry"]["rotate"], 90);
        assert_eq!(out["geometry"]["angle"], -2.5);
        assert_eq!(out["geometry"]["crop"]["left"], 0.1);
        assert_eq!(out["geometry"]["aspect"], "4:5");
        assert_eq!(DevelopSettings::from_value(&out).unwrap(), v2);

        let v1 = DevelopSettings::from_json(&format!(r#"{{"v":1,{crop}}}"#)).unwrap();
        let codes: Vec<_> = v1
            .validate()
            .into_iter()
            .map(|e| (e.path, e.code))
            .collect();
        assert_eq!(codes, vec![("v".to_string(), "versionTooLow".to_string())]);

        // An identity geometry (only the aspect lock) stays v 1; v 2 is read
        // without one too.
        let lock = DevelopSettings::from_json(r#"{"v":1,"geometry":{"aspect":"1:1"}}"#).unwrap();
        assert_eq!(lock.required_version(), 1);
        assert!(lock.validate().is_empty());
        assert!(DevelopSettings::from_json(r#"{"v":2}"#)
            .unwrap()
            .validate()
            .is_empty());
        // Settings without a geometry do not gain the key.
        assert!(DevelopSettings::neutral()
            .to_value()
            .get("geometry")
            .is_none());
        assert!(DevelopSettings::from_json(r#"{"v":4}"#).is_ok());
        assert!(DevelopSettings::from_json(r#"{"v":5}"#).is_ok());
        assert!(DevelopSettings::from_json(r#"{"v":6}"#).is_ok());
        assert_eq!(
            DevelopSettings::from_json(r#"{"v":10}"#).unwrap_err().code,
            "unsupportedVersion"
        );
        assert_eq!(
            DevelopSettings::from_json(r#"{"v":1.5}"#).unwrap_err().code,
            "unsupportedVersion"
        );
        assert_eq!(
            DevelopSettings::from_json(r#"{"geometry":{"rotate":45}}"#)
                .unwrap_err()
                .path,
            "geometry.rotate"
        );
    }

    #[test]
    fn a_perspective_needs_v7_above_every_other_feature() {
        let perspective = r#""geometry":{"perspective":{"vertical":-25}}"#;
        let v7 = DevelopSettings::from_json(&format!(r#"{{"v":7,{perspective}}}"#)).unwrap();
        assert_eq!(v7.v, PERSPECTIVE_SETTINGS_VERSION);
        assert_eq!(v7.required_version(), 7);
        assert!(v7.validate().is_empty());
        assert!(v7.is_neutral(), "the perspective is not a color edit");
        assert_eq!(DevelopSettings::from_value(&v7.to_value()).unwrap(), v7);
        // Lower versions are too low, whatever else they carry.
        for v in [2, 3, 4] {
            let low = DevelopSettings::from_json(&format!(r#"{{"v":{v},{perspective}}}"#)).unwrap();
            assert!(low
                .validate()
                .iter()
                .any(|issue| issue.path == "v" && issue.code == "versionTooLow"));
        }
        let mut with_points = v7.clone();
        with_points.grayscale = true;
        assert_eq!(with_points.required_version(), 7);
        // `constrain` and `upright` alone keep the old version (they do not
        // change the pixels an older reader would draw).
        let switches = DevelopSettings::from_json(
            r#"{"v":1,"geometry":{"constrain":true,"upright":1,"perspective":{"scale":100}}}"#,
        )
        .unwrap();
        assert_eq!(switches.required_version(), 1);
        assert!(switches.validate().is_empty());
        assert!(READABLE_SETTINGS_VERSIONS.contains(&7));
        assert_eq!(MAX_SETTINGS_VERSION, LENS_SETTINGS_VERSION);
    }

    #[test]
    fn validate_reports_ranges_and_white_balance_mode() {
        let mut s = DevelopSettings::neutral();
        s.contrast = 120.0;
        s.relative_temperature = 10.0;
        s.white_balance = WhiteBalance {
            mode: WhiteBalanceMode::Absolute,
            temperature: Some(1500.0),
            tint: Some(0.0),
        };
        let codes: Vec<_> = s.validate().into_iter().map(|e| (e.path, e.code)).collect();
        assert!(codes.contains(&("contrast".into(), "outOfRange".into())));
        assert!(codes.contains(&("whiteBalance.temperature".into(), "outOfRange".into())));
        assert!(codes.contains(&("whiteBalance.mode".into(), "modeMismatch".into())));
    }

    fn with_effects() -> DevelopSettings {
        let mut s = DevelopSettings::neutral();
        s.v = EFFECTS_SETTINGS_VERSION;
        s.grayscale = true;
        s.gray_mixer.set(HslBand::Red, 40.0);
        s.gray_mixer.set(HslBand::Blue, -25.5);
        s.vignette = VignetteSettings {
            amount: -30.0,
            midpoint: 40.0,
            roundness: -20.0,
            feather: 70.0,
            highlights: 10.0,
            style: VignetteStyle::PaintOverlay,
        };
        s.grain = GrainSettings {
            amount: 35.0,
            size: 30.0,
            roughness: 60.0,
            seed: Some(4_294_967_295.0),
        };
        s
    }

    #[test]
    fn effects_are_written_only_when_they_differ_from_the_defaults() {
        let neutral = DevelopSettings::neutral().to_value();
        for key in ["grayscale", "grayMixer", "vignette", "grain"] {
            assert!(neutral.get(key).is_none(), "{key}");
        }
        // A default-valued group read back is the same settings, and is
        // omitted again.
        let parsed = DevelopSettings::from_json(
            r#"{"grayscale":false,"grayMixer":{"red":0},"vignette":{"amount":0,"style":"highlightPriority"},"grain":{"size":25}}"#,
        )
        .unwrap();
        assert_eq!(parsed, DevelopSettings::neutral());
        assert!(parsed.is_neutral());

        let s = with_effects();
        let value = s.to_value();
        assert_eq!(value["grayscale"], true);
        assert_eq!(value["grayMixer"]["red"], 40);
        assert_eq!(value["grayMixer"]["blue"], -25.5);
        assert_eq!(value["grayMixer"]["green"], 0);
        assert_eq!(value["vignette"]["style"], "paintOverlay");
        assert_eq!(value["vignette"]["midpoint"], 40);
        assert_eq!(value["grain"]["seed"], 4_294_967_295u64);
        assert_eq!(DevelopSettings::from_value(&value).unwrap(), s);
        assert!(s.validate().is_empty(), "{:?}", s.validate());

        // One field off its default writes the whole group (defaults filled).
        let mut only_size = DevelopSettings::neutral();
        only_size.grain.size = 60.0;
        let v = only_size.to_value();
        assert_eq!(v["grain"]["amount"], 0);
        assert_eq!(v["grain"]["roughness"], 50);
        assert!(v["grain"].get("seed").is_none());
        assert_eq!(DevelopSettings::from_value(&v).unwrap(), only_size);
        // Inactive values are not an edit.
        assert!(only_size.is_neutral());
    }

    #[test]
    fn effects_make_settings_non_neutral() {
        let mut gray = DevelopSettings::neutral();
        gray.grayscale = true;
        assert!(!gray.is_neutral());
        let mut mixer_only = DevelopSettings::neutral();
        mixer_only.gray_mixer.set(HslBand::Green, 20.0);
        assert!(mixer_only.is_neutral());
        let mut vignette = DevelopSettings::neutral();
        vignette.vignette.amount = 5.0;
        assert!(!vignette.is_neutral());
        let mut grain = DevelopSettings::neutral();
        grain.grain.amount = 1.0;
        assert!(!grain.is_neutral());
    }

    #[test]
    fn active_effects_need_v3_and_round_trip() {
        let mut effects = DevelopSettings::neutral();
        effects.grayscale = true;
        assert_eq!(effects.required_version(), EFFECTS_SETTINGS_VERSION);
        assert!(effects
            .validate()
            .iter()
            .any(|issue| issue.code == "versionTooLow"));

        effects.v = EFFECTS_SETTINGS_VERSION;
        assert!(effects.validate().is_empty(), "{:?}", effects.validate());
        let value = effects.to_value();
        assert_eq!(value["v"], EFFECTS_SETTINGS_VERSION);
        assert_eq!(DevelopSettings::from_value(&value).unwrap(), effects);

        let v2_with_effect = DevelopSettings::from_json(r#"{"v":2,"grain":{"amount":1}}"#).unwrap();
        assert_eq!(v2_with_effect.required_version(), EFFECTS_SETTINGS_VERSION);
        assert!(v2_with_effect
            .validate()
            .iter()
            .any(|issue| issue.code == "versionTooLow"));
    }

    #[test]
    fn effects_parse_errors_and_ranges() {
        let code = |json: &str| DevelopSettings::from_json(json).unwrap_err().code;
        assert_eq!(code(r#"{"grayscale":1}"#), "invalidType");
        assert_eq!(code(r#"{"grayMixer":[]}"#), "invalidType");
        assert_eq!(code(r#"{"grayMixer":{"red":"1"}}"#), "invalidType");
        assert_eq!(code(r#"{"grayMixer":{"cyan":1}}"#), "invalidValue");
        assert_eq!(code(r#"{"vignette":{"style":"soft"}}"#), "invalidValue");
        assert_eq!(code(r#"{"vignette":{"style":2}}"#), "invalidType");
        assert_eq!(code(r#"{"grain":{"amount":null}}"#), "invalidType");
        assert_eq!(
            DevelopSettings::from_json(r#"{"grain":{"seed":null}}"#)
                .unwrap()
                .grain
                .seed,
            None
        );

        let mut s = with_effects();
        s.gray_mixer.set(HslBand::Aqua, 101.0);
        s.vignette.amount = -101.0;
        s.vignette.midpoint = -1.0;
        s.vignette.roundness = 120.0;
        s.vignette.feather = 101.0;
        s.vignette.highlights = -5.0;
        s.grain.amount = -1.0;
        s.grain.size = 101.0;
        s.grain.roughness = 200.0;
        s.grain.seed = Some(4_294_967_296.0);
        let issues: Vec<_> = s.validate().into_iter().map(|e| (e.path, e.code)).collect();
        for path in [
            "grayMixer.aqua",
            "vignette.amount",
            "vignette.midpoint",
            "vignette.roundness",
            "vignette.feather",
            "vignette.highlights",
            "grain.amount",
            "grain.size",
            "grain.roughness",
            "grain.seed",
        ] {
            assert!(
                issues.contains(&(path.to_string(), "outOfRange".to_string())),
                "{path}: {issues:?}"
            );
        }
        let mut fractional = DevelopSettings::neutral();
        fractional.grain.seed = Some(1.5);
        assert_eq!(fractional.validate()[0].code, "notInteger");
    }
}
