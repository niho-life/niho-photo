//! Stage 2 rendering (spec "段 2", Photo Bench production paths).
//!
//! RAW working copy (`AdobeBaseRenderer.Handle.image(settings:)`, spatial
//! order `.preTone`):
//!   [absolute WB: the working copy's white-balance table, else
//!   approximate] -> exposure `2^(baselineEV + exposure)` ->
//!   [S] Highlights / Shadows / Texture / Clarity -> [DCP LookTable: PR2] ->
//!   look HSV (`niho-interim-1` identity / `niho-standard-1`) -> ACR3
//!   default curve (one cube with the look) ->
//!   cube P (Contrast, Dehaze, Whites, Blacks, Parametric, Point, look tone) ->
//!   Calibration (matrix, clamp) -> cube Q (Vibrance, Saturation, HSL,
//!   Color Grading) -> linear sRGB -> relative temperature / tint ->
//!   [reduce] -> highlight shoulder + gamut compression -> sRGB 8-bit.
//!
//! JPEG / PNG original (`RenderEngine.apply`, spatial order `.sP1P2`): no
//! look, no default curve, the non-RAW exposure formula inside cube P:
//!   [`niho-1`: relative temperature / tint on the input] ->
//!   ProPhoto -> [S] -> cube P (exposureNonRaw + P) -> linear sRGB ->
//!   ProPhoto -> Calibration -> cube Q -> linear sRGB -> [reduce] ->
//!   output transform (when Photo Bench applies it) -> sRGB 8-bit ->
//!   [`niho-2`: calibrated incremental-WB RGB delta LUT].
//!
//! Effects (NIHO extension, `effects.rs`): on RAW, the black & white mix is
//! immediately after ACR3 and its grading is in cube Q; on raster input the
//! mix remains in cube Q. The
//! vignette's highlight / color priority (gain, or a blend toward white when
//! brightening) after the local pass, before the first cube; the paint
//! overlay and grain on the encoded output, before the 8-bit quantization. Drag and released frames apply them at the
//! same places with the same planes.
//!
//! Processing happens at the output resolution: the original is reduced to
//! `max_dimension` while decoding, so the "reduce" step is a no-op here
//! (spec: local processing radius follows the long edge; different output
//! sizes differ, compared at 1500px). With a geometry the image is a window
//! around the output ([`Framing`], [`crate::frame`]): the radii follow the
//! whole frame's long edge at this scale, the adaptive statistics the whole
//! photo, and only the output rectangle is written.

use crate::color::{
    mat_vec_f32, raw_white_balance_prophoto, srgb_oetf_f32, to_f32, xy_from_temperature, Xy,
    PP_LUMA_F32, PROPHOTO_TO_SRGB_F32, REC709_LUMA_F32, SRGB_TO_PROPHOTO_F32,
};
use crate::color_ops::{
    self, calibration_matrix, needs_calibration, needs_color_ops, PreparedColorOps,
};
use crate::decode::{AsShotWhite, LinearImage, Raster, WorkingCopyMeta};
use crate::effects::{self, EffectsCache, LinearVignette, OutputEffects};
use crate::fastmath::{srgb8, UnitTable};
use crate::frame::Rect;
use crate::jpeg_wb::PreparedJpegWhiteBalance;
use crate::lut::{decode, encode, Cube, CUBE_DIMENSION};
use crate::output::{output_transform, output_transform_clip};
use crate::relative_wb::relative_matrix;
use crate::resize::{bilinear_downscale, bilinear_downscale_with, Filter};
use crate::settings::{
    uses_float_cubes, uses_head_white_balance, DevelopSettings, VignetteStyle, WhiteBalanceMode,
    ENGINE_NIHO_10, ENGINE_NIHO_11, ENGINE_NIHO_12, ENGINE_NIHO_2, ENGINE_NIHO_3, ENGINE_NIHO_4,
    ENGINE_NIHO_5, ENGINE_NIHO_6, ENGINE_NIHO_7, ENGINE_NIHO_8,
};
use crate::spatial::{
    self, adaptive_parameters, AdaptivePath, AdaptiveStats, Plane, Quality, SpatialParams,
};
use crate::tone_ops::{exposure_non_raw, needs_post_ops, rgb_tone, PreparedPostOps};
use crate::wb_table::WhiteBalanceTable;
use std::sync::{Arc, OnceLock};

/// `AdobeBaseRenderer.dragCubeDimension` (interactive tone cube).
pub const INTERACTIVE_TONE_CUBE_DIMENSION: usize = 33;

#[derive(Debug, Clone, Copy)]
pub struct RenderOptions {
    /// Long-edge cap of the output (0 = original size).
    pub max_dimension: usize,
    pub quality: Quality,
    /// Reduction filter (Lanczos-3 default; area average is faster).
    pub filter: Filter,
    /// With a geometry, the one-shot render decodes the original large
    /// enough for the crop to reach `max_dimension`, at most this long
    /// edge (0 = no cap; `crate::frame::decode_long_edge`). Without a
    /// geometry it decodes at `max_dimension`.
    pub decode_cap: usize,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            max_dimension: 2048,
            quality: Quality::Final,
            filter: Filter::Lanczos3,
            decode_cap: crate::frame::DEFAULT_DECODE_CAP,
        }
    }
}

/// A rendered frame: sRGB 8-bit RGBA (alpha 255).
#[derive(Debug, Clone)]
pub struct Rendered {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
    /// Stages that approximate Photo Bench / Lightroom for these settings.
    pub approximations: Vec<&'static str>,
}

/// Photo Bench `EditSettings.hasActiveColorEdits` (drives the output
/// transform for bounded sRGB rasters). Texture / Clarity / Dehaze and the
/// absolute white balance are not part of it in Photo Bench either. NIHO's
/// positive highlight-priority vignette also enables it because the linear
/// gain can push bounded sRGB highlights above 1.0, and so do NIHO's
/// midtone / global color grading luminance (niho-photo#39).
pub fn has_active_color_edits(s: &DevelopSettings) -> bool {
    let tol = 1e-9;
    // `niho-13` balances the source itself and keeps a bounded source in
    // [0, 1] (`head_wb.rs`), so its white balance alone needs no output
    // transform: the balanced bounded source is drawn as a bounded one.
    let relative_active =
        s.white_balance.mode == WhiteBalanceMode::Relative && !uses_head_white_balance(&s.engine);
    let scalars = [
        s.exposure,
        s.contrast,
        s.highlights,
        s.shadows,
        s.whites,
        s.blacks,
        s.vibrance,
        s.saturation,
        if relative_active {
            s.relative_temperature
        } else {
            0.0
        },
        if relative_active {
            s.relative_tint
        } else {
            0.0
        },
        s.parametric_shadows,
        s.parametric_darks,
        s.parametric_lights,
        s.parametric_highlights,
    ];
    let c = &s.calibration;
    let calibration = [
        c.red_hue,
        c.red_saturation,
        c.green_hue,
        c.green_saturation,
        c.blue_hue,
        c.blue_saturation,
    ];
    let g = &s.color_grading;
    let grading = [
        g.shadow.hue,
        g.shadow.saturation,
        g.shadow.luminance,
        g.midtone.hue,
        g.midtone.saturation,
        // NIHO renders midtone / global luminance (Photo Bench keeps them
        // only), so they are color edits like the shadow / highlight ones.
        g.midtone.luminance,
        g.highlight.hue,
        g.highlight.saturation,
        g.highlight.luminance,
        g.global.hue,
        g.global.saturation,
        g.global.luminance,
    ];
    // Black & white is a color edit (NIHO; the mix only acts with it).
    s.grayscale
        // Positive highlight-priority vignette is a linear gain and can
        // push bounded sRGB highlights above 1.0 before output encoding.
        || (s.vignette.style == VignetteStyle::HighlightPriority && s.vignette.amount > 0.0)
        || scalars.iter().any(|v| v.abs() > tol)
        || calibration.iter().any(|v| v.abs() > tol)
        || grading.iter().any(|v| v.abs() > tol)
        || s.has_active_color_points()
        || !crate::tone_ops::curves_are_identity(&s.tone_curves, tol)
        || s.hsl
            .entries()
            .iter()
            .any(|(_, a)| a.hue.abs() > tol || a.saturation.abs() > tol || a.luminance.abs() > tol)
}

fn needs_spatial(s: &DevelopSettings) -> bool {
    s.highlights != 0.0 || s.shadows != 0.0 || s.texture != 0.0 || s.clarity != 0.0
}

/// Cube P for these settings (`postOpsCube`), optionally preceded by the
/// non-RAW exposure.
pub fn bake_post_ops_cube(s: &DevelopSettings, exposure_non_raw_ev: f64, dimension: usize) -> Cube {
    bake_post_ops_cube_with_look(s, exposure_non_raw_ev, dimension, None)
}

/// Cube P with the look's `point-curve` tone (RAW: [`raw_look_tone`]).
pub fn bake_post_ops_cube_with_look(
    s: &DevelopSettings,
    exposure_non_raw_ev: f64,
    dimension: usize,
    look: Option<&'static crate::look::LookParams>,
) -> Cube {
    let prepared = PreparedPostOps::with_exposure(s, exposure_non_raw_ev).with_look(look);
    let transform = move |v| prepared.apply(v);
    if uses_float_cubes(&s.engine) {
        Cube::bake_float_with_dimension(dimension, &transform)
    } else {
        Cube::bake_with_dimension(dimension, &transform)
    }
}

fn bake_raw_post_ops_cube_niho3(
    s: &DevelopSettings,
    exposure_non_raw_ev: f64,
    look: Option<&'static crate::look::LookParams>,
) -> Cube {
    let prepared = PreparedPostOps::with_exposure(s, exposure_non_raw_ev).with_look(look);
    Cube::bake_float(&move |v| prepared.apply(v))
}

/// The settings whose formulas render a legacy unsigned RAW working copy for
/// a float-cube engine: `niho-8` and `niho-12` keep the `niho-2` RAW formula
/// and change only cube precision (`None` for every other engine).
fn legacy_raw_formula(s: &DevelopSettings) -> Option<DevelopSettings> {
    uses_float_cubes(&s.engine).then(|| {
        let mut legacy = s.clone();
        legacy.engine = ENGINE_NIHO_2.to_string();
        legacy
    })
}

/// Raster engines whose relative white balance is the calibrated
/// incremental-WB delta LUT on the encoded output (not the linear matrix).
fn uses_jpeg_white_balance(engine: &str) -> bool {
    matches!(
        engine,
        ENGINE_NIHO_2
            | ENGINE_NIHO_3
            | ENGINE_NIHO_6
            | ENGINE_NIHO_8
            | ENGINE_NIHO_10
            | ENGINE_NIHO_12
    )
}

/// Raster engines whose relative white balance is the linear matrix of
/// `relative_wb.rs` in the head pixel (`niho-1`): not the output-side LUT,
/// and not `niho-13`, whose source is balanced before it reaches a frame
/// (`head_wb.rs`).
fn uses_relative_matrix_on_raster(engine: &str) -> bool {
    !uses_jpeg_white_balance(engine) && !uses_head_white_balance(engine)
}

/// The look whose tone goes into cube P on the RAW path (`None` when the
/// look has no `point-curve` tone). JPEG / PNG never get a look.
pub fn raw_look_tone(s: &DevelopSettings) -> Option<&'static crate::look::LookParams> {
    crate::look::params(&s.look).filter(|p| p.tone_stage() == crate::look::ToneStage::PointCurve)
}

/// Cube Q (`postColorCube`). Photo Bench keeps it at 64^3 even while
/// dragging; single-threaded wasm cannot bake 262,144 points per frame, so
/// interactive frames use the drag grid here too (the release frame is
/// exact).
pub fn bake_color_cube(s: &DevelopSettings, dimension: usize) -> Cube {
    bake_color_cube_for(s, dimension, false)
}

/// Cube Q of a RAW working copy (`raw`: its input is past the ACR3 default
/// curve, which the black & white mix takes back) or of a JPEG / PNG.
pub fn bake_color_cube_for(s: &DevelopSettings, dimension: usize, raw: bool) -> Cube {
    let prepared = color_ops_for(s, raw);
    let transform = move |v| {
        if raw {
            prepared.apply_raw_after_pre_post(v)
        } else {
            prepared.apply(v)
        }
    };
    if uses_float_cubes(&s.engine)
        || s.has_active_color_points()
        || (!raw && s.engine == ENGINE_NIHO_10)
    {
        // Hue restoration alone is insufficient if Q's entries are then
        // rounded to 8-bit: saturation -50 can still drift over two degrees.
        // Keep the new raster engine's color stage unquantized; legacy
        // engines retain their original cube precision.
        Cube::bake_float_with_dimension(dimension, &transform)
    } else if raw
        && matches!(
            s.engine.as_str(),
            ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
        )
    {
        Cube::bake_float(&transform)
    } else {
        Cube::bake_with_dimension(dimension, &transform)
    }
}

fn bake_color_cube_with_precision(
    s: &DevelopSettings,
    dimension: usize,
    raw: bool,
    float_entries: bool,
) -> Cube {
    if float_entries {
        let prepared = color_ops_for(s, raw);
        let transform = move |v| {
            if raw {
                prepared.apply_raw_after_pre_post(v)
            } else {
                prepared.apply(v)
            }
        };
        Cube::bake_float_with_dimension(dimension, &transform)
    } else {
        bake_color_cube_for(s, dimension, raw)
    }
}

/// Cube Q through the input of independent color points. The points and
/// Color Grading are evaluated exactly per pixel after this cube.
fn bake_pre_color_cube_for(s: &DevelopSettings, dimension: usize, raw: bool) -> Cube {
    let prepared = color_ops_for(s, raw);
    let transform = move |v| {
        if raw {
            prepared.apply_raw_before_color_points_after_pre_post(v)
        } else {
            prepared.apply_before_color_points(v)
        }
    };
    Cube::bake_float_with_dimension(dimension, &transform)
}

fn color_ops_for(s: &DevelopSettings, raw: bool) -> PreparedColorOps {
    if raw {
        PreparedColorOps::after_default_curve(s)
    } else {
        PreparedColorOps::new(s)
    }
}

/// The ACR3 default tone curve cube (`RGBTone.apply(ACR3)` on linear
/// ProPhoto); the Adobe Color look curve is not used (NIHO look instead).
pub fn acr3_cube() -> &'static Cube {
    static C: OnceLock<Cube> = OnceLock::new();
    C.get_or_init(|| Cube::bake(&|v| rgb_tone(v, &crate::acr3::evaluate)))
}

fn niho3_acr3_cube() -> &'static Cube {
    static C: OnceLock<Cube> = OnceLock::new();
    C.get_or_init(|| Cube::bake_float(&|v| rgb_tone(v, &crate::acr3::evaluate)))
}

/// The look followed by the ACR3 default curve, as one cube (the cube input
/// is clamped to `[0, 1]`, which is the look's domain). `niho-interim-1` is
/// the plain ACR3 cube.
pub fn look_cube(look: &str) -> &'static Cube {
    if look == crate::look::LOOK_NIHO_STANDARD_1 {
        static C: OnceLock<Cube> = OnceLock::new();
        let p = crate::look::standard_1();
        return C.get_or_init(|| Cube::bake(&|v| rgb_tone(p.pre_acr3(v), &crate::acr3::evaluate)));
    }
    if matches!(
        look,
        crate::look::LOOK_NIHO_STANDARD_2
            | crate::look::LOOK_NIHO_STANDARD_3
            | crate::look::LOOK_NIHO_STANDARD_4
            | crate::look::LOOK_NIHO_STANDARD_5
    ) {
        return niho3_acr3_cube();
    }
    acr3_cube()
}

