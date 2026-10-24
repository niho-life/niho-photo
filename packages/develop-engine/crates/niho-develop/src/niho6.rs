//! `niho-6` raster preparation (#18397, `NIHO6.md`): the JPEG / PNG
//! original (or raster working copy) with Highlights (<= 0) and Shadows
//! (>= 0) from the JPEG-trained response ([`crate::niho6_response`]). The
//! rest of the frame is the `niho-2` raster formula on the prepared image
//! (`pipeline::render_linear` leaves those two directions to this module).
//!
//! - Analysis: the whole photo (not a crop, preview or thumbnail) reduced
//!   to a 750px long edge by area averaging in linear sRGB, then linear
//!   ProPhoto. Its coefficient maps do not depend on the amounts.
//! - Gain: `gH`, `gS` (EV) at the analysis size, resized bilinearly to the
//!   prepared image. Per pixel, with `Y` the ProPhoto luminance,
//!   `out = rgb·G + (rgb − Y)·(C − G)`, `G = 2^(gH + gS)`,
//!   `C = 2^(αH·gH + αS·gS)` (the chroma follows its own exponents of the
//!   luminance gain, as in Lightroom's JPEG exports).

use crate::color::{PP_LUMA, SRGB_TO_PROPHOTO, SRGB_TO_PROPHOTO_F32};
use crate::decode::LinearImage;
use crate::niho6_response::{self, CoefficientMaps, ResponseError};
use crate::resize::{self, Filter};
use crate::settings::DevelopSettings;
use std::fmt;
use std::sync::OnceLock;

pub const ANALYSIS_LONG_EDGE: usize = 750;

/// Share of Highlights (<= 0) / Shadows (>= 0) the `niho-2` local pass keeps
/// (R24 in `NIHO6.md`): the learned gain applies `1 - LEGACY_SHARE` of its
/// response and the legacy local pass `LEGACY_SHARE` of the amounts. The two
/// err on different photos, so the mix halves the regressions against
/// `niho-2` on unseen capture dates.
pub const LEGACY_SHARE: f64 = 0.5;

/// Engines that use the frozen `niho-6` formula on raster sources. `niho-8`
/// changes cube entry precision, `niho-10` adds hue-stable saturation,
/// `niho-12` is `niho-10` with float cubes and `niho-13` is `niho-12` with
/// the relative white balance applied to the source (the analysis reads the
/// balanced source); all deliberately reuse this response. `niho-14` is
/// `niho-13` with a lighter analysis of the same response
/// ([`AnalysisKind::Light`]).
pub fn uses_raster_formula(settings: &DevelopSettings) -> bool {
    matches!(
        settings.engine.as_str(),
        crate::settings::ENGINE_NIHO_6
            | crate::settings::ENGINE_NIHO_8
            | crate::settings::ENGINE_NIHO_10
            | crate::settings::ENGINE_NIHO_12
            | crate::settings::ENGINE_NIHO_13
            | crate::settings::ENGINE_NIHO_14
    )
}

/// How the response's analysis (features and networks) is computed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AnalysisKind {
    /// `niho-6`〜`niho-13`: the frozen features and `f64` networks
    /// ([`niho6_response`]).
    Frozen,
    /// `niho-14`: the same response with the large local levels on reduced
    /// planes and `f32` SIMD networks ([`crate::niho14_analysis`]).
    Light,
}

impl AnalysisKind {
    /// Part of the cache keys of what an analysis makes.
    pub fn key(self) -> &'static str {
        match self {
            Self::Frozen => "frozen",
            Self::Light => "light",
        }
    }
}

/// The analysis `settings`' engine uses.
pub fn analysis_kind(settings: &DevelopSettings) -> AnalysisKind {
    if settings.engine == crate::settings::ENGINE_NIHO_14 {
        AnalysisKind::Light
    } else {
        AnalysisKind::Frozen
    }
}

/// What a source's pixels are: decoded JPEG / PNG originals are extended
/// linear sRGB, raster working copies linear ProPhoto.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceSpace {
    LinearSrgb,
    LinearProPhoto,
}

#[derive(Debug)]
pub enum PrepareError {
    Response(ResponseError),
    NonFinite(&'static str),
}

impl fmt::Display for PrepareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Response(e) => write!(f, "H/S response: {e}"),
            Self::NonFinite(stage) => write!(f, "non-finite value during {stage}"),
        }
    }
}

impl std::error::Error for PrepareError {}