fn bake_float_look_cube(look: &str, dimension: usize) -> Cube {
    match crate::look::params(look) {
        Some(params) => Cube::bake_float_with_dimension(dimension, &|v| {
            rgb_tone(params.pre_acr3(v), &crate::acr3::evaluate)
        }),
        None => {
            Cube::bake_float_with_dimension(dimension, &|v| rgb_tone(v, &crate::acr3::evaluate))
        }
    }
}

/// Cubes that depend on the settings; reusable across frames whose
/// relevant settings did not change (the session keeps them).
#[derive(Clone)]
pub struct SettingsCubes {
    /// `niho-8` only: dimension-aware float look + ACR3 cube. Existing
    /// engines continue to use their process-wide frozen cube.
    pub acr3_key: String,
    pub acr3: Option<Arc<Cube>>,
    pub post_key: String,
    pub post: Option<Arc<Cube>>,
    pub color_key: String,
    /// The actual cube contents' key. With active independent points this
    /// excludes point/grading values, while `color_key` remains the full
    /// settings identity used by frame-level consumers.
    color_cube_key: String,
    pub color: Option<Arc<Cube>>,
    /// Drag frames: the per-pixel tail ([`DragTail`]).
    pub drag: Option<Arc<DragTail>>,
    /// The cubes of the last released (Final) frame, kept through the drag
    /// frames after it (whose cubes are of the drag grid): releasing a drag
    /// that left the cubes' settings as they were (the white balance of
    /// `niho-13`, H/S, Texture, Clarity, ...) takes them back instead of
    /// baking the Final grid again. The same keys, so the same entries.
    released: Option<Arc<SettingsCubes>>,
    quality: Quality,
}

fn post_key(s: &DevelopSettings, exposure_non_raw_ev: f64, dimension: usize) -> String {
    let v = s.to_value();
    format!(
        "{}|{exposure_non_raw_ev}|{dimension}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        s.engine,
        s.contrast,
        s.dehaze,
        s.whites,
        s.blacks,
        s.parametric_shadows,
        s.parametric_darks,
        s.parametric_lights,
        s.parametric_highlights,
        s.parametric_shadow_split,
        s.parametric_midtone_split,
        s.parametric_highlight_split,
        v["toneCurves"]
    )
}

fn color_key(s: &DevelopSettings, dimension: usize, raw: bool) -> String {
    let v = s.to_value();
    format!(
        "{}|{dimension}|{raw}|{}|{}|{}|{}|{}|{:?}|{}",
        s.engine,
        s.vibrance,
        s.saturation,
        v["hsl"],
        v["colorGrading"],
        s.grayscale,
        s.gray_mixer.bands,
        v["colorPoints"]
    )
}

fn pre_color_key(s: &DevelopSettings, dimension: usize, raw: bool) -> String {
    let v = s.to_value();
    format!(
        "pre-point|{}|{dimension}|{raw}|{}|{}|{}|{}|{:?}",
        s.engine, s.vibrance, s.saturation, v["hsl"], s.grayscale, s.gray_mixer.bands
    )
}

/// Whether Stage Q has work before independent points and Color Grading.
/// Keeping point/grading-only settings out of this predicate avoids running
/// an identity cube whose interpolation would move the picker's target.
fn needs_pre_color_ops(settings: &DevelopSettings, raw: bool) -> bool {
    let frozen_raw_profile = raw
        && !settings.grayscale
        && matches!(
            settings.engine.as_str(),
            ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
        );
    let grayscale_before_points = !raw && settings.grayscale;
    frozen_raw_profile
        || grayscale_before_points
        || (!settings.grayscale
            && (settings.vibrance != 0.0
                || settings.saturation != 0.0
                || settings.hsl.entries().iter().any(|(_, adjustment)| {
                    adjustment.hue != 0.0
                        || adjustment.saturation != 0.0
                        || adjustment.luminance != 0.0
                })))
}

/// Returns cube P and cube Q for `s`, reusing `cache` entries whose keys
/// match. `bake: false` only computes the keys (drag frames whose tail
/// evaluates the stages directly, [`DragTail`]).
pub fn settings_cubes(
    s: &DevelopSettings,
    exposure_non_raw_ev: f64,
    quality: Quality,
    cache: Option<&SettingsCubes>,
    bake: bool,
    look: Option<&'static crate::look::LookParams>,
    raw: bool,
) -> SettingsCubes {
    let formula_override = if !raw && s.engine == ENGINE_NIHO_3 {
        let mut legacy = s.clone();
        legacy.engine = ENGINE_NIHO_2.to_string();
        legacy.look = crate::look::LOOK_NIHO_INTERIM_1.to_string();
        Some(legacy)
    } else if raw {
        legacy_raw_formula(s)
    } else {
        None
    };
    let formula_settings = formula_override.as_ref().unwrap_or(s);
    let float_candidate = uses_float_cubes(&s.engine);
    let dimension = if raw
        && matches!(
            s.engine.as_str(),
            ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
        ) {
        CUBE_DIMENSION
    } else {
        match quality {
            Quality::Interactive => INTERACTIVE_TONE_CUBE_DIMENSION,
            Quality::Final => CUBE_DIMENSION,
        }
    };
    let precision_key = if float_candidate { "f32" } else { "u8" };
    let ak = if raw && float_candidate {
        format!("{}|{dimension}|{precision_key}", s.look)
    } else {
        String::new()
    };
    // This frame's cache and the released frame's cubes it keeps.
    let caches = [cache, cache.and_then(|c| c.released.as_deref())];
    let kept = |pick: &dyn Fn(&SettingsCubes) -> Option<Arc<Cube>>| {
        caches.iter().flatten().find_map(|c| pick(c))
    };
    let acr3 = if ak.is_empty() {
        None
    } else {
        match kept(&|c| (c.acr3_key == ak).then(|| c.acr3.clone()).flatten()) {
            Some(cube) => Some(cube),
            None => Some(Arc::new(bake_float_look_cube(&s.look, dimension))),
        }
    };
    let want_post =
        exposure_non_raw_ev != 0.0 || needs_post_ops(formula_settings) || look.is_some();
    let pk = format!(
        "{}|{}|{precision_key}",
        post_key(formula_settings, exposure_non_raw_ev, dimension),
        if look.is_some() { s.look.as_str() } else { "" }
    );
    let post = if !want_post
        || (!bake
            && !(raw
                && matches!(
                    s.engine.as_str(),
                    ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
                )))
    {
        None
    } else {
        match kept(&|c| (c.post_key == pk).then(|| c.post.clone()).flatten()) {
            Some(cube) => Some(cube),
            // A drag frame can keep a matching final cube without
            // baking one; releasing H/S or WB then reuses it.
            _ if !bake => None,
            _ if float_candidate => {
                let prepared =
                    PreparedPostOps::with_exposure(formula_settings, exposure_non_raw_ev)
                        .with_look(look);
                Some(Arc::new(Cube::bake_float_with_dimension(
                    dimension,
                    &move |v| prepared.apply(v),
                )))
            }
            _ if raw
                && matches!(
                    s.engine.as_str(),
                    ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
                ) =>
            {
                Some(Arc::new(bake_raw_post_ops_cube_niho3(
                    formula_settings,
                    exposure_non_raw_ev,
                    look,
                )))
            }
            _ => Some(Arc::new(bake_post_ops_cube_with_look(
                formula_settings,
                exposure_non_raw_ev,
                dimension,
                look,
            ))),
        }
    };
    let ck = format!(
        "{}|{precision_key}",
        color_key(formula_settings, dimension, raw)
    );
    let cube_ck = if formula_settings.has_active_color_points() {
        format!(
            "{}|{precision_key}",
            pre_color_key(formula_settings, dimension, raw)
        )
    } else {
        ck.clone()
    };
    let needs_color_cube = if formula_settings.has_active_color_points() {
        needs_pre_color_ops(formula_settings, raw)
    } else {
        needs_color_ops(formula_settings)
    };
    let color = if !needs_color_cube
        || (!bake
            && !(raw
                && matches!(
                    s.engine.as_str(),
                    ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
                ))) {
        None
    } else {
        match kept(&|c| {
            (c.color_cube_key == cube_ck)
                .then(|| c.color.clone())
                .flatten()
        }) {
            Some(cube) => Some(cube),
            _ if !bake => None,
            _ => Some(Arc::new(if formula_settings.has_active_color_points() {
                bake_pre_color_cube_for(formula_settings, dimension, raw)
            } else {
                bake_color_cube_with_precision(formula_settings, dimension, raw, float_candidate)
            })),
        }
    };
    SettingsCubes {
        acr3_key: ak,
        acr3,
        post_key: pk,
        post,
        color_key: ck,
        color_cube_key: cube_ck,
        color,
        drag: cache.and_then(|c| c.drag.clone()),
        // A released frame is itself the set to keep; a drag frame keeps the
        // last released set (the frame before it, or the one that one kept).
        released: match (quality, cache) {
            (Quality::Final, _) => None,
            (Quality::Interactive, Some(c)) if c.quality == Quality::Final => {
                Some(Arc::new(SettingsCubes {
                    released: None,
                    ..c.clone()
                }))
            }
            (Quality::Interactive, c) => c.and_then(|c| c.released.clone()),
        },
        quality,
    }
}

/// Grid of the drag-frame tail (odd: the middle gray is a node).
pub const DRAG_TAIL_DIMENSION: usize = 33;
/// Samples of the drag tail's shaper.
const SHAPER_SAMPLES: usize = 1024;
/// Share of the identity in the shaper: keeps it strictly increasing where
/// the tone response is flat, and some grid everywhere.
const SHAPER_IDENTITY: f32 = 0.3;

/// Stage A of a [`DragTail`] and its shaper, kept while their settings do
/// not change.
struct DragStageA {
    key: String,
    /// The linear input to the shaped coordinate (the gamma-1.8 encode, the
    /// cube's input clamp and the shaper in one table).
    input: UnitTable,
    /// Stage A at every node (red fastest).
    grid: Vec<[f32; 3]>,
}

/// Drag frames: the whole per-pixel tail, from the encoded (clamped) input
/// of the first cube to the sRGB-encoded output, as one
/// `DRAG_TAIL_DIMENSION^3` cube, so a pixel costs one lookup instead of the
/// chain of cubes, matrices and the output transform.
///
/// - The entries are the stages themselves evaluated at the nodes (cube P
///   and Q as their functions, not baked on a coarser grid), so the only
///   difference to the released frame is the interpolation between nodes.
/// - Each channel goes through a shaper first (the encoded input mapped to
///   the lightness of stage A's neutral response, 30% mixed with the
///   identity), so the nodes follow the tone curve (dense where it is
///   steep, e.g. lifted blacks), and the lookup is tetrahedral.
/// - Stage A (cube P; on the RAW path the ACR3 cube and cube P) and the
///   shaper stay while their settings do not change: dragging a color
///   slider only re-evaluates stage B (calibration, cube Q, the output) at
///   the nodes.
///
/// Measured against the released frame on bluesky2 (`tests/interactive.rs`):
/// p99.9 ΔE00 4.0 -> 2.6 on the JPEG path (README "性能").
pub struct DragTail {
    stage_a: Arc<DragStageA>,
    key: String,
    cube: Cube,
}

impl DragTail {
    /// The tail of a linear input (the first cube's, before its encode and
    /// clamp): sRGB-encoded `[0,1]`.
    #[inline]
    fn lookup(&self, v: [f32; 3]) -> [f32; 3] {
        let t = &self.stage_a.input;
        self.cube
            .lookup_tetrahedral([t.eval(v[0]), t.eval(v[1]), t.eval(v[2])])
    }
}

#[inline]
fn shape(shaper: &[f32], e: f32) -> f32 {
    let t = e * (SHAPER_SAMPLES - 1) as f32;
    let i = (t as usize).min(SHAPER_SAMPLES - 2);
    let w = t - i as f32;
    shaper[i] + (shaper[i + 1] - shaper[i]) * w
}

/// The shaper of stage A and the encoded inputs of the nodes.
fn shaper_and_nodes(a: &dyn Fn([f32; 3]) -> [f32; 3]) -> (Vec<f32>, Vec<f32>) {
    let k = SHAPER_SAMPLES;
    let last = (k - 1) as f32;
    // The lightness (sRGB-encoded luminance) of the neutral response.
    let y: Vec<f32> = (0..k)
        .map(|i| {
            let e = i as f32 / last;
            let v = a([e, e, e]);
            let lum = v[0] * PP_LUMA_F32[0] + v[1] * PP_LUMA_F32[1] + v[2] * PP_LUMA_F32[2];
            srgb_oetf_f32(lum.clamp(0.0, 1.0))
        })
        .collect();
    let (lo, hi) = (y[0], y[k - 1]);
    let mut shaper = Vec::with_capacity(k);
    let mut running = 0.0f32;
    for (i, v) in y.iter().enumerate() {
        let e = i as f32 / last;
        let normalized = if hi - lo > 1e-4 {
            ((v - lo) / (hi - lo)).clamp(0.0, 1.0)
        } else {
            e
        };
        running = running.max(normalized);
        shaper.push((1.0 - SHAPER_IDENTITY) * running + SHAPER_IDENTITY * e);
    }
    shaper[k - 1] = 1.0;
    // Inverse at the nodes (the shaper is strictly increasing).
    let n = DRAG_TAIL_DIMENSION;
    let mut nodes = Vec::with_capacity(n);
    let mut j = 0;
    for i in 0..n {
        let t = i as f32 / (n - 1) as f32;
        while j + 2 < k && shaper[j + 1] < t {
            j += 1;
        }
        let (u0, u1) = (shaper[j], shaper[j + 1]);
        let w = ((t - u0) / (u1 - u0)).clamp(0.0, 1.0);
        nodes.push(((j as f32 + w) / last).clamp(0.0, 1.0));
    }
    nodes[0] = 0.0;
    nodes[n - 1] = 1.0;
    (shaper, nodes)
}

/// The drag tail for `key` (everything it depends on), reusing `cache`'s
/// when the key matches and its stage A when `key_a` does. `a` maps the
/// encoded input to stage A's linear output, `b` stage A's output to the
/// sRGB-encoded result.
fn drag_tail(
    cache: Option<&Arc<DragTail>>,
    key_a: String,
    key: String,
    a: &dyn Fn([f32; 3]) -> [f32; 3],
    b: &dyn Fn([f32; 3]) -> [f32; 3],
) -> Arc<DragTail> {
    if let Some(t) = cache {
        if t.key == key {
            return t.clone();
        }
    }
    let stage_a = match cache {
        Some(t) if t.stage_a.key == key_a => t.stage_a.clone(),
        _ => {
            let (shaper, nodes) = shaper_and_nodes(a);
            let n = DRAG_TAIL_DIMENSION;
            let mut grid = Vec::with_capacity(n * n * n);
            for bi in 0..n {
                for gi in 0..n {
                    for ri in 0..n {
                        grid.push(a([nodes[ri], nodes[gi], nodes[bi]]));
                    }
                }
            }
            let input = UnitTable::new(|x| shape(&shaper, encode([x, 0.0, 0.0])[0]));
            Arc::new(DragStageA {
                key: key_a,
                input,
                grid,
            })
        }
    };
    let cube = Cube::from_entries(DRAG_TAIL_DIMENSION, stage_a.grid.iter().map(|v| b(*v)));
    Arc::new(DragTail { stage_a, key, cube })
}

#[inline]
fn clamp01(v: [f32; 3]) -> [f32; 3] {
    [
        v[0].clamp(0.0, 1.0),
        v[1].clamp(0.0, 1.0),
        v[2].clamp(0.0, 1.0),
    ]
}

/// A cube stage as its function (what the cube samples): input clamped
/// like `CIColorCube`'s, output clipped like the baked entries.
#[inline]
fn exact(f: &dyn Fn([f64; 3]) -> [f64; 3], v: [f32; 3]) -> [f32; 3] {
    let v = clamp01(v);
    let o = f([v[0] as f64, v[1] as f64, v[2] as f64]);
    clamp01([o[0] as f32, o[1] as f32, o[2] as f32])
}

/// The sRGB-encoded result of a linear `[0, 1]` output.
#[inline]
fn oetf3(v: [f32; 3]) -> [f32; 3] {
    [
        srgb_oetf_f32(v[0]),
        srgb_oetf_f32(v[1]),
        srgb_oetf_f32(v[2]),
    ]
}

/// An sRGB-encoded `[0, 1]` value from a preview tail to 8 bits.
#[inline]
fn write_encoded_rgba(out: &mut [u8], c: [f32; 3]) {
    out[0] = (c[0] * 255.0 + 0.5) as u8;
    out[1] = (c[1] * 255.0 + 0.5) as u8;
    out[2] = (c[2] * 255.0 + 0.5) as u8;
    out[3] = 255;
}

/// Non-RAW adaptive statistics: the plain input (linear sRGB, before the
/// relative white balance), reduced like Core Image's affine sampling.
pub fn raster_stats(image: &LinearImage, quality: Quality) -> AdaptiveStats {
    let (small, w, h) = bilinear_downscale(
        &image.data,
        image.width,
        image.height,
        quality.stats_long_edge(),
    );
    spatial::compute_stats(&small, w, h, REC709_LUMA_F32)
}

/// The per-pixel stages after the spatial pass of the raster path, fused
/// into one loop that writes RGBA: cube P -> linear sRGB -> (ProPhoto ->
/// Calibration -> cube Q -> linear sRGB) -> output transform -> 8-bit.
struct RasterTail {
    post: Option<Arc<Cube>>,
    stage_p: bool,
    calibration: Option<[[f32; 3]; 3]>,
    color: Option<Arc<Cube>>,
    /// Exact end of Stage Q when independent points are active.
    point_tail: Option<PreparedColorOps>,
    output_transform: bool,
}

#[derive(Clone, Copy)]
struct CachedColorPointPixel {
    /// Linear ProPhoto immediately before independent points.
    value: [f32; 3],
    /// The same value's Oklch selection coordinates, calculated with the
    /// shared signed f32 kernel and checked against the f64 reference.
    oklch: [f32; 3],
}

/// The one output-sized active-point plane retained by a Session. Its key
/// contains every stage through the point-selection input except point and
/// grading values, so slider changes only run the exact tail.
pub(crate) struct ColorPointPlane {
    key: String,
    width: usize,
    height: usize,
    pixels: Vec<CachedColorPointPixel>,
}

impl ColorPointPlane {
    fn sample(&self, index: usize) -> Option<[f64; 3]> {
        self.pixels
            .get(index)
            .map(|pixel| pixel.oklch.map(f64::from))
    }

    #[cfg(test)]
    pub(crate) fn test_identity(&self) -> (&str, usize, usize, usize) {
        (
            &self.key,
            self.width,
            self.height,
            self.pixels.as_ptr() as usize,
        )
    }
}

impl RasterTail {
    #[inline]
    fn pixel(&self, mut v: [f32; 3]) -> [f32; 3] {
        if let Some(point_tail) = &self.point_tail {
            let v = self.before_color_points(v);
            let v = point_tail
                .apply_color_points_and_grading(v.map(f64::from))
                .map(|channel| channel as f32);
            return mat_vec_f32(&PROPHOTO_TO_SRGB_F32, v);
        }
        // Preserve the legacy path exactly when no independent point is
        // active; even an empty / zero-delta v4 array takes this branch.
        if self.stage_p {
            if let Some(cube) = &self.post {
                v = cube.apply(v);
            }
            v = mat_vec_f32(&PROPHOTO_TO_SRGB_F32, v);
        }
        self.color_stage(v)
    }

    #[inline]
    fn cached_point_pixel(&self, pixel: CachedColorPointPixel) -> [f32; 3] {
        let point_tail = self.point_tail.as_ref().expect("active point tail");
        mat_vec_f32(
            &PROPHOTO_TO_SRGB_F32,
            point_tail.apply_cached_color_points_and_grading(pixel.value, pixel.oklch),
        )
    }

    /// Float-boundary evaluation for working halo pixels. Active points use
    /// the same f32 selection coordinates as the output-sized point cache,
    /// but the halo itself is never retained in that cache.
    #[inline]
    fn float_boundary_pixel(&self, value: [f32; 3]) -> [f32; 3] {
        if self.point_tail.is_none() {
            return self.pixel(value);
        }
        let value = self.before_color_points(value);
        self.cached_point_pixel(CachedColorPointPixel {
            value,
            oklch: color_ops::cached_prophoto_to_oklch(value),
        })
    }

    /// Shared normal-render / picker chain through the input of independent
    /// color points, returned in linear ProPhoto.
    #[inline]
    fn before_color_points(&self, mut v: [f32; 3]) -> [f32; 3] {
        if self.stage_p {
            if let Some(cube) = &self.post {
                v = cube.apply(v);
            }
            v = mat_vec_f32(&PROPHOTO_TO_SRGB_F32, v);
        }
        v = mat_vec_f32(&SRGB_TO_PROPHOTO_F32, v);
        if let Some(m) = &self.calibration {
            v = clamp01(mat_vec_f32(m, v));
        }
        if let Some(cube) = &self.color {
            v = cube.apply(v);
        }
        v
    }

    #[inline]
    fn color_stage(&self, mut v: [f32; 3]) -> [f32; 3] {
        if self.calibration.is_some() || self.color.is_some() {
            v = mat_vec_f32(&SRGB_TO_PROPHOTO_F32, v);
            if let Some(m) = &self.calibration {
                let c = mat_vec_f32(m, v);
                v = [
                    c[0].clamp(0.0, 1.0),
                    c[1].clamp(0.0, 1.0),
                    c[2].clamp(0.0, 1.0),
                ];
            }
            if let Some(cube) = &self.color {
                v = cube.apply(v);
            }
            v = mat_vec_f32(&PROPHOTO_TO_SRGB_F32, v);
        }
        v
    }

    /// The output stage of [`write_rgba`] before the 8-bit encode.
    #[inline]
    fn output(&self, v: [f32; 3]) -> [f32; 3] {
        if self.output_transform {
            output_transform(v)
        } else {
            [
                v[0].clamp(0.0, 1.0),
                v[1].clamp(0.0, 1.0),
                v[2].clamp(0.0, 1.0),
            ]
        }
    }
}

#[inline]
fn write_rgba(out: &mut [u8], v: [f32; 3], transform: bool) {
    let enc = srgb8();
    let v = if transform {
        output_transform(v)
    } else {
        [
            v[0].clamp(0.0, 1.0),
            v[1].clamp(0.0, 1.0),
            v[2].clamp(0.0, 1.0),
        ]
    };
    out[0] = enc.encode(v[0]);
    out[1] = enc.encode(v[1]);
    out[2] = enc.encode(v[2]);
    out[3] = 255;
}

/// An sRGB-encoded value from a preview tail with the frame's output
/// effects to 8 bits.
#[inline]
fn write_encoded_fx(out: &mut [u8], e: [f32; 3], fx: Option<&OutputEffects>, i: usize) {
    match fx {
        None => write_encoded_rgba(out, e),
        Some(fx) => write_encoded_rgba(out, fx.apply(e, i)),
    }
}

/// [`write_rgba`] with the frame's output effects: encoded first (they act
/// on the encoded value), then 8 bits.
#[inline]
fn write_rgba_fx(
    out: &mut [u8],
    v: [f32; 3],
    transform: bool,
    fx: Option<&OutputEffects>,
    i: usize,
) {
    match fx {
        None => write_rgba(out, v, transform),
        Some(fx) => {
            let o = if transform {
                output_transform(v)
            } else {
                clamp01(v)
            };
            write_encoded_rgba(out, fx.apply(effects::encode_srgb3(o), i));
        }
    }
}

#[inline]
fn write_niho3_output_rgba(
    out: &mut [u8],
    linear_srgb: [f32; 3],
    encoder: &crate::fastmath::Niho3Srgb8Encoder,
) {
    let linear = output_transform_clip(linear_srgb);
    out[0] = encoder.encode(linear[0]);
    out[1] = encoder.encode(linear[1]);
    out[2] = encoder.encode(linear[2]);
    out[3] = 255;
}

#[inline]
fn write_niho3_output_rgba_fx(
    out: &mut [u8],
    linear_srgb: [f32; 3],
    fx: &OutputEffects,
    index: usize,
) {
    let encoded = oetf3(output_transform_clip(linear_srgb));
    write_encoded_rgba(out, fx.apply(encoded, index));
}

/// A geometry frame (F3 #17122, [`crate::frame`]): the image rendered is a
/// window around the output, not the whole photo.
#[derive(Clone, Copy)]
pub struct Framing<'a> {
    /// The whole photo before the geometry: the adaptive statistics read it
    /// (with the same function as a whole render), so the crop does not
    /// change them.
    pub stats_source: &'a LinearImage,
    /// Long edge of the whole frame at this scale: the local radii follow
    /// it (`frame::Plan::scale_long_edge`).
    pub long_edge: usize,
    /// The output inside the window.
    pub output: Rect,
    /// The window's identity (geometry, size, rectangle): a kept local pass
    /// of another window is not reused.
    pub key: &'a str,
}

/// What a frame reads besides its image: the statistics' source, the long
/// edge of the local radii, the output rectangle and the window's key
/// (the whole image without a geometry).
fn frame_of<'a>(img: &'a LinearImage, framing: Option<&Framing<'a>>) -> Framing<'a> {
    match framing {
        Some(f) => *f,
        None => Framing {
            stats_source: img,
            long_edge: img.width.max(img.height),
            output: Rect::whole(img.width, img.height),
            key: "",
        },
    }
}

/// Where a drag-frame tail cube takes over the per-pixel chain.
enum PreviewEntry {
    /// At cube P's input (encoded ProPhoto).
    Post,
    /// At cube Q's input (no cube P, no calibration): encoded ProPhoto of
    /// the linear sRGB value.
    Color,
}

#[derive(Clone, Copy)]
struct OutputPixels<'a, 'v> {
    src: &'a [f32],
    src_width: usize,
    output: Rect,
    local: Option<&'a Plane>,
    vignette: Option<&'a LinearVignette<'v>>,
}

#[inline]
fn raster_head_pixel(
    mut v: [f32; 3],
    input: Option<&[[f32; 3]; 3]>,
    relative: Option<&[[f32; 3]; 3]>,
    stage_p: bool,
) -> [f32; 3] {
    if let Some(matrix) = input {
        v = mat_vec_f32(matrix, v);
    }
    if let Some(matrix) = relative {
        v = mat_vec_f32(matrix, v);
    }
    if stage_p {
        v = mat_vec_f32(&SRGB_TO_PROPHOTO_F32, v);
    }
    v
}

#[inline]
fn raw_head_pixel(mut v: [f32; 3], white_balance: Option<&[[f32; 3]; 3]>, gain: f32) -> [f32; 3] {
    if let Some(matrix) = white_balance {
        v = mat_vec_f32(matrix, v);
    }
    [v[0] * gain, v[1] * gain, v[2] * gain]
}

#[inline]
fn linear_spatial_pixel(
    mut v: [f32; 3],
    ratio: Option<f32>,
    vignette: Option<(&LinearVignette<'_>, f32)>,
) -> [f32; 3] {
    if let Some(ratio) = ratio {
        v = [v[0] * ratio, v[1] * ratio, v[2] * ratio];
    }
    if let Some((vignette, rho)) = vignette {
        v = vignette.apply(v, rho);
    }
    v
}

/// Visits every output pixel after `head`, the local-pass ratio, and the
/// vignette's linear stage. `src` and spatial ratios span the geometry
/// window; output indices are row-major within its output rectangle.
#[inline(always)]
fn for_each_output_pixel(
    pixels: OutputPixels<'_, '_>,
    head: impl Fn([f32; 3]) -> [f32; 3],
    mut emit: impl FnMut([f32; 3], usize),
) {
    let OutputPixels {
        src,
        src_width,
        output,
        local,
        vignette,
    } = pixels;
    for y in 0..output.height {
        let start = (output.y + y) * src_width + output.x;
        let end = start + output.width;
        let output_start = y * output.width;
        let output_end = output_start + output.width;
        let pixels = src[start * 3..end * 3]
            .chunks_exact(3)
            .enumerate()
            .map(|(x, px)| (start + x, output_start + x, px));
        match (local, vignette) {
            (Some(ratio), Some(vignette)) => {
                for ((_, output_i, px), (ratio, rho)) in pixels.zip(
                    ratio.data[start..end]
                        .iter()
                        .zip(vignette.radius()[output_start..output_end].iter()),
                ) {
                    let v = head([px[0], px[1], px[2]]);
                    emit(
                        linear_spatial_pixel(v, Some(*ratio), Some((vignette, *rho))),
                        output_i,
                    );
                }
            }
            (Some(ratio), None) => {
                for ((_, output_i, px), ratio) in pixels.zip(ratio.data[start..end].iter()) {
                    let v = head([px[0], px[1], px[2]]);
                    emit(linear_spatial_pixel(v, Some(*ratio), None), output_i);
                }
            }
            (None, Some(vignette)) => {
                for ((_, output_i, px), rho) in
                    pixels.zip(vignette.radius()[output_start..output_end].iter())
                {
                    let v = head([px[0], px[1], px[2]]);
                    emit(
                        linear_spatial_pixel(v, None, Some((vignette, *rho))),
                        output_i,
                    );
                }
            }
            (None, None) => {
                for (_, output_i, px) in pixels {
                    emit(head([px[0], px[1], px[2]]), output_i);
                }
            }
        }
    }
}

/// [`for_each_output_pixel`] writing row-major RGBA.
#[inline(always)]
fn fill_rgba(
    rgba: &mut [u8],
    pixels: OutputPixels<'_, '_>,
    head: impl Fn([f32; 3]) -> [f32; 3],
    emit: impl Fn(&mut [u8], [f32; 3], usize),
) {
    for_each_output_pixel(pixels, head, |value, index| {
        emit(&mut rgba[index * 4..index * 4 + 4], value, index);
    });
}

/// Float boundary immediately before output transform. When sharpening is
/// active this spans the working window, not just the output crop, so the
/// convolution sees the geometry halo. Later mask composition can reuse the
/// same boundary without decoding RGBA8.
struct LinearRgbPlane {
    width: usize,
    height: usize,
    data: Vec<f32>,
}

/// Builds a working-sized float plane. The local ratio is working-sized;
/// the vignette remains defined on the post-crop output and evaluates halo
/// coordinates relative to that output instead of indexing its rho table by
/// a working index.
#[allow(clippy::too_many_arguments)]
fn collect_working_float_plane(
    source: &[f32],
    width: usize,
    height: usize,
    output: Rect,
    output_filled_from_cache: bool,
    local: Option<&Plane>,
    vignette: Option<&LinearVignette<'_>>,
    head: impl Fn([f32; 3]) -> [f32; 3],
    tail: impl Fn([f32; 3]) -> [f32; 3],
) -> LinearRgbPlane {
    let mut data = vec![0.0f32; width * height * 3];
    for y in 0..height {
        for x in 0..width {
            // The exact cached tail fills the interior once below. Only
            // halo pixels need the uncached evaluation here.
            if output_filled_from_cache
                && x >= output.x
                && x < output.x + output.width
                && y >= output.y
                && y < output.y + output.height
            {
                continue;
            }
            let index = y * width + x;
            let offset = index * 3;
            let mut value = head([source[offset], source[offset + 1], source[offset + 2]]);
            let vignette_at = vignette.map(|effect| {
                let rho = effect.radius_at(
                    x as isize - output.x as isize,
                    y as isize - output.y as isize,
                );
                (effect, rho)
            });
            value = linear_spatial_pixel(value, local.map(|plane| plane.data[index]), vignette_at);
            data[offset..offset + 3].copy_from_slice(&tail(value));
        }
    }
    LinearRgbPlane {
        width,
        height,
        data,
    }
}

fn replace_output_region(
    plane: &mut LinearRgbPlane,
    output: Rect,
    values: impl IntoIterator<Item = [f32; 3]>,
) {
    let mut values = values.into_iter();
    for y in 0..output.height {
        for x in 0..output.width {
            let index = ((output.y + y) * plane.width + output.x + x) * 3;
            plane.data[index..index + 3]
                .copy_from_slice(&values.next().expect("complete output float region"));
        }
    }
    debug_assert!(values.next().is_none());
}

#[derive(Clone, Copy)]
enum FloatEncoding<'a> {
    Standard { transform: bool },
    Niho3(&'a crate::fastmath::Niho3Srgb8Encoder),
}

/// Float -> optional sharp -> output crop -> existing output transform /
/// encode -> output effects exactly once.
fn finalize_float_plane(
    mut plane: LinearRgbPlane,
    output: Rect,
    whole_long_edge: usize,
    sharpening: Option<crate::settings::SharpeningSettings>,
    encoding: FloatEncoding<'_>,
    output_effects: Option<&OutputEffects>,
    mark_out_of_srgb: bool,
) -> Vec<u8> {
    assert!(output.x + output.width <= plane.width);
    assert!(output.y + output.height <= plane.height);
    if let Some(sharpening) = sharpening.filter(|value| value.amount > 0.0) {
        // FramePlan retains a full internal halo. Near an actual photo edge
        // it clips that halo, and Gaussian clamping matches the whole render.
        crate::detail::sharpen_linear_srgb(
            &mut plane.data,
            plane.width,
            plane.height,
            whole_long_edge,
            sharpening,
        )
        .expect("validated float detail output");
    }

    let mut rgba = vec![0u8; output.width * output.height * 4];
    for y in 0..output.height {
        for x in 0..output.width {
            let source_index = ((output.y + y) * plane.width + output.x + x) * 3;
            let output_index = y * output.width + x;
            let pixel = &plane.data[source_index..source_index + 3];
            let value = [pixel[0], pixel[1], pixel[2]];
            let destination = &mut rgba[output_index * 4..output_index * 4 + 4];
            match encoding {
                FloatEncoding::Standard { transform } => {
                    write_rgba_fx(destination, value, transform, output_effects, output_index);
                    if mark_out_of_srgb
                        && transform
                        && (value[0] < 0.0 || value[1] < 0.0 || value[2] < 0.0)
                    {
                        destination[3] = 0;
                    }
                }
                FloatEncoding::Niho3(encoder) => match output_effects {
                    None => write_niho3_output_rgba(destination, value, encoder),
                    Some(effect) => {
                        write_niho3_output_rgba_fx(destination, value, effect, output_index)
                    }
                },
            }
        }
    }
    rgba
}

fn color_point_plane_key(
    kind: &str,
    img: &LinearImage,
    frame: Framing<'_>,
    quality: Quality,
    settings: &DevelopSettings,
) -> String {
    let mut before_points = settings.clone();
    before_points.color_points.clear();
    before_points.color_grading = Default::default();
    format!(
        "{kind}|{:p}|{}x{}|{:?}|{:?}|{}|{}",
        img.data.as_ptr(),
        img.width,
        img.height,
        frame.output,
        quality,
        frame.key,
        before_points.to_value()
    )
}

fn cached_color_point_plane<'a>(
    cache: &'a mut Option<ColorPointPlane>,
    key: String,
    width: usize,
    height: usize,
    pixels: OutputPixels<'_, '_>,
    head: impl Fn([f32; 3]) -> [f32; 3],
    before_color_points: impl Fn([f32; 3]) -> [f32; 3],
) -> &'a ColorPointPlane {
    let hit = cache
        .as_ref()
        .is_some_and(|plane| plane.key == key && plane.width == width && plane.height == height);
    if !hit {
        // Drop first so changing size/source never retains two full planes.
        *cache = None;
        let mut values = Vec::with_capacity(width * height);
        for_each_output_pixel(pixels, head, |value, index| {
            debug_assert_eq!(index, values.len());
            let value = before_color_points(value);
            values.push(CachedColorPointPixel {
                value,
                oklch: color_ops::cached_prophoto_to_oklch(value),
            });
        });
        *cache = Some(ColorPointPlane {
            key,
            width,
            height,
            pixels: values,
        });
    }
    cache.as_ref().expect("active-point plane")
}