/// The response's coefficient maps of one photo, and the size of the
/// source they were made from (a session made from the same source reuses
/// them, whatever its own working size).
#[derive(Debug)]
pub struct Analysis {
    pub maps: CoefficientMaps,
    /// The exposure the analysis was made at ([`analysis_exposure`]).
    pub exposure_ev: f64,
    /// How it was made.
    pub kind: AnalysisKind,
    pub source_width: usize,
    pub source_height: usize,
}

/// Whether these settings use the response (otherwise `niho-6` renders
/// exactly as `niho-2`).
pub fn uses_response(settings: &DevelopSettings) -> bool {
    settings.highlights < 0.0 || settings.shadows > 0.0
}

/// The analysis size of a `width x height` source (as NIHO 3's).
pub fn analysis_size(width: usize, height: usize) -> (usize, usize) {
    if width >= height {
        (
            ANALYSIS_LONG_EDGE.min(width),
            ((height as f64 * ANALYSIS_LONG_EDGE as f64 / width as f64).round() as usize)
                .max(1)
                .min(height),
        )
    } else {
        (
            ((width as f64 * ANALYSIS_LONG_EDGE as f64 / height as f64).round() as usize)
                .max(1)
                .min(width),
            ANALYSIS_LONG_EDGE.min(height),
        )
    }
}

/// The analysis image of a whole source: area average to
/// [`analysis_size`] in the source's space, then linear ProPhoto.
pub fn analysis_image(source: &LinearImage, space: SourceSpace) -> LinearImage {
    let (w, h) = (source.width, source.height);
    let (aw, ah) = analysis_size(w, h);
    let mut data = resize::resample(&source.data, w, h, aw, ah, Filter::Area);
    if space == SourceSpace::LinearSrgb {
        for px in data.chunks_exact_mut(3) {
            let v = crate::color::mat_vec_f32(&SRGB_TO_PROPHOTO_F32, [px[0], px[1], px[2]]);
            px.copy_from_slice(&v);
        }
    }
    LinearImage {
        width: aw,
        height: ah,
        data,
    }
}

/// The exposure (EV) the response sees for `settings`: Lightroom decides
/// Highlights / Shadows on the exposed photo (R20 in `NIHO6.md`), so the
/// features are those of the analysis image scaled by `2^exposure`.
pub fn analysis_exposure(settings: &DevelopSettings) -> f64 {
    if settings.exposure.is_finite() {
        settings.exposure
    } else {
        0.0
    }
}

/// The features of a whole source's analysis image (once per photo; the
/// exposure only moves two of them, [`analysis_at`]).
pub fn source_features(
    source: &LinearImage,
    space: SourceSpace,
) -> Result<SourceFeatures, PrepareError> {
    source_features_of(source, space, AnalysisKind::Frozen)
}

/// [`source_features`] made the `kind` way.
pub fn source_features_of(
    source: &LinearImage,
    space: SourceSpace,
    kind: AnalysisKind,
) -> Result<SourceFeatures, PrepareError> {
    let small = analysis_image(source, space);
    let features = match kind {
        AnalysisKind::Frozen => niho6_response::features(&small.data, small.width, small.height),
        AnalysisKind::Light => {
            crate::niho14_analysis::features(&small.data, small.width, small.height)
        }
    }
    .map_err(PrepareError::Response)?;
    Ok(SourceFeatures {
        features,
        kind,
        source_width: source.width,
        source_height: source.height,
    })
}

/// [`source_features`] and the size of the source they were made from.
#[derive(Debug)]
pub struct SourceFeatures {
    pub features: niho6_response::Features,
    /// How they were made (their networks are the same kind's).
    pub kind: AnalysisKind,
    pub source_width: usize,
    pub source_height: usize,
}

/// The analysis of a source's features as seen at `exposure_ev`.
pub fn analysis_at(features: &SourceFeatures, exposure_ev: f64) -> Result<Analysis, PrepareError> {
    let maps = match features.kind {
        AnalysisKind::Frozen => {
            niho6_response::coefficient_maps_at(&features.features, exposure_ev)
        }
        AnalysisKind::Light => {
            crate::niho14_analysis::coefficient_maps_at(&features.features, exposure_ev)
        }
    }
    .map_err(PrepareError::Response)?;
    Ok(Analysis {
        maps,
        exposure_ev,
        kind: features.kind,
        source_width: features.source_width,
        source_height: features.source_height,
    })
}

/// The analysis of a whole source as seen at `exposure_ev`.
pub fn analysis(
    source: &LinearImage,
    space: SourceSpace,
    exposure_ev: f64,
) -> Result<Analysis, PrepareError> {
    analysis_of(source, space, exposure_ev, AnalysisKind::Frozen)
}