/// The local pass as frames run it: the reference for released frames,
/// the half-resolution Highlights / Shadows for drag frames
/// ([`spatial::preview_luminance`]).
fn local_luminance(ln0: &Plane, params: &SpatialParams) -> Option<Plane> {
    match params.quality {
        Quality::Interactive => spatial::preview_luminance(ln0, params),
        Quality::Final => spatial::spatial_luminance(ln0, params),
    }
}

/// The local pass of a frame, kept by a [`crate::Session`] for its next
/// frames: the ratio `exp2(Ln - Ln0)` per pixel.
///
/// A drag frame takes the kept pass whenever its input is the same (the
/// image, the stages before the pass, Highlights / Shadows / Texture /
/// Clarity): the released frame's full-resolution pass included, and
/// without recomputing the adaptive statistics (Photo Bench also freezes
/// them while dragging, `PreviewDragSession`). Dragging a slider outside
/// the pass (a color, a curve, cube P on JPEG / PNG) then costs no local
/// processing at all. A released frame takes it only when it is a released
/// pass with the same adaptive parameters of the same source, i.e. the same
/// pixels. `niho-13`'s head white balance is the source's (`source_key`):
/// a drag of it keeps the pass of the frame before (its ratio of the
/// previous balance), the released frame computes it again.
pub struct LocalPass {
    input_key: String,
    source_key: String,
    params_key: String,
    quality: Quality,
    ratio: Plane,
}

/// Session-owned caches passed together through repeated-render entry points.
pub(crate) struct RenderCaches<'a> {
    cubes: Option<&'a SettingsCubes>,
    local: &'a mut Option<LocalPass>,
    /// Another frame's local pass of the same image (a local mask's layer
    /// reads its global frame's, `mask_session.rs`): taken instead of
    /// computing one when it is the pass this frame would compute (the same
    /// input, adaptive parameters and quality). Never written.
    shared_local: Option<&'a LocalPass>,
    effects: &'a mut EffectsCache,
    color_points: &'a mut Option<ColorPointPlane>,
    noise: &'a mut Option<NoiseCache>,
}

impl<'a> RenderCaches<'a> {
    pub(crate) fn new(
        cubes: Option<&'a SettingsCubes>,
        local: &'a mut Option<LocalPass>,
        effects: &'a mut EffectsCache,
        color_points: &'a mut Option<ColorPointPlane>,
        noise: &'a mut Option<NoiseCache>,
    ) -> Self {
        Self {
            cubes,
            local,
            shared_local: None,
            effects,
            color_points,
            noise,
        }
    }

    /// These caches with `shared` as [`RenderCaches::shared_local`].
    pub(crate) fn sharing_local(mut self, shared: Option<&'a LocalPass>) -> Self {
        self.shared_local = shared;
        self
    }
}

/// A frame's local pass slot and the shared pass it may read
/// ([`RenderCaches::shared_local`]).
struct LocalCaches<'a> {
    own: &'a mut Option<LocalPass>,
    shared: Option<&'a LocalPass>,
}

/// The exact pre-local v6 raster source retained by a Session. The key
/// includes immutable source identity, NR amounts, working size, geometry
/// window, whole-image scale and quality. `sampleColor` reads `image`, so it
/// cannot accidentally sample the unfiltered source used to create it.
pub(crate) struct NoiseCache {
    key: String,
    pub(crate) source_ptr: usize,
    pub(crate) image: LinearImage,
    stats: Option<LinearImage>,
}

/// Applies v6 source NR (color, then luminance) into `noise_cache`, or
/// clears it when no NR is active. Geometry windows include a halo and use
/// the whole-frame long edge, so their filter footprint matches an uncropped
/// render; the statistics source is reduced at its own full-resolution scale.
fn update_noise_cache(
    source_img: &LinearImage,
    framing: Option<&Framing<'_>>,
    source_space: crate::detail::SourceSpace,
    detail: Option<crate::settings::DetailSettings>,
    quality: Quality,
    noise_cache: &mut Option<NoiseCache>,
) {
    let source_long_edge = framing.map_or(source_img.width.max(source_img.height), |frame| {
        frame.long_edge
    });
    let active_detail = detail.filter(|value| {
        value.luminance_noise_reduction > 0.0
            || value
                .color_noise_reduction
                .is_some_and(|amount| amount > 0.0)
    });
    let Some(value) = active_detail else {
        *noise_cache = None;
        return;
    };
    let frame_key = framing.map_or("", |frame| frame.key);
    let output = framing.map(|frame| frame.output);
    let key = format!(
        "{:p}|{}x{}|{source_long_edge}|{frame_key}|{output:?}|{quality:?}|{source_space:?}|{}|{:?}",
        source_img.data.as_ptr(),
        source_img.width,
        source_img.height,
        value.luminance_noise_reduction,
        value.color_noise_reduction,
    );
    if noise_cache.as_ref().is_some_and(|cache| cache.key == key) {
        return;
    }
    let image = LinearImage {
        width: source_img.width,
        height: source_img.height,
        data: crate::detail::reduce_noise(
            &source_img.data,
            source_img.width,
            source_img.height,
            source_long_edge,
            source_space,
            value,
            value.color_noise_reduction,
        )
        .expect("validated decoded detail input"),
    };
    let stats = framing.map(|frame| LinearImage {
        width: frame.stats_source.width,
        height: frame.stats_source.height,
        data: crate::detail::reduce_noise(
            &frame.stats_source.data,
            frame.stats_source.width,
            frame.stats_source.height,
            // Statistics read the full source before geometry. Its NR
            // footprint belongs to that full-resolution source; the working
            // window separately uses frame.long_edge.
            frame.stats_source.width.max(frame.stats_source.height),
            source_space,
            value,
            value.color_noise_reduction,
        )
        .expect("validated decoded detail statistics input"),
    });
    *noise_cache = Some(NoiseCache {
        key,
        source_ptr: source_img.data.as_ptr() as usize,
        image,
        stats,
    });
}

/// Keeps only a local pass that may be reused by the next frame. A frame
/// without spatial adjustments must release the old pass so a later drag
/// recomputes adaptive statistics from its current settings.
fn prepare_local_cache(cache: &mut Option<LocalPass>, spatial_on: bool, input_key: &str) {
    if !spatial_on || cache.as_ref().is_some_and(|c| c.input_key != input_key) {
        *cache = None;
    }
}

/// The local pass for this frame from `cache` or computed (the kept plane
/// is dropped first: one pass in memory at a time), left in `cache`.
/// `params` computes the adaptive parameters (statistics), `ln0` the log
/// luminance of the stages before the pass. `shared` (another frame's pass
/// of the same image, [`RenderCaches::shared_local`]) serves when it has
/// this frame's input and adaptive parameters and is of this frame's
/// quality (the pass this frame would compute) or, for a drag frame, a
/// released pass (which a drag frame takes from its own cache too).
fn local_pass<'c>(
    cache: &'c mut Option<LocalPass>,
    shared: Option<&'c LocalPass>,
    input_key: String,
    source_key: String,
    quality: Quality,
    params: impl FnOnce() -> SpatialParams,
    ln0: impl FnOnce() -> Plane,
) -> Option<&'c LocalPass> {
    let same_input = cache.as_ref().is_some_and(|c| c.input_key == input_key);
    if same_input && quality == Quality::Interactive {
        return cache.as_ref();
    }
    let p = params();
    let params_key = format!("{:?}|{:?}|{}", p.gain_scale, p.shift, p.scale_px);
    let same_pass = cache.as_ref().is_some_and(|c| {
        c.quality == Quality::Final && c.params_key == params_key && c.source_key == source_key
    });
    if same_input && same_pass {
        return cache.as_ref();
    }
    if let Some(shared) = shared.filter(|c| {
        c.input_key == input_key
            && c.params_key == params_key
            && (c.quality == quality || c.quality == Quality::Final)
    }) {
        *cache = None;
        return Some(shared);
    }
    *cache = None;
    let ln0 = ln0();
    let mut ratio = local_luminance(&ln0, &p)?;
    for (r, l0) in ratio.data.iter_mut().zip(&ln0.data) {
        *r = libm::exp2f(*r - l0);
    }
    drop(ln0);
    *cache = Some(LocalPass {
        input_key,
        source_key,
        params_key,
        quality,
        ratio,
    });
    cache.as_ref()
}

/// `raster` balanced by the head white balance of `s` (`niho-13`,
/// `head_wb.rs`; `None` when `s` takes none). A Session keeps the balanced
/// source instead.
fn head_balanced_raster(raster: &Raster, s: &DevelopSettings) -> Option<Raster> {
    crate::head_wb::balanced(&raster.image, crate::niho6::SourceSpace::LinearSrgb, s).map(|image| {
        Raster {
            image,
            info: raster.info.clone(),
        }
    })
}

/// A raster working copy balanced by the head white balance of `s` (`None`
/// for a RAW working copy or settings that take none).
fn head_balanced_working_copy(wc: &WorkingCopy<'_>, s: &DevelopSettings) -> Option<LinearImage> {
    if !matches!(wc.meta, WorkingCopyMeta::Raster { .. }) {
        return None;
    }
    crate::head_wb::balanced(wc.image, crate::niho6::SourceSpace::LinearProPhoto, s)
}

/// Renders a decoded JPEG / PNG original. `niho-13` balances it first
/// (`head_wb.rs`); `niho-6` settings that use its response are prepared
/// here from this (balanced) raster (a Session keeps the analysis instead,
/// [`prepare_niho6`]).
pub fn render_raster(
    raster: &Raster,
    s: &DevelopSettings,
    quality: Quality,
    stats_cache: Option<AdaptiveStats>,
    cubes_cache: Option<&SettingsCubes>,
) -> (Rendered, SettingsCubes, Option<AdaptiveStats>) {
    let balanced = head_balanced_raster(raster, s);
    let raster = balanced.as_ref().unwrap_or(raster);
    let prepared = niho6_one_shot(raster, s);
    let (raster, failed) = match &prepared {
        Some(Ok(prepared)) => (prepared, false),
        Some(Err(_)) => (raster, true),
        None => (raster, false),
    };
    let downstream;
    let render_settings = if matches!(&prepared, Some(Ok(_))) {
        downstream = crate::detail::source_noise_disabled(s);
        &downstream
    } else {
        s
    };
    let (mut rendered, cubes, stats) = render_raster_in_session(
        raster,
        None,
        render_settings,
        quality,
        stats_cache,
        RenderCaches::new(
            cubes_cache,
            &mut None,
            &mut EffectsCache::default(),
            &mut None,
            &mut None,
        ),
    );
    if failed {
        rendered.approximations.push("niho6ResponseUnavailable");
    }
    (rendered, cubes, stats)
}

/// `raster` prepared for `niho-6` settings that use the response, from its
/// own analysis (`None` when these settings do not need it).
fn niho6_one_shot(
    raster: &Raster,
    s: &DevelopSettings,
) -> Option<Result<Raster, crate::niho6::PrepareError>> {
    if !crate::niho6::uses_raster_formula(s) || !crate::niho6::uses_response(s) {
        return None;
    }
    let space = crate::niho6::SourceSpace::LinearSrgb;
    let reduced;
    let image = if let Some(detail) = s.detail.filter(|detail| {
        detail.luminance_noise_reduction > 0.0
            || detail
                .color_noise_reduction
                .is_some_and(|amount| amount > 0.0)
    }) {
        reduced = LinearImage {
            width: raster.image.width,
            height: raster.image.height,
            data: crate::detail::reduce_noise(
                &raster.image.data,
                raster.image.width,
                raster.image.height,
                raster.image.width.max(raster.image.height),
                crate::detail::SourceSpace::LinearSrgb,
                detail,
                detail.color_noise_reduction,
            )
            .expect("validated decoded NIHO 6 detail input"),
        };
        &reduced
    } else {
        &raster.image
    };
    Some(
        crate::niho6::analysis_of(
            image,
            space,
            crate::niho6::analysis_exposure(s),
            crate::niho6::analysis_kind(s),
        )
        .and_then(|analysis| crate::niho6::apply(image, space, &analysis, s))
        .map(|image| Raster {
            image,
            info: raster.info.clone(),
        }),
    )
}

/// The `niho-6` image of a Session: `image` (the whole source or its
/// reduction for a display-size frame) with the response gains of the
/// analysis of the whole source ([`crate::niho6::response_gains`], which the
/// Session keeps: the same bytes as [`crate::niho6::apply`]).
pub(crate) fn prepare_niho6(
    image: &LinearImage,
    space: crate::niho6::SourceSpace,
    gains: &crate::niho6::ResponseGains,
) -> Result<LinearImage, crate::niho6::PrepareError> {
    crate::niho6::apply_gains(image, space, gains)
}

/// [`render_raster`] with a session's kept local pass ([`LocalPass`]) and
/// effects' planes. With a geometry, `raster` is the window and `framing`
/// says where the output is ([`Framing`]).
pub(crate) fn render_raster_in_session(
    raster: &Raster,
    framing: Option<&Framing<'_>>,
    s: &DevelopSettings,
    quality: Quality,
    stats_cache: Option<AdaptiveStats>,
    caches: RenderCaches<'_>,
) -> (Rendered, SettingsCubes, Option<AdaptiveStats>) {
    let RenderCaches {
        cubes,
        local,
        shared_local,
        effects,
        color_points,
        noise,
    } = caches;
    render_linear(
        &raster.image,
        framing,
        raster.info.is_bounded_srgb(),
        None,
        s,
        quality,
        stats_cache,
        cubes,
        LocalCaches {
            own: local,
            shared: shared_local,
        },
        effects,
        color_points,
        noise,
        false,
    )
}

/// [`render_raster`] at final quality with alpha 0 on every pixel whose
/// color leaves sRGB before the output stage: where NIHO clips first and
/// Photo Bench compresses the unclipped color (output.rs). Diagnostics: the
/// golden test leaves those pixels out of its 99.9th percentile.
pub fn render_raster_marking_out_of_srgb(raster: &Raster, s: &DevelopSettings) -> Rendered {
    let balanced = head_balanced_raster(raster, s);
    let raster = balanced.as_ref().unwrap_or(raster);
    let prepared = niho6_one_shot(raster, s).and_then(Result::ok);
    let raster = prepared.as_ref().unwrap_or(raster);
    let downstream;
    let render_settings = if prepared.is_some() {
        downstream = crate::detail::source_noise_disabled(s);
        &downstream
    } else {
        s
    };
    render_linear(
        &raster.image,
        None,
        raster.info.is_bounded_srgb(),
        None,
        render_settings,
        Quality::Final,
        None,
        None,
        LocalCaches {
            own: &mut None,
            shared: None,
        },
        &mut EffectsCache::default(),
        &mut None,
        &mut None,
        true,
    )
    .0
}

/// The non-RAW path on `img`, whose pixels `input` maps to extended linear
/// sRGB (identity for decoded originals; ProPhoto -> sRGB for non-RAW
/// working copies). Nothing full-size is kept but the log luminance planes
/// of the local pass and the output: every per-pixel stage before it is
/// recomputed from the source in the final loop (same values).
/// `mark_out_of_srgb`: [`render_raster_marking_out_of_srgb`]. With a
/// geometry, `img` is the window ([`Framing`]).
#[allow(clippy::too_many_arguments)]
fn render_linear(
    source_img: &LinearImage,
    framing: Option<&Framing<'_>>,
    bounded_srgb: bool,
    input: Option<[[f32; 3]; 3]>,
    s: &DevelopSettings,
    quality: Quality,
    stats_cache: Option<AdaptiveStats>,
    cubes_cache: Option<&SettingsCubes>,
    local_caches: LocalCaches<'_>,
    effects_cache: &mut EffectsCache,
    color_point_cache: &mut Option<ColorPointPlane>,
    noise_cache: &mut Option<NoiseCache>,
    mark_out_of_srgb: bool,
) -> (Rendered, SettingsCubes, Option<AdaptiveStats>) {
    let LocalCaches {
        own: local_cache,
        shared: shared_local,
    } = local_caches;
    // NIHO 3 changes only signed RAW rendering. Raster input inherits the
    // complete NIHO 2 formula, including Interactive preview closures; do
    // this once at the entrance so no RAW-only branch can leak into JPEG.
    let ignored_cnr_detail = s.color_noise_reduction_detail != 50.0;
    let ignored_cnr_smoothness = s.color_noise_reduction_smoothness != 50.0;
    let raster_legacy = (s.engine == ENGINE_NIHO_3).then(|| {
        let mut legacy = s.clone();
        legacy.engine = ENGINE_NIHO_2.to_string();
        legacy.look = crate::look::LOOK_NIHO_INTERIM_1.to_string();
        legacy
    });
    let s = raster_legacy.as_ref().unwrap_or(s);
    // v6 source NR precedes NIHO local tone processing. Raster color NR is
    // opt-in only: the legacy top-level field remains ignored on JPEG/PNG.
    let source_space = if input.is_some() {
        crate::detail::SourceSpace::LinearProPhoto
    } else {
        crate::detail::SourceSpace::LinearSrgb
    };
    update_noise_cache(
        source_img,
        framing,
        source_space,
        s.detail,
        quality,
        noise_cache,
    );
    let cached_noise = noise_cache.as_ref();
    let img = cached_noise.map_or(source_img, |cache| &cache.image);
    let reduced_framing = framing.map(|frame| Framing {
        stats_source: cached_noise
            .and_then(|cache| cache.stats.as_ref())
            .unwrap_or(frame.stats_source),
        ..*frame
    });
    let framing = reduced_framing.as_ref();
    let mut approximations = Vec::new();
    if ignored_cnr_detail {
        approximations.push("colorNoiseReductionDetail");
    }
    if ignored_cnr_smoothness {
        approximations.push("colorNoiseReductionSmoothness");
    }
    // niho-6: the prepared image (niho6.rs) holds the learned share of
    // Highlights <= 0 and Shadows >= 0; the legacy local pass keeps the other
    // directions and `LEGACY_SHARE` of those (R24).
    let (spatial_highlights, spatial_shadows) = if crate::niho6::uses_raster_formula(s) {
        let legacy = |v: f64, learned: bool| {
            if learned {
                v * crate::niho6::LEGACY_SHARE
            } else {
                v
            }
        };
        (
            legacy(s.highlights, s.highlights < 0.0),
            legacy(s.shadows, s.shadows > 0.0),
        )
    } else {
        (s.highlights, s.shadows)
    };
    let spatial_on =
        spatial_highlights != 0.0 || spatial_shadows != 0.0 || s.texture != 0.0 || s.clarity != 0.0;
    let input_matrix = input;
    let input = |px: [f32; 3]| match &input_matrix {
        Some(m) => mat_vec_f32(m, px),
        None => px,
    };
    let mut stats = stats_cache;
    let jpeg_white_balance = if uses_jpeg_white_balance(&s.engine)
        && s.white_balance.mode == WhiteBalanceMode::Relative
    {
        PreparedJpegWhiteBalance::new(s.relative_temperature, s.relative_tint)
    } else {
        None
    };
    let relative = if uses_relative_matrix_on_raster(&s.engine)
        && s.white_balance.mode == WhiteBalanceMode::Relative
    {
        relative_matrix(s.relative_temperature, s.relative_tint)
    } else {
        None
    };
    if s.white_balance.mode == WhiteBalanceMode::Absolute {
        // Photo Bench keeps an absolute white balance on non-RAW input
        // without rendering it.
        approximations.push("absoluteWhiteBalanceIgnoredForRaster");
    }
    let want_post = s.exposure != 0.0 || needs_post_ops(s);
    let stage_p = want_post || spatial_on;
    let (w, h) = (img.width, img.height);
    let frame = frame_of(img, framing);
    let out = frame.output;
    let fx = effects::prepare(s, out.width, out.height, effects_cache);
    approximations.extend(&fx.approximations);
    let (vignette, out_fx) = (fx.linear.as_ref(), fx.output.as_ref());

    let input_key = format!(
        "raster|{w}x{h}|{input_matrix:?}|{relative:?}|{stage_p}|{}|{}|{}|{}|{}",
        spatial_highlights, spatial_shadows, s.texture, s.clarity, frame.key
    );
    // `niho-13`: `img` is the source balanced by its head white balance (the
    // caller's). A drag of the balance may keep the pass ([`LocalPass`]); a
    // released frame only takes a pass of the same balance.
    let source_key = crate::head_wb::HeadWhiteBalance::key(crate::head_wb::HeadWhiteBalance::of(s));
    prepare_local_cache(local_cache, spatial_on, &input_key);
    let calibration =
        needs_calibration(&s.calibration).then(|| to_f32(&calibration_matrix(&s.calibration)));
    let color_on = needs_color_ops(s);
    // Drag frames whose chain starts with a cube (its input clamp makes the
    // rest a function of the encoded value): one lookup per pixel. The tail
    // evaluates cube P / Q itself, so they are not baked for it.
    let entry = if s.has_active_color_points() {
        None
    } else {
        match quality {
            Quality::Final => None,
            Quality::Interactive if want_post => Some(PreviewEntry::Post),
            Quality::Interactive if color_on && calibration.is_none() => Some(PreviewEntry::Color),
            Quality::Interactive => None,
        }
    };
    let mut cubes = settings_cubes(
        s,
        s.exposure,
        quality,
        cubes_cache,
        entry.is_none(),
        None,
        false,
    );
    let tail = RasterTail {
        post: cubes.post.clone(),
        stage_p,
        calibration,
        color: cubes.color.clone(),
        point_tail: s
            .has_active_color_points()
            .then(|| PreparedColorOps::new(s)),
        output_transform: !bounded_srgb || has_active_color_edits(s),
    };
    let preview = entry.map(|entry| {
        let color = color_on.then(|| PreparedColorOps::new(s));
        let q = |v: [f32; 3]| match &color {
            Some(c) => exact(&|x| c.apply(x), v),
            None => v,
        };
        let drag = match entry {
            PreviewEntry::Post => {
                let post = PreparedPostOps::with_exposure(s, s.exposure);
                let key_a = format!("raster|post|{}", cubes.post_key);
                let key = format!(
                    "{key_a}|{}|{:?}|{}",
                    cubes.color_key, calibration, tail.output_transform
                );
                drag_tail(
                    cubes.drag.as_ref(),
                    key_a,
                    key,
                    &|e| exact(&|x| post.apply(x), decode(e)),
                    &|p| {
                        // RasterTail::pixel after cube P, with cube Q as its function.
                        let mut v = mat_vec_f32(&PROPHOTO_TO_SRGB_F32, p);
                        if calibration.is_some() || color.is_some() {
                            v = mat_vec_f32(&SRGB_TO_PROPHOTO_F32, v);
                            if let Some(m) = &calibration {
                                v = clamp01(mat_vec_f32(m, v));
                            }
                            v = mat_vec_f32(&PROPHOTO_TO_SRGB_F32, q(v));
                        }
                        oetf3(tail.output(v))
                    },
                )
            }
            PreviewEntry::Color => {
                let key_a = "raster|color".to_string();
                let key = format!("{key_a}|{}|{}", cubes.color_key, tail.output_transform);
                drag_tail(cubes.drag.as_ref(), key_a, key, &decode, &|v| {
                    oetf3(tail.output(mat_vec_f32(&PROPHOTO_TO_SRGB_F32, q(v))))
                })
            }
        };
        cubes.drag = Some(drag.clone());
        (entry, drag)
    });
    // The per-pixel stages before the local pass (the input conversion is
    // matched outside the pixel loops).
    let rest = |v: [f32; 3]| raster_head_pixel(v, None, relative.as_ref(), stage_p);
    let head = |px: [f32; 3]| rest(input(px));
    let local_pass = if spatial_on {
        local_pass(
            local_cache,
            shared_local,
            input_key,
            source_key,
            quality,
            || {
                // Non-RAW adaptive statistics: the plain input (linear sRGB,
                // before the relative white balance), reduced like Core
                // Image's sampling.
                let stats = *stats.get_or_insert_with(|| {
                    let whole = frame.stats_source;
                    let (small, sw, sh) = bilinear_downscale_with(
                        &whole.data,
                        whole.width,
                        whole.height,
                        quality.stats_long_edge(),
                        input,
                    );
                    spatial::compute_stats(&small, sw, sh, REC709_LUMA_F32)
                });
                let (gain_scale, shift) = adaptive_parameters(Some(&stats), AdaptivePath::NonRaw);
                SpatialParams {
                    highlights: spatial_highlights,
                    shadows: spatial_shadows,
                    texture: s.texture,
                    clarity: s.clarity,
                    scale_px: spatial::scale_px(frame.long_edge as f64),
                    long_edge: frame.long_edge,
                    gain_scale,
                    shift,
                    quality,
                }
            },
            || {
                let mut ln0 = Plane::new(w, h);
                for (dst, px) in ln0.data.iter_mut().zip(img.data.chunks_exact(3)) {
                    *dst = spatial::log_luminance(head([px[0], px[1], px[2]]));
                }
                ln0
            },
        )
    } else {
        None
    };
    let local = local_pass.map(|pass| &pass.ratio);
    let mut rgba = vec![0u8; out.width * out.height * 4];
    let pixels = OutputPixels {
        src: &img.data,
        src_width: w,
        output: out,
        local,
        vignette,
    };
    // One monomorphized loop per (input conversion, output) pair.
    macro_rules! fill {
        ($emit:expr) => {
            match &input_matrix {
                Some(m) => fill_rgba(&mut rgba, pixels, |px| rest(mat_vec_f32(m, px)), $emit),
                None => fill_rgba(&mut rgba, pixels, rest, $emit),
            }
        };
    }
    let final_sharpening = (quality == Quality::Final)
        .then(|| s.detail.map(|detail| detail.sharpening))
        .flatten()
        .filter(|sharpening| sharpening.amount > 0.0);
    if let Some(sharpening) = final_sharpening {
        // Keep the tail in float. Detail sharpening must never decode the
        // already quantized Rendered.rgba, and output effects are applied
        // exactly once after sharpening. The float plane spans the working
        // halo; only finalize extracts the output rectangle.
        let mut linear = match &input_matrix {
            Some(matrix) => collect_working_float_plane(
                &img.data,
                w,
                h,
                out,
                s.has_active_color_points(),
                local,
                vignette,
                |pixel| rest(mat_vec_f32(matrix, pixel)),
                |value| tail.float_boundary_pixel(value),
            ),
            None => collect_working_float_plane(
                &img.data,
                w,
                h,
                out,
                s.has_active_color_points(),
                local,
                vignette,
                rest,
                |value| tail.float_boundary_pixel(value),
            ),
        };
        if s.has_active_color_points() {
            let key = format!(
                "{}|local={:?}",
                color_point_plane_key("raster", img, frame, quality, s),
                local_pass.map(|pass| &pass.params_key)
            );
            let plane = match &input_matrix {
                Some(m) => cached_color_point_plane(
                    color_point_cache,
                    key,
                    out.width,
                    out.height,
                    pixels,
                    |px| rest(mat_vec_f32(m, px)),
                    |value| tail.before_color_points(value),
                ),
                None => cached_color_point_plane(
                    color_point_cache,
                    key,
                    out.width,
                    out.height,
                    pixels,
                    rest,
                    |value| tail.before_color_points(value),
                ),
            };
            replace_output_region(
                &mut linear,
                out,
                plane
                    .pixels
                    .iter()
                    .copied()
                    .map(|pixel| tail.cached_point_pixel(pixel)),
            );
        } else {
            *color_point_cache = None;
        }
        rgba = finalize_float_plane(
            linear,
            out,
            frame.long_edge,
            Some(sharpening),
            FloatEncoding::Standard {
                transform: tail.output_transform,
            },
            out_fx,
            mark_out_of_srgb,
        );
    } else if s.has_active_color_points() {
        let key = format!(
            "{}|local={:?}",
            color_point_plane_key("raster", img, frame, quality, s),
            local_pass.map(|pass| &pass.params_key)
        );
        let plane = match &input_matrix {
            Some(m) => cached_color_point_plane(
                color_point_cache,
                key,
                out.width,
                out.height,
                pixels,
                |px| rest(mat_vec_f32(m, px)),
                |value| tail.before_color_points(value),
            ),
            None => cached_color_point_plane(
                color_point_cache,
                key,
                out.width,
                out.height,
                pixels,
                rest,
                |value| tail.before_color_points(value),
            ),
        };
        for (i, pixel) in plane.pixels.iter().copied().enumerate() {
            let output = tail.cached_point_pixel(pixel);
            let out = &mut rgba[i * 4..i * 4 + 4];
            write_rgba_fx(out, output, tail.output_transform, out_fx, i);
            if mark_out_of_srgb
                && tail.output_transform
                && (output[0] < 0.0 || output[1] < 0.0 || output[2] < 0.0)
            {
                out[3] = 0;
            }
        }
    } else {
        // A non-point frame must not keep a large plane alive for a later,
        // unrelated edit or preview.
        *color_point_cache = None;
        match &preview {
            Some((PreviewEntry::Post, drag)) => {
                fill!(|out: &mut [u8], v: [f32; 3], i: usize| {
                    write_encoded_fx(out, drag.lookup(v), out_fx, i)
                })
            }
            Some((PreviewEntry::Color, drag)) => fill!(|out: &mut [u8], v: [f32; 3], i: usize| {
                let v = if stage_p {
                    mat_vec_f32(&PROPHOTO_TO_SRGB_F32, v)
                } else {
                    v
                };
                write_encoded_fx(
                    out,
                    drag.lookup(mat_vec_f32(&SRGB_TO_PROPHOTO_F32, v)),
                    out_fx,
                    i,
                )
            }),
            None if mark_out_of_srgb => fill!(|out: &mut [u8], v: [f32; 3], i: usize| {
                let p = tail.pixel(v);
                write_rgba_fx(out, p, tail.output_transform, out_fx, i);
                // The shoulder keeps every channel below 1, so only a negative
                // one takes the color out of sRGB at the output stage.
                if tail.output_transform && (p[0] < 0.0 || p[1] < 0.0 || p[2] < 0.0) {
                    out[3] = 0;
                }
            }),
            None => fill!(|out: &mut [u8], v: [f32; 3], i: usize| {
                write_rgba_fx(out, tail.pixel(v), tail.output_transform, out_fx, i)
            }),
        }
    }
    if let Some(white_balance) = jpeg_white_balance {
        white_balance.apply_rgba(&mut rgba);
    }
    (
        Rendered {
            width: out.width,
            height: out.height,
            rgba,
            approximations,
        },
        cubes,
        stats,
    )
}