/// [`analysis`] made the `kind` way.
pub fn analysis_of(
    source: &LinearImage,
    space: SourceSpace,
    exposure_ev: f64,
    kind: AnalysisKind,
) -> Result<Analysis, PrepareError> {
    analysis_at(&source_features_of(source, space, kind)?, exposure_ev)
}

/// ProPhoto luminance of a value in `space` (`PP_LUMA`, and for linear sRGB
/// `PP_LUMA · SRGB_TO_PROPHOTO`; both spaces keep the same white, so
/// `rgb − Y` is the same color difference).
fn luminance_weights(space: SourceSpace) -> [f32; 3] {
    static SRGB: OnceLock<[f32; 3]> = OnceLock::new();
    match space {
        SourceSpace::LinearProPhoto => PP_LUMA.map(|v| v as f32),
        SourceSpace::LinearSrgb => *SRGB.get_or_init(|| {
            let mut w = [0.0f64; 3];
            for (j, slot) in w.iter_mut().enumerate() {
                *slot = (0..3).map(|i| PP_LUMA[i] * SRGB_TO_PROPHOTO[i][j]).sum();
            }
            w.map(|v| v as f32)
        }),
    }
}

/// The cache key of an image prepared from a `width x height` source for
/// `settings` with an analysis made at `analysis_exposure_ev` (only the
/// amounts the response uses, its preprocessed source, and that exposure
/// change it).
pub fn preparation_key(
    width: usize,
    height: usize,
    settings: &DevelopSettings,
    analysis_exposure_ev: f64,
) -> String {
    let detail = settings.detail.map_or_else(
        || "none".to_string(),
        |detail| {
            format!(
                "{}|{:?}",
                detail.luminance_noise_reduction, detail.color_noise_reduction
            )
        },
    );
    // The frozen analysis keeps its key as it was.
    let kind = match analysis_kind(settings) {
        AnalysisKind::Frozen => String::new(),
        kind => format!("|{}", kind.key()),
    };
    format!(
        "niho6{kind}|{width}x{height}|{detail}|{}|{}|{analysis_exposure_ev}",
        settings.highlights.min(0.0),
        settings.shadows.max(0.0),
    )
}

/// `image` (in `space`; the whole photo or its reduction) with the
/// response's Highlights and Shadows of `settings` applied.
pub fn apply(
    image: &LinearImage,
    space: SourceSpace,
    analysis: &Analysis,
    settings: &DevelopSettings,
) -> Result<LinearImage, PrepareError> {
    apply_gains(
        image,
        space,
        &response_gains(image.width, image.height, analysis, settings)?,
    )
}

/// The per-pixel gains [`apply`] multiplies a `width x height` image by:
/// the luminance gain `G` and the chroma gain `C` of the module docs. They
/// depend on the analysis, the amounts and the size only, not on the pixels
/// (a Session keeps them while `niho-13`'s white balance is dragged).
pub struct ResponseGains {
    width: usize,
    height: usize,
    gains: Vec<[f32; 2]>,
}

/// [`ResponseGains`] of `analysis` and the amounts of `settings`.
pub fn response_gains(
    width: usize,
    height: usize,
    analysis: &Analysis,
    settings: &DevelopSettings,
) -> Result<ResponseGains, PrepareError> {
    let maps = &analysis.maps;
    let (highlight, shadow) = niho6_response::gains(
        maps,
        settings.highlights.min(0.0),
        settings.shadows.max(0.0),
    )
    .map_err(PrepareError::Response)?;
    let models = niho6_response::models().map_err(PrepareError::Response)?;
    let (alpha_h, alpha_s) = (models.highlight_chroma_alpha, models.shadow_chroma_alpha);
    let share = (1.0 - LEGACY_SHARE) as f32;
    let highlight: Vec<f32> = highlight.iter().map(|g| g * share).collect();
    let shadow: Vec<f32> = shadow.iter().map(|g| g * share).collect();
    let highlight = resize_plane_bilinear(&highlight, maps.width, maps.height, width, height);
    let shadow = resize_plane_bilinear(&shadow, maps.width, maps.height, width, height);
    let gains = highlight
        .into_iter()
        .zip(shadow)
        .map(|(gh, gs)| {
            [
                libm::exp2f(gh + gs),
                libm::exp2f(alpha_h * gh + alpha_s * gs),
            ]
        })
        .collect();
    Ok(ResponseGains {
        width,
        height,
        gains,
    })
}