/// The per-pixel tail after exposure / [S] on the RAW path, in linear
/// ProPhoto: look + ACR3 cube -> RAW black & white mix -> cube P ->
/// Calibration -> cube Q.
struct RawTail {
    legacy_acr3: &'static Cube,
    candidate_acr3: Option<Arc<Cube>>,
    niho4_camera: Option<crate::niho4_response::Camera>,
    post: Option<Arc<Cube>>,
    calibration: Option<[[f32; 3]; 3]>,
    color_ops: Option<PreparedColorOps>,
    color: Option<Arc<Cube>>,
    /// Exact end of Stage Q when independent points are active.
    point_tail: Option<PreparedColorOps>,
}

impl RawTail {
    fn new(
        s: &DevelopSettings,
        cubes: &SettingsCubes,
        niho4_camera: Option<crate::niho4_response::Camera>,
    ) -> Self {
        Self {
            legacy_acr3: look_cube(&s.look),
            candidate_acr3: cubes.acr3.clone(),
            niho4_camera,
            post: cubes.post.clone(),
            calibration: needs_calibration(&s.calibration)
                .then(|| to_f32(&calibration_matrix(&s.calibration))),
            color_ops: needs_color_ops(s).then(|| PreparedColorOps::after_default_curve(s)),
            color: cubes.color.clone(),
            point_tail: s
                .has_active_color_points()
                .then(|| PreparedColorOps::after_default_curve(s)),
        }
    }

    #[inline]
    fn pixel(&self, px: [f32; 3]) -> [f32; 3] {
        self.pixel_encoded(encode(px))
    }

    /// The tail from the encoded (clamped) input of the first cube.
    #[inline]
    fn pixel_encoded(&self, e: [f32; 3]) -> [f32; 3] {
        let v = self.before_color_points_encoded(e);
        match &self.point_tail {
            Some(point_tail) => point_tail
                .apply_color_points_and_grading(v.map(f64::from))
                .map(|channel| channel as f32),
            None => v,
        }
    }

    #[inline]
    fn cached_point_pixel(&self, pixel: CachedColorPointPixel) -> [f32; 3] {
        self.point_tail
            .as_ref()
            .expect("active point tail")
            .apply_cached_color_points_and_grading(pixel.value, pixel.oklch)
    }

    /// Working-halo counterpart of the output-sized point cache.
    #[inline]
    fn float_boundary_pixel(&self, value: [f32; 3]) -> [f32; 3] {
        if self.point_tail.is_none() {
            return self.pixel(value);
        }
        let value = self.before_color_points(value);
        self.cached_point_pixel(CachedColorPointPixel {
            value,
            oklch: color_ops::cached_prophoto_to_oklch(value),
        })
    }

    /// Shared normal-render / picker chain through the input of independent
    /// color points.
    #[inline]
    fn before_color_points(&self, px: [f32; 3]) -> [f32; 3] {
        self.before_color_points_encoded(encode(px))
    }

    #[inline]
    fn before_color_points_encoded(&self, e: [f32; 3]) -> [f32; 3] {
        // Adjacent cubes pass values in the encoded domain.
        let mut e = self
            .candidate_acr3
            .as_deref()
            .unwrap_or(self.legacy_acr3)
            .lookup_encoded(e);
        if let Some(camera) = self.niho4_camera {
            e = encode(crate::niho4::pre_profile(camera, decode(e)));
        }
        if let Some(color_ops) = &self.color_ops {
            // The RAW black & white mix measures the color immediately after
            // ACR3. It must not see cube P or calibration output.
            let v = exact(&|x| color_ops.apply_raw_before_post(x), decode(e));
            e = encode(v);
        }
        if let Some(p) = &self.post {
            e = p.apply_encoded(e);
        }
        let mut v = decode(e);
        if let Some(cal) = &self.calibration {
            let c = mat_vec_f32(cal, v);
            v = [
                c[0].clamp(0.0, 1.0),
                c[1].clamp(0.0, 1.0),
                c[2].clamp(0.0, 1.0),
            ];
        }
        if let Some(q) = &self.color {
            v = q.apply(v);
        }
        v
    }
}

/// RAW working copy with its metadata.
pub struct WorkingCopy<'a> {
    pub image: &'a LinearImage,
    pub meta: &'a WorkingCopyMeta,
}

/// Renders a RAW (or non-RAW) working copy. `niho-13` balances a non-RAW
/// working copy first (`head_wb.rs`). `niho-6` settings that use its
/// response are prepared here from a non-RAW working copy (linear ProPhoto),
/// as [`render_raster`] does for rasters (a Session keeps the analysis
/// instead), so this draws the same image as a Session.
pub fn render_working_copy(
    wc: &WorkingCopy<'_>,
    s: &DevelopSettings,
    quality: Quality,
    cubes_cache: Option<&SettingsCubes>,
) -> (Rendered, SettingsCubes) {
    let balanced = head_balanced_working_copy(wc, s);
    let wc = &WorkingCopy {
        image: balanced.as_ref().unwrap_or(wc.image),
        meta: wc.meta,
    };
    let prepared = niho6_working_copy_one_shot(wc, s);
    let (image, failed) = match &prepared {
        Some(Ok(prepared)) => (prepared, false),
        Some(Err(_)) => (wc.image, true),
        None => (wc.image, false),
    };
    let downstream;
    let render_settings = if matches!(&prepared, Some(Ok(_))) {
        downstream = crate::detail::source_noise_disabled(s);
        &downstream
    } else {
        s
    };
    let (mut rendered, cubes) = render_working_copy_in_session(
        &WorkingCopy {
            image,
            meta: wc.meta,
        },
        None,
        render_settings,
        quality,
        RenderCaches::new(
            cubes_cache,
            &mut None,
            &mut EffectsCache::default(),
            &mut None,
            &mut None,
        ),
    );
    if failed {
        rendered.approximations.push("niho6ResponseUnavailable");
    }
    (rendered, cubes)
}

/// A non-RAW working copy prepared for `niho-6` settings that use the
/// response, from its own analysis in linear ProPhoto (`None` for a RAW
/// working copy or settings that do not need it).
fn niho6_working_copy_one_shot(
    wc: &WorkingCopy<'_>,
    s: &DevelopSettings,
) -> Option<Result<LinearImage, crate::niho6::PrepareError>> {
    if !matches!(wc.meta, WorkingCopyMeta::Raster { .. })
        || !crate::niho6::uses_raster_formula(s)
        || !crate::niho6::uses_response(s)
    {
        return None;
    }
    let space = crate::niho6::SourceSpace::LinearProPhoto;
    let reduced;
    let image = if let Some(detail) = s.detail.filter(|detail| {
        detail.luminance_noise_reduction > 0.0
            || detail
                .color_noise_reduction
                .is_some_and(|amount| amount > 0.0)
    }) {
        reduced = LinearImage {
            width: wc.image.width,
            height: wc.image.height,
            data: crate::detail::reduce_noise(
                &wc.image.data,
                wc.image.width,
                wc.image.height,
                wc.image.width.max(wc.image.height),
                crate::detail::SourceSpace::LinearProPhoto,
                detail,
                detail.color_noise_reduction,
            )
            .expect("validated NIHO 6 working-copy detail input"),
        };
        &reduced
    } else {
        wc.image
    };
    Some(
        crate::niho6::analysis_of(
            image,
            space,
            crate::niho6::analysis_exposure(s),
            crate::niho6::analysis_kind(s),
        )
        .and_then(|analysis| crate::niho6::apply(image, space, &analysis, s)),
    )
}

/// [`render_working_copy`] with a session's kept local pass ([`LocalPass`])
/// and effects' planes. With a geometry, `wc.image` is the window and
/// `framing` says where the output is ([`Framing`]).
pub(crate) fn render_working_copy_in_session(
    wc: &WorkingCopy<'_>,
    framing: Option<&Framing<'_>>,
    s: &DevelopSettings,
    quality: Quality,
    caches: RenderCaches<'_>,
) -> (Rendered, SettingsCubes) {
    render_working_copy_with(wc, framing, s, quality, caches, false)
}

/// [`render_working_copy`] at final quality with alpha 0 on every pixel
/// whose color leaves sRGB before the output stage (as
/// [`render_raster_marking_out_of_srgb`]; the RAW golden test).
pub fn render_working_copy_marking_out_of_srgb(
    wc: &WorkingCopy<'_>,
    s: &DevelopSettings,
) -> Rendered {
    let balanced = head_balanced_working_copy(wc, s);
    let wc = &WorkingCopy {
        image: balanced.as_ref().unwrap_or(wc.image),
        meta: wc.meta,
    };
    let prepared = niho6_working_copy_one_shot(wc, s);
    let (image, failed) = match &prepared {
        Some(Ok(prepared)) => (prepared, false),
        Some(Err(_)) => (wc.image, true),
        None => (wc.image, false),
    };
    let downstream;
    let render_settings = if matches!(&prepared, Some(Ok(_))) {
        downstream = crate::detail::source_noise_disabled(s);
        &downstream
    } else {
        s
    };
    let mut rendered = render_working_copy_with(
        &WorkingCopy {
            image,
            meta: wc.meta,
        },
        None,
        render_settings,
        Quality::Final,
        RenderCaches::new(
            None,
            &mut None,
            &mut EffectsCache::default(),
            &mut None,
            &mut None,
        ),
        true,
    )
    .0;
    if failed {
        rendered.approximations.push("niho6ResponseUnavailable");
    }
    rendered
}

fn render_working_copy_with(
    wc: &WorkingCopy<'_>,
    framing: Option<&Framing<'_>>,
    s: &DevelopSettings,
    quality: Quality,
    caches: RenderCaches<'_>,
    mark_out_of_srgb: bool,
) -> (Rendered, SettingsCubes) {
    let RenderCaches {
        cubes,
        local,
        shared_local,
        effects,
        color_points,
        noise,
    } = caches;
    let local = LocalCaches {
        own: local,
        shared: shared_local,
    };
    match wc.meta {
        WorkingCopyMeta::Raster { .. } => {
            // Non-RAW working copies (HEIC / TIFF / large JPEG) are linear
            // ProPhoto; they take the non-RAW path from linear sRGB.
            let (r, c, _) = render_linear(
                wc.image,
                framing,
                false,
                Some(PROPHOTO_TO_SRGB_F32),
                s,
                quality,
                None,
                cubes,
                local,
                effects,
                color_points,
                noise,
                mark_out_of_srgb,
            );
            (r, c)
        }
        WorkingCopyMeta::Raw {
            baseline_ev,
            as_shot_white,
            as_shot_white_adobe,
            white_balance_table,
            dcp_sha256,
            ..
        } => {
            let white_balance = raw_white_balance(
                as_shot_white,
                as_shot_white_adobe.as_ref(),
                white_balance_table.as_deref(),
                s,
            );
            // Signed RAW engines reduce noise once while preparing their
            // canonical master (niho3.rs / niho4.rs). A legacy unsigned RAW
            // working copy (niho-1 / niho-2 / niho-8) has no such master, so
            // its v6 NR runs here on the linear ProPhoto source, before white
            // balance and exposure, with the same cache as raster sources.
            let unsigned_legacy = !matches!(
                s.engine.as_str(),
                ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
            );
            if unsigned_legacy {
                update_noise_cache(
                    wc.image,
                    framing,
                    crate::detail::SourceSpace::LinearProPhoto,
                    s.detail,
                    quality,
                    noise,
                );
            }
            let cached_noise = noise.as_ref().filter(|_| unsigned_legacy);
            let img = cached_noise.map_or(wc.image, |cache| &cache.image);
            let reduced_framing = framing.map(|frame| Framing {
                stats_source: cached_noise
                    .and_then(|cache| cache.stats.as_ref())
                    .unwrap_or(frame.stats_source),
                ..*frame
            });
            render_raw(
                img,
                reduced_framing.as_ref(),
                *baseline_ev,
                white_balance,
                matches!(
                    s.engine.as_str(),
                    ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
                )
                .then(|| crate::niho4_response::Camera::from_calibration(dcp_sha256))
                .flatten(),
                s,
                quality,
                cubes,
                local,
                effects,
                color_points,
                mark_out_of_srgb,
            )
        }
    }
}

/// A RAW working copy's absolute white balance: the matrix applied to its
/// linear ProPhoto before exposure.
#[derive(Debug, Clone, Copy)]
struct RawWhiteBalance {
    matrix: [[f32; 3]; 3],
    /// A chromatic adaptation standing in for the RAW decoder's white
    /// (`absoluteWhiteBalance`).
    approximate: bool,
}

/// The absolute white balance of `s` on a RAW working copy; `None` unless
/// `s` sets an absolute white.
///
/// With the working copy's white-balance table (S11 #17108) and its as-shot
/// white in Lightroom's scale, it is the matrix Apple's RAW decoder applies
/// between the two whites ([`WhiteBalanceTable::working_copy_transfer`]).
/// The as-shot white is the one stage 1's self-check used: Adobe's reading
/// (`asShotWhiteAdobe`) when the working copy carries it, else stage 1's
/// own (`asShotWhite`), and only with both its temperature and tint (the
/// other one is on another scale). Otherwise a chromatic adaptation from
/// the same as-shot white's chromaticity approximates it.
fn raw_white_balance(
    as_shot_white: &AsShotWhite,
    as_shot_white_adobe: Option<&AsShotWhite>,
    table: Option<&WhiteBalanceTable>,
    s: &DevelopSettings,
) -> Option<RawWhiteBalance> {
    if s.white_balance.mode != WhiteBalanceMode::Absolute {
        return None;
    }
    let target = (s.white_balance.temperature?, s.white_balance.tint?);
    let as_shot = as_shot_white_adobe.unwrap_or(as_shot_white);
    let exact = table.and_then(|table| {
        table.working_copy_transfer((as_shot.temperature?, as_shot.tint?), target)
    });
    Some(match exact {
        Some(m) => RawWhiteBalance {
            matrix: to_f32(&m),
            approximate: false,
        },
        None => RawWhiteBalance {
            matrix: to_f32(&raw_white_balance_prophoto(
                Xy {
                    x: as_shot.x,
                    y: as_shot.y,
                },
                xy_from_temperature(target.0, target.1),
            )),
            approximate: true,
        },
    })
}

pub(crate) fn prepare_niho3(
    image: &LinearImage,
    meta: &WorkingCopyMeta,
    settings: &DevelopSettings,
    target: Option<crate::niho3::PreparationTarget>,
    cached_analysis: Option<crate::niho3::AnalysisCache>,
) -> Result<crate::niho3::Prepared, crate::niho3::PrepareError> {
    let white_balance = match meta {
        WorkingCopyMeta::Raw {
            as_shot_white,
            as_shot_white_adobe,
            white_balance_table,
            ..
        } => raw_white_balance(
            as_shot_white,
            as_shot_white_adobe.as_ref(),
            white_balance_table.as_deref(),
            settings,
        ),
        WorkingCopyMeta::Raster { .. } => None,
    };
    crate::niho3::prepare(
        image,
        meta,
        settings,
        white_balance.map(|value| value.matrix),
        white_balance.is_some_and(|value| value.approximate),
        target,
        cached_analysis,
    )
}

pub(crate) fn niho3_preparation_key(
    meta: &WorkingCopyMeta,
    settings: &DevelopSettings,
    target: Option<crate::niho3::PreparationTarget>,
) -> String {
    let white_balance = match meta {
        WorkingCopyMeta::Raw {
            as_shot_white,
            as_shot_white_adobe,
            white_balance_table,
            ..
        } => raw_white_balance(
            as_shot_white,
            as_shot_white_adobe.as_ref(),
            white_balance_table.as_deref(),
            settings,
        )
        .map(|value| value.matrix),
        WorkingCopyMeta::Raster { .. } => None,
    };
    crate::niho3::preparation_key(meta, settings, white_balance, target)
}

pub(crate) fn prepare_niho4(
    image: &LinearImage,
    meta: &WorkingCopyMeta,
    settings: &DevelopSettings,
    target: Option<crate::niho4::PreparationTarget>,
    cached_analysis: Option<crate::niho4::AnalysisCache>,
) -> Result<crate::niho4::Prepared, crate::niho4::PrepareError> {
    let white_balance = match meta {
        WorkingCopyMeta::Raw {
            as_shot_white,
            as_shot_white_adobe,
            white_balance_table,
            ..
        } => raw_white_balance(
            as_shot_white,
            as_shot_white_adobe.as_ref(),
            white_balance_table.as_deref(),
            settings,
        ),
        WorkingCopyMeta::Raster { .. } => None,
    };
    crate::niho4::prepare(
        image,
        meta,
        settings,
        white_balance.map(|value| value.matrix),
        white_balance.is_some_and(|value| value.approximate),
        target,
        cached_analysis,
    )
}

pub(crate) fn niho4_preparation_key(
    meta: &WorkingCopyMeta,
    settings: &DevelopSettings,
    target: Option<crate::niho4::PreparationTarget>,
) -> Result<String, crate::niho4::PrepareError> {
    let camera = crate::niho4::camera(meta).ok_or(crate::niho4::PrepareError::UnsupportedCamera)?;
    let white_balance = match meta {
        WorkingCopyMeta::Raw {
            as_shot_white,
            as_shot_white_adobe,
            white_balance_table,
            ..
        } => raw_white_balance(
            as_shot_white,
            as_shot_white_adobe.as_ref(),
            white_balance_table.as_deref(),
            settings,
        )
        .map(|value| value.matrix),
        WorkingCopyMeta::Raster { .. } => None,
    };
    Ok(crate::niho4::preparation_key(
        camera,
        meta,
        settings,
        white_balance,
        target,
    ))
}

#[allow(clippy::too_many_arguments)]
fn render_raw(
    img: &LinearImage,
    framing: Option<&Framing<'_>>,
    baseline_ev: f64,
    white_balance: Option<RawWhiteBalance>,
    niho4_camera: Option<crate::niho4_response::Camera>,
    s: &DevelopSettings,
    quality: Quality,
    cubes_cache: Option<&SettingsCubes>,
    local_caches: LocalCaches<'_>,
    effects_cache: &mut EffectsCache,
    color_point_cache: &mut Option<ColorPointPlane>,
    mark_out_of_srgb: bool,
) -> (Rendered, SettingsCubes) {
    let LocalCaches {
        own: local_cache,
        shared: shared_local,
    } = local_caches;
    // `niho-8` / `niho-12` deliberately keep the legacy unsigned-RAW formula.
    // Only their three cubes change precision; signed RAW never reaches this
    // path with them.
    let legacy_formula = legacy_raw_formula(s);
    let formula = legacy_formula.as_ref().unwrap_or(s);
    let mut approximations = vec!["dcpLookTableNotApplied"];
    if white_balance.is_some_and(|wb| wb.approximate) {
        approximations.push("absoluteWhiteBalance");
    }
    if s.color_noise_reduction_detail != 50.0 {
        approximations.push("colorNoiseReductionDetail");
    }
    if s.color_noise_reduction_smoothness != 50.0 {
        approximations.push("colorNoiseReductionSmoothness");
    }
    let white_balance = white_balance.map(|wb| wb.matrix);
    let gain = libm::exp2(baseline_ev + formula.exposure) as f32;
    let expose = move |v: [f32; 3]| raw_head_pixel(v, None, gain);
    // [absolute WB] -> exposure, per pixel (recomputed where needed).
    let head = |px: [f32; 3]| -> [f32; 3] { raw_head_pixel(px, white_balance.as_ref(), gain) };
    let (w, h) = (img.width, img.height);
    let frame = frame_of(img, framing);
    let out = frame.output;
    let fx = effects::prepare(formula, out.width, out.height, effects_cache);
    approximations.extend(&fx.approximations);
    let (vignette, out_fx) = (fx.linear.as_ref(), fx.output.as_ref());

    let spatial_on = needs_spatial(formula);
    let input_key = format!(
        "raw|{w}x{h}|{white_balance:?}|{gain}|{}|{}|{}|{}|{}",
        formula.highlights, formula.shadows, formula.texture, formula.clarity, frame.key
    );
    prepare_local_cache(local_cache, spatial_on, &input_key);
    // Drag frames bake cube P / Q only for the adaptive statistics of a new
    // local pass (their tail evaluates the stages itself).
    let kept_pass = quality == Quality::Interactive
        && local_cache
            .as_ref()
            .is_some_and(|c| c.input_key == input_key);
    let look_tone = raw_look_tone(formula);
    let mut cubes = settings_cubes(
        s,
        0.0,
        quality,
        cubes_cache,
        quality == Quality::Final || (spatial_on && !kept_pass) || s.has_active_color_points(),
        look_tone,
        true,
    );
    let tail = RawTail::new(formula, &cubes, niho4_camera);
    let local_pass = if spatial_on {
        local_pass(
            local_cache,
            shared_local,
            input_key,
            String::new(),
            quality,
            || {
                // round2 set A: statistics of the "preHS" rendering (every
                // setting but H/S/Texture/Clarity, through cube Q) at 750 /
                // 375 px.
                let whole = frame.stats_source;
                let (mut small, sw, sh) = bilinear_downscale_with(
                    &whole.data,
                    whole.width,
                    whole.height,
                    quality.stats_long_edge(),
                    head,
                );
                for px in small.chunks_exact_mut(3) {
                    let v = tail.pixel([px[0], px[1], px[2]]);
                    px.copy_from_slice(&v);
                }
                let stats = spatial::compute_stats(&small, sw, sh, PP_LUMA_F32);
                let (gain_scale, shift) = adaptive_parameters(Some(&stats), AdaptivePath::Raw);
                SpatialParams {
                    highlights: formula.highlights,
                    shadows: formula.shadows,
                    texture: formula.texture,
                    clarity: formula.clarity,
                    scale_px: spatial::scale_px(frame.long_edge as f64),
                    long_edge: frame.long_edge,
                    gain_scale,
                    shift,
                    quality,
                }
            },
            || {
                let mut ln0 = Plane::new(w, h);
                for (dst, px) in ln0.data.iter_mut().zip(img.data.chunks_exact(3)) {
                    *dst = spatial::log_luminance(head([px[0], px[1], px[2]]));
                }
                ln0
            },
        )
    } else {
        None
    };
    let relative = if formula.white_balance.mode == WhiteBalanceMode::Relative {
        relative_matrix(formula.relative_temperature, formula.relative_tint)
    } else {
        None
    };
    let finish = |v: [f32; 3]| -> [f32; 3] {
        let v = mat_vec_f32(&PROPHOTO_TO_SRGB_F32, v);
        match &relative {
            Some(m) => mat_vec_f32(m, v),
            None => v,
        }
    };
    // Drag frames: the ACR3 cube clamps its input, so the whole tail is one
    // cube of the encoded value.
    let local = local_pass.map(|pass| &pass.ratio);
    let preview = (quality == Quality::Interactive && !s.has_active_color_points()).then(|| {
        let post = (needs_post_ops(formula) || look_tone.is_some())
            .then(|| PreparedPostOps::with_exposure(formula, 0.0).with_look(look_tone));
        let color =
            needs_color_ops(formula).then(|| PreparedColorOps::after_default_curve(formula));
        // The RAW black & white mix is part of stage A, before cube P.
        let key_a = format!(
            "raw|{}|{:?}|{}|{}",
            formula.look, niho4_camera, cubes.post_key, cubes.color_key
        );
        let key = format!(
            "{key_a}|{}|{:?}|{:?}",
            cubes.color_key, tail.calibration, relative
        );
        let legacy_acr3 = look_cube(&formula.look);
        let acr3 = cubes.acr3.as_deref().unwrap_or(legacy_acr3);
        let drag = drag_tail(
            cubes.drag.as_ref(),
            key_a,
            key,
            &|e| {
                let mut v = decode(acr3.lookup_encoded(e));
                if let Some(camera) = niho4_camera {
                    v = crate::niho4::pre_profile(camera, v);
                }
                if let Some(q) = &color {
                    v = exact(&|x| q.apply_raw_before_post(x), v);
                }
                match &post {
                    Some(p) => exact(&|x| p.apply(x), v),
                    None => v,
                }
            },
            &|v| {
                // RawTail::pixel_encoded after cube P, with cube Q as its function.
                let mut v = v;
                if let Some(m) = &tail.calibration {
                    v = clamp01(mat_vec_f32(m, v));
                }
                if let Some(q) = &color {
                    v = exact(&|x| q.apply_raw_after_pre_post(x), v);
                }
                let linear = finish(v);
                oetf3(
                    if matches!(
                        s.engine.as_str(),
                        ENGINE_NIHO_3
                            | ENGINE_NIHO_4
                            | ENGINE_NIHO_5
                            | ENGINE_NIHO_7
                            | ENGINE_NIHO_11
                    ) {
                        output_transform_clip(linear)
                    } else {
                        output_transform(linear)
                    },
                )
            },
        );
        cubes.drag = Some(drag.clone());
        drag
    });
    let mut rgba = vec![0u8; out.width * out.height * 4];
    let pixels = OutputPixels {
        src: &img.data,
        src_width: w,
        output: out,
        local,
        vignette,
    };
    // One monomorphized loop per (white balance, output) pair.
    macro_rules! fill {
        ($emit:expr) => {
            match &white_balance {
                Some(m) => fill_rgba(&mut rgba, pixels, |px| expose(mat_vec_f32(m, px)), $emit),
                None => fill_rgba(&mut rgba, pixels, expose, $emit),
            }
        };
    }
    let final_sharpening = (quality == Quality::Final)
        .then(|| s.detail.map(|detail| detail.sharpening))
        .flatten()
        .filter(|sharpening| sharpening.amount > 0.0);
    if let Some(sharpening) = final_sharpening {
        let mut linear = match &white_balance {
            Some(matrix) => collect_working_float_plane(
                &img.data,
                w,
                h,
                out,
                s.has_active_color_points(),
                local,
                vignette,
                |pixel| expose(mat_vec_f32(matrix, pixel)),
                |value| finish(tail.float_boundary_pixel(value)),
            ),
            None => collect_working_float_plane(
                &img.data,
                w,
                h,
                out,
                s.has_active_color_points(),
                local,
                vignette,
                expose,
                |value| finish(tail.float_boundary_pixel(value)),
            ),
        };
        if s.has_active_color_points() {
            let key = format!(
                "{}|local={:?}",
                color_point_plane_key("raw", img, frame, quality, s),
                local_pass.map(|pass| &pass.params_key)
            );
            let plane = match &white_balance {
                Some(matrix) => cached_color_point_plane(
                    color_point_cache,
                    key,
                    out.width,
                    out.height,
                    pixels,
                    |pixel| expose(mat_vec_f32(matrix, pixel)),
                    |value| tail.before_color_points(value),
                ),
                None => cached_color_point_plane(
                    color_point_cache,
                    key,
                    out.width,
                    out.height,
                    pixels,
                    expose,
                    |value| tail.before_color_points(value),
                ),
            };
            replace_output_region(
                &mut linear,
                out,
                plane
                    .pixels
                    .iter()
                    .copied()
                    .map(|pixel| finish(tail.cached_point_pixel(pixel))),
            );
        } else {
            *color_point_cache = None;
        }
        let legacy = matches!(
            s.engine.as_str(),
            ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
        );
        let encoder = legacy.then(crate::fastmath::niho3_srgb8);
        let encoding = encoder.map_or(FloatEncoding::Standard { transform: true }, |encoder| {
            FloatEncoding::Niho3(encoder)
        });
        rgba = finalize_float_plane(
            linear,
            out,
            frame.long_edge,
            Some(sharpening),
            encoding,
            out_fx,
            mark_out_of_srgb,
        );
    } else if s.has_active_color_points() {
        let key = format!(
            "{}|local={:?}",
            color_point_plane_key("raw", img, frame, quality, s),
            local_pass.map(|pass| &pass.params_key)
        );
        let plane = match &white_balance {
            Some(m) => cached_color_point_plane(
                color_point_cache,
                key,
                out.width,
                out.height,
                pixels,
                |px| expose(mat_vec_f32(m, px)),
                |value| tail.before_color_points(value),
            ),
            None => cached_color_point_plane(
                color_point_cache,
                key,
                out.width,
                out.height,
                pixels,
                expose,
                |value| tail.before_color_points(value),
            ),
        };
        let legacy = matches!(
            s.engine.as_str(),
            ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
        );
        let encoder = legacy.then(crate::fastmath::niho3_srgb8);
        for (i, pixel) in plane.pixels.iter().copied().enumerate() {
            let output = finish(tail.cached_point_pixel(pixel));
            let out = &mut rgba[i * 4..i * 4 + 4];
            match (encoder, out_fx) {
                (Some(encoder), None) => write_niho3_output_rgba(out, output, encoder),
                (Some(_), Some(fx)) => write_niho3_output_rgba_fx(out, output, fx, i),
                (None, _) => {
                    write_rgba_fx(out, output, true, out_fx, i);
                    if mark_out_of_srgb && (output[0] < 0.0 || output[1] < 0.0 || output[2] < 0.0) {
                        out[3] = 0;
                    }
                }
            }
        }
    } else {
        *color_point_cache = None;
        match &preview {
            Some(drag) => fill!(|out: &mut [u8], v: [f32; 3], i: usize| {
                write_encoded_fx(out, drag.lookup(v), out_fx, i)
            }),
            None if matches!(
                s.engine.as_str(),
                ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
            ) && out_fx.is_none() =>
            {
                let encoder = crate::fastmath::niho3_srgb8();
                fill!(|out: &mut [u8], v: [f32; 3], _i: usize| {
                    write_niho3_output_rgba(out, finish(tail.pixel(v)), encoder)
                })
            }
            None if matches!(
                s.engine.as_str(),
                ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
            ) =>
            {
                let fx = out_fx.expect("NIHO 3 output effects");
                fill!(|out: &mut [u8], v: [f32; 3], i: usize| {
                    write_niho3_output_rgba_fx(out, finish(tail.pixel(v)), fx, i)
                })
            }
            None if mark_out_of_srgb => fill!(|out: &mut [u8], v: [f32; 3], i: usize| {
                let p = finish(tail.pixel(v));
                write_rgba_fx(out, p, true, out_fx, i);
                if p[0] < 0.0 || p[1] < 0.0 || p[2] < 0.0 {
                    out[3] = 0;
                }
            }),
            None => fill!(|out: &mut [u8], v: [f32; 3], i: usize| {
                write_rgba_fx(out, finish(tail.pixel(v)), true, out_fx, i)
            }),
        }
    }
    (
        Rendered {
            width: out.width,
            height: out.height,
            rgba,
            approximations,
        },
        cubes,
    )
}