/// `image` (in `space`, of the gains' size) with the response applied.
pub fn apply_gains(
    image: &LinearImage,
    space: SourceSpace,
    gains: &ResponseGains,
) -> Result<LinearImage, PrepareError> {
    let (w, h) = (image.width, image.height);
    assert_eq!((w, h), (gains.width, gains.height), "gains of another size");
    let luma = luminance_weights(space);
    let mut data = image.data.clone();
    for (px, [g, c]) in data.chunks_exact_mut(3).zip(gains.gains.iter().copied()) {
        let y = px[0] * luma[0] + px[1] * luma[1] + px[2] * luma[2];
        for v in px.iter_mut() {
            *v = *v * g + (*v - y) * (c - g);
        }
    }
    if data.iter().any(|v| !v.is_finite()) {
        return Err(PrepareError::NonFinite("niho-6 preparation"));
    }
    Ok(LinearImage {
        width: w,
        height: h,
        data,
    })
}

/// Bilinear resize of a plane with pixel centers aligned (NIHO 3's).
pub(crate) fn resize_plane_bilinear(
    source: &[f32],
    in_width: usize,
    in_height: usize,
    out_width: usize,
    out_height: usize,
) -> Vec<f32> {
    let mut output = vec![0.0; out_width * out_height];
    let scale_x = in_width as f64 / out_width as f64;
    let scale_y = in_height as f64 / out_height as f64;
    // The column positions are the same on every row (computed once, the
    // same values).
    let columns: Vec<(usize, usize, f32)> = (0..out_width)
        .map(|x| {
            let sx = ((x as f64 + 0.5) * scale_x - 0.5).clamp(0.0, (in_width - 1) as f64);
            let x0 = libm::floor(sx) as usize;
            let x1 = (x0 + 1).min(in_width - 1);
            (x0, x1, (sx - x0 as f64) as f32)
        })
        .collect();
    for y in 0..out_height {
        let sy = ((y as f64 + 0.5) * scale_y - 0.5).clamp(0.0, (in_height - 1) as f64);
        let y0 = libm::floor(sy) as usize;
        let y1 = (y0 + 1).min(in_height - 1);
        let ty = (sy - y0 as f64) as f32;
        for (x, &(x0, x1, tx)) in columns.iter().enumerate() {
            let top = source[y0 * in_width + x0]
                + tx * (source[y0 * in_width + x1] - source[y0 * in_width + x0]);
            let bottom = source[y1 * in_width + x0]
                + tx * (source[y1 * in_width + x1] - source[y1 * in_width + x0]);
            output[y * out_width + x] = top + ty * (bottom - top);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: usize, h: usize) -> LinearImage {
        let mut data = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                let t = (x + y * w) as f32 / (w * h) as f32;
                data.extend_from_slice(&[0.01 + 0.8 * t * t, 0.01 + 0.7 * t, 0.02 + 0.5 * t]);
            }
        }
        LinearImage {
            width: w,
            height: h,
            data,
        }
    }

    #[test]
    fn zero_amounts_keep_every_bit() {
        let image = gradient(64, 48);
        let analysis = analysis(&image, SourceSpace::LinearSrgb, 0.0).unwrap();
        let prepared = apply(
            &image,
            SourceSpace::LinearSrgb,
            &analysis,
            &DevelopSettings::neutral(),
        )
        .unwrap();
        assert_eq!(prepared.data, image.data);
    }

    #[test]
    fn analysis_is_of_the_whole_photo_at_750() {
        assert_eq!(analysis_size(2560, 1707), (750, 500));
        assert_eq!(analysis_size(1707, 2560), (500, 750));
        assert_eq!(analysis_size(600, 400), (600, 400));
    }

    #[test]
    fn neutral_pixels_stay_neutral() {
        let mut image = gradient(32, 24);
        for px in image.data.chunks_exact_mut(3) {
            let v = px[1];
            px.copy_from_slice(&[v, v, v]);
        }
        let analysis = analysis(&image, SourceSpace::LinearSrgb, 0.0).unwrap();
        let settings = DevelopSettings {
            highlights: -80.0,
            shadows: 60.0,
            ..DevelopSettings::neutral()
        };
        let prepared = apply(&image, SourceSpace::LinearSrgb, &analysis, &settings).unwrap();
        for px in prepared.data.chunks_exact(3) {
            assert!((px[0] - px[1]).abs() <= 1e-5 * px[1].abs().max(1.0));
            assert!((px[2] - px[1]).abs() <= 1e-5 * px[1].abs().max(1.0));
        }
    }
}