/// Pointwise-only evaluation of the non-RAW chain (tests / tools).
pub fn raster_pointwise(v: [f64; 3], s: &DevelopSettings) -> [f64; 3] {
    let mut v = v;
    if s.exposure != 0.0 {
        v = exposure_non_raw(v, s.exposure);
    }
    v = crate::tone_ops::apply_post_ops(v, s);
    if needs_calibration(&s.calibration) {
        v = color_ops::calibration(v, &s.calibration);
    }
    PreparedColorOps::new(s).apply(v)
}

#[derive(Clone, Copy)]
pub(crate) struct ColorSampleLocation {
    pub working_index: usize,
    pub output_size: (usize, usize),
    pub output_index: usize,
}

#[derive(Clone, Copy)]
pub(crate) struct ColorSampleStages<'a> {
    pub cubes: Option<&'a SettingsCubes>,
    pub local: Option<&'a LocalPass>,
    pub color_points: Option<&'a ColorPointPlane>,
}

/// Samples the normal raster path at Stage Q immediately before independent
/// color points and Color Grading. `index` addresses the same working image
/// and local-pass plane used by the preceding Session render.
pub(crate) fn sample_raster_before_color_points(
    px: [f32; 3],
    location: ColorSampleLocation,
    input_is_prophoto: bool,
    s: &DevelopSettings,
    stages: ColorSampleStages<'_>,
    effects_cache: &mut EffectsCache,
) -> [f64; 3] {
    let ColorSampleStages {
        cubes,
        local,
        color_points,
    } = stages;
    let ColorSampleLocation {
        working_index: index,
        output_size,
        output_index,
    } = location;
    if let Some(sample) = color_points.and_then(|plane| plane.sample(output_index)) {
        return sample;
    }
    let input = if input_is_prophoto {
        Some(&PROPHOTO_TO_SRGB_F32)
    } else {
        None
    };
    let relative = if uses_relative_matrix_on_raster(&s.engine)
        && s.white_balance.mode == WhiteBalanceMode::Relative
    {
        relative_matrix(s.relative_temperature, s.relative_tint)
    } else {
        None
    };
    let stage_p = s.exposure != 0.0 || needs_post_ops(s) || needs_spatial(s);
    let mut v = raster_head_pixel(px, input, relative.as_ref(), stage_p);
    let effects = effects::prepare(s, output_size.0, output_size.1, effects_cache);
    v = linear_spatial_pixel(
        v,
        local.and_then(|pass| pass.ratio.data.get(index)).copied(),
        effects.linear.as_ref().and_then(|vignette| {
            vignette
                .radius()
                .get(output_index)
                .map(|rho| (vignette, *rho))
        }),
    );
    let color = needs_pre_color_ops(s, false).then(|| {
        cubes
            .and_then(|value| {
                if s.has_active_color_points() {
                    value.color.clone()
                } else {
                    None
                }
            })
            .unwrap_or_else(|| Arc::new(bake_pre_color_cube_for(s, CUBE_DIMENSION, false)))
    });
    let tail = RasterTail {
        post: cubes.and_then(|value| value.post.clone()),
        stage_p,
        calibration: needs_calibration(&s.calibration)
            .then(|| to_f32(&calibration_matrix(&s.calibration))),
        color,
        point_tail: None,
        output_transform: false,
    };
    color_ops::cached_prophoto_to_oklch(tail.before_color_points(v)).map(f64::from)
}

pub(crate) fn sample_raw_before_color_points(
    px: [f32; 3],
    location: ColorSampleLocation,
    meta: &WorkingCopyMeta,
    s: &DevelopSettings,
    stages: ColorSampleStages<'_>,
    effects_cache: &mut EffectsCache,
) -> [f64; 3] {
    let ColorSampleStages {
        cubes,
        local,
        color_points,
    } = stages;
    let ColorSampleLocation {
        working_index: index,
        output_size,
        output_index,
    } = location;
    if let Some(sample) = color_points.and_then(|plane| plane.sample(output_index)) {
        return sample;
    }
    // Sample the formula `render_raw` draws (`niho-2` for the float-cube
    // engines' legacy RAW path).
    let legacy_formula = legacy_raw_formula(s);
    let s = legacy_formula.as_ref().unwrap_or(s);
    let WorkingCopyMeta::Raw {
        baseline_ev,
        as_shot_white,
        as_shot_white_adobe,
        white_balance_table,
        dcp_sha256,
        ..
    } = meta
    else {
        return [f64::NAN; 3];
    };
    let white_balance = raw_white_balance(
        as_shot_white,
        as_shot_white_adobe.as_ref(),
        white_balance_table.as_deref(),
        s,
    );
    let gain = libm::exp2(*baseline_ev + s.exposure) as f32;
    let mut v = raw_head_pixel(px, white_balance.as_ref().map(|value| &value.matrix), gain);
    let effects = effects::prepare(s, output_size.0, output_size.1, effects_cache);
    v = linear_spatial_pixel(
        v,
        local.and_then(|pass| pass.ratio.data.get(index)).copied(),
        effects.linear.as_ref().and_then(|vignette| {
            vignette
                .radius()
                .get(output_index)
                .map(|rho| (vignette, *rho))
        }),
    );
    let niho4_camera = if matches!(
        s.engine.as_str(),
        ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
    ) {
        crate::niho4_response::Camera::from_calibration(dcp_sha256)
    } else {
        None
    };
    let color = needs_pre_color_ops(s, true).then(|| {
        cubes
            .and_then(|value| {
                if s.has_active_color_points() {
                    value.color.clone()
                } else {
                    None
                }
            })
            .unwrap_or_else(|| Arc::new(bake_pre_color_cube_for(s, CUBE_DIMENSION, true)))
    });
    let tail = RawTail {
        legacy_acr3: look_cube(&s.look),
        candidate_acr3: cubes.and_then(|value| value.acr3.clone()),
        niho4_camera,
        post: cubes.and_then(|value| value.post.clone()),
        calibration: needs_calibration(&s.calibration)
            .then(|| to_f32(&calibration_matrix(&s.calibration))),
        color_ops: needs_color_ops(s).then(|| PreparedColorOps::after_default_curve(s)),
        color,
        point_tail: None,
    };
    color_ops::cached_prophoto_to_oklch(tail.before_color_points(v)).map(f64::from)
}

#[cfg(test)]
mod color_point_cache_tests {
    use super::*;
    use crate::decode::LinearImage;
    use crate::settings::{
        ColorPoint, HslAdjustment, HslBand, OklchDelta, OklchRange, OklchTarget,
    };

    fn active_settings() -> DevelopSettings {
        let mut settings = DevelopSettings::neutral();
        settings.v = 4;
        settings.engine = ENGINE_NIHO_10.into();
        settings.color_points = vec![ColorPoint {
            id: "cache".into(),
            target: OklchTarget {
                lightness: 0.65,
                chroma: 0.1,
                hue: 45.0,
            },
            range: OklchRange {
                hue: 20.0,
                chroma: 0.05,
                lightness: 0.1,
            },
            delta: OklchDelta {
                hue: 8.0,
                chroma_scale: 1.1,
                lightness: 0.01,
            },
        }];
        settings
    }

    fn image(seed: f32) -> LinearImage {
        LinearImage {
            width: 4,
            height: 3,
            data: vec![seed; 4 * 3 * 3],
        }
    }

    #[test]
    fn plane_key_reuses_only_point_and_grading_changes() {
        let first_image = image(0.25);
        let second_image = image(0.25);
        let frame = frame_of(&first_image, None);
        let settings = active_settings();
        let base = color_point_plane_key("raster", &first_image, frame, Quality::Final, &settings);

        let mut point = settings.clone();
        point.color_points[0].delta.hue = -15.0;
        assert_eq!(
            base,
            color_point_plane_key("raster", &first_image, frame, Quality::Final, &point)
        );
        let mut grading = point;
        grading.color_grading.global.hue = 210.0;
        grading.color_grading.global.saturation = 90.0;
        assert_eq!(
            base,
            color_point_plane_key("raster", &first_image, frame, Quality::Final, &grading)
        );

        let mut changes = Vec::new();
        let mut changed = settings.clone();
        changed.exposure = 0.2;
        changes.push(("global tone", changed));
        let mut changed = settings.clone();
        changed.saturation = 1.0;
        changes.push(("saturation", changed));
        let mut changed = settings.clone();
        changed.hsl.set(
            HslBand::Orange,
            HslAdjustment {
                hue: 1.0,
                ..Default::default()
            },
        );
        changes.push(("hsl", changed));
        let mut changed = settings.clone();
        changed.calibration.red_hue = 1.0;
        changes.push(("calibration", changed));
        let mut changed = settings.clone();
        changed.highlights = -1.0;
        changes.push(("spatial", changed));
        let mut changed = settings.clone();
        changed.vignette.amount = -1.0;
        changes.push(("vignette", changed));
        let mut changed = settings.clone();
        changed.base = Some("another-raw-base".into());
        changes.push(("raw base", changed));
        for (label, changed) in changes {
            assert_ne!(
                base,
                color_point_plane_key("raster", &first_image, frame, Quality::Final, &changed),
                "{label}"
            );
        }

        assert_ne!(
            base,
            color_point_plane_key(
                "raster",
                &first_image,
                frame,
                Quality::Interactive,
                &settings
            ),
            "quality"
        );
        assert_ne!(
            base,
            color_point_plane_key(
                "raster",
                &second_image,
                frame_of(&second_image, None),
                Quality::Final,
                &settings
            ),
            "source"
        );
        assert_ne!(
            base,
            color_point_plane_key("raw", &first_image, frame, Quality::Final, &settings),
            "source kind"
        );
        let cropped = Framing {
            stats_source: &first_image,
            long_edge: 4,
            output: Rect {
                x: 1,
                y: 0,
                width: 3,
                height: 3,
            },
            key: "crop",
        };
        assert_ne!(
            base,
            color_point_plane_key("raster", &first_image, cropped, Quality::Final, &settings),
            "geometry/dimension"
        );
    }
}

#[cfg(test)]
mod local_pass_tests {
    use super::*;

    fn params(quality: Quality) -> SpatialParams {
        let (gain_scale, shift) = adaptive_parameters(None, AdaptivePath::NonRaw);
        SpatialParams {
            highlights: -40.0,
            shadows: 0.0,
            texture: 0.0,
            clarity: 20.0,
            scale_px: spatial::scale_px(32.0),
            long_edge: 32,
            gain_scale,
            shift,
            quality,
        }
    }

    /// Whether `local_pass` computed a new pass (else it reused the kept one).
    fn computes(cache: &mut Option<LocalPass>, source_key: &str, quality: Quality) -> bool {
        let mut computed = false;
        local_pass(
            cache,
            None,
            "input".into(),
            source_key.into(),
            quality,
            || params(quality),
            || {
                computed = true;
                let mut plane = Plane::new(32, 24);
                for (i, v) in plane.data.iter_mut().enumerate() {
                    *v = (i % 7) as f32 * 0.1 - 2.0;
                }
                plane
            },
        )
        .expect("pass");
        computed
    }

    #[test]
    fn released_frames_take_a_pass_of_the_same_source_only() {
        let mut cache = None;
        assert!(computes(&mut cache, "30/0", Quality::Final));
        assert!(!computes(&mut cache, "30/0", Quality::Final));
        // A drag of niho-13's white balance keeps the pass of the frame before.
        assert!(!computes(&mut cache, "36/0", Quality::Interactive));
        // Its release never takes a pass of another balance, even with the
        // same adaptive parameters.
        assert!(computes(&mut cache, "36/0", Quality::Final));
        assert!(!computes(&mut cache, "36/0", Quality::Final));
    }
}

#[cfg(test)]
mod released_cube_tests {
    use super::*;

    #[test]
    fn a_release_after_drag_frames_takes_back_the_released_cubes() {
        let mut s = DevelopSettings::neutral();
        s.engine = crate::settings::ENGINE_NIHO_13.into();
        s.look = crate::look::LOOK_NIHO_STANDARD_1.into();
        s.contrast = 20.0;
        s.vibrance = 15.0;
        let released = settings_cubes(&s, 0.3, Quality::Final, None, true, None, false);
        let post = released.post.clone().expect("cube P");
        let color = released.color.clone().expect("cube Q");
        // Drag frames of a slider outside the cubes (the drag grid's keys).
        let mut cache = released;
        for _ in 0..3 {
            cache = settings_cubes(
                &s,
                0.3,
                Quality::Interactive,
                Some(&cache),
                false,
                None,
                false,
            );
            assert!(cache.post.is_none());
        }
        let again = settings_cubes(&s, 0.3, Quality::Final, Some(&cache), true, None, false);
        assert!(Arc::ptr_eq(again.post.as_ref().unwrap(), &post));
        assert!(Arc::ptr_eq(again.color.as_ref().unwrap(), &color));
        // A drag that changed cube P bakes it again on release; cube Q stays.
        s.contrast = 25.0;
        let dragged = settings_cubes(
            &s,
            0.3,
            Quality::Interactive,
            Some(&again),
            false,
            None,
            false,
        );
        let changed = settings_cubes(&s, 0.3, Quality::Final, Some(&dragged), true, None, false);
        assert!(!Arc::ptr_eq(changed.post.as_ref().unwrap(), &post));
        assert!(Arc::ptr_eq(changed.color.as_ref().unwrap(), &color));
        assert!(changed.released.is_none());
    }
}
